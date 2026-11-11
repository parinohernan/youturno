export interface CalendarAppointment {
  id: number;
  identifier: string;
  scheduled_date: string;
  start_time: string;
  end_time: string;
  status: string;
}

/** Public labels captured when the customer confirms, never customer identity. */
export interface BookingCalendarContext {
  companyName: string;
  serviceName: string;
  address?: string | null;
}

export interface BookingCalendarEvent {
  uid: string;
  identifier: string;
  start: string;
  end: string;
  title: string;
  description: string;
  location: string;
}

export const calendarCopyWarning = "Este evento no se actualiza automáticamente si reprograma o cancela su turno.";

function plainText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n?|\n/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim() : "";
}

/** The booking contract stores UTC HH:MM on one date; never infer a next day. */
export function bookingCalendarEvent(appointment: CalendarAppointment, context: BookingCalendarContext, host: string): BookingCalendarEvent | null {
  if (!appointment || appointment.status !== "confirmed" || !Number.isSafeInteger(appointment.id) || appointment.id <= 0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(appointment.scheduled_date) || typeof host !== "string" ||
      !/^[0-9a-z.-]+$/i.test(host) || host.length > 253) return null;
  const midnight = new Date(`${appointment.scheduled_date}T00:00:00Z`);
  if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== appointment.scheduled_date) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(appointment.start_time) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(appointment.end_time) ||
      appointment.end_time <= appointment.start_time) return null;
  const company = plainText(context?.companyName), service = plainText(context?.serviceName), identifier = plainText(appointment.identifier);
  if (!company || !service || !identifier) return null;
  const stamp = (time: string) => `${appointment.scheduled_date.replaceAll("-", "")}T${time.replace(":", "")}00Z`;
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  return {
    uid: `appointment-${appointment.id}@${host.toLowerCase()}`,
    identifier,
    start: stamp(appointment.start_time),
    end: stamp(appointment.end_time),
    title: `${service} · ${company}`,
    description: `Turno: ${identifier}\nDuración: ${minutes(appointment.end_time) - minutes(appointment.start_time)} min\n\n${calendarCopyWarning}`,
    location: plainText(context.address),
  };
}

/** Official one-off template: developers.google.com/workspace/calendar/api/concepts/inviting-attendees-to-events */
export function googleCalendarUrl(event: BookingCalendarEvent): string {
  const params = new URLSearchParams({ action: "TEMPLATE", dates: `${event.start}/${event.end}`, stz: "UTC", etz: "UTC",
    text: event.title, details: event.description });
  if (event.location) params.set("location", event.location);
  return `https://calendar.google.com/calendar/r/eventedit?${params}`;
}

function escapeText(value: string): string {
  return plainText(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll(";", "\\;").replaceAll(",", "\\,");
}

/** RFC 5545 §3.1: fold UTF-8 at character boundaries, counting continuation space. */
function foldLine(line: string): string {
  const encoder = new TextEncoder();
  let result = "", octets = 0;
  for (const character of line) {
    const size = encoder.encode(character).length;
    if (octets + size > 75) { result += "\r\n "; octets = 1; }
    result += character;
    octets += size;
  }
  return result;
}

export function bookingCalendarFile(event: BookingCalendarEvent, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Youturno//Customer appointment//ES", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT", `UID:${escapeText(event.uid)}`, `DTSTAMP:${stamp}`, `DTSTART:${event.start}`, `DTEND:${event.end}`,
    `SUMMARY:${escapeText(event.title)}`, `DESCRIPTION:${escapeText(event.description)}`,
    ...(event.location ? [`LOCATION:${escapeText(event.location)}`] : []), "END:VEVENT", "END:VCALENDAR",
  ].map(foldLine).join("\r\n") + "\r\n";
}

export function calendarFilename(identifier: string): string {
  const safe = identifier.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return `turno-${safe || "reserva"}.ics`;
}

/** Allocate only on a user gesture; defer revocation until the download starts. */
export function downloadBookingCalendar(event: BookingCalendarEvent): void {
  const anchor = document.createElement("a");
  const url = URL.createObjectURL(new Blob([bookingCalendarFile(event)], { type: "text/calendar;charset=utf-8" }));
  try {
    anchor.href = url;
    anchor.download = calendarFilename(event.identifier);
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
