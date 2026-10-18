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
import { authRoutes } from "./modules/auth/auth.routes.js";
import { hotspotRoutes } from "./modules/hotspots/hotspot.routes.js";

const app: Application = express();

// middleware global ---------------------------------------------------------------
app.use(
  cors({
    origin: (origin, callback) => {
      // perbolehkan request tanpa origin (seperti curl atau server-to-server)
      if (!origin) return callback(null, true);
      if (
        ENV.CORS_ORIGIN.indexOf(origin) !== -1 ||
        ENV.NODE_ENV === "development" ||
        origin.endsWith(".vercel.app")
      ) {
        return callback(null, true);
      }
      return callback(new Error("CORS policy violation"));
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
app.use("/api/v1/timeline", timelineRoutes);
app.use("/api/v1/reports", reportRoutes);
app.use("/api/v1/auth", authRoutes);
// end of registrasi rute ----------------------------------------------------------

// middleware penanganan galat -----------------------------------------------------
app.use(errorHandler);

export default app;
