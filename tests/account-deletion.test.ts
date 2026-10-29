// Exercise permanent deletion with isolated accounts; preserve content and deny stale access.
import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { UserModel } from "../src/modules/auth/user.model.js";
import { authStore, ensureAuthIndexes } from "../src/modules/auth/auth.store.js";
import { createSession } from "../src/modules/auth/session.service.js";
import { hashPassword, passwordCodec, PasswordBusyError } from "../src/modules/auth/password.service.js";
import { deleteAccount } from "../src/modules/auth/account-deletion.service.js";
import { createEmailAuthService } from "../src/modules/auth/email-auth.service.js";
import { ForumCommentModel, ForumPostModel } from "../src/modules/forum/forum.model.js";
import { getPost, listComments, listPosts, listRecoveryReports, getActivity } from "../src/modules/forum/forum.service.js";

const dbName = `buktipulih_account_deletion_test_${process.pid}`;
const PASSWORD = "DeleteFixture#2026";
const proof = "d".repeat(64);
let hash: string, server: Server, base: string;
let user: InstanceType<typeof UserModel>, other: InstanceType<typeof UserModel>;
let session: Awaited<ReturnType<typeof createSession>>, secondSession: Awaited<ReturnType<typeof createSession>>;
let service: ReturnType<typeof createEmailAuthService>;
const deliveries: { email: string; code: string }[] = [];
before(async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27017/${dbName}`);
  await Promise.all([ensureAuthIndexes(), UserModel.init(), ForumPostModel.init(), ForumCommentModel.init()]);
  hash = await hashPassword(PASSWORD);
  service = createEmailAuthService({ pepper: "e".repeat(64), sendCode: async value => { deliveries.push(value); } });
  server = createApp({ emailAuth: service }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  deliveries.length = 0;
  await Promise.all([UserModel.deleteMany({}), ForumPostModel.deleteMany({}), ForumCommentModel.deleteMany({}), authStore.flows().deleteMany({}), authStore.sessions().deleteMany({}), authStore.limits().deleteMany({}), authStore.reservations().deleteMany({})]);
  [user, other] = await UserModel.create([
    { email: "delete@example.test", email_verified_at: new Date(), phone_number: "+6200000000", full_name: "Private name", pin_hash: "legacy-private-pin", password_hash: hash, password_version: 1, username: "BeforeDeletion", city: "Private city", participation: "affected", avatar_url: "https://files.public.blob.vercel-storage.com/avatar.webp", organization_name: "Private organisation", role: "COMMUNITY_VOLUNTEER", role_badge: "Relawan", assigned_plots: ["plot-private"] },
    { email: "other@example.test", password_hash: hash, password_version: 1, username: "OtherAccount", participation: "observer" },
  ]);
  session = await createSession(user._id.toString(), new Date(), 1);
  secondSession = await createSession(user._id.toString(), new Date(), 1);
});
after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  assert.equal(mongoose.connection.name, dbName);
  assert.match(dbName, /^buktipulih_account_deletion_test_\d+$/);
  await mongoose.connection.dropDatabase(); await mongoose.disconnect();
});
async function request(method = "DELETE", body: unknown = { password: PASSWORD }, current = session, extra: Record<string, string> = {}) {
  return fetch(`${base}/api/v1/auth/me`, { method, headers: {
    "Content-Type": "application/json", Origin: "http://localhost:3001", Cookie: `bp_session=${current.token}`, "X-Session-Context": current.context, ...extra,
  }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
}
const start = (purpose: "login" | "reset" | "register", email = user.email!) => service.start({ email, purpose, request_id: randomUUID(), ...(purpose === "reset" ? {} : { password: PASSWORD }) }, proof, "198.51.100.51");
const verify = (id: string, email = user.email!) => service.verify({ flow_id: id, code: deliveries.findLast(item => item.email === email)!.code }, proof, "198.51.100.51");
const expectCode = (operation: () => Promise<unknown>, code: string) => assert.rejects(operation, (error: unknown) => (error as { code?: string }).code === code);
const deletedAuthor = { username: "Deleted Account", city: "", avatar_url: null, participation: null, age: 0 };

test("only an authenticated same-origin current session can delete itself", async () => {
  assert.equal((await request("DELETE", { password: PASSWORD }, session, { Cookie: "" })).status, 401);
  assert.equal((await request("DELETE", { password: PASSWORD }, session, { Origin: "https://attacker.test" })).status, 403);
  assert.equal((await request("DELETE", { password: PASSWORD }, session, { "X-Session-Context": randomUUID() })).status, 409);
  assert.equal((await request("DELETE", { password: PASSWORD, user_id: other._id.toString() })).status, 422);
  assert.equal((await request("DELETE", { password: "" })).status, 422);
  assert.equal((await request("DELETE", { password: PASSWORD })).status, 200);
  assert.equal((await UserModel.findById(other._id))!.is_active, true);
});

test("wrong password leaves the account and both sessions intact", async () => {
  const response = await request("DELETE", { password: "WrongFixture#2026" });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, "PASSWORD_INVALID");
  assert.equal((await request("GET")).status, 200);
  assert.equal((await request("GET", {}, secondSession)).status, 200);
  assert.equal((await UserModel.findById(user._id))!.username, "BeforeDeletion");
  assert.equal((await request()).status, 200);
});

test("deletion reserves at most five password comparisons per fifteen minutes", async () => {
  let comparisons = 0;
  const passwords = { ...passwordCodec, verify: async () => { comparisons++; return false; } };
  for (let index = 0; index < 5; index++) await expectCode(() => deleteAccount(user._id.toString(), "wrong", passwords), "PASSWORD_INVALID");
  const blocked = await request();
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  assert.equal(comparisons, 5);
  assert.equal((await UserModel.findById(user._id))!.is_active, true);
});

test("success removes identity, credentials, every session and pending login/reset flow", async () => {
  const login = await start("login");
  const reset = await start("reset");
  await verify(reset.flow_id);
  const result = await request();
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).data, { deleted: true });
  const cookies = result.headers.getSetCookie();
  assert.ok(cookies.some(value => value.startsWith("bp_session=;") && value.includes("HttpOnly")));
  assert.ok(cookies.some(value => value.startsWith("bp_auth_proof=;")));
  const stored = await UserModel.collection.findOne({ _id: user._id });
  assert.ok(stored?.deleted_at instanceof Date); assert.equal(stored.is_active, false); assert.equal(stored.password_version, 2);
  for (const field of ["email", "email_verified_at", "phone_number", "full_name", "pin_hash", "password_hash", "username", "username_save_count", "participation", "avatar_url", "city", "organization_name", "lock_until", "last_login_at"]) assert.equal(stored[field], undefined, field);
  assert.equal(stored.role, "PUBLIC_GUEST"); assert.deepEqual(stored.assigned_plots, []);
  assert.equal(await authStore.sessions().countDocuments({ user_id: user._id.toString() }), 0);
  assert.equal(await authStore.flows().countDocuments({ user_id: user._id.toString() }), 0);
  assert.equal((await request("GET")).status, 401);
  assert.equal((await request("GET", {}, secondSession)).status, 401);
  await expectCode(() => verify(login.flow_id), "FLOW_EXPIRED");
  await expectCode(() => service.resetPassword({ flow_id: reset.flow_id, password: "DifferentFixture#2026" }, proof, "198.51.100.51"), "FLOW_EXPIRED");
  const late = await createSession(user._id.toString(), new Date(), 1);
  assert.equal((await request("GET", {}, late)).status, 401);
});

test("posts, comments and replies keep their content while every public author loses identity", async () => {
  const common = { author_id: user._id, location_name: "Test field", region_key: "kalbar", caption: "Content remains", media: { type: "image", url: "https://files.public.blob.vercel-storage.com/photo.webp", aspect_ratio: "square" }, location: { type: "Point", coordinates: [109, 0] }, ecosystem_type: "gambut", condition: "subur", verification_status: "unverified" };
  const [post, anonymous] = await ForumPostModel.create([{ ...common, is_anonymous: false }, { ...common, is_anonymous: true }]);
  const comment = await ForumCommentModel.create({ post_id: post._id.toString(), author_id: user._id, content: "Original comment" });
  const reply = await ForumCommentModel.create({ post_id: post._id.toString(), parent_id: comment._id.toString(), author_id: user._id, content: "Original reply" });
  await ForumCommentModel.create({ post_id: post._id.toString(), author_id: other._id, content: "Other account comment" });
  await deleteAccount(user._id.toString(), PASSWORD);
  const detail = await getPost(post._id.toString()); assert.ok(detail);
  assert.deepEqual(JSON.parse(JSON.stringify(detail.author)), deletedAuthor);
  assert.equal(detail.caption, "Content remains"); assert.equal(detail.metrics.comments_count, 3);
  const comments = await listComments(post._id.toString(), 1, 10, "new", null);
  assert.equal(comments!.pagination.total_items, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(comments!.items.find(item => item.id === comment._id.toString())!.author)), deletedAuthor);
  assert.equal(comments!.items.find(item => item.author.username === "OtherAccount")!.content, "Other account comment");
  const replies = await listComments(post._id.toString(), 1, 10, "new", comment._id.toString());
  assert.equal(replies!.items[0].id, reply._id.toString()); assert.equal(replies!.items[0].content, "Original reply");
  assert.deepEqual(JSON.parse(JSON.stringify(replies!.items[0].author)), deletedAuthor);
  assert.deepEqual(JSON.parse(JSON.stringify((await getPost(anonymous._id.toString()))!.author)), deletedAuthor);
  const feed = await listPosts(1, 25); assert.equal(feed.items.length, 2);
  assert.ok(feed.items.every(item => item.author.username === "Deleted Account"));
  const recovery = await listRecoveryReports({ bbox: [100, -10, 120, 10], region: "all", condition: "all", ecosystem: "all" });
  assert.equal(recovery.items.length, 2); assert.ok(recovery.items.every(item => item.author.username === "Deleted Account"));
  const publicData = JSON.stringify([detail, feed, replies, recovery]);
  for (const secret of [user._id.toString(), "BeforeDeletion", "Private name", "Private city", "avatar.webp", user.email!]) assert.equal(publicData.includes(secret), false, secret);
  assert.equal(await ForumPostModel.countDocuments(), 2); assert.equal(await ForumCommentModel.countDocuments(), 3);
});

test("registering the same email creates a fresh account without old content or access", async () => {
  const originalId = user._id.toString(); const originalEmail = user.email!;
  await ForumCommentModel.create({ post_id: "post-kb-001", author_id: user._id, content: "Old comment remains" });
  await deleteAccount(originalId, PASSWORD);
  const flow = await start("register", originalEmail);
  const result = await verify(flow.flow_id, originalEmail); assert.equal(result.reset_required, false);
  if (result.reset_required) throw new Error("Expected a new account");
  assert.notEqual(result.user.id, originalId);
  const history = await getActivity(result.user.id, "comments", 1, 10);
  assert.equal(history.pagination.total_items, 0);
  assert.equal((await UserModel.findById(originalId))!.is_active, false);
  const comments = await listComments("post-kb-001", 1, 10, "new", null);
  assert.equal(comments!.items[0].author.username, "Deleted Account");
});

test("a password change during verification prevents stale deletion", async () => {
  const replacement = await hashPassword("ReplacementFixture#2026");
  const passwords = { ...passwordCodec, verify: async () => {
    await UserModel.updateOne({ _id: user._id }, { $set: { password_hash: replacement }, $inc: { password_version: 1 } });
    return true;
  } };
  await expectCode(() => deleteAccount(user._id.toString(), PASSWORD, passwords), "CREDENTIALS_CHANGED");
  const remaining = await UserModel.findById(user._id).select("+password_hash");
  assert.equal(remaining!.is_active, true); assert.equal(remaining!.password_hash, replacement);
});

test("simultaneous delete requests change the account once", async () => {
  let arrivals = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const passwords = { ...passwordCodec, verify: async () => { if (++arrivals === 2) release(); await gate; return true; } };
  const results = await Promise.allSettled([deleteAccount(user._id.toString(), PASSWORD, passwords), deleteAccount(user._id.toString(), PASSWORD, passwords)]);
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
  assert.equal((await UserModel.findById(user._id))!.password_version, 2);
});

test("unavailable password hashing leaves the account intact", async () => {
  const passwords = { ...passwordCodec, verify: async () => { throw new PasswordBusyError(); } };
  await expectCode(() => deleteAccount(user._id.toString(), PASSWORD, passwords), "PASSWORD_BUSY");
  assert.equal((await request("GET")).status, 200);
});

test("cleanup failure cannot revive sessions or bound OTP challenges", async () => {
  const flow = await start("reset"); await verify(flow.flow_id);
  const originalSessions = authStore.sessions, originalFlows = authStore.flows;
  const failed = async () => { throw new Error("Fixture cleanup unavailable"); };
  const errors: string[] = []; const originalLog = console.error;
  try {
    authStore.sessions = () => { const collection = originalSessions(); return Object.assign(Object.create(collection), { deleteMany: failed }); };
    authStore.flows = () => { const collection = originalFlows(); return Object.assign(Object.create(collection), { deleteMany: failed }); };
    console.error = value => { errors.push(String(value)); };
    await deleteAccount(user._id.toString(), PASSWORD);
  } finally { authStore.sessions = originalSessions; authStore.flows = originalFlows; console.error = originalLog; }
  assert.deepEqual(errors, ["Account cleanup pending."]);
  assert.equal((await request("GET")).status, 401);
  await expectCode(() => service.getFlow(flow.flow_id, proof), "FLOW_EXPIRED");
  await expectCode(() => service.resend({ flow_id: flow.flow_id, request_id: randomUUID() }, proof, "198.51.100.51"), "FLOW_EXPIRED");
  await expectCode(() => service.resetPassword({ flow_id: flow.flow_id, password: "ReplacementFixture#2026" }, proof, "198.51.100.51"), "FLOW_EXPIRED");
});
