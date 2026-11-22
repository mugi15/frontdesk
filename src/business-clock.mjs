const MINUTES_PER_DAY = 9 * 60;
const OPEN_UTC_HOUR = 4; // 09:30 in Asia/Kolkata
const CLOSE_UTC_HOUR = 13; // 18:30 in Asia/Kolkata

function localDateParts(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(value instanceof Date ? value : new Date(value));
  const read = (type) => Number(parts.find((part) => part.type === type).value);
  return { year: read('year'), month: read('month'), day: read('day') };
}

function keyOf(instant) {
  const { year, month, day } = localDateParts(instant);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function dateFromKey(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function keyForUtcDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function isBusinessDay(key, holidays) {
  const weekday = dateFromKey(key).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.has(key);
}

function opening(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, OPEN_UTC_HOUR, 0));
}

function closing(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, CLOSE_UTC_HOUR, 0));
}

function nextKey(key) {
  const next = dateFromKey(key);
  next.setUTCDate(next.getUTCDate() + 1);
  return keyForUtcDate(next);
}

function firstOpenAtOrAfter(value, holidays) {
  const instant = new Date(value);
  let key = keyOf(instant);
  for (let i = 0; i < 370; i += 1) {
    if (!isBusinessDay(key, holidays)) {
      key = nextKey(key);
      continue;
    }
    const open = opening(key);
    const close = closing(key);
    if (instant < open) return open;
    if (instant < close) return instant;
    key = nextKey(key);
  }
  throw new Error('Could not find a working day in the next year.');
}

export function addWorkingMinutes(value, minutes, holidays = new Set()) {
  let cursor = firstOpenAtOrAfter(value, holidays);
  let remaining = Math.max(0, Number(minutes));
  if (remaining === 0) return cursor;

  for (let i = 0; i < 3700; i += 1) {
    const key = keyOf(cursor);
    const close = closing(key);
    const available = (close.getTime() - cursor.getTime()) / 60000;
    if (remaining <= available) return new Date(cursor.getTime() + remaining * 60000);
    remaining -= available;
    cursor = firstOpenAtOrAfter(new Date(close.getTime() + 1000), holidays);
  }
  throw new Error('Working-time deadline exceeded the supported horizon.');
}

function* workingDateRanges(startValue, endValue, holidays) {
  const start = new Date(startValue);
  const end = new Date(endValue);
  if (end <= start) return;
  let key = keyOf(start);
  const finalKey = keyOf(end);
  for (let i = 0; i < 3700; i += 1) {
    if (!isBusinessDay(key, holidays)) {
      yield { date: key, kind: holidays.has(key) ? 'holiday' : 'weekend' };
    } else {
      const from = Math.max(start.getTime(), opening(key).getTime());
      const to = Math.min(end.getTime(), closing(key).getTime());
      if (to > from) {
        yield { date: key, kind: 'working', from, to, minutes: (to - from) / 60000 };
      } else if (key !== finalKey) {
        yield { date: key, kind: 'outside_hours' };
      }
    }
    if (key === finalKey) return;
    key = nextKey(key);
  }
  throw new Error('Working-time interval exceeded the supported horizon.');
}

export function workingMinutesBetween(startValue, endValue, holidays = new Set()) {
  let total = 0;
  for (const range of workingDateRanges(startValue, endValue, holidays)) total += range.minutes ?? 0;
  return total;
}

export function workingTimeBreakdown(startValue, endValue, holidays = new Set()) {
  return [...workingDateRanges(startValue, endValue, holidays)].map((range) =>
    range.kind === 'working'
      ? { date: range.date, kind: range.kind, startAt: new Date(range.from), endAt: new Date(range.to), minutes: range.minutes }
      : range
  );
}

export function sameWorkingDayDeadline(value, holidays = new Set()) {
  const cursor = firstOpenAtOrAfter(value, holidays);
  return closing(keyOf(cursor));
}

export function priorityTargets(priority) {
  if (priority === 'urgent') return { firstReplyMinutes: 120, resolutionMinutes: 540, sameDayResolution: true };
  if (priority === 'medium') return { firstReplyMinutes: 270, resolutionMinutes: 1620, sameDayResolution: false };
  return { firstReplyMinutes: 540, resolutionMinutes: 2700, sameDayResolution: false };
}

export const WORKDAY_MINUTES = MINUTES_PER_DAY;
