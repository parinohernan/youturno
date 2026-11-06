import { MAX_LOGO_BYTES, validLogo } from "./company-logo.js";

// Base64 is accepted only in the bounded staff mutation, never in list responses.
export const MAX_STAFF_BODY = Math.ceil(MAX_LOGO_BYTES / 3) * 4 + 64 * 1024;
export type PhotoInput = { mime: "image/png" | "image/jpeg"; data: string };
export function decodeStaffPhoto(photo: PhotoInput): Uint8Array | null {
  if (!photo.data || photo.data.length > Math.ceil(MAX_LOGO_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(photo.data)) return null;
  try {
    const bytes = Uint8Array.from(atob(photo.data), (char) => char.charCodeAt(0));
    return validLogo(bytes, photo.mime) ? bytes : null;
  } catch { return null; }
}

export function staffPhotoUrl(id: number, revision: string | null | undefined, slug?: string): string | null {
  return revision ? `${slug ? `/api/public/${encodeURIComponent(slug)}/staff` : "/api/staff"}/${id}/photo?v=${encodeURIComponent(revision)}` : null;
}
