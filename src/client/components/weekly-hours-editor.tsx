import type { WeeklyHours } from "../types";

export const WEEK_DAYS = [["mon", "Lunes"], ["tue", "Martes"], ["wed", "Miércoles"],
  ["thu", "Jueves"], ["fri", "Viernes"], ["sat", "Sábado"], ["sun", "Domingo"]] as const;

export function dayIntervals(day: WeeklyHours[string] | undefined): [string, string][] {
  if (!day?.length) return [];
  return typeof day[0] === "string" ? [day as [string, string]] : day as [string, string][];
}

export function hoursError(hours: WeeklyHours): string | null {
  for (const [day, label] of WEEK_DAYS) {
    const intervals = [...dayIntervals(hours[day])].sort((a, b) => a[0].localeCompare(b[0]));
    for (let index = 0; index < intervals.length; index++) {
      const [start, end] = intervals[index];
      if (![start, end].every((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) || start >= end)
        return `${label}: indique apertura y cierre válidos (HH:mm), con el cierre posterior a la apertura.`;
      if (index > 0 && start < intervals[index - 1][1]) return `${label}: los intervalos no deben superponerse.`;
    }
  }
  return null;
}

/** Missing personal days inherit; [] explicitly closes a day. */
export function WeeklyHoursEditor({ hours, onChange, personal = false, disabled = false }: {
  hours: WeeklyHours; onChange: (hours: WeeklyHours) => void; personal?: boolean; disabled?: boolean;
}) {
  return <div className="space-y-3">
    <p className="text-xs text-muted-foreground">Horarios en UTC. Los intervalos no deben superponerse. Los intervalos contiguos se unen.</p>
    {personal && <p className="text-xs text-muted-foreground">La disponibilidad siempre se limita al horario de la empresa.</p>}
    {WEEK_DAYS.map(([day, label]) => {
      const intervals = dayIntervals(hours[day]);
      const mode = personal && !(day in hours) ? "inherit" : intervals.length ? "custom" : "closed";
      return <fieldset key={day} disabled={disabled} className="min-w-0 space-y-2 rounded border p-2">
        <legend className="px-1 text-sm font-medium">{label}</legend>
        <select aria-label={`${label}: disponibilidad`} value={mode} className="w-full rounded border bg-background p-2 text-sm"
          onChange={(event) => {
            const next = { ...hours };
            if (event.currentTarget.value === "inherit") delete next[day];
            else next[day] = event.currentTarget.value === "closed" ? [] : [["09:00", "18:00"]];
            onChange(next);
          }}>
          {personal && <option value="inherit">Heredar horario de la empresa</option>}
          <option value="closed">Cerrado</option>
          <option value="custom">Horario personalizado</option>
        </select>
        {intervals.map((pair, index) => <div key={index} className="flex flex-wrap items-center gap-2">
          {([0, 1] as const).map((edge) => <label className="min-w-0 flex-1 text-xs">
            {edge === 0 ? "Desde" : "Hasta"}
            <input type="time" required value={pair[edge]} className="block w-full rounded border bg-background p-2 text-sm"
              aria-label={`${label}: intervalo ${index + 1}, ${edge === 0 ? "apertura" : "cierre"}`}
              onInput={(event) => {
                const next = intervals.map((interval): [string, string] => [...interval]);
                next[index][edge] = event.currentTarget.value;
                onChange({ ...hours, [day]: next });
              }} />
          </label>)}
          <button type="button" className="min-h-11 px-2 text-sm underline" aria-label={`${label}: eliminar intervalo ${index + 1}`}
            onClick={() => onChange({ ...hours, [day]: intervals.filter((_, item) => item !== index) })}>Eliminar</button>
        </div>)}
        {mode === "custom" && <button type="button" className="min-h-11 text-sm underline"
          onClick={() => onChange({ ...hours, [day]: [...intervals, ["", ""]] })}>Agregar intervalo</button>}
      </fieldset>;
    })}
  </div>;
}
