// Verify authenticated threaded comments and account-scoped votes.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { createSession } from "../src/modules/auth/session.service.js";
import { UserModel } from "../src/modules/auth/user.model.js";
import { ForumCommentModel, ForumCommentVoteModel, ForumPostModel } from "../src/modules/forum/forum.model.js";

const dbName = `buktipulih_forum_comments_test_${process.pid}`;
let server: Server | undefined;
let baseUrl: string;
let userOne: InstanceType<typeof UserModel>;
let userTwo: InstanceType<typeof UserModel>;
let cookieOne: string;
let cookieTwo: string;
const contexts = new Map<string, string>();
let postOne: InstanceType<typeof ForumPostModel>;
let postTwo: InstanceType<typeof ForumPostModel>;

before(async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27017/${dbName}`);
  await Promise.all([UserModel.init(), ForumPostModel.init(), ForumCommentModel.init(), ForumCommentVoteModel.init()]);
  [userOne, userTwo] = await UserModel.create([
    { email: "thread-one@example.test", role: "PUBLIC_GUEST", username: "thread_one", participation: "affected" },
    { email: "thread-two@example.test", role: "COMMUNITY_VOLUNTEER", username: "thread_two", participation: "volunteer" },
  ]);
  [postOne, postTwo] = await ForumPostModel.create([
    { author_id: userOne._id, location_name: "Post one", region_key: "kalbar", caption: "First", media: { type: "image", url: "https://example.test/one.jpg", aspect_ratio: "landscape" } },
    { author_id: userTwo._id, location_name: "Post two", region_key: "riau", caption: "Second", media: { type: "image", url: "https://example.test/two.jpg", aspect_ratio: "landscape" } },
  ]);
  const sessionCookie = async (userId: string) => {
    const { token, context } = await createSession(userId);
    const cookie = `bp_session=${token}`;
    contexts.set(cookie, context);
    return cookie;
  };
  [cookieOne, cookieTwo] = await Promise.all([sessionCookie(userOne._id.toString()), sessionCookie(userTwo._id.toString())]);
  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  }
  assert.equal(mongoose.connection.name, dbName);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

async function request(path: string, options: RequestInit = {}, cookie?: string) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set("Cookie", cookie);
  const context = cookie ? contexts.get(cookie) : undefined;
  if (context) headers.set("x-session-context", context);
  if (options.body) headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET") headers.set("Origin", "http://localhost:3001");
  return fetch(`${baseUrl}${path}`, { ...options, headers });
}
const json = (value: unknown) => JSON.stringify(value);
const commentsPath = (postId = postOne._id.toString()) => `/api/v1/forum/posts/${postId}/comments`;
const comment = (content = "A useful comment", extra: Record<string, unknown> = {}) => ({ content, ...extra });
const writeComment = async (cookie: string, postId = postOne._id.toString(), body = comment()) => request(commentsPath(postId), { method: "POST", body: json(body) }, cookie);

 test("comment writes require a completed authenticated account and reject anonymous or spoofed data", async () => {
  assert.equal((await writeComment("", postOne._id.toString())).status, 401);
  const incomplete = await UserModel.create({ email: "incomplete@example.test", role: "PUBLIC_GUEST" });
  const { token, context } = await createSession(incomplete._id.toString());
  const incompleteCookie = `bp_session=${token}`;
  contexts.set(incompleteCookie, context);
  const blocked = await writeComment(incompleteCookie);
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.code, "PROFILE_INCOMPLETE");
  for (const fields of [{ author_id: userTwo._id.toString() }, { is_anonymous: true }, { anonymous: true }, { username: "forged" }]) {
    assert.equal((await writeComment(cookieOne, postOne._id.toString(), comment("Trying forged identity", fields))).status, 422);
  }
  const csrf = await fetch(`${baseUrl}${commentsPath()}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookieOne, "x-session-context": contexts.get(cookieOne)! }, body: json(comment()) });
  assert.equal(csrf.status, 403);
});

