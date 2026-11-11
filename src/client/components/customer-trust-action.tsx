import { useRef, useState } from "preact/hooks";
import { customerTrustLabels, type CustomerTrustState } from "../../shared/customer-policy";
import { CustomerTrustBadge } from "./customer-trust";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "./ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./ui/dialog";

export function CustomerTrustAction({ client, updateClient, disabled = false }: {
  client: { id: number; name: string; trust_state?: CustomerTrustState };
  updateClient: (id: number, data: { trust_state: CustomerTrustState }) => Promise<void>;
  disabled?: boolean;
}) {
  const state = client.trust_state ?? "new";
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const saving = useRef(false);
  const openingDialog = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  async function save(next: CustomerTrustState) {
    if (saving.current || disabled || next === state) return;
    saving.current = true;
    setPending(true);
    setError("");
    setNotice("");
    try {
      await updateClient(client.id, { trust_state: next });
      setNotice(next === "new" ? "Estado actualizado. Si tiene una atención finalizada en esta empresa, se conserva como Recurrente." : `Estado actualizado: ${customerTrustLabels[next]}.`);
      setConfirmBlock(false);
    } catch {
      setError("No se pudo actualizar el estado. Compruebe su conexión y sus permisos, y vuelva a intentarlo. Si el problema continúa, recargue la página para verificar el estado actual.");
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  function select(next: CustomerTrustState) {
    if (saving.current || disabled || next === state) return;
    setError("");
    setNotice("");
    if (next === "blocked") {
      openingDialog.current = true;
      setConfirmBlock(true);
    } else {
      void save(next);
    }
  }

  const stop = (event: Event) => event.stopPropagation();
  return <div className="min-w-0" onClick={stop} onPointerDown={stop} onKeyDown={stop} onKeyUp={stop}>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button ref={trigger} type="button" disabled={disabled || pending} aria-busy={pending}
          aria-label={`Cambiar estado de ${client.name}. Estado actual: ${customerTrustLabels[state]}`}
          className="inline-flex min-h-11 min-w-11 items-center gap-2 rounded-md px-2 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60">
          <CustomerTrustBadge state={state} />
          <span aria-hidden="true" className="text-xs">{pending ? "Guardando…" : "▾"}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-[calc(100vw-2rem)]" onClick={stop} onKeyDown={stop}
        onCloseAutoFocus={(event) => {
          if (openingDialog.current) { event.preventDefault(); openingDialog.current = false; }
        }}>
        <DropdownMenuRadioGroup value={state} onValueChange={(next) => select(next as CustomerTrustState)} aria-label={`Cambiar estado de ${client.name}`}>
          {Object.entries(customerTrustLabels).map(([value, label]) => <DropdownMenuRadioItem key={value} value={value} disabled={disabled || pending} className="min-h-11">{label}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    <div role="status" aria-live="polite" className="max-w-xs whitespace-normal break-words text-xs text-muted-foreground">{pending ? "Guardando estado…" : notice}</div>
    {error && !confirmBlock && <p role="alert" className="max-w-xs whitespace-normal break-words text-xs text-destructive">{error}</p>}
    <Dialog open={confirmBlock} onOpenChange={(open) => { if (!saving.current) setConfirmBlock(open); }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg grid-cols-[minmax(0,1fr)] overflow-y-auto" onClick={stop} onKeyDown={stop}
        onOpenAutoFocus={(event) => { event.preventDefault(); cancel.current?.focus(); }}
        onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus(); }}>
        <DialogHeader className="min-w-0">
          <DialogTitle className="break-words pr-6">¿Bloquear a {client.name}?</DialogTitle>
          <DialogDescription>No podrá realizar nuevas reservas en línea. Sus turnos existentes se conservan y no se cancelan. La administración podrá seguir reservando manualmente.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter className="gap-2">
          <Button ref={cancel} variant="outline" className="min-h-11" disabled={pending} onClick={() => setConfirmBlock(false)}>Cancelar</Button>
          <Button variant="destructive" className="min-h-11" disabled={pending} onClick={() => void save("blocked")}>{pending ? "Guardando…" : "Confirmar bloqueo"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
