// Shared strings — ONLY strings appearing in >=2 files qualify (admission rule).
// Single-use strings translate in place in their own file (proposal #277 decision 1).
export const strings = {
  saving: "Guardando...",
  nameRequired: "El nombre es obligatorio",
  unassigned: "Sin asignar",
  staffFallback: "Este integrante del equipo",
  unavailableThen: "no está disponible en ese horario.",
  saveChanges: "Guardar cambios",
  dateAtTime: "a las", // connector between "{date}" and "{time}"
} as const;
