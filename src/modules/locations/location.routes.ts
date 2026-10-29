// Allow signed-in users to search Indonesian places and identify a selected point.
import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { requireAuth, requireActiveUser } from "../../middlewares/auth.js";
import { sendSuccess, sendError } from "../../utils/response.js";
import { takeAuthLimit } from "../auth/auth-rate-limit.js";
import { createLocationService, LocationError, type LocationService } from "./location.service.js";
const search = z.object({ q: z.string().trim().min(3).max(160) }).strict();
const coordinate = z.string().trim().min(1).pipe(z.coerce.number());
const reverse = z.object({ lng: coordinate.pipe(z.number().min(-180).max(180)), lat: coordinate.pipe(z.number().min(-90).max(90)) }).strict();
const service = createLocationService();
export function createLocationRoutes(locations: LocationService = service) {
  const router = Router();
  router.use(requireAuth, requireActiveUser);
  router.use(async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    try {
      const retry = await takeAuthLimit(createHash("sha256").update(`location:${req.user!.userId}`).digest("hex"), 60, 60_000, new Date());
      if (retry) { res.set("Retry-After", String(retry)); sendError(res, 429, "RATE_LIMITED", "Terlalu banyak pencarian. Coba lagi sebentar."); return; }
      next();
    } catch (error) { next(error); }
  });
  for (const path of ["search", "reverse"] as const) router.get(`/${path}`, async (req, res, next) => {
    try {
      const query = path === "search" ? search.parse(req.query) : reverse.parse(req.query);
      const items = "q" in query ? await locations.search(query.q) : await locations.reverse([query.lng, query.lat]);
      sendSuccess(res, { items });
    } catch (error) {
      if (error instanceof LocationError) { sendError(res, 503, error.message, "Lokasi belum dapat dimuat. Coba lagi."); return; }
      next(error);
    }
  });
  return router;
}
