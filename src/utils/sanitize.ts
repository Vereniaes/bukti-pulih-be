// Todo:
// -> Trim text and remove HTML tags and attributes.

// --- Text input ---
import sanitizeHtml from "sanitize-html";

export const sanitizeTextInput = (input: string): string => {
  if (!input || typeof input !== "string") return "";
  return sanitizeHtml(input.trim(), {
    allowedTags: [], // hapus seluruh tag html
    allowedAttributes: {},
  });
};
// --- end of Text input ---
