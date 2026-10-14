// src/middlewares/auth.ts
// -> middleware autentikasi dan otorisasi sesi kader/publik
//      -> verifikasi token cookie bp_session atau header authorization
//      -> proteksi hak akses berdasarkan peran pengguna

import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { ENV } from "../config/env.js";
import { sendError } from "../utils/response.js";

export interface AuthUserPayload {
  userId: string;
  phoneNumber: string;
  fullName: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUserPayload;
    }
  }
}

export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  const token = req.cookies?.bp_session || req.headers.authorization?.replace("Bearer ", "");

  if (!token) {
    sendError(res, 401, "UNAUTHORIZED", "Sesi tidak ditemukan. Silakan masuk terlebih dahulu.");
    return;
  }

  try {
    const decoded = jwt.verify(token, ENV.JWT_SECRET) as AuthUserPayload;
    req.user = decoded;
    next();
  } catch {
    sendError(res, 401, "INVALID_TOKEN", "Sesi kedaluwarsa atau tidak valid.");
  }
};

export const optionalAuth = (req: Request, _res: Response, next: NextFunction): void => {
  const token = req.cookies?.bp_session || req.headers.authorization?.replace("Bearer ", "");
  if (token) {
    try {
      const decoded = jwt.verify(token, ENV.JWT_SECRET) as AuthUserPayload;
      req.user = decoded;
    } catch {
      // abaikan jika token tidak valid untuk tamu publik
    }
  }
  next();
};
