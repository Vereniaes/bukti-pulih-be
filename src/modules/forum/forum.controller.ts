// Validate public Forum reads and authenticated post and comment writes.
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { sendError, sendSuccess } from "../../utils/response.js";
import { isPublicUploadUrl } from "../../utils/media.js";
import { sanitizeTextInput } from "../../utils/sanitize.js";
import { createComment, createPost, getActivity, getPost, listComments, listPosts, listRecoveryReports, voteComment } from "./forum.service.js";

const pathId = (value: unknown) => z.string().min(1).max(120).transform(id => /^[a-f0-9]{24}$/i.test(id) ? id.toLowerCase() : id).parse(value);
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
const activityQuery = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(20).default(10),
  type: z.enum(["posts", "comments"]),
});
const regionKeys = ["kalbar", "kalteng", "bekasi", "riau", "sumsel", "kalsel", "jambi", "lainnya"] as const;
const mediaSchema = z.object({
  type: z.enum(["image", "video"]),
  url: z.string().url().max(2048).refine(value => isPublicUploadUrl(value, "/bukti-lapangan/"), "Gunakan berkas yang diunggah melalui Kirim bukti."),
  aspect_ratio: z.enum(["square", "portrait", "landscape"]),
}).strict();
const postSchema = z.object({
  location_name: z.string().trim().min(2).max(200),
  region_key: z.enum(regionKeys),
  province: z.string().trim().min(2).max(100).optional(),
  city: z.string().trim().min(2).max(100).optional(),
  place_detail: z.string().trim().max(240).optional(),
  caption: z.string().trim().min(1).max(5000),
  media: mediaSchema,
  is_anonymous: z.boolean().default(false),
  submission_id: z.string().uuid(),
  location: z.object({ type: z.literal("Point"), coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]) }).strict(),
  ecosystem_type: z.enum(["gambut", "hutan_kota", "mineral"]),
  condition: z.enum(["subur", "perlu_rawat", "kritis", "mati"]),
}).strict();
const commentSchema = z.object({
  content: z.string().trim().min(3).max(3000),
  post_title: z.string().trim().max(200).optional(),
  parent_id: z.string().regex(/^[a-f0-9]{24}$/i).transform(id => id.toLowerCase()).nullable().optional(),
}).strict();
const commentQuery = pageQuery.extend({
  sort: z.enum(["top", "new"]).default("new"),
  parent_id: z.string().regex(/^[a-f0-9]{24}$/i).transform(id => id.toLowerCase()).optional(),
});
const voteSchema = z.object({ vote: z.enum(["up", "down", "clear"]) }).strict();

function validationError(res: Response, field: string, issue: string) {
  sendError(res, 422, "VALIDATION_FAILED", "Data masukan tidak valid.", [{ field, issue }]);
}
function safeText(value: string, field: string, res: Response): string | null {
  const clean = sanitizeTextInput(value);
  if (!clean.trim()) {
    validationError(res, field, "Isi tidak boleh kosong.");
    return null;
  }
  return clean;
}
function handleServiceError(error: unknown, res: Response, next: NextFunction) {
  const code = (error as Error)?.message;
  if (code === "SUBMISSION_CONFLICT") {
    sendError(res, 409, "SUBMISSION_CONFLICT", "Laporan ini sudah tersimpan dengan data berbeda. Periksa riwayat akun sebelum mengirim ulang."); return;
  }
  if (code === "PARENT_NOT_FOUND") {
    sendError(res, 404, "NOT_FOUND", "Komentar induk tidak ditemukan.");
    return;
  }
  if (code === "PROFILE_INCOMPLETE") {
    sendError(res, 409, "PROFILE_INCOMPLETE", "Lengkapi nama pengguna dan partisipasi sebelum mengirim catatan.");
    return;
  }
  if (code === "UNAUTHORIZED") {
    sendError(res, 401, "UNAUTHORIZED", "Sesi tidak aktif.");
    return;
  }
  next(error);
}

