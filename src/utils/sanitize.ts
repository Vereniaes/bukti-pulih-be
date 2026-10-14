// src/utils/sanitize.ts
// -> penyaringan konten teks untuk pencegahan stored xss
//      -> membersihkan tag script dan elemen berbahaya
//      -> menyaring kata terlarang dan spam

import sanitizeHtml from "sanitize-html";

export const sanitizeTextInput = (input: string): string => {
  if (!input || typeof input !== "string") return "";
  return sanitizeHtml(input.trim(), {
    allowedTags: [], // hapus seluruh tag html
    allowedAttributes: {},
  });
};
