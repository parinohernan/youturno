import type { WeeklyHours } from "../types";
import type { BookingSelection, QualifiedStaff } from "./booking-selection";

export interface ScheduledStaff extends QualifiedStaff {
  effective_hours: WeeklyHours;
}

/** Input staff and qualifications are the active, tenant-scoped public overview. */
export function bookingHours(staff: ScheduledStaff[], selection: BookingSelection) {
  const candidates = staff.filter((member) =>
    (selection.staffId === null || member.id === selection.staffId) &&
    (selection.serviceId === null ? selection.staffId !== null || member.service_ids.length > 0 :
      member.service_ids.includes(selection.serviceId)));
  const hours: WeeklyHours = {};
  for (const day of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]) {
    const intervals = candidates.flatMap((member): [string, string][] => {
      const value = member.effective_hours[day];
      if (!value?.length) return [];
      return typeof value[0] === "string" ? [value as [string, string]] : value as [string, string][];
    }).sort((a, b) => a[0].localeCompare(b[0]));
    const merged: [string, string][] = [];
    for (const [start, end] of intervals) {
      const previous = merged.at(-1);
      if (previous && start <= previous[1]) previous[1] = previous[1] > end ? previous[1] : end;
      else merged.push([start, end]);
    }
    hours[day] = merged;
  }
  return { hours, candidateCount: candidates.length };
}
