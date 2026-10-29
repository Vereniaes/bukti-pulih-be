// Keep username spelling; the database still rejects differently cased duplicates.
export const USERNAME_PATTERN = /^\S{1,24}$/u;
export const USERNAME_SAVE_LIMIT = 2;
export const usernameSaveCount = (user: { username?: string | null; username_save_count?: number }) =>
  Math.max(user.username ? 1 : 0, user.username_save_count ?? 0);
export const USERNAME_INDEX = {
  name: "username_unique_case_insensitive",
  unique: true,
  partialFilterExpression: { username: { $type: "string" } },
  collation: { locale: "en", strength: 2 },
} as const;
