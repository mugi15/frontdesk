import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addWorkingMinutes, priorityTargets, sameWorkingDayDeadline, workingMinutesBetween, workingTimeBreakdown,
  WORKDAY_MINUTES
} from '../src/business-clock.mjs';

const ist = (date, time) => new Date(`${date}T${time}:00+05:30`);
const friday = '2026-11-20';
const holidayMonday = '2026-11-23';
const holidays = new Set([holidayMonday]);

for (const [name, date, time, minutes, expectedDate, expectedTime, calendar] of [
  ['Friday urgent reply crosses the weekend', friday, '18:00', 120, '2026-11-23', '11:00'],
  ['Friday urgent reply also skips a Monday holiday', friday, '18:00', 120, '2026-11-24', '11:00', holidays],
  ['starts at opening for a ticket opened before hours', friday, '07:00', 120, friday, '11:30'],
  ['uses the next opening when the ticket arrives exactly at close', friday, '18:30', 1, '2026-11-23', '09:31'],
  ['can land exactly at close', friday, '17:30', 60, friday, '18:30'],
  ['starts Tuesday after a Saturday arrival and Monday holiday', '2026-11-21', '10:00', 120, '2026-11-24', '11:30', holidays],
  ['uses the Kolkata calendar date when UTC is still on the previous date', '2026-11-24', '00:15', 120, '2026-11-24', '11:30', holidays],
  ['skips consecutive holidays across the year boundary', '2026-12-31', '18:00', 120, '2027-01-05', '11:00', new Set(['2027-01-01', '2027-01-04'])],
  ['counts five working days from the time a ticket starts waiting', friday, '17:30', 2700, '2026-11-30', '17:30', holidays],
  ['keeps the same instant when adding zero during working hours', friday, '17:30', 0, friday, '17:30'],
  ['uses the next opening when adding zero outside working hours', friday, '20:00', 0, '2026-11-23', '09:30'],
]) {
  test(name, () => {
    assert.equal(
      addWorkingMinutes(ist(date, time), minutes, calendar).toISOString(),
      ist(expectedDate, expectedTime).toISOString()
    );
  });
}

test('counts only the parts of the first and last working days in a weekend and holiday interval', () => {
  assert.equal(workingMinutesBetween(ist(friday, '18:00'), ist('2026-11-24', '11:00'), holidays), 120);
});

test('shows the working time before and after skipped weekend days and a holiday', () => {
  const start = ist(friday, '18:00');
  const due = ist('2026-11-24', '11:00');
  assert.deepEqual(workingTimeBreakdown(start, due, holidays), [
    { date: friday, kind: 'working', startAt: start, endAt: ist(friday, '18:30'), minutes: 30 },
    { date: '2026-11-21', kind: 'weekend' },
    { date: '2026-11-22', kind: 'weekend' },
    { date: holidayMonday, kind: 'holiday' },
    { date: '2026-11-24', kind: 'working', startAt: ist('2026-11-24', '09:30'), endAt: due, minutes: 90 },
  ]);
});

test('counts an entire workday and preserves fractions of a minute', () => {
  assert.equal(workingMinutesBetween(ist(friday, '00:00'), ist(friday, '23:59')), WORKDAY_MINUTES);
  const opening = ist(friday, '09:30');
  const thirtySecondsLater = new Date(+opening + 30_000);
  assert.equal(workingMinutesBetween(opening, thirtySecondsLater), 0.5);
  assert.equal(+addWorkingMinutes(opening, 0.5), +thirtySecondsLater);
});

test('returns zero for weekend-only, empty and reversed intervals', () => {
  const opening = ist(friday, '09:30');
  assert.equal(workingMinutesBetween(ist('2026-11-21', '09:30'), ist('2026-11-22', '18:30')), 0);
  assert.equal(workingMinutesBetween(opening, opening), 0);
  assert.equal(workingMinutesBetween(opening, ist(friday, '07:00')), 0);
});

test('urgent resolution uses the closing time of the effective working day', () => {
  assert.equal(+sameWorkingDayDeadline(ist(friday, '18:29'), holidays), +ist(friday, '18:30'));
  assert.equal(+sameWorkingDayDeadline(ist(friday, '07:00'), holidays), +ist(friday, '18:30'));
  assert.equal(+sameWorkingDayDeadline(ist(friday, '18:30'), holidays), +ist('2026-11-24', '18:30'));
  assert.equal(+sameWorkingDayDeadline(ist(holidayMonday, '11:00'), holidays), +ist('2026-11-24', '18:30'));
});

test('priority targets distinguish urgent same-day resolution from medium and low working-hour budgets', () => {
  assert.deepEqual(priorityTargets('urgent'), { firstReplyMinutes: 120, resolutionMinutes: 540, sameDayResolution: true });
  assert.deepEqual(priorityTargets('medium'), { firstReplyMinutes: 270, resolutionMinutes: 1620, sameDayResolution: false });
  assert.deepEqual(priorityTargets('low'), { firstReplyMinutes: 540, resolutionMinutes: 2700, sameDayResolution: false });
  const monday = ist('2026-11-23', '09:30');
  assert.equal(+addWorkingMinutes(monday, priorityTargets('medium').resolutionMinutes), +ist('2026-11-25', '18:30'));
  assert.equal(+addWorkingMinutes(monday, priorityTargets('low').resolutionMinutes), +ist('2026-11-27', '18:30'));
});
