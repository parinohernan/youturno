import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import type { CompanyProfile, WeeklyHours } from "../types";
import { Button } from "./ui/button";
import { WeeklyHoursEditor, hoursError } from "./weekly-hours-editor";
import { safeSocialUrl, socialNetworks } from "../../shared/social-links";

export function CompanyProfilePage({ refreshSession }: { refreshSession: () => Promise<void> }) {
  const [profile, setProfile] = useState<CompanyProfile | null>(null);
  const [hours, setHours] = useState<WeeklyHours | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    api<CompanyProfile>("GET", "/api/company/profile").then((data) => {
      setProfile(data); setHours(data.business_hours);
    }).catch((cause) => setNotice((cause as Error).message));
  }, []);

  const perform = async (action: () => Promise<void>, message: string) => {
    if (busy) return;
    setBusy(true); setNotice("");
    try { await action(); setNotice(message); }
    catch (cause) { setNotice((cause as Error).message || "No se pudieron guardar los cambios."); }
    finally { setBusy(false); }
  };
  const reloadLogo = async () => {
    const data = await api<CompanyProfile>("GET", "/api/company/profile");
    setProfile((current) => current ? { ...current, logo_url: data.logo_url } : data);
  };
  const field = (key: "name" | "description" | "address" | "phone" | "public_email" | "website", label: string,
    maxLength: number, type = "text") => <label className="block space-y-1">
    <span>{label}</span>
    <input className="w-full rounded border border-input bg-background px-3 py-2" type={type}
      value={profile?.[key] ?? ""} maxLength={maxLength} required={key === "name"} minLength={key === "name" ? 2 : undefined}
      disabled={busy} onInput={(event) => setProfile((current) => current ? { ...current, [key]: event.currentTarget.value } : current)} />
  </label>;

  return <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-8">
    <header><h1 className="text-2xl font-bold">Perfil de empresa</h1>
      <p className="text-sm text-muted-foreground">Estos datos son públicos y se muestran en su página de reservas. No modifican los datos legales de YouTurno.</p></header>
    {notice && <p role="status" className="rounded border p-3 text-sm">{notice}</p>}
    {!profile ? <p>Cargando perfil…</p> : <>
      <form className="space-y-4 rounded border p-4" onSubmit={(event) => {
        event.preventDefault();
        const invalidSocial = socialNetworks.find(({ key }) => {
          const value = profile.social_links?.[key]?.trim();
          return value && !safeSocialUrl(value);
        });
        if (invalidSocial) { setNotice(`${invalidSocial.label}: use una URL http:// o https:// sin usuario ni contraseña (máximo 500 caracteres).`); return; }
        void perform(async () => {
          const { name, description, address, phone, public_email, website, social_links } = profile;
          await api("PUT", "/api/company/profile", { name, description, address, phone, public_email, website, social_links });
          await refreshSession();
        }, "Perfil guardado.");
      }}>
        <h2 className="text-lg font-semibold">Información pública</h2>
        {field("name", "Nombre de la empresa", 120)}
        {field("description", "Descripción breve (opcional)", 500)}
        {field("address", "Dirección o ubicación (opcional)", 300)}
        {field("phone", "Teléfono de contacto (opcional)", 40, "tel")}
        {field("public_email", "Correo electrónico público (opcional)", 254, "email")}
        {field("website", "Sitio web: http:// o https:// (opcional)", 500, "url")}
        <fieldset className="space-y-3" aria-describedby="social-links-help" disabled={busy}>
          <legend className="text-lg font-semibold">Redes sociales</legend>
          <p id="social-links-help" className="text-sm text-muted-foreground">Enlaces públicos opcionales. Pegue la URL completa, preferentemente https://. Los ejemplos son orientativos. Deje un campo vacío para quitar su enlace.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {socialNetworks.map(({ key, label, placeholder }) => <label key={key} className="block space-y-1">
              <span>{label} (opcional)</span>
              <input className="w-full rounded border border-input bg-background px-3 py-2" type="url"
                maxLength={500} placeholder={placeholder} value={profile.social_links?.[key] ?? ""}
                onInput={(event) => setProfile((current) => current ? { ...current,
                  social_links: { ...current.social_links, [key]: event.currentTarget.value } } : current)} />
            </label>)}
          </div>
        </fieldset>
        <p className="text-xs text-muted-foreground">Deje un campo opcional vacío para quitarlo de la página pública.</p>
        <Button type="submit" disabled={busy}>Guardar perfil</Button>
      </form>
      <section className="space-y-3 rounded border p-4" aria-labelledby="company-logo-title">
        <h2 id="company-logo-title" className="text-lg font-semibold">Logo de la empresa</h2>
        {profile.logo_url && <img src={profile.logo_url} alt={`Logo de ${profile.name}`} className="h-32 w-32 rounded object-contain" />}
        <p id="company-logo-help" className="text-sm text-muted-foreground">PNG o JPEG. Máximo 512 KB y 4096 × 4096 píxeles. Se guarda la imagen original, sin redimensionar. El logo se guarda por separado.</p>
        <label className="block">{profile.logo_url ? "Reemplazar imagen" : "Subir imagen"}
          <input className="mt-2 block w-full" type="file" accept="image/png,image/jpeg" disabled={busy}
            aria-describedby="company-logo-help" onChange={(event) => {
              const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
              if (!file) return;
              if (!["image/png", "image/jpeg"].includes(file.type) || file.size === 0 || file.size > 512 * 1024) {
                setNotice("Seleccione un PNG o JPEG de hasta 512 KB."); return;
              }
              void perform(async () => { await api("PUT", "/api/company/logo", file); await reloadLogo(); }, "Logo guardado.");
            }} />
        </label>
        {profile.logo_url && <Button type="button" variant="outline" disabled={busy} onClick={() => {
          void perform(async () => { await api("DELETE", "/api/company/logo", {}); await reloadLogo(); }, "Logo eliminado.");
        }}>Quitar logo</Button>}
      </section>
      {hours && <form className="space-y-3 rounded border p-4" onSubmit={(event) => {
        event.preventDefault();
        const invalid = hoursError(hours);
        if (invalid) { setNotice(invalid); return; }
        void perform(async () => { await api("PUT", "/api/company/business-hours", hours); }, "Horarios guardados.");
      }}>
        <h2 className="text-lg font-semibold">Horarios generales (UTC)</h2>
        <p className="text-sm text-muted-foreground">Se guardan por separado. El equipo hereda estos horarios salvo sus excepciones; la disponibilidad también depende de los servicios habilitados y los turnos existentes.</p>
        <WeeklyHoursEditor hours={hours} onChange={setHours} disabled={busy} />
        <Button type="submit" disabled={busy}>Guardar horarios</Button>
      </form>}
    </>}
  </div>;
}
