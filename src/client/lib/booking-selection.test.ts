import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseService, chooseStaff, compatibleSelection } from "./booking-selection.ts";

const staff = [{ id: 1, service_ids: [10] }, { id: 2, service_ids: [20] }, { id: 3, service_ids: [] }];

test("professional first and service first preserve only compatible selections", () => {
  const first = chooseStaff(staff, { serviceId: null, staffId: null }, 1);
  assert.deepEqual(first, { serviceId: null, staffId: 1 });
  assert.deepEqual(chooseService(staff, first, 10), { serviceId: 10, staffId: 1 });
  assert.deepEqual(chooseService(staff, first, 20), { serviceId: 20, staffId: null });
  assert.deepEqual(chooseStaff(staff, { serviceId: 10, staffId: null }, 2), { serviceId: null, staffId: 2 });
  assert.deepEqual(chooseStaff(staff, { serviceId: 10, staffId: 1 }, null), { serviceId: 10, staffId: null });
  assert.deepEqual(chooseService(staff, { serviceId: 10, staffId: 1 }, null), { serviceId: null, staffId: 1 });
});

test("restored intent fails compatibility after removal, missing staff, or empty qualifications", () => {
  assert.equal(compatibleSelection(staff, { serviceId: 10, staffId: 1 }), true);
  assert.equal(compatibleSelection(staff, { serviceId: 10, staffId: 2 }), false);
  assert.equal(compatibleSelection(staff, { serviceId: 10, staffId: 3 }), false);
  assert.equal(compatibleSelection(staff, { serviceId: 10, staffId: 99 }), false);
  assert.equal(compatibleSelection(staff, { serviceId: 10, staffId: null }), true);
  assert.equal(compatibleSelection([{ id: 1, service_ids: [] }], { serviceId: 10, staffId: 1 }), false);
});
