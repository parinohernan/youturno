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
import { LegalLinks } from "./legal-pages";
import { CompanyPublicDetails } from "./company-public-details";
import { BookingPageFrame } from "./booking-page-frame";

export interface PublicOverview {
  google_sign_in: boolean;
  company: import("../types").CompanyProfile & { slug: string };
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

export function BookPublic({ slug, preview }: { slug: string; preview?: PublicOverview }) {
  const [phase, setPhase] = useState<OverviewPhase>(preview ? "ready" : "loading");
  const [loadedOverview, setOverview] = useState<PublicOverview | null>(null);
  const overview = preview ?? loadedOverview;
  const [serviceId, setServiceId] = useState<number | null>(preview?.services[0]?.id ?? null);
  const [staffId, setStaffId] = useState<number | null>(null); // null = "Cualquiera"
  const [date, setDate] = useState<string | null>(preview ? today() : null);
  const [time, setTime] = useState<string | null>(preview ? "10:00" : null);
  const [slots, setSlots] = useState<string[]>(preview ? ["10:00", "10:30", "11:00"] : []);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [customer, setCustomer] = useState<CustomerSession | null>(null);
  const [sessionChecked, setSessionChecked] = useState(!!preview);
  const [booked, setBooked] = useState<BookedAppointment | null>(null);
  const [notice, setNotice] = useState("");
  const [authFailed] = useState(() => !preview && new URLSearchParams(window.location.search).get("auth") === "failed");
  const submitting = useRef(false);
  const [booking, setBooking] = useState(false);
  const [slotsVersion, setSlotsVersion] = useState(0);

  useEffect(() => {
    if (preview) return;
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
    if (preview) return;
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
    if (preview) return;
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
    if (preview) return;
    try { sessionStorage.setItem(draftKey(slug), JSON.stringify({ serviceId, staffId, date, time })); }
    catch { setNotice("No se pudo guardar la selección. Después de ingresar, volvé a elegir el horario."); }
  };

  const book = async (slot: string) => {
    if (preview) return;
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
    return <BookingPageFrame><div className="booking-page-content mx-auto max-w-md"><div className="booking-panel p-8" role="status">Cargando...</div></div></BookingPageFrame>;
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
      <BookingPageFrame appearance={overview.company.appearance}>
      <div className="booking-page-content mx-auto max-w-md">
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
        <div className="mt-4"><LegalLinks /></div>
      </div>
      </BookingPageFrame>
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
    <BookingPageFrame appearance={overview.company.appearance} preview={!!preview}>
    <div className="booking-page-content mx-auto min-w-0 max-w-2xl space-y-6">
      <header className="booking-company-header booking-panel space-y-3">
        {overview.company.cover_url && <img src={overview.company.cover_url} alt="Portada de la empresa"
          className="mb-4 aspect-[3/1] w-full rounded-lg object-cover object-center" />}
        <h1 className="text-center text-2xl font-bold tracking-tight">{overview.company.name}</h1>
        <CompanyPublicDetails company={overview.company} preview={!!preview} />
        {overview.company.appearance?.welcome && <p className="whitespace-pre-wrap break-words py-2">{overview.company.appearance.welcome}</p>}
        <p className="text-sm text-muted-foreground">Reservá tu turno en tres pasos. Horarios en UTC.</p>
        <LegalLinks />
      </header>

      {notice && (
        <div className="booking-panel rounded-md border p-3 text-sm" role="alert">{notice}</div>
      )}
      {authFailed && (
        <div className="booking-panel rounded-md border p-3 text-sm" role="alert">
          No pudimos verificar tu cuenta de Google. Podés intentarlo de nuevo.
        </div>
      )}

      <fieldset disabled={booking || !!preview} className="min-w-0 w-full space-y-6">
      {/* Step 1 — service */}
      <section className="booking-step booking-panel space-y-4">
        <h2 className="font-semibold">1. Elegí un servicio o un profesional</h2>
        <Button className="h-auto min-h-11 max-w-full whitespace-normal" variant="outline" onClick={() => selectService(null)}>Ver todos los profesionales / Limpiar servicio</Button>
        <div className="grid min-w-0 gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}>
          {overview.services.filter((svc) => staffId === null || overview.staff.some((member) => member.id === staffId && member.service_ids.includes(svc.id))).map((svc) => (
            <Card
              key={svc.id}
              role="button" tabIndex={booking ? -1 : 0} aria-pressed={serviceId === svc.id}
              onKeyDown={(event: KeyboardEvent) => { if (!booking && ["Enter", " "].includes(event.key)) {
                event.preventDefault(); selectService(svc.id);
              } }}
              onClick={() => { if (!booking) selectService(svc.id); }}
              className={cn("min-w-0 cursor-pointer transition-shadow hover:shadow-md",
                serviceId === svc.id && "border-primary ring-2 ring-ring/40")}
            >
              <CardContent className="flex h-full min-w-0 flex-col items-start gap-3 p-4">
                <div className="min-w-0 max-w-full">
                  <div className="font-medium">{svc.name}</div>
                  <div className="text-xs text-muted-foreground">{svc.duration} min</div>
                </div>
                <div className="mt-auto min-w-0 max-w-full text-sm font-semibold">{formatMoney(svc.price)}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Professional selection is available even before choosing a service. */}
        <section className="booking-step booking-panel space-y-4">

          {overview.staff.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Con quién</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-pressed={staffId === null}
                  className={cn(btnChip, staffId === null && "border-primary bg-primary text-primary-foreground")}
                  onClick={() => selectStaff(null)}
                >Cualquiera</button>
                {overview.staff.filter((member) => serviceId === null || member.service_ids.includes(serviceId)).map((member) => (
                  <button
                    key={member.id} type="button"
                    aria-pressed={staffId === member.id}
                    className={cn(btnChip, staffId === member.id && "border-primary bg-primary text-primary-foreground")}
                    onClick={() => selectStaff(member.id)}
                  >
                    <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: member.color }} />
                    <span className="min-w-0">{member.name}</span>
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
            <div className="flex min-w-0 max-w-full gap-2 overflow-x-auto overscroll-x-contain p-1" role="group" aria-label="Días disponibles" tabIndex={0}>
              {days.map((day) => {
                const d = parseDate(day);
                const dayLabel = fmtWeekday.format(d).replace(".", "");
                return (
                  <button
                    key={day} type="button" aria-pressed={date === day} aria-label={formatDate(day, "long")}
                    onClick={() => { setDate(day); setTime(null); setNotice(""); }}
                    className={cn(btnChip, "h-16 w-16 shrink-0 flex-col gap-0.5 p-2",
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
             {time && !customer && sessionChecked && (overview.google_sign_in ? <SignInPrompt slug={slug} time={time} preserveDraft={preserveDraft} preview={!!preview} /> :
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
              <li key={row.label} className="flex flex-wrap justify-between gap-x-3 gap-y-1 py-1.5">
                <span className="min-w-0 text-muted-foreground">{row.label}</span>
                <span className={cn("min-w-0", row.window === "Cerrado" && "text-muted-foreground")}>{row.window}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
    </BookingPageFrame>
  );
}

const btnChip = "inline-flex min-h-11 min-w-0 max-w-full items-center justify-center gap-2 whitespace-normal rounded-full border border-border bg-background px-4 py-1.5 text-sm font-medium text-foreground transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function SignInPrompt({ slug, time, preserveDraft, preview = false }: { slug: string; time: string; preserveDraft: () => void; preview?: boolean }) {
  return (
    <div className="mt-3 space-y-2 rounded-md border p-3 text-sm">
      <p>Para confirmar tu turno de las <span className="font-semibold">{time}</span>, primero iniciá sesión con tu cuenta de Google.</p>
      {preview ? <Button className="h-auto min-h-11 max-w-full whitespace-normal" disabled aria-label="Continuar con Google (no disponible en vista previa)">Continuar con Google</Button> : <Button className="h-auto min-h-11 max-w-full whitespace-normal" asChild>
        <a href={`/api/auth/customer/google?slug=${encodeURIComponent(slug)}`} onClick={preserveDraft}>Continuar con Google</a>
      </Button>}
      <p className="text-xs text-muted-foreground">Al volver, revisá la selección y confirmá el turno.</p>
      <LegalLinks />
    </div>
  );
}

function CleanScreen({ title, body }: { title: string; body: string }) {
  return (
    <BookingPageFrame><div className="booking-page-content mx-auto flex min-h-dvh max-w-md items-center justify-center">
      <Card className="max-w-sm">
        <CardContent className="space-y-2 p-6 text-center">
          <h1 className="text-lg font-bold">{title}</h1>
          <p className="text-sm text-muted-foreground">{body}</p>
          <LegalLinks />
        </CardContent>
      </Card>
    </div></BookingPageFrame>
  );
}
