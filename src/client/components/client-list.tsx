import { useState } from "preact/hooks";
import { useApp } from "../context";
import { Plus, Search, Trash2 } from "lucide-preact";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pagination } from "./pagination";
import { CreateClient } from "./create-client";
import { CustomerTrustAction } from "./customer-trust-action";

export function ClientList() {
  const { clients, clientsPag, setClientsPage, clientsSearch, setClientsSearch, deleteClient, updateClient, navigate, loading } = useApp();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="min-w-0 space-y-4 p-4 sm:p-6">
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
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead className="hidden w-44 md:table-cell">Correo electrónico</TableHead>
                <TableHead className="hidden w-28 sm:table-cell">Teléfono</TableHead>
                <TableHead className="hidden w-24 text-center sm:table-cell">Visitas</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.length === 0 && (
                <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">No se encontraron clientes</TableCell></TableRow>
              )}
              {clients.map((c) => (
                <TableRow key={c.id} className="cursor-pointer" onClick={() => navigate(`/clients/${c.id}`)}>
                  <TableCell className="font-medium"><span className="block break-words [overflow-wrap:anywhere]">{c.name}</span><CustomerTrustAction client={c} updateClient={updateClient} disabled={loading} /></TableCell>
                  <TableCell className="hidden break-words text-sm text-muted-foreground md:table-cell">{c.email || "—"}</TableCell>
                  <TableCell className="hidden break-words text-sm sm:table-cell">{c.phone || "—"}</TableCell>
                  <TableCell className="hidden text-center sm:table-cell">{c.appointment_count || 0}</TableCell>
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
