/** Customer-safe projection: no client contacts, private notes or staff history. */
export interface CustomerAppointment {
  id: number;
  identifier: string;
  status: string;
  scheduled_date: string;
  start_time: string;
  end_time: string;
  staff_name: string | null;
  services: string[];
  total_price: number;
  duration: number;
  version: string;
  can_cancel: boolean;
  can_reschedule: boolean;
}

/** Pending appointments remain visible until their scheduled UTC end, exclusive. */
export function isUpcomingCustomerAppointment(
  appointment: Pick<CustomerAppointment, "scheduled_date" | "end_time">,
  now: Date,
): boolean {
  return Date.parse(`${appointment.scheduled_date}T${appointment.end_time}:00Z`) > now.getTime();
}
