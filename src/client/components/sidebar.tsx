import { AppNav, embedded } from "@clawnify/app/client";
import { useEffect, useState } from "preact/hooks";
import { useApp } from "../context";
import { Menu, LayoutDashboard, CalendarDays, Clock, Users, UserCog, Sparkles, Package, Building2 } from "lucide-preact";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { View } from "../types";
import { BrandLogo } from "./brand-logo";

const navItems: { view: View; path: string; label: string; icon: typeof LayoutDashboard }[] = [
  { view: "dashboard", path: "/", label: "Panel de inicio", icon: LayoutDashboard },
  { view: "calendar", path: "/calendar", label: "Agenda", icon: CalendarDays },
  { view: "appointments", path: "/appointments", label: "Turnos", icon: Clock },
  { view: "clients", path: "/clients", label: "Clientes", icon: Users },
  { view: "staff", path: "/staff", label: "Equipo", icon: UserCog },
  { view: "services", path: "/services", label: "Servicios", icon: Sparkles },
  { view: "products", path: "/products", label: "Productos", icon: Package },
  { view: "company", path: "/company", label: "Perfil de empresa", icon: Building2 },
];

function SidebarContent({ currentView, onNavigate }: { currentView: View; onNavigate?: () => void }) {
  const { navigate, stats } = useApp();

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      <div className="flex items-center justify-center px-4 py-5">
        <BrandLogo className="h-40 w-40" />
      </div>
      <Separator />
      <nav aria-label="Navegación principal" className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-3">
        <p className="mb-2 px-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">Menú</p>
        {navItems.map((item) => (
          <button
            key={item.view}
            className={cn(
              "flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-0",
              currentView === item.view
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
            )}
            aria-current={currentView === item.view ? "page" : undefined}
            onClick={() => { navigate(item.path); onNavigate?.(); }}
          >
            <item.icon className="h-4 w-4" />
            <span className="flex-1 text-left">{item.label}</span>
            {item.view === "appointments" && stats.appointments > 0 && (
              <Badge variant="secondary" className="h-5 px-1.5 text-xs">{stats.appointments}</Badge>
            )}
            {item.view === "clients" && stats.clients > 0 && (
              <Badge variant="secondary" className="h-5 px-1.5 text-xs">{stats.clients}</Badge>
            )}
            {item.view === "products" && stats.low_stock_products > 0 && (
              <Badge variant="destructive" className="h-5 px-1.5 text-xs">{stats.low_stock_products}</Badge>
            )}
          </button>
        ))}
      </nav>
      <Separator />
      <div className="flex items-center justify-around px-4 py-4">
        <div className="text-center">
          <div className="text-lg font-bold text-sidebar-foreground">{stats.today_appointments}</div>
          <div className="text-xs text-muted-foreground">Hoy</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-bold text-sidebar-foreground">{stats.upcoming_appointments}</div>
          <div className="text-xs text-muted-foreground">Próximos</div>
        </div>
      </div>
    </div>
  );
}

export function Sidebar({ currentView }: { currentView: View }) {
  const [open, setOpen] = useState(false);
  const { navigate, stats } = useApp();

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    const closeOnDesktop = () => { if (desktop.matches) setOpen(false); };
    const closeOnHistory = () => setOpen(false);
    desktop.addEventListener("change", closeOnDesktop);
    window.addEventListener("popstate", closeOnHistory);
    return () => {
      desktop.removeEventListener("change", closeOnDesktop);
      window.removeEventListener("popstate", closeOnHistory);
    };
  }, []);

  if (embedded) {
    const icons = ["home", "calendar-days", "clock", "users", "users", "sparkles", "package", "building-2"];
    return <AppNav title="Salón" icon="calendar-days" active={currentView}
      groups={[{ items: navItems.map((item, index) => ({
        id: item.view, label: item.label, href: item.path, icon: icons[index],
        home: item.view === "dashboard",
        count: item.view === "appointments" ? stats.appointments || undefined
          : item.view === "clients" ? stats.clients || undefined
          : item.view === "products" ? stats.low_stock_products || undefined : undefined,
      })) }]}
      onNavigate={(item) => navigate(item.href || "/")} />;
  }

  return (
    <>
      <aside className="hidden w-60 shrink-0 border-r md:block">
        <SidebarContent currentView={currentView} />
      </aside>
      <header className="flex shrink-0 items-center justify-between gap-3 border-b bg-sidebar px-4 py-2 md:hidden">
        <BrandLogo className="h-20 w-20" />
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" className="min-h-11" aria-label="Abrir menú de navegación">
              <Menu className="h-4 w-4" />
              Menú
            </Button>
          </DialogTrigger>
          <DialogContent aria-describedby={undefined} className="left-0 top-0 flex h-dvh w-80 max-w-[calc(100%-2rem)] translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:rounded-none [&>button]:flex [&>button]:h-11 [&>button]:w-11 [&>button]:items-center [&>button]:justify-center [&>button]:right-2 [&>button]:top-3">
            <DialogTitle className="sr-only">Menú de navegación</DialogTitle>
            <SidebarContent currentView={currentView} onNavigate={() => setOpen(false)} />
          </DialogContent>
        </Dialog>
      </header>
    </>
  );
}
