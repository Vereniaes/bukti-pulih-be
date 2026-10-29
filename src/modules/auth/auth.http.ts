// Keep browser mutations on approved origins and issue private, host-only cookies.
import type { Request, Response, NextFunction } from "express";
import { randomBytes } from "node:crypto";
import { ENV } from "../../config/env.js";
import { sendError } from "../../utils/response.js";
export const sessionCookie = () => ENV.NODE_ENV === "production" ? "__Host-bp_session" : "bp_session";
const proofCookie = () => ENV.NODE_ENV === "production" ? "__Host-bp_auth_proof" : "bp_auth_proof";
const options = () => ({ httpOnly: true, secure: ENV.NODE_ENV === "production", sameSite: "lax" as const, path: "/" });
export const readSessionToken = (req: Request): string => req.cookies?.[sessionCookie()] ?? "";
export const readBrowserProof = (req: Request): string => req.cookies?.[proofCookie()] ?? "";
export const validBrowserProof = (value: string) => /^[a-f0-9]{64}$/.test(value);
export function prepareBrowserProof(req: Request, res: Response) {
  const current = readBrowserProof(req);
  res.cookie(proofCookie(), validBrowserProof(current) ? current : randomBytes(32).toString("hex"), { ...options(), maxAge: 30 * 60_000 });
}
export const setSessionCookie = (res: Response, token: string) => res.cookie(sessionCookie(), token, { ...options(), maxAge: 7 * 86_400_000 });
export const clearSessionCookie = (res: Response) => res.clearCookie(sessionCookie(), options());
export const clearBrowserProof = (res: Response) => res.clearCookie(proofCookie(), options());
export function browserMutation(req: Request, res: Response, next: NextFunction) {
  const origin = req.get("origin");
  if (!origin || !ENV.CORS_ORIGIN.includes(origin) || !req.is("application/json")) {
    sendError(res, 403, "REQUEST_REJECTED", "Permintaan tidak dapat diproses.");
    return;
  }
  next();
}
