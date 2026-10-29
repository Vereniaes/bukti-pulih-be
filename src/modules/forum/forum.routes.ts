// Expose public Forum reads and active-account post and comment writes.
import { browserMutation } from "../auth/auth.http.js";
import { Router } from "express";
import { optionalAuth, requireAuth, requireActiveUser } from "../../middlewares/auth.js";
import {
  createCommentHandler, createPostHandler, getPostHandler, listCommentsHandler, listPostsHandler, recoveryReportsHandler, voteCommentHandler,
} from "./forum.controller.js";

const router = Router();
router.get("/recovery", recoveryReportsHandler);
router.get("/posts", listPostsHandler);
router.post("/posts", browserMutation, requireAuth, requireActiveUser, createPostHandler);
router.get("/posts/:id", getPostHandler);
router.get("/posts/:postId/comments", optionalAuth, listCommentsHandler);
router.post("/posts/:postId/comments", browserMutation, requireAuth, requireActiveUser, createCommentHandler);
router.post("/posts/:postId/comments/:commentId/vote", browserMutation, requireAuth, requireActiveUser, voteCommentHandler);

export const forumRoutes = router;
