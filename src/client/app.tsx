import { reportLocation } from "@clawnify/app/client";
import { useEffect, useMemo, useState } from "preact/hooks";
import { api, setCsrfToken } from "./api";
import { AppContext } from "./context";
import { useAppState } from "./hooks/use-app";
import { useRouter } from "./hooks/use-router";
import { Sidebar } from "./components/sidebar";
import { Dashboard } from "./components/dashboard";
import { CalendarView } from "./components/calendar-view";
import { AppointmentList } from "./components/appointment-list";
import { AppointmentDetail } from "./components/appointment-detail";
import { ClientList } from "./components/client-list";
import { ClientDetail } from "./components/client-detail";
import { StaffList } from "./components/staff-list";
import { ServiceList } from "./components/service-list";
import { ProductList } from "./components/product-list";
import { ErrorBanner } from "./components/error-banner";
import { BookPublic } from "./components/book-public";

type Session = { email: string; role: "superadmin" | "tenant"; company_id: number | null;
  company_name: string | null; company_status: string | null; csrf: string };

/** /book/{slug} — public booking lives outside the tenant session gate. */
function publicBookingSlug(): string | null {
  const match = window.location.pathname.match(/^\/book\/([a-z0-9-]+)\/?$/);
  return match ? match[1] : null;
}

export function App() {
  const bookingSlug = publicBookingSlug();
  return bookingSlug ? <BookPublic key={bookingSlug} slug={bookingSlug} /> : <StaffApp />;
}

function StaffApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refresh = async () => {
    try {
      const current = await api<Session>("GET", "/api/auth/session");
      setCsrfToken(current.csrf);
      setSession(current);
    } catch (cause) {
      setCsrfToken(null);
      setSession(null);
      if ((cause as { status?: number }).status !== 401) setError((cause as Error).message);
    } finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);
  const logout = async () => {
    try { await api("POST", "/api/auth/logout", {}); } catch { /* Clear local state even if already revoked. */ }
    setCsrfToken(null);
    setSession(null);
  };
  if (loading) return <div className="p-8">Cargando...</div>;
  if (!session) return <main className="mx-auto max-w-sm space-y-4 p-8">
    <h1 className="text-2xl font-bold">Ingresar a Youturno</h1>
    <form className="space-y-4" onSubmit={async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      try {
        const response = await api<{ csrf: string }>("POST", "/api/auth/login", {
          email: data.get("email"), password: data.get("password"),
        });
        setCsrfToken(response.csrf); setError(""); await refresh();
      } catch (cause) { setError((cause as Error).message); }
    }}>
      <label className="block">Correo electrónico<input className="w-full rounded border p-2" name="email" type="email" autoComplete="username" required /></label>
      <label className="block">Contraseña<input className="w-full rounded border p-2" name="password" type="password" autoComplete="current-password" required /></label>
      <button className="rounded bg-violet-700 px-4 py-2 text-white" type="submit">Ingresar</button>
    </form>{error && <p role="alert">{error}</p>}
  </main>;
  if (session.role === "superadmin") return <AdminPanel session={session} refresh={refresh} logout={logout} />;
  if (!session.company_id) return <main className="mx-auto max-w-sm space-y-4 p-8">
    <h1 className="text-xl font-bold">Configurar empresa</h1>
    <form onSubmit={async (event) => {
      event.preventDefault();
      const name = new FormData(event.currentTarget).get("name");
      try { await api("POST", "/api/onboarding/company", { name }); await refresh(); }
      catch (cause) { setError((cause as Error).message); }
    }}><input className="w-full rounded border p-2" name="name" placeholder="Nombre de la empresa" required minLength={2} />
      <button className="mt-4 rounded bg-violet-700 px-4 py-2 text-white">Crear empresa</button></form>
    {error && <p role="alert">{error}</p>}<button onClick={logout}>Salir</button>
  </main>;
  if (session.company_status !== "active") return <main className="p-8">
    <h1 className="text-xl font-bold">{session.company_status === "pending" ? "Esperando activación" : "Empresa desactivada"}</h1>
    <p>Contactá al administrador de la plataforma.</p>
    <button className="mr-4" onClick={() => void refresh()}>Actualizar estado</button><button onClick={logout}>Salir</button>
  </main>;
  return <TenantApp key={session.company_id} logout={logout} />;
}

