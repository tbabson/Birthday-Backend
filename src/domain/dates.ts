import { DateTime } from 'luxon';

/**
 * The date engine.
 *
 * Two layers, deliberately separated:
 *
 *   1. A *calendar* layer of plain {year, month, day} values. All birthday
 *      arithmetic happens here, in pure integers, so DST cannot reach it.
 *      "The day before 15 March" is a calendar question, not an instant one.
 *
 *   2. An *instant* layer that converts a calendar date plus an hour plus an
 *      IANA zone into a real UTC timestamp. This is the only place a time zone
 *      is involved, and it is the only place DST can bite.
 *
 * Mixing the two is where off-by-one-day bugs come from: subtracting 24 hours
 * from an instant is not the same as subtracting one day from a date.
 *
 * Nothing in this module does IO, and nothing reads the wall clock — `now` is
 * always passed in, so every case below is testable against a fixed clock.
 */

export interface CalendarDate {
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
}

/** A birthday as stored: month + day always known, year optional (§6.3). */
export interface BirthDate {
  month: number;
  day: number;
  year?: number | null;
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return DAYS_IN_MONTH[month - 1]!;
}

/**
 * Valid as a *birthday*, which is not the same as valid as a date: Feb 29 is
 * always accepted even though most years don't have one. Mirrors the
 * `contacts_valid_month_day` check constraint.
 */
