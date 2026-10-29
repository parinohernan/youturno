import { get, run } from "./db.js";

/**
 * Sample data + the appointment counter rows.
 *
 * These used to live at the bottom of schema.sql, but Clawnify applies that
 * file as DDL only — a single INSERT there fails the entire deploy. They run
 * from the app instead, on the first request an isolate serves.
 */

type StaffSeed = [id: number, name: string, email: string, title: string, color: string];
type ServiceSeed = [id: number, name: string, description: string, duration: number, price: number, color: string, category: string];
type ClientSeed = [id: number, name: string, email: string, phone: string];
type ProductSeed = [id: number, name: string, brand: string, category: string, price: number, cost: number, stock: number];

const STAFF: StaffSeed[] = [
  [1, "Alex", "alex@example.com", "Estilista senior", "#3b82f6"],
  [2, "Jordan", "jordan@example.com", "Terapeuta", "#10b981"],
  [3, "Sam", "sam@example.com", "Especialista", "#f59e0b"],
  [4, "Taylor", "taylor@example.com", "Estilista junior", "#8b5cf6"],
];

// Generic so they work across verticals.
const SERVICES: ServiceSeed[] = [
  [1, "Corte de pelo", "Corte clásico", 60, 50, "#3b82f6", "General"],
  [2, "Corte + barba", "Turno corto", 30, 30, "#10b981", "General"],
  [3, "Tratamiento premium", "Servicio premium extendido", 90, 85, "#8b5cf6", "Premium"],
  [4, "Arreglo express", "Servicio rápido de 15 minutos", 15, 20, "#f59e0b", "Express"],
  [5, "Consulta", "Consulta inicial", 30, 0, "#6b7280", "General"],
  [6, "Paquete", "Varios servicios combinados", 120, 120, "#ec4899", "Premium"],
];

const CLIENTS: ClientSeed[] = [
  [1, "Jamie Rivera", "jamie@example.com", "555-0101"],
  [2, "Casey Morgan", "casey@example.com", "555-0102"],
  [3, "Riley Chen", "riley@example.com", "555-0103"],
  [4, "Dakota Smith", "dakota@example.com", "555-0104"],
];

const PRODUCTS: ProductSeed[] = [
  [1, "Shampoo profesional", "ProCare", "Cuidado del cabello", 24.99, 12.0, 25],
  [2, "Gel de peinado", "ProCare", "Estilizado", 15.99, 7.5, 40],
  [3, "Crema hidratante", "SkinLux", "Cuidado de la piel", 32.99, 16.0, 18],
  [4, "Set de aceites esenciales", "AromaPlus", "Bienestar", 45.99, 22.0, 12],
];

let seeded = false;

/** Insert `rows` into `table` only while it is still empty. */
async function seedIfEmpty(table: string, columns: string[], rows: readonly unknown[][]): Promise<void> {
  const existing = await get<{ count: number }>(`SELECT COUNT(*) as count FROM ${table}`);
  if ((existing?.count ?? 0) > 0) return;
  const placeholders = rows.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
  await run(
    `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES ${placeholders}`,
    rows.flat(),
  );
}

/**
 * Idempotent. The demo tables are only seeded while still empty, so a redeploy
 * never resurrects a row the user deleted; the _meta rows are INSERT OR IGNORE
 * so an existing counter is never reset.
 */
export async function ensureSeeded(): Promise<void> {
  if (seeded) return;
  try {
    await run("INSERT OR IGNORE INTO _meta (key, value) VALUES ('appointment_counter', '0')");
    await run("INSERT OR IGNORE INTO _meta (key, value) VALUES ('appointment_prefix', 'APT')");
    await seedIfEmpty("staff", ["id", "name", "email", "title", "color"], STAFF);
    await seedIfEmpty("services", ["id", "name", "description", "duration", "price", "color", "category"], SERVICES);
    await seedIfEmpty("clients", ["id", "name", "email", "phone"], CLIENTS);
    await seedIfEmpty("products", ["id", "name", "brand", "category", "price", "cost", "stock"], PRODUCTS);
    seeded = true;
  } catch {
    // Sample data must never fail a request; retry on the next one.
    seeded = false;
  }
}
