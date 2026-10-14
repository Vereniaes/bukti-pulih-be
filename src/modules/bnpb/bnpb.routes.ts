// src/modules/bnpb/bnpb.routes.ts
// -> perutean endpoint adapter eksternal bnpb karhutla
//      -> get /api/v1/external/bnpb-karhutla

import { Router } from "express";
import { getBnpbKarhutlaHandler } from "./bnpb.controller.js";

const router = Router();

router.get("/bnpb-karhutla", getBnpbKarhutlaHandler);

export const bnpbRoutes = router;
