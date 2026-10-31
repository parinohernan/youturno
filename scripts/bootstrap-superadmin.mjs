import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../src/server/auth.ts";

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || process.stdin.isTTY) {
  console.error("Usage: password-manager-command | pnpm bootstrap:local admin@example.com (password via stdin, never CLI arguments)");
  process.exit(1);
}
const password = readFileSync(0, "utf8").replace(/\r?\n$/, "");
const passwordHash = await hashPassword(password);
const quote = (value) => `'${value.replace(/'/g, "''")}'`;
const sql = `INSERT OR IGNORE INTO users (email, password_hash, role)
  SELECT ${quote(email)}, ${quote(passwordHash)}, 'superadmin'
  WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'superadmin') RETURNING id`;
const wrangler = fileURLToPath(new URL("../node_modules/.bin/wrangler", import.meta.url));
const args = ["d1", "execute", "youturno-db", "--local", "--json", "--command", sql];
if (process.env.YOUTURNO_BOOTSTRAP_PERSIST_TO) args.push("--persist-to", process.env.YOUTURNO_BOOTSTRAP_PERSIST_TO);
const result = spawnSync(wrangler, args, { encoding: "utf8" });
if (result.status !== 0) {
  console.error("Local bootstrap failed. Apply schema.sql first and check the local D1 configuration.");
  process.exit(1);
}
// Only a RETURNING row proves that this invocation inserted the account.
const output = JSON.parse(result.stdout);
if (!Array.isArray(output) || !output.some((entry) => entry.results?.some((row) => Number.isSafeInteger(row.id)))) {
  console.error("No account created (an administrator may already exist). Check the database audit before retrying.");
  process.exit(1);
}
console.log("Local superadmin created; auth_audit recorded the bootstrap event.");
