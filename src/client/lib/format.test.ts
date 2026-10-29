import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDate, formatDateTime, formatHour, formatMoney, formatTime } from "./format.ts";

test("formatDate formats a Date", () => {
  assert.equal(formatDate(new Date(2026, 0, 5, 12)), "5 de ene de 2026");
});

test("formatDate keeps the calendar day for bare YYYY-MM-DD strings", () => {
  // Anchored locally (lib/dates noon parse): must not shift to the previous
  // day in negative-offset zones.
  assert.equal(formatDate("2026-01-05"), "5 de ene de 2026");
});

test("formatDate long preset includes the weekday", () => {
  assert.equal(formatDate("2026-01-05", "long"), "lunes, 5 de ene de 2026");
});

test("formatDate falls back to an em dash on missing or invalid input", () => {
  assert.equal(formatDate(""), "—");
  assert.equal(formatDate("not a date"), "—");
  assert.equal(formatDate(null as unknown as string), "—");
});

test("formatDateTime joins the date and 24-hour time", () => {
  assert.equal(formatDateTime(new Date(2026, 4, 6, 14, 30)), "6 de may de 2026, 14:30");
  assert.equal(formatDateTime("garbage"), "—");
});

test("formatTime renders clean 24-hour HH:MM", () => {
  assert.equal(formatTime(new Date(2026, 0, 5, 14, 30)), "14:30");
  assert.equal(formatTime(new Date(2026, 0, 5, 8, 5)), "08:05");
  assert.equal(formatTime("!invalid!"), "—");
});

test("formatHour renders the 24-hour gutter label", () => {
  assert.equal(formatHour(7), "07:00");
  assert.equal(formatHour(14), "14:00");
});

test("formatMoney renders USD with CLDR es-419 decimals", () => {
  assert.equal(formatMoney(1234.56), "$1,234.56");
  assert.equal(formatMoney(0.5), "$0.50");
  assert.equal(formatMoney(Number.NaN), "—");
});
