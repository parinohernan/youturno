/**
 * Booking conflict detection.
 *
 * Pure interval maths, no database, so the rules can be unit-tested directly.
 *
 * Intervals are half-open `[start, end)`. That is the whole reason a 10:00-11:00
 * cut and an 11:00-12:00 colour are back-to-back rather than a clash: in a salon
 * the next client sits down the minute the last one gets up.
 *
 * Times are `HH:MM` wall clock, currently UTC until business timezones are
 * configurable. Minutes are counted from midnight.
 */

export type Interval = { start: number; end: number };

/** Minutes between candidate start times shown to a customer. */
export const SLOT_MINUTES = 30;

export type SchedulingMode = "consecutive" | "fixed" | "service_duration";
export type SchedulingPolicy = { scheduling_mode?: SchedulingMode; scheduling_interval?: number };

/** Earliest whole minute not in the past (UTC, matching stored booking times). */
export function bookingFloor(date: string, now = new Date()): number {
  if (weekdayOf(date) === null) return Infinity;
  const today = now.toISOString().slice(0, 10);
  if (date < today) return Infinity;
  return date > today ? 0 : Math.ceil((now.getTime() - Date.parse(`${today}T00:00:00Z`)) / 60000);
}

/** Public starts, keeping original effective intervals intact across busy gaps. */
export function publicStarts(windows: Interval[], duration: number, busy: Busy[], policy: SchedulingPolicy = {}, earliest = 0): string[] {
  if (!Number.isSafeInteger(duration) || duration <= 0) return [];
  const mode = policy.scheduling_mode ?? "fixed";
  const cadence = policy.scheduling_interval ?? SLOT_MINUTES;
  if (!["consecutive", "fixed", "service_duration"].includes(mode) || !Number.isSafeInteger(cadence) || cadence < 1 || cadence > 240) return [];
  const occupied = busy.flatMap((item) => {
    const start = toMinutes(item.start_time), end = toMinutes(item.end_time);
    return start === null || end === null || start >= end ? [] : [{ start, end }];
  }).sort((a, b) => a.start - b.start);
  const result: string[] = [];
  for (const window of windows) {
    if (mode === "consecutive") {
      let start = Math.max(window.start, earliest);
      for (const interval of occupied) {
        if (start + duration <= interval.start) break;
        if (start < interval.end) start = interval.end;
      }
      if (start + duration <= window.end) result.push(minutesToTime(start));
    } else {
      const step = mode === "fixed" ? cadence : duration;
      const anchor = mode === "fixed" ? 0 : window.start;
      let start = anchor + Math.ceil((Math.max(window.start, earliest) - anchor) / step) * step;
      for (; start + duration <= window.end; start += step) {
        if (!occupied.some((interval) => overlaps({ start, end: start + duration }, interval))) result.push(minutesToTime(start));
      }
    }
  }
  return [...new Set(result)].sort();
}

/** `720` -> `"12:00"`, the inverse of `toMinutes`. */
export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * The week the booking page speaks: lowercase three-letter keys, `"sun"` first
 * to match `Date.getUTCDay()`.
 */
const WEEK_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];

/** `"2026-11-02"` -> day-of-week number (`0` = Sunday). `null` for a fake date. */
export function weekdayOf(dateISO: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO ?? "");
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return date.getUTCDay();
}

/**
 * The stored `business_hours` JSON -> pure minute windows keyed by weekday.
 *
 * Every key of the week stays present, so callers never check for holes. A row
 * that is missing, malformed or holds unknown keys degrades to closed: a shop
 * is never open when we cannot prove it is.
 */
export type WeeklyHours = Record<WeekDay, Interval[]>;
export type HoursInput = Partial<Record<WeekDay, [string, string][] | [string, string] | null>>;

/** Strict edit validation; adjacent intervals merge, overlaps are rejected. */
export function normalizeHours(value: unknown, partial = false): HoursInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: HoursInput = {};
  if (Object.keys(value).some((key) => !(WEEK_DAYS as readonly string[]).includes(key))) return null;
  for (const day of WEEK_DAYS) {
    if (!(day in value)) { if (partial) continue; return null; }
    const input = (value as HoursInput)[day];
    if (input === null) { result[day] = []; continue; }
    if (!Array.isArray(input)) return null;
    const pairs: unknown[] = typeof input[0] === "string" ? [input] : input;
    const intervals: [string, string][] = [];
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((time) => typeof time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) || pair[0] >= pair[1]) return null;
      intervals.push([pair[0], pair[1]]);
    }
    intervals.sort((a, b) => a[0].localeCompare(b[0]));
    const merged: [string, string][] = [];
    for (const pair of intervals) {
      const previous = merged.at(-1);
      if (previous && pair[0] < previous[1]) return null;
      if (previous && pair[0] === previous[1]) previous[1] = pair[1];
      else merged.push(pair);
    }
    result[day] = merged;
  }
  return result;
}

export function parseBusinessHours(raw: string | null): WeeklyHours {
  const hours = Object.fromEntries(WEEK_DAYS.map((day) => [day, []])) as unknown as WeeklyHours;
  try {
    const rows = raw ? JSON.parse(raw) : null;
    if (!rows || typeof rows !== "object" || Array.isArray(rows)) return hours;
    for (const [key, value] of Object.entries(rows)) {
      if (!(WEEK_DAYS as readonly string[]).includes(key)) continue;
      const normalized = normalizeHours({ [key]: value }, true);
      if (normalized) hours[key as WeekDay] = (normalized[key as WeekDay] as [string, string][]).map(([start, end]) => ({ start: toMinutes(start)!, end: toMinutes(end)! }));
    }
  } catch { /* treat as closed */ }
  return hours;
}

