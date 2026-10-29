// Check authenticated, private and map-ready geolocated community evidence.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { createSession } from "../src/modules/auth/session.service.js";
import { UserModel } from "../src/modules/auth/user.model.js";
import { ForumPostModel } from "../src/modules/forum/forum.model.js";
import { PlotModel } from "../src/modules/plots/plot.model.js";
import { ReportInboxModel } from "../src/modules/reports/report.model.js";
import { MonitoringLogModel } from "../src/modules/timeline/timeline.model.js";

const dbName = `buktipulih_geolocated_evidence_test_${process.pid}`;
let server: Server | undefined;
let baseUrl: string;
let userOne: InstanceType<typeof UserModel>;
let userTwo: InstanceType<typeof UserModel>;
let cookieOne: string;
let cookieTwo: string;
const sessionContexts = new Map<string, string>();

before(async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27017/${dbName}`);
  await Promise.all([UserModel.init(), ForumPostModel.init(), PlotModel.init(), MonitoringLogModel.init(), ReportInboxModel.init()]);
  [userOne, userTwo] = await UserModel.create([
    { email: "evidence-one@example.test", role: "COMMUNITY_VOLUNTEER" },
    { email: "evidence-two@example.test", role: "PUBLIC_GUEST" },
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
  [cookieOne, cookieTwo] = await Promise.all([
    sessionCookie(userOne._id.toString()), sessionCookie(userTwo._id.toString()),
  ]);
  for (const [cookie, username] of [[cookieOne, "evidence_one"], [cookieTwo, "evidence_two"]] as const) {
    const response = await request("/api/v1/auth/me", {
      method: "PATCH", body: json({ username, participation: "volunteer" }),
    }, cookie);
    assert.equal(response.status, 200);
  }
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  }
  assert.equal(mongoose.connection.name, dbName);
  assert.match(mongoose.connection.name, /^buktipulih_geolocated_evidence_test_/);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

async function request(path: string, options: RequestInit = {}, cookie?: string, contextOverride?: string) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set("Cookie", cookie);
  const context = contextOverride ?? (cookie ? sessionContexts.get(cookie) : undefined);
  if (context) headers.set("x-session-context", context);
  if (options.body) headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET") headers.set("Origin", "http://localhost:3001");
  return fetch(`${baseUrl}${path}`, { ...options, headers });
}
const json = (value: unknown) => JSON.stringify(value);
const submissionId = () => crypto.randomUUID();
const evidence = (overrides: Record<string, unknown> = {}) => ({
  location_name: "Area A", region_key: "kalbar", caption: "Field update",
  media: { type: "image", url: "https://files.public.blob.vercel-storage.com/bukti-lapangan/photo.jpg", aspect_ratio: "landscape" },
  location: { type: "Point", coordinates: [109.3, -0.02] },
  ecosystem_type: "gambut", condition: "perlu_rawat", submission_id: submissionId(),
  ...overrides,
});

test("new evidence requires an active complete-profile session and valid browser context", async () => {
  assert.equal((await request("/api/v1/forum/posts", { method: "POST", body: json(evidence()) })).status, 401);
  assert.equal((await request("/api/v1/forum/posts", {
    method: "POST", body: json(evidence()),
  }, cookieOne, "stale-session-context")).status, 409);
  const noOrigin = await fetch(`${baseUrl}/api/v1/forum/posts`, {
    method: "POST", headers: { Cookie: cookieOne, "x-session-context": sessionContexts.get(cookieOne)!, "Content-Type": "application/json" },
    body: json(evidence()),
  });
  assert.equal(noOrigin.status, 403);
});

test("evidence rejects missing, malformed and out-of-range WGS84 coordinates", async () => {
  const invalid = [
    { location: undefined },
    { location: { type: "Point", coordinates: ["109.3", -0.02] } },
    { location: { type: "Point", coordinates: [181, 0] } },
    { location: { type: "Point", coordinates: [0, -91] } },
    { location: { type: "Point", coordinates: [null, 0] } },
    { location: { type: "LineString", coordinates: [109.3, -0.02] } },
  ];
  for (const invalidFields of invalid) {
    assert.equal((await request("/api/v1/forum/posts", {
      method: "POST", body: json(evidence(invalidFields)),
    }, cookieOne)).status, 422);
  }
});

test("new evidence rejects external media hosts and non-evidence upload paths", async () => {
  for (const url of ["https://tracker.example.test/photo.jpg", "https://files.public.blob.vercel-storage.com/profiles/photo.jpg", "https://files.public.blob.vercel-storage.com.attacker.test/bukti-lapangan/photo.jpg"]) {
    const body = evidence(); body.media.url = url;
    assert.equal((await request("/api/v1/forum/posts", { method: "POST", body: json(body) }, cookieOne)).status, 422);
  }
});

test("server owns identity and verification state; client cannot set protected fields", async () => {
  for (const protectedFields of [
    { author_id: userTwo._id.toString() },
    { verification_status: "verified" },
  ]) {
    assert.equal((await request("/api/v1/forum/posts", {
      method: "POST", body: json(evidence(protectedFields)),
    }, cookieOne)).status, 422);
  }
  const response = await request("/api/v1/forum/posts", {
    method: "POST", body: json(evidence()),
  }, cookieOne);
  assert.equal(response.status, 201);
  const post = (await response.json()).data;
  assert.equal(post.author.user_id, userOne._id.toString());
  assert.equal(post.verification_status, "unverified");
  assert.deepEqual(post.location, { type: "Point", coordinates: [109.3, -0.02] });
  assert.equal(post.ecosystem_type, "gambut");
  assert.equal(post.condition, "perlu_rawat");
});

test("submission id is idempotent within one account and independent across accounts", async () => {
  const input = evidence();
  const [first, retry] = await Promise.all([
    request("/api/v1/forum/posts", { method: "POST", body: json(input) }, cookieOne),
    request("/api/v1/forum/posts", { method: "POST", body: json(input) }, cookieOne),
  ]);
  assert.ok([201, 200].includes(first.status));
  assert.ok([201, 200].includes(retry.status));
  const [one, two] = await Promise.all([first.json(), retry.json()]);
  assert.equal(one.data.id, two.data.id);
  assert.equal(await ForumPostModel.countDocuments({ author_id: userOne._id, submission_id: input.submission_id }), 1);

  const otherAccount = await request("/api/v1/forum/posts", {
    method: "POST", body: json(input),
  }, cookieTwo);
  assert.equal(otherAccount.status, 201);
  assert.notEqual((await otherAccount.json()).data.id, one.data.id);
});

test("an edited retry cannot silently reuse an already-public report", async () => {
  const input = evidence({ is_anonymous: false });
  const first = await request("/api/v1/forum/posts", { method: "POST", body: json(input) }, cookieOne);
  assert.equal(first.status, 201);
  const saved = (await first.json()).data;
  const edited = await request("/api/v1/forum/posts", { method: "POST", body: json({ ...input, is_anonymous: true }) }, cookieOne);
  assert.equal(edited.status, 409);
  assert.equal((await edited.json()).error.code, "SUBMISSION_CONFLICT");
  assert.equal(await ForumPostModel.countDocuments({ author_id: userOne._id, submission_id: input.submission_id }), 1);
  assert.equal((await ForumPostModel.findById(saved.id))!.is_anonymous, false);
});

test("recovery map applies bbox and filters, hides anonymous identity and excludes legacy posts", async () => {
  const publicResponse = await request("/api/v1/forum/posts", {
    method: "POST", body: json(evidence({ submission_id: submissionId() })),
  }, cookieOne);
  const anonymousResponse = await request("/api/v1/forum/posts", {
    method: "POST", body: json(evidence({ is_anonymous: true, submission_id: submissionId() })),
  }, cookieOne);
  const outsideBbox = await request("/api/v1/forum/posts", {
    method: "POST", body: json(evidence({
      location: { type: "Point", coordinates: [110.5, 0] }, submission_id: submissionId(),
    })),
  }, cookieOne);
  const otherCondition = await request("/api/v1/forum/posts", {
    method: "POST", body: json(evidence({ condition: "kritis", submission_id: submissionId() })),
  }, cookieOne);
  const otherRegion = await request("/api/v1/forum/posts", {
    method: "POST", body: json(evidence({ region_key: "riau", submission_id: submissionId() })),
  }, cookieOne);
  const otherEcosystem = await request("/api/v1/forum/posts", {
    method: "POST", body: json(evidence({ ecosystem_type: "mineral", submission_id: submissionId() })),
  }, cookieOne);
  assert.equal(publicResponse.status, 201);
  assert.equal(anonymousResponse.status, 201);
  assert.equal(outsideBbox.status, 201);
  assert.equal(otherCondition.status, 201);
  assert.equal(otherRegion.status, 201);
  assert.equal(otherEcosystem.status, 201);

  const publicPostId = (await publicResponse.json()).data.id;
  const anonymousId = (await anonymousResponse.json()).data.id;
  const outsideBboxId = (await outsideBbox.json()).data.id;
  const otherConditionId = (await otherCondition.json()).data.id;
  const otherRegionId = (await otherRegion.json()).data.id;
  const otherEcosystemId = (await otherEcosystem.json()).data.id;
  const legacy = await ForumPostModel.create({
    author_id: userOne._id, location_name: "Legacy", region_key: "kalbar", caption: "Old post",
    media: { type: "image", url: "https://example.test/old.jpg", aspect_ratio: "landscape" },
  });
  const url = "/api/v1/forum/recovery?bbox=109,-1,110,1&region=kalbar&condition=perlu_rawat&ecosystem=gambut";
  const result = await request(url);
  assert.equal(result.status, 200);
  const body = (await result.json()).data;
  assert.equal(body.truncated, false);
  assert.ok(body.items.some((item: { id: string }) => item.id === publicPostId));
  assert.ok(body.items.every((item: { location?: unknown }) => item.location));
  assert.equal(body.items.some((item: { id: string }) => item.id === outsideBboxId), false);
  assert.equal(body.items.some((item: { id: string }) => item.id === otherConditionId), false);
  assert.equal(body.items.some((item: { id: string }) => item.id === otherRegionId), false);
  assert.equal(body.items.some((item: { id: string }) => item.id === otherEcosystemId), false);
  assert.equal(body.items.some((item: { id: string }) => item.id === legacy._id.toString()), false);
  const anonymousMapItem = body.items.find((item: { id: string }) => item.id === anonymousId);
  assert.equal(anonymousMapItem.author.username, "Anonim");
  assert.equal(anonymousMapItem.author.user_id, undefined);
  assert.equal(anonymousMapItem.author.avatar_url, null);
  assert.equal(anonymousMapItem.author.email, undefined);
  assert.equal((await request("/api/v1/forum/recovery?region=kalbar")).status, 422);
  assert.equal((await request("/api/v1/forum/recovery?bbox=109,-1,110,1&condition=invalid")).status, 422);
});

test("public detail and owner history retain safe fields for geolocated posts", async () => {
  const created = await request("/api/v1/forum/posts", {
    method: "POST", body: json(evidence({ is_anonymous: true })),
  }, cookieOne);
  assert.equal(created.status, 201);
  const post = (await created.json()).data;
  const detail = await request(`/api/v1/forum/posts/${post.id}`);
  const detailPost = (await detail.json()).data;
  assert.equal(detailPost.location.coordinates[0], 109.3);
  assert.equal(detailPost.verification_status, "unverified");
  assert.equal(detailPost.author.user_id, undefined);
  const history = await request("/api/v1/auth/me/activity?type=posts&page=1&limit=20", {}, cookieOne);
  const historyItems = (await history.json()).data.items;
  assert.ok(historyItems.some((item: { post_id: string }) => item.post_id === post.id));
});

test("geolocated evidence does not create plots or monitoring logs", async () => {
  const plotCount = await PlotModel.countDocuments();
  const logCount = await MonitoringLogModel.countDocuments();
  const response = await request("/api/v1/forum/posts", {
    method: "POST", body: json(evidence()),
  }, cookieOne);
  assert.equal(response.status, 201);
  assert.equal(await PlotModel.countDocuments(), plotCount);
  assert.equal(await MonitoringLogModel.countDocuments(), logCount);
});

test("legacy report endpoints block guests and prevent volunteer metric updates", async () => {
  const plot = await PlotModel.create({
    plot_code: "EVIDENCE-TEST-001", name: "Evidence test plot", region: "kalbar",
    location: { type: "Point", coordinates: [109.3, -0.02] }, area_hectares: 1,
    community_name: "Test community", coordinator_name: "Test coordinator",
    total_planted: 10, current_alive: 9, survival_rate: 90, latest_status: "subur",
    cover_image_url: "https://example.test/plot.jpg",
  });
  const plotMetrics = {
    latest_status: plot.latest_status, total_planted: plot.total_planted,
    current_alive: plot.current_alive, survival_rate: plot.survival_rate,
  };
  const reportCount = await ReportInboxModel.countDocuments();
  const reportBody = {
    plot_id: plot._id.toString(), tree_condition: "mati", height_cm: 1,
    latitude: -0.02, longitude: 109.3, notes: "Attempted public metric update",
  };
  const guestSingle = await request("/api/v1/reports", {
    method: "POST", body: json(reportBody),
  });
  const guestBatch = await request("/api/v1/reports/offline-batch", {
    method: "POST", body: json({ batch: [reportBody] }),
  });
  assert.equal(guestSingle.status, 401);
  assert.equal(guestBatch.status, 401);

  const volunteerSingle = await request("/api/v1/reports", {
    method: "POST", body: json(reportBody),
  }, cookieOne);
  const volunteerBatch = await request("/api/v1/reports/offline-batch", {
    method: "POST", body: json({ batch: [reportBody] }),
  }, cookieOne);
  assert.equal(volunteerSingle.status, 403);
  assert.equal(volunteerBatch.status, 403);
  assert.equal(await ReportInboxModel.countDocuments(), reportCount);
  const persistedPlot = await PlotModel.findById(plot._id);
  assert.deepEqual({
    latest_status: persistedPlot?.latest_status, total_planted: persistedPlot?.total_planted,
    current_alive: persistedPlot?.current_alive, survival_rate: persistedPlot?.survival_rate,
  }, plotMetrics);
});

test("the public map limits a dense viewport and reports truncation", async () => {
  await ForumPostModel.insertMany(Array.from({ length: 501 }, (_, index) => ({
    ...evidence(), author_id: userOne._id, region_key: "lainnya", verification_status: "unverified",
    location_name: "Dense area " + index, location: { type: "Point", coordinates: [120, -5] },
  })));
  const response = await request("/api/v1/forum/recovery?bbox=119,-6,121,-4&region=lainnya");
  assert.equal(response.status, 200);
  const result = (await response.json()).data;
  assert.equal(result.items.length, 500);
  assert.equal(result.truncated, true);
});


test("province, city and short place detail survive feed/detail/map reads and idempotent retry", async () => {
  const input = evidence({ region_key: "lainnya", province: "Jawa Timur", city: "Surabaya", place_detail: "Samping tambal ban" });
  const created = await request("/api/v1/forum/posts", { method: "POST", body: json(input) }, cookieOne);
  assert.equal(created.status, 201); const post = (await created.json()).data;
  for (const key of ["province", "city", "place_detail"] as const) assert.equal(post[key], input[key]);
  const retry = await request("/api/v1/forum/posts", { method: "POST", body: json(input) }, cookieOne);
  assert.equal((await retry.json()).data.id, post.id);
  const changed = await request("/api/v1/forum/posts", { method: "POST", body: json({ ...input, place_detail: "Lokasi berbeda" }) }, cookieOne);
  assert.equal(changed.status, 409); assert.equal((await changed.json()).error.code, "SUBMISSION_CONFLICT");
  const detail = (await (await request(`/api/v1/forum/posts/${post.id}`)).json()).data;
  assert.equal(detail.city, "Surabaya"); assert.equal(detail.province, "Jawa Timur"); assert.equal(detail.place_detail, "Samping tambal ban");
  const feed = (await (await request("/api/v1/forum/posts?page=1&limit=50")).json()).data;
  assert.equal(feed.items.find((item: { id: string }) => item.id === post.id).city, "Surabaya");
});

test("new administrative fields reject invalid lengths and are stored as plain text", async () => {
  for (const extra of [{ province: "x" }, { city: "x" }, { province: "p".repeat(101) }, { city: "c".repeat(101) }, { place_detail: "d".repeat(241) }, { province: "<b></b>" }]) {
    assert.equal((await request("/api/v1/forum/posts", { method: "POST", body: json(evidence(extra)) }, cookieOne)).status, 422);
  }
  const response = await request("/api/v1/forum/posts", { method: "POST", body: json(evidence({ province: "<b>Kalimantan Barat</b>", city: "<b>Pontianak</b>", place_detail: "<b>Samping warung</b>" })) }, cookieOne);
  assert.equal(response.status, 201); const post = (await response.json()).data;
  assert.equal(post.province, "Kalimantan Barat"); assert.equal(post.city, "Pontianak"); assert.equal(post.place_detail, "Samping warung");
});
