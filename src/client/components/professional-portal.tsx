import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api";
import { today, shiftDate } from "../lib/dates";
import { formatDate, formatMoney } from "../lib/format";
import { actionable, appointmentDuration, bookingUpdates, chronological, nextAppointment, pollDelay, sameSnapshot, snapshot, type AppointmentSnapshot } from "../lib/professional-agenda";
import * as Dialog from "@radix-ui/react-dialog";
import { dayIntervals } from "./weekly-hours-editor";
import type { WeeklyHours } from "../types";
import { ProfessionalAvatar } from "./professional-avatar";

type Booking = AppointmentSnapshot & { id: number; identifier: string; client_name: string | null; client_phone: string | null;
  client_email: string | null; notes: string; total_price: number;
  services?: { service_name: string; duration: number; price: number }[];
  notes_history?: { content: string; created_at: string }[];
  history?: { action: string; old_date: string; old_start: string; new_date: string; new_start: string; created_at: string }[] };
type Agenda = { appointments: Booking[]; upcoming: Booking[]; cursor: number; new_booking_ids: number[]; staff: { name: string; photo_url?: string | null; effective_hours: WeeklyHours } | null };

export function ProfessionalPortal({ companyName, logout }: { companyName: string | null; logout: () => Promise<void> }) {
  const [date, setDate] = useState(today());
  const [agenda, setAgenda] = useState<Agenda | null>(null);
  const [detail, setDetail] = useState<Booking | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [alerts, setAlerts] = useState(0);
  const [updated, setUpdated] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [acknowledged, setAcknowledged] = useState(false);
  const [edit, setEdit] = useState<{ expected: AppointmentSnapshot; date: string; time: string } | null>(null);
  const cursor = useRef<number | null>(null);
  const acting = useRef(false);
  const generation = useRef(0);
  const [view, setView] = useState<"day" | "upcoming">("day");
  const [confirmation, setConfirmation] = useState<"completed" | "cancelled" | null>(null);
  const [offline, setOffline] = useState(typeof navigator !== "undefined" && navigator.onLine === false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const confirmationOpener = useRef<HTMLButtonElement | null>(null);
  const rescheduleHeading = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    if (edit) {
      rescheduleHeading.current?.focus({ preventScroll: true });
      rescheduleHeading.current?.scrollIntoView({ block: "start" });
    }
  }, [!!edit]);

  useEffect(() => {
    const connection = () => setOffline(navigator.onLine === false);
    window.addEventListener("online", connection); window.addEventListener("offline", connection);
    return () => { window.removeEventListener("online", connection); window.removeEventListener("offline", connection); };
  }, []);

  useEffect(() => {
    let disposed = false, pending = false, failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => document.visibilityState !== "hidden" && document.hasFocus() && navigator.onLine !== false;
    const load = async () => {
      clearTimeout(timer);
      if (disposed || pending) return;
      if (!visible()) return;
      if (acting.current) { timer = setTimeout(load, 15_000); return; }
      pending = true;
      const version = generation.current;
      try {
        const result = await api<Agenda>("GET", `/api/professional/agenda?date=${date}${cursor.current === null ? "" : `&cursor=${cursor.current}`}`);
        const appointment = selected === null ? null : (await api<{ appointment: Booking }>("GET", `/api/professional/appointments/${selected}`)).appointment;
        if (disposed || acting.current || version !== generation.current) return;
        const updates = bookingUpdates(cursor.current, result.cursor, result.new_booking_ids);
        cursor.current = updates.cursor;
        setAlerts((value) => value + updates.count);
        setAgenda(result); setDetail(appointment); setError("");
        setUpdated(new Date().toLocaleTimeString("es-419", { hour: "2-digit", minute: "2-digit" })); failures = 0;
      } catch (cause) {
        if (disposed || version !== generation.current) return;
        failures++;
        const status = (cause as { status?: number }).status;
        if (status === 401 || status === 403) { setAgenda(null); setDetail(null); setSelected(null); setEdit(null); cursor.current = null; setAlerts(0); }
        if (status === 404) { setAgenda(null); setDetail(null); setSelected(null); setEdit(null); }
        setError(status === 404 ? "El turno ya no está asignado a su agenda." : "No se pudo actualizar. Verifique su sesión y conexión; los datos pueden estar desactualizados.");
      } finally {
        pending = false;
        if (!disposed && visible()) timer = setTimeout(load, pollDelay(failures));
      }
    };
    const wake = () => { if (visible()) void load(); else clearTimeout(timer); };
    const pause = () => clearTimeout(timer);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake); window.addEventListener("online", wake);
    window.addEventListener("blur", pause); window.addEventListener("offline", pause);
    void load();
    return () => {
      disposed = true; clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake); window.removeEventListener("online", wake);
      window.removeEventListener("blur", pause); window.removeEventListener("offline", pause);
    };
  }, [date, selected, refresh]);

  const choose = (id: number | null) => {
    generation.current++; setSelected(id); setDetail(null); setEdit(null); setConfirmation(null); setAcknowledged(false); setMessage(""); setActionError("");
  };
  const action = async (kind: "completed" | "cancelled" | "reschedule") => {
    if (!detail || acting.current || error || offline) return;
    acting.current = true; generation.current++; setBusy(true); setMessage(""); setActionError("");
    try {
      const result = await api<{ message: string }>("POST", `/api/professional/appointments/${detail.id}/actions`, {
        action: kind, expected: kind === "reschedule" && edit ? edit.expected : snapshot(detail),
        ...(kind === "reschedule" && edit ? { date: edit.date, start_time: edit.time } : {}),
        manual_contact_acknowledged: acknowledged,
      });
      setMessage(result.message); setEdit(null); setAcknowledged(false); setDetail(null); setSelected(null); setConfirmation(null);
    } catch (cause) {
      const status = (cause as { status?: number }).status;
      if (status === 401 || status === 403) { setAgenda(null); setDetail(null); setSelected(null); setEdit(null); setConfirmation(null); cursor.current = null; setAlerts(0); setError("Su sesión no permite continuar. Vuelva a ingresar."); }
      else setActionError(`No se guardó el cambio. ${(cause as Error).message}`);
    }
    finally { acting.current = false; setBusy(false); setRefresh((value) => value + 1); }
  };
  const status = (value: string) => <span className="pa-status" data-status={value}>{({ booked: "Reservado", confirmed: "Confirmado", in_progress: "En curso", completed: "Finalizado", cancelled: "Cancelado", no_show: "No asistió" } as Record<string, string>)[value] || value}</span>;
  const openBooking = (booking: Booking, button: HTMLButtonElement) => { opener.current = button; choose(booking.id); };
  const list = (bookings: Booking[]) => <ol className="pa-list">{chronological(bookings).map((booking) => <li key={booking.id}>
    <button className="pa-row" disabled={busy} onClick={(event) => openBooking(booking, event.currentTarget)}>
      <span className="pa-time"><strong>{booking.start_time}</strong><span>{booking.end_time}</span></span>
      <span className="pa-row-content"><strong>{booking.client_name || "Cliente"}</strong>
        <span>{view === "upcoming" ? `${formatDate(booking.scheduled_date)} · ` : ""}{appointmentDuration(booking)} min · {booking.identifier}</span>
        {status(booking.status)}</span><span className="pa-arrow" aria-hidden="true">↗</span>
    </button></li>)}</ol>;
  const active = detail && actionable(detail);
  const staleEdit = !!edit && !!detail && !sameSnapshot(edit.expected, detail);
  const next = agenda && !error && !offline ? nextAppointment(agenda.appointments, date) : undefined;
  const changeDate = (value: string) => { if (value && value !== date) { choose(null); setAgenda(null); setDate(value); } };
  const bookings = agenda ? view === "day" ? agenda.appointments : agenda.upcoming : [];
  const tabKey = (event: KeyboardEvent) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault(); const target = event.key === "Home" ? "day" : event.key === "End" ? "upcoming" : view === "day" ? "upcoming" : "day";
      setView(target); document.getElementById(`pa-tab-${target}`)?.focus();
    }
  };
  return <main className="professional-agenda">
    <header className="pa-header"><div className="pa-context"><span className="pa-brand">youturno <span aria-hidden="true">/</span> <small>Profesionales</small></span><p>{companyName || "Su espacio profesional"}</p></div>
      <button className="pa-quiet" disabled={busy} onClick={logout}>Salir</button></header>
    <div className="pa-workspace">
      <div className="pa-heading"><div><div className="pa-identity"><ProfessionalAvatar src={agenda?.staff?.photo_url} eager /><p className="pa-eyebrow">{agenda?.staff?.name || "Espacio de trabajo"}</p></div><h1>Mi agenda<span aria-hidden="true">.</span></h1></div><span className="pa-zone">UTC</span></div>
      <div className="pa-sync"><p role="status">{offline ? "Sin conexión · los datos pueden estar desactualizados." : error ? "Actualización pendiente" : updated ? `Actualizado ${updated}` : "Conectando con su agenda…"}</p><button className="pa-quiet" disabled={busy || offline} onClick={() => setRefresh(value => value + 1)}>Actualizar</button></div>
      {alerts > 0 && <div role="status" className="pa-notice"><p>{alerts} {alerts === 1 ? "nuevo turno en su agenda" : "nuevos turnos en su agenda"}.</p><button onClick={() => setAlerts(0)}>Entendido</button></div>}
      {error && <p role="alert" className="pa-notice pa-error">{error}</p>}
      {message && <p role="status" className="pa-notice">{message}</p>}
      <div className="pa-tabs" role="tablist" aria-label="Vista de agenda">{([['day', 'Día'], ['upcoming', 'Próximos']] as const).map(([key, label]) => <button key={key} role="tab" id={`pa-tab-${key}`} aria-selected={view === key} aria-controls="pa-agenda-panel" tabIndex={view === key ? 0 : -1} onKeyDown={tabKey} onClick={() => setView(key)}>{label}</button>)}</div>
      <section role="tabpanel" id="pa-agenda-panel" aria-labelledby={`pa-tab-${view}`} tabIndex={0}>
        {view === "day" ? <div className="pa-datebar"><button aria-label="Día anterior" disabled={busy} onClick={() => changeDate(shiftDate(date, -1))}>←</button><label><span className="pa-eyebrow">Día de atención</span><input aria-label="Día de atención" type="date" value={date} disabled={busy} onChange={event => changeDate(event.currentTarget.value)} /></label><button aria-label="Día siguiente" disabled={busy} onClick={() => changeDate(shiftDate(date, 1))}>→</button><button className="pa-today" disabled={busy || date === today()} onClick={() => changeDate(today())}>Hoy</button></div> : <p className="pa-view-note">Hasta 100 turnos en los próximos 90 días.</p>}
        {view === "day" && next && <button className="pa-next" onClick={event => openBooking(next, event.currentTarget)}><span className="pa-eyebrow">{next.status === "in_progress" ? "Turno en curso" : "Próximo turno"}</span><span className="pa-next-main"><strong>{next.start_time}</strong><span>{next.client_name || "Cliente"}<small>Hasta {next.end_time} · {appointmentDuration(next)} min</small></span><span aria-hidden="true">↗</span></span><span className="pa-next-footer">Ver detalle y gestionar <span aria-hidden="true">→</span></span></button>}
        <div className="pa-section-heading"><h2>{view === "day" ? "Turnos del día" : "Próximos turnos"}</h2>{agenda && <span>{bookings.length} {bookings.length === 1 ? "turno" : "turnos"}</span>}</div>
        {agenda ? bookings.length ? list(bookings) : <div className="pa-empty"><span aria-hidden="true">—</span><h3>{view === "day" ? "Un día sin turnos" : "Sin próximos turnos"}</h3><p>{view === "day" ? "No hay turnos para esta fecha. Puede consultar otro día." : "Los nuevos turnos aparecerán aquí al actualizar."}</p></div> : <p className="pa-empty" role="status">{error ? "Agenda no disponible." : offline ? "Conéctese para cargar su agenda." : "Cargando agenda…"}</p>}
      </section>
      {agenda?.staff && <details className="pa-hours"><summary>Mi jornada habitual <span>UTC</span></summary><ul>{([['mon', 'Lunes'], ['tue', 'Martes'], ['wed', 'Miércoles'], ['thu', 'Jueves'], ['fri', 'Viernes'], ['sat', 'Sábado'], ['sun', 'Domingo']] as const).map(([key, label]) => {
        const intervals = dayIntervals(agenda.staff!.effective_hours[key]);
        return <li key={key}><span>{label}</span><span>{intervals.length ? intervals.map(([start, end]) => `${start}–${end}`).join(' · ') : 'Cerrado'}</span></li>;
      })}</ul></details>}
      <footer className="pa-footnote">Horarios en UTC · Se actualiza cada 15 segundos con la ventana activa y conexión. No es instantáneo.</footer>
    </div>
    <Dialog.Root open={selected !== null} onOpenChange={(open: boolean) => { if (!open && !busy) choose(null); }}>
      <Dialog.Portal><Dialog.Overlay className="pa-overlay" /><Dialog.Content className="professional-agenda pa-sheet" onOpenAutoFocus={(event: Event) => { event.preventDefault(); closeButton.current?.focus(); }} onCloseAutoFocus={(event: Event) => { event.preventDefault(); opener.current?.focus(); }} onPointerDownOutside={(event: Event) => event.preventDefault()}>
        <div className="pa-sheet-top"><span className="pa-eyebrow">Detalle del turno</span><button ref={closeButton} className="pa-quiet" disabled={busy} onClick={() => choose(null)}>Cerrar <span aria-hidden="true">×</span></button></div>
        <div className="pa-sheet-body"><Dialog.Title className="pa-detail-title">{detail?.client_name || (detail ? "Cliente" : "Cargando turno…")}</Dialog.Title><Dialog.Description className="pa-detail-description">{detail ? `${detail.identifier} · ${formatDate(detail.scheduled_date)} · UTC` : "Consultando los datos de su turno."}</Dialog.Description>
          {!detail ? <p role={error ? "alert" : "status"}>{error || (offline ? "Sin conexión. Conéctese para cargar el turno." : "Cargando turno…")}</p> : <>
            <div className="pa-slot"><p><strong>{detail.start_time}–{detail.end_time}</strong><span>{appointmentDuration(detail)} minutos</span></p>{status(detail.status)}</div>
            {error && <p className="pa-notice pa-error" role="alert">{error}</p>}{offline && <p className="pa-notice" role="status">Sin conexión. Conéctese antes de gestionar el turno.</p>}
            <section className="pa-detail-section"><h3>Contacto del cliente</h3><p className="pa-phone">{detail.client_phone || "Teléfono no registrado"}</p><p className="pa-muted">Teléfono de contacto no verificado.</p>
              {detail.client_phone && <div className="pa-contact-actions"><a className="pa-button" href={`tel:${detail.client_phone.replace(/[^+\d]/g, "")}`}>Llamar al cliente <span aria-hidden="true">↗</span></a><button className="pa-button pa-secondary" onClick={() => { void (navigator.clipboard?.writeText(detail.client_phone!) ?? Promise.reject()).then(() => setMessage("Teléfono copiado.")).catch(() => setMessage("No se pudo copiar. Seleccione el número manualmente.")); }}>Copiar teléfono</button></div>}
              {message && <p role="status">{message}</p>}<details><summary>Correo del cliente</summary><p>{detail.client_email || "No registrado"}</p></details>
            </section>
            <section className="pa-detail-section"><h3>Servicios del turno</h3><ul className="pa-services">{detail.services?.map((service, index) => <li key={index}><span>{service.service_name || "Servicio"}<small>{service.duration} min</small></span><span>{formatMoney(service.price)}</span></li>)}</ul>{detail.notes && <p className="pa-notes">{detail.notes}</p>}</section>
            {(active || edit) && <fieldset disabled={busy || !!error || offline} className="pa-actions"><legend>Gestionar turno</legend>
              {!edit ? <><button className="pa-button" onClick={event => { confirmationOpener.current = event.currentTarget; setActionError(""); setConfirmation("completed"); }}>Finalizar turno</button><p className="pa-muted">Finalizar no registra un pago.</p><button className="pa-button pa-secondary" onClick={() => { setActionError(""); setAcknowledged(false); setEdit({ expected: snapshot(detail), date: detail.scheduled_date, time: detail.start_time }); }}>Reprogramar</button><button className="pa-danger-link" onClick={event => { confirmationOpener.current = event.currentTarget; setActionError(""); setAcknowledged(false); setConfirmation("cancelled"); }}>Cancelar turno</button></> : <form className="pa-reschedule" onSubmit={event => { event.preventDefault(); if (!staleEdit && acknowledged) void action("reschedule"); }}><h3 ref={rescheduleHeading} tabIndex={-1}>Reprogramar turno</h3><p>Se conservan los {appointmentDuration(edit.expected)} minutos originales. El nuevo horario debe estar libre y dentro de su jornada y la de la empresa; no se aplica la frecuencia de reservas públicas.</p><label>Nueva fecha<input type="date" required value={edit.date} onInput={event => setEdit({ ...edit, date: event.currentTarget.value })} /></label><label>Hora (UTC)<input type="time" required value={edit.time} onInput={event => setEdit({ ...edit, time: event.currentTarget.value })} /></label><p>No se envían mensajes automáticos. Coordine el cambio con el cliente.</p><label className="pa-check"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.currentTarget.checked)} />Entiendo que debo contactar al cliente manualmente.</label>{staleEdit && <p role="alert" className="pa-notice pa-error">El turno cambió. Vuelva al detalle y abra la reprogramación para revisar el horario actualizado.</p>}{actionError && <p role="alert" className="pa-notice pa-error">{actionError}</p>}<button className="pa-button" disabled={!acknowledged || staleEdit}>{busy ? "Guardando…" : "Guardar reprogramación"}</button><button type="button" className="pa-button pa-secondary" onClick={() => { setEdit(null); setActionError(""); }}>Volver al detalle</button></form>}
            </fieldset>}
            {!!detail.notes_history?.length && <details className="pa-history"><summary>Notas de este turno <span>{detail.notes_history.length}</span></summary><ul>{detail.notes_history.map((note, index) => <li key={index}><p>{note.content}</p><small>{note.created_at} UTC</small></li>)}</ul></details>}
            {!!detail.history?.length && <details className="pa-history"><summary>Cambios de este turno <span>{detail.history.length}</span></summary><ul>{detail.history.map((change, index) => <li key={index}>{change.action === "completed" ? "Finalizado" : change.action === "cancelled" ? "Cancelado" : "Reprogramado"}<p>{change.old_date} {change.old_start} → {change.new_date} {change.new_start}</p><small>{change.created_at} UTC</small></li>)}</ul></details>}
          </>}
        </div>
        <Dialog.Root open={confirmation !== null} onOpenChange={(open: boolean) => { if (!open && !busy) { setConfirmation(null); setActionError(""); } }}><Dialog.Portal><Dialog.Overlay className="pa-overlay pa-confirm-overlay" /><Dialog.Content className="professional-agenda pa-confirm" onPointerDownOutside={(event: Event) => event.preventDefault()} onOpenAutoFocus={(event: Event) => { event.preventDefault(); document.getElementById("pa-keep-appointment")?.focus(); }} onCloseAutoFocus={(event: Event) => { event.preventDefault(); confirmationOpener.current?.focus(); }}>
          <Dialog.Title>{confirmation === "cancelled" ? "¿Cancelar este turno?" : "¿Finalizar este turno?"}</Dialog.Title><Dialog.Description>{confirmation === "cancelled" ? "El turno quedará cancelado. Debe avisar al cliente manualmente: no se envían mensajes automáticos." : "El turno quedará finalizado. Esta acción no registra ningún pago."}</Dialog.Description>
          {detail && <p>{detail.client_name || "Cliente"} · {formatDate(detail.scheduled_date)} · {detail.start_time} UTC</p>}
          {confirmation === "cancelled" && <label className="pa-check"><input type="checkbox" disabled={busy} checked={acknowledged} onChange={event => setAcknowledged(event.currentTarget.checked)} />Entiendo que debo contactar al cliente manualmente.</label>}
          {actionError && <p className="pa-notice pa-error" role="alert">{actionError}</p>}
          <button id="pa-keep-appointment" className="pa-button pa-secondary" disabled={busy} onClick={() => { setConfirmation(null); setActionError(""); }}>Volver al turno</button><button className={`pa-button ${confirmation === "cancelled" ? "pa-destructive" : ""}`} disabled={busy || !!error || offline || (confirmation === "cancelled" && !acknowledged)} onClick={() => { if (confirmation) void action(confirmation); }}>{busy ? "Guardando…" : confirmation === "cancelled" ? "Confirmar cancelación" : "Confirmar finalización"}</button>
        </Dialog.Content></Dialog.Portal></Dialog.Root>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </main>;
}