/** The opening window of `dateISO`, or `null` when closed that day. */
export function windowsOnDate(hours: WeeklyHours, dateISO: string): Interval[] {
  const weekday = weekdayOf(dateISO);
  return weekday === null ? [] : hours[WEEK_DAYS[weekday]];
}

/** Legacy single-window helper: never spans a split day's gap. */
export function windowOnDate(hours: WeeklyHours, dateISO: string): Interval | null {
  return windowsOnDate(hours, dateISO)[0] ?? null;
}

/** Missing override/day inherits; an explicit null or [] closes that day. */
export function effectiveWindows(company: WeeklyHours, override: string | null | undefined, date: string): Interval[] {
  const weekday = weekdayOf(date);
  return weekday === null ? [] : effectiveDayWindows(company, override, WEEK_DAYS[weekday]);
}

/** Recurring schedule metadata uses exactly the same rules as dated slots. */
export function effectiveWeeklyHours(company: WeeklyHours, override: string | null | undefined): WeeklyHours {
  return Object.fromEntries(WEEK_DAYS.map((day) => [day, effectiveDayWindows(company, override, day)])) as WeeklyHours;
}

function effectiveDayWindows(company: WeeklyHours, override: string | null | undefined, day: WeekDay): Interval[] {
  const opening = company[day];
  if (override == null) return opening;
  try {
    const rows = JSON.parse(override);
    if (!rows || typeof rows !== "object" || Array.isArray(rows)) return [];
    if (!(day in rows)) return opening;
    const personal = parseBusinessHours(override)[day];
    return opening.flatMap((a) => personal.map((b) => ({ start: Math.max(a.start, b.start), end: Math.min(a.end, b.end) })).filter((interval) => interval.start < interval.end));
  } catch { return []; }
}

export function fitsWindows(windows: Interval[], start: number, duration: number): boolean {
  return Number.isSafeInteger(duration) && duration > 0 && windows.some((window) => start >= window.start && start + duration <= window.end);
}

/**
 * Candidate start times for a service that must fit inside the window entirely,
 * aligned to `SLOT_MINUTES`. A window that cannot hold the service at all is
 * simply empty.
 */
export function slotStarts(window: Interval, durationMinutes: number): string[] {
  const starts: string[] = [];
  if (!Number.isSafeInteger(durationMinutes) || durationMinutes <= 0) return starts;
  let start = Math.ceil(window.start / SLOT_MINUTES) * SLOT_MINUTES;
  while (start + durationMinutes <= window.end) {
    starts.push(minutesToTime(start));
    start += SLOT_MINUTES;
  }
  return starts;
}

/**
 * Start times still free for the chosen (or any) staff member.
 *
 * `busyByStaff` holds each candidate staff member's occupied intervals; a time
 * survives when at least one of them is free for the whole service. No staff
 * configured means nothing survives — nothing can be booked.
 */
export function availableSlots(window: Interval, durationMinutes: number, busyByStaff: Busy[][]): string[] {
  return slotStarts(window, durationMinutes).filter((start) => {
    const startMinutes = toMinutes(start)!;
    const end = minutesToTime(startMinutes + durationMinutes);
    return busyByStaff.some((busy) => findConflicts(start, end, busy).length === 0);
  });
}

/** Something already occupying a staff member's day. */
export type Busy = {
  kind: "appointment" | "blocked";
  start_time: string;
  end_time: string;
  /** Who or what holds the slot: the client's name, or the reason for the block. */
  label: string;
};

/** `"09:30"` -> `570`. Returns `null` for anything unparseable. */
export function toMinutes(time: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Do two half-open intervals share any minute? */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Everything in `busy` that collides with `[start_time, end_time)`.
 *
 * A candidate that does not parse, or that does not run forwards, is treated as
 * having no conflicts: it is the caller's job to reject it, and answering
 * "clashes with nothing" is safer than answering from a nonsense interval.
 */
export function findConflicts(start_time: string, end_time: string, busy: Busy[]): Busy[] {
  const start = toMinutes(start_time);
  const end = toMinutes(end_time);
  if (start === null || end === null || end <= start) return [];
  return busy.filter((b) => {
    const bs = toMinutes(b.start_time);
    const be = toMinutes(b.end_time);
    if (bs === null || be === null || be <= bs) return false;
    return overlaps({ start, end }, { start: bs, end: be });
  });
}

/**
 * The 409 message.
 *
 * Written to be acted on rather than just read: an agent booking on behalf of
 * the owner gets the times that are taken and the two ways out, so it can offer
 * another slot instead of failing the request back to a human.
 */
export function describeConflicts(staffName: string, conflicts: Busy[], action: "book" | "block" = "book"): string {
  const who = staffName || "Este integrante del equipo";
  const list = conflicts
    .map((c) => `${c.start_time}-${c.end_time} (${c.label})`)
    .join(", ");
  // Mixed causes keep the stronger word: anything the caller can't override by
  // blocking must read as "taken".
  const what = conflicts.every((c) => c.kind === "blocked") ? "no está disponible" : "ya está ocupado";
  const word = action === "block" ? "bloquearlo" : "agendarlo";
  return `${who} ${what} en ${list}. Elige otro horario o integrante del equipo, o envía allow_conflict: true para ${word} de todas formas.`;
}
