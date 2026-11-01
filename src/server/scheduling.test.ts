import { test } from "node:test";
import assert from "node:assert/strict";
import { toMinutes, overlaps, findConflicts, describeConflicts, minutesToTime, weekdayOf, parseBusinessHours, normalizeHours, effectiveWindows, fitsWindows,
  windowOnDate, slotStarts, availableSlots, type Busy, type Interval } from "./scheduling.ts";

const appt = (start_time: string, end_time: string, label = "Jamie Rivera"): Busy =>
  ({ kind: "appointment", start_time, end_time, label });
const block = (start_time: string, end_time: string, label = "Lunch"): Busy =>
  ({ kind: "blocked", start_time, end_time, label });

test("toMinutes reads wall clock, and rejects nonsense", () => {
  assert.equal(toMinutes("00:00"), 0);
  assert.equal(toMinutes("09:30"), 570);
  assert.equal(toMinutes("23:59"), 1439);
  assert.equal(toMinutes("9:05"), 545);
  assert.equal(toMinutes("24:00"), null);
  assert.equal(toMinutes("10:75"), null);
  assert.equal(toMinutes("half ten"), null);
  assert.equal(toMinutes("09:30garbage"), null);
  assert.equal(toMinutes("09:30:99"), null);
  assert.equal(toMinutes(""), null);
});

test("intervals are half-open, so back-to-back is not a clash", () => {
  // The next client sits down the minute the last one gets up.
  assert.equal(overlaps({ start: 600, end: 660 }, { start: 660, end: 720 }), false);
  assert.equal(overlaps({ start: 660, end: 720 }, { start: 600, end: 660 }), false);
  // One minute of genuine overlap is a clash.
  assert.equal(overlaps({ start: 600, end: 661 }, { start: 660, end: 720 }), true);
});

test("overlap is found however the two bookings sit", () => {
  const candidate = ["10:00", "11:00"] as const;
  const clash = (b: Busy) => findConflicts(candidate[0], candidate[1], [b]).length === 1;

  assert.ok(clash(appt("10:00", "11:00")), "identical");
  assert.ok(clash(appt("10:30", "11:30")), "starts inside");
  assert.ok(clash(appt("09:30", "10:30")), "ends inside");
  assert.ok(clash(appt("09:00", "12:00")), "swallows it");
  assert.ok(clash(appt("10:15", "10:45")), "sits inside");
  assert.ok(!clash(appt("11:00", "12:00")), "straight after");
  assert.ok(!clash(appt("09:00", "10:00")), "straight before");
  assert.ok(!clash(appt("14:00", "15:00")), "hours away");
});

test("blocked time is as binding as a booking", () => {
  const found = findConflicts("13:30", "14:30", [block("13:00", "14:00")]);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "blocked");
});

test("every clash is reported, not just the first", () => {
  const found = findConflicts("10:00", "13:00", [
    appt("09:00", "09:30"),   // before
    appt("10:00", "11:00"),
    block("11:30", "12:00"),
    appt("14:00", "15:00"),   // after
  ]);
  assert.deepEqual(found.map((f) => f.start_time), ["10:00", "11:30"]);
});

test("a candidate that does not run forwards conflicts with nothing", () => {
  // Rejecting it is the route's job; answering from a nonsense interval is not.
  assert.deepEqual(findConflicts("14:00", "13:00", [appt("09:00", "20:00")]), []);
  assert.deepEqual(findConflicts("14:00", "14:00", [appt("09:00", "20:00")]), []);
  assert.deepEqual(findConflicts("nope", "11:00", [appt("09:00", "20:00")]), []);
});

test("a stored row that does not run forwards is skipped, not thrown on", () => {
  // Older builds could write these: patching start_time left end_time behind.
  assert.deepEqual(findConflicts("10:00", "11:00", [appt("10:00", "10:00")]), []);
});

