import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api";
import type { CompanyProfile } from "../types";
import { appearanceError, defaultAppearance, type BookingAppearance } from "../../shared/booking-appearance";
import { BookPublic, type PublicOverview } from "./book-public";
import { Button } from "./ui/button";

type SavedAppearance = { appearance: BookingAppearance; cover_url: string | null };

/** Only company public identity is reused; schedule and people below are explicitly fictional. */
export function appearancePreview(company: CompanyProfile, appearance: BookingAppearance, cover: string | null): PublicOverview {
  const hours = { mon: [["09:00", "18:00"]], tue: [["09:00", "18:00"]], wed: [["09:00", "18:00"]],
    thu: [["09:00", "18:00"]], fri: [["09:00", "18:00"]], sat: [], sun: [] } as CompanyProfile["business_hours"];
  return { google_sign_in: true, company: { ...company, slug: "preview", appearance, cover_url: cover },
    services: [{ id: -1, name: "Servicio de ejemplo", duration: 30, price: 1000 }],
    staff: [{ id: -1, name: "Profesional de ejemplo", title: "", color: "#6d28d9", service_ids: [-1], effective_hours: hours }] };
}

export function BookingAppearanceEditor() {
  const [company, setCompany] = useState<CompanyProfile | null>(null);
  const [saved, setSaved] = useState<SavedAppearance | null>(null);
  const [draft, setDraft] = useState<BookingAppearance>({ ...defaultAppearance });
  const [file, setFile] = useState<File | null>(null);
  const [removeCover, setRemoveCover] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [width, setWidth] = useState<"mobile" | "desktop">("mobile");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const saving = useRef(false);
  useEffect(() => {
    let current = true;
    setLoadError("");
    Promise.all([api<CompanyProfile>("GET", "/api/company/profile"), api<SavedAppearance>("GET", "/api/company/appearance")])
      .then(([profile, settings]) => { if (current) { setCompany(profile); setSaved(settings); setDraft(settings.appearance); } })
      .catch((cause) => { if (current) setLoadError((cause as Error).message || "Intente nuevamente."); });
    return () => { current = false; };
  }, [loadAttempt]);
  useEffect(() => {
    if (!file) { setObjectUrl(null); return; }
    const url = URL.createObjectURL(file); setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const invalid = appearanceError(draft);
  const cover = file ? objectUrl : removeCover ? null : saved?.cover_url ?? null;
  const cancel = () => {
    if (!saved || saving.current) return;
    setDraft({ ...saved.appearance }); setFile(null); setRemoveCover(false); setNotice("Cambios sin guardar descartados.");
  };
  const save = async () => {
    if (!saved || invalid || saving.current) return;
    saving.current = true; setBusy(true); setNotice("");
    const form = new FormData();
    form.set("settings", JSON.stringify(draft));
    form.set("cover_action", file ? "replace" : removeCover ? "remove" : "preserve");
    if (file) form.set("cover", file);
    try {
      await api("PUT", "/api/company/appearance", form);
      const settings = await api<SavedAppearance>("GET", "/api/company/appearance");
      setSaved(settings); setDraft(settings.appearance); setFile(null); setRemoveCover(false);
      setNotice("Diseño guardado y publicado.");
    } catch (cause) { setNotice((cause as Error).message || "No se pudo guardar el diseño."); }
    finally { saving.current = false; setBusy(false); }
  };
  return <div className="booking-appearance-editor mx-auto min-w-0 max-w-6xl space-y-6 p-4 sm:p-8">
    <header><h1 className="text-2xl font-bold">Personalizar página de reservas</h1>
      <p>Los cambios solo se publican al guardar. El logo se reutiliza del perfil de la empresa.</p></header>
    {notice && <p role="status" className="rounded border p-3">{notice}</p>}
    {loadError ? <div role="alert" className="space-y-2 rounded border p-3">
      <p>No se pudo cargar el diseño. No se puede guardar hasta cargar la configuración actual. {loadError}</p>
      <Button variant="outline" onClick={() => { setLoadError(""); setLoadAttempt((attempt) => attempt + 1); }}>Reintentar carga</Button>
    </div> : !company || !saved ? <p role="status">Cargando diseño… Espere antes de guardar.</p> : <>
      <form className="space-y-4 rounded border p-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset className="min-w-0 space-y-4" disabled={busy}>
          <legend className="font-semibold">Diseño de su empresa</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            {([["background", "Color de fondo"], ["text", "Color del texto"], ["button", "Color de botones"]] as const).map(([key, label]) =>
              <label className="flex min-w-0 flex-wrap items-center gap-3" key={key}><span>{label}</span>
                <input type="color" aria-label={label} value={draft[key]} onInput={(event) => setDraft({ ...draft, [key]: event.currentTarget.value })} />
                <span className="font-mono text-xs">{draft[key]}</span>
              </label>)}
          </div>
          <p className="text-sm">Contraste mínimo: texto 4,5:1; botones respecto del fondo 3:1. El texto de los botones será blanco o negro automáticamente para asegurar legibilidad.</p>
          {invalid && <p role="alert" className="rounded border p-2">{invalid} Ajuste los colores antes de guardar.</p>}
          <label className="block space-y-1"><span>Mensaje de bienvenida (opcional, hasta 500 caracteres)</span>
            <textarea className="block w-full rounded border bg-background p-2" rows={3} maxLength={500} value={draft.welcome}
              onInput={(event) => setDraft({ ...draft, welcome: event.currentTarget.value })} /></label>
          <label className="block space-y-1"><span>Imagen de portada (opcional)</span>
            <input className="block w-full" type="file" accept="image/png,image/jpeg" aria-describedby="cover-help" onChange={(event) => {
              const selected = event.currentTarget.files?.[0]; event.currentTarget.value = "";
              if (!selected) return;
              if (!["image/png", "image/jpeg"].includes(selected.type) || !selected.size || selected.size > 512 * 1024) {
                setNotice("Seleccione un PNG o JPEG de hasta 512 KB."); return;
              }
              setFile(selected); setRemoveCover(false); setNotice("");
            }} /></label>
          <p id="cover-help" className="text-sm">PNG o JPEG, máximo 512 KB y 4096 × 4096 píxeles. Se recorta visualmente al centro en proporción 3:1, sin deformar. La imagen original se conserva. La portada no se publica al seleccionarla.</p>
          {(cover || file) && <Button type="button" variant="outline" onClick={() => { setFile(null); setRemoveCover(true); }}>Quitar portada al guardar</Button>}
          <p id="appearance-save-help" role="status" className="text-sm">
            {busy ? "Guardando diseño. Espere a que termine la publicación." : invalid
              ? `No se puede guardar: ${invalid} Ajuste los colores o use los colores predeterminados.`
              : "Puede guardar y publicar este diseño, incluso si no realizó cambios."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" aria-describedby="appearance-save-help" disabled={busy || !!invalid}>{busy ? "Guardando…" : "Guardar y publicar diseño"}</Button>
            <Button type="button" variant="outline" onClick={() => {
              setDraft({ ...draft, background: defaultAppearance.background, text: defaultAppearance.text, button: defaultAppearance.button });
              setNotice("Colores predeterminados en vista previa. El mensaje y la portada se conservan. Guarde para publicarlos.");
            }}>Usar colores predeterminados</Button>
            <Button type="button" variant="outline" onClick={cancel}>Cancelar cambios</Button>
            <Button type="button" variant="outline" onClick={() => {
              setDraft({ ...defaultAppearance }); setFile(null); setRemoveCover(true); setNotice("Diseño predeterminado en vista previa. Guarde para publicarlo.");
            }}>Restablecer diseño</Button>
          </div>
        </fieldset>
      </form>
      <section className="space-y-3" aria-labelledby="appearance-preview-title">
        <h2 id="appearance-preview-title" className="text-lg font-semibold">Vista previa en vivo</h2>
        <p>Datos de ejemplo. Esta vista no permite reservar, iniciar sesión ni abrir enlaces. Los horarios siguen en UTC.</p>
        <div className="flex gap-2">
          <Button variant="outline" aria-pressed={width === "mobile"} onClick={() => setWidth("mobile")}>Móvil</Button>
          <Button variant="outline" aria-pressed={width === "desktop"} onClick={() => setWidth("desktop")}>Escritorio</Button>
        </div>
        <div className="min-w-0 max-w-full rounded border p-2">
          <div className="mx-auto max-w-full" style={{ width: width === "mobile" ? "375px" : "760px" }}>
            <BookPublic slug="preview" preview={appearancePreview(company, draft, cover)} />
          </div>
        </div>
      </section>
    </>}
  </div>;
}
