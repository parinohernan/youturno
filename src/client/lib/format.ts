/**
 * Canonical locale-locked formatting.
 *
 * Every product date/time rendering routes through here. The "es-419" locale is
 * the single source for all Intl calls in the client; the display layer never
 * throws on bad data — missing or invalid input renders an em dash instead.
 * `lib/dates.ts` stays locale-independent and untouched; its noon-anchored
 * parser is reused so bare "YYYY-MM-DD" strings don't shift a day in zones
 * behind UTC.
 */
import { parseDate } from "./dates.ts";

const LOCALE = "es-419"; // single locale source of the whole product

// CLDR's built-in yMMMd pattern renders "5 ene 2026" for es-419, so the
// "5 de ene de 2026" sample this product is pinned to is assembled from parts
// instead of trusting the merged skeleton — its output can drift across CLDR
// versions. All piece formatters are still constructed once at module scope.
const fmtDay = new Intl.DateTimeFormat(LOCALE, { day: "numeric" });
const fmtMonthShort = new Intl.DateTimeFormat(LOCALE, { month: "short" });
const fmtYear = new Intl.DateTimeFormat(LOCALE, { year: "numeric" });
const fmtWeekdayLong = new Intl.DateTimeFormat(LOCALE, { weekday: "long" });
const fmtTime = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit", hour12: false });
const fmtMoney = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol" });

const EM_DASH = "—";

/** `formatDate` accepts exactly two named presets; no per-call Intl options. */
type DateStyle = undefined | "long";

/** Strings parse on the local calendar; anything else goes through `Date`. */
function parseInput(value: string | Date): Date | null {
  if (value instanceof Date) return value;
  if (value == null || value === "") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return parseDate(value);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "5 de ene de 2026", or "lunes, 5 de ene de 2026" with the "long" preset. */
export function formatDate(value: string | Date, style?: DateStyle): string {
  const d = parseInput(value);
  if (!d) return EM_DASH;
  const base = `${fmtDay.format(d)} de ${fmtMonthShort.format(d)} de ${fmtYear.format(d)}`;
  return style === "long" ? `${fmtWeekdayLong.format(d)}, ${base}` : base;
}

/** "5 de ene de 2026, 14:30" */
export function formatDateTime(value: string | Date): string {
  const d = parseInput(value);
  if (!d) return EM_DASH;
  return `${formatDate(d)}, ${fmtTime.format(d)}`;
}

/** 24-hour clock time, "HH:MM". */
export function formatTime(value: string | Date): string {
  const d = parseInput(value);
  if (!d) return EM_DASH;
  return fmtTime.format(d);
}

/** Calendar hour-gutter label on the 24-hour clock, e.g. "07:00". */
export function formatHour(hour: number): string {
  if (!Number.isFinite(hour) || hour < 0 || hour >= 24) return EM_DASH;
  return `${String(Math.floor(hour)).padStart(2, "0")}:00`;
}

/** USD rendered with es-419's own dot-decimal convention, e.g. "$1,234.56". */
export function formatMoney(amount: number): string {
  if (!Number.isFinite(amount)) return EM_DASH;
  return fmtMoney.format(amount);
}