test("the message tells the caller what is in the way and how to proceed", () => {
  const msg = describeConflicts("Alex", [appt("10:00", "11:00", "Jamie Rivera")]);
  assert.match(msg, /Alex ya está ocupado en 10:00-11:00 \(Jamie Rivera\)/);
  assert.match(msg, /allow_conflict/);
});

test("the message names the explicit override action for blocked time", () => {
  const msg = describeConflicts("Alex", [appt("10:00", "11:00", "Jamie Rivera")], "block");
  assert.match(msg, /allow_conflict: true para bloquearlo de todas formas/);
});

test("time blocked off reads as unavailable rather than booked", () => {
  assert.match(describeConflicts("Alex", [block("13:00", "14:00", "Lunch")]), /no está disponible en 13:00-14:00 \(Lunch\)/);
  // Mixed causes fall back to the stronger word.
  assert.match(describeConflicts("Alex", [block("13:00", "14:00"), appt("14:00", "15:00")]), /ya está ocupado/);
});

test("the message survives a staff member with no name on file", () => {
  assert.match(describeConflicts("", [appt("10:00", "11:00")]), /^Este integrante del equipo ya está ocupado/);
});

const nineToSix: Interval = { start: 540, end: 1080 };

test("minutesToTime is the inverse of toMinutes", () => {
  assert.equal(minutesToTime(0), "00:00");
  assert.equal(minutesToTime(570), "09:30");
  assert.equal(minutesToTime(1439), "23:59");
});

test("weekdayOf reads an ISO date and rejects a fake one", () => {
  // 2026-11-02 is a Monday (1), and its Sunday is day 0.
  assert.equal(weekdayOf("2026-11-02"), 1);
  assert.equal(weekdayOf("2026-11-01"), 0);
  assert.equal(weekdayOf("2026-02-30"), null, "February never has 30 days");
  assert.equal(weekdayOf("2026-13-01"), null);
  assert.equal(weekdayOf("2026-01-02 "), null);
  assert.equal(weekdayOf("nope"), null);
});

test("business hours degrade to closed when the stored JSON is unusable", () => {
  const closed = { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] };
  assert.deepEqual(parseBusinessHours(null), closed);
  assert.deepEqual(parseBusinessHours("not json"), closed);
  assert.deepEqual(parseBusinessHours("[1,2,3]"), closed);
  // Unknown keys hold nothing, and a window that does not run forwards holds nothing either.
  const rows = parseBusinessHours('{"mon":["09:00","18:00"],"sun":["18:00","09:00"],"xmas":["08:00","12:00"]}');
  assert.deepEqual(rows.mon, [{ start: 540, end: 1080 }]);
  assert.deepEqual(rows.sun, []);
  assert.equal("xmas" in rows, false);
});

test("the day's window follows the weekday and closes when the JSON says so", () => {
  const hours = parseBusinessHours('{"mon":["09:00","18:00"],"sat":["10:00","14:00"],"sun":null}');
  assert.deepEqual(windowOnDate(hours, "2026-11-02"), { start: 540, end: 1080 }, "Monday");
  assert.deepEqual(windowOnDate(hours, "2026-11-07"), { start: 600, end: 840 }, "Saturday");
  assert.equal(windowOnDate(hours, "2026-11-01"), null, "Sunday is closed");
  assert.equal(windowOnDate(parseBusinessHours(null), "2026-11-02"), null, "missing hours means closed");
  assert.equal(windowOnDate(hours, "31-10-2026"), null, "a bad date closes the day, not the shop");
});

