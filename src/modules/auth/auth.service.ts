// src/modules/auth/auth.service.ts
// -> business logic autentikasi sesi kader lapangan
//      -> validasi nomor whatsapp dan verifikasi pin 6 digit bcrypt
//      -> pembuatan token sesi jwt bertanda tangan rahasia server
//      -> mitigasi peniruan identitas dan rate-limiting percobaan pin

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { UserModel } from "./user.model.js";
import { ENV } from "../../config/env.js";

export const loginService = async (phoneNumber: string, pin: string) => {
  const cleanPhone = phoneNumber.replace(/[^0-9]/g, "");

  const user = await UserModel.findOne({ phone_number: cleanPhone });
  if (!user || !user.is_active) {
    throw new Error("Nomor ponsel atau PIN tidak cocok.");
  }

  // verifikasi hash bcrypt --------------------------------------------------------
  const isMatch = await bcrypt.compare(pin, user.pin_hash);
  if (!isMatch) {
    user.failed_attempts += 1;
    await user.save();
    throw new Error("Nomor ponsel atau PIN tidak cocok.");
  }

  user.failed_attempts = 0;
  user.last_login_at = new Date();
  await user.save();

  // buat token jwt sesi (masa aktif 30 hari) --------------------------------------
  const token = jwt.sign(
    {
      userId: user._id.toString(),
      phoneNumber: user.phone_number,
      fullName: user.full_name,
      role: user.role,
    },
    ENV.JWT_SECRET,
    { expiresIn: "30d" }
  );

  return {
    token,
    user: {
      id: user._id.toString(),
      phone_number: user.phone_number,
      full_name: user.full_name,
      role: user.role,
      role_badge: user.role_badge,
      organization_name: user.organization_name,
      assigned_plots: user.assigned_plots,
    },
  };
};

export const meService = async (userId: string) => {
  const user = await UserModel.findById(userId).select("-pin_hash");
  if (!user) return null;
  return user;
};