export function isValidBirthDate(month: number, day: number): boolean {
  if (!Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  return day <= DAYS_IN_MONTH[month - 1]!;
}

// --- calendar layer ---------------------------------------------------------

/** Calendar dates as UTC DateTimes purely so Luxon can do the arithmetic. */
function toUtc(d: CalendarDate): DateTime {
  return DateTime.fromObject(
    { year: d.year, month: d.month, day: d.day },
    { zone: 'utc' },
  );
}

function fromUtc(dt: DateTime): CalendarDate {
  return { year: dt.year, month: dt.month, day: dt.day };
}

export function addDays(d: CalendarDate, n: number): CalendarDate {
  return fromUtc(toUtc(d).plus({ days: n }));
}

/** Negative if a < b, 0 if equal, positive if a > b. */
export function compareDates(a: CalendarDate, b: CalendarDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

export function datesEqual(a: CalendarDate, b: CalendarDate): boolean {
  return compareDates(a, b) === 0;
}

/** Whole calendar days from `a` to `b`. DST-proof: both sides are UTC. */
export function daysBetween(a: CalendarDate, b: CalendarDate): number {
  return Math.round(toUtc(b).diff(toUtc(a), 'days').days);
}

export function formatISODate(d: CalendarDate): string {
  const mm = String(d.month).padStart(2, '0');
  const dd = String(d.day).padStart(2, '0');
  return `${d.year}-${mm}-${dd}`;
}

/** Today's calendar date in the user's own zone. */
export function todayIn(zone: string, now: Date): CalendarDate {
  const dt = DateTime.fromJSDate(now, { zone });
  if (!dt.isValid) throw new Error(`Invalid time zone: ${zone}`);
  return { year: dt.year, month: dt.month, day: dt.day };
}

/** The current hour (0-23) on the user's own wall clock. */
export function hourIn(zone: string, now: Date): number {
  const dt = DateTime.fromJSDate(now, { zone });
  if (!dt.isValid) throw new Error(`Invalid time zone: ${zone}`);
  return dt.hour;
}

export function isValidZone(zone: string): boolean {
  return DateTime.local().setZone(zone).isValid;
}

// --- birthday occurrences ---------------------------------------------------

/**
 * The date a birthday is *observed* in a given year.
 *
 * Feb 29 in a non-leap year is observed on Feb 28 (§6.4). This is a decision,
 * not a fact — Mar 1 would have been equally defensible — so it is made once,
 * here, and covered by tests. The consequence is that a Feb 29 person gets
 * their T-1 reminder on Feb 27 in common years and Feb 28 in leap years.
 */
export function observedOccurrence(birth: BirthDate, year: number): CalendarDate {
  if (birth.month === 2 && birth.day === 29 && !isLeapYear(year)) {
    return { year, month: 2, day: 28 };
  }
  return { year, month: birth.month, day: birth.day };
}

/**
 * The next observed occurrence on or after `today`. If the birthday is today,
 * today is returned — a birthday is not "next year" until it has passed.
 */
export function nextOccurrence(birth: BirthDate, today: CalendarDate): CalendarDate {
  const thisYear = observedOccurrence(birth, today.year);
  if (compareDates(thisYear, today) >= 0) return thisYear;
  return observedOccurrence(birth, today.year + 1);
}

export function daysUntilNextBirthday(birth: BirthDate, today: CalendarDate): number {
  return daysBetween(today, nextOccurrence(birth, today));
}

/**
 * The date the reminder for a given occurrence goes out: `leadDays` calendar
 * days before it. A 1 January birthday reminds on 31 December of the previous
 * year, which is exactly why `occurrenceYear` is stored separately from the
 * send date (§6.4).
 */
export function reminderDateFor(
  occurrence: CalendarDate,
  leadDays: number,
): CalendarDate {
  return addDays(occurrence, -leadDays);
}

/**
 * The inverse, used by the sweep: given the day a reminder is being sent and
 * the lead time, which birthday date is it about?
 */
export function occurrenceDateFor(
  reminderDate: CalendarDate,
  leadDays: number,
): CalendarDate {
  return addDays(reminderDate, leadDays);
}

/**
 * Which stored (birth_month, birth_day) pairs are observed on `target`?
 *
 * Normally exactly one — itself. The exception is 28 February in a non-leap
 * year, which is *also* when Feb 29 people are observed. The sweep must query
 * for both or every leapling silently misses their reminder in three years
 * out of four.
 */
export function birthDatesObservedOn(
  target: CalendarDate,
): Array<{ month: number; day: number }> {
  const pairs = [{ month: target.month, day: target.day }];
  if (target.month === 2 && target.day === 28 && !isLeapYear(target.year)) {
    pairs.push({ month: 2, day: 29 });
  }
  return pairs;
}

// --- ages -------------------------------------------------------------------

/** The age reached at a given occurrence — "turning 31". Null if year unknown. */
export function ageAtOccurrence(
  birth: BirthDate,
  occurrenceYear: number,
): number | null {
  if (birth.year == null) return null;
  return occurrenceYear - birth.year;
}

/** Age as of today: one less than `turning` until the birthday has happened. */
export function currentAge(birth: BirthDate, today: CalendarDate): number | null {
  if (birth.year == null) return null;
  const thisYear = observedOccurrence(birth, today.year);
  const hasHadBirthday = compareDates(today, thisYear) >= 0;
  return today.year - birth.year - (hasHadBirthday ? 0 : 1);
}

// --- instant layer ----------------------------------------------------------

/**
 * The real UTC instant at which a reminder fires: `hour` o'clock, in the
 * user's zone, on `date`.
 *
 * `zone` must be an IANA name (`Africa/Lagos`), never a fixed offset — a fixed
 * offset is what produces the classic one-hour skip across a DST boundary
 * (§6.4). If the wall-clock hour does not exist on that date because the clocks
 * sprang forward through it, Luxon moves forward to the next real instant,
 * which is the behaviour we want: the reminder still goes out that morning.
 */
export function instantAt(date: CalendarDate, hour: number, zone: string): Date {
  const dt = DateTime.fromObject(
    { year: date.year, month: date.month, day: date.day, hour, minute: 0, second: 0 },
    { zone },
  );
  if (!dt.isValid) {
    throw new Error(`Invalid instant: ${formatISODate(date)} ${hour}:00 ${zone} — ${dt.invalidReason}`);
  }
  return dt.toJSDate();
}

/** Renders a calendar date for a human, in their own zone. */
export function formatHuman(date: CalendarDate, zone: string, locale = 'en-GB'): string {
  return DateTime.fromObject(
    { year: date.year, month: date.month, day: date.day },
    { zone },
  )
    .setLocale(locale)
    .toFormat('cccc d LLLL');
}
