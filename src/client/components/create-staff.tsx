import { useState } from "preact/hooks";
import { useApp } from "../context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { strings } from "@/lib/strings";
import type { Staff } from "../types";
import type { WeeklyHours } from "../types";
import { WeeklyHoursEditor, hoursError } from "./weekly-hours-editor";

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

  const handleSubmit = async () => {
    if (!name.trim()) { setError(strings.nameRequired); return; }
    const invalid = hours && hoursError(hours);
    if (invalid) { setScheduleError(invalid); return; }
    if (!Number.isInteger(schedulingInterval) || schedulingInterval < 1 || schedulingInterval > 240) {
      setScheduleError("El intervalo debe ser un número entero entre 1 y 240 minutos."); return;
    }
    setSaving(true);
    setScheduleError("");
    try {
      const data = { name: name.trim(), email, phone, title, color, working_hours: hours, service_ids: serviceIds,
        scheduling_mode: schedulingMode, scheduling_interval: schedulingInterval };
      if (staff) await updateStaff(staff.id, data);
      else await addStaff(data);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setScheduleError((err as Error).message);
    } finally {
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
              <Label>Correo electrónico</Label>
              <Input type="email" value={email} onChange={(e) => setEmail((e.target as HTMLInputElement).value)} />
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
          <fieldset disabled={saving} className="space-y-2 min-w-0">
            <legend className="text-sm font-medium">Horarios de reserva pública</legend>
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
          <div className="space-y-2">
            <fieldset disabled={saving} className="space-y-2">
              <legend className="text-sm font-medium">Servicios que ofrece</legend>
              {services.map((service) => <label key={service.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={serviceIds.includes(service.id)}
                  onChange={(event) => setServiceIds(event.currentTarget.checked
                    ? [...serviceIds, service.id] : serviceIds.filter((id) => id !== service.id))} />
                {service.name}{service.active ? "" : " (inactivo)"}
              </label>)}
              {services.length === 0 && <p className="text-sm text-muted-foreground">Primero agregá servicios a la empresa.</p>}
              {serviceIds.filter((id) => services.some((service) => service.id === id && service.active)).length === 0 &&
                <p role="status" className="text-sm text-amber-700">Sin servicios activos asignados, este profesional no podrá recibir reservas públicas.</p>}
            </fieldset>
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={hours === null} disabled={saving}
              onChange={(event) => setHours(event.currentTarget.checked ? null : {})} /> Heredar todos los horarios de la empresa</label>
            {hours !== null && <WeeklyHoursEditor hours={hours} onChange={setHours} personal disabled={saving} />}
            {scheduleError && <p role="alert" className="text-sm text-destructive">{scheduleError}</p>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={saving} onClick={handleSubmit}>{saving ? strings.saving : isEditing ? strings.saveChanges : "Agregar integrante"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
