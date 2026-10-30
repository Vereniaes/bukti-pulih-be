// Todo:
// -> save posts, ordered media and threaded comments
// -> scope account history to its owner

// --- Forum service ---
import { createHash } from "node:crypto";
import { Types } from "mongoose";
import { UserModel } from "../auth/user.model.js";
import { ForumCommentModel, ForumCommentVoteModel, ForumPostModel, type ForumCommentRecord, type ForumMedia, type ForumPostRecord } from "./forum.model.js";

const PROFILE_FIELDS = "username participation avatar_url city deleted_at";
const LEGACY_POST_IDS = new Set([
  "post-kb-001", "post-bks-002", "post-kt-003", "post-kb-004", "post-bks-005", "post-kt-006",
  "post-riau-007", "post-sumsel-008", "post-kalsel-009", "post-jambi-010", "post-kb-011",
]);
export const isLegacyPostId = (id: string) => LEGACY_POST_IDS.has(id);
const isObjectId = (id: string) => /^[a-f0-9]{24}$/i.test(id);
const pagination = (page: number, limit: number, total: number) => ({
  page, limit, total_items: total, total_pages: Math.ceil(total / limit),
});
const userView = (user: { _id: Types.ObjectId; username?: string; city?: string; avatar_url?: string | null; participation?: string; deleted_at?: Date }) => ({
  user_id: user.deleted_at ? undefined : user._id.toString(),
  username: user.deleted_at ? "Deleted Account" : user.username ?? null,
  city: user.deleted_at ? "" : user.city ?? "",
  avatar_url: user.deleted_at ? null : user.avatar_url ?? null,
  participation: user.deleted_at ? null : user.participation ?? null,
  age: 0,
});
const formatComment = (comment: ForumCommentRecord, author: ReturnType<typeof userView>, stats = { score: 0, viewer_vote: null as "up" | "down" | null, reply_count: 0 }) => ({
  id: comment._id.toString(),
  post_id: comment.post_id,
  parent_id: comment.parent_id ?? null,
  author,
  content: comment.content,
  created_at: comment.created_at.toISOString(),
  score: stats.score,
  viewer_vote: stats.viewer_vote,
  reply_count: stats.reply_count,
});
const formatPost = (post: ForumPostRecord, author: ReturnType<typeof userView>, commentsCount = 0, comments: ReturnType<typeof formatComment>[] = []) => ({
  id: post._id.toString(),
  author: post.is_anonymous && author.user_id ? { username: "Anonim", age: 0, city: "", avatar_url: null, participation: null } : author,
  location_name: post.location_name,
  region_key: post.region_key,
  ...(post.province ? { province: post.province } : {}),
  ...(post.city ? { city: post.city } : {}),
  ...(post.place_detail ? { place_detail: post.place_detail } : {}),
  created_at: post.created_at.toISOString(),
  time_ago: "",
  caption: post.caption,
  media: post.media,
  media_items: post.media_items?.length ? post.media_items : [post.media],
  ...(post.location ? {
    location: { type: "Point" as const, coordinates: [...post.location.coordinates] as [number, number] },
    ecosystem_type: post.ecosystem_type, condition: post.condition, verification_status: post.verification_status,
  } : {}),
  is_anonymous: post.is_anonymous,
  metrics: { likes: 0, views: 0, comments_count: commentsCount },
  comments,
  persisted: true as const,
});
const loadAuthor = async (authorId: Types.ObjectId) => {
  const user = await UserModel.findById(authorId).select(PROFILE_FIELDS);
  if (!user) throw new Error("FORUM_AUTHOR_MISSING");
  return userView(user);
};
const loadAuthors = async (ids: Types.ObjectId[]) => {
  const users = await UserModel.find({ _id: { $in: ids } }).select(PROFILE_FIELDS);
  return new Map(users.map(user => [user._id.toString(), userView(user)]));
};
const requireActiveActor = async (userId: string) => {
  const user = await UserModel.findOne({ _id: userId, is_active: true }).select(PROFILE_FIELDS);
  if (!user) throw new Error("UNAUTHORIZED");
  return user;
};
const commentsCountByPost = async (ids: string[]) => {
  const counts = await ForumCommentModel.aggregate<{ _id: string; count: number }>([
    { $match: { post_id: { $in: ids } } }, { $group: { _id: "$post_id", count: { $sum: 1 } } },
  ]);
  return new Map(counts.map(item => [item._id, item.count]));
};

