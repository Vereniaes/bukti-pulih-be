// Todo:
// -> Verify request validation and BNPB scheduling.

// --- Security regression tests ---
import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import cron from "node-cron";
import app from "../src/app.js";
import { initBnpbCronJob } from "../src/modules/bnpb/bnpb.cron.js";
import { sanitizeTextInput } from "../src/utils/sanitize.js";

let server: Server;
let baseUrl: string;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  for (const task of cron.getTasks().values()) await task.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
});

async function post(path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test("report validation retains the 422 error envelope and field paths", async () => {
  const result = await post("/api/v1/reports", {});
  assert.equal(result.response.status, 422);
  assert.equal(result.body.error.code, "VALIDATION_FAILED");
  assert.equal(result.body.error.message, "Data masukan tidak valid.");
  const fields = result.body.error.details.map((detail: { field: string }) => detail.field);
  for (const field of ["plot_id", "tree_condition", "height_cm", "latitude", "longitude"]) {
    assert.ok(fields.includes(field), field);
  }
});

test("nested batch errors retain their indexed paths and custom messages", async () => {
  const result = await post("/api/v1/reports/offline-batch", {
    batch: [{ plot_id: "PL-KALBAR-001", tree_condition: "subur", height_cm: "0", latitude: "0", longitude: "109" }],
  });
  assert.equal(result.response.status, 422);
  assert.deepEqual(result.body.error.details, [
    { field: "batch.0.height_cm", issue: "Tinggi minimal 1 cm" },
  ]);
});

test("comment validation preserves Indonesian messages before accessing storage", async () => {
  const result = await post("/api/v1/timeline/test-only/comments", { author_name: "A", content: "x" });
  assert.equal(result.response.status, 422);
  assert.deepEqual(result.body.error.details, [
    { field: "author_name", issue: "Nama minimal 2 karakter" },
    { field: "content", issue: "Catatan minimal 3 karakter" },
  ]);
});

test("invalid login input keeps the existing authentication failure contract", async () => {
  const result = await post("/api/v1/auth/login", { phone_number: "123", pin: "1" });
  assert.equal(result.response.status, 401);
  assert.equal(result.body.error.code, "AUTH_FAILED");
  assert.match(result.body.error.message, /Nomor ponsel minimal 8 angka/);
  assert.match(result.body.error.message, /PIN harus 6 digit angka/);
});

test("text sanitization strips active HTML while retaining ordinary text", () => {
  assert.equal(sanitizeTextInput("  Bibit <b>subur</b><script>alert(1)</script><iframe src='javascript:alert(1)'></iframe>!  "), "Bibit subur!");
});

test("BNPB scheduling starts automatically and retains its six-hour cadence", async () => {
  const existing = new Set(cron.getTasks().keys());
  initBnpbCronJob("test");
  const tasks = [...cron.getTasks().values()].filter(task => !existing.has(task.id));
  assert.equal(tasks.length, 1);
  const task = tasks[0];
  try {
    assert.equal(task.getStatus(), "idle");
    assert.equal(task.getPattern(), "0 */6 * * *");
    assert.ok(task.match(new Date(2026, 9, 24, 6, 0, 0)));
    assert.equal(task.match(new Date(2026, 9, 24, 7, 0, 0)), false);
    assert.ok(task.getNextRun() instanceof Date);
    assert.equal(task.lastRun(), null);
  } finally {
    await task.destroy();
  }
});
// --- end of Security regression tests ---
