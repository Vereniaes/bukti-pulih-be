// Allow only the configured Google scheduler service account.
import type { RequestHandler } from "express";
import { OAuth2Client, type TokenPayload } from "google-auth-library";
import { ENV } from "../../config/env.js";
import { sendError } from "../../utils/response.js";

const client = new OAuth2Client();
type Verifier = (token: string, audience: string) => Promise<TokenPayload | undefined>;
const verifyGoogleToken: Verifier = async (idToken, audience) => (await client.verifyIdToken({ idToken, audience })).getPayload();
export function createSchedulerGuard(
  config = { audience: ENV.SCHEDULER_AUDIENCE, serviceAccount: ENV.SCHEDULER_SERVICE_ACCOUNT },
  verify: Verifier = verifyGoogleToken,
): RequestHandler {
  return async (req, res, next) => {
    if (!config.audience || !config.serviceAccount) { sendError(res, 503, "SCHEDULER_NOT_CONFIGURED", "Scheduler unavailable"); return; }
    const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(req.headers.authorization ?? "");
    if (!match) { sendError(res, 401, "UNAUTHORIZED", "Unauthorized"); return; }
    try {
      const payload = await verify(match[1], config.audience);
      if (!payload || payload.email !== config.serviceAccount || payload.email_verified !== true) {
        sendError(res, 403, "FORBIDDEN", "Forbidden"); return;
      }
      next();
    } catch { sendError(res, 401, "UNAUTHORIZED", "Unauthorized"); }
  };
}
