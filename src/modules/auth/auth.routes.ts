// src/modules/auth/auth.routes.ts
// -> perutean endpoint autentikasi sesi kader
//      -> post /api/v1/auth/login
//      -> get /api/v1/auth/me
//      -> post /api/v1/auth/logout

import { Router } from "express";
import { loginHandler, meHandler, logoutHandler } from "./auth.controller.js";
import { requireAuth } from "../../middlewares/auth.js";

const router = Router();

router.post("/login", loginHandler);
router.get("/me", requireAuth, meHandler);
router.post("/logout", logoutHandler);

export const authRoutes = router;
