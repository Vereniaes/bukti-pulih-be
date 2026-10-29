// Resolve opaque sessions against active users; legacy JWT/PIN tokens cannot authorize requests.
import type { Request, Response, NextFunction } from "express";
import { sendError } from "../utils/response.js";
import { UserModel } from "../modules/auth/user.model.js";
import { readSession } from "../modules/auth/session.service.js";
import { readSessionToken } from "../modules/auth/auth.http.js";

export interface AuthUserPayload {
  userId: string; phoneNumber: string; fullName: string; role: string; sessionContext: string;
}
declare global { namespace Express { interface Request { user?: AuthUserPayload; } } }
async function resolveUser(req: Request) {
  const session = await readSession(readSessionToken(req));
  if (!session) return null;
  const user = await UserModel.findOne({ _id: session.user_id, is_active: true }).select("username phone_number role password_version");
  return user && (user.password_version ?? 0) === session.password_version ? { userId: user._id.toString(), phoneNumber: user.phone_number ?? "", fullName: user.username ?? "", role: user.role, sessionContext: session.context } : null;
}
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await resolveUser(req);
    if (!user) { sendError(res, 401, "UNAUTHORIZED", "Sesi tidak aktif. Silakan masuk kembali."); return; }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("x-session-context") !== user.sessionContext) {
      sendError(res, 409, "SESSION_CHANGED", "Sesi berubah. Muat ulang akun sebelum melanjutkan."); return;
    }
    req.user = user;
    next();
  } catch (error) { next(error); }
}
// Kept as a shared route boundary; active status is checked when resolving the session.
export function requireActiveUser(req: Request, res: Response, next: NextFunction) {
  if (!req.user) { sendError(res, 401, "UNAUTHORIZED", "Sesi tidak aktif."); return; }
  next();
}
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const user = await resolveUser(req);
    if (user && (["GET", "HEAD"].includes(req.method) || req.get("x-session-context") === user.sessionContext)) req.user = user;
    next();
  } catch (error) { next(error); }
}
