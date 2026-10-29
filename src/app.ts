// src/app.ts
// -> konfigurasi instance aplikasi express.js
//      -> integrasi middleware cors, cookie-parser, dan json body parser
//      -> registrasi seluruh perutean modular /api/v1
//      -> penanganan endpoint health check dan middleware penanganan error

import express, { Application, Request, Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { ENV } from "./config/env.js";
import { errorHandler } from "./middlewares/errorHandler.js";

import { plotRoutes } from "./modules/plots/plot.routes.js";
import { metricsRoutes } from "./modules/metrics/metrics.routes.js";
import { bnpbRoutes } from "./modules/bnpb/bnpb.routes.js";
import { timelineRoutes } from "./modules/timeline/timeline.routes.js";
import { reportRoutes } from "./modules/reports/report.routes.js";
import { createAuthRoutes } from "./modules/auth/auth.routes.js";
import type { EmailAuthService } from "./modules/auth/email-auth.service.js";
import { createLocationRoutes } from "./modules/locations/location.routes.js";
import type { LocationService } from "./modules/locations/location.service.js";
import { forumRoutes } from "./modules/forum/forum.routes.js";
import { satelliteRoutes } from "./modules/satellite/satellite.routes.js";
import { ispuRoutes } from "./modules/ispu/ispu.routes.js";
import { windRoutes } from "./modules/wind/wind.routes.js";
import { hotspotRoutes } from "./modules/hotspots/hotspot.routes.js";
import { hazardRoutes } from "./modules/hazards/hazard.routes.js";

export function createApp(options: { emailAuth?: EmailAuthService; locations?: LocationService } = {}): Application {
const app: Application = express();

// middleware global ---------------------------------------------------------------
app.use(
  cors({
    origin: (origin, callback) => {
      // perbolehkan request tanpa origin (seperti curl atau server-to-server)
      if (!origin) return callback(null, true);
      if (
        ENV.CORS_ORIGIN.includes(origin)
      ) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));
app.use(cookieParser(ENV.COOKIE_SECRET));
// end of middleware global --------------------------------------------------------

// health check endpoint -----------------------------------------------------------
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "healthy",
    service: "bukti-pulih-be",
    timestamp: new Date().toISOString(),
  });
});
// end of health check -------------------------------------------------------------

// registrasi rute api v1 ----------------------------------------------------------
app.use("/api/v1/plots", plotRoutes);
app.use("/api/v1/metrics", metricsRoutes);
app.use("/api/v1/external", bnpbRoutes);
app.use("/api/v1/external", hotspotRoutes);
app.use("/api/v1/external", windRoutes);
app.use("/api/v1/external", ispuRoutes);
app.use("/api/v1", hazardRoutes);
app.use("/api/v1", satelliteRoutes);
app.use("/api/v1/timeline", timelineRoutes);
app.use("/api/v1/reports", reportRoutes);
app.use("/api/v1/auth", createAuthRoutes(options.emailAuth));
app.use("/api/v1/forum", forumRoutes);
app.use("/api/v1/locations", createLocationRoutes(options.locations));
// end of registrasi rute ----------------------------------------------------------

// middleware penanganan galat -----------------------------------------------------
app.use(errorHandler);

return app;
}
export default createApp();