test("split windows intersect personal hours without bridging gaps or confusing closed and inherited", () => {
  const hours = parseBusinessHours('{"mon":[["09:00","13:00"],["16:00","20:00"]]}');
  const date = "2026-11-02";
  assert.deepEqual(effectiveWindows(hours, null, date), hours.mon);
  assert.deepEqual(effectiveWindows(hours, '{"tue":null}', date), hours.mon);
  for (const override of ['{"mon":null}', '{"mon":[]}', 'broken', 'null', '{"mon":[["09:00","14:00"],["13:00","18:00"]]}'])
    assert.deepEqual(effectiveWindows(hours, override, date), []);
  const intersected = effectiveWindows(hours, '{"mon":[["08:00","10:00"],["12:00","18:00"]]}', date);
  assert.deepEqual(intersected, [{ start: 540, end: 600 }, { start: 720, end: 780 }, { start: 960, end: 1080 }]);
  assert.equal(fitsWindows(intersected, 720, 60), true);
  assert.equal(fitsWindows(intersected, 750, 60), false);
  assert.equal(fitsWindows(intersected, 780, 180), false);
  assert.equal(fitsWindows(intersected, 960, 120), true);
  assert.equal(fitsWindows(intersected, 960, 121), false);
  assert.equal(fitsWindows(intersected, 960, 0), false);
});

test("schedule edits are strict, sorted and merge adjacency but reject overlaps", () => {
  assert.deepEqual(normalizeHours({ mon: [["13:00", "18:00"], ["09:00", "13:00"]], sun: null }, true),
    { mon: [["09:00", "18:00"]], sun: [] });
  assert.deepEqual(normalizeHours({ mon: ["09:00", "18:00"] }, true), { mon: [["09:00", "18:00"]] });
  for (const mon of [[["09:00", "14:00"], ["13:00", "18:00"]], [["9:00", "18:00"]], [["09:00", "09:00"]], [["18:00", "09:00"]], [["09:00", "24:00"]], ["09:00"], [["09:00", "18:00", "20:00"]]])
    assert.equal(normalizeHours({ mon }, true), null);
  assert.equal(normalizeHours({ mon: [] }), null, "company edits require every weekday");
  assert.equal(normalizeHours({ holiday: [] }, true), null);
});

test("slot starts align to half hours and the whole service must fit", () => {
  // 60-minute service in 09:00-18:00: first at 09:00, last at 17:00.
  assert.deepEqual(slotStarts(nineToSix, 60)[0], "09:00");
  assert.deepEqual(slotStarts(nineToSix, 60).at(-1), "17:00");
  const all = slotStarts(nineToSix, 60);
  assert.equal(all.length, 17);
  assert.ok(all.every((time) => /^(09|1[0-7]):[0-3]0$/.test(time)), "only :00 and :30 appear");
  assert.deepEqual(slotStarts(nineToSix, 540), ["09:00"], "a 9-hour service opens exactly once");
  assert.deepEqual(slotStarts(nineToSix, 541), [], "anything longer than the window never fits");
  assert.deepEqual(slotStarts(nineToSix, 0), [], "a zero-length service cannot be booked");
});

test("a time survives when at least one staff member is free for it", () => {
  const { start, end } = nineToSix;
  // Only Ana on staff: her 10:00-11:00 booking removes 09:30, 10:00 and 10:30.
  const solo = availableSlots({ start, end }, 60, [
    [appt("10:00", "11:00", "Ana's booking")],
  ]);
  assert.ok(!solo.includes("10:00") && !solo.includes("09:30") && !solo.includes("10:30"));
  assert.ok(solo.includes("09:00") && solo.includes("11:00"));
  // Ana and Ben: Ben free at 10:00 keeps that start time bookable.
  const pair = availableSlots({ start, end }, 60, [
    [appt("10:00", "11:00", "Ana's booking")],
    [],
  ]);
  assert.ok(pair.includes("10:00"));
  // Blocked time is as binding as a booking.
  const blocked = availableSlots({ start, end }, 60, [
    [block("13:00", "14:00", "Lunch")],
  ]);
  assert.ok(!blocked.includes("13:00") && !blocked.includes("12:30") && !blocked.includes("13:30"));
  assert.ok(blocked.includes("12:00") && blocked.includes("14:00"));
  // Nobody on staff: nothing is bookable.
  assert.deepEqual(availableSlots({ start, end }, 60, []), []);
});
