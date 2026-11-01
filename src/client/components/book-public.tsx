/**
 * Public booking page for end customers at /book/{slug}.
 *
 * Lives entirely outside the tenant session gate: anyone opening the link can
 * browse services, pick a day and a time, and only then is asked to sign in
 * with Google (which the server gates via the `yt_book` customer cookie).
 * A pending selection survives the Google round-trip in sessionStorage so the
 * customer reviews and explicitly confirms after returning signed in.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "@/api";
import { shiftDate, today, parseDate } from "@/lib/dates";
import { formatDate, formatMoney } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { cn } from "@/lib/utils";
import { dayIntervals } from "./weekly-hours-editor";
import { compatibleSelection, chooseService, chooseStaff } from "../lib/booking-selection";
import { bookingHours, type ScheduledStaff } from "../lib/booking-hours";

interface PublicOverview {
  google_sign_in: boolean;
  company: { name: string; slug: string; business_hours: import("../types").WeeklyHours };
  services: { id: number; name: string; duration: number; price: number }[];
  staff: (ScheduledStaff & { name: string; title: string; color: string })[];
}

interface CustomerSession {
  sub: string;
  email: string;
  name: string;
}

/** What the app booked, as confirmed by the server. */
interface BookedAppointment {
  id: number;
  identifier: string;
  scheduled_date: string;
  start_time: string;
  end_time: string;
  status: string;
}

/** Selection stashed across the Google sign-in redirect. */
interface BookDraft {
  serviceId: number;
  staffId: number | null;
  date: string;
  time: string;
}

type OverviewPhase = "loading" | "ready" | "notfound" | "error";

const DAY_LABELS: [string, string][] = [
  ["mon", "Lunes"], ["tue", "Martes"], ["wed", "Miércoles"], ["thu", "Jueves"],
  ["fri", "Viernes"], ["sat", "Sábado"], ["sun", "Domingo"],
];

const fmtWeekday = new Intl.DateTimeFormat("es-419", { weekday: "short" });

function draftKey(slug: string): string {
  return `yt-public-book-${slug}`;
}

