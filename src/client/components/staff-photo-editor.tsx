import { useEffect, useRef, useState } from "preact/hooks";
import { ProfessionalAvatar } from "./professional-avatar";
import { Button } from "@/components/ui/button";

export type StaffPhotoChange = { mime: "image/png" | "image/jpeg"; data: string } | null | undefined;

export function StaffPhotoEditor({ src, disabled, onChange, onBusy }: { src?: string | null; disabled: boolean; onChange: (photo: StaffPhotoChange) => void; onBusy: (busy: boolean) => void }) {
  const [preview, setPreview] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => () => { if (preview?.startsWith("blob:")) URL.revokeObjectURL(preview); }, [preview]);

  const select = async (file?: File) => {
    if (!file) return;
    const version = ++generation.current;
    setError("");
    if (!["image/png", "image/jpeg"].includes(file.type) || file.size > 512 * 1024 || !file.size) {
      setError("Use PNG o JPEG de hasta 512 KB y 4096 × 4096 píxeles."); onBusy(true); return;
    }
    setReading(true); onBusy(true);
    const url = URL.createObjectURL(file);
    try {
      const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => reject(new Error("invalid image")); image.src = url;
      });
      if (!dimensions.width || !dimensions.height || dimensions.width > 4096 || dimensions.height > 4096) throw new Error("invalid dimensions");
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      if (version !== generation.current) { URL.revokeObjectURL(url); return; }
      onChange({ mime: file.type as "image/png" | "image/jpeg", data: btoa(binary) });
      setPreview(url);
    } catch {
      URL.revokeObjectURL(url);
      if (version === generation.current) {
        setError("No se pudo leer la imagen. Use un PNG o JPEG válido de hasta 4096 × 4096 píxeles.");
        setReading(false); onBusy(true);
      }
      return;
    }
    if (version === generation.current) { setReading(false); onBusy(false); }
  };

  return <fieldset disabled={disabled} className="min-w-0 space-y-2 rounded-md border p-3">
    <legend className="px-1 text-sm font-medium">Foto del profesional</legend>
    <div className="flex min-w-0 items-center gap-3">
      <ProfessionalAvatar src={preview === undefined ? src : preview} size={64} eager />
      <div className="min-w-0 flex-1 space-y-2">
        <input ref={input} id="staff-photo" className="sr-only" type="file" accept="image/png,image/jpeg" aria-label="Seleccionar foto del profesional" onChange={event => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void select(file);
        }} />
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={reading} onClick={() => input.current?.click()}>{reading ? "Leyendo imagen…" : (preview === undefined ? src : preview) ? "Reemplazar foto" : "Agregar foto"}</Button>
          {(preview === undefined ? src : preview) && <Button type="button" variant="outline" disabled={reading} onClick={() => { generation.current++; setPreview(null); onChange(null); onBusy(false); setError(""); if (input.current) input.current.value = ""; }}>Quitar foto</Button>}
        </div>
        <p className="text-xs text-muted-foreground">PNG o JPEG · Hasta 512 KB · Máximo 4096 × 4096 píxeles.</p>
      </div>
    </div>
    <p className="text-xs text-muted-foreground">Opcional y pública en el enlace de reservas. Se guarda junto con la ficha al guardar los cambios. Sin foto se muestra una silueta.</p>
    {error && <><p role="alert" className="text-sm text-destructive">{error}</p><Button type="button" variant="outline" onClick={() => { generation.current++; setPreview(undefined); onChange(undefined); onBusy(false); setError(""); }}>Descartar selección</Button></>}
  </fieldset>;
}
