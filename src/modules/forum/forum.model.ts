// Store persisted Forum posts and comments with server-owned author references.
import mongoose, { Schema, Types } from "mongoose";

export type ForumRegion = "kalbar" | "kalteng" | "bekasi" | "riau" | "sumsel" | "kalsel" | "jambi" | "lainnya";
export interface ForumMedia { type: "image" | "video"; url: string; aspect_ratio: "square" | "portrait" | "landscape"; }
export interface ForumPostRecord extends mongoose.Document {
  author_id: Types.ObjectId;
  location_name: string;
  region_key: ForumRegion;
  province?: string;
  city?: string;
  place_detail?: string;
  caption: string;
  media: ForumMedia;
  is_anonymous: boolean;
  submission_id?: string;
  submission_fingerprint?: string;
  location?: { type: "Point"; coordinates: [number, number] };
  ecosystem_type?: "gambut" | "hutan_kota" | "mineral";
  condition?: "subur" | "perlu_rawat" | "kritis" | "mati";
  verification_status?: "unverified";
  created_at: Date;
}
export interface ForumCommentRecord extends mongoose.Document {
  post_id: string;
  parent_id: string | null;
  author_id: Types.ObjectId;
  content: string;
  legacy_post_title?: string;
  created_at: Date;
}

export interface ForumCommentVoteRecord extends mongoose.Document {
  comment_id: string;
  user_id: Types.ObjectId;
  vote: "up" | "down";
}

const ForumPostSchema = new Schema<ForumPostRecord>({
  author_id: { type: Schema.Types.ObjectId, ref: "User", required: true },
  location_name: { type: String, required: true, maxlength: 200 },
  region_key: { type: String, enum: ["kalbar", "kalteng", "bekasi", "riau", "sumsel", "kalsel", "jambi", "lainnya"], required: true },
  province: { type: String, maxlength: 100 },
  city: { type: String, maxlength: 100 },
  place_detail: { type: String, maxlength: 240 },
  caption: { type: String, required: true, maxlength: 5000 },
  is_anonymous: { type: Boolean, default: false },
  submission_id: { type: String },
  submission_fingerprint: { type: String },
  location: { type: new Schema({
    type: { type: String, enum: ["Point"], required: true },
    coordinates: { type: [Number], required: true, validate: (value: number[]) => value.length === 2 && value.every(Number.isFinite) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90 },
  }, { _id: false }) },
  ecosystem_type: { type: String, enum: ["gambut", "hutan_kota", "mineral"] },
  condition: { type: String, enum: ["subur", "perlu_rawat", "kritis", "mati"] },
  verification_status: { type: String, enum: ["unverified"] },
  media: {
    type: { type: String, enum: ["image", "video"], required: true },
    url: { type: String, required: true, maxlength: 2048 },
    aspect_ratio: { type: String, enum: ["square", "portrait", "landscape"], required: true },
  },
}, { timestamps: { createdAt: "created_at", updatedAt: false } });
ForumPostSchema.index({ author_id: 1, created_at: -1, _id: -1 });
ForumPostSchema.index({ author_id: 1, submission_id: 1 }, { unique: true, partialFilterExpression: { submission_id: { $type: "string" } } });
ForumPostSchema.index({ location: "2dsphere" });
ForumPostSchema.index({ created_at: -1, _id: -1 });

const ForumCommentSchema = new Schema<ForumCommentRecord>({
  post_id: { type: String, required: true },
  parent_id: { type: String, default: null, match: /^[a-f0-9]{24}$/i },
  author_id: { type: Schema.Types.ObjectId, ref: "User", required: true },
  content: { type: String, required: true, maxlength: 3000 },
  legacy_post_title: { type: String, maxlength: 200 },
}, { timestamps: { createdAt: "created_at", updatedAt: false } });
ForumCommentSchema.index({ post_id: 1, created_at: -1, _id: -1 });
ForumCommentSchema.index({ post_id: 1, parent_id: 1, created_at: -1, _id: -1 });
ForumCommentSchema.index({ author_id: 1, created_at: -1, _id: -1 });

const ForumCommentVoteSchema = new Schema<ForumCommentVoteRecord>({
  comment_id: { type: String, required: true, match: /^[a-f0-9]{24}$/i },
  user_id: { type: Schema.Types.ObjectId, ref: "User", required: true },
  vote: { type: String, enum: ["up", "down"], required: true },
}, { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } });
ForumCommentVoteSchema.index({ comment_id: 1, user_id: 1 }, { unique: true });

export const ForumPostModel = mongoose.models.ForumPost ?? mongoose.model<ForumPostRecord>("ForumPost", ForumPostSchema);
export const ForumCommentModel = mongoose.models.ForumComment ?? mongoose.model<ForumCommentRecord>("ForumComment", ForumCommentSchema);
export const ForumCommentVoteModel = mongoose.models.ForumCommentVote ?? mongoose.model<ForumCommentVoteRecord>("ForumCommentVote", ForumCommentVoteSchema);
