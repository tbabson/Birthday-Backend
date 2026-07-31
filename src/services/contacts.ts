import type { Contact, User } from '../db/schema.js';
import {
  ageAtOccurrence,
  compareDates,
  currentAge,
  daysBetween,
  formatISODate,
  nextOccurrence,
  observedOccurrence,
  todayIn,
  type BirthDate,
  type CalendarDate,
} from '../domain/dates.js';

export interface ContactView {
  id: string;
  name: string;
  birthMonth: number;
  birthDay: number;
  birthYear: number | null;
  tag: string | null;
  notes: string | null;
  photoUrl: string | null;
  /** ISO date of the next observed birthday, in the user's zone. */
  nextBirthday: string;
  daysAway: number;
  /** Age they will turn at that birthday. Null when the birth year is unknown. */
  turningAge: number | null;
  /** Age today. Null when the birth year is unknown. */
  age: number | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function birthDateOf(contact: Contact): BirthDate {
  return { month: contact.birthMonth, day: contact.birthDay, year: contact.birthYear };
}

export function toContactView(
  contact: Contact,
  today: CalendarDate,
): ContactView {
  const birth = birthDateOf(contact);
  const next = nextOccurrence(birth, today);

  return {
    id: contact.id,
    name: contact.name,
    birthMonth: contact.birthMonth,
    birthDay: contact.birthDay,
    birthYear: contact.birthYear,
    tag: contact.tag,
    notes: contact.notes,
    photoUrl: contact.photoUrl,
    nextBirthday: formatISODate(next),
    daysAway: daysBetween(today, next),
    turningAge: ageAtOccurrence(birth, next.year),
    age: currentAge(birth, today),
    deletedAt: contact.deletedAt?.toISOString() ?? null,
    createdAt: contact.createdAt.toISOString(),
    updatedAt: contact.updatedAt.toISOString(),
  };
}

export type ContactSort = 'next_birthday' | 'name' | 'created_at';

/**
 * "Next birthday" ordering is computed here rather than in SQL on purpose: the
 * Feb 29 -> Feb 28 rule and the year rollover live in one place (the date
 * engine), and duplicating them into an ORDER BY expression is exactly how the
 * two drift apart. A personal register is small enough that sorting in memory
 * costs nothing — `listContacts` caps the row count.
 */
export function buildContactViews(
  rows: Contact[],
  user: Pick<User, 'timezone'>,
  now: Date,
  sort: ContactSort = 'next_birthday',
): ContactView[] {
  const today = todayIn(user.timezone, now);
  const views = rows.map((c) => toContactView(c, today));

  switch (sort) {
    case 'name':
      return views.sort((a, b) => a.name.localeCompare(b.name));
    case 'created_at':
      return views.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    case 'next_birthday':
    default:
      // Ties broken by name so the order is stable between requests.
      return views.sort((a, b) => a.daysAway - b.daysAway || a.name.localeCompare(b.name));
  }
}

/** §5.5 / GET /upcoming — everyone with a birthday in the next N days. */
export function upcomingWithin(
  rows: Contact[],
  user: Pick<User, 'timezone'>,
  now: Date,
  windowDays: number,
): ContactView[] {
  return buildContactViews(rows, user, now).filter((v) => v.daysAway <= windowDays);
}

export interface DashboardSummary {
  totalContacts: number;
  today: ContactView[];
  tomorrow: ContactView[];
  thisWeek: ContactView[];
  thisMonth: ContactView[];
  next: ContactView | null;
  /** §5.5 "most recent" — the most recently added contact. */
  mostRecentlyAdded: ContactView | null;
}

export function summarise(
  rows: Contact[],
  user: Pick<User, 'timezone'>,
  now: Date,
): DashboardSummary {
  const views = buildContactViews(rows, user, now);
  const byCreated = [...views].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return {
    totalContacts: views.length,
    today: views.filter((v) => v.daysAway === 0),
    tomorrow: views.filter((v) => v.daysAway === 1),
    thisWeek: views.filter((v) => v.daysAway <= 7),
    thisMonth: views.filter((v) => v.daysAway <= 31),
    next: views[0] ?? null,
    mostRecentlyAdded: byCreated[0] ?? null,
  };
}

export interface CalendarDay {
  /** ISO date within the requested year. */
  date: string;
  count: number;
  names: string[];
}

export interface CalendarYear {
  year: number;
  /** Only days that actually have a birthday — a heatmap fills the rest with zero. */
  days: CalendarDay[];
  total: number;
  busiestDay: CalendarDay | null;
}

/**
 * Birthday counts per day for the yearly heatmap (§5.5).
 *
 * Keyed on the *observed* occurrence, so in a common year a 29 February
 * contact appears under 28 February — the same day the reminder logic uses.
 * Computing this server-side keeps the leap-year rule in one place instead of
 * duplicating it into the browser.
 */
export function buildCalendar(
  rows: Contact[],
  user: Pick<User, 'timezone'>,
  now: Date,
  year?: number,
): CalendarYear {
  const targetYear = year ?? todayIn(user.timezone, now).year;
  const byDate = new Map<string, string[]>();

  for (const contact of rows) {
    const occurrence = observedOccurrence(birthDateOf(contact), targetYear);
    const key = formatISODate(occurrence);
    const names = byDate.get(key) ?? [];
    names.push(contact.name);
    byDate.set(key, names);
  }

  const days: CalendarDay[] = [...byDate.entries()]
    .map(([date, names]) => ({ date, count: names.length, names: names.sort() }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const busiestDay = days.reduce<CalendarDay | null>(
    (best, day) => (best === null || day.count > best.count ? day : best),
    null,
  );

  return { year: targetYear, days, total: rows.length, busiestDay };
}

/** True when `date` is today or later in the user's zone — used by the catch-up check. */
export function isTodayOrFuture(date: CalendarDate, timezone: string, now: Date): boolean {
  return compareDates(date, todayIn(timezone, now)) >= 0;
}