export async function createPost(userId: string, input: {
  location_name: string; region_key: ForumPostRecord["region_key"]; caption: string; media: ForumMedia; media_items?: ForumMedia[]; is_anonymous: boolean;
  province?: string; city?: string; place_detail?: string;
  submission_id: string; location: NonNullable<ForumPostRecord["location"]>;
  ecosystem_type: NonNullable<ForumPostRecord["ecosystem_type"]>; condition: NonNullable<ForumPostRecord["condition"]>;
}) {
  const user = await requireActiveActor(userId);
  if (!user.username || !user.participation) throw new Error("PROFILE_INCOMPLETE");
  const fingerprint = createHash("sha256").update(JSON.stringify([
    input.location_name, input.region_key, input.caption, input.media.type, input.media.url, input.media.aspect_ratio,
    input.is_anonymous, input.location.coordinates, input.ecosystem_type, input.condition,
    ...([input.province, input.city, input.place_detail].some(value => value !== undefined) ? [input.province ?? "", input.city ?? "", input.place_detail ?? ""] : []),
    ...(input.media_items && input.media_items.length > 1 ? ["media_items", input.media_items.slice(1).map(item => [item.type, item.url, item.aspect_ratio])] : []),
  ])).digest("hex");
  await ForumPostModel.init();
  // A retry reuses the first saved report; the unique index also covers simultaneous requests.
  let post: ForumPostRecord;
  try {
    post = await ForumPostModel.findOneAndUpdate(
      { author_id: user._id, submission_id: input.submission_id },
      { $setOnInsert: { ...input, author_id: user._id, verification_status: "unverified", submission_fingerprint: fingerprint } },
      { upsert: true, new: true, runValidators: true },
    );
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const existing = await ForumPostModel.findOne({ author_id: user._id, submission_id: input.submission_id });
    if (!existing) throw error;
    post = existing;
  }
  if (post.submission_fingerprint !== fingerprint) throw new Error("SUBMISSION_CONFLICT");
  return formatPost(post, userView(user));
}

