export type CustomerTrustState = "new" | "returning" | "blocked";
export type CustomerPolicyCode = "CUSTOMER_BLOCKED" | "CUSTOMER_ACTIVE_LIMIT";

export const customerTrustLabels: Record<CustomerTrustState, string> = {
  new: "Nuevo", returning: "Recurrente", blocked: "Bloqueado",
};

export const customerPolicyMessages: Record<CustomerPolicyCode, string> = {
  CUSTOMER_BLOCKED: "La reserva en línea no está disponible para su cuenta en esta empresa. Contacte a la empresa para recibir asistencia.",
  CUSTOMER_ACTIVE_LIMIT: "Ya tiene un turno reservado",
};
