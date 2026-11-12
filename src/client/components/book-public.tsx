/**
 * Public booking page for end customers at /book/{slug}.
 *
 * Lives entirely outside the tenant session gate: anyone opening the link can
 * sign in with Google before choosing a service and time (using the separate
 * `yt_book` customer cookie, never the tenant/staff session).
 * A pending selection survives the Google round-trip in sessionStorage so the
 * customer reviews and explicitly confirms after returning signed in.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "@/api";
import { customerPolicyMessages, type CustomerPolicyCode } from "../../shared/customer-policy";
import { contactPhone } from "../../shared/contact-phone";
import { shiftDate, today, parseDate } from "@/lib/dates";
import { formatDate, formatMoney } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { cn } from "@/lib/utils";
import { dayIntervals } from "./weekly-hours-editor";
import { compatibleSelection, chooseService, chooseStaff } from "../lib/booking-selection";
import { bookingHours, type ScheduledStaff } from "../lib/booking-hours";
import { CompanyPublicDetails } from "./company-public-details";
import { BookingPageFrame } from "./booking-page-frame";
import { ProfessionalAvatar } from "./professional-avatar";
import { CustomerBookings } from "./customer-bookings";
import { BookingCalendarAction } from "./booking-calendar-action";
import type { BookingCalendarContext } from "../lib/booking-calendar";
import { bookingDraftKey, bookingEndTime, bookingStep, readBookingDraft, validBookingService, type BookingStep } from "../lib/booking-wizard";

export interface PublicOverview {
  google_sign_in: boolean;
  allow_unverified_bookings?: boolean;
  company: import("../types").CompanyProfile & { slug: string };
  services: { id: number; name: string; duration: number; price: number }[];
  staff: (ScheduledStaff & { name: string; title: string; color: string; photo_url?: string | null })[];
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

type OverviewPhase = "loading" | "ready" | "notfound" | "error";

const DAY_LABELS: [string, string][] = [
  ["mon", "Lunes"], ["tue", "Martes"], ["wed", "Miércoles"], ["thu", "Jueves"],
  ["fri", "Viernes"], ["sat", "Sábado"], ["sun", "Domingo"],
];

const fmtWeekday = new Intl.DateTimeFormat("es-419", { weekday: "short" });

export function BookPublic({ slug, preview }: { slug: string; preview?: PublicOverview }) {
  const [phase, setPhase] = useState<OverviewPhase>(preview ? "ready" : "loading");
  const [loadedOverview, setOverview] = useState<PublicOverview | null>(null);
  const overview = preview ?? loadedOverview;
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [staffId, setStaffId] = useState<number | null>(null); // null = "Cualquiera"
  const [date, setDate] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [slots, setSlots] = useState<string[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [customer, setCustomer] = useState<CustomerSession | null>(null);
  const [sessionChecked, setSessionChecked] = useState(!!preview);
  const [booked, setBooked] = useState<(BookedAppointment & { calendarContext: BookingCalendarContext }) | null>(null);
  const [notice, setNotice] = useState("");
  const [authFailed] = useState(() => !preview && new URLSearchParams(window.location.search).get("auth") === "failed");
  const [finished, setFinished] = useState(() => !preview && typeof window !== "undefined" && new URLSearchParams(window.location.search).get("reserva") === "finalizada");
  const [confirmedName, setConfirmedName] = useState("");
  const submitting = useRef(false);
  const [booking, setBooking] = useState(false);
  const [slotsVersion, setSlotsVersion] = useState(0);
  const [requestedStep, setRequestedStep] = useState<BookingStep>(2);
  const [slotsKey, setSlotsKey] = useState("");
  const [sessionError, setSessionError] = useState(false);
  const [phone, setPhone] = useState("");
  const [guest, setGuest] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [eligibility, setEligibility] = useState<{ eligible: boolean; code: CustomerPolicyCode | null; message: string | null } | null>(null);
  const [eligibilityError, setEligibilityError] = useState(false);
  const [eligibilityVersion, setEligibilityVersion] = useState(0);
  const eligibilityRequest = useRef(0);
  const customerEpoch = useRef(0);
  const customerIdentity = useRef("");
  const logoutLock = useRef(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const agendaSummary = useRef<HTMLElement>(null);
  const agendaFocus = useRef(false);
  const [agendaFocusVersion, setAgendaFocusVersion] = useState(0);
  const [customerRoute, setCustomerRoute] = useState(() => {
    if (preview || typeof window === "undefined") return "";
    const route = new URLSearchParams(window.location.search).get("turnos") ?? "";
    return route === "lista" || /^\d+$/.test(route) ? route : "";
  });
  const [agendaOpen, setAgendaOpen] = useState(!!customerRoute);
  const [agendaMounted, setAgendaMounted] = useState(!!customerRoute);
  const writeCustomerRoute = (route: string, replace = false) => {
    if (preview) return;
    const url = new URL(window.location.href);
    if (route) url.searchParams.set("turnos", route); else url.searchParams.delete("turnos");
    window.history[replace ? "replaceState" : "pushState"](null, "", url);
  };
  const customerNavigate = (route: string) => {
    if (submitting.current || preview) return;
    writeCustomerRoute(route);
    if (route) { setCustomerRoute(route); setAgendaMounted(true); }
    setAgendaOpen(!!route);
    agendaFocus.current = true;
    setAgendaFocusVersion((version) => version + 1);
    if (!route && booked && !finished) customerChanged();
  };
  useEffect(() => {
    if (agendaFocus.current) {
      agendaSummary.current?.focus();
      agendaSummary.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      agendaFocus.current = false;
    }
  }, [agendaOpen, customerRoute, agendaFocusVersion]);
  useEffect(() => {
    if (preview) return;
    const back = () => {
      const value = new URLSearchParams(window.location.search).get("turnos") ?? "";
      const route = value === "lista" || /^\d+$/.test(value) ? value : "";
      if (route) { setCustomerRoute(route); setAgendaMounted(true); }
      setAgendaOpen(!!route);
    };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, [slug, preview]);
  const customerChanged = () => {
    setEligibility(null); setEligibilityVersion((version) => version + 1);
    requestVersion.current++; setTime(null); setSlots([]); setSlotsKey(""); setSlotsVersion((version) => version + 1);
    completed.current = finished; setBooked(null); setRequestedStep(2);
  };
  const clearCustomer = () => {
    customerEpoch.current++; sessionVersion.current++; eligibilityRequest.current++; requestVersion.current++;
    customerIdentity.current = "";
    setCustomer(null); setEligibility(null); setEligibilityError(false); setSessionError(false); setSessionChecked(true);
    setServiceId(null); setStaffId(null); setDate(null); setTime(null); setSlots([]); setSlotsKey(""); setSlotsLoading(false);
    setPhone(""); setBooked(null); setConfirmedName(""); completed.current = false; setRequestedStep(2);
    setGuest(false); setGuestName("");
    setAgendaOpen(false); setAgendaMounted(false); setCustomerRoute(""); setLogoutError("");
    focusRequested.current = true;
    if (!preview) {
      writeCustomerRoute("", true);
      try { sessionStorage.removeItem(bookingDraftKey(slug)); sessionStorage.removeItem(`yt.customer.intent:${slug}`); } catch { /* Best effort, scoped to this booking page. */ }
    }
  };
  const customerExpired = () => {
    clearCustomer();
    setNotice("Su sesión venció. Inicie sesión con Google para continuar con sus turnos.");
  };
  const logout = async () => {
    if (preview || logoutLock.current || submitting.current) return;
    logoutLock.current = true; setLoggingOut(true); setLogoutError("");
    // Invalidate session reads immediately, including a focus refresh already in flight.
    sessionVersion.current++;
    try {
      await api("POST", "/api/auth/customer/logout", {});
      clearCustomer(); setNotice("");
    } catch (cause) {
      if ((cause as { status?: number }).status === 401) customerExpired();
      else setLogoutError("No se pudo cerrar la sesión. Revise la conexión y vuelva a intentar.");
    } finally { logoutLock.current = false; setLoggingOut(false); }
  };
  useEffect(() => {
    setEligibility(null); setEligibilityError(false);
  }, [customer?.sub, customer?.email, slug, preview]);
  useEffect(() => {
    const version = ++eligibilityRequest.current;
    if (!customer || preview || submitting.current) return;
    api<NonNullable<typeof eligibility>>("GET", `/api/public/${slug}/eligibility`)
      .then((value) => { if (version === eligibilityRequest.current) { setEligibility(value); setEligibilityError(false); } })
      .catch((cause) => { if (version === eligibilityRequest.current) { setEligibility(null); if (cause.status === 401) customerExpired(); else setEligibilityError(true); } });
    return () => { eligibilityRequest.current++; };
  }, [customer?.sub, customer?.email, slug, eligibilityVersion, preview, agendaOpen]);
  useEffect(() => {
    if (!customer || preview) return;
    const visible = () => {
      if (document.visibilityState === "visible" && !submitting.current) setEligibilityVersion((version) => version + 1);
    };
    document.addEventListener("visibilitychange", visible);
    // A denied customer may stay on this tab while the company completes a visit.
    // Poll only this warning, quietly, while visible; never reset wizard selections.
    const timer = eligibility?.code === "CUSTOMER_ACTIVE_LIMIT" ? window.setInterval(visible, 30_000) : null;
    return () => { document.removeEventListener("visibilitychange", visible); if (timer !== null) window.clearInterval(timer); };
  }, [customer?.sub, customer?.email, slug, preview, eligibility?.code]);
  useEffect(() => { setPhone(""); }, [customer?.sub]);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusRequested = useRef(false);
  const requestVersion = useRef(0);
  const sessionVersion = useRef(0);
  const completed = useRef(false);
  const service = overview?.services.find((s) => s.id === serviceId) ?? null;
  const selectionKey = `${slug}:${serviceId}:${staffId}:${date}:${service?.duration}:${slotsVersion}`;
  const validService = !!overview && validBookingService(overview.services, overview.staff, { serviceId, staffId });
  const guestBooking = guest && !customer && !!overview?.allow_unverified_bookings;
  const step = bookingStep(requestedStep, !!customer || guestBooking, validService, date, time);
  const verifiedTime = !!time && slotsKey === selectionKey && !slotsLoading && slots.includes(time);
  const navigate = (next: BookingStep) => {
    if (submitting.current) return;
    focusRequested.current = true;
    setRequestedStep(next);
  };
  useEffect(() => {
    if (focusRequested.current) { heading.current?.focus(); focusRequested.current = false; }
  }, [step, booked, finished]);

  const checkSession = async () => {
    if (logoutLock.current) return;
    const version = ++sessionVersion.current;
    setSessionError(false);
    try {
      const result = await api<{ customer: CustomerSession }>("GET", "/api/auth/customer/session");
      if (version === sessionVersion.current) {
        const identity = `${result.customer.sub}:${result.customer.email}`;
        if (customerIdentity.current && customerIdentity.current !== identity) clearCustomer();
        customerIdentity.current = identity; setCustomer(result.customer); setGuest(false); setGuestName("");
      }
    } catch (cause) {
      if (version === sessionVersion.current) {
        if ((cause as { status?: number }).status === 401) { if (customerIdentity.current) customerExpired(); }
        else setSessionError(true);
      }
    }
    finally { if (version === sessionVersion.current) setSessionChecked(true); }
  };

  useEffect(() => {
    if (preview) return;
    let current = true;
    const refresh = () => {
      requestVersion.current++;
      setSlotsKey("");
      setSlotsVersion((version) => version + 1);
      setEligibilityVersion((version) => version + 1);
      void checkSession();
      api<PublicOverview>("GET", `/api/public/${slug}/overview`).then((value) => { if (current) setOverview(value); })
        .catch((cause) => { if (current && (cause as { status?: number }).status === 404) setPhase("notfound"); });
    };
    window.addEventListener("focus", refresh);
    return () => { current = false; sessionVersion.current++; window.removeEventListener("focus", refresh); };
  }, [slug]);

  const compatible = !!overview && compatibleSelection(overview.staff, { serviceId, staffId });
  const selectService = (id: number | null) => {
    if (!overview) return;
    const next = chooseService(overview.staff, { serviceId, staffId }, id);
    requestVersion.current++;
    setServiceId(next.serviceId); setStaffId(next.staffId); setDate(null); setTime(null); setSlots([]); setSlotsKey(""); setNotice("");
  };
  const selectStaff = (id: number | null) => {
    if (!overview) return;
    const next = chooseStaff(overview.staff, { serviceId, staffId }, id);
    requestVersion.current++;
    setServiceId(next.serviceId); setStaffId(next.staffId); setDate(null); setTime(null); setSlots([]); setSlotsKey(""); setNotice("");
  };

  // Revalidate restored OAuth intent and refreshed overview before confirmation.
  useEffect(() => {
    if (!overview) return;
    if ((serviceId !== null && (!service || !validService)) || !compatible) {
      requestVersion.current++;
      setServiceId(null); setStaffId(null); setDate(null); setTime(null); setSlots([]); setSlotsKey(""); setRequestedStep(2);
      setNotice("La selección ya no está disponible. Seleccione nuevamente el servicio y el profesional.");
    }
  }, [overview, serviceId, staffId]);

  // ── Boot: overview + customer session + resumed draft ──

  useEffect(() => {
    if (preview) return;
    let current = true;
    document.title = "Reservar turno";
    api<PublicOverview>("GET", `/api/public/${slug}/overview`)
      .then((value) => { if (current) setOverview(value); })
      .catch((cause) => { if (current) setPhase((cause as { status?: number }).status === 404 ? "notfound" : "error"); })
      .finally(() => { if (current) setPhase((prev) => (prev === "loading" ? "ready" : prev)); });
    void checkSession();

    if (finished) {
      try { sessionStorage.removeItem(bookingDraftKey(slug)); sessionStorage.removeItem(`yt.customer.intent:${slug}`); } catch { /* Best effort: never restore a finished wizard. */ }
      return () => { current = false; };
    }

    try {
      const key = `yt.customer.intent:${slug}`;
      const intent = sessionStorage.getItem(key);
      sessionStorage.removeItem(key);
      if (intent && (intent === "lista" || /^\d+$/.test(intent))) {
        const url = new URL(window.location.href); url.searchParams.set("turnos", intent);
        window.history.replaceState(null, "", url); setCustomerRoute(intent); setAgendaOpen(true); setAgendaMounted(true);
      }
    } catch { /* Navigation still works when storage is unavailable. */ }

    try {
      const draft = readBookingDraft(sessionStorage.getItem(bookingDraftKey(slug)), today(), shiftDate(today(), 13));
      if (draft) {
          setServiceId(draft.serviceId);
          setStaffId(draft.staffId);
          setDate(draft.date);
          setTime(draft.time);
          setRequestedStep(draft.step);
      }
    } catch { /* Corrupt drafts just mean starting over. */ }
    return () => { current = false; };
  }, [slug]);

  // ── Slots follow the chosen service + staff + date ──

  useEffect(() => {
    let current = true;
    const version = ++requestVersion.current;
    setSlots([]);
    setSlotsKey("");
    if ((!customer && !guestBooking) || !serviceId || !date || !validService || requestedStep < 3 || booked || finished) { setSlotsLoading(false); return; }
    if (preview) { setSlots(["10:00", "10:30", "11:00"]); setSlotsKey(selectionKey); setSlotsLoading(false); return; }
    const params = new URLSearchParams({ date, service_id: String(serviceId) });
    if (staffId !== null) params.set("staff_id", String(staffId));
    setSlotsLoading(true);
    api<{ slots: string[] }>("GET", `/api/public/${slug}/slots?${params}`)
      .then((result) => { if (current && version === requestVersion.current) {
        setSlots(result.slots);
        setSlotsKey(selectionKey);
        setTime((selected) => selected && result.slots.includes(selected) ? selected : null);
      } })
      .catch((cause) => { if (current && version === requestVersion.current) {
        setSlots([]);
        if ((cause as { status?: number }).status === 401 && customer) customerExpired();
        else { setTime(null); setNotice("No se pudieron cargar los horarios. Vuelva a intentar o seleccione otro día."); }
      } })
      .finally(() => { if (current && version === requestVersion.current) setSlotsLoading(false); });
    return () => { current = false; };
  }, [slug, serviceId, staffId, date, slotsVersion, overview, validService, customer, guestBooking, requestedStep >= 3, booked, finished]);

  const preserveDraft = () => {
    if (preview) return;
    try { sessionStorage.setItem(bookingDraftKey(slug), JSON.stringify({ serviceId, staffId, date, time, step: requestedStep })); }
    catch { /* Storage may be unavailable; booking still works without persistence. */ }
  };
  useEffect(() => {
    if (phase === "ready" && overview && sessionChecked && !booked && !finished && (customer || serviceId !== null)) preserveDraft();
  }, [serviceId, staffId, date, time, requestedStep, phase, overview, sessionChecked, booked, finished]);

  const finishBooking = () => {
    if (!booked || submitting.current) return;
    // Finish only the local receipt; the appointment and customer session stay intact.
    completed.current = true;
    requestVersion.current++;
    setFinished(true); setBooked(null); setConfirmedName(""); setRequestedStep(2);
    setServiceId(null); setStaffId(null); setDate(null); setTime(null);
    setSlots([]); setSlotsKey(""); setSlotsLoading(false); setPhone(""); setNotice("");
    focusRequested.current = true;
    if (!preview) {
      const url = new URL(window.location.href);
      url.searchParams.set("reserva", "finalizada");
      window.history.replaceState(null, "", url);
      try { sessionStorage.removeItem(bookingDraftKey(slug)); sessionStorage.removeItem(`yt.customer.intent:${slug}`); } catch { /* Optional temporary intent only. */ }
    }
  };

  const customerBookingNavigate = (route: string) => {
    // Only the agenda's explicit reserve actions may start a new wizard.
    if (!route && finished) {
      setFinished(false); completed.current = false;
      const url = new URL(window.location.href);
      url.searchParams.delete("reserva");
      window.history.replaceState(null, "", url);
      focusRequested.current = true;
    }
    customerNavigate(route);
  };

  const book = async (slot: string) => {
    if (!contactPhone(phone)) { setNotice("Ingrese un teléfono de contacto válido para confirmar."); return; }
    if (guestBooking && (guestName.trim().length < 2 || guestName.trim().length > 120)) { setNotice("Ingrese su nombre (entre 2 y 120 caracteres)."); return; }
    if (finished || logoutLock.current || (!guestBooking && !preview && !eligibility?.eligible) || step !== 4 || !serviceId || !validService || !date || (!customer && !guestBooking) || submitting.current || completed.current || !verifiedTime || slot !== time) return;
    submitting.current = true;
    const epoch = customerEpoch.current;
    eligibilityRequest.current++;
    setBooking(true);
    setNotice("");
    try {
      const result = preview ? { appointment: { id: -1, identifier: "EJEMPLO", scheduled_date: date, start_time: slot,
        end_time: bookingEndTime(slot, service!.duration), status: "confirmed" } } : await api<{ appointment: BookedAppointment }>(
        "POST", `/api/public/${slug}/book`,
        { service_id: serviceId, date, start_time: slot, contact_phone: contactPhone(phone),
          ...(guestBooking ? { guest_name: guestName.trim() } : {}),
          ...(staffId !== null ? { staff_id: staffId } : {}) });
      if (epoch !== customerEpoch.current) return;
      setConfirmedName(preview ? "Cliente de ejemplo" : guestBooking ? guestName.trim() : customer?.name?.trim() || "Cliente");
      setBooked({ ...result.appointment, calendarContext: { companyName: overview!.company.name,
        serviceName: service!.name, address: overview!.company.address } });
      completed.current = true;
      focusRequested.current = true;
      setTime(null);
      setSlots([]);
      if (!preview) try { sessionStorage.removeItem(bookingDraftKey(slug)); } catch { /* best effort */ }
    } catch (cause) {
      if (epoch !== customerEpoch.current) return;
      const status = (cause as { status?: number }).status;
      const code = (cause as { body?: { code?: CustomerPolicyCode } }).body?.code;
      if (code === "CUSTOMER_BLOCKED" || code === "CUSTOMER_ACTIVE_LIMIT") {
        eligibilityRequest.current++;
        setEligibility({ eligible: false, code, message: customerPolicyMessages[code] });
        setNotice("");
      } else if (status === 401 && customer) {
        customerExpired();
      } else if (status === 401) {
        setNotice("No se pudo confirmar sin verificación. Actualice la página y vuelva a intentar.");
      } else if (guestBooking && (status === 409 || status === 429 || status === 403)) {
        setNotice(status === 429 ? "Demasiados intentos. Vuelva a intentar más tarde o contacte a la empresa." :
          status === 403 ? "La reserva sin verificación ya no está disponible. Contacte a la empresa." :
            "No se pudo completar la reserva. El horario o los datos pueden no estar disponibles. Contacte a la empresa o elija otro horario.");
        setSlotsVersion((version) => version + 1);
      } else if (status === 409 || status === 400) {
        setNotice(status === 409 ? "Ese horario ya no está disponible. Seleccione otro para continuar." : "La selección ya no está disponible. Seleccione nuevamente el servicio y el profesional.");
        focusRequested.current = true;
        setRequestedStep(status === 409 ? 3 : 2);
        if (status === 400) { setServiceId(null); setStaffId(null); setDate(null); }
        setTime(null);
        setSlots([]);
        setSlotsVersion((version) => version + 1);
        api<PublicOverview>("GET", `/api/public/${slug}/overview`).then(setOverview).catch(() => {});
      } else {
        setNotice((cause as Error).message || "No se pudo reservar. Intente nuevamente.");
      }
    } finally { submitting.current = false; setBooking(false); }
  };

  const days = useMemo(() => {
    const start = today();
    return Array.from({ length: 14 }, (_, i) => shiftDate(start, i));
  }, []);

  if (phase === "loading" || (phase === "ready" && !sessionChecked)) {
    return <BookingPageFrame><div className="booking-page-content booking-loading mx-auto max-w-md"><div className="booking-panel p-8" role="status"><span className="booking-eyebrow">Su próxima visita</span><p>Cargando agenda…</p><div className="booking-skeleton" aria-hidden="true" /><div className="booking-skeleton" aria-hidden="true" /></div></div></BookingPageFrame>;
  }
  if (phase === "notfound") {
    return <CleanScreen title="Agenda no disponible" body="Este enlace no corresponde a una agenda activa. Verifique con la empresa y vuelva a intentarlo." />;
  }
  if (phase === "error") {
    return <CleanScreen title="No se pudo cargar la agenda" body="Ocurrió un problema de conexión. Vuelva a cargar la página para intentar nuevamente." />;
  }
  if (!overview) return null;

  const epoch = customerEpoch.current;
  const sessionIsCurrent = () => customerEpoch.current === epoch;
  const success = booked && (
      <div className="min-w-0">
        <Card>
          <CardContent className="booking-success flex flex-col items-center gap-3 p-5 text-center">
            <p className="booking-eyebrow">{overview.company.name}</p>
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-2xl">✓</div>
            <h1 ref={heading} tabIndex={-1} className="text-xl font-bold">{preview ? "Vista previa: turno de ejemplo" : "¡Turno confirmado!"}</h1>
            <p className="min-w-0 max-w-full break-words text-sm">Reserva a nombre de <span className="font-semibold">{confirmedName}</span></p>
            <StatusBadge status={booked.status} />
            <p className="font-mono text-lg">{booked.identifier}</p>
            <p className="text-sm text-muted-foreground">
              {formatDate(booked.scheduled_date, "long")} &middot; {booked.start_time} a {booked.end_time} · UTC
            </p>
            {service && <p className="text-sm text-muted-foreground">{service.name}</p>}
            <p className="text-xs text-muted-foreground">{preview ? "No se creó ninguna reserva." : "Guarde este código para cualquier cambio."}</p>
            <div className="flex w-full min-w-0 max-w-xs flex-col gap-2">
              <Button className="h-auto min-h-11 w-full whitespace-normal" onClick={finishBooking}>Cerrar</Button>
              <BookingCalendarAction appointment={booked} context={booked.calendarContext} preview={!!preview} />
               {!preview && customer && <Button variant="ghost" className="h-auto min-h-11 w-full whitespace-normal" onClick={() => customerNavigate("lista")}>Ver mis turnos</Button>}
               {guest && !customer && <p className="text-xs text-muted-foreground">Para consultar o cambiar este turno, contacte a la empresa. Este registro no permite acceder a Mis turnos.</p>}
            </div>
            {preview && <Button onClick={() => { completed.current = false; setBooked(null); setConfirmedName(""); setRequestedStep(2); focusRequested.current = true; }}>Volver a la vista previa</Button>}
          </CardContent>
        </Card>
      </div>
    );

  const schedule = bookingHours(overview.staff, { serviceId, staffId });
  const scheduleSubject = staffId !== null ? overview.staff.find((member) => member.id === staffId)?.name ?? "Profesional no disponible" :
    service ? `Profesionales que realizan ${service.name}` : "Profesionales con servicios para reserva pública";
  const hoursRows = DAY_LABELS.map(([key, label]) => {
    const intervals = dayIntervals(schedule.hours[key]);
    return { label, window: intervals.length ? intervals.map(([start, end]) => `${start} a ${end}`).join(" · ") : "Cerrado" };
  });

  return (
    <BookingPageFrame appearance={overview.company.appearance} preview={!!preview}>
    <div className="booking-page-content booking-layout mx-auto min-w-0" data-booking-step={step}>
      {preview && <p className="booking-preview-notice text-center text-sm font-medium">Vista previa interactiva · Datos ficticios · No se crean reservas</p>}
      <header className="booking-company-header" data-compact={step > 1 || undefined}>
        {step === 1 && overview.company.cover_url && <img src={overview.company.cover_url} alt="Portada de la empresa"
          className="booking-cover w-full object-cover object-center" />}
        <div className="booking-identity">
          <CompanyPublicDetails company={overview.company} preview={!!preview} identityOnly />
          <div className="min-w-0"><p className="booking-eyebrow">Reservas en línea</p>
          <h1>{overview.company.name}</h1></div>
        </div>
        {step === 1 && <div className="booking-welcome"><span className="booking-editorial-mark" aria-hidden="true">✳</span>
          <p className="booking-welcome-title">Un momento para usted.</p>
          {overview.company.appearance?.welcome && <p className="whitespace-pre-wrap break-words">{overview.company.appearance.welcome}</p>}
        </div>}
      </header>

      {customer && <div className="booking-customer-identity flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b py-2 text-sm">
        <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">Hola, <span className="font-semibold">{customer.name?.trim() || "Cliente"}</span></p>
        <Button variant="ghost" className="min-h-11 shrink-0" disabled={!!preview || loggingOut || booking} onClick={() => void logout()}>{loggingOut ? "Cerrando sesión…" : "Cerrar sesión"}</Button>
        {logoutError && <p className="w-full" role="alert">{logoutError}</p>}
        {sessionError && <div className="w-full space-y-2" role="alert"><p>No se pudo verificar su sesión. Revise la conexión y vuelva a intentar.</p>
          <Button variant="outline" disabled={loggingOut} onClick={() => void checkSession()}>Reintentar verificación</Button></div>}
      </div>}
      {success}
      {finished && <Card>
        <CardContent className="booking-success flex min-w-0 flex-col items-center gap-3 p-5 text-center">
          <p className="booking-eyebrow">{overview.company.name}</p>
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-2xl" aria-hidden="true">✓</div>
          <h1 ref={heading} tabIndex={-1} className="text-xl font-bold">Todo listo</h1>
          <p className="text-sm">{preview ? "Finalizó la reserva de ejemplo. No se creó ningún turno." : "Su reserva quedó confirmada."}</p>
          <p className="text-sm text-muted-foreground">Puede cerrar esta pestaña.</p>
          {!preview && customer && <Button variant="outline" className="h-auto min-h-11 max-w-full whitespace-normal" onClick={() => customerNavigate("lista")}>Ver mis turnos</Button>}
        </CardContent>
      </Card>}
      {!booked && !finished && <>
      <nav aria-label="Progreso de la reserva" className="booking-progress">
        <ol className="flex gap-2" aria-label={`Paso ${step} de 4`}>
          {(["Ingreso", "Servicio", "Horario", "Confirmación"] as const).map((label, index) =>
            <li key={label} className="min-w-0 flex-1" aria-current={step === index + 1 ? "step" : undefined}>
              <span className="booking-progress-line" data-complete={step >= index + 1 || undefined} />
              <span className="sr-only">{index + 1}. {label}</span>
            </li>)}
        </ol>
        <p className="font-medium" aria-hidden="true"><span className="booking-step-number">0{step} / 04</span> {step === 1 ? "Ingreso" : step === 2 ? "Servicio y profesional" : step === 3 ? "Día y horario" : "Confirmación"}</p>
      </nav>

      {notice && (
        <div className="booking-notice booking-panel rounded-md border p-3 text-sm" role="alert">{notice}</div>
      )}
      {customer && !preview && (eligibilityError || eligibility?.eligible === false || eligibility?.message) && <div id="booking-eligibility" className="booking-notice booking-panel space-y-3 rounded-md border p-3 text-sm" role={eligibility?.eligible ? "status" : "alert"}>
        <p>{eligibilityError ? "No se pudo verificar si puede reservar. Vuelva a intentar antes de confirmar." : eligibility?.code === "CUSTOMER_ACTIVE_LIMIT" ? customerPolicyMessages.CUSTOMER_ACTIVE_LIMIT : eligibility?.message ?? "Verificando si puede reservar…"}</p>
        {eligibility?.eligible === false && <>
          <Button onClick={() => customerNavigate("lista")}>Ver mis turnos</Button>
        </>}
        {eligibilityError && <Button variant="outline" onClick={() => setEligibilityVersion((version) => version + 1)}>Reintentar verificación</Button>}
      </div>}
      {authFailed && step === 1 && (
        <div className="booking-notice booking-panel rounded-md border p-3 text-sm" role="alert">
          No se pudo verificar su cuenta de Google. Vuelva a intentar con el botón de ingreso.
        </div>
      )}

      <section key={step} className="booking-wizard-screen booking-step booking-panel space-y-4" aria-labelledby="booking-step-title">
        <h2 id="booking-step-title" ref={heading} tabIndex={-1} className="text-lg font-semibold">
          {step === 1 ? "Su turno empieza aquí" : step === 2 ? "¿Qué le gustaría reservar?" : step === 3 ? "Encuentre su momento" : "Todo listo para su visita"}
        </h2>
        {step === 1 && <div className="space-y-4 text-sm">
           <p>{overview.google_sign_in ? `Inicie sesión con Google para elegir su turno en ${overview.company.name}.` : `Elija cómo reservar en ${overview.company.name}.`}</p>
          {sessionError ? <div role="alert" className="space-y-2">
            <p>No se pudo verificar su sesión. Revise la conexión y vuelva a intentar.</p>
            <Button variant="outline" onClick={() => void checkSession()}>Reintentar verificación</Button>
          </div> : preview ? <Button className="booking-google h-auto min-h-11 max-w-full whitespace-normal" onClick={() => {
            setCustomer({ sub: "preview", name: "Cliente de ejemplo", email: "ejemplo@example.invalid" }); navigate(requestedStep);
          }}><span className="booking-google-symbol" aria-hidden="true">G</span>Simular ingreso con Google</Button> : overview.google_sign_in ? <Button className="booking-google h-auto min-h-11 max-w-full whitespace-normal" asChild>
            <a href={`/api/auth/customer/google?slug=${encodeURIComponent(slug)}`} onClick={() => {
              preserveDraft();
              if (customerRoute) try { sessionStorage.setItem(`yt.customer.intent:${slug}`, customerRoute); } catch { /* Optional return intent. */ }
            }}><span className="booking-google-symbol" aria-hidden="true">G</span>Continuar con Google</a>
           </Button> : <p role="alert">El ingreso con Google aún no está configurado.{!overview.allow_unverified_bookings && " Contacte a la empresa para reservar."}</p>}
           {overview.allow_unverified_bookings && <div className="space-y-2 border-t pt-4">
             <Button variant="outline" className="min-h-11" onClick={() => { setGuest(true); navigate(2); }}>Reservar sin verificación</Button>
             <p className="text-muted-foreground">Podrá crear un turno con su nombre y teléfono. El número no se verifica y no tendrá acceso a Mis turnos ni podrá cancelar o reprogramar en línea. Para cambios, contacte a la empresa.</p>
           </div>}
          <p className="text-xs">Luego podrá elegir su servicio y horario. La reserva solo se crea al confirmar el último paso.</p>
          {overview.company.phone && <p>Teléfono: {overview.company.phone}</p>}
          {overview.company.public_email && <p>Correo electrónico: {overview.company.public_email}</p>}
        </div>}
      <fieldset disabled={booking} className="min-w-0 w-full space-y-4" hidden={step === 1}>
      <legend className="sr-only">{step === 2 ? "Servicio y profesional" : step === 3 ? "Fecha y horario" : "Confirmación de la reserva"}</legend>
      {step === 2 && <>
         <div className="booking-section-label"><p>Servicio</p><Button className="booking-clear h-auto min-h-11 max-w-full whitespace-normal" variant="outline" onClick={() => selectService(null)}>Ver todos / Limpiar</Button></div>
         <div role="group" aria-label="Servicios disponibles" className="booking-service-list min-w-0">
          {overview.services.filter((svc) => staffId === null || overview.staff.some((member) => member.id === staffId && member.service_ids.includes(svc.id))).map((svc) => (
            <Card
              key={svc.id}
              role="button" tabIndex={booking ? -1 : 0} aria-pressed={serviceId === svc.id}
              onKeyDown={(event: KeyboardEvent) => { if (!booking && ["Enter", " "].includes(event.key)) {
                event.preventDefault(); selectService(svc.id);
              } }}
              onClick={() => { if (!booking) selectService(svc.id); }}
              className={cn("booking-service min-w-0 cursor-pointer",
                serviceId === svc.id && "border-primary ring-2 ring-ring/40")}
            >
              <CardContent className="booking-service-content min-w-0">
                <span className="booking-selection-mark" aria-hidden="true">{serviceId === svc.id ? "✓" : "+"}</span>
                <div className="min-w-0 max-w-full">
                  <div className="font-medium">{svc.name}</div>
                  <div className="text-xs text-muted-foreground">{svc.duration} min</div>
                </div>
                <div className="booking-service-price min-w-0 max-w-full text-sm font-semibold">{formatMoney(svc.price)}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      {/* Professional selection is available even before choosing a service. */}
          {overview.staff.length > 0 && (
            <div className="space-y-1.5">
            <p className="booking-section-label text-sm font-medium">Profesional <span className="booking-optional">Elija o deje que asignemos uno</span></p>
              <div role="group" aria-label="Profesionales disponibles" className="flex flex-wrap gap-2">
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
                    <ProfessionalAvatar src={member.photo_url} />
                    <span className="min-w-0 [overflow-wrap:anywhere]">{member.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
           {staffId !== null && !service && <p className="text-sm text-muted-foreground">Seleccione uno de los servicios de este profesional. Si no hay servicios, todavía no recibe reservas públicas.</p>}
          {service && !overview.staff.some((member) => member.service_ids.includes(service.id)) &&
            <p role="status" className="text-sm text-muted-foreground">Este servicio todavía no tiene profesionales disponibles para reservas públicas.</p>}

           <p id="booking-service-help" className="text-sm" aria-live="polite">{validService ? "Puede continuar para elegir un horario." : "Seleccione un servicio con un profesional disponible para continuar."}</p>
            <div className="booking-actions flex flex-wrap gap-2">
             {preview && <Button variant="outline" onClick={() => { setCustomer(null); navigate(2); }}>Ver ingreso de ejemplo</Button>}
             <Button disabled={!validService} aria-describedby="booking-service-help" onClick={() => { if (validService) navigate(3); }}>Continuar</Button>
           </div>
      </>}

      {step === 3 && service && <>
            <div className="booking-selection-context"><p>{service.name}</p><p className="text-sm">{service.duration} min · {formatMoney(service.price)} · {staffId === null ? "Cualquier profesional disponible" : overview.staff.find((member) => member.id === staffId)?.name}</p></div>
          <div className="space-y-1.5">
            <div className="booking-section-label"><p>Día</p><span className="booking-optional" aria-hidden="true">Deslice para ver más →</span></div>
            <div className="booking-day-strip flex min-w-0 max-w-full gap-2 overflow-x-auto overscroll-x-contain p-1" role="group" aria-label="Días disponibles" tabIndex={0}>
              {days.map((day) => {
                const d = parseDate(day);
                const dayLabel = fmtWeekday.format(d).replace(".", "");
                return (
                  <button
                    key={day} type="button" aria-pressed={date === day} aria-label={formatDate(day, "long")}
                     onClick={() => { requestVersion.current++; setDate(day); setTime(null); setSlots([]); setSlotsKey(""); setNotice(""); setSlotsVersion((version) => version + 1); }}
                    className={cn(btnChip, "booking-day h-16 w-16 shrink-0 flex-col gap-0.5 p-2",
                      date === day && "border-primary bg-primary text-primary-foreground hover:bg-primary/90")}
                  >
                    <span className="text-xs capitalize opacity-80">{dayLabel}</span>
                    <span className="text-base font-semibold">{d.getDate()}</span>
                    <span className="booking-day-month">{d.toLocaleDateString("es-419", { month: "short" }).replace(".", "")}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
             <p className="booking-section-label text-sm font-medium">Horario{date ? "" : " (seleccione un día primero)"} <span className="booking-optional">UTC</span></p>
            {date === null ? null : slotsLoading ? (
               <p role="status" className="text-sm text-muted-foreground">Buscando horarios...</p>
            ) : slots.length === 0 ? (
               <div className="space-y-2"><p role="status" className="text-sm text-muted-foreground">Sin horarios disponibles. Seleccione otro día o vuelva a intentar.</p>
                 <Button variant="outline" onClick={() => setSlotsVersion((version) => version + 1)}>Actualizar horarios</Button></div>
            ) : (
              <div className="booking-time-grid">
                {slots.map((slot) => (
                  <button
                     key={slot} type="button"
                     aria-pressed={time === slot}
                    className={cn(btnChip, time === slot && "border-primary bg-primary text-primary-foreground hover:bg-primary/90")}
                     disabled={booking}
                     onClick={() => { setTime(slot); setNotice(""); }}
                  >
                    {slot}
                  </button>
                ))}
              </div>
            )}
           </div>
           <p id="booking-time-help" className="text-sm" aria-live="polite">{verifiedTime ? `${time} a ${bookingEndTime(time!, service.duration)} · ${service.duration} min` : "Seleccione un día y un horario disponible para continuar."}</p>
           <div className="booking-actions flex flex-wrap gap-2">
             <Button variant="outline" onClick={() => navigate(2)}>Atrás</Button>
             <Button disabled={!verifiedTime} aria-describedby="booking-time-help" onClick={() => { if (verifiedTime) navigate(4); }}>Continuar</Button>
           </div>
      </>}

      {step === 4 && service && date && time && (customer || guestBooking) && <div className="space-y-4 text-sm">
        <dl className="booking-summary space-y-3">
          <div><dt>Servicio</dt><dd>{service.name}</dd></div>
          <div><dt>Profesional</dt><dd>{staffId === null ? "Cualquier profesional disponible" : overview.staff.find((member) => member.id === staffId)?.name}</dd></div>
          <div><dt>Fecha</dt><dd>{formatDate(date, "long")}</dd></div>
          <div><dt>Horario (UTC)</dt><dd>{time} a {bookingEndTime(time, service.duration)} · {service.duration} min</dd></div>
          <div><dt>Total</dt><dd>{formatMoney(service.price)}</dd></div>
           <div><dt>Reserva a nombre de</dt><dd>{guestBooking ? guestName.trim() || "Complete su nombre abajo" : customer!.name || customer!.email}</dd></div>
        </dl>
         {guestBooking && <label className="block space-y-2 font-medium" htmlFor="booking-guest-name">Nombre y apellido
           <input id="booking-guest-name" className="w-full min-w-0 rounded-md border bg-background p-3 font-normal" type="text" autoComplete="name" maxLength={120} required value={guestName}
             onInput={(event) => setGuestName(event.currentTarget.value)} />
         </label>}
         <div className="space-y-2">
          <label className="block font-medium" htmlFor="booking-contact-phone">Teléfono de contacto</label>
          <input id="booking-contact-phone" className="w-full min-w-0 rounded-md border bg-background p-3" type="tel" autoComplete="tel"
            value={phone} maxLength={40} required aria-invalid={!!phone && !contactPhone(phone)} aria-describedby="booking-phone-help" onInput={(event) => setPhone(event.currentTarget.value)} />
           <p id="booking-phone-help">La empresa usará este número para contactarle manualmente sobre su turno. No se envían mensajes automáticos.</p>
          {phone && !contactPhone(phone) && <p role="status">Use entre 7 y 15 dígitos, con + al inicio si corresponde. Puede incluir espacios, paréntesis o guiones.</p>}
        </div>
        <p id="booking-confirm-help" aria-live="polite">{booking ? "Confirmando su turno…" : verifiedTime ? (preview ? "Vista previa: la confirmación es ficticia y no crea una reserva." : "Revise los datos. Su turno se creará solo al confirmar.") : "Verificando disponibilidad. Si el horario ya no está disponible, seleccione otro."}</p>
        <div className="booking-actions flex flex-wrap gap-2">
          <Button variant="outline" disabled={booking} onClick={() => navigate(3)}>Atrás</Button>
           <Button disabled={booking || !verifiedTime || !contactPhone(phone) || (guestBooking ? guestName.trim().length < 2 : !preview && !eligibility?.eligible)} aria-describedby="booking-confirm-help booking-phone-help booking-eligibility" onClick={() => void book(time)}>{booking ? "Confirmando..." : "Confirmar turno"}</Button>
        </div>
      </div>}
      </fieldset>
      </section>
      </>}

      {customer && <details className="booking-business-info min-w-0" open={agendaOpen}
        onToggle={(event) => {
          const open = event.currentTarget.open;
          if (open !== agendaOpen) {
            if (preview) setAgendaOpen(open);
            else customerNavigate(open ? customerRoute || "lista" : "");
          }
        }} onKeyDown={(event) => {
          if (event.key === "Escape" && agendaOpen) { event.stopPropagation(); if (preview) setAgendaOpen(false); else customerNavigate(""); }
        }}>
        <summary ref={agendaSummary} className="min-h-11 cursor-pointer py-3 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.currentTarget.click(); }
          }} onClick={(event) => {
            // Commit the disclosure state before asynchronous eligibility renders;
            // native toggle events arrive later and can otherwise lose keyboard input.
            event.preventDefault();
            if (preview) setAgendaOpen(!agendaOpen);
            else customerNavigate(agendaOpen ? "" : customerRoute || "lista");
          }}>Mis turnos</summary>
        {preview ? <p className="py-3 text-sm">Vista previa · No hay turnos reales para consultar.</p> : agendaMounted &&
          <CustomerBookings key={`${slug}:${customer.sub}:${customer.email}:${epoch}`} slug={slug} route={customerRoute || "lista"}
            navigate={(route) => { if (sessionIsCurrent()) customerBookingNavigate(route); }} isCurrent={sessionIsCurrent}
            onChanged={() => { if (sessionIsCurrent()) customerChanged(); }} onExpired={() => { if (sessionIsCurrent()) customerExpired(); }} />}
      </details>}

      {/* Recurring working hours, not date-specific appointment availability. */}
      <details className="booking-business-info">
        <summary className="min-h-11 cursor-pointer py-3 font-medium">Información del negocio</summary>
        <CompanyPublicDetails company={overview.company} preview={!!preview} hideLogo />
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
      </details>
    </div>
    </BookingPageFrame>
  );
}

const btnChip = "inline-flex min-h-11 min-w-0 max-w-full items-center justify-center gap-2 whitespace-normal rounded-full border border-border bg-background px-4 py-1.5 text-sm font-medium text-foreground transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function CleanScreen({ title, body }: { title: string; body: string }) {
  return (
    <BookingPageFrame><div className="booking-page-content mx-auto flex min-h-dvh max-w-md items-center justify-center">
      <Card className="max-w-sm">
        <CardContent className="space-y-2 p-6 text-center">
          <h1 className="text-lg font-bold">{title}</h1>
          <p className="text-sm text-muted-foreground">{body}</p>
        </CardContent>
      </Card>
    </div></BookingPageFrame>
  );
}
