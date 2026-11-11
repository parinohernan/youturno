import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "@/api";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { StatusBadge } from "./status-badge";
import { formatDate, formatMoney } from "@/lib/format";
import { bookingEndTime } from "../lib/booking-wizard";
import type { CustomerAppointment } from "../../shared/customer-bookings";

type Props = {
  slug: string; route: string; navigate: (route: string) => void;
  onChanged: () => void; onExpired: () => void;
  isCurrent?: () => boolean;
};
const utcToday = () => new Date().toISOString().slice(0, 10);
const chip = "min-h-11 min-w-0 rounded-full border px-2 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** This surface receives the wizard's verified session; it never opens a staff login. */
export function CustomerBookings({ slug, route, navigate, onChanged, onExpired, isCurrent = () => true }: Props) {
  const [appointments, setAppointments] = useState<CustomerAppointment[]>([]);
  const [appointment, setAppointment] = useState<CustomerAppointment | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const [moving, setMoving] = useState(false);
  const [date, setDate] = useState(utcToday());
  const [time, setTime] = useState<string | null>(null);
  const [slots, setSlots] = useState<string[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState("");
  const [slotsVersion, setSlotsVersion] = useState(0);
  const [review, setReview] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLElement>(null);
  const cancelTrigger = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const slotRequest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const selected = /^\d+$/.test(route) ? Number(route) : null;
  const prefix = `/api/public/${encodeURIComponent(slug)}/appointments`;

  useEffect(() => {
    let current = true;
    setLoading(true); setError(""); setAppointment(null); setAppointments([]);
    setMoving(false); setReview(false); setCancelOpen(false); setTime(null); setSlots([]);
    api<{ appointments?: CustomerAppointment[]; appointment?: CustomerAppointment }>("GET", selected ? `${prefix}/${selected}` : prefix)
      .then((result) => { if (current && isCurrent()) { setAppointments(result.appointments ?? []); setAppointment(result.appointment ?? null); } })
      .catch((cause) => { if (current && isCurrent()) {
        if (cause.status === 401) onExpired();
        else setError(cause.status === 404 ? "No se encontró el turno. Vuelva a sus turnos para consultar los pendientes." : "No se pudieron cargar sus turnos. Revise la conexión y vuelva a intentar.");
      } })
      .finally(() => { if (current && isCurrent()) { setLoading(false); if (!panel.current?.closest("details:not([open])")) heading.current?.focus(); } });
    return () => { current = false; };
  }, [slug, route, reload]);

  useEffect(() => {
    let current = true;
    const request = ++slotRequest.current;
    setSlots([]); setTime(null); setSlotsError(""); setReview(false);
    if (!moving || !appointment || !date) { setSlotsLoading(false); return; }
    setSlotsLoading(true);
    api<{ slots: string[] }>("GET", `${prefix}/${appointment.id}/slots?date=${encodeURIComponent(date)}`)
      .then((result) => { if (current && isCurrent() && request === slotRequest.current) setSlots(result.slots); })
      .catch((cause) => { if (current && isCurrent() && request === slotRequest.current) {
        if (cause.status === 401) onExpired();
        else setSlotsError(cause.status === 409 ? cause.message : "No se pudieron cargar los horarios. Vuelva a intentar.");
      } })
      .finally(() => { if (current && isCurrent() && request === slotRequest.current) setSlotsLoading(false); });
    return () => { current = false; };
  }, [moving, appointment?.id, date, slotsVersion, slug]);

  const save = async (action: "cancel" | "reschedule") => {
    if (!isCurrent() || !appointment || lock.current || (action === "cancel" ? !cancelOpen || !appointment.can_cancel : !review || !time || !slots.includes(time) || !appointment.can_reschedule)) return;
    lock.current = true; setSaving(true); setError("");
    try {
      await api("POST", `${prefix}/${appointment.id}/actions`, { action, version: appointment.version,
        ...(action === "reschedule" ? { date, start_time: time } : {}) });
      if (!mounted.current || !isCurrent()) return;
      setCancelOpen(false); setMoving(false); setReview(false); setTime(null); setSlots([]);
      setNotice(action === "cancel" ? "Turno cancelado. Puede consultar si está habilitado para reservar nuevamente." : "Turno reprogramado. El nuevo horario ya figura en la agenda de la empresa.");
      onChanged();
      if (selected) navigate("lista"); else setReload((value) => value + 1);
    } catch (cause) {
      if (!mounted.current || !isCurrent()) return;
      const failure = cause as { status?: number; message?: string };
      if (failure.status === 401) { setCancelOpen(false); onExpired(); }
      else if (failure.status === 409) {
        // Keep the selected day and original booking. Refresh the version and slots;
        // the customer must explicitly select/review again, never silently retry.
        setError(failure.message ?? "Los datos cambiaron. Revise el turno antes de confirmar nuevamente.");
        setCancelOpen(false); setReview(false); setTime(null); setSlotsVersion((value) => value + 1);
        try {
          const result = await api<{ appointment: CustomerAppointment }>("GET", `${prefix}/${appointment.id}`);
          if (!mounted.current || !isCurrent()) return;
          setAppointment(result.appointment);
          if (!result.appointment.can_reschedule) setMoving(false);
        } catch (refresh) { if (mounted.current && isCurrent() && (refresh as { status?: number }).status === 401) onExpired(); }
      } else setError(failure.message ?? "No se pudo guardar el cambio. Su turno no fue modificado; vuelva a intentar.");
    } finally { lock.current = false; if (mounted.current && isCurrent()) setSaving(false); }
  };
  const summary = (item: CustomerAppointment) => <div className="space-y-2 [overflow-wrap:anywhere]">
    <div className="flex flex-wrap items-center gap-2"><span className="booking-eyebrow">{item.identifier}</span><StatusBadge status={item.status} /></div>
    <p className="text-lg font-semibold">{item.services.join(" · ") || "Turno con la empresa"}</p>
    <p>{formatDate(item.scheduled_date, "long")}</p>
    <p className="font-mono text-lg">{item.start_time}–{item.end_time} <span className="text-xs">UTC</span></p>
    <p className="text-sm">{item.staff_name ?? "Profesional por confirmar"} · {formatMoney(item.total_price)}</p>
    {["booked", "confirmed", "in_progress"].includes(item.status) && Date.parse(`${item.scheduled_date}T${item.start_time}:00Z`) <= Date.now() && Date.parse(`${item.scheduled_date}T${item.end_time}:00Z`) > Date.now() && <p className="text-sm">En curso. Solo la empresa puede modificarlo; contacte a la empresa si necesita asistencia.</p>}
    {item.status === "in_progress" && Date.parse(`${item.scheduled_date}T${item.start_time}:00Z`) > Date.now() && <p className="text-sm">Turno en curso. Solo la empresa puede modificarlo; contacte a la empresa si necesita asistencia.</p>}
  </div>;

  return <section ref={panel} className="booking-panel booking-wizard-screen min-w-0 space-y-5 p-5 sm:p-8" aria-labelledby="customer-bookings-title" aria-busy={saving}>
    <div><p className="booking-eyebrow">Su agenda personal</p><h2 ref={heading} id="customer-bookings-title" tabIndex={-1} className="text-2xl font-semibold">{selected ? moving ? "Un nuevo momento" : "Su turno" : "Próximos y en curso"}</h2></div>
    <div className="flex flex-wrap gap-2">
      {selected && <Button variant="outline" disabled={saving} onClick={() => { setNotice(""); navigate("lista"); }}>Volver a mis turnos</Button>}
      <Button variant="outline" disabled={saving} onClick={() => navigate("")}>Volver a reservar</Button>
      <Button variant="outline" disabled={saving || loading} onClick={() => setReload((value) => value + 1)}>Actualizar turnos</Button>
    </div>
    {notice && <p role="status" className="booking-notice">{notice}</p>}
    {error && <div role="alert" className="space-y-2"><p>{error}</p><Button variant="outline" disabled={saving} onClick={() => setReload((value) => value + 1)}>Reintentar</Button></div>}
    {loading ? <p role="status">Cargando sus turnos…</p> : selected && appointment ? <>
      {summary(appointment)}
      {!moving ? <div className="flex flex-wrap gap-2">
        {appointment.can_reschedule && <Button onClick={() => { setMoving(true); setDate(appointment.scheduled_date >= utcToday() ? appointment.scheduled_date : utcToday()); setError(""); setNotice(""); }}>Reprogramar</Button>}
        {appointment.can_cancel && <Button ref={cancelTrigger} variant="outline" onClick={() => { setCancelOpen(true); setError(""); }}>Cancelar turno</Button>}
      </div> : <div className="space-y-4 border-t pt-4">
        <p className="text-sm">Se mantienen el profesional, todos los servicios, el precio y la duración ({appointment.duration} min). El turno actual se conserva hasta confirmar el cambio.</p>
        <label className="block space-y-2"><span className="font-medium">Nuevo día (UTC)</span>
          <input className="min-h-11 w-full min-w-0 max-w-full rounded-md border bg-background p-3" type="date" min={utcToday()} value={date} disabled={saving}
            onInput={(event) => { if (event.currentTarget.value !== date) { slotRequest.current++; setDate(event.currentTarget.value); setTime(null); setReview(false); setSlots([]); } }} /></label>
        {slotsLoading ? <p role="status">Buscando horarios…</p> : slotsError ? <p role="alert">{slotsError}</p> : slots.length === 0 ? <p role="status">No hay horarios disponibles para este día.</p> :
          <div className="booking-time-grid" role="group" aria-label="Nuevo horario">
            {slots.map((slot) => <button key={slot} type="button" disabled={saving} aria-pressed={time === slot}
              className={`${chip} ${time === slot ? "bg-primary text-primary-foreground" : "bg-background"}`} onClick={() => { setTime(slot); setReview(false); }}>{slot}</button>)}
          </div>}
        <Button variant="outline" disabled={saving || slotsLoading} onClick={() => setSlotsVersion((value) => value + 1)}>Actualizar horarios</Button>
        {review && time && <div className="booking-notice space-y-3 p-3" role="status">
          <h3 className="font-semibold">Revise el cambio</h3>
          <p>Actual: {formatDate(appointment.scheduled_date)} · {appointment.start_time}–{appointment.end_time} UTC</p>
          <p>Nuevo: {formatDate(date)} · {time}–{bookingEndTime(time, appointment.duration)} UTC</p>
          <p className="text-sm">{appointment.services.join(" · ")} · {appointment.staff_name} · {formatMoney(appointment.total_price)}</p>
          <Button disabled={saving || slotsLoading || !slots.includes(time)} onClick={() => void save("reschedule")}>{saving ? "Guardando…" : "Confirmar nuevo horario"}</Button>
        </div>}
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={saving} onClick={() => { setMoving(false); setReview(false); }}>Conservar horario actual</Button>
          {!review && <Button disabled={!time || slotsLoading || saving} onClick={() => setReview(true)}>Revisar cambio</Button>}</div>
      </div>}
    </> : !selected && !error ? appointments.length ? <ol className="space-y-4">
      {appointments.map((item, index) => <li key={item.id} className="min-w-0 border-t pt-5">
        <p className="booking-eyebrow mb-3">{String(index + 1).padStart(2, "0")} / Su visita</p>
        {summary(item)}<Button className="mt-4" onClick={() => { setNotice(""); navigate(String(item.id)); }}>Ver turno</Button>
      </li>)}
    </ol> : <div className="space-y-3"><p>No tiene próximos turnos en esta empresa.</p><Button onClick={() => navigate("")}>Reservar un turno</Button></div> : null}
    <Dialog open={cancelOpen} onOpenChange={(open: boolean) => { if (!lock.current) setCancelOpen(open); }}>
      <DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-md grid-cols-[minmax(0,1fr)] overflow-y-auto [overflow-wrap:anywhere] [&>button]:min-w-11"
        portalContainer={panel.current?.closest(".booking-appearance") as HTMLElement | undefined}
        onOpenAutoFocus={(event: Event) => { event.preventDefault(); keepButton.current?.focus(); }}
        onCloseAutoFocus={(event: Event) => { event.preventDefault(); cancelTrigger.current?.focus(); }}>
        <DialogTitle className="pr-10">¿Cancelar {appointment?.identifier}?</DialogTitle>
        <DialogDescription>Se liberará el horario de este turno. Para su primera visita, el límite se libera cuando no quedan otros turnos activos. Su categoría no cambia. No se envían mensajes automáticos.</DialogDescription>
        {appointment && summary(appointment)}
        {error && <p role="alert">{error}</p>}
        <div className="flex flex-wrap gap-2"><Button ref={keepButton} variant="outline" disabled={saving} onClick={() => setCancelOpen(false)}>Conservar turno</Button>
          <Button disabled={saving} onClick={() => void save("cancel")}>{saving ? "Cancelando…" : "Confirmar cancelación"}</Button></div>
      </DialogContent>
    </Dialog>
  </section>;
}
