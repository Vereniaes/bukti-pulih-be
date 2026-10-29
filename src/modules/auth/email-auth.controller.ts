// Validate email challenges; session tokens and OTP values stay out of JSON responses.
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { sendSuccess, sendError } from "../../utils/response.js";
import { createEmailAuthService, EmailAuthError, type EmailAuthService } from "./email-auth.service.js";
import { PASSWORD_FORMAT, normalizePassword } from "./password.service.js";
import { prepareBrowserProof, readBrowserProof, setSessionCookie, validBrowserProof } from "./auth.http.js";

const requestId = z.string().uuid();
const identity = { email: z.string().trim().max(254).email().toLowerCase(), request_id: requestId };
const password = z.string().min(1).max(256).transform(normalizePassword).refine(value => PASSWORD_FORMAT.test(value), "Gunakan password 8-128 karakter tanpa spasi.");
const startSchema = z.discriminatedUnion("purpose", [
  z.object({ ...identity, purpose: z.literal("login"), password }).strict(),
  z.object({ ...identity, purpose: z.literal("register"), password }).strict(),
  z.object({ ...identity, purpose: z.literal("reset") }).strict(),
]);
const resendSchema = z.object({ flow_id: requestId, request_id: requestId }).strict();
const verifySchema = z.object({ flow_id: requestId, code: z.string().regex(/^\d{8}$/) }).strict();
export function emailAuthHandlers(service: EmailAuthService = createEmailAuthService()) {
  const handler = (run: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!validBrowserProof(readBrowserProof(req))) { sendError(res, 400, "BROWSER_PROOF_REQUIRED", "Buka kembali formulir masuk dan coba lagi."); return; }
      await run(req, res);
    } catch (error) {
      if (error instanceof EmailAuthError) {
        if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
        sendError(res, error.status, error.code, error.message); return;
      }
      next(error);
    }
  };
  return {
    prepare: (req: Request, res: Response) => { prepareBrowserProof(req, res); sendSuccess(res, { ready: true }); },
    start: handler(async (req, res) => { sendSuccess(res, await service.start(startSchema.parse(req.body), readBrowserProof(req), req.socket.remoteAddress ?? "unknown")); }),
    resetPassword: handler(async (req, res) => {
      const input = z.object({ flow_id: requestId, password }).strict().parse(req.body);
      sendSuccess(res, await service.resetPassword(input, readBrowserProof(req), req.socket.remoteAddress ?? "unknown"));
    }),
    cancel: handler(async (req, res) => {
      const input = z.object({ flow_id: requestId }).strict().parse(req.body);
      sendSuccess(res, await service.cancel(input.flow_id, readBrowserProof(req)));
    }),
    resend: handler(async (req, res) => { sendSuccess(res, await service.resend(resendSchema.parse(req.body), readBrowserProof(req), req.socket.remoteAddress ?? "unknown")); }),
    flow: handler(async (req, res) => { sendSuccess(res, await service.getFlow(requestId.parse(req.query.flow_id), readBrowserProof(req))); }),
    verify: handler(async (req, res) => {
      const result = await service.verify(verifySchema.parse(req.body), readBrowserProof(req), req.socket.remoteAddress ?? "unknown");
      if (result.reset_required) { sendSuccess(res, { reset_required: true, flow: result.flow }); return; }
      setSessionCookie(res, result.token);
      sendSuccess(res, { reset_required: false, user: result.user, onboarding_required: result.onboarding_required });
    }),
  };
}
