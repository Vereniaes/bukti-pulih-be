// Accept public media from the application's Blob storage, not arbitrary remote servers.
export function isPublicUploadUrl(value: string, prefix = "") {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.port && !url.username && !url.password
      && (url.hostname.endsWith(".public.blob.vercel-storage.com") || url.hostname.endsWith(".blob.vercel-storage.com"))
      && url.pathname.startsWith(prefix) && !url.pathname.toLowerCase().endsWith(".svg");
  } catch { return false; }
}
