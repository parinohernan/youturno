export type AppointmentSnapshot = { status: string; scheduled_date: string; start_time: string; end_time: string };
export function snapshot(appointment: AppointmentSnapshot): AppointmentSnapshot {
  return { status: appointment.status, scheduled_date: appointment.scheduled_date, start_time: appointment.start_time, end_time: appointment.end_time };
}
export function sameSnapshot(a: AppointmentSnapshot, b: AppointmentSnapshot): boolean {
  return Object.entries(snapshot(a)).every(([key, value]) => b[key as keyof AppointmentSnapshot] === value);
}
export function pollDelay(failures: number): number { return Math.min(120_000, 15_000 * 2 ** Math.min(failures, 3)); }

/** First response establishes a baseline; a repeated response never alerts twice. */
export function bookingUpdates(previous: number | null, cursor: number, ids: number[]) {
  return { cursor: Math.max(previous ?? 0, cursor), count: previous === null ? 0 :
    new Set(ids.filter((id) => id > previous && id <= cursor)).size };
}

export const actionable = (appointment: AppointmentSnapshot) => ["booked", "confirmed", "in_progress"].includes(appointment.status);

export function chronological<T extends AppointmentSnapshot>(appointments: T[]): T[] {
  return [...appointments].sort((a, b) => `${a.scheduled_date}T${a.start_time}`.localeCompare(`${b.scheduled_date}T${b.start_time}`));
}

/** Portal times are UTC. Never label a future day or a finished slot as next. */
export function nextAppointment<T extends AppointmentSnapshot>(appointments: T[], date: string, now = new Date()): T | undefined {
  if (date !== now.toISOString().slice(0, 10)) return undefined;
  return chronological(appointments).find(appointment => actionable(appointment) &&
    appointment.scheduled_date === date && new Date(`${date}T${appointment.end_time}:00Z`).getTime() > now.getTime());
}

export function appointmentDuration(appointment: AppointmentSnapshot): number {
  const minutes = (time: string) => { const [hour, minute] = time.split(":").map(Number); return hour * 60 + minute; };
  return minutes(appointment.end_time) - minutes(appointment.start_time);
}
