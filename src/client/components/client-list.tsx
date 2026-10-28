import { useState } from "preact/hooks";
import { useApp } from "../context";
import { Plus, Search, Trash2 } from "lucide-preact";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pagination } from "./pagination";
import { CreateClient } from "./create-client";

export function ClientList() {
  const { clients, clientsPag, setClientsPage, clientsSearch, setClientsSearch, deleteClient, navigate } = useApp();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Clientes</h1>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Agregar cliente
        </Button>
      </div>

      {showCreate && <CreateClient onClose={() => setShowCreate(false)} />}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="Buscar clientes..." value={clientsSearch} onInput={(e) => setClientsSearch((e.target as HTMLInputElement).value)} />
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead className="w-44">Correo electrónico</TableHead>
                <TableHead className="w-28">Teléfono</TableHead>
                <TableHead className="w-24 text-center">Visitas</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.length === 0 && (
                <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">No se encontraron clientes</TableCell></TableRow>
              )}
              {clients.map((c) => (
                <TableRow key={c.id} className="cursor-pointer" onClick={() => navigate(`/clients/${c.id}`)}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{c.email || "—"}</TableCell>
                  <TableCell className="text-sm">{c.phone || "—"}</TableCell>
                  <TableCell className="text-center">{c.appointment_count || 0}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={(e) => { e.stopPropagation(); deleteClient(c.id); }}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Pagination pag={clientsPag} setPage={setClientsPage} />
    </div>
  );
}
