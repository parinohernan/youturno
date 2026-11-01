/**
 * Dashboard card letting the owner manage the public booking link.
 *
 * All settings come from the authenticated company, never a cross-tenant cache.
 */
import { useEffect, useState } from "preact/hooks";
import { ApiError, api } from "@/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link, Copy, Check } from "lucide-preact";
import { WeeklyHoursEditor, hoursError } from "./weekly-hours-editor";
import type { WeeklyHours as Hours } from "../types";


function slugify(name: string): string {
  const base = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "");
  return base.length >= 3 ? base : `${base || "mi"}-salon`;
}

export function BookingLinkCard() {
  const [slug, setSlug] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [hours, setHours] = useState<Hours | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  // Fill the suggestion on first visit from the signed-in company's name.
  useEffect(() => {
    Promise.all([
      api<{ slug: string | null; business_hours: Hours }>("GET", "/api/company/booking"),
      api<{ company_name: string | null }>("GET", "/api/auth/session"),
    ]).then(([settings, session]) => {
      setSlug(settings.slug);
      setValue(settings.slug || slugify(session.company_name || "mi-salon"));
      setHours(settings.business_hours);
    }).catch((cause) => setNotice((cause as Error).message || "No se pudo cargar el enlace."))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    setNotice("");
    try {
      const result = await api<{ slug: string }>("PUT", "/api/company/slug", { slug: value.trim() });
      setSlug(result.slug);
      setValue(result.slug);
    } catch (cause) {
      if (cause instanceof ApiError) {
        if (cause.status === 409) {
          setNotice("Ya está en uso. Probá con otro, por ejemplo, agregando un número: “" + value.trim() + "-2”");
        } else if (cause.status === 400) {
          setNotice("Usá sólo minúsculas, números y guiones (mínimo 3 caracteres).");
        } else {
          setNotice(cause.message || "No se pudo guardar el enlace.");
        }
      } else {
        setNotice((cause as Error).message || "No se pudo guardar el enlace.");
      }
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    const text = `${window.location.origin}/book/${slug}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (permissions, stale document): select the
      // text so the user can copy it manually.
      const input = document.querySelector<HTMLInputElement>("input[data-booking-link]");
      input?.select();
      input?.focus();
      input?.select();
      setNotice("Seleccionamos el enlace. Copialo con Ctrl+C o desde el menú del dispositivo.");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 pb-3">
        <Link className="h-4 w-4 text-muted-foreground" />
        <CardTitle className="text-lg">Tu enlace de reservas</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
           Compartí este enlace para que tus clientes reserven turnos confirmados.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
            value={slug ? `${window.location.origin}/book/${slug}` : value}
            readOnly={!!slug}
            data-booking-link={!slug ? undefined : "true"}
          />
          {slug && (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => void copy()}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? "Copiado" : "Copiar"}
              </Button>
              <Button variant="outline" size="sm" asChild>
                <a href={`/book/${slug}`} target="_blank" rel="noreferrer">Ver</a>
              </Button>
            </div>
          )}
        </div>
        {!slug ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
              placeholder="mi-salon"
              value={value}
              onInput={(e) => setValue((e.target as HTMLInputElement).value.toLowerCase())}
            />
            <Button size="sm" disabled={loading || saving || !value.trim()} onClick={() => void save()}>
              {saving ? "Guardando..." : "Guardar enlace"}
            </Button>
          </div>
        ) : (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Cambiar el enlace</summary>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
                value={value}
                onInput={(e) => setValue((e.target as HTMLInputElement).value.toLowerCase())}
              />
              <Button variant="outline" size="sm" disabled={saving || !value.trim()} onClick={() => void save()}>
                {saving ? "Guardando..." : "Guardar cambios"}
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Los enlaces viejos dejan de funcionar al cambiarlo.</p>
          </details>
        )}
        {hours && <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Horarios semanales (UTC)</summary>
          <form className="mt-3 space-y-2" onSubmit={async (event) => {
            event.preventDefault();
            if (saving) return;
            const invalid = hoursError(hours);
            if (invalid) { setNotice(invalid); return; }
            setSaving(true); setNotice("");
            try { await api("PUT", "/api/company/business-hours", hours); setNotice("Horarios guardados."); }
            catch (cause) { setNotice((cause as Error).message || "No se pudieron guardar los horarios."); }
            finally { setSaving(false); }
          }}>
            <WeeklyHoursEditor hours={hours} onChange={setHours} disabled={saving} />
            <Button type="submit" size="sm" disabled={saving}>{saving ? "Guardando..." : "Guardar horarios"}</Button>
          </form>
        </details>}
        {notice && <p className="text-sm text-amber-600" role="alert">{notice}</p>}
      </CardContent>
    </Card>
  );
}
