export const socialNetworks = [
  { key: "instagram", label: "Instagram", placeholder: "https://www.instagram.com/su-cuenta" },
  { key: "facebook", label: "Facebook", placeholder: "https://www.facebook.com/su-pagina" },
  { key: "tiktok", label: "TikTok", placeholder: "https://www.tiktok.com/@su-cuenta" },
  { key: "youtube", label: "YouTube", placeholder: "https://www.youtube.com/@su-canal" },
  { key: "linkedin", label: "LinkedIn", placeholder: "https://www.linkedin.com/company/su-empresa" },
] as const;

export type SocialLinks = Partial<Record<typeof socialNetworks[number]["key"], string>>;

/** Outbound URLs only; no platform SDKs, embeds or domain allowlist. */
export function safeSocialUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length > 500) return null;
  try {
    const url = new URL(value.trim());
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
