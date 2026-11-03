import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const DEFAULT_HOURS = '{"mon":["09:00","18:00"],"tue":["09:00","18:00"],"wed":["09:00","18:00"],"thu":["09:00","18:00"],"fri":["09:00","18:00"],"sat":["09:00","18:00"],"sun":null}';

/** Add only missing columns; never rebuild or replace existing company rows. */
export function companyUpgrade(columns) {
  if (!columns.length) return "";
  const names = new Set(columns.map((column) => column.name));
  return [
    !names.has("slug") ? "ALTER TABLE companies ADD COLUMN slug TEXT;" : "",
    !names.has("social_links") ? "ALTER TABLE companies ADD COLUMN social_links TEXT NOT NULL DEFAULT '{}';" : "",
    !names.has("business_hours") ? `ALTER TABLE companies ADD COLUMN business_hours TEXT NOT NULL DEFAULT '${DEFAULT_HOURS}';` : "",
    ...["description", "address", "phone", "public_email", "website"].map((field) =>
      !names.has(field) ? `ALTER TABLE companies ADD COLUMN ${field} TEXT NOT NULL DEFAULT '';` : ""),
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_slug ON companies(slug);",
  ].filter(Boolean).join("\n");
}

export function staffUpgrade(columns) {
  return columns.length && !columns.some((column) => column.name === "working_hours")
    ? "ALTER TABLE staff ADD COLUMN working_hours TEXT DEFAULT NULL;" : "";
}

export function admissionUpgrade(columns) {
  return columns.length && !columns.some((column) => column.name === "service_id")
    ? "ALTER TABLE public_booking_admission ADD COLUMN service_id INTEGER REFERENCES services(id);" : "";
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const backup = args[args.indexOf("--backup") + 1];
  if (args.some((arg) => arg === "--remote")) throw new Error("This migration is local-only");
  const wrangler = (...command) => {
    const result = spawnSync("pnpm", ["exec", "wrangler", "d1", ...command], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || "Wrangler failed");
    return result.stdout;
  };
  const rows = JSON.parse(wrangler("execute", "youturno-db", "--local", "--json", "--command", "PRAGMA table_info(companies)"));
  const staffRows = JSON.parse(wrangler("execute", "youturno-db", "--local", "--json", "--command", "PRAGMA table_info(staff)"));
  const admissionRows = JSON.parse(wrangler("execute", "youturno-db", "--local", "--json", "--command", "PRAGMA table_info(public_booking_admission)"));
  const upgrade = [companyUpgrade(rows[0]?.results ?? []), staffUpgrade(staffRows[0]?.results ?? []), admissionUpgrade(admissionRows[0]?.results ?? [])].filter(Boolean).join("\n");
  if (!apply) {
    console.log(upgrade || "No existing columns require upgrade; additive schema/booking guards are still applied with --apply.");
    console.log("Additive schema includes empty staff_services and current-qualification admission guard; no assignments are backfilled.");
    console.log("Additive schema also creates company_booking_appearance (settings and optional cover BLOB); no company designs are populated. Existing rows use defaults.");
    console.log("Preview only. To apply: pnpm migrate:local --apply --backup /absolute/path/to/new-backup.sql (stop the dev server first).");
    return;
  }
  if (!args.includes("--backup") || !backup?.startsWith("/")) throw new Error("--apply requires --backup with an absolute, unused output path");
  if (existsSync(backup)) throw new Error("Backup output already exists; choose a new path");
  wrangler("export", "youturno-db", "--local", "--output", backup);
  if (!statSync(backup).isFile() || statSync(backup).size === 0) throw new Error("Backup is empty or not a regular file; migration aborted");
  // Upgrade existing tables before installing guards that reference new columns.
  if (upgrade) wrangler("execute", "youturno-db", "--local", "--command", upgrade);
  wrangler("execute", "youturno-db", "--local", "--file", "src/server/schema.sql");
  wrangler("execute", "youturno-db", "--local", "--file", "src/server/migrate-legacy.sql");
  console.log("Local migration complete; backup retained at the supplied path.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
