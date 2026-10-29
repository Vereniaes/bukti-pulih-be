// Todo:
// -> Read paged plot notes and save visitor confirmations and comments.

// --- Timeline entries ---
import { MonitoringLogModel, LogCommentModel } from "./timeline.model.js";
import { sanitizeTextInput } from "../../utils/sanitize.js";

interface GetTimelineQuery {
  plot_id?: string;
  page?: number;
  limit?: number;
}

export const getTimelineService = async (query: GetTimelineQuery) => {
  const page = Math.max(1, query.page || 1);
  const limit = Math.min(20, Math.max(1, query.limit || 10));
  const skip = (page - 1) * limit;

  const filter: Record<string, unknown> = {};
  if (query.plot_id && query.plot_id !== "all") {
    filter.plot_code = query.plot_id;
  }

  const [items, total] = await Promise.all([
    MonitoringLogModel.find(filter)
      .sort({ monitoring_date: -1 })
      .skip(skip)
      .limit(limit),
    MonitoringLogModel.countDocuments(filter),
  ]);

  const formattedItems = items.map((item) => ({
    id: item._id.toString(),
    plot_id: item.plot_id.toString(),
    plot_code: item.plot_code,
    plot_name: item.plot_name,
    reporter: item.reporter,
    monitoring_date: item.monitoring_date.toISOString(),
    postmark_badge: item.postmark_badge,
    tree_metrics: item.tree_metrics,
    field_notes: item.field_notes,
    images: item.images,
    community_verifications: {
      confirmed_subur_count: item.community_verifications.confirmed_subur_count,
      dispute_count: item.community_verifications.dispute_count,
    },
    comment_count: item.comment_count,
  }));

  return {
    items: formattedItems,
    pagination: {
      current_page: page,
      limit,
      total_items: total,
      total_pages: Math.ceil(total / limit),
      has_next: page * limit < total,
    },
  };
};

export const verifyTimelineItemService = async (
  logId: string,
  type: "subur" | "dispute",
  visitorIdentifier: string
) => {
  const log = await MonitoringLogModel.findById(logId);
  if (!log) return null;

  const visitors = log.community_verifications.verified_visitors || [];
  const alreadyVerified = visitors.includes(visitorIdentifier);

  if (alreadyVerified) {
    log.community_verifications.verified_visitors = visitors.filter((v) => v !== visitorIdentifier);
    if (type === "subur") {
      log.community_verifications.confirmed_subur_count = Math.max(
        0,
        log.community_verifications.confirmed_subur_count - 1
      );
    }
  } else {
    log.community_verifications.verified_visitors.push(visitorIdentifier);
    if (type === "subur") {
      log.community_verifications.confirmed_subur_count += 1;
    } else {
      log.community_verifications.dispute_count += 1;
    }
  }

  await log.save();

  return {
    log_id: log._id.toString(),
    confirmed_subur_count: log.community_verifications.confirmed_subur_count,
    user_has_verified: !alreadyVerified,
  };
};

export const addCommentService = async (
  logId: string,
  payload: { author_name: string; author_badge?: string; content: string }
) => {
  const log = await MonitoringLogModel.findById(logId);
  if (!log) return null;

  const cleanAuthor = sanitizeTextInput(payload.author_name) || "Warga Anonim";
  const cleanContent = sanitizeTextInput(payload.content);

  const comment = new LogCommentModel({
    log_id: log._id,
    author_name: cleanAuthor,
    author_badge: payload.author_badge || "warga_lokal",
    content: cleanContent,
  });

  await comment.save();

  log.comment_count += 1;
  await log.save();

  return comment;
};
// --- end of Timeline entries ---
