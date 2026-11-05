export type View = "dashboard" | "calendar" | "appointments" | "clients" | "staff" | "services" | "products" | "company";

export interface CompanyProfile {
  appearance?: import("../shared/booking-appearance").BookingAppearance;
  cover_url?: string | null;
  social_links: import("../shared/social-links").SocialLinks;
  name: string;
  description: string;
  address: string;
  phone: string;
  public_email: string;
  website: string;
  logo_url: string | null;
  business_hours: WeeklyHours;
}

export type AppointmentStatus = "booked" | "confirmed" | "in_progress" | "completed" | "cancelled" | "no_show";

export interface Appointment {
  id: number;
  identifier: string;
  client_id: number;
  staff_id: number | null;
  status: AppointmentStatus;
  scheduled_date: string;
  start_time: string;
  end_time: string;
  total_price: number;
  notes: string;
  is_recurring: number;
  recurrence_interval: string;
  client_name?: string;
  client_phone?: string;
  staff_name?: string | null;
  staff_color?: string | null;
  service_names?: string | null;
  latest_note?: string | null;
  appointment_services?: AppointmentService[];
  appointment_notes?: AppointmentNote[];
  created_at: string;
  updated_at: string;
}

export interface AppointmentService {
  id: number;
  appointment_id: number;
  service_id: number;
  service_name?: string;
  price: number;
  duration: number;
}

export interface AppointmentNote {
  id: number;
  appointment_id: number;
  content: string;
  created_at: string;
}

export interface Client {
  id: number;
  name: string;
  email: string;
  phone: string;
  notes: string;
  appointment_count?: number;
  created_at: string;
  updated_at: string;
}

export type WeeklyHours = Record<string, [string, string][] | [string, string] | null>;

export interface Staff {
  access_enabled?: number | boolean;
  service_ids: number[];
  id: number;
  name: string;
  email: string;
  phone: string;
  title: string;
  color: string;
  active: number;
  working_hours?: WeeklyHours | null;
  scheduling_mode?: "consecutive" | "fixed" | "service_duration";
  scheduling_interval?: number;
  appointment_count?: number;
  completed_appointment_count?: number;
  completed_service_value?: number;
  created_at: string;
}

export interface Service {
  id: number;
  name: string;
  description: string;
  duration: number;
  price: number;
  color: string;
  category: string;
  active: number;
  created_at: string;
}

export interface BlockedSlot {
  id: number;
  staff_id: number;
  staff_name?: string;
  blocked_date: string;
  start_time: string;
  end_time: string;
  reason: string;
  created_at: string;
}

export interface Product {
  id: number;
  name: string;
  brand: string;
  category: string;
  sku: string;
  price: number;
  cost: number;
  stock: number;
  low_stock_alert: number;
  created_at: string;
  updated_at: string;
}

export interface Stats {
  appointments: number;
  clients: number;
  staff: number;
  services: number;
  products: number;
  today_appointments: number;
  upcoming_appointments: number;
  completed_appointments: number;
  revenue: number;
  low_stock_products: number;
}

export interface PaginatedState {
  page: number;
  limit: number;
  total: number;
}

export interface ClientLookup {
  id: number;
  name: string;
}

export interface StaffLookup {
  id: number;
  name: string;
  color: string;
}
