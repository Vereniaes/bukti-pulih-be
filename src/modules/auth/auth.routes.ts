// Route email sign-in, account settings and private activity through shared session checks.
import { Router } from "express";
import { meHandler, updateMeHandler, deleteMeHandler, logoutHandler } from "./auth.controller.js";
import { requireAuth, requireActiveUser } from "../../middlewares/auth.js";
import { activityHandler } from "../forum/forum.controller.js";
import { browserMutation } from "./auth.http.js";
import { emailAuthHandlers } from "./email-auth.controller.js";
import type { EmailAuthService } from "./email-auth.service.js";
import { sendError } from "../../utils/response.js";
export function createAuthRoutes(service?: EmailAuthService) {
  const router = Router();
  const email = emailAuthHandlers(service);
  router.use((_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });
  router.post("/login", (_req, res) => sendError(res, 410, "EMAIL_LOGIN_REQUIRED", "Gunakan email untuk masuk."));
  router.get("/email/prepare", email.prepare);
  router.get("/email/flow", email.flow);
  router.post("/email/start", browserMutation, email.start);
  router.post("/email/cancel", browserMutation, email.cancel);
  router.post("/email/resend", browserMutation, email.resend);
  router.post("/email/reset-password", browserMutation, email.resetPassword);
  router.post("/email/verify", browserMutation, email.verify);
  router.get("/me/activity", requireAuth, requireActiveUser, activityHandler);
  router.get("/me", requireAuth, requireActiveUser, meHandler);
  router.patch("/me", browserMutation, requireAuth, requireActiveUser, updateMeHandler);
  router.delete("/me", browserMutation, requireAuth, requireActiveUser, deleteMeHandler);
  router.post("/logout", browserMutation, requireAuth, logoutHandler);
  return router;
}
