// Verify real password hashing, password plus OTP login and bounded password recovery.
import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { createEmailAuthService } from "../src/modules/auth/email-auth.service.js";
import { authStore, ensureAuthIndexes } from "../src/modules/auth/auth.store.js";
import { UserModel } from "../src/modules/auth/user.model.js";
import { acceptablePassword, PASSWORD_FORMAT, hashPassword, verifyPassword } from "../src/modules/auth/password.service.js";
import { readSession } from "../src/modules/auth/session.service.js";
const dbName = `buktipulih_password_auth_test_${process.pid}`;
const PASSWORD = "ALongForestPassword2026!";
const NEXT_PASSWORD = "AnotherLongForestPhrase2027!";
const proof = "a".repeat(64);
let now = new Date();
let service: ReturnType<typeof createEmailAuthService>;
const deliveries: { email: string; code: string; request: string }[] = [];
let server: Server;
let base: string;
const requestId = () => randomUUID();
const start = (email: string, purpose: "register" | "login" | "reset", password = PASSWORD, browser = proof) => service.start({ email, purpose, ...(purpose !== "reset" ? { password } : {}), request_id: requestId() }, browser, "198.51.100.70");
const code = (email: string) => deliveries.findLast(item => item.email === email)!.code;
async function register(email: string) {
  const flow = await start(email, "register");
  const verified = await service.verify({ flow_id: flow.flow_id, code: code(email) }, proof, "198.51.100.70");
  assert.equal(verified.reset_required, false);
  if (verified.reset_required) throw new Error("Session expected");
  return verified;
}
const errorCode = async (operation: () => Promise<unknown>, expected: string) => assert.rejects(operation, (error: unknown) => (error as { code?: string }).code === expected);
before(async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27017/${dbName}`);
  await ensureAuthIndexes();
  service = createEmailAuthService({ pepper: "b".repeat(64), now: () => new Date(now), sendCode: async input => { deliveries.push({ email: input.email, code: input.code, request: input.idempotencyKey }); } });
  server = createApp({ emailAuth: service }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  now = new Date(); deliveries.length = 0;
  await Promise.all([UserModel.deleteMany({}), authStore.flows().deleteMany({}), authStore.reservations().deleteMany({}), authStore.limits().deleteMany({}), authStore.sessions().deleteMany({})]);
});
after(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  assert.equal(mongoose.connection.name, dbName); assert.match(dbName, /^buktipulih_password_auth_test_\d+$/);
  await mongoose.connection.dropDatabase(); await mongoose.disconnect();
});

test("scrypt salts differ, preserves password content and normalizes Unicode", async () => {
  const first = await hashPassword(PASSWORD);
  const second = await hashPassword(PASSWORD);
  assert.notEqual(first, second); assert.equal(first.includes(PASSWORD), false);
  assert.equal(await verifyPassword(PASSWORD, first), true);
  assert.equal(await verifyPassword(PASSWORD + " ", first), false);
  assert.equal(await verifyPassword(PASSWORD, undefined), false);
  const unicode = "caf\u00e9InTheGreenForest";
  const stored = await hashPassword(unicode);
  assert.equal(await verifyPassword(unicode.normalize("NFD"), stored), true);
  assert.equal(acceptablePassword("123456789012345"), false);
  assert.equal(acceptablePassword("short"), false);
  assert.equal(acceptablePassword(" ".repeat(15)), false);
  assert.equal(acceptablePassword("x".repeat(129)), false);
});

test("registration stores a pending hash and creates an account only after OTP", async () => {
  const email = "register@example.test";
  const flow = await start(email, "register");
  assert.equal(await UserModel.countDocuments(), 0);
  const pending = await authStore.flows().findOne({ _id: flow.flow_id });
  assert.ok(pending?.pending_password_hash?.startsWith("scrypt$"));
  assert.equal(JSON.stringify(pending).includes(PASSWORD), false);
  assert.equal(JSON.stringify(flow).includes("password"), false);
  const verified = await service.verify({ flow_id: flow.flow_id, code: code(email) }, proof, "198.51.100.70");
  assert.equal(verified.reset_required, false);
  if (verified.reset_required) throw new Error("Session expected");
  const user = await UserModel.findById(verified.user.id).select("+password_hash");
  assert.ok(user); assert.equal(await verifyPassword(PASSWORD, user.password_hash), true);
  assert.equal(user.password_version, 1);
  assert.equal(JSON.stringify(verified.user).includes("password"), false);
  assert.equal((await authStore.flows().findOne({ _id: flow.flow_id }))?.pending_password_hash, undefined);
});

test("wrong or absent password never sends a login OTP; correct password still needs a new OTP", async () => {
  const email = "login@example.test";
  await register(email); const sent = deliveries.length;
  await errorCode(() => start(email, "login", "ThisPasswordIsIncorrect"), "CREDENTIALS_INVALID");
  await errorCode(() => service.start({ email, purpose: "login", request_id: requestId() }, proof, "198.51.100.70"), "PASSWORD_REQUIRED");
  assert.equal(deliveries.length, sent);
  const flow = await start(email, "login");
  assert.equal(await authStore.sessions().countDocuments(), 1);
  const authenticated = await service.verify({ flow_id: flow.flow_id, code: code(email) }, proof, "198.51.100.70");
  assert.equal(authenticated.reset_required, false);
  assert.equal(await authStore.sessions().countDocuments(), 2);
});

test("ten rejected password attempts are rate-limited before another expensive comparison", async () => {
  const email = "guess@example.test";
  await UserModel.create({ email, password_hash: await hashPassword(PASSWORD), password_version: 1 });
  for (let index = 0; index < 10; index++) await errorCode(() => start(email, "login", "IncorrectForestPassword"), "CREDENTIALS_INVALID");
  await errorCode(() => start(email, "login", PASSWORD), "RATE_LIMITED");
  assert.equal(deliveries.length, 0);
});

test("re-registering an email cannot replace the existing password or create another session", async () => {
  const email = "existing@example.test";
  const first = await register(email);
  const flow = await start(email, "register", NEXT_PASSWORD);
  await errorCode(() => service.verify({ flow_id: flow.flow_id, code: code(email) }, proof, "198.51.100.70"), "EMAIL_REGISTERED");
  const user = await UserModel.findById(first.user.id).select("+password_hash");
  assert.equal(await verifyPassword(PASSWORD, user!.password_hash), true);
  assert.equal(await authStore.sessions().countDocuments(), 1);
});

test("password reset proof alone has no session, then reset revokes old sessions and pending login codes", async () => {
  const email = "reset@example.test";
  const original = await register(email);
  const pendingLogin = await start(email, "login"); const pendingCode = code(email);
  const flow = await start(email, "reset");
  const resetProof = await service.verify({ flow_id: flow.flow_id, code: code(email) }, proof, "198.51.100.70");
  assert.equal(resetProof.reset_required, true); assert.equal("token" in resetProof, false);
  assert.ok(await readSession(original.token));
  await service.resetPassword({ flow_id: flow.flow_id, password: NEXT_PASSWORD }, proof, "198.51.100.70");
  assert.equal(await readSession(original.token), null);
  await errorCode(() => service.resetPassword({ flow_id: flow.flow_id, password: PASSWORD }, proof, "198.51.100.70"), "FLOW_EXPIRED");
  await errorCode(() => service.verify({ flow_id: pendingLogin.flow_id, code: pendingCode }, proof, "198.51.100.70"), "FLOW_EXPIRED");
  now = new Date(now.getTime() + 16 * 60_000);
  await errorCode(() => start(email, "login", PASSWORD), "CREDENTIALS_INVALID");
  const fresh = await start(email, "login", NEXT_PASSWORD);
  const login = await service.verify({ flow_id: fresh.flow_id, code: code(email) }, proof, "198.51.100.70");
  assert.equal(login.reset_required, false);
  if (login.reset_required) throw new Error("Session expected");
  assert.equal(login.user.id, original.user.id);
});

test("reset proof expires and cannot reset a different email or bypass its purpose", async () => {
  const email = "expired-reset@example.test";
  await register(email);
  const login = await start(email, "login");
  await errorCode(() => service.resetPassword({ flow_id: login.flow_id, password: NEXT_PASSWORD }, proof, "198.51.100.70"), "INVALID_CODE");
  const flow = await start(email, "reset");
  const verified = await service.verify({ flow_id: flow.flow_id, code: code(email) }, proof, "198.51.100.70");
  assert.equal(verified.reset_required, true);
  now = new Date(now.getTime() + 301_000);
  await errorCode(() => service.resetPassword({ flow_id: flow.flow_id, password: NEXT_PASSWORD }, proof, "198.51.100.70"), "INVALID_CODE");
});

test("unverified reset and unknown email never create an account or a session", async () => {
  const flow = await start("unknown@example.test", "reset");
  await errorCode(() => service.resetPassword({ flow_id: flow.flow_id, password: NEXT_PASSWORD }, proof, "198.51.100.70"), "INVALID_CODE");
  await errorCode(() => service.verify({ flow_id: flow.flow_id, code: code("unknown@example.test") }, proof, "198.51.100.70"), "INVALID_CODE");
  assert.equal(await UserModel.countDocuments(), 0); assert.equal(await authStore.sessions().countDocuments(), 0);
});

test("credential version rejects an old session even if revocation cleanup is interrupted", async () => {
  const registered = await register("version@example.test");
  await UserModel.updateOne({ _id: registered.user.id }, { $inc: { password_version: 1 } });
  const response = await fetch(`${base}/api/v1/auth/me`, { headers: { Cookie: `bp_session=${registered.token}` } });
  assert.equal(response.status, 401);
});


test("simultaneous logins need distinct OTPs and keep the same account", async () => {
  const email = "parallel-login@example.test";
  const original = await register(email);
  const [first, second] = await Promise.all([
    start(email, "login", PASSWORD, "1".repeat(64)),
    start(email, "login", PASSWORD, "2".repeat(64)),
  ]);
  const sent = deliveries.filter(item => item.email === email).slice(-2);
  assert.notEqual(sent[0].code, sent[1].code);
  const [firstRecord, secondRecord] = await Promise.all([authStore.flows().findOne({ _id: first.flow_id }), authStore.flows().findOne({ _id: second.flow_id })]);
  const firstDelivery = deliveries.findLast(item => item.request === firstRecord?.send_request_id);
  const secondDelivery = deliveries.findLast(item => item.request === secondRecord?.send_request_id);
  assert.ok(firstDelivery && secondDelivery);
  const results = await Promise.all([
    service.verify({ flow_id: first.flow_id, code: firstDelivery.code }, "1".repeat(64), "198.51.100.71"),
    service.verify({ flow_id: second.flow_id, code: secondDelivery.code }, "2".repeat(64), "198.51.100.72"),
  ]);
  for (const result of results) {
    assert.equal(result.reset_required, false);
    if (!result.reset_required) assert.equal(result.user.id, original.user.id);
  }
});

test("two verified recovery flows cannot both replace the same password version", async () => {
  const email = "parallel-reset@example.test";
  const original = await register(email);
  const first = await start(email, "reset"); const firstCode = code(email);
  const second = await start(email, "reset"); const secondCode = code(email);
  await service.verify({ flow_id: first.flow_id, code: firstCode }, proof, "198.51.100.70");
  await service.verify({ flow_id: second.flow_id, code: secondCode }, proof, "198.51.100.70");
  const outcomes = await Promise.allSettled([
    service.resetPassword({ flow_id: first.flow_id, password: NEXT_PASSWORD }, proof, "198.51.100.70"),
    service.resetPassword({ flow_id: second.flow_id, password: "AThirdLongForestPhrase2028!" }, proof, "198.51.100.70"),
  ]);
  assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
  assert.equal((await UserModel.findById(original.user.id))?.password_version, 2);
  assert.equal(await readSession(original.token), null);
});


test("password format rejects whitespace, including bypassed API inputs, without sending OTP", async () => {
  for (const whitespace of [" ", "\t", "\n", "\r", "\u00a0", "\u2003", "\u2028", "\u3000"]) {
    const value = `Forest${whitespace}RecoveryPassword2026!`;
    assert.equal(PASSWORD_FORMAT.test(value), false);
    assert.equal(acceptablePassword(value), false);
    await errorCode(() => start("space@example.test", "register", value), "PASSWORD_FORMAT");
    await errorCode(() => start("space@example.test", "login", value), "PASSWORD_FORMAT");
    await errorCode(() => service.resetPassword({ flow_id: requestId(), password: value }, proof, "198.51.100.70"), "PASSWORD_WEAK");
  }
  assert.equal(acceptablePassword(` ${PASSWORD}`), false);
  assert.equal(acceptablePassword(`${PASSWORD} `), false);
  const response = await fetch(`${base}/api/v1/auth/email/start`, {
    method: "POST", headers: { Origin: "http://localhost:3001", "Content-Type": "application/json", Cookie: `bp_auth_proof=${proof}` },
    body: JSON.stringify({ email: "space@example.test", purpose: "register", password: "Invalid Password2026!", request_id: requestId() }),
  });
  assert.equal(response.status, 422);
  assert.equal(deliveries.length, 0);
  assert.equal(await UserModel.countDocuments(), 0);
  assert.equal(PASSWORD_FORMAT.test("A".repeat(7)), false);
  assert.equal(PASSWORD_FORMAT.test("A".repeat(8)), true);
  assert.equal(PASSWORD_FORMAT.test("A".repeat(128)), true);
  assert.equal(PASSWORD_FORMAT.test("A".repeat(129)), false);
});


test("eight-character passwords register, log in and reset while seven characters are rejected", async () => {
  const email = "eight@example.test", password = "Rimba#28", replacement = "Pulih#29";
  for (const value of ["Abcd#27", "A".repeat(129)]) {
    const response = await fetch(`${base}/api/v1/auth/email/start`, {
      method: "POST", headers: { Origin: "http://localhost:3001", "Content-Type": "application/json", Cookie: `bp_auth_proof=${proof}` },
      body: JSON.stringify({ email, purpose: "register", password: value, request_id: requestId() }),
    });
    assert.equal(response.status, 422);
    await errorCode(() => service.resetPassword({ flow_id: requestId(), password: value }, proof, "198.51.100.70"), "PASSWORD_WEAK");
  }
  assert.equal(deliveries.length, 0);
  for (const value of ["password", "12345678", "qwerty123", "aaaaaaaa"]) assert.equal(acceptablePassword(value), false);
  assert.equal(acceptablePassword(password), true);
  const response = await fetch(`${base}/api/v1/auth/email/start`, {
    method: "POST", headers: { Origin: "http://localhost:3001", "Content-Type": "application/json", Cookie: `bp_auth_proof=${proof}` },
    body: JSON.stringify({ email, purpose: "register", password, request_id: requestId() }),
  });
  assert.equal(response.status, 200);
  const pending = (await response.json()).data;
  assert.equal(await UserModel.countDocuments(), 0);
  const original = await service.verify({ flow_id: pending.flow_id, code: code(email) }, proof, "198.51.100.70");
  assert.equal(original.reset_required, false);
  if (original.reset_required) throw new Error("Session expected");
  const login = await start(email, "login", password);
  const authenticated = await service.verify({ flow_id: login.flow_id, code: code(email) }, proof, "198.51.100.70");
  assert.equal(authenticated.reset_required, false);
  const reset = await start(email, "reset");
  const recovery = await service.verify({ flow_id: reset.flow_id, code: code(email) }, proof, "198.51.100.70");
  assert.equal(recovery.reset_required, true);
  await service.resetPassword({ flow_id: reset.flow_id, password: replacement }, proof, "198.51.100.70");
  assert.equal(await readSession(original.token), null);
  await errorCode(() => start(email, "login", password), "CREDENTIALS_INVALID");
  now = new Date(now.getTime() + 16 * 60_000);
  const next = await start(email, "login", replacement);
  const restored = await service.verify({ flow_id: next.flow_id, code: code(email) }, proof, "198.51.100.70");
  assert.equal(restored.reset_required, false);
  if (restored.reset_required) throw new Error("Session expected");
  assert.equal(restored.user.id, original.user.id);
});
