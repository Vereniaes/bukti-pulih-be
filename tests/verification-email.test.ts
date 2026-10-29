// Check the delivered HTML contract, timezone and escaping without sending mail.
import test from "node:test";
import assert from "node:assert/strict";
import { createVerificationEmail } from "../src/modules/auth/verification-email.js";
import { sendBrevoCode } from "../src/modules/auth/brevo-mailer.js";

const expiresAt = new Date("2026-10-28T20:30:00Z");

test("expiry uses the WIB calendar day regardless of the server timezone", () => {
  const previous = process.env.TZ;
  try {
    for (const timezone of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
      process.env.TZ = timezone;
      const email = createVerificationEmail({ code: "00123456", expiresAt, purpose: "register" });
      assert.match(email.htmlContent, /29 Oktober 2026, 03[.:]30 WIB/);
      assert.match(email.htmlContent, />00123456<\/p>/);
      assert.doesNotMatch(email.htmlContent, /2026-10-28T20:30|UTC/);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

test("each email purpose keeps its own title and instructions", () => {
  for (const [purpose, title] of [["register", "Verifikasi akun"], ["login", "Lanjutkan masuk"], ["reset", "Atur ulang password"]] as const) {
    const email = createVerificationEmail({ code: "00123456", expiresAt, purpose });
    assert.ok(email.htmlContent.includes(title));
    assert.match(email.subject, /BuktiPulih$/);
    assert.doesNotMatch(email.htmlContent, /<script|<img|<link|@font-face/i);
  }
});

test("dynamic code text cannot add HTML", () => {
  const email = createVerificationEmail({ code: "<img src=x>&", expiresAt, purpose: "login" });
  assert.ok(email.htmlContent.includes("&lt;img src=x&gt;&amp;"));
  assert.doesNotMatch(email.htmlContent, /<img/);
});

test("Brevo receives one HTML body with the existing delivery headers", async (t) => {
  let payload: Record<string, unknown> | undefined;
  const fetch = t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    payload = JSON.parse(options.body as string);
    return new Response(JSON.stringify({ messageId: "test-only" }), { status: 201 });
  });
  await sendBrevoCode({ email: "test@example.invalid", code: "00123456", expiresAt, purpose: "register", idempotencyKey: "test-only-id" });
  assert.equal(fetch.mock.callCount(), 1);
  assert.ok(typeof payload?.htmlContent === "string");
  assert.equal(payload?.textContent, undefined);
  assert.deepEqual(payload?.headers, { idempotencyKey: "test-only-id" });
  assert.deepEqual(payload?.to, [{ email: "test@example.invalid" }]);
});
