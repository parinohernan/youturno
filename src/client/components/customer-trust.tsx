import { customerTrustLabels, type CustomerTrustState } from "../../shared/customer-policy";

const badgeColors: Record<CustomerTrustState, string> = {
  new: "border-yellow-300 bg-yellow-100 text-yellow-900 dark:border-yellow-700 dark:bg-yellow-950 dark:text-yellow-200",
  returning: "border-green-300 bg-green-100 text-green-900 dark:border-green-700 dark:bg-green-950 dark:text-green-200",
  blocked: "border-red-300 bg-red-100 text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200",
};

export function CustomerTrustBadge({ state = "new" }: { state?: CustomerTrustState }) {
  return <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${badgeColors[state]}`} aria-label={`Estado del cliente: ${customerTrustLabels[state]}`}>{customerTrustLabels[state]}</span>;
}

export function CustomerTrustControl({ value, onChange }: { value: CustomerTrustState; onChange: (value: CustomerTrustState) => void }) {
  return <div className="space-y-1.5">
    <label htmlFor="customer-trust" className="text-sm font-medium">Estado del cliente</label>
    <select id="customer-trust" value={value} onChange={(event) => onChange((event.target as HTMLSelectElement).value as CustomerTrustState)}
      aria-describedby="customer-trust-help" className="h-10 w-full rounded-md border bg-background px-3 text-sm">
      {Object.entries(customerTrustLabels).map(([state, label]) => <option key={state} value={state}>{label}</option>)}
    </select>
    <p id="customer-trust-help" className="text-xs text-muted-foreground">Nuevo: un turno pendiente que aún no haya terminado. Una atención finalizada en esta empresa determina la categoría Recurrente, aunque seleccione Nuevo. Bloqueado impide nuevas reservas en línea y tiene prioridad sobre el historial. Los turnos existentes se conservan. La administración puede reservar manualmente.</p>
  </div>;
}