test("comments reply only within the same post and expose parent and direct reply count", async () => {
  const created = await writeComment(cookieOne);
  assert.equal(created.status, 201);
  const root = (await created.json()).data;
  assert.equal(root.parent_id, null);
  assert.equal(root.score, 0);
  assert.equal(root.viewer_vote, null);
  assert.equal(root.reply_count, 0);
  assert.equal((await writeComment(cookieTwo, postTwo._id.toString(), comment("Cross post", { parent_id: root.id }))).status, 404);
  assert.equal((await request(`${commentsPath(postTwo._id.toString())}?parent_id=${root.id.toUpperCase()}`)).status, 404);
  const replyResponse = await writeComment(cookieTwo, postOne._id.toString().toUpperCase(), comment("A direct reply", { parent_id: root.id.toUpperCase() }));
  assert.equal(replyResponse.status, 201);
  const reply = (await replyResponse.json()).data;
  assert.equal(reply.parent_id, root.id);
  const children = await request(`${commentsPath(postOne._id.toString().toUpperCase())}?parent_id=${root.id.toUpperCase()}`);
  const childData = (await children.json()).data;
  assert.equal(childData.items.length, 1);
  assert.equal(childData.items[0].id, reply.id);
  assert.equal(childData.total_comments, 2);
  const roots = (await (await request(commentsPath())).json()).data.items;
  assert.equal(roots[0].reply_count, 1);
});

test("legacy comments without parent_id remain roots and top/new are deterministic paged lists", async () => {
  const legacyA = await ForumCommentModel.create({ post_id: "post-kb-001", author_id: userOne._id, content: "Older legacy root", created_at: new Date("2020-01-01T00:00:00Z") });
  const legacyB = await ForumCommentModel.create({ post_id: "post-kb-001", parent_id: null, author_id: userTwo._id, content: "Newer legacy root", created_at: new Date("2021-01-01T00:00:00Z") });
  await ForumCommentModel.collection.updateOne({ _id: legacyA._id }, { $unset: { parent_id: "" } });
  await ForumCommentVoteModel.create([
    { comment_id: legacyA._id.toString(), user_id: userOne._id, vote: "up" },
    { comment_id: legacyA._id.toString(), user_id: userTwo._id, vote: "up" },
    { comment_id: legacyB._id.toString(), user_id: userOne._id, vote: "down" },
  ]);
  const top = await request("/api/v1/forum/posts/post-kb-001/comments?sort=top&page=1&limit=1");
  const topData = (await top.json()).data;
  assert.equal(topData.items[0].id, legacyA._id.toString());
  assert.equal(topData.items[0].score, 2);
  assert.equal(topData.total_comments, 2);
  assert.equal(topData.pagination.total_items, 2);
  const topPageTwo = (await (await request("/api/v1/forum/posts/post-kb-001/comments?sort=top&page=2&limit=1")).json()).data;
  assert.equal(topPageTwo.items[0].id, legacyB._id.toString());
  const newest = (await (await request("/api/v1/forum/posts/post-kb-001/comments?sort=new")).json()).data;
  assert.equal(newest.items[0].id, legacyB._id.toString());
  assert.equal(newest.items[1].parent_id, null);
  for (const url of ["?sort=invalid", "?parent_id=bad", "?page=0"]) assert.equal((await request(`/api/v1/forum/posts/post-kb-001/comments${url}`)).status, 422);
});

