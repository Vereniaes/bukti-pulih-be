// Handle sign-in and safe profile reads and updates.
import type { Request, Response, NextFunction } from "express";
import { isPublicUploadUrl } from "../../utils/media.js";
import { z } from "zod";
import { USERNAME_PATTERN } from "./username-policy.js";
import { meService, updateMeService, ProfileUpdateError } from "./auth.service.js";
import { sendSuccess, sendError } from "../../utils/response.js";
import { clearBrowserProof, clearSessionCookie, readSessionToken } from "./auth.http.js";
import { revokeSession } from "./session.service.js";
import { AccountDeletionError, deleteAccount } from "./account-deletion.service.js";

const isAvatarUrl = (value: string | null | undefined) => value == null || isPublicUploadUrl(value);
const profileSchema = z.object({
  username: z.string().regex(USERNAME_PATTERN, "Username harus berisi 1-24 karakter tanpa spasi.").optional(),
  participation: z.enum(["affected", "volunteer", "observer"]).optional(),
  avatar_url: z.string().url().max(2048).nullable().optional().refine(isAvatarUrl, "URL avatar harus berasal dari Vercel Blob."),
  city: z.string().trim().max(80).optional(),
}).strict().refine(value => Object.keys(value).length > 0, "Pilih informasi yang ingin disimpan.");

export const meHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      sendError(res, 401, "UNAUTHORIZED", "Tidak ada sesi aktif.");
      return;
    }
    const user = await meService(req.user.userId);
    if (!user) {
      sendError(res, 404, "NOT_FOUND", "Pengguna tidak ditemukan.");
      return;
    }
    sendSuccess(res, { authenticated: true, user: { ...user, session_context: req.user.sessionContext } });
  } catch (error) { next(error); }
};

export const updateMeHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      sendError(res, 401, "UNAUTHORIZED", "Tidak ada sesi aktif.");
      return;
    }
    const profile = profileSchema.parse(req.body);
    const user = await updateMeService(req.user.userId, profile);
    if (!user) {
      sendError(res, 404, "NOT_FOUND", "Pengguna tidak ditemukan.");
      return;
    }
    sendSuccess(res, { ...user, session_context: req.user.sessionContext });
  } catch (error) {
    if (error instanceof ProfileUpdateError) { sendError(res, 409, error.code, error.message); return; }
    if ((error as { code?: number }).code === 11000) {
      sendError(res, 409, "USERNAME_TAKEN", "Nama pengguna sudah digunakan.");
      return;
    }
    next(error);
  }
};

export const logoutHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await revokeSession(readSessionToken(req));
    clearSessionCookie(res);
    sendSuccess(res, { message: "Sesi berhasil ditutup." });
  } catch (error) { next(error); }
};

export const deleteMeHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 401, "UNAUTHORIZED", "Tidak ada sesi aktif."); return; }
    const { password } = z.object({ password: z.string().min(1).max(256) }).strict().parse(req.body);
    await deleteAccount(req.user.userId, password);
    clearSessionCookie(res);
    clearBrowserProof(res);
    sendSuccess(res, { deleted: true });
  } catch (error) {
    if (error instanceof AccountDeletionError) {
      if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
      sendError(res, error.status, error.code, error.message);
      return;
    }
    next(error);
  }
};