function AdminPanel({ session, refresh, logout }: { session: Session; refresh: () => Promise<void>; logout: () => Promise<void> }) {
  const [companies, setCompanies] = useState<{ id: number; name: string; status: string; users: number }[]>([]);
  const [error, setError] = useState("");
  const load = () => api<{ companies: typeof companies }>("GET", "/api/admin/companies")
    .then((result) => setCompanies(result.companies)).catch((cause) => setError((cause as Error).message));
  useEffect(() => { void load(); }, []);
  return <main className="mx-auto max-w-2xl space-y-6 p-8">
    <header className="flex justify-between"><h1 className="text-2xl font-bold">Administración de empresas</h1><button onClick={logout}>Salir</button></header>
    <p>{session.email}</p>
    <form className="space-y-2" onSubmit={async (event) => {
      event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
      try {
        await api("POST", "/api/admin/users", { email: data.get("email"), password: data.get("password"),
          company_id: data.get("company_id") ? Number(data.get("company_id")) : null,
          agreement_confirmed: data.get("agreement_confirmed") === "on" });
        form.reset(); setError(""); await load();
      } catch (cause) { setError((cause as Error).message); }
    }}>
      <h2 className="font-semibold">Crear cuenta</h2>
      <input className="w-full rounded border p-2" name="email" type="email" placeholder="Correo electrónico" required />
      <input className="w-full rounded border p-2" name="password" type="password" minLength={12} placeholder="Contraseña inicial (mínimo 12 caracteres)" required />
      <select className="w-full rounded border p-2" name="company_id" key={companies.length} defaultValue="">
        <option value="">Primera cuenta: configura su empresa</option>
        {companies.map((company) => <option key={company.id} value={company.id}>Cuenta adicional: {company.name}</option>)}
      </select><button className="rounded bg-violet-700 px-4 py-2 text-white">Crear cuenta</button>
      <label className="block"><input type="checkbox" name="agreement_confirmed" /> Confirmo el acuerdo para cuentas adicionales</label>
      <p className="text-sm">Cada nueva empresa queda pendiente de activación antes de usar el sistema.</p>
    </form>
    <h2 className="font-semibold">Empresas</h2>
    {companies.map((company) => <div className="flex justify-between gap-3 border-b py-2" key={company.id}>
      <span>{company.name} · {company.status} · {company.users} cuentas</span>
      <button onClick={async () => {
        try { await api("PUT", `/api/admin/companies/${company.id}/status`, { status: company.status === "active" ? "disabled" : "active" }); await load(); }
        catch (cause) { setError((cause as Error).message); }
      }}>{company.status === "active" ? "Desactivar" : "Activar"}</button>
    </div>)}
    {error && <p role="alert">{error}</p>}
  </main>;
}

function TenantApp({ logout }: { logout: () => Promise<void> }) {
  const isAgent = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.has("agent") || params.get("mode") === "agent";
  }, []);

  useEffect(() => {
    if (isAgent) {
      document.documentElement.setAttribute("data-agent", "");
    }
  }, [isAgent]);

  const { view, id, navigate } = useRouter();
  const appState = useAppState(isAgent, navigate);
  useEffect(() => { reportLocation(window.location.pathname + window.location.search); }, [view, id]);

  useEffect(() => {
    if (view === "appointments" && id) {
      appState.selectAppointment(parseInt(id, 10));
    } else if (view === "clients" && id) {
      appState.selectClient(parseInt(id, 10));
    }
  }, [view, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderMain = () => {
    if (view === "appointments" && id && appState.selectedAppointment) return <AppointmentDetail />;
    if (view === "clients" && id && appState.selectedClient) return <ClientDetail />;
    switch (view) {
      case "calendar": return <CalendarView />;
      case "appointments": return <AppointmentList />;
      case "clients": return <ClientList />;
      case "staff": return <StaffList />;
      case "services": return <ServiceList />;
      case "products": return <ProductList />;
      default: return <Dashboard />;
    }
  };

  return (
    <AppContext.Provider value={appState}>
      <div className="flex h-dvh flex-col overflow-hidden md:flex-row">
        <Sidebar currentView={view} />
        <main className="min-h-0 min-w-0 flex-1 overflow-auto bg-background">
          {appState.loading ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">Cargando...</div>
          ) : (
            renderMain()
          )}
        </main>
      </div>
      <ErrorBanner />
      <button className="fixed bottom-2 right-2 rounded bg-background p-2 shadow" onClick={logout}>Salir</button>
    </AppContext.Provider>
  );
}