test("one account has one switchable vote, concurrent retries do not duplicate it, and reads are private", async () => {
  const created = await writeComment(cookieOne, postTwo._id.toString());
  const id = (await created.json()).data.id as string;
  const voteUrl = `${commentsPath(postTwo._id.toString().toUpperCase())}/${id.toUpperCase()}/vote`;
  assert.equal((await request(voteUrl, { method: "POST", body: json({ vote: "up" }) })).status, 401);
  const wrongContext = await fetch(`${baseUrl}${voteUrl}`, { method: "POST", headers: {
    "Content-Type": "application/json", Origin: "http://localhost:3001", Cookie: cookieOne, "x-session-context": "wrong-context",
  }, body: json({ vote: "up" }) });
  assert.equal(wrongContext.status, 409);
  const incomplete = await UserModel.create({ email: "vote-incomplete@example.test", role: "PUBLIC_GUEST" });
  const incompleteSession = await createSession(incomplete._id.toString());
  const incompleteCookie = `bp_session=${incompleteSession.token}`;
  contexts.set(incompleteCookie, incompleteSession.context);
  assert.equal((await request(voteUrl, { method: "POST", body: json({ vote: "up" }) }, incompleteCookie).then(async response => {
    assert.equal((await response.json()).error.code, "PROFILE_INCOMPLETE"); return response;
  })).status, 409);
  const noOrigin = await fetch(`${baseUrl}${voteUrl}`, { method: "POST", headers: {
    "Content-Type": "application/json", Cookie: cookieOne, "x-session-context": contexts.get(cookieOne)!,
  }, body: json({ vote: "up" }) });
  assert.equal(noOrigin.status, 403);
  const upBody = { method: "POST", body: json({ vote: "up" }) };
  const parallel = await Promise.all([request(voteUrl, upBody, cookieOne), request(voteUrl, upBody, cookieOne)]);
  assert.ok(parallel.every(response => response.status === 200));
  assert.equal(await ForumCommentVoteModel.countDocuments({ comment_id: id, user_id: userOne._id }), 1);
  let current = (await (await request(voteUrl, { method: "POST", body: json({ vote: "down" }) }, cookieOne)).json()).data;
  assert.deepEqual({ score: current.score, viewer_vote: current.viewer_vote }, { score: -1, viewer_vote: "down" });
  const secondAccount = await request(voteUrl, { method: "POST", body: json({ vote: "up" }) }, cookieTwo);
  assert.equal((await secondAccount.json()).data.score, 0);
  const clear = await request(voteUrl, { method: "POST", body: json({ vote: "clear" }) }, cookieOne);
  assert.deepEqual((await clear.json()).data, { comment_id: id, score: 1, viewer_vote: null });
  assert.equal(await ForumCommentVoteModel.countDocuments({ comment_id: id }), 1);
  const signedInRead = await request(commentsPath(postTwo._id.toString()), {}, cookieTwo);
  const publicRead = await request(commentsPath(postTwo._id.toString()));
  assert.equal(signedInRead.headers.get("cache-control"), "private, no-store");
  const signedData = (await signedInRead.clone().json()).data.items[0];
  const publicData = (await publicRead.json()).data.items[0];
  assert.equal(signedData.viewer_vote, "up");
  assert.equal(publicData.viewer_vote, null);
  assert.equal(publicRead.headers.get("cache-control"), "private, no-store");
  assert.equal((await request(voteUrl, { method: "POST", body: json({ vote: "up", user_id: userTwo._id.toString() }) }, cookieOne)).status, 422);
});

test("legacy comments support root and reply votes with a score round trip", async () => {
  const rootResponse = await writeComment(cookieOne, "post-kb-011", comment("Legacy root comment"));
  assert.equal(rootResponse.status, 201);
  const root = (await rootResponse.json()).data;
  const replyResponse = await writeComment(cookieTwo, "post-kb-011", comment("Legacy reply", { parent_id: root.id.toUpperCase() }));
  assert.equal(replyResponse.status, 201);
  const reply = (await replyResponse.json()).data;
  const feed = (await (await request("/api/v1/forum/posts?limit=1")).json()).data;
  assert.equal(feed.legacy_comment_counts["post-kb-011"], 2);
  const voteUrl = `/api/v1/forum/posts/post-kb-011/comments/${reply.id.toUpperCase()}/vote`;
  const voted = await request(voteUrl, { method: "POST", body: json({ vote: "up" }) }, cookieOne);
  assert.equal(voted.status, 200);
  assert.deepEqual((await voted.json()).data, { comment_id: reply.id, score: 1, viewer_vote: "up" });
  const listed = await request(`/api/v1/forum/posts/post-kb-011/comments?parent_id=${root.id}&sort=top`, {}, cookieOne);
  const listedReply = (await listed.json()).data.items.find((item: { id: string }) => item.id === reply.id);
  assert.equal(listedReply.score, 1);
  assert.equal(listedReply.viewer_vote, "up");
  const cleared = await request(voteUrl, { method: "POST", body: json({ vote: "clear" }) }, cookieOne);
  assert.deepEqual((await cleared.json()).data, { comment_id: reply.id, score: 0, viewer_vote: null });
});

test("replies appear in owner history with their parent id", async () => {
  const root = await writeComment(cookieOne);
  const rootId = (await root.json()).data.id;
  const reply = await writeComment(cookieTwo, postOne._id.toString(), comment("History reply", { parent_id: rootId }));
  const replyId = (await reply.json()).data.id;
  const history = await request("/api/v1/auth/me/activity?type=comments&page=1&limit=10", {}, cookieTwo);
  const item = (await history.json()).data.items.find((entry: { id: string }) => entry.id === replyId);
  assert.equal(item.parent_id, rootId);
});
