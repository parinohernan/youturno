import assert from "node:assert/strict";
import { test } from "node:test";
import { isUpcomingCustomerAppointment } from "./customer-bookings.ts";

test("pending visibility compares exact UTC ends, excluding the current end instant", () => {
  const check = (scheduled_date: string, end_time: string, now: string) =>
    isUpcomingCustomerAppointment({ scheduled_date, end_time }, new Date(now));
  const noon = "2037-11-01T12:00:00Z";
  assert.equal(check("2037-10-31", "23:59", noon), false);
  assert.equal(check("2037-11-01", "11:59", noon), false);
  assert.equal(check("2037-11-01", "12:00", noon), false);
  assert.equal(check("2037-11-01", "12:01", noon), true);
  assert.equal(check("2037-11-02", "00:00", noon), true);
  assert.equal(check("2037-11-01", "12:00", "2037-11-01T12:00:00.001Z"), false);
  assert.equal(check("2037-11-01", "23:59", "2037-11-02T00:00:00Z"), false);
  assert.equal(check("2037-11-02", "00:00", "2037-11-02T00:00:00Z"), false);
});
