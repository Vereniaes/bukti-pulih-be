// Todo:
// -> Expose public timeline reads, confirmations, and comments.

// --- Timeline routes ---
import { Router } from "express";
import {
  getTimelineHandler,
  verifyTimelineItemHandler,
  addCommentHandler,
} from "./timeline.controller.js";

const router = Router();

router.get("/", getTimelineHandler);
router.post("/:id/verify", verifyTimelineItemHandler);
router.post("/:id/comments", addCommentHandler);

export const timelineRoutes = router;
// --- end of Timeline routes ---
