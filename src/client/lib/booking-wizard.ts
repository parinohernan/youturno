import { compatibleSelection, type QualifiedStaff } from "./booking-selection";

export type BookingStep = 1 | 2 | 3 | 4;
export interface BookingDraft {
  serviceId: number | null;
  staffId: number | null;
  date: string | null;
  time: string | null;
  step: BookingStep;
}

export const bookingDraftKey = (slug: string) => `yt-public-book-${slug}`;

/** Accept partial intent and legacy full selections, never identity or credentials. */
export function readBookingDraft(raw: string | null, firstDay: string, lastDay: string): BookingDraft | null {
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object") return null;
    const serviceId = Number.isSafeInteger(value.serviceId) && value.serviceId > 0 ? value.serviceId : null;
    const staffId = Number.isSafeInteger(value.staffId) && value.staffId > 0 ? value.staffId : null;
    const date = typeof value.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.date) &&
      value.date >= firstDay && value.date <= lastDay &&
      new Date(`${value.date}T12:00:00Z`).toISOString().slice(0, 10) === value.date ? value.date : null;
    const time = date && typeof value.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.time) ? value.time : null;
    const step = [1, 2, 3, 4].includes(value.step) ? value.step : time ? 4 : 2;
    return { serviceId, staffId, date, time, step };
  } catch { return null; }
}

export function validBookingService(services: { id: number }[], staff: QualifiedStaff[], draft: Pick<BookingDraft, "serviceId" | "staffId">): boolean {
  return services.some((service) => service.id === draft.serviceId) && compatibleSelection(staff, draft) &&
    staff.some((member) => member.service_ids.includes(draft.serviceId!));
}

/** Navigation is a request, not permission to bypass prerequisites. */
export function bookingStep(requested: BookingStep, authenticated: boolean, validService: boolean, date: string | null, time: string | null): BookingStep {
  if (!authenticated) return 1;
  if (requested <= 2 || !validService) return 2;
  if (requested === 3 || !date || !time) return 3;
  return 4;
}

export function bookingEndTime(time: string, duration: number): string {
  const [hour, minute] = time.split(":").map(Number);
  const end = hour * 60 + minute + duration;
  return `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
}
