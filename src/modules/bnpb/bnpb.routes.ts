// Todo:
// -> Expose the public BNPB summary endpoint.

// --- BNPB route ---
import { Router } from "express";
import { getBnpbKarhutlaHandler } from "./bnpb.controller.js";

const router = Router();

router.get("/bnpb-karhutla", getBnpbKarhutlaHandler);

export const bnpbRoutes = router;
// --- end of BNPB route ---
