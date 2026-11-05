import assert from "node:assert/strict";
import { test } from "node:test";
import { actionable, appointmentDuration, bookingUpdates, chronological, nextAppointment, pollDelay, sameSnapshot, snapshot } from "./professional-agenda.ts";
import { contactPhone } from "../../shared/contact-phone.ts";

test("booking alert baseline, deduplication and backoff remain bounded", () => {
  assert.deepEqual(bookingUpdates(null, 20, [19, 20]), { cursor: 20, count: 0 });
  assert.deepEqual(bookingUpdates(20, 24, [19, 21, 21, 24, 25]), { cursor: 24, count: 2 });
  assert.deepEqual(bookingUpdates(24, 24, [21, 24]), { cursor: 24, count: 0 });
  assert.deepEqual(bookingUpdates(24, 20, []), { cursor: 24, count: 0 });
  assert.deepEqual([0, 1, 2, 3, 20].map(pollDelay), [15000, 30000, 60000, 120000, 120000]);
});

test("optimistic action snapshots exclude private fields and detect changed status or times", () => {
  const appointment = { status: "confirmed", scheduled_date: "2037-11-02", start_time: "10:00", end_time: "11:00", client_phone: "private" };
  assert.deepEqual(Object.keys(snapshot(appointment)).sort(), ["end_time", "scheduled_date", "start_time", "status"]);
  assert.equal(sameSnapshot(appointment, { ...appointment, client_phone: "changed" }), true);
  assert.equal(sameSnapshot(appointment, { ...appointment, status: "cancelled" }), false);
  assert.equal(sameSnapshot(appointment, { ...appointment, start_time: "10:30" }), false);
});

test("manual contact normalization preserves local leading zeros and never infers country", () => {
  assert.equal(contactPhone("+54 (11) 5555-0100"), "+541155550100");
  assert.equal(contactPhone("020 1234 5678"), "02012345678");
  for (const value of [null, 55555555, "", "123456", "1234567890123456", "00abc123456", "++123456789", "123.4567", "1234567 ext 2"]) assert.equal(contactPhone(value), null);
});

test("next actionable appointment uses chronological UTC slots, not finished or future-day bookings", () => {
  const base = { status: "confirmed", scheduled_date: "2037-11-02", start_time: "10:00", end_time: "11:00" };
  const later = { ...base, start_time: "12:00", end_time: "13:00" };
  const completed = { ...base, status: "completed", start_time: "09:00" };
  const cancelled = { ...base, status: "cancelled" };
  const bookings = [later, completed, cancelled, base];
  const now = new Date("2037-11-02T10:30:00Z");
  assert.equal(nextAppointment(bookings, base.scheduled_date, now), base);
  assert.equal(nextAppointment(bookings, base.scheduled_date, new Date("2037-11-02T11:00:00Z")), later);
  assert.equal(nextAppointment(bookings, "2037-11-03", now), undefined);
  assert.equal(nextAppointment([completed, cancelled], base.scheduled_date, now), undefined);
  assert.equal(nextAppointment(bookings, base.scheduled_date, new Date("2037-11-02T14:00:00Z")), undefined);
  assert.equal(actionable({ ...base, status: "in_progress" }), true);
  assert.equal(actionable({ ...base, status: "no_show" }), false);
  assert.equal(appointmentDuration({ ...base, start_time: "10:17", end_time: "11:32" }), 75);
  assert.deepEqual(chronological([later, base]), [base, later]);
  assert.deepEqual(bookings, [later, completed, cancelled, base], "sorting never mutates polling data");
});
