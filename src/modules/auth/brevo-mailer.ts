// Send one verification message through Brevo; never log the code or provider payload.
import { ENV } from "../../config/env.js";
import { createVerificationEmail } from "./verification-email.js";
export interface VerificationEmail { email: string; code: string; expiresAt: Date; idempotencyKey: string; purpose: "login" | "register" | "reset" }
export const brevoConfigured = () => Boolean(ENV.BREVO_API_KEY && ENV.BREVO_SENDER_EMAIL && ENV.BREVO_SENDER_NAME);
export async function sendBrevoCode(input: VerificationEmail) {
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST", signal: AbortSignal.timeout(8000),
    headers: { "api-key": ENV.BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      sender: { email: ENV.BREVO_SENDER_EMAIL, name: ENV.BREVO_SENDER_NAME },
      to: [{ email: input.email }],
      ...createVerificationEmail(input),
      headers: { idempotencyKey: input.idempotencyKey },
    }),
  });
  // Acceptance is not proof of inbox delivery. Ambiguous failures require a new generation.
  if (!response.ok) { await response.body?.cancel(); throw new Error("EMAIL_DELIVERY_UNAVAILABLE"); }
  await response.body?.cancel();
}
