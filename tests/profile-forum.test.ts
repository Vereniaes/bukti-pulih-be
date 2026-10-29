// Verify safe profiles, server-owned Forum authors and per-account history.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { createSession } from "../src/modules/auth/session.service.js";
import { UserModel } from "../src/modules/auth/user.model.js";
import { ForumCommentModel, ForumPostModel } from "../src/modules/forum/forum.model.js";

const dbName = `buktipulih_profile_forum_test_${process.pid}`;
let server: Server | undefined;
let baseUrl: string;
let userOne: InstanceType<typeof UserModel>;
let userTwo: InstanceType<typeof UserModel>;
let cookieOne: string;
let cookieTwo: string;
const sessionContexts = new Map<string, string>();

before(async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27017/${dbName}`);
  await Promise.all([UserModel.init(), ForumPostModel.init(), ForumCommentModel.init()]);
  [userOne, userTwo] = await UserModel.create([
    { email: "profile-one@example.test", full_name: "Private Real Name One", role: "COMMUNITY_VOLUNTEER" },
    { email: "profile-two@example.test", full_name: "Private Real Name Two", role: "PUBLIC_GUEST" },
  ]);
  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const sessionCookie = async (userId: string) => {
    const { token, context } = await createSession(userId);
    const cookie = `bp_session=${token}`;
    sessionContexts.set(cookie, context);
    return cookie;
  };
  cookieOne = await sessionCookie(userOne._id.toString());
  cookieTwo = await sessionCookie(userTwo._id.toString());
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  }
  assert.equal(mongoose.connection.name, dbName);
  assert.match(mongoose.connection.name, /^buktipulih_profile_forum_test_/);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

async function request(path: string, options: RequestInit = {}, cookie?: string) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set("Cookie", cookie);
  const context = cookie ? sessionContexts.get(cookie) : undefined;
  if (context) headers.set("x-session-context", context);
  if (options.body) headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET") headers.set("Origin", "http://localhost:3001");
  return fetch(`${baseUrl}${path}`, { ...options, headers });
}
const json = (value: unknown) => JSON.stringify(value);

test("opaque session and me return a safe profile without private auth fields", async () => {
  const response = await request("/api/v1/auth/me", {}, cookieOne);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.match(body.data.user.session_context, /^[a-f0-9-]{36}$/);
  assert.deepEqual(body.data.user, {
    id: userOne._id.toString(), username: null, username_saves_remaining: 2, participation: null, avatar_url: null, city: "",
    email: userOne.email, phone_number: null, role: "COMMUNITY_VOLUNTEER", role_badge: userOne.role_badge,
    organization_name: null, assigned_plots: [], created_at: userOne.created_at.toISOString(),
    session_context: sessionContexts.get(cookieOne),
  });
  assert.equal(JSON.stringify(body).includes("Private Real Name"), false);
  assert.equal(JSON.stringify(body).includes("pin_hash"), false);
  assert.equal((await request("/api/v1/auth/me/activity", {}, undefined)).status, 401);
});

test("profile preserves username spelling, validates avatar and never changes account role", async () => {
  const updated = await request("/api/v1/auth/me", {
    method: "PATCH", body: json({
      username: "Forest_One", participation: "affected",
      avatar_url: "https://files.public.blob.vercel-storage.com/avatar.png", city: "Kota",
    }),
  }, cookieOne);
  assert.equal(updated.status, 200);
  const profile = (await updated.json()).data;
  assert.equal(profile.username, "Forest_One");
  assert.equal(profile.participation, "affected");
  assert.equal(profile.role, "COMMUNITY_VOLUNTEER");
  assert.equal(profile.city, "Kota");
  assert.equal("full_name" in profile, false);

  const duplicate = await request("/api/v1/auth/me", {
    method: "PATCH", body: json({ username: "FOREST_ONE", participation: "volunteer" }),
  }, cookieTwo);
  assert.equal(duplicate.status, 409);
  assert.equal((await UserModel.findById(userTwo._id))?.username, undefined);

  const forbidden = await request("/api/v1/auth/me", {
    method: "PATCH", body: json({ username: "another_user", participation: "volunteer", role: "ADMIN_SUPER" }),
  }, cookieTwo);
  assert.equal(forbidden.status, 422);
  const badAvatar = await request("/api/v1/auth/me", {
    method: "PATCH", body: json({ username: "another_user", participation: "volunteer", avatar_url: "javascript:alert(1)" }),
  }, cookieTwo);
  assert.equal(badAvatar.status, 422);
});

test("concurrent case-insensitive username claims preserve both account roles", async () => {
  const [claimantOne, claimantTwo] = await UserModel.create([
    { email: "claimant-one@example.test", role: "PUBLIC_GUEST" },
    { email: "claimant-two@example.test", role: "COMMUNITY_VOLUNTEER" },
  ]);
  const sessionCookie = async (userId: string) => {
    const { token, context } = await createSession(userId);
    const cookie = `bp_session=${token}`;
    sessionContexts.set(cookie, context);
    return cookie;
  };
  const [sessionOne, sessionTwo] = await Promise.all([
    sessionCookie(claimantOne._id.toString()), sessionCookie(claimantTwo._id.toString()),
  ]);
  const results = await Promise.all([
    request("/api/v1/auth/me", {
      method: "PATCH", body: json({ username: "Shared_Name", participation: "affected" }),
    }, sessionOne),
    request("/api/v1/auth/me", {
      method: "PATCH", body: json({ username: "shared_name", participation: "volunteer" }),
    }, sessionTwo),
  ]);
  assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
  const persisted = await UserModel.find({ _id: { $in: [claimantOne._id, claimantTwo._id] } });
  assert.equal(persisted.filter(user => user.username?.toLowerCase() === "shared_name").length, 1);
  assert.equal((await UserModel.findById(claimantOne._id))?.role, "PUBLIC_GUEST");
  assert.equal((await UserModel.findById(claimantTwo._id))?.role, "COMMUNITY_VOLUNTEER");
});
test("Forum writes take identity from the session and histories are private and paginated", async () => {
  const incompletePost = await request("/api/v1/forum/posts", { method: "POST", body: json({
    submission_id: randomUUID(), location: { type: "Point", coordinates: [109.2, -.8] }, ecosystem_type: "gambut", condition: "subur",
    location_name: "Area B", region_key: "kalbar", caption: "A field update",
    media: { type: "image", url: "https://files.public.blob.vercel-storage.com/bukti-lapangan/photo.jpg", aspect_ratio: "landscape" },
  }) }, cookieTwo);
  assert.equal(incompletePost.status, 409);
  assert.equal((await incompletePost.json()).error.code, "PROFILE_INCOMPLETE");
  const postResponse = await request("/api/v1/forum/posts", {
    method: "POST",
    body: json({
      submission_id: randomUUID(), location: { type: "Point", coordinates: [109.2, -.8] }, ecosystem_type: "gambut", condition: "subur",
      location_name: "Area A", region_key: "kalbar", caption: "A field update",
      media: { type: "image", url: "https://files.public.blob.vercel-storage.com/bukti-lapangan/photo.jpg", aspect_ratio: "landscape" },
      author_id: userTwo._id.toString(),
    }),
  }, cookieOne);
  assert.equal(postResponse.status, 422);
  const savedPostResponse = await request("/api/v1/forum/posts", {
    method: "POST",
    body: json({
      submission_id: randomUUID(), location: { type: "Point", coordinates: [109.2, -.8] }, ecosystem_type: "gambut", condition: "subur",
      location_name: "Area A", region_key: "kalbar", caption: "A field update",
      media: { type: "image", url: "https://files.public.blob.vercel-storage.com/bukti-lapangan/photo.jpg", aspect_ratio: "landscape" },
    }),
  }, cookieOne);
  assert.equal(savedPostResponse.status, 201);
  const post = (await savedPostResponse.json()).data;
  assert.equal(post.author.user_id, userOne._id.toString());
  assert.equal(post.author.username, "Forest_One");
  assert.equal(post.author.age, 0);
  assert.equal(post.author.full_name, undefined);
  assert.deepEqual(post.metrics, { likes: 0, views: 0, comments_count: 0 });
  assert.equal(post.persisted, true);
  const anonymousResponse = await request("/api/v1/forum/posts", {
    method: "POST",
    body: json({
      submission_id: randomUUID(), location: { type: "Point", coordinates: [109.2, -.8] }, ecosystem_type: "gambut", condition: "subur",
    location_name: "Area B", region_key: "kalbar", caption: "An anonymous update",
      media: { type: "image", url: "https://files.public.blob.vercel-storage.com/bukti-lapangan/photo.jpg", aspect_ratio: "landscape" },
      is_anonymous: true,
    }),
  }, cookieOne);
  assert.equal(anonymousResponse.status, 201);
  const anonymousPost = (await anonymousResponse.json()).data;
  assert.deepEqual(anonymousPost.author, {
    username: "Anonim", age: 0, city: "", avatar_url: null, participation: null,
  });
  const anonymousDetail = await request(`/api/v1/forum/posts/${anonymousPost.id}`);
  const anonymousPublicAuthor = (await anonymousDetail.json()).data.author;
  assert.equal(anonymousPublicAuthor.user_id, undefined);
  assert.equal(anonymousPublicAuthor.avatar_url, null);
  assert.equal(anonymousPublicAuthor.username, "Anonim");

  const incompleteComment = await request(`/api/v1/forum/posts/${post.id}/comments`, {
    method: "POST", body: json({ content: "Thanks for the update" }),
  }, cookieTwo);
  assert.equal(incompleteComment.status, 409);
  assert.equal((await incompleteComment.json()).error.code, "PROFILE_INCOMPLETE");

  const completedProfile = await request("/api/v1/auth/me", {
    method: "PATCH", body: json({ username: "forest_two", participation: "volunteer" }),
  }, cookieTwo);
  assert.equal(completedProfile.status, 200);
  const commentResponse = await request(`/api/v1/forum/posts/${post.id}/comments`, {
    method: "POST", body: json({ content: "Thanks for the update", post_title: "Client supplied title" }),
  }, cookieTwo);
  assert.equal(commentResponse.status, 201);
  const comment = (await commentResponse.json()).data;
  assert.equal(comment.author.user_id, userTwo._id.toString());
  assert.equal(comment.author.username, "forest_two");

  const legacy = await request("/api/v1/forum/posts/post-kb-001/comments", {
    method: "POST", body: json({ content: "I checked the site", post_title: "Legacy field note" }),
  }, cookieTwo);
  assert.equal(legacy.status, 201);

  const publicList = await request("/api/v1/forum/posts");
  assert.equal(publicList.status, 200);
  const publicItems = (await publicList.json()).data.items;
  assert.equal(publicItems.length, 2);
  const anonymousListAuthor = publicItems.find((item: { id: string }) => item.id === anonymousPost.id).author;
  assert.equal(anonymousListAuthor.user_id, undefined);
  assert.equal(anonymousListAuthor.username, "Anonim");
  const publicDetail = await request(`/api/v1/forum/posts/${post.id}`);
  assert.equal((await publicDetail.json()).data.comments[0].content, "Thanks for the update");
  const legacyComments = await request("/api/v1/forum/posts/post-kb-001/comments");
  assert.equal((await legacyComments.json()).data.items.length, 1);

  const ownPosts = await request("/api/v1/auth/me/activity?type=posts&page=1&limit=10", {}, cookieOne);
  const ownPostHistory = (await ownPosts.json()).data;
  assert.deepEqual(new Set(ownPostHistory.items.map((item: { post_id: string }) => item.post_id)), new Set([post.id, anonymousPost.id]));
  assert.ok(ownPostHistory.items.some((item: { title: string }) => item.title === "Area A"));
  assert.ok(ownPostHistory.items.some((item: { title: string }) => item.title === "Area B"));
  const ownComments = await request("/api/v1/auth/me/activity?type=comments&page=1&limit=10", {}, cookieTwo);
  const ownCommentHistory = (await ownComments.json()).data;
  assert.deepEqual(new Set(ownCommentHistory.items.map((item: { post_id: string }) => item.post_id)), new Set([post.id, "post-kb-001"]));
  assert.ok(ownCommentHistory.items.some((item: { title: string }) => item.title === "Area A"));
  assert.ok(ownCommentHistory.items.some((item: { title: string }) => item.title === "Legacy field note"));
  assert.equal((await request("/api/v1/auth/me/activity?type=posts", {}, cookieTwo).then(r => r.json())).data.items.length, 0);

  for (const path of [
    "/api/v1/forum/posts?page=0", "/api/v1/forum/posts?limit=51",
    "/api/v1/auth/me/activity?type=bad", "/api/v1/auth/me/activity?type=posts&page=x",
    "/api/v1/auth/me/activity?type=posts&limit=21",
  ]) assert.equal((await request(path, {}, cookieOne)).status, 422);
});

test("inactive users cannot read or write private data", async () => {
  await UserModel.updateOne({ _id: userOne._id }, { $set: { is_active: false } });
  assert.equal((await request("/api/v1/auth/me", {}, cookieOne)).status, 401);
  assert.equal((await request("/api/v1/auth/me/activity?type=posts", {}, cookieOne)).status, 401);
  const post = await request("/api/v1/forum/posts", { method: "POST", body: json({}) }, cookieOne);
  assert.equal(post.status, 401);
});


test("usernames accept short, Unicode, symbol and emoji names without changing case", async () => {
  const names = ["A", "C++", "Rimba.Hijau+", "Élodie", "緑の森", "A🌿", "🌿".repeat(24), "<b>Rimba</b>"];
  for (const [index, username] of names.entries()) {
    const owner = await UserModel.create({ email: `flexible-owner-${index}@example.test`, role: "PUBLIC_GUEST" });
    const session = await createSession(owner._id.toString());
    const cookie = `bp_session=${session.token}`;
    sessionContexts.set(cookie, session.context);
    const response = await request("/api/v1/auth/me", { method: "PATCH", body: json({ username, participation: "observer" }) }, cookie);
    assert.equal(response.status, 200, username);
    assert.equal((await response.json()).data.username, username);
    assert.equal((await UserModel.findById(owner._id))?.username, username);
  }
  const duplicate = await request("/api/v1/auth/me", { method: "PATCH", body: json({ username: "<B>RIMBA</B>", participation: "observer" }) }, cookieTwo);
  assert.equal(duplicate.status, 409);
});

test("whitespace, empty and overlength usernames fail without changing the profile", async () => {
  const owner = await UserModel.create({ email: "username-boundary@example.test", username: "Valid.Name", role: "PUBLIC_GUEST" });
  const session = await createSession(owner._id.toString());
  const cookie = `bp_session=${session.token}`;
  sessionContexts.set(cookie, session.context);
  for (const username of ["", " A", "A ", "A B", "A\tB", "A\nB", "A\u00a0B", "A\u3000B", "a".repeat(25), "🌿".repeat(25)]) {
    const response = await request("/api/v1/auth/me", { method: "PATCH", body: json({ username, participation: "observer" }) }, cookie);
    assert.equal(response.status, 422, JSON.stringify(username));
    assert.equal((await UserModel.findById(owner._id))?.username, "Valid.Name");
  }
});

async function cookieFor(userId: string) {
  const session = await createSession(userId);
  const cookie = `bp_session=${session.token}`;
  sessionContexts.set(cookie, session.context);
  return cookie;
}
const patch = (cookie: string, value: unknown) => request("/api/v1/auth/me", { method: "PATCH", body: json(value) }, cookie);

test("first and second username saves persist; further changes are rejected while other profile edits still work", async () => {
  const owner = await UserModel.create({ email: "username-count@example.test", role: "PUBLIC_GUEST" });
  const cookie = await cookieFor(owner._id.toString());
  let response = await request("/api/v1/auth/me", {}, cookie);
  assert.equal((await response.json()).data.user.username_saves_remaining, 2);
  response = await patch(cookie, { username: "First🌿" });
  assert.equal(response.status, 200); assert.equal((await response.json()).data.username_saves_remaining, 1);
  response = await patch(cookie, { username: "First🌿" });
  assert.equal(response.status, 200); assert.equal((await response.json()).data.username_saves_remaining, 1);
  response = await patch(cookie, { username: "FIRST🌿" });
  assert.equal(response.status, 200); assert.equal((await response.json()).data.username_saves_remaining, 0);
  response = await patch(cookie, { username: "Third🌿", city: "Must not save" });
  assert.equal(response.status, 409); assert.equal((await response.json()).error.code, "USERNAME_LIMIT");
  response = await patch(cookie, { username: "FIRST🌿", city: "Pontianak", participation: "volunteer" });
  assert.equal(response.status, 200);
  const profile = (await response.json()).data;
  assert.equal(profile.username, "FIRST🌿"); assert.equal(profile.city, "Pontianak"); assert.equal(profile.username_saves_remaining, 0);
  assert.equal((await UserModel.findById(owner._id)).username_save_count, 2);
  response = await request("/api/v1/auth/me", {}, cookie);
  assert.equal((await response.json()).data.user.username_saves_remaining, 0);
});

test("existing usernames without a stored count have one change remaining", async () => {
  const owner = await UserModel.create({ email: "username-legacy@example.test", username: "LegacyBefore", role: "PUBLIC_GUEST" });
  await UserModel.collection.updateOne({ _id: owner._id }, { $unset: { username_save_count: "" } });
  const cookie = await cookieFor(owner._id.toString());
  const before = (await (await request("/api/v1/auth/me", {}, cookie)).json()).data.user;
  assert.equal(before.username_saves_remaining, 1);
  const changed = await patch(cookie, { username: "LegacyAfter" });
  assert.equal(changed.status, 200); assert.equal((await changed.json()).data.username_saves_remaining, 0);
  const stored = await UserModel.collection.findOne({ _id: owner._id });
  assert.equal(stored!.username_save_count, 2); assert.equal(stored!.username, "LegacyAfter");
});

test("duplicate, invalid, forged email and forged counter requests cannot spend or reset the limit", async () => {
  await UserModel.create({ email: "username-taken@example.test", username: "TakenName", role: "PUBLIC_GUEST" });
  const owner = await UserModel.create({ email: "username-protected@example.test", username: "OriginalName", role: "PUBLIC_GUEST" });
  const cookie = await cookieFor(owner._id.toString());
  for (const [payload, status] of [
    [{ username: "TAKENNAME" }, 409], [{ username: "No spaces" }, 422],
    [{ email: "attacker@example.test" }, 422], [{ username_save_count: 0 }, 422],
    [{ username: "ValidNewName", email: "attacker@example.test" }, 422], [{}, 422],
  ] as const) assert.equal((await patch(cookie, payload)).status, status);
  const after = await UserModel.findById(owner._id);
  assert.equal(after!.username, "OriginalName"); assert.equal(after!.email, "username-protected@example.test");
  const profile = (await (await request("/api/v1/auth/me", {}, cookie)).json()).data.user;
  assert.equal(profile.username_saves_remaining, 1);
  assert.equal((await patch(cookie, { username: "AllowedName" })).status, 200);
});

test("concurrent sessions can use the final username save only once", async () => {
  const owner = await UserModel.create({ email: "username-race@example.test", username: "RaceInitial", role: "PUBLIC_GUEST" });
  const [first, second, third] = await Promise.all(Array.from({ length: 3 }, () => cookieFor(owner._id.toString())));
  const responses = await Promise.all([
    patch(first, { username: "RaceFirst" }), patch(second, { username: "RaceSecond" }), patch(third, { username: "RaceThird" }),
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409, 409]);
  const winner = (await responses.find(response => response.status === 200)!.json()).data;
  assert.equal(winner.username_saves_remaining, 0);
  const stored = await UserModel.findById(owner._id);
  assert.equal(stored!.username, winner.username); assert.equal(stored!.username_save_count, 2);
  assert.equal((await patch(first, { username: "RaceFourth" })).status, 409);
});

test("concurrent first saves cannot overwrite each other or consume more than one slot", async () => {
  const owner = await UserModel.create({ email: "username-first-race@example.test", role: "PUBLIC_GUEST" });
  const [first, second] = await Promise.all([cookieFor(owner._id.toString()), cookieFor(owner._id.toString())]);
  const responses = await Promise.all([patch(first, { username: "FirstRaceA" }), patch(second, { username: "FirstRaceB" })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const stored = await UserModel.findById(owner._id);
  assert.equal(stored!.username_save_count, 1);
  const fresh = await request("/api/v1/auth/me", {}, second);
  assert.equal((await fresh.json()).data.user.username_saves_remaining, 1);
  const next = await patch(second, { username: "FinalRace" });
  assert.equal(next.status, 200); assert.equal((await next.json()).data.username_saves_remaining, 0);
});


test("concurrent username and biodata saves preserve both changes", async () => {
  const owner = await UserModel.create({ email: "username-and-biodata@example.test", username: "BeforeBoth", city: "Before", participation: "observer", role: "PUBLIC_GUEST" });
  const [first, second] = await Promise.all([cookieFor(owner._id.toString()), cookieFor(owner._id.toString())]);
  const responses = await Promise.all([
    patch(first, { username: "AfterBoth" }), patch(second, { city: "After", participation: "volunteer" }),
  ]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  const profile = (await (await request("/api/v1/auth/me", {}, first)).json()).data.user;
  assert.equal(profile.username, "AfterBoth"); assert.equal(profile.city, "After");
  assert.equal(profile.participation, "volunteer"); assert.equal(profile.username_saves_remaining, 0);
});
