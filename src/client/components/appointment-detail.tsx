import { useState } from "preact/hooks";
import { useApp } from "../context";
import { ArrowLeft, Trash2, Send, Clock, User, DollarSign } from "lucide-preact";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "./status-badge";
import { RescheduleAppointment } from "./reschedule-appointment";
import { conflictsFrom, conflictSentence } from "@/lib/conflicts";

export function AppointmentDetail() {
  const {
    selectedAppointment: apt, navigate, updateAppointment, deleteAppointment,
    addAppointmentNote, deleteAppointmentNote, staffLookup, setError,
  } = useApp();
  const [noteText, setNoteText] = useState("");
  const [rescheduling, setRescheduling] = useState(false);

  if (!apt) return null;

  // Reassigning can now be refused, because the new person may already be busy.
  const save = async (patch: Partial<typeof apt>) => {
    try {
      await updateAppointment(apt.id, patch);
    } catch (err) {
      const clashes = conflictsFrom(err);
      setError(clashes
        ? conflictSentence(staffLookup.find((s) => s.id === patch.staff_id)?.name ?? "", clashes)
        : (err as Error).message);
    }
  };

  const handleStatusChange = (status: string) => save({ status } as Partial<typeof apt>);
  const handleStaffChange = (staffId: string) => save({ staff_id: staffId ? parseInt(staffId) : null } as Partial<typeof apt>);

  const handleAddNote = async () => {
    if (!noteText.trim()) return;
    await addAppointmentNote(apt.id, noteText.trim());
    setNoteText("");
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/appointments")}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Volver
        </Button>
        <h1 className="flex-1 text-2xl font-bold">{apt.identifier}</h1>
        <StatusBadge status={apt.status} />
        <Button variant="destructive" size="sm" onClick={() => deleteAppointment(apt.id)}>
          <Trash2 className="mr-1 h-3.5 w-3.5" /> Eliminar
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Detalles del turno</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label className="flex items-center gap-1.5 text-xs text-muted-foreground"><Clock className="h-3 w-3" /> Fecha y hora</Label>
                  <p className="text-sm font-medium">{apt.scheduled_date} a las {apt.start_time} - {apt.end_time}</p>
                  <Button variant="outline" size="sm" className="px-2" onClick={() => setRescheduling(true)}>Reprogramar</Button>
                </div>
                <div className="space-y-1">
                  <Label className="flex items-center gap-1.5 text-xs text-muted-foreground"><User className="h-3 w-3" /> Cliente</Label>
                  <button className="text-sm font-medium text-primary hover:underline" onClick={() => navigate(`/clients/${apt.client_id}`)}>
                    {apt.client_name}
                  </button>
                  {apt.client_phone && <p className="text-xs text-muted-foreground">{apt.client_phone}</p>}
                </div>
              </div>
              <Separator />
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Equipo</Label>
                  <select className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={apt.staff_id || ""} onChange={(e) => handleStaffChange((e.target as HTMLSelectElement).value)}>
                    <option value="">Sin asignar</option>
                    {staffLookup.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Estado</Label>
                  <select className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={apt.status} onChange={(e) => handleStatusChange((e.target as HTMLSelectElement).value)}>
                    <option value="booked">Reservado</option>
                    <option value="confirmed">Confirmado</option>
                    <option value="in_progress">En curso</option>
                    <option value="completed">Completado</option>
                    <option value="cancelled">Cancelado</option>
                    <option value="no_show">No asistió</option>
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="flex items-center gap-1.5 text-xs text-muted-foreground"><DollarSign className="h-3 w-3" /> Total</Label>
                <p className="text-lg font-bold">${apt.total_price.toFixed(2)}</p>
              </div>
              {apt.notes && (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Notas</Label>
                  <p className="text-sm">{apt.notes}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Servicios</CardTitle>
            </CardHeader>
            <CardContent>
              {(!apt.appointment_services || apt.appointment_services.length === 0) ? (
                <p className="text-sm text-muted-foreground">Aún no hay servicios</p>
              ) : (
                <div className="space-y-2">
                  {apt.appointment_services.map((svc) => (
                    <div key={svc.id} className="flex items-center justify-between text-sm">
                      <span>{svc.service_name || `Servicio #${svc.service_id}`}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{svc.duration} min</span>
                        <span className="font-medium">${svc.price.toFixed(2)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Actividad</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-2">
                <Input
                  placeholder="Agregar una nota..."
                  value={noteText}
                  onChange={(e) => setNoteText((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddNote()}
                />
                <Button variant="outline" size="icon" onClick={handleAddNote}>
                  <Send className="h-4 w-4" />
                </Button>
              </div>
              {(!apt.appointment_notes || apt.appointment_notes.length === 0) ? (
                <p className="text-sm text-muted-foreground">Aún no hay notas</p>
              ) : (
                <div className="space-y-2">
                  {apt.appointment_notes.map((note) => (
                    <div key={note.id} className="rounded-md border bg-muted/30 p-2.5">
                      <p className="text-sm">{note.content}</p>
                      <div className="mt-1 flex items-center justify-between">
                        <span className="text-[10px] text-muted-foreground">{new Date(note.created_at).toLocaleString()}</span>
                        <Button variant="ghost" size="icon" className="h-5 w-5 text-muted-foreground hover:text-destructive" onClick={() => deleteAppointmentNote(note.id)}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
      {rescheduling && <RescheduleAppointment key={apt.id} appointment={apt} onClose={() => setRescheduling(false)} />}
    </div>
  );
}
