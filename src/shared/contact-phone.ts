/** Customer-supplied, unverified contact number; never infer a country code. */
export function contactPhone(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const trimmed = value.trim();
  if (!/^\+?[\d ()-]+$/.test(trimmed)) return null;
  const normalized = trimmed.replace(/[ ()-]/g, "");
  return /^\+?\d{7,15}$/.test(normalized) ? normalized : null;
}
