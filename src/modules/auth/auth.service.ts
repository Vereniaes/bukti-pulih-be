// Authenticate accounts and return only the public profile shape.
import { USERNAME_INDEX, USERNAME_SAVE_LIMIT, usernameSaveCount } from "./username-policy.js";
import { UserModel, type IUser } from "./user.model.js";

export function safeUser(user: IUser) {
  return {
    id: user._id.toString(),
    username: user.username ?? null,
    username_saves_remaining: Math.max(0, USERNAME_SAVE_LIMIT - usernameSaveCount(user)),
    participation: user.participation ?? null,
    avatar_url: user.avatar_url ?? null,
    city: user.city ?? "",
    phone_number: user.phone_number ?? null,
    email: user.email ?? null,
    role: user.role,
    role_badge: user.role_badge,
    organization_name: user.organization_name ?? null,
    assigned_plots: user.assigned_plots ?? [],
    created_at: user.created_at.toISOString(),
  };
}

let usernameIndexReady: Promise<string> | undefined;
const ensureUsernameIndex = () => usernameIndexReady ??= UserModel.collection.createIndex({ username: 1 }, USERNAME_INDEX).catch(error => { usernameIndexReady = undefined; throw error; });

const PROFILE_FIELDS = "email phone_number username username_save_count participation avatar_url city role role_badge organization_name assigned_plots created_at";
export class ProfileUpdateError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export const meService = async (userId: string) => {
  const user = await UserModel.findOne({ _id: userId, is_active: true }).select(PROFILE_FIELDS);
  return user ? safeUser(user) : null;
};

export const updateMeService = async (userId: string, changes: Record<string, unknown>) => {
  const filter: Record<string, unknown> = { _id: userId, is_active: true };
  const update = { ...changes };
  if (typeof changes.username === "string") {
    await ensureUsernameIndex();
    const current = await UserModel.findOne(filter).select("username username_save_count");
    if (!current) return null;
    if (changes.username === current.username) delete update.username;
    else {
      const used = usernameSaveCount(current);
      if (used >= USERNAME_SAVE_LIMIT) throw new ProfileUpdateError("USERNAME_LIMIT", "Username sudah disimpan 2 kali dan tidak dapat diubah lagi.");
      // Match both values so another device cannot overwrite the final saved username.
      filter.username = current.username ?? null;
      filter.username_save_count = current.username_save_count || { $in: [0, null] };
      update.username_save_count = used + 1;
    }
  }
  const user = await UserModel.findOneAndUpdate(filter, { $set: update }, { new: true, runValidators: true }).select(PROFILE_FIELDS);
  if (!user && update.username !== undefined && await UserModel.exists({ _id: userId, is_active: true })) {
    throw new ProfileUpdateError("PROFILE_CHANGED", "Username berubah. Muat ulang akun sebelum melanjutkan.");
  }
  return user ? safeUser(user) : null;
};
