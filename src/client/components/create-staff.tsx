import { useRef, useState } from "preact/hooks";
import { useApp } from "../context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { strings } from "@/lib/strings";
import type { Staff } from "../types";
import type { WeeklyHours } from "../types";
import { WeeklyHoursEditor, hoursError } from "./weekly-hours-editor";
import { StaffPhotoEditor, type StaffPhotoChange } from "./staff-photo-editor";

const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#ef4444", "#14b8a6", "#f97316"];

export function CreateStaff({ onClose, staff }: { onClose: () => void; staff?: Staff }) {
  const { addStaff, updateStaff, setError, services } = useApp();
  const [serviceIds, setServiceIds] = useState<number[]>(staff?.service_ids ?? []);
  const [name, setName] = useState(staff?.name || "");
  const [email, setEmail] = useState(staff?.email || "");
  const [phone, setPhone] = useState(staff?.phone || "");
  const [title, setTitle] = useState(staff?.title || "");
  const [color, setColor] = useState(staff?.color || COLORS[0]);
  const [saving, setSaving] = useState(false);
  const [hours, setHours] = useState<WeeklyHours | null>(staff?.working_hours ?? null);
  const [schedulingMode, setSchedulingMode] = useState<NonNullable<Staff["scheduling_mode"]>>(staff?.scheduling_mode ?? "fixed");
  const [schedulingInterval, setSchedulingInterval] = useState(staff?.scheduling_interval ?? 30);
  const [scheduleError, setScheduleError] = useState("");
  const isEditing = staff !== undefined;
  const passwordInput = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const [changingAccess, setChangingAccess] = useState(false);
  const [accessStatus, setAccessStatus] = useState("");
  const [accessEnabled, setAccessEnabled] = useState(Boolean(staff?.access_enabled));
  const portalPath = "/profesionales/login";
  const portalUrl = typeof window === "undefined" ? portalPath : `${window.location.origin}${portalPath}`;
  const [photo, setPhoto] = useState<StaffPhotoChange>(undefined);
  const [readingPhoto, setReadingPhoto] = useState(false);

  const handleSubmit = async () => {
    if (submitting.current || readingPhoto) return;
    const professionalPassword = passwordInput.current?.value || "";
    if (passwordInput.current) passwordInput.current.value = "";
    setChangingAccess(false);
    if (professionalPassword && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || professionalPassword.length < 12 || professionalPassword.length > 1024)) {
      setScheduleError("Para crear o cambiar el acceso, indique un correo válido y una contraseña de 12 a 1024 caracteres."); return;
    }
    if (!name.trim()) { setError(strings.nameRequired); return; }
    const invalid = hours && hoursError(hours);
    if (invalid) { setScheduleError(invalid); return; }
    if (!Number.isInteger(schedulingInterval) || schedulingInterval < 1 || schedulingInterval > 240) {
      setScheduleError("El intervalo debe ser un número entero entre 1 y 240 minutos."); return;
    }
    setSaving(true);
    submitting.current = true;
    setScheduleError("");
    try {
      const data = { name: name.trim(), email, phone, title, color, working_hours: hours, service_ids: serviceIds,
        scheduling_mode: schedulingMode, scheduling_interval: schedulingInterval,
        ...(photo !== undefined ? { photo } : {}),
        ...(professionalPassword ? { professional_password: professionalPassword } : {}) };
      if (staff) await updateStaff(staff.id, data);
      else await addStaff(data);
      if (professionalPassword) {
        setAccessEnabled(true);
        setAccessStatus(accessEnabled ? "Cambios guardados y contraseña actualizada. Las sesiones anteriores se cerraron." : "Cambios guardados y acceso profesional creado.");
      } else onClose();
    } catch (err) {
      setError((err as Error).message);
      setScheduleError((err as Error).message);
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Editar integrante" : "Agregar integrante"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <StaffPhotoEditor src={staff?.photo_url} disabled={saving} onChange={setPhoto} onBusy={setReadingPhoto} />
          <div className="space-y-1.5">
            <Label>Nombre *</Label>
            <Input value={name} onChange={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Nombre completo" />
          </div>
          <div className="space-y-1.5">
            <Label>Puesto / Rol</Label>
            <Input value={title} onChange={(e) => setTitle((e.target as HTMLInputElement).value)} placeholder="ej. Estilista senior" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="staff-email">Correo electrónico</Label>
              <Input id="staff-email" type="email" value={email} onChange={(e) => setEmail((e.target as HTMLInputElement).value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Teléfono</Label>
              <Input value={phone} onChange={(e) => setPhone((e.target as HTMLInputElement).value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Color</Label>
            <div className="flex flex-wrap gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  className={`h-8 w-8 rounded-full transition-transform ${color === c ? "scale-110 ring-2 ring-ring ring-offset-2" : "hover:scale-105"}`}
                  style={{ backgroundColor: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </div>
          {isEditing && <fieldset disabled={saving} className="min-w-0 space-y-2 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">Acceso al portal profesional</legend>
            <p className="text-sm">Ingreso con el correo de esta ficha. Solo permite consultar y gestionar su propia agenda; no otorga administración de la empresa.</p>
            <Label htmlFor="professional-password">{accessEnabled ? "Nueva contraseña" : "Contraseña para crear acceso"}</Label>
            <Input id="professional-password" ref={passwordInput} type="password" autoComplete="new-password" minLength={12} maxLength={1024}
              aria-describedby="professional-access-help" onInput={(event) => { setChangingAccess(Boolean(event.currentTarget.value)); setAccessStatus(""); }} />
            <p id="professional-access-help" className="text-xs text-muted-foreground">{accessEnabled
              ? "Deje vacío para conservar la contraseña actual. Cambiarla cerrará las sesiones del profesional."
              : "El acceso es opcional. Para crearlo, indique un correo válido y una contraseña de al menos 12 caracteres; luego guarde los cambios."}</p>
            {!email.trim() && <p className="text-sm text-amber-700">Indique un correo electrónico antes de crear el acceso.</p>}
            <a className="block break-all text-sm underline" href={portalPath} target="_blank" rel="noopener noreferrer">Portal del profesional</a>
            <p className="break-all text-xs text-muted-foreground">{portalUrl}</p>
            <Button variant="outline" type="button" onClick={async () => {
              try { await navigator.clipboard.writeText(portalUrl); setAccessStatus("Enlace copiado."); }
              catch { setAccessStatus("No se pudo copiar. Puede copiar el enlace que aparece arriba."); }
            }}>Copiar enlace del portal</Button>
            {accessStatus && <p role="status" className="text-sm">{accessStatus}</p>}
          </fieldset>}
          <fieldset disabled={saving} className="min-w-0 space-y-2 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">Método de agenda</legend>
            <Label htmlFor="scheduling-mode">Método de agenda</Label>
            <select id="scheduling-mode" value={schedulingMode} className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              aria-describedby="scheduling-help" onChange={(event) => {
                setSchedulingMode(event.currentTarget.value as NonNullable<Staff["scheduling_mode"]>);
                // Do not let an unfinished hidden cadence prevent another method's save.
                if (!Number.isInteger(schedulingInterval) || schedulingInterval < 1 || schedulingInterval > 240) setSchedulingInterval(staff?.scheduling_interval ?? 30);
                setScheduleError("");
              }}>
              <option value="consecutive">Agenda consecutiva</option>
              <option value="fixed">Intervalo fijo</option>
              <option value="service_duration">Según duración del servicio</option>
            </select>
            <p id="scheduling-help" className="text-xs text-muted-foreground">
              {schedulingMode === "consecutive" ? "Ofrece solo el primer horario libre en cada tramo de trabajo, por ejemplo mañana y tarde, donde cabe el servicio completo." :
                schedulingMode === "fixed" ? "Permite elegir inicios cada X minutos, alineados desde las 00:00. La duración del servicio se ocupa completa, sin redondearla al intervalo." :
                  "Separa los inicios por la duración del servicio elegido, desde el comienzo de cada tramo de trabajo. Los horarios ocupados se omiten sin reiniciar la secuencia."}
            </p>
            {schedulingMode === "fixed" && <div className="space-y-1.5">
              <Label htmlFor="scheduling-interval">Minutos entre inicios</Label>
              <Input id="scheduling-interval" type="number" min={1} max={240} step={1} value={schedulingInterval}
                onChange={(event) => setSchedulingInterval(Number(event.currentTarget.value))} />
              <p className="text-xs text-muted-foreground">Entre 1 y 240 minutos. Se conserva al cambiar de método.</p>
            </div>}
            <p className="text-xs text-muted-foreground">No cambia turnos existentes ni la agenda manual. Solo se ofrecen horarios futuros dentro del horario de la empresa y del profesional.</p>
          </fieldset>
          <fieldset disabled={saving} className="min-w-0 space-y-2 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">Servicios que ofrece</legend>
            {services.map((service) => <label key={service.id} className="flex min-w-0 items-center gap-2 text-sm">
              <input type="checkbox" className="shrink-0" checked={serviceIds.includes(service.id)}
                onChange={(event) => setServiceIds(event.currentTarget.checked
                  ? [...serviceIds, service.id] : serviceIds.filter((id) => id !== service.id))} />
              <span className="min-w-0 break-words">{service.name}{service.active ? "" : " (inactivo)"}</span>
            </label>)}
            {services.length === 0 && <p className="text-sm text-muted-foreground">Primero agregue servicios a la empresa.</p>}
            {serviceIds.filter((id) => services.some((service) => service.id === id && service.active)).length === 0 &&
              <p role="status" className="text-sm text-amber-700">Sin servicios activos asignados, este profesional no podrá recibir reservas públicas.</p>}
          </fieldset>
          <fieldset disabled={saving} className="min-w-0 space-y-2 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">Horarios de atención</legend>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="shrink-0" checked={hours === null} disabled={saving}
              onChange={(event) => setHours(event.currentTarget.checked ? null : {})} /> Usar los horarios de atención de la empresa</label>
            {hours !== null && <WeeklyHoursEditor hours={hours} onChange={setHours} personal disabled={saving} />}
          </fieldset>
          {scheduleError && <p role="alert" className="text-sm text-destructive">{scheduleError}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={saving || readingPhoto} onClick={handleSubmit}>{saving ? strings.saving : changingAccess ? (accessEnabled ? "Guardar y cambiar contraseña" : "Guardar y crear acceso") : isEditing ? strings.saveChanges : "Agregar integrante"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
