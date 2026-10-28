import type { Appointment, BlockedSlot } from "../types";

const HEADERS = [
  "Fecha", "Inicio", "Fin", "Tipo", "Referencia", "Equipo", "Cliente",
  "Teléfono", "Servicios", "Estado", "Detalles",
];

/** Keep exported cells inert when the CSV is opened in spreadsheet software. */
function csvCell(value: unknown): string {
  let text = String(value ?? "");
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function buildDaySheetCsv(
  date: string,
  appointments: Appointment[],
  blocked: BlockedSlot[],
): string {
  const rows = [
    ...appointments.map((appointment) => ({
      start: appointment.start_time,
      staff: appointment.staff_name ?? "Sin asignar",
      type: "Turno",
      values: [
        date,
        appointment.start_time,
        appointment.end_time,
        "Turno",
        appointment.identifier,
        appointment.staff_name ?? "Sin asignar",
        appointment.client_name ?? "",
        appointment.client_phone ?? "",
        appointment.appointment_services?.map((service) => service.service_name).filter(Boolean).join("; ") ?? "",
        appointment.status,
        appointment.notes,
      ],
    })),
    ...blocked.map((block) => ({
      start: block.start_time,
      staff: block.staff_name ?? "",
      type: "Horario bloqueado",
      values: [
        date,
        block.start_time,
        block.end_time,
        "Horario bloqueado",
        "",
        block.staff_name ?? "",
        "",
        "",
        "",
        "",
        block.reason,
      ],
    })),
  ].sort((a, b) => a.start.localeCompare(b.start)
    || a.staff.localeCompare(b.staff)
    || a.type.localeCompare(b.type));

  return [HEADERS, ...rows.map((row) => row.values)]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n") + "\r\n";
}

export function downloadDaySheet(
  date: string,
  appointments: Appointment[],
  blocked: BlockedSlot[],
): void {
  const csv = buildDaySheetCsv(date, appointments, blocked);
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `opensalon-day-sheet-${date}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
