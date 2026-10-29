// src/modules/reports/report.controller.ts
// -> controller penerima http request pelaporan lapangan
//      -> penanganan post /api/v1/reports
//      -> penanganan post /api/v1/reports/offline-batch

import { Request, Response, NextFunction } from "express";
import { createReportService, batchOfflineSyncService } from "./report.service.js";
import { sendSuccess, sendError } from "../../utils/response.js";
import { z } from "zod";

const createReportSchema = z.object({
  plot_id: z.string().min(1, "ID atau kode petak wajib diisi"),
  tree_condition: z.enum(["subur", "perlu_rawat", "mati"]),
  height_cm: z.coerce.number().min(1, "Tinggi minimal 1 cm").max(2000, "Tinggi maksimal 2000 cm"),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  accuracy_meters: z.coerce.number().optional(),
  notes: z.string().max(500).optional(),
  quick_tags: z.array(z.string()).optional(),
  photo_url: z.string().optional(),
});

export const createReportHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!["GOVERNMENT_VERIFIER", "ADMIN_SUPER"].includes(req.user!.role)) {
      sendError(res, 403, "FORBIDDEN", "Gunakan Kirim bukti untuk laporan warga."); return;
    }
    const validated = createReportSchema.parse(req.body);
    const report = await createReportService({
      ...validated,
      reporter_id: req.user?.userId,
      reporter_name: req.user?.fullName,
    });
    sendSuccess(
      res,
      {
        report_id: report._id.toString(),
        plot_code: report.plot_code,
        tree_condition: report.tree_condition,
        height_cm: report.height_cm,
        verification_status: report.verification_status,
        message: "Laporan lapangan berhasil dicatat!",
      },
      201
    );
  } catch (error) {
    next(error);
  }
};

const batchSchema = z.object({
  batch: z.array(createReportSchema),
});

export const batchOfflineSyncHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!["GOVERNMENT_VERIFIER", "ADMIN_SUPER"].includes(req.user!.role)) {
      sendError(res, 403, "FORBIDDEN", "Gunakan Kirim bukti untuk laporan warga."); return;
    }
    const validated = batchSchema.parse(req.body);
    const result = await batchOfflineSyncService(validated.batch.map(item => ({ ...item, reporter_id: req.user!.userId, reporter_name: req.user!.fullName })));
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
};
