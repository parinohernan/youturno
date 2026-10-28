import { useState } from "preact/hooks";
import { useApp } from "../context";
import { X, TriangleAlert } from "lucide-preact";
import { conflictsFrom, describeConflict, type Conflict } from "@/lib/conflicts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { today } from "@/lib/dates";
import { strings } from "@/lib/strings";

interface Props {
  onClose: () => void;
  defaultDate?: string;
  defaultClientId?: number;
  defaultStaffId?: number | null;
  defaultStartTime?: string;
}

export function CreateAppointment({ onClose, defaultDate, defaultClientId, defaultStaffId, defaultStartTime }: Props) {
  const { addAppointment, clientLookup, staffLookup, services, setError } = useApp();
  const [clientId, setClientId] = useState(defaultClientId ? String(defaultClientId) : "");
  const [staffId, setStaffId] = useState(defaultStaffId ? String(defaultStaffId) : "");
  const [date, setDate] = useState(defaultDate || today());
  const [startTime, setStartTime] = useState(defaultStartTime || "09:00");
  const [selectedServices, setSelectedServices] = useState<number[]>([]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);

  const toggleService = (id: number) => {
    setConflicts(null);
    setSelectedServices((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );
  };

  const totalPrice = services
    .filter((s) => selectedServices.includes(s.id))
    .reduce((sum, s) => sum + s.price, 0);

  const totalDuration = services
    .filter((s) => selectedServices.includes(s.id))
    .reduce((sum, s) => sum + s.duration, 0);

  const handleSubmit = async (allowConflict = false) => {
    if (!clientId) { setError("Elige un cliente"); return; }
    setSaving(true);
    setConflicts(null);
    try {
      await addAppointment({
        client_id: parseInt(clientId),
        staff_id: staffId ? parseInt(staffId) : null,
        scheduled_date: date,
        start_time: startTime,
        notes,
        service_ids: selectedServices,
        ...(allowConflict ? { allow_conflict: true } : {}),
      });
      onClose();
    } catch (err) {
      // A clash is answered in the form, next to the time that caused it, rather
      // than thrown at the page as a failure: the booking is one field away.
      const clashes = conflictsFrom(err);
      if (clashes) setConflicts(clashes);
      else setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nuevo turno</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Cliente *</Label>
              <select className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={clientId} onChange={(e) => setClientId((e.target as HTMLSelectElement).value)}>
                <option value="">Elegir cliente...</option>
                {clientLookup.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Equipo</Label>
              <select className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={staffId} onChange={(e) => { setStaffId((e.target as HTMLSelectElement).value); setConflicts(null); }}>
                <option value="">Sin asignar</option>
                {staffLookup.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Fecha</Label>
              <Input type="date" value={date} onChange={(e) => { setDate((e.target as HTMLInputElement).value); setConflicts(null); }} />
            </div>
            <div className="space-y-1.5">
              <Label>Hora de inicio</Label>
              <Input type="time" value={startTime} onChange={(e) => { setStartTime((e.target as HTMLInputElement).value); setConflicts(null); }} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Servicios</Label>
            <div className="flex flex-wrap gap-2">
              {services.filter((s) => s.active).map((svc) => (
                <button
                  key={svc.id}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    selectedServices.includes(svc.id)
                      ? "border-primary bg-primary/5 text-primary"
                      : "border-border bg-background text-muted-foreground hover:border-primary/50"
                  )}
                  onClick={() => toggleService(svc.id)}
                >
                  <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: svc.color }} />
                  {svc.name}
                  <span className="text-[10px] opacity-70">{svc.duration}m &middot; ${svc.price}</span>
                </button>
              ))}
            </div>
            {selectedServices.length > 0 && (
              <p className="text-xs font-medium text-primary">
                Total: {totalDuration} min &middot; ${totalPrice.toFixed(2)}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Notas</Label>
            <Textarea rows={3} placeholder="Pedidos especiales, preferencias..." value={notes} onChange={(e) => setNotes((e.target as HTMLTextAreaElement).value)} />
          </div>
        </div>
        {conflicts && (
          <div className="flex gap-2.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" aria-hidden="true" />
            <div className="space-y-1">
              <p className="font-medium">
                {staffLookup.find((s) => String(s.id) === staffId)?.name ?? "Este integrante del equipo"} no está disponible en ese horario.
              </p>
              <ul className="text-muted-foreground">
                {conflicts.map((c) => (
                  <li key={`${c.start_time}-${c.label}`}>{describeConflict(c)}</li>
                ))}
              </ul>
              <p className="text-muted-foreground">Elige otro horario o integrante del equipo, o agéndalo de todas formas.</p>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          {conflicts && (
            <Button variant="outline" disabled={saving} onClick={() => handleSubmit(true)}>
              Agendar de todas formas
            </Button>
          )}
          <Button disabled={saving} onClick={() => handleSubmit()}>
            {saving ? strings.saving : "Crear turno"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
