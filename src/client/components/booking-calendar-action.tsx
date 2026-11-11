import { useRef, useState } from "preact/hooks";
import { Button, buttonVariants } from "./ui/button";
import { bookingCalendarEvent, calendarCopyWarning, downloadBookingCalendar, googleCalendarUrl,
  type CalendarAppointment, type BookingCalendarContext } from "../lib/booking-calendar";

export function BookingCalendarAction({ appointment, context, preview = false }: {
  appointment: CalendarAppointment; context: BookingCalendarContext; preview?: boolean;
}) {
  const summary = useRef<HTMLElement>(null);
  const [error, setError] = useState(false);
  const actionClass = "h-auto min-h-11 w-full max-w-full whitespace-normal [overflow-wrap:anywhere]";
  if (preview) return <div className="w-full max-w-xs space-y-2">
    <Button variant="outline" className={actionClass} disabled>Agregar al calendario</Button>
    <p className="text-xs text-muted-foreground">Disponible al confirmar un turno real.</p>
  </div>;
  const event = bookingCalendarEvent(appointment, context, window.location.hostname);
  if (!event) return <p className="text-xs text-muted-foreground">No se pudo preparar el evento de calendario. Consulte los datos en Mis turnos.</p>;
  return <details className="w-full min-w-0 max-w-xs space-y-2" data-booking-calendar
    onKeyDown={(e) => {
      if (e.key === "Escape") { e.stopPropagation(); e.currentTarget.open = false; summary.current?.focus(); }
    }}>
    <summary ref={summary} className={buttonVariants({ variant: "outline", className: `${actionClass} cursor-pointer list-none [&::-webkit-details-marker]:hidden` })}>
      Agregar al calendario
    </summary>
    <div className="space-y-2 rounded-md border p-3 text-left">
      <Button variant="outline" className={actionClass} asChild>
        <a href={googleCalendarUrl(event)} target="_blank" rel="noopener noreferrer">Google Calendar<span className="sr-only"> (se abre en otra pestaña)</span></a>
      </Button>
      <Button variant="outline" className={actionClass} onClick={() => {
        try { downloadBookingCalendar(event); setError(false); } catch { setError(true); }
      }}>Apple, Outlook y otros (.ics)</Button>
      <p className="text-xs text-muted-foreground">{calendarCopyWarning}</p>
      {error && <p className="text-xs" role="alert">No se pudo descargar el archivo. Vuelva a intentar.</p>}
    </div>
  </details>;
}
