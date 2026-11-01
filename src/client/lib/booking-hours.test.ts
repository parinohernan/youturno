import assert from "node:assert/strict";
import { test } from "node:test";
import { bookingHours } from "./booking-hours.ts";
import { chooseService, chooseStaff } from "./booking-selection.ts";

const staff = [
  { id: 1, service_ids: [10], effective_hours: { mon: [["09:00", "12:00"], ["16:00", "18:00"]] } },
  { id: 2, service_ids: [10, 20], effective_hours: { mon: [["11:00", "13:00"], ["18:00", "19:00"]] } },
  { id: 3, service_ids: [20], effective_hours: { mon: [["14:00", "15:00"]] } },
  { id: 4, service_ids: [], effective_hours: { mon: [["00:00", "23:59"]] } },
] as Parameters<typeof bookingHours>[0];

test("any professional unions eligible hours, merging overlap and adjacency but preserving gaps", () => {
  const result = bookingHours(staff, { serviceId: 10, staffId: null });
  assert.equal(result.candidateCount, 2);
  assert.deepEqual(result.hours.mon, [["09:00", "13:00"], ["16:00", "19:00"]]);
  assert.deepEqual(result.hours.sun, []);
  assert.deepEqual(staff[0].effective_hours.mon, [["09:00", "12:00"], ["16:00", "18:00"]], "does not mutate overview");
});

test("disjoint eligible staff hours remain separate", () => {
  assert.deepEqual(bookingHours(staff, { serviceId: 20, staffId: null }).hours.mon,
    [["11:00", "13:00"], ["14:00", "15:00"], ["18:00", "19:00"]]);
});

test("unselected schedule includes only publicly bookable professionals", () => {
  const result = bookingHours(staff, { serviceId: null, staffId: null });
  assert.equal(result.candidateCount, 3);
  assert.deepEqual(result.hours.mon, [["09:00", "13:00"], ["14:00", "15:00"], ["16:00", "19:00"]]);
  assert.deepEqual(bookingHours(staff, { serviceId: null, staffId: 4 }).hours.mon, [["00:00", "23:59"]],
    "an explicitly selected professional shows their own hours even before choosing a service");
});

test("empty and incompatible candidates never fall back to company hours", () => {
  for (const selection of [{ serviceId: 99, staffId: null }, { serviceId: 20, staffId: 1 }, { serviceId: null, staffId: 99 }]) {
    const result = bookingHours(staff, selection);
    assert.equal(result.candidateCount, 0);
    assert.ok(Object.values(result.hours).every((day) => Array.isArray(day) && day.length === 0));
  }
  assert.equal(bookingHours([], { serviceId: null, staffId: null }).candidateCount, 0);
});

test("selection transitions derive fresh schedules from the latest service, professional and overview", () => {
  let selection = chooseStaff(staff, { serviceId: null, staffId: null }, 1);
  assert.deepEqual(bookingHours(staff, selection).hours.mon, staff[0].effective_hours.mon);
  selection = chooseService(staff, selection, 20);
  assert.deepEqual(selection, { serviceId: 20, staffId: null });
  assert.deepEqual(bookingHours(staff, selection).hours.mon, [["11:00", "13:00"], ["14:00", "15:00"], ["18:00", "19:00"]]);
  selection = chooseStaff(staff, selection, 3);
  assert.deepEqual(bookingHours(staff, selection).hours.mon, [["14:00", "15:00"]]);
  assert.deepEqual(bookingHours([{ ...staff[2], effective_hours: { mon: [] } }], selection).hours.mon, []);
});
