import { useState } from "preact/hooks";
import { useApp } from "../context";
import { ArrowLeft, Trash2, Save, Mail, Phone, Plus } from "lucide-preact";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "./status-badge";
import { CreateAppointment } from "./create-appointment";
import { CustomerTrustBadge, CustomerTrustControl } from "./customer-trust";
import { strings } from "@/lib/strings";
import { formatMoney, formatDate, formatDateTime } from "@/lib/format";

export function ClientDetail() {
  const { selectedClient: client, selectedClientAppointments: appointments, navigate, updateClient, deleteClient } = useApp();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(client?.name || "");
  const [email, setEmail] = useState(client?.email || "");
  const [phone, setPhone] = useState(client?.phone || "");
  const [notes, setNotes] = useState(client?.notes || "");
  const [trustState, setTrustState] = useState(client?.trust_state || "new");
  const [trustChanged, setTrustChanged] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  if (!client) return null;

  const handleSave = async () => {
    if (saving) return;
    setSaving(true); setSaveError("");
    try {
      await updateClient(client.id, { name, email, phone, notes, ...(trustChanged ? { trust_state: trustState } : {}) });
      setEditing(false);
    } catch (cause) { setSaveError((cause as Error).message || "No se pudieron guardar los cambios."); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate("/clients")}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Volver
        </Button>
        <h1 className="min-w-0 flex-1 text-2xl font-bold">{client.name}</h1>
        <div className="flex w-full gap-2 sm:w-auto">
          <Button size="sm" className="flex-1 sm:flex-none" onClick={() => setShowCreate(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Reservar turno
          </Button>
          <Button variant="destructive" size="sm" className="flex-1 sm:flex-none" onClick={() => deleteClient(client.id)}>
            <Trash2 className="mr-1 h-3.5 w-3.5" /> Eliminar
          </Button>
        </div>
      </div>

      <CustomerTrustBadge state={client.trust_state} />
      {client.trust_state === "blocked" && <p className="text-sm" role="note">Las reservas en línea están bloqueadas. Reservar turno desde esta ficha es una excepción manual de la administración; no cambia el estado ni cancela turnos existentes.</p>}

      {showCreate && (
        <CreateAppointment
          defaultClientId={client.id}
          onClose={() => setShowCreate(false)}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Datos</CardTitle>
            {!editing ? (
              <Button variant="outline" size="sm" onClick={() => { setTrustState(client.trust_state || "new"); setTrustChanged(false); setEditing(true); }}>Editar</Button>
            ) : (
              <Button size="sm" disabled={saving} onClick={handleSave}><Save className="mr-1 h-3.5 w-3.5" /> {saving ? "Guardando…" : "Guardar"}</Button>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
            {editing ? (
              <>
                <div className="space-y-1.5"><Label>Nombre</Label><Input value={name} onChange={(e) => setName((e.target as HTMLInputElement).value)} /></div>
                <div className="space-y-1.5"><Label>Correo electrónico</Label><Input value={email} onChange={(e) => setEmail((e.target as HTMLInputElement).value)} /></div>
                <div className="space-y-1.5"><Label>Teléfono</Label><Input value={phone} onChange={(e) => setPhone((e.target as HTMLInputElement).value)} /></div>
                <div className="space-y-1.5"><Label>Notas</Label><Textarea rows={3} value={notes} onChange={(e) => setNotes((e.target as HTMLTextAreaElement).value)} /></div>
                <CustomerTrustControl value={trustState} onChange={(value) => { setTrustState(value); setTrustChanged(true); }} />
              </>
            ) : (
              <>
                {client.email && (
                  <div className="flex items-center gap-2 text-sm">
                    <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                    {client.email}
                  </div>
                )}
                {client.phone && (
                  <div className="flex items-center gap-2 text-sm">
                    <Phone className="h-3.5 w-3.5 text-muted-foreground" />
                    {client.phone}
                  </div>
                )}
                {client.notes && <p className="text-sm text-muted-foreground">{client.notes}</p>}
                <p className="text-xs text-muted-foreground">Cliente desde {formatDate(client.created_at)}</p>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Historial de turnos</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y lg:hidden">
              {appointments.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">Aún no hay turnos</p>}
              {appointments.map((apt) => (
                <button
                  key={apt.id}
                  type="button"
                  className="w-full p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={() => navigate(`/appointments/${apt.id}`)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground"></p>
                      <p className="font-medium">{apt.service_names || "—"}</p>
                      {apt.latest_note && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{apt.latest_note}</p>}
                    </div>
                    <StatusBadge status={apt.status} />
                  </div>
                  <div className="mt-3 flex items-center justify-between text-sm">
                    <span className="flex items-center gap-1.5">
                      {apt.staff_name && <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: apt.staff_color || "#7c3aed" }} />}
                      <span>{apt.staff_name || "—"}</span>
                    </span>
                    <span className="font-medium">{formatMoney(apt.total_price)}</span>
                  </div>
                </button>
              ))}
            </div>
            <div className="hidden lg:block">
              <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Visita</TableHead>
                  <TableHead>Equipo</TableHead>
                  <TableHead className="w-24">Estado</TableHead>
                  <TableHead className="w-20 text-right">Precio</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {appointments.length === 0 && (
                  <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">Aún no hay turnos</TableCell></TableRow>
                )}
                {appointments.map((apt) => (
                  <TableRow key={apt.id} className="cursor-pointer" onClick={() => navigate(`/appointments/${apt.id}`)}>
                    <TableCell className="min-w-52">
                      <p className="text-xs text-muted-foreground"></p>
                      <p className="font-medium">{apt.service_names || "—"}</p>
                      {apt.latest_note && <p className="mt-1 line-clamp-2 max-w-md text-xs text-muted-foreground">{apt.latest_note}</p>}
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-1.5">
                        {apt.staff_name && <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: apt.staff_color || "#7c3aed" }} />}
                        <span className="text-sm">{apt.staff_name || "—"}</span>
                      </span>
                    </TableCell>
                    <TableCell><StatusBadge status={apt.status} /></TableCell>
                    <TableCell className="text-right">{formatMoney(apt.total_price)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
