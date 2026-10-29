// Issue bounded email challenges and consume each code once with shared atomic state.
import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { ENV } from "../../config/env.js";
import { UserModel } from "./user.model.js";
import { safeUser } from "./auth.service.js";
import { authStore, duplicateKey, ensureAuthIndexes, type AuthFlow } from "./auth.store.js";
import { createSession } from "./session.service.js";
import { takeAuthLimit } from "./auth-rate-limit.js";
import { acceptablePassword, PASSWORD_FORMAT, normalizePassword, passwordCodec, PasswordBusyError, type PasswordCodec } from "./password.service.js";
import { brevoConfigured, sendBrevoCode, type VerificationEmail } from "./brevo-mailer.js";

const MINUTE = 60_000;
export class EmailAuthError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfter?: number) { super(message); }
}
interface Options {
  pepper?: string;
  sendCode?: (input: VerificationEmail) => Promise<void>;
  now?: () => Date;
  generateCode?: () => string;
  passwords?: PasswordCodec;
}
const unavailable = () => new EmailAuthError(503, "EMAIL_AUTH_UNAVAILABLE", "Masuk email belum tersedia. Coba lagi nanti.");
const invalid = () => new EmailAuthError(400, "INVALID_CODE", "Kode tidak cocok atau sudah tidak berlaku.");
export function createEmailAuthService(options: Options = {}) {
  const pepper = options.pepper ?? ENV.AUTH_OTP_PEPPER;
  const clock = options.now ?? (() => new Date());
  const sender = options.sendCode ?? sendBrevoCode;
  const passwords = options.passwords ?? passwordCodec;
  const generateCode = options.generateCode ?? (() => String(randomInt(100_000_000)).padStart(8, "0"));
  const tag = (purpose: string, value: string) => createHmac("sha256", pepper).update(purpose).update("\0").update(value).digest("hex");
  const proofHash = (proof: string) => createHash("sha256").update(proof).digest("hex");
  let ready: Promise<void> | undefined;
  async function configure() {
    if (!/^[a-f0-9]{64,128}$/i.test(pepper) || (!options.sendCode && !brevoConfigured())) throw unavailable();
    try { await (ready ??= ensureAuthIndexes().catch(error => { ready = undefined; throw error; })); }
    catch { throw unavailable(); }
  }
  const metadata = (flow: AuthFlow) => ({
    flow_id: flow._id, masked_email: `${flow.email[0]}***@${flow.email.split("@")[1]}`,
    expires_at: flow.expires_at.toISOString(), resend_at: flow.resend_at.toISOString(),
    server_time: clock().toISOString(), status: flow.status, purpose: flow.purpose,
  });
  async function takeLimit(scope: string, maximum: number, window: number, now: Date) {
    const retryAfter = await takeAuthLimit(tag("limit", scope), maximum, window, now);
    if (retryAfter) throw new EmailAuthError(429, "RATE_LIMITED", "Terlalu banyak percobaan. Coba lagi nanti.", retryAfter);
  }

  async function sendLimits(flow: AuthFlow, ip: string, now: Date) {
    await takeLimit(`send-email-15:${flow.email_key}`, 3, 15 * MINUTE, now);
    await takeLimit(`send-email-60:${flow.email_key}`, 10, 60 * MINUTE, now);
    await takeLimit(`send-ip:${ip}`, 20, 5 * MINUTE, now);
    await takeLimit("send-global", 100, 60 * MINUTE, now);
  }
  async function reserve(expires: Date) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode();
      if (!/^\d{8}$/.test(code)) throw unavailable();
      try {
        await authStore.reservations().insertOne({ _id: tag("active-code", code), purge_at: new Date(expires.getTime() + MINUTE) });
        return code;
      } catch (error) { if (!duplicateKey(error)) throw error; }
    }
    throw unavailable();
  }
  const verifier = (flow: AuthFlow, code: string) => tag("verifier", `${flow._id}:${flow.email_key}:${flow.proof_hash}:${flow.purpose}:${flow.password_version ?? 0}:${flow.generation}:${code}`);
  async function deliver(flow: AuthFlow, ip: string, now: Date) {
    try {
      await sendLimits(flow, ip, now);
      const code = await reserve(flow.expires_at);
      const value = verifier(flow, code);
      await authStore.flows().updateOne({ _id: flow._id, generation: flow.generation, status: "pending_send" }, { $set: { verifier: value } });
      await sender({ email: flow.email, code, expiresAt: flow.expires_at, idempotencyKey: flow.send_request_id, purpose: flow.purpose });
      const active = await authStore.flows().findOneAndUpdate({
        _id: flow._id, generation: flow.generation, status: "pending_send", expires_at: { $gt: clock() },
      }, { $set: { status: "active" } }, { returnDocument: "after" });
      if (!active) throw unavailable();
      return metadata(active);
    } catch (error) {
      await authStore.flows().updateOne({ _id: flow._id, generation: flow.generation, status: "pending_send" }, { $set: { status: "send_failed" }, $unset: { verifier: "" } });
      if (error instanceof EmailAuthError) throw error;
      throw unavailable();
    }
  }
  async function load(id: string, proof: string) {
    const flow = await authStore.flows().findOne({ _id: id, proof_hash: proofHash(proof) });
    if (!flow || !["register", "login", "reset"].includes(flow.purpose) || flow.flow_expires_at <= clock() || ["used", "cancelled"].includes(flow.status)) throw new EmailAuthError(410, "FLOW_EXPIRED", "Permintaan sudah berakhir. Minta kode baru.");
    if (flow.user_id && !await UserModel.exists({ _id: flow.user_id, is_active: true })) throw new EmailAuthError(410, "FLOW_EXPIRED", "Permintaan sudah berakhir. Minta kode baru.");
    return flow;
  }
  async function start(input: { email: string; request_id: string; purpose: AuthFlow["purpose"]; password?: string }, proof: string, ip: string) {
    await configure();
    const email = input.email.trim().toLowerCase();
    const hash = proofHash(proof);
    const normalized = normalizePassword(input.password ?? "");
    if (!["register", "login", "reset"].includes(input.purpose) || (input.purpose !== "reset" && !normalized)) throw new EmailAuthError(422, "PASSWORD_REQUIRED", "Masukkan email dan password.");
    if (input.purpose !== "reset" && !PASSWORD_FORMAT.test(normalized)) throw new EmailAuthError(422, "PASSWORD_FORMAT", "Gunakan password 8-128 karakter tanpa spasi.");
    if (input.purpose === "register" && !acceptablePassword(normalized)) throw new EmailAuthError(422, "PASSWORD_WEAK", "Gunakan password 8-128 karakter tanpa spasi yang tidak mudah ditebak.");
    const now = clock();
    const emailKey = tag("email", email);
    await takeLimit(`credential-email:${emailKey}`, 10, 15 * MINUTE, now);
    await takeLimit(`credential-ip:${ip}`, 50, 5 * MINUTE, now);
    await takeLimit("credential-global", 500, 60 * MINUTE, now);
    const previous = await authStore.flows().findOne({ proof_hash: hash, request_id: input.request_id });
    if (previous) {
      if (previous.user_id && !await UserModel.exists({ _id: previous.user_id, is_active: true })) throw new EmailAuthError(410, "FLOW_EXPIRED", "Permintaan sudah berakhir. Minta kode baru.");
      if (previous.email !== email || previous.purpose !== input.purpose || previous.flow_expires_at <= clock() || ["used", "cancelled"].includes(previous.status)) throw invalid();
      if (previous.status === "send_failed") throw unavailable();
      if (input.purpose !== "reset") {
        const account = input.purpose === "login" ? await UserModel.findOne({ _id: previous.user_id, is_active: true }).select("+password_hash") : null;
        const stored = input.purpose === "register" ? previous.pending_password_hash : account?.password_hash;
        let matches: boolean;
        try { matches = await passwords.verify(normalized, stored); }
        catch (error) {
          if (error instanceof PasswordBusyError) throw new EmailAuthError(503, "PASSWORD_BUSY", "Server sedang sibuk. Coba lagi sebentar.");
          throw error;
        }
        if (!matches || (account && (account.password_version ?? 0) !== previous.password_version)) throw new EmailAuthError(401, "CREDENTIALS_INVALID", "Email atau password tidak cocok.");
      }
      if (previous.status !== "active") throw new EmailAuthError(409, "SEND_PENDING", "Permintaan belum selesai. Coba lagi sebentar.");
      return metadata(previous);
    }
    const user = await UserModel.findOne({ email }).select("+password_hash");
    let pendingHash: string | undefined;
    try {
      if (input.purpose === "login") {
        const matches = await passwords.verify(normalized, user?.password_hash);
        if (!matches || !user?.is_active) throw new EmailAuthError(401, "CREDENTIALS_INVALID", "Email atau password tidak cocok.");
      } else if (input.purpose === "register") pendingHash = await passwords.hash(normalized);
    } catch (error) {
      if (error instanceof PasswordBusyError) throw new EmailAuthError(503, "PASSWORD_BUSY", "Server sedang sibuk. Coba lagi sebentar.");
      throw error;
    }
    const flow: AuthFlow = {
      _id: randomUUID(), proof_hash: hash, email, email_key: emailKey, request_id: input.request_id,
      purpose: input.purpose,
      ...(pendingHash ? { pending_password_hash: pendingHash } : {}),
      ...(user ? { user_id: user._id.toString(), password_version: user.password_version ?? 0 } : {}),
      generation: 1, attempts: 0, status: "pending_send", created_at: now,
      flow_expires_at: new Date(now.getTime() + 15 * MINUTE), expires_at: new Date(now.getTime() + 5 * MINUTE),
      resend_at: new Date(now.getTime() + MINUTE), purge_at: new Date(now.getTime() + 16 * MINUTE), send_request_id: randomUUID(), send_requests: [],
    };
    try { await authStore.flows().insertOne(flow); }
    catch (error) {
      if (duplicateKey(error)) throw new EmailAuthError(409, "SEND_PENDING", "Permintaan sedang diproses. Coba lagi sebentar.");
      throw error;
    }
    return deliver(flow, ip, now);
  }
  async function resend(input: { flow_id: string; request_id: string }, proof: string, ip: string) {
    await configure();
    const flow = await load(input.flow_id, proof);
    const now = clock();
    if (flow.status === "reset_verified") throw invalid();
    if (flow.attempts >= 5) throw new EmailAuthError(429, "ATTEMPTS_EXHAUSTED", "Batas percobaan tercapai. Minta kode baru setelah permintaan ini berakhir.");
    if (flow.send_request_id === input.request_id) {
      if (flow.status === "active") return metadata(flow);
      if (flow.status === "send_failed") throw unavailable();
      throw new EmailAuthError(409, "SEND_PENDING", "Permintaan belum selesai. Coba lagi sebentar.");
    }
    if (flow.send_requests?.includes(input.request_id)) throw new EmailAuthError(409, "REQUEST_REPLACED", "Permintaan ini sudah diganti. Gunakan kode terbaru.");
    if (flow.resend_at > now) throw new EmailAuthError(429, "RESEND_COOLDOWN", "Tunggu sebelum mengirim ulang kode.", Math.ceil((flow.resend_at.getTime() - now.getTime()) / 1000));
    const pending = await authStore.flows().findOneAndUpdate({
      _id: flow._id, generation: flow.generation, status: { $in: ["active", "send_failed"] }, attempts: { $lt: 5 },
      flow_expires_at: { $gt: now }, resend_at: { $lte: now },
    }, { $set: {
      status: "pending_send", expires_at: new Date(Math.min(now.getTime() + 5 * MINUTE, flow.flow_expires_at.getTime())),
      resend_at: new Date(now.getTime() + MINUTE), send_request_id: input.request_id,
    }, $inc: { generation: 1 }, $push: { send_requests: input.request_id }, $unset: { verifier: "" } }, { returnDocument: "after" });
    if (!pending) throw invalid();
    return deliver(pending, ip, now);
  }
  async function getFlow(id: string, proof: string) {
    await configure();
    return metadata(await load(id, proof));
  }
  async function verify(input: { flow_id: string; code: string }, proof: string, ip: string) {
    await configure();
    const flow = await load(input.flow_id, proof);
    const now = clock();
    await takeLimit(`verify-ip:${ip}`, 100, 5 * MINUTE, now);
    if (flow.attempts >= 5) throw new EmailAuthError(429, "ATTEMPTS_EXHAUSTED", "Batas percobaan tercapai. Minta kode baru setelah permintaan ini berakhir.");
    if (flow.status !== "active" || flow.expires_at <= now || !flow.verifier) throw invalid();
    const recentWrong = await authStore.limits().findOne({ _id: tag("limit", `wrong-email:${flow.email_key}`) });
    if ((recentWrong?.events.filter(at => at.getTime() > now.getTime() - 15 * MINUTE).length ?? 0) >= 20) throw new EmailAuthError(429, "RATE_LIMITED", "Terlalu banyak percobaan. Coba lagi nanti.");
    const value = verifier(flow, input.code);
    const matches = /^\d{8}$/.test(input.code) && timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(flow.verifier, "hex"));
    const filter = { _id: flow._id, proof_hash: flow.proof_hash, generation: flow.generation, status: "active" as const, verifier: flow.verifier, attempts: { $lt: 5 }, expires_at: { $gt: now } };
    if (!matches) {
      await takeLimit(`wrong-email:${flow.email_key}`, 20, 15 * MINUTE, now);
      const wrong = await authStore.flows().findOneAndUpdate(filter, { $inc: { attempts: 1 } }, { returnDocument: "after" });
      if (wrong && wrong.attempts >= 5) throw new EmailAuthError(429, "ATTEMPTS_EXHAUSTED", "Batas percobaan tercapai. Minta kode baru setelah permintaan ini berakhir.");
      throw invalid();
    }
    const consumed = await authStore.flows().findOneAndUpdate(filter, {
      $set: { status: flow.purpose === "reset" ? "reset_verified" : "used", ...(flow.purpose === "reset" ? { expires_at: new Date(Math.min(now.getTime() + 5 * MINUTE, flow.flow_expires_at.getTime())) } : {}) },
      $unset: { verifier: "", pending_password_hash: "" },
    }, { returnDocument: "after" });
    if (!consumed) throw invalid();
    let user = await UserModel.findOne({ email: flow.email }).select("+password_hash");
    if (user && (!user.is_active || ["ADMIN_SUPER", "GOVERNMENT_VERIFIER"].includes(user.role))) throw new EmailAuthError(403, "ACCOUNT_UNAVAILABLE", "Akun ini memerlukan metode masuk tambahan.");
    if (flow.purpose === "reset") {
      if (!user || flow.user_id !== user._id.toString() || flow.password_version !== (user.password_version ?? 0)) throw invalid();
      return { reset_required: true as const, flow: metadata(consumed) };
    }
    if (flow.purpose === "login") {
      if (!user?.password_hash || flow.user_id !== user._id.toString() || flow.password_version !== (user.password_version ?? 0)) throw new EmailAuthError(409, "CREDENTIALS_CHANGED", "Password sudah berubah. Masuk kembali.");
    } else {
      if (!flow.pending_password_hash) throw invalid();
      if (user?.password_hash) throw new EmailAuthError(409, "EMAIL_REGISTERED", "Email sudah terdaftar. Gunakan Masuk atau Lupa password.");
      if (user) {
        user = await UserModel.findOneAndUpdate({ _id: user._id, password_hash: { $in: [null, ""] }, is_active: true }, {
          $set: { password_hash: flow.pending_password_hash, email_verified_at: now }, $inc: { password_version: 1 },
        }, { new: true, runValidators: true });
        if (!user) throw new EmailAuthError(409, "EMAIL_REGISTERED", "Email sudah terdaftar. Gunakan Masuk atau Lupa password.");
      } else {
        try {
          user = await UserModel.create({ email: flow.email, email_verified_at: now, password_hash: flow.pending_password_hash, password_version: 1, role: "PUBLIC_GUEST", role_badge: "" });
        } catch (error) {
          if (duplicateKey(error)) throw new EmailAuthError(409, "EMAIL_REGISTERED", "Email sudah terdaftar. Gunakan Masuk atau Lupa password.");
          throw error;
        }
      }
    }
    if (!user) throw invalid();
    const active = await UserModel.updateOne({ _id: user._id, is_active: true, password_version: user.password_version ?? 0 }, { $set: { last_login_at: now } });
    if (!active.matchedCount) throw new EmailAuthError(409, "CREDENTIALS_CHANGED", "Akun berubah. Masuk kembali.");
    const session = await createSession(user._id.toString(), now, user.password_version ?? 0);
    return { reset_required: false as const, user: { ...safeUser(user), session_context: session.context }, ...session, onboarding_required: !user.username || !user.participation };
  }
  async function resetPassword(input: { flow_id: string; password: string }, proof: string, ip: string) {
    await configure();
    if (!acceptablePassword(input.password)) throw new EmailAuthError(422, "PASSWORD_WEAK", "Gunakan password 8-128 karakter tanpa spasi yang tidak mudah ditebak.");
    const flow = await load(input.flow_id, proof);
    if (flow.purpose !== "reset" || flow.status !== "reset_verified" || flow.expires_at <= clock() || !flow.user_id) throw invalid();
    const user = await UserModel.findOne({ _id: flow.user_id, email: flow.email, is_active: true }).select("password_version role");
    if (!user || (user.password_version ?? 0) !== flow.password_version || ["ADMIN_SUPER", "GOVERNMENT_VERIFIER"].includes(user.role)) throw invalid();
    await takeLimit(`password-reset:${flow.email_key}`, 10, 15 * MINUTE, clock());
    await takeLimit(`password-reset-ip:${ip}`, 20, 5 * MINUTE, clock());
    let passwordHash: string;
    try { passwordHash = await passwords.hash(input.password); }
    catch (error) {
      if (error instanceof PasswordBusyError) throw new EmailAuthError(503, "PASSWORD_BUSY", "Server sedang sibuk. Coba lagi sebentar.");
      throw error;
    }
    const now = clock();
    const claimed = await authStore.flows().findOneAndUpdate({ _id: flow._id, proof_hash: flow.proof_hash, status: "reset_verified", expires_at: { $gt: now } }, { $set: { status: "used" } });
    if (!claimed) throw invalid();
    const version = flow.password_version ?? 0;
    const updated = await UserModel.findOneAndUpdate({
      _id: flow.user_id, is_active: true,
      $or: [{ password_version: version }, ...(version === 0 ? [{ password_version: { $exists: false } }] : [])],
    }, { $set: { password_hash: passwordHash }, $inc: { password_version: 1 } }, { new: true });
    if (!updated) throw new EmailAuthError(409, "CREDENTIALS_CHANGED", "Password sudah berubah. Minta kode baru.");
    await Promise.all([
      authStore.sessions().updateMany({ user_id: flow.user_id, password_version: { $ne: updated.password_version } }, { $set: { revoked_at: now } }),
      authStore.flows().updateMany({ user_id: flow.user_id, _id: { $ne: flow._id }, status: { $nin: ["used", "cancelled"] } }, { $set: { status: "cancelled" }, $unset: { verifier: "", pending_password_hash: "" } }),
    ]);
    return { password_reset: true };
  }
  async function cancel(id: string, proof: string) {
    await authStore.flows().updateOne({ _id: id, proof_hash: proofHash(proof), status: { $nin: ["used", "cancelled"] } }, {
      $set: { status: "cancelled" }, $unset: { verifier: "", pending_password_hash: "" },
    });
    return { cancelled: true };
  }
  return { start, resend, getFlow, verify, cancel, resetPassword };
}
export type EmailAuthService = ReturnType<typeof createEmailAuthService>;
