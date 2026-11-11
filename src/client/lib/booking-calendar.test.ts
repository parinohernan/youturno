import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { bookingCalendarEvent, bookingCalendarFile, calendarCopyWarning, calendarFilename, downloadBookingCalendar, googleCalendarUrl } from "./booking-calendar.ts";

const appointment = { id: 42, identifier: "APT-42", scheduled_date: "2032-02-29", start_time: "22:15", end_time: "23:45", status: "confirmed" };
const context = { companyName: "Casa Oliva", serviceName: "Corte y cuidado", address: "Avenida Ficticia 123" };
const event = bookingCalendarEvent(appointment, context, "booking.example.invalid")!;
const now = new Date("2030-01-02T03:04:05.678Z");
const unfold = (value: string) => value.replace(/\r\n[ \t]/g, "");

test("calendar uses exact persisted UTC start/end, leap date and duration, independent of browser timezone", () => {
  assert.equal(event.start, "20320229T221500Z"); assert.equal(event.end, "20320229T234500Z");
  assert.equal(event.title, "Corte y cuidado · Casa Oliva"); assert.match(event.description, /90 min/);
  assert.ok(event.description.includes(calendarCopyWarning));
  const midnight = bookingCalendarEvent({ ...appointment, start_time: "00:00", end_time: "00:15" }, context, "example.invalid")!;
  assert.equal(midnight.start, "20320229T000000Z"); assert.equal(midnight.end, "20320229T001500Z");
  const original = process.env.TZ;
  try {
    for (const zone of ["America/Argentina/Buenos_Aires", "Pacific/Auckland", "UTC"]) {
      process.env.TZ = zone;
      assert.deepEqual(bookingCalendarEvent(appointment, context, "booking.example.invalid"), event);
    }
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});

test("calendar rejects malformed, nonpersisted, incomplete and reversed/same-time appointments without guessing rollover", () => {
  for (const change of [{ id: -1 }, { id: 0 }, { id: 1.5 }, { id: NaN }, { identifier: " " }, { status: "cancelled" },
    { status: "booked" }, { scheduled_date: "2031-02-29" }, { scheduled_date: "2032-02-30" }, { scheduled_date: "2032-13-01" },
    { scheduled_date: "2032-2-01" }, { scheduled_date: undefined }, { start_time: "24:00" }, { start_time: "22:60" },
    { start_time: "22:15Z" }, { start_time: "9:00" }, { end_time: "22:15" }, { end_time: "00:15" }, { end_time: null }]) {
    assert.equal(bookingCalendarEvent({ ...appointment, ...change } as any, context, "example.invalid"), null, JSON.stringify(change));
  }
  assert.equal(bookingCalendarEvent(null as any, context, "example.invalid"), null);
  for (const bad of [undefined, "a\r\nBEGIN:VEVENT", "a/b", "", "a@example.invalid"]) {
    assert.equal(bookingCalendarEvent(appointment, context, bad as any), null);
  }
  assert.equal(bookingCalendarEvent(appointment, { ...context, serviceName: "" }, "example.invalid"), null);
  assert.equal(bookingCalendarEvent(appointment, null as any, "example.invalid"), null);
});

test("Google template URL encodes public labels and saved dates, excluding unexpected private fields and guessed staff", () => {
  const special = bookingCalendarEvent({ ...appointment, email: "private@example.invalid", contact_phone: "+541199999999", sub: "secret-sub", token: "secret-token" } as any,
    { ...context, serviceName: 'Corte & color, "Élite" + cuidado', address: 'Calle 1; piso 2, Córdoba\nPuerta "B"', staffName: "Cualquiera", email: "company@example.invalid" } as any,
    "example.invalid")!;
  const url = new URL(googleCalendarUrl(special));
  assert.equal(url.origin, "https://calendar.google.com"); assert.equal(url.pathname, "/calendar/r/eventedit");
  assert.equal(url.searchParams.get("action"), "TEMPLATE"); assert.equal(url.searchParams.get("dates"), `${event.start}/${event.end}`);
  assert.equal(url.searchParams.get("stz"), "UTC"); assert.equal(url.searchParams.get("etz"), "UTC");
  assert.equal(url.searchParams.get("text"), special.title); assert.equal(url.searchParams.get("location"), special.location);
  assert.equal(url.searchParams.get("details"), special.description);
  const output = googleCalendarUrl(special) + bookingCalendarFile(special, now);
  for (const privateText of ["private@example.invalid", "+541199999999", "secret-sub", "secret-token", "company@example.invalid", "Cualquiera", "ATTENDEE", "ORGANIZER"]) assert.ok(!output.includes(privateText));
  const noLocation = bookingCalendarEvent(appointment, { ...context, address: null }, "example.invalid")!;
  assert.ok(!new URL(googleCalendarUrl(noLocation)).searchParams.has("location"));
  assert.ok(!bookingCalendarFile(noLocation, now).includes("LOCATION:"));
});

test("ICS has required fields, stable deployment-scoped UID, deterministic UTC stamp and CRLF", () => {
  const file = bookingCalendarFile(event, now);
  assert.equal(unfold(file), ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Youturno//Customer appointment//ES", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT", "UID:appointment-42@booking.example.invalid", "DTSTAMP:20300102T030405Z", "DTSTART:20320229T221500Z", "DTEND:20320229T234500Z",
    "SUMMARY:Corte y cuidado · Casa Oliva", "DESCRIPTION:Turno: APT-42\\nDuración: 90 min\\n\\nEste evento no se actualiza automáticamente si reprograma o cancela su turno.",
    "LOCATION:Avenida Ficticia 123", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n"));
  assert.ok(!file.replaceAll("\r\n", "").match(/[\r\n]/));
  const later = bookingCalendarFile(event, new Date("2030-01-03T00:00:00Z"));
  assert.equal(file.match(/UID:.+/)![0], later.match(/UID:.+/)![0]);
  assert.notEqual(bookingCalendarEvent({ ...appointment, id: 43 }, context, "booking.example.invalid")!.uid, event.uid);
  assert.notEqual(bookingCalendarEvent(appointment, context, "other.example.invalid")!.uid, event.uid);
  assert.equal(bookingCalendarEvent(appointment, context, "BOOKING.EXAMPLE.INVALID")!.uid, event.uid);
});

test("ICS escapes text/injection and folds Unicode to at most 75 UTF-8 octets without corruption", () => {
  const label = 'Élite 💇🏽 日本語 "cuidado", semi; slash\\ fin\r\nBEGIN:VEVENT\rATTENDEE:bad\nOtro' + "💇é日本".repeat(55);
  const special = bookingCalendarEvent({ ...appointment, identifier: "APT-42\r\nEND:VEVENT" }, { companyName: label, serviceName: label, address: label }, "example.invalid")!;
  const file = bookingCalendarFile(special, now), logical = unfold(file);
  const escaped = label.replace(/\r\n?|\n/g, "\n").replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll(";", "\\;").replaceAll(",", "\\,");
  assert.ok(logical.includes(`SUMMARY:${escaped} · ${escaped}\r\n`)); assert.ok(logical.includes(`LOCATION:${escaped}\r\n`));
  assert.match(logical, /DESCRIPTION:Turno: APT-42\\nEND:VEVENT\\nDuración:/);
  assert.equal(logical.split("\r\n").filter((line) => line === "BEGIN:VEVENT").length, 1);
  assert.equal(logical.split("\r\n").filter((line) => line === "END:VEVENT").length, 1);
  assert.ok(!logical.split("\r\n").some((line) => line.startsWith("ATTENDEE:")));
  for (const line of file.split("\r\n")) { assert.ok(Buffer.byteLength(line) <= 75); assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(line)), line); }
});

