// src/modules/auth/auth.controller.ts
// -> controller penerima http request autentikasi
//      -> penanganan post /api/v1/auth/login
//      -> penanganan get /api/v1/auth/me
//      -> penanganan post /api/v1/auth/logout

import { Request, Response, NextFunction } from "express";
import { loginService, meService } from "./auth.service.js";
import { sendSuccess, sendError } from "../../utils/response.js";
import { ENV } from "../../config/env.js";
import { z } from "zod";

const loginSchema = z.object({
  phone_number: z.string().min(8, "Nomor ponsel minimal 8 angka"),
  pin: z.string().length(6, "PIN harus 6 digit angka"),
});

export const loginHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { phone_number, pin } = loginSchema.parse(req.body);
    const { token, user } = await loginService(phone_number, pin);

    // simpan ke httponly secure cookie --------------------------------------------
    res.cookie("bp_session", token, {
      httpOnly: true,
      secure: ENV.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 hari
    });

    sendSuccess(res, { user, message: `Selamat datang kembali, ${user.full_name}!` });
  } catch (error) {
    const errObj = error as Error;
    sendError(res, 401, "AUTH_FAILED", errObj.message || "Autentikasi gagal.");
  }
};

export const meHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
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
    sendSuccess(res, { authenticated: true, user });
  } catch (error) {
    next(error);
  }
};

export const logoutHandler = (
  _req: Request,
  res: Response
): void => {
  res.clearCookie("bp_session");
  sendSuccess(res, { message: "Sesi berhasil ditutup." });
};