const recoveryQuery = z.object({
  bbox: z.string().refine(value => value.split(",").every(part => part.trim() !== "")).transform(value => value.split(",").map(Number)).pipe(z.tuple([
    z.number().min(-180).max(180), z.number().min(-90).max(90),
    z.number().min(-180).max(180), z.number().min(-90).max(90),
  ])).refine(([west, south, east, north]) => west < east && south < north),
  region: z.enum(["all", ...regionKeys]).default("all"),
  condition: z.enum(["all", "subur", "perlu_rawat", "kritis", "mati"]).default("all"),
  ecosystem: z.enum(["all", "gambut", "hutan_kota", "mineral"]).default("all"),
});
export const recoveryReportsHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try { sendSuccess(res, await listRecoveryReports(recoveryQuery.parse(req.query))); }
  catch (error) { next(error); }
};

export const listPostsHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, limit } = pageQuery.parse(req.query);
    sendSuccess(res, await listPosts(page, limit));
  } catch (error) { next(error); }
};

export const getPostHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const post = await getPost(pathId(req.params.id));
    if (!post) {
      sendError(res, 404, "NOT_FOUND", "Catatan tidak ditemukan.");
      return;
    }
    sendSuccess(res, post);
  } catch (error) { next(error); }
};

export const listCommentsHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const query = commentQuery.parse(req.query);
    res.setHeader("Cache-Control", "private, no-store");
    res.vary("Cookie");
    const result = await listComments(pathId(req.params.postId), query.page, query.limit, query.sort, query.parent_id ?? null, req.user?.userId);
    if (!result) {
      sendError(res, 404, "NOT_FOUND", "Catatan atau komentar induk tidak ditemukan.");
      return;
    }
    sendSuccess(res, result);
  } catch (error) { next(error); }
};

export const createPostHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      sendError(res, 401, "UNAUTHORIZED", "Tidak ada sesi aktif.");
      return;
    }
    const input = postSchema.parse(req.body);
    const location = safeText(input.location_name, "location_name", res);
    const caption = safeText(input.caption, "caption", res);
    if (location === null || caption === null) return;
    const details: { province?: string; city?: string; place_detail?: string } = {};
    for (const key of ["province", "city", "place_detail"] as const) {
      if (input[key] === undefined) continue;
      const value = sanitizeTextInput(input[key]);
      if (key !== "place_detail" && value.length < 2) { validationError(res, key, "Isi tidak boleh kosong."); return; }
      details[key] = value;
    }
    const post = await createPost(req.user.userId, { ...input, ...details, location_name: location, caption });
    sendSuccess(res, post, 201);
  } catch (error) { handleServiceError(error, res, next); }
};

export const createCommentHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      sendError(res, 401, "UNAUTHORIZED", "Tidak ada sesi aktif.");
      return;
    }
    const input = commentSchema.parse(req.body);
    const content = safeText(input.content, "content", res);
    if (content === null) return;
    const title = input.post_title === undefined ? undefined : sanitizeTextInput(input.post_title).slice(0, 200);
    const comment = await createComment(req.user.userId, pathId(req.params.postId), content, title, input.parent_id ?? null);
    if (!comment) {
      sendError(res, 404, "NOT_FOUND", "Catatan tidak ditemukan.");
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    sendSuccess(res, comment, 201);
  } catch (error) { handleServiceError(error, res, next); }
};


export const voteCommentHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 401, "UNAUTHORIZED", "Tidak ada sesi aktif."); return; }
    const { vote } = voteSchema.parse(req.body);
    const result = await voteComment(req.user.userId, pathId(req.params.postId), pathId(req.params.commentId), vote);
    if (!result) { sendError(res, 404, "NOT_FOUND", "Komentar tidak ditemukan."); return; }
    res.setHeader("Cache-Control", "private, no-store");
    sendSuccess(res, result);
  } catch (error) { handleServiceError(error, res, next); }
};

export const activityHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      sendError(res, 401, "UNAUTHORIZED", "Tidak ada sesi aktif.");
      return;
    }
    const query = activityQuery.parse(req.query);
    sendSuccess(res, await getActivity(req.user.userId, query.type, query.page, query.limit));
  } catch (error) { next(error); }
};