test("download filenames are safe ASCII and Blob URLs are revoked later on success or failed click", async () => {
  assert.equal(calendarFilename('../../APT-42\r\n"💇.ics'), "turno-APT-42-ics.ics");
  assert.equal(calendarFilename("💇"), "turno-reserva.ics"); assert.ok(calendarFilename("x".repeat(200)).length <= 74);
  const global = globalThis as any, original = { document: global.document, window: global.window, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  try {
    for (const fail of [false, true]) {
      const calls: string[] = []; let blob: Blob | undefined, callback: () => void = () => {};
      const anchor = { href: "", download: "", hidden: false, click() { calls.push("click"); if (fail) throw new Error("blocked"); }, remove() { calls.push("remove"); } };
      URL.createObjectURL = (value: Blob) => { blob = value; calls.push("create"); return "blob:fixture"; };
      URL.revokeObjectURL = (value: string) => { assert.equal(value, "blob:fixture"); calls.push("revoke"); };
      global.document = { createElement: () => anchor, body: { appendChild: () => calls.push("append") } };
      global.window = { setTimeout(fn: () => void, ms: number) { assert.equal(ms, 1000); callback = fn; calls.push("defer"); } };
      if (fail) assert.throws(() => downloadBookingCalendar(event), /blocked/); else downloadBookingCalendar(event);
      assert.deepEqual(calls, ["create", "append", "click", "remove", "defer"]);
      assert.equal(anchor.href, "blob:fixture"); assert.equal(anchor.download, "turno-APT-42.ics"); assert.equal(anchor.hidden, true);
      assert.equal(blob!.type, "text/calendar;charset=utf-8"); assert.match(await blob!.text(), /DTSTART:20320229T221500Z/);
      callback(); assert.equal(calls.at(-1), "revoke");
    }
  } finally { global.document = original.document; global.window = original.window; URL.createObjectURL = original.create; URL.revokeObjectURL = original.revoke; }
});

function nodes(node: any): any[] {
  if (node == null || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}

test("actual chooser is explicit, keyboard dismissible, preview-inert and malformed-data safe", async () => {
  const require = createRequire(import.meta.url), { build } = createRequire(require.resolve("vite"))("esbuild");
  const result = await build({ entryPoints: [new URL("../components/booking-calendar-action.tsx", import.meta.url).pathname], bundle: true, platform: "node", format: "esm", write: false,
    alias: { react: "preact/compat", "react-dom": "preact/compat", "react/jsx-runtime": "preact/jsx-runtime" },
    plugins: [{ name: "calendar-hooks", setup(builder: any) {
      builder.onResolve({ filter: /^preact\/hooks$/ }, (args: any) => args.importer.endsWith("/booking-calendar-action.tsx") ? { path: "hooks", namespace: "calendar-hooks" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "calendar-hooks" }, () => ({ contents: "export function useRef(){return {current:globalThis.__calendarSummary}};export function useState(){return [false,()=>{}]}" }));
    } }] });
  const { BookingCalendarAction } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  const global = globalThis as any, original = global.window;
  let focuses = 0;
  global.__calendarSummary = { focus() { focuses++; } };
  global.window = { location: { hostname: "example.invalid" } };
  try {
    const tree = nodes(BookingCalendarAction({ appointment, context }));
    const summary = tree.find((n) => n.type === "summary"); assert.ok(nodes(summary).includes("Agregar al calendario")); assert.match(summary.props.className, /min-h-11/);
    const link = tree.find((n) => n.type === "a"); assert.equal(new URL(link.props.href).origin, "https://calendar.google.com");
    assert.equal(link.props.target, "_blank"); assert.equal(link.props.rel, "noopener noreferrer");
    assert.ok(tree.includes("Apple, Outlook y otros (.ics)")); assert.ok(tree.includes(calendarCopyWarning));
    const disclosure = tree[0], currentTarget = { open: true }; let stopped = false;
    disclosure.props.onKeyDown({ key: "Escape", currentTarget, stopPropagation() { stopped = true; } });
    assert.equal(currentTarget.open, false); assert.equal(focuses, 1); assert.equal(stopped, true);
    const preview = nodes(BookingCalendarAction({ appointment, context, preview: true }));
    assert.ok(preview.some((n) => n.props?.disabled && nodes(n).includes("Agregar al calendario")));
    assert.ok(preview.includes("Disponible al confirmar un turno real.")); assert.ok(!preview.some((n) => n.props?.href || n.props?.onClick));
    const malformed = nodes(BookingCalendarAction({ appointment: { ...appointment, end_time: "invalid" }, context }));
    assert.ok(malformed.includes("No se pudo preparar el evento de calendario. Consulte los datos en Mis turnos."));
    assert.ok(!malformed.some((n) => n.props?.href || n.props?.onClick));
  } finally { global.window = original; delete global.__calendarSummary; }
});