export function BookPublic({ slug }: { slug: string }) {
  const [phase, setPhase] = useState<OverviewPhase>("loading");
  const [overview, setOverview] = useState<PublicOverview | null>(null);
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [staffId, setStaffId] = useState<number | null>(null); // null = "Cualquiera"
  const [date, setDate] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [slots, setSlots] = useState<string[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [customer, setCustomer] = useState<CustomerSession | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [booked, setBooked] = useState<BookedAppointment | null>(null);
  const [notice, setNotice] = useState("");
  const [authFailed] = useState(() => new URLSearchParams(window.location.search).get("auth") === "failed");
  const submitting = useRef(false);
  const [booking, setBooking] = useState(false);
  const [slotsVersion, setSlotsVersion] = useState(0);

  useEffect(() => {
    const refresh = () => {
      setSlotsVersion((version) => version + 1);
      api<PublicOverview>("GET", `/api/public/${slug}/overview`).then(setOverview).catch(() => {});
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [slug]);

  const service = overview?.services.find((s) => s.id === serviceId) ?? null;
  const compatible = !!overview && compatibleSelection(overview.staff, { serviceId, staffId });
  const selectService = (id: number | null) => {
    if (!overview) return;
    const next = chooseService(overview.staff, { serviceId, staffId }, id);
    setServiceId(next.serviceId); setStaffId(next.staffId); setTime(null); setSlots([]); setNotice("");
  };
  const selectStaff = (id: number | null) => {
    if (!overview) return;
    const next = chooseStaff(overview.staff, { serviceId, staffId }, id);
    setServiceId(next.serviceId); setStaffId(next.staffId); setTime(null); setSlots([]); setNotice("");
  };

  // Revalidate restored OAuth intent and refreshed overview before confirmation.
  useEffect(() => {
    if (!overview) return;
    if ((serviceId !== null && !service) || !compatible) {
      setServiceId(null); setStaffId(null); setTime(null); setSlots([]);
      setNotice("La selección ya no está disponible. Elegí nuevamente el servicio y el profesional.");
    }
  }, [overview, serviceId, staffId]);

  // ── Boot: overview + customer session + resumed draft ──

  useEffect(() => {
    document.title = "Reservar turno";
    api<PublicOverview>("GET", `/api/public/${slug}/overview`)
      .then(setOverview)
      .catch((cause) => setPhase((cause as { status?: number }).status === 404 ? "notfound" : "error"))
      .finally(() => setPhase((prev) => (prev === "loading" ? "ready" : prev)));
    api<{ customer: CustomerSession }>("GET", "/api/auth/customer/session")
      .then((result) => setCustomer(result.customer))
      .catch(() => setCustomer(null))
      .finally(() => setSessionChecked(true));

    try {
      const raw = sessionStorage.getItem(draftKey(slug));
      if (raw) {
        const draft = JSON.parse(raw) as BookDraft;
        if (Number.isSafeInteger(draft.serviceId) && (draft.staffId === null || Number.isSafeInteger(draft.staffId)) &&
          /^\d{4}-\d{2}-\d{2}$/.test(draft.date) && /^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) {
          setServiceId(draft.serviceId);
          setStaffId(draft.staffId);
          setDate(draft.date);
          setTime(draft.time);
        }
        sessionStorage.removeItem(draftKey(slug));
      }
    } catch { /* Corrupt drafts just mean starting over. */ }
  }, [slug]);

  // ── Slots follow the chosen service + staff + date ──

  useEffect(() => {
    let current = true;
    setSlots([]);
    if (!serviceId || !date || !service || !compatible) { setSlotsLoading(false); return; }
    const params = new URLSearchParams({ date, service_id: String(serviceId) });
    if (staffId !== null) params.set("staff_id", String(staffId));
    setSlotsLoading(true);
    api<{ slots: string[] }>("GET", `/api/public/${slug}/slots?${params}`)
      .then((result) => { if (current) {
        setSlots(result.slots);
        setTime((selected) => selected && result.slots.includes(selected) ? selected : null);
      } })
      .catch(() => { if (current) { setSlots([]); setTime(null); setNotice("No se pudieron cargar los horarios. Volvé a elegir el día."); } })
      .finally(() => { if (current) setSlotsLoading(false); });
    return () => { current = false; };
  }, [slug, serviceId, staffId, date, slotsVersion, overview, compatible]);

  const preserveDraft = () => {
    try { sessionStorage.setItem(draftKey(slug), JSON.stringify({ serviceId, staffId, date, time })); }
    catch { setNotice("No se pudo guardar la selección. Después de ingresar, volvé a elegir el horario."); }
  };

  const book = async (slot: string) => {
    if (!serviceId || !compatible || !date || !customer || submitting.current || slotsLoading || !slots.includes(slot)) return;
    submitting.current = true;
    setBooking(true);
    setNotice("");
    try {
      const result = await api<{ appointment: BookedAppointment }>(
        "POST", `/api/public/${slug}/book`,
        { service_id: serviceId, date, start_time: slot,
          ...(staffId !== null ? { staff_id: staffId } : {}) });
      setBooked(result.appointment);
      setTime(null);
      setSlots([]);
      try { sessionStorage.removeItem(draftKey(slug)); } catch { /* best effort */ }
    } catch (cause) {
      const status = (cause as { status?: number }).status;
      if (status === 401) {
        setCustomer(null);
        setNotice("Tu sesión venció. Iniciá sesión otra vez para confirmar.");
      } else if (status === 409 || status === 400) {
        setNotice(status === 409 ? "Ese horario ya no está disponible. Elegí otro, por favor." : "La selección ya no está disponible. Elegí nuevamente el servicio y el profesional.");
        setTime(null);
        setSlots([]);
        setSlotsVersion((version) => version + 1);
        api<PublicOverview>("GET", `/api/public/${slug}/overview`).then(setOverview).catch(() => {});
        try { sessionStorage.removeItem(draftKey(slug)); } catch { /* best effort */ }
      } else {
        setNotice((cause as Error).message || "No se pudo reservar. Probá de nuevo.");
        try { sessionStorage.removeItem(draftKey(slug)); } catch { /* best effort */ }
      }
    } finally { submitting.current = false; setBooking(false); }
  };

  const days = useMemo(() => {
    const start = today();
    return Array.from({ length: 14 }, (_, i) => shiftDate(start, i));
  }, []);

  if (phase === "loading") {
    return <div className="flex min-h-dvh items-center justify-center bg-background p-8 text-muted-foreground">Cargando...</div>;
  }
  if (phase === "notfound") {
    return <CleanScreen title="Agenda no disponible" body="Este enlace no corresponde a una agenda activa. Verificá con la empresa y volvé a intentarlo." />;
  }
  if (phase === "error") {
    return <CleanScreen title="No se pudo cargar la agenda" body="Ocurrió un problema de conexión. Probá de nuevo en un rato." />;
  }
  if (!overview) return null;

  // ── Success card: the only screen after a confirmed booking ──

  if (booked) {
    return (
      <div className="mx-auto max-w-md p-4 sm:p-8">
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-2xl">✓</div>
            <h1 className="text-xl font-bold">¡Turno confirmado!</h1>
            <StatusBadge status={booked.status} />
            <p className="font-mono text-lg">{booked.identifier}</p>
            <p className="text-sm text-muted-foreground">
              {formatDate(booked.scheduled_date, "long")} &middot; {booked.start_time} a {booked.end_time}
            </p>
            {service && <p className="text-sm text-muted-foreground">{service.name}</p>}
            <p className="text-xs text-muted-foreground">Guardá este código para cualquier cambio.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const schedule = bookingHours(overview.staff, { serviceId, staffId });
  const scheduleSubject = staffId !== null ? overview.staff.find((member) => member.id === staffId)?.name ?? "Profesional no disponible" :
    service ? `Profesionales que realizan ${service.name}` : "Profesionales con servicios para reserva pública";
  const hoursRows = DAY_LABELS.map(([key, label]) => {
    const intervals = dayIntervals(schedule.hours[key]);
    return { label, window: intervals.length ? intervals.map(([start, end]) => `${start} a ${end}`).join(" · ") : "Cerrado" };
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6 bg-background p-4 sm:p-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">{overview.company.name}</h1>
        <p className="text-sm text-muted-foreground">Reservá tu turno en tres pasos. Horarios en UTC.</p>
      </header>

      {notice && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm" role="alert">{notice}</div>
      )}
      {authFailed && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm" role="alert">
          No pudimos verificar tu cuenta de Google. Podés intentarlo de nuevo.
        </div>
      )}

      <fieldset disabled={booking} className="space-y-6">
      {/* Step 1 — service */}
      <section className="space-y-2">
        <h2 className="font-semibold">1. Elegí un servicio o un profesional</h2>
        <Button variant="outline" onClick={() => selectService(null)}>Ver todos los profesionales / Limpiar servicio</Button>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {overview.services.filter((svc) => staffId === null || overview.staff.some((member) => member.id === staffId && member.service_ids.includes(svc.id))).map((svc) => (
            <Card
              key={svc.id}
              role="button" tabIndex={booking ? -1 : 0} aria-pressed={serviceId === svc.id}
              onKeyDown={(event: KeyboardEvent) => { if (!booking && ["Enter", " "].includes(event.key)) {
                event.preventDefault(); selectService(svc.id);
              } }}
              onClick={() => { if (!booking) selectService(svc.id); }}
              className={cn("cursor-pointer transition-shadow hover:shadow-md",
                serviceId === svc.id && "border-primary ring-2 ring-ring/40")}
            >
              <CardContent className="flex items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <div className="truncate font-medium">{svc.name}</div>
                  <div className="text-xs text-muted-foreground">{svc.duration} min</div>
                </div>
                <div className="text-sm font-semibold">{formatMoney(svc.price)}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Professional selection is available even before choosing a service. */}
        <section className="space-y-4">

          {overview.staff.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Con quién</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-pressed={staffId === null}
                  className={cn(btnChip, staffId === null && "border-primary bg-primary/5 text-primary")}
                  onClick={() => selectStaff(null)}
                >Cualquiera</button>
                {overview.staff.filter((member) => serviceId === null || member.service_ids.includes(serviceId)).map((member) => (
                  <button
                    key={member.id} type="button"
                    aria-pressed={staffId === member.id}
                    className={cn(btnChip, staffId === member.id && "border-primary bg-primary/5 text-primary")}
                    onClick={() => selectStaff(member.id)}
                  >
                    <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: member.color }} />
                    {member.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {staffId !== null && !service && <p className="text-sm text-muted-foreground">Elegí uno de los servicios de este profesional. Si no hay servicios, todavía no recibe reservas públicas.</p>}
          {service && !overview.staff.some((member) => member.service_ids.includes(service.id)) &&
            <p role="status" className="text-sm text-muted-foreground">Este servicio todavía no tiene profesionales disponibles para reservas públicas.</p>}

          {service && compatible && <>
          <h2 className="font-semibold">2. Elegí día y horario</h2>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Día</p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {days.map((day) => {
                const d = parseDate(day);
                const dayLabel = fmtWeekday.format(d).replace(".", "");
                return (
                  <button
                    key={day} type="button" onClick={() => { setDate(day); setTime(null); setNotice(""); }}
                    className={cn(btnChip, "flex min-w-16 flex-col items-center gap-0.5 py-2",
                      date === day && "border-primary bg-primary text-primary-foreground hover:bg-primary/90")}
                  >
                    <span className="text-xs capitalize opacity-80">{dayLabel}</span>
                    <span className="text-base font-semibold">{d.getDate()}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <p className="text-sm font-medium">Horario{date ? "" : " (elegí un día primero)"}</p>
            {date === null ? null : slotsLoading ? (
              <p className="text-sm text-muted-foreground">Buscando horarios...</p>
            ) : slots.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin disponibilidad</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {slots.map((slot) => (
                  <button
                    key={slot} type="button"
                    className={cn(btnChip, time === slot && "border-primary bg-primary text-primary-foreground hover:bg-primary/90")}
                     disabled={booking}
                     onClick={() => { setTime(slot); setNotice(""); }}
                  >
                    {slot}
                  </button>
                ))}
              </div>
            )}
            {time && !customer && sessionChecked && (overview.google_sign_in ? <SignInPrompt slug={slug} time={time} preserveDraft={preserveDraft} /> :
              <p role="alert" className="text-sm">El inicio de sesión con Google todavía no está configurado. Contactá a la empresa para reservar.</p>)}
            {time && customer && <div className="space-y-2 rounded-md border p-3 text-sm">
              <h2 className="font-semibold">3. Confirmá tu turno</h2>
              <p>{service.name} · {formatDate(date!, "long")} · {time} · {formatMoney(service.price)}</p>
              <p>{staffId === null ? "Cualquier profesional disponible" : overview.staff.find((member) => member.id === staffId)?.name}</p>
              <p>Reservás como {customer.name || customer.email}. El turno quedará confirmado.</p>
              <Button disabled={booking || slotsLoading || !slots.includes(time)} onClick={() => void book(time)}>
                {booking ? "Confirmando..." : "Confirmar turno"}
              </Button>
            </div>}
          </div>
          </>}
        </section>
      </fieldset>

      {/* Recurring working hours, not date-specific appointment availability. */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Horarios de atención</CardTitle></CardHeader>
        <CardContent>
          <p className="mb-2 text-sm font-medium">{scheduleSubject}</p>
          <p className="mb-3 text-xs text-muted-foreground">Horarios semanales habituales en UTC. Los turnos disponibles para cada fecha tienen en cuenta las reservas y los bloqueos.</p>
          {schedule.candidateCount === 0 && <p role="status" className="mb-2 text-sm text-muted-foreground">No hay profesionales habilitados para esta selección.</p>}
          <ul className="divide-y text-sm">
            {hoursRows.map((row) => (
              <li key={row.label} className="flex justify-between py-1.5">
                <span className="text-muted-foreground">{row.label}</span>
                <span className={cn(row.window === "Cerrado" && "text-muted-foreground")}>{row.window}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

const btnChip = "rounded-full border border-border bg-background px-4 py-1.5 text-sm font-medium text-foreground transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function SignInPrompt({ slug, time, preserveDraft }: { slug: string; time: string; preserveDraft: () => void }) {
  return (
    <div className="mt-3 space-y-2 rounded-md border p-3 text-sm">
      <p>Para confirmar tu turno de las <span className="font-semibold">{time}</span>, primero iniciá sesión con tu cuenta de Google.</p>
      <Button asChild>
        <a href={`/api/auth/customer/google?slug=${encodeURIComponent(slug)}`} onClick={preserveDraft}>Continuar con Google</a>
      </Button>
      <p className="text-xs text-muted-foreground">Al volver, revisá la selección y confirmá el turno.</p>
    </div>
  );
}

function CleanScreen({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-8">
      <Card className="max-w-sm">
        <CardContent className="space-y-2 p-6 text-center">
          <h1 className="text-lg font-bold">{title}</h1>
          <p className="text-sm text-muted-foreground">{body}</p>
        </CardContent>
      </Card>
    </div>
  );
}