export async function listPosts(page: number, limit: number) {
  const filter = {};
  const [total, posts] = await Promise.all([
    ForumPostModel.countDocuments(filter),
    ForumPostModel.find(filter).sort({ created_at: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
  ]);
  const ids = posts.map(post => post.author_id);
  const [authors, counts] = await Promise.all([loadAuthors(ids), commentsCountByPost([...posts.map(post => post._id.toString()), ...LEGACY_POST_IDS])]);
  const items = posts.flatMap(post => {
    const author = authors.get(post.author_id.toString());
    return author ? [formatPost(post, author, counts.get(post._id.toString()) ?? 0)] : [];
  });
  return { items, pagination: pagination(page, limit, total), legacy_comment_counts: Object.fromEntries([...LEGACY_POST_IDS].map(id => [id, counts.get(id) ?? 0])) };
}

export async function listRecoveryReports(input: { bbox: [number, number, number, number]; region: string; condition: string; ecosystem: string }) {
  const [west, south, east, north] = input.bbox;
  const filter = {
    verification_status: "unverified",
    "location.coordinates.0": { $gte: west, $lte: east },
    "location.coordinates.1": { $gte: south, $lte: north },
    ...(input.region !== "all" ? { region_key: input.region } : {}),
    ...(input.condition !== "all" ? { condition: input.condition } : {}),
    ...(input.ecosystem !== "all" ? { ecosystem_type: input.ecosystem } : {}),
  };
  const posts = await ForumPostModel.find(filter).sort({ created_at: -1, _id: -1 }).limit(501);
  const authors = await loadAuthors(posts.slice(0, 500).map(post => post.author_id));
  return {
    items: posts.slice(0, 500).flatMap(post => {
      const author = authors.get(post.author_id.toString());
      return author ? [formatPost(post, author)] : [];
    }),
    truncated: posts.length > 500,
  };
}

export async function getPost(postId: string) {
  if (!isObjectId(postId)) return null;
  postId = postId.toLowerCase();
  const post = await ForumPostModel.findById(postId);
  if (!post) return null;
  const [author, commentDocs, totalComments] = await Promise.all([
    loadAuthor(post.author_id),
    ForumCommentModel.find({ post_id: postId }).sort({ created_at: -1, _id: -1 }).limit(50),
    ForumCommentModel.countDocuments({ post_id: postId }),
  ]);
  return formatPost(post, author, totalComments, await enrichComments(commentDocs));
}

async function enrichComments(comments: ForumCommentRecord[], viewerId?: string) {
  const ids = comments.map(comment => comment._id.toString());
  if (!ids.length) return [];
  const [authors, scores, replies, viewerVotes] = await Promise.all([
    loadAuthors(comments.map(comment => comment.author_id)),
    ForumCommentVoteModel.aggregate<{ _id: string; score: number }>([
      { $match: { comment_id: { $in: ids } } },
      { $group: { _id: "$comment_id", score: { $sum: { $cond: [{ $eq: ["$vote", "up"] }, 1, -1] } } } },
    ]),
    ForumCommentModel.aggregate<{ _id: string; count: number }>([
      { $match: { post_id: comments[0].post_id, parent_id: { $in: ids } } }, { $group: { _id: "$parent_id", count: { $sum: 1 } } },
    ]),
    viewerId ? ForumCommentVoteModel.find({ comment_id: { $in: ids }, user_id: viewerId }).select("comment_id vote") : Promise.resolve([]),
  ]);
  const scoreById = new Map(scores.map(item => [item._id, item.score]));
  const replyCountById = new Map(replies.map(item => [item._id, item.count]));
  const voteById = new Map(viewerVotes.map(item => [item.comment_id, item.vote as "up" | "down"]));
  return comments.flatMap(comment => {
    const id = comment._id.toString();
    const author = authors.get(comment.author_id.toString());
    return author?.username ? [formatComment(comment, author, {
      score: scoreById.get(id) ?? 0, viewer_vote: voteById.get(id) ?? null,
      reply_count: replyCountById.get(id) ?? 0,
    })] : [];
  });
}

export async function listComments(
  postId: string, page: number, limit: number, sort: "top" | "new", parentId: string | null, viewerId?: string,
) {
  postId = isObjectId(postId) ? postId.toLowerCase() : postId;
  parentId = parentId?.toLowerCase() ?? null;
  const legacy = isLegacyPostId(postId);
  if (!legacy && (!isObjectId(postId) || !(await ForumPostModel.exists({ _id: postId })))) return null;
  if (parentId && !(await ForumCommentModel.exists({ _id: parentId, post_id: postId }))) return null;
  const filter = parentId ? { post_id: postId, parent_id: parentId } : { post_id: postId, parent_id: null };
  const total = await ForumCommentModel.countDocuments(filter);
  let comments: ForumCommentRecord[];
  if (sort === "top") {
    const ranked = await ForumCommentModel.aggregate<{ _id: Types.ObjectId }>([
      { $match: filter },
      { $lookup: {
        from: ForumCommentVoteModel.collection.name,
        let: { commentId: { $toString: "$_id" } },
        pipeline: [
          { $match: { $expr: { $eq: ["$comment_id", "$$commentId"] } } },
          { $group: { _id: null, score: { $sum: { $cond: [{ $eq: ["$vote", "up"] }, 1, -1] } } } },
        ],
        as: "vote_score",
      } },
      { $addFields: { score: { $ifNull: [{ $arrayElemAt: ["$vote_score.score", 0] }, 0] } } },
      { $sort: { score: -1, created_at: -1, _id: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit }, { $project: { _id: 1 } },
    ]);
    comments = await ForumCommentModel.find({ _id: { $in: ranked.map(item => item._id) } });
    const byId = new Map(comments.map(item => [item._id.toString(), item]));
    comments = ranked.flatMap(item => { const found = byId.get(item._id.toString()); return found ? [found] : []; });
  } else {
    comments = await ForumCommentModel.find(filter).sort({ created_at: -1, _id: -1 }).skip((page - 1) * limit).limit(limit);
  }
  return { items: await enrichComments(comments, viewerId), pagination: pagination(page, limit, total), total_comments: await ForumCommentModel.countDocuments({ post_id: postId }) };
}

export async function createComment(userId: string, postId: string, content: string, postTitle?: string, parentId: string | null = null) {
  const author = await requireActiveActor(userId);
  if (!author.username || !author.participation) throw new Error("PROFILE_INCOMPLETE");
  let legacyTitle: string | undefined;
  if (isLegacyPostId(postId)) {
    legacyTitle = postTitle?.slice(0, 200) || "Forum warga";
  } else {
    if (!isObjectId(postId)) return null;
    postId = postId.toLowerCase();
    if (!(await ForumPostModel.exists({ _id: postId }))) return null;
  }
  parentId = parentId?.toLowerCase() ?? null;
  if (parentId && !(await ForumCommentModel.exists({ _id: parentId, post_id: postId }))) throw new Error("PARENT_NOT_FOUND");
  const comment = await ForumCommentModel.create({
    post_id: postId, parent_id: parentId, author_id: author._id, content, legacy_post_title: legacyTitle,
  });
  return formatComment(comment, userView(author));
}

export async function voteComment(userId: string, postId: string, commentId: string, vote: "up" | "down" | "clear") {
  const actor = await requireActiveActor(userId);
  if (!actor.username || !actor.participation) throw new Error("PROFILE_INCOMPLETE");
  if (!isObjectId(commentId)) return null;
  commentId = commentId.toLowerCase();
  if (isObjectId(postId)) postId = postId.toLowerCase();
  else if (!isLegacyPostId(postId)) return null;
  await ForumCommentVoteModel.init();
  const comment = await ForumCommentModel.findOne({ _id: commentId, post_id: postId }).select("_id");
  if (!comment) return null;
  const key = { comment_id: commentId, user_id: new Types.ObjectId(userId) };
  if (vote === "clear") {
    await ForumCommentVoteModel.deleteOne(key);
  } else {
    try {
      await ForumCommentVoteModel.updateOne(key, { $set: { vote } }, { upsert: true, runValidators: true });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      await ForumCommentVoteModel.updateOne(key, { $set: { vote } }, { runValidators: true });
    }
  }
  const [scoreResult, current] = await Promise.all([
    ForumCommentVoteModel.aggregate<{ score: number }>([
      { $match: { comment_id: commentId } },
      { $group: { _id: null, score: { $sum: { $cond: [{ $eq: ["$vote", "up"] }, 1, -1] } } } },
    ]),
    ForumCommentVoteModel.findOne(key).select("vote"),
  ]);
  return { comment_id: commentId, score: scoreResult[0]?.score ?? 0, viewer_vote: current?.vote ?? null };
}

export async function getActivity(userId: string, type: "posts" | "comments", page: number, limit: number) {
  const authorId = new Types.ObjectId(userId);
  if (type === "posts") {
    const filter = { author_id: authorId };
    const [total, posts] = await Promise.all([
      ForumPostModel.countDocuments(filter),
      ForumPostModel.find(filter).sort({ created_at: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
    ]);
    return {
      items: posts.map(post => ({
        id: post._id.toString(), post_id: post._id.toString(), title: post.location_name,
        content: post.caption, created_at: post.created_at.toISOString(),
        is_anonymous: post.is_anonymous, verification_status: post.verification_status,
      })),
      pagination: pagination(page, limit, total),
    };
  }

  const filter = { author_id: authorId };
  const [total, comments] = await Promise.all([
    ForumCommentModel.countDocuments(filter),
    ForumCommentModel.find(filter).sort({ created_at: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
  ]);
  const postIds = [...new Set(comments.map(comment => comment.post_id))];
  const objectIds = postIds.filter(isObjectId);
  const posts = objectIds.length ? await ForumPostModel.find({ _id: { $in: objectIds } }).select("location_name") : [];
  const titles = new Map(posts.map(post => [post._id.toString(), post.location_name]));
  return {
    items: comments.map(comment => ({
      id: comment._id.toString(),
      post_id: comment.post_id,
      title: titles.get(comment.post_id) ?? comment.legacy_post_title ?? "Forum warga",
      content: comment.content,
      created_at: comment.created_at.toISOString(),
      parent_id: comment.parent_id ?? null,
    })),
    pagination: pagination(page, limit, total),
  };
}
