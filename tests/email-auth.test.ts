// Exercise email OTP abuse controls, opaque sessions and account creation against an isolated Mongo database.
import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import mongoose from "mongoose";
import { authStore } from "../src/modules/auth/auth.store.js";
import { TEST_PASSWORD, testPasswords } from "./password-fixture.js";
import { createApp } from "../src/app.js";
import { createEmailAuthService } from "../src/modules/auth/email-auth.service.js";
import { UserModel } from "../src/modules/auth/user.model.js";
import { createSession, readSession } from "../src/modules/auth/session.service.js";
import { ensureAuthIndexes, migrateAuthIndexes } from "../src/modules/auth/auth.store.js";
import { ENV } from "../src/config/env.js";

const dbName = `buktipulih_email_auth_test_${process.pid}`;
const pepper = "a".repeat(64);
let server: Server | undefined;
let baseUrl: string;
let now = new Date();
let generatedCodeSequence = 0;
const deliveries: Array<{ email: string; code: string; expiresAt: Date; idempotencyKey: string }> = [];
let service: ReturnType<typeof createEmailAuthService>;

before(async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27017/${dbName}`);
  service = createEmailAuthService({ passwords: testPasswords,
    pepper,
    now: () => new Date(now),
    generateCode: () => String(generatedCodeSequence++ % 100_000_000).padStart(8, "0"),
    sendCode: async input => { deliveries.push({ ...input }); },
  });
});
beforeEach(async () => {
  now = new Date();
  deliveries.length = 0;
  await Promise.all([
    UserModel.deleteMany({}),
    authStore.flows().deleteMany({}),
    authStore.reservations().deleteMany({}),
    authStore.limits().deleteMany({}),
    authStore.sessions().deleteMany({}),
  ]);
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  }
  assert.equal(mongoose.connection.name, dbName);
  assert.match(mongoose.connection.name, /^buktipulih_email_auth_test_\d+$/);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("index setup fails safely on the legacy phone unique index until explicit migration", async () => {
  await UserModel.collection.createIndex({ phone_number: 1 }, { unique: true, name: "phone_number_legacy_unique" });
  await assert.rejects(() => ensureAuthIndexes());
  await migrateAuthIndexes();
  const indexes = await UserModel.collection.indexes();
  assert.equal(indexes.some(index => index.key.phone_number === 1 && index.unique && !index.partialFilterExpression), false);
  await ensureAuthIndexes();
});
const proof = (digit: string) => digit.repeat(64);
let requestSequence = 0;
const start = (email: string, browserProof = proof("1")) => service.start({
  email, purpose: "register", password: TEST_PASSWORD, request_id: `request-${++requestSequence}`,
}, browserProof, `198.51.100.${(requestSequence % 200) + 1}`);
const codeFor = (email: string) => {
  const delivery = [...deliveries].reverse().find(item => item.email === email.toLowerCase());
  assert.ok(delivery, `expected a captured delivery for ${email}`);
  return delivery.code;
};
const rejectsAuth = async (action: () => Promise<unknown>) => {
  let caught: unknown;
  try { await action(); } catch (error) { caught = error; }
  assert.ok(caught, "expected authentication action to reject");
  assert.equal(typeof (caught as { status?: unknown }).status, "number");
  assert.equal(typeof (caught as { code?: unknown }).code, "string");
  return caught as { status: number; code: string };
};

test("concurrent starts allocate unique active eight-digit codes and return no code or verifier", async () => {
  const results = await Promise.all(Array.from({ length: 100 }, (_, index) =>
    start(`person-${index}@example.test`, proof((index % 9 + 1).toString()))));
  assert.equal(new Set(deliveries.slice(-100).map(item => item.code)).size, 100);
  assert.ok(results.every(result => typeof result.flow_id === "string"));
  const serialized = JSON.stringify(results);
  for (const delivery of deliveries.slice(-100)) assert.equal(serialized.includes(delivery.code), false);
  assert.equal(serialized.includes(pepper), false);
});

test("unconfigured default email auth returns 503 before any sender can run", async () => {
  const previous = {
    pepper: ENV.AUTH_OTP_PEPPER,
    apiKey: ENV.BREVO_API_KEY,
    senderEmail: ENV.BREVO_SENDER_EMAIL,
    senderName: ENV.BREVO_SENDER_NAME,
  };
  try {
    ENV.AUTH_OTP_PEPPER = "";
    ENV.BREVO_API_KEY = "";
    ENV.BREVO_SENDER_EMAIL = "";
    ENV.BREVO_SENDER_NAME = "";
    const unconfigured = createEmailAuthService();
    const error = await rejectsAuth(() => unconfigured.start({ email: "unconfigured@example.test", purpose: "register" as const, password: TEST_PASSWORD, request_id: "e6d760c0-55bb-4dad-91ad-30a95f301044" }, proof("9"), "198.51.100.98"));
    assert.equal(error.status, 503);
    assert.equal(error.code, "EMAIL_AUTH_UNAVAILABLE");
    assert.equal(deliveries.length, 0);
  } finally {
    ENV.AUTH_OTP_PEPPER = previous.pepper;
    ENV.BREVO_API_KEY = previous.apiKey;
    ENV.BREVO_SENDER_EMAIL = previous.senderEmail;
    ENV.BREVO_SENDER_NAME = previous.senderName;
  }
});
test("provider failure leaves no active verifier that can accept the generated code", async () => {
  const failed = createEmailAuthService({ passwords: testPasswords,
    pepper,
    now: () => new Date(now),
    generateCode: () => "76543210",
    sendCode: async () => { throw new Error("provider unavailable"); },
  });
  await assert.rejects(() => failed.start({ email: "mail-failure@example.test", purpose: "register" as const, password: TEST_PASSWORD, request_id: "a0c24b31-31a6-4e5d-a7b8-6292f15f1db4" }, proof("9"), "198.51.100.99"));
  const flow = await authStore.flows().findOne({ request_id: "a0c24b31-31a6-4e5d-a7b8-6292f15f1db4" });
  assert.ok(flow);
  assert.equal(flow.status, "send_failed");
  assert.equal(flow.verifier, undefined);
  await rejectsAuth(() => failed.verify({ flow_id: flow._id, code: "76543210" }, proof("9"), "198.51.100.99"));
});
test("code generation retries a forced collision", async () => {
  const generated = ["31415926", "31415926", "27182818"];
  const collisionService = createEmailAuthService({ passwords: testPasswords,
    pepper,
    now: () => new Date(now),
    generateCode: () => generated.shift() ?? "16180339",
    sendCode: async input => { deliveries.push({ ...input }); },
  });
  await Promise.all([
    collisionService.start({ email: "collision-one@example.test", purpose: "register" as const, password: TEST_PASSWORD, request_id: "collision-1" }, proof("2"), "198.51.100.25"),
    collisionService.start({ email: "collision-two@example.test", purpose: "register" as const, password: TEST_PASSWORD, request_id: "collision-2" }, proof("3"), "198.51.100.26"),
  ]);
  assert.deepEqual(deliveries.slice(-2).map(item => item.code).sort(), ["27182818", "31415926"]);
});

test("proof binds a flow, successful verification is single-use, and attempts survive resend", async () => {
  const flow = await start("replay@example.test", proof("4"));
  await rejectsAuth(() => service.getFlow(flow.flow_id, proof("5")));
  await rejectsAuth(() => service.verify({ flow_id: flow.flow_id, code: codeFor("replay@example.test") }, proof("5"), "198.51.100.27"));

  const firstCode = codeFor("replay@example.test");
  const wrongCode = firstCode === "99999999" ? "00000000" : "99999999";
  for (let i = 0; i < 4; i++) {
    await rejectsAuth(() => service.verify({ flow_id: flow.flow_id, code: wrongCode }, proof("4"), "198.51.100.27"));
  }
  now = new Date(now.getTime() + 61_000);
  const resent = await service.resend({ flow_id: flow.flow_id, request_id: "replay-resend" }, proof("4"), "198.51.100.27");
  assert.equal(resent.flow_id, flow.flow_id);
  const newCode = codeFor("replay@example.test");
  assert.notEqual(newCode, firstCode);
  const wrongAfterResend = newCode === "99999999" ? "00000000" : "99999999";
  await rejectsAuth(() => service.verify({ flow_id: flow.flow_id, code: wrongAfterResend }, proof("4"), "198.51.100.27"));
  await rejectsAuth(() => service.verify({ flow_id: flow.flow_id, code: newCode }, proof("4"), "198.51.100.27"));
});

test("a code issued for a different email flow cannot be substituted", async () => {
  const firstEmail = "flow-first@example.test";
  const secondEmail = "flow-second@example.test";
  const first = await start(firstEmail, proof("1"));
  const firstCode = codeFor(firstEmail);
  const second = await start(secondEmail, proof("1"));
  const secondCode = codeFor(secondEmail);
  await rejectsAuth(() => service.verify({ flow_id: first.flow_id, code: secondCode }, proof("1"), "198.51.100.42"));
  const verified = await service.verify({ flow_id: first.flow_id, code: firstCode }, proof("1"), "198.51.100.43");
  assert.equal(verified.reset_required, false);
  if (verified.reset_required) throw new Error("Expected a session");
  assert.equal(verified.user.email, firstEmail);
});

test("resend invalidates the previous code while preserving the proof-bound flow", async () => {
  const email = "resend@example.test";
  const flow = await start(email, proof("2"));
  const oldCode = codeFor(email);
  await rejectsAuth(() => service.resend({ flow_id: flow.flow_id, request_id: "too-early" }, proof("2"), "198.51.100.44"));
  now = new Date(now.getTime() + 61_000);
  await service.resend({ flow_id: flow.flow_id, request_id: "after-cooldown" }, proof("2"), "198.51.100.44");
  const newCode = codeFor(email);
  assert.notEqual(newCode, oldCode);
  await rejectsAuth(() => service.verify({ flow_id: flow.flow_id, code: oldCode }, proof("2"), "198.51.100.44"));
  const verified = await service.verify({ flow_id: flow.flow_id, code: newCode }, proof("2"), "198.51.100.44");
  assert.equal(verified.reset_required, false);
  if (verified.reset_required) throw new Error("Expected a session");
  assert.equal(verified.user.email, email);
});
test("concurrent verification consumes a flow once and creates a minimal guest account", async () => {
  const email = "new-guest@example.test";
  const flow = await start(email, proof("6"));
  const code = codeFor(email);
  const results = await Promise.allSettled([
    service.verify({ flow_id: flow.flow_id, code }, proof("6"), "198.51.100.28"),
    service.verify({ flow_id: flow.flow_id, code }, proof("6"), "198.51.100.29"),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  const success = results.find(result => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof service.verify>>>;
  assert.equal(success.value.reset_required, false);
  if (success.value.reset_required) throw new Error("Expected a session");
  const user = await UserModel.findById(success.value.user.id);
  assert.ok(user);
  assert.equal(user.role, "PUBLIC_GUEST");
  assert.equal(user.role_badge, "");
  assert.equal(user.email, email);
  assert.equal(user.phone_number ?? null, null);
  assert.equal(user.pin_hash ?? null, null);
  assert.equal(user.full_name ?? null, null);
  assert.equal(success.value.onboarding_required, true);
  assert.match(success.value.token, /^[a-f0-9]{64}$/);
  assert.match(success.value.context, /^[a-f0-9-]{36}$/);

  await rejectsAuth(() => service.verify({ flow_id: flow.flow_id, code }, proof("6"), "198.51.100.30"));
});

test("simultaneous registrations preserve one account and never overwrite its password", async () => {
  const email = "same-address@example.test";
  const first = await start(email, proof("2"));
  const firstCode = codeFor(email);
  const second = await start(email, proof("3"));
  const secondCode = codeFor(email);
  const results = await Promise.allSettled([
    service.verify({ flow_id: first.flow_id, code: firstCode }, proof("2"), "198.51.100.40"),
    service.verify({ flow_id: second.flow_id, code: secondCode }, proof("3"), "198.51.100.41"),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(await UserModel.countDocuments({ email }), 1);
});
test("rolling 15-minute quota rejects a fourth send just after the quarter-hour boundary", async () => {
  now = new Date("2026-01-01T00:14:59.000Z");
  const email = "quarter-boundary@example.test";
  await start(email, proof("1"));
  await start(email, proof("2"));
  await start(email, proof("3"));
  now = new Date(now.getTime() + 1_000);
  const error = await rejectsAuth(() => start(email, proof("4")));
  assert.equal(error.status, 429);
  assert.equal(error.code, "RATE_LIMITED");
});
test("per-email send limits and resend cooldown are enforced", async () => {
  now = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 + 100);
  const email = "limits@example.test";
  const first = await start(email, proof("7"));
  await rejectsAuth(() => service.resend({ flow_id: first.flow_id, request_id: "too-soon" }, proof("7"), "198.51.100.31"));
  await start(email, proof("8"));
  await start(email, proof("9"));
  await rejectsAuth(() => start(email, proof("1")));

  now = new Date(now.getTime() + 15 * 60_000);
  await start(email, proof("2"));
  await start(email, proof("3"));
  await start(email, proof("4"));
  now = new Date(now.getTime() + 15 * 60_000);
  await start(email, proof("5"));
  await start(email, proof("6"));
  await start(email, proof("7"));
  now = new Date(now.getTime() + 15 * 60_000);
  await start(email, proof("8"));
  await rejectsAuth(() => start(email, proof("9")));
});

test("expiration is enforced from server time while the Mongo TTL document still exists", async () => {
  const email = "expired@example.test";
  const flow = await start(email, proof("8"));
  const code = codeFor(email);
  const collections = await mongoose.connection.db!.listCollections().toArray();
  const flowCollection = collections.find(collection => /flow/i.test(collection.name));
  assert.ok(flowCollection, "email auth flow collection should be present");
  now = new Date(new Date(flow.expires_at).getTime() + 1);
  await rejectsAuth(() => service.verify({ flow_id: flow.flow_id, code }, proof("8"), "198.51.100.32"));
  assert.ok(await mongoose.connection.db!.collection(flowCollection.name).countDocuments() > 0);
});

test("resend and verify race has one compare-and-set winner", async () => {
  const email = "resend-verify-race@example.test";
  const flow = await start(email, proof("3"));
  const oldCode = codeFor(email);
  now = new Date(now.getTime() + 61_000);
  const outcomes = await Promise.allSettled([
    service.resend({ flow_id: flow.flow_id, request_id: "race-resend" }, proof("3"), "198.51.100.45"),
    service.verify({ flow_id: flow.flow_id, code: oldCode }, proof("3"), "198.51.100.46"),
  ]);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  const persisted = await authStore.flows().findOne({ _id: flow.flow_id });
  assert.ok(persisted);
  assert.ok(persisted.status === "used" || (persisted.status === "active" && persisted.generation === 2));
});
test("opaque sessions expire by server time and store only a verifier", async () => {
  const createdAt = new Date(now);
  const { token } = await createSession("507f1f77bcf86cd799439011", createdAt);
  const stored = await authStore.sessions().findOne({ _id: createHash("sha256").update(token).digest("hex") });
  assert.ok(stored);
  assert.equal(JSON.stringify(stored).includes(token), false);
  assert.equal(await readSession(token, new Date(createdAt.getTime() + 24 * 60 * 60_000)), null);
  assert.equal(await readSession(token, new Date(createdAt.getTime() + 8 * 86_400_000)), null);
});
test("HTTP bootstrap preserves proof, enforces CSRF, and logout requires the session context", async () => {
  server = createApp({ emailAuth: service }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  const legacyLogin = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST", headers: { Origin: "http://localhost:3001", "Content-Type": "application/json" }, body: JSON.stringify({ phone_number: "15550000000", pin: "123456" }),
  });
  assert.equal(legacyLogin.status, 410);
  assert.equal((await legacyLogin.json()).error.code, "EMAIL_LOGIN_REQUIRED");
  const forgedJwt = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { Cookie: "bp_session=eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiIxIn0.invalid" } });
  assert.equal(forgedJwt.status, 401);
  const prepared = await fetch(`${baseUrl}/api/v1/auth/email/prepare`);
  assert.equal(prepared.status, 200);
  const setCookie = prepared.headers.get("set-cookie");
  assert.ok(setCookie?.includes("bp_auth_proof="));
  assert.match(setCookie ?? "", /HttpOnly/i);
  assert.match(setCookie ?? "", /SameSite=Lax/i);
  const cookie = setCookie!.split(";")[0];
  const proofValue = cookie.slice("bp_auth_proof=".length);
  assert.match(proofValue, /^[a-f0-9]{64}$/);
  const preparedAgain = await fetch(`${baseUrl}/api/v1/auth/email/prepare`, { headers: { Cookie: cookie } });
  assert.equal(preparedAgain.status, 200);
  assert.equal(preparedAgain.headers.get("set-cookie")?.split(";")[0], cookie);

  const badOrigin = await fetch(`${baseUrl}/api/v1/auth/email/start`, {
    method: "POST", headers: { Cookie: cookie, Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: JSON.stringify({ email: "csrf@example.test", purpose: "register" as const, password: TEST_PASSWORD, request_id: "csrf-bad" }),
  });
  assert.equal(badOrigin.status, 403);
  const noJson = await fetch(`${baseUrl}/api/v1/auth/email/start`, {
    method: "POST", headers: { Cookie: cookie, Origin: "http://localhost:3001", "Content-Type": "text/plain" }, body: "{}",
  });
  assert.ok(noJson.status >= 400);
  const emailOnly = await fetch(`${baseUrl}/api/v1/auth/email/start`, {
    method: "POST", headers: { Cookie: cookie, Origin: "http://localhost:3001", "Content-Type": "application/json" },
    body: JSON.stringify({ email: "email-only@example.test", request_id: "d6bde2dc-e463-4651-aeac-cd949b075851" }),
  });
  assert.equal(emailOnly.status, 422);
  const started = await fetch(`${baseUrl}/api/v1/auth/email/start`, {
    method: "POST", headers: { Cookie: cookie, Origin: "http://localhost:3001", "Content-Type": "application/json" },
    body: JSON.stringify({ email: "http-session@example.test", purpose: "register" as const, password: TEST_PASSWORD, request_id: "b1c35c42-42b7-4f6e-b8c9-7303a26f2ec5" }),
  });
  assert.equal(started.status, 200);
  const startBody = await started.json();
  const otp = codeFor("http-session@example.test");
  assert.equal(JSON.stringify(startBody).includes(otp), false);
  assert.equal(JSON.stringify(startBody).includes(proofValue), false);
  const activeFlow = await authStore.flows().findOne({ _id: startBody.data.flow_id });
  assert.ok(activeFlow?.verifier);
  assert.notEqual(activeFlow.verifier, otp);
  assert.equal(JSON.stringify(activeFlow).includes(otp), false);
  assert.equal(JSON.stringify(activeFlow).includes(proofValue), false);
  const flowRead = await fetch(`${baseUrl}/api/v1/auth/email/flow?flow_id=${startBody.data.flow_id}`, { headers: { Cookie: cookie } });
  assert.equal(flowRead.status, 200);
  assert.equal(JSON.stringify(await flowRead.json()).includes(otp), false);

  const verified = await fetch(`${baseUrl}/api/v1/auth/email/verify`, {
    method: "POST", headers: { Cookie: cookie, Origin: "http://localhost:3001", "Content-Type": "application/json" },
    body: JSON.stringify({ flow_id: startBody.data.flow_id, code: otp }),
  });
  assert.equal(verified.status, 200);
  const verifiedBody = await verified.json();
  const sessionCookie = verified.headers.get("set-cookie");
  assert.ok(sessionCookie?.includes("bp_session="));
  assert.match(sessionCookie ?? "", /HttpOnly/i);
  assert.match(sessionCookie ?? "", /SameSite=Lax/i);
  const rawToken = sessionCookie!.match(/bp_session=([^;]+)/)?.[1];
  assert.match(rawToken ?? "", /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(verifiedBody).includes(rawToken!), false);
  const rawTokenHash = createHash("sha256").update(rawToken!).digest("hex");
  const sessionRecord = await authStore.sessions().findOne({ _id: rawTokenHash });
  assert.ok(sessionRecord);
  assert.equal(JSON.stringify(sessionRecord).includes(rawToken!), false);
  const storedFlows = await authStore.flows().find({ _id: startBody.data.flow_id }).toArray();
  assert.equal(JSON.stringify(storedFlows).includes(otp), false);
  assert.equal(JSON.stringify(storedFlows).includes(proofValue), false);
  const profile = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { Cookie: `bp_session=${rawToken}` } });
  const profileBody = await profile.json();
  const context = profileBody.data.user.session_context;

  const missingContext = await fetch(`${baseUrl}/api/v1/auth/logout`, {
    method: "POST", headers: { Cookie: `bp_session=${rawToken}`, Origin: "http://localhost:3001", "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(missingContext.status, 409);
  const mismatchedContext = await fetch(`${baseUrl}/api/v1/auth/logout`, {
    method: "POST", headers: { Cookie: `bp_session=${rawToken}`, Origin: "http://localhost:3001", "Content-Type": "application/json", "x-session-context": "0".repeat(64) }, body: "{}",
  });
  assert.equal(mismatchedContext.status, 409);
  const loggedOut = await fetch(`${baseUrl}/api/v1/auth/logout`, {
    method: "POST", headers: { Cookie: `bp_session=${rawToken}`, Origin: "http://localhost:3001", "Content-Type": "application/json", "x-session-context": context }, body: "{}",
  });
  assert.equal(loggedOut.status, 200);
  const revokedSession = await authStore.sessions().findOne({ _id: rawTokenHash });
  assert.ok(revokedSession?.revoked_at);
  assert.equal((await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { Cookie: `bp_session=${rawToken}` } })).status, 401);
});

test("a delayed retry cannot invalidate a newer resend generation", async () => {
  const email = "resend-retry@example.test";
  const flow = await start(email, proof("2"));
  now = new Date(now.getTime() + 61_000);
  await service.resend({ flow_id: flow.flow_id, request_id: "send-one" }, proof("2"), "198.51.100.61");
  now = new Date(now.getTime() + 61_000);
  await service.resend({ flow_id: flow.flow_id, request_id: "send-two" }, proof("2"), "198.51.100.61");
  const latest = codeFor(email);
  now = new Date(now.getTime() + 61_000);
  const delayed = await rejectsAuth(() => service.resend({ flow_id: flow.flow_id, request_id: "send-one" }, proof("2"), "198.51.100.61"));
  assert.equal(delayed.code, "REQUEST_REPLACED");
  const verified = await service.verify({ flow_id: flow.flow_id, code: latest }, proof("2"), "198.51.100.61");
  assert.equal(verified.reset_required, false);
  if (verified.reset_required) throw new Error("Expected a session");
  assert.equal(verified.user.email, email);
});

test("email-only verification cannot issue a privileged session", async () => {
  const email = "privileged@example.test";
  const user = await UserModel.create({ email, role: "ADMIN_SUPER", role_badge: "Official" });
  const flow = await start(email, proof("3"));
  const rejected = await rejectsAuth(() => service.verify({ flow_id: flow.flow_id, code: codeFor(email) }, proof("3"), "198.51.100.62"));
  assert.equal(rejected.code, "ACCOUNT_UNAVAILABLE");
  assert.equal(await authStore.sessions().countDocuments({ user_id: user._id.toString() }), 0);
});


test("changing email cancels only the proof-bound flow and removes its verifier", async () => {
  const flow = await start("cancel@example.test", proof("4"));
  const code = codeFor("cancel@example.test");
  await service.cancel(flow.flow_id, proof("5"));
  assert.equal((await authStore.flows().findOne({ _id: flow.flow_id }))?.status, "active");
  await service.cancel(flow.flow_id, proof("4"));
  const cancelled = await authStore.flows().findOne({ _id: flow.flow_id });
  assert.equal(cancelled?.status, "cancelled");
  assert.equal(cancelled?.verifier, undefined);
  await rejectsAuth(() => service.verify({ flow_id: flow.flow_id, code }, proof("4"), "198.51.100.63"));
});

test("retrying an accepted start reuses its metadata and sends one message", async () => {
  const input = { email: "request-retry@example.test", purpose: "register" as const, password: TEST_PASSWORD, request_id: "same-start-request" };
  const first = await service.start(input, proof("6"), "198.51.100.64");
  const second = await service.start(input, proof("6"), "198.51.100.64");
  assert.equal(first.flow_id, second.flow_id);
  assert.equal(deliveries.filter(item => item.email === input.email).length, 1);
});
