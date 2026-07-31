import { describe, expect, it } from 'vitest';
import {
  addDays,
  ageAtOccurrence,
  birthDatesObservedOn,
  compareDates,
  currentAge,
  daysBetween,
  daysUntilNextBirthday,
  formatISODate,
  instantAt,
  isLeapYear,
  isValidBirthDate,
  nextOccurrence,
  observedOccurrence,
  occurrenceDateFor,
  reminderDateFor,
  todayIn,
  type BirthDate,
  type CalendarDate,
} from './dates.js';

const d = (year: number, month: number, day: number): CalendarDate => ({ year, month, day });

describe('isLeapYear', () => {
  it.each([
    [2024, true],
    [2025, false],
    [2026, false],
    [2027, false],
    [2028, true],
    [2000, true], // divisible by 400
    [1900, false], // divisible by 100 but not 400 — the classic trap
    [2100, false],
  ])('%i -> %s', (year, expected) => {
    expect(isLeapYear(year)).toBe(expected);
  });
});

describe('isValidBirthDate', () => {
  it('accepts Feb 29 — it is a real birthday', () => {
    expect(isValidBirthDate(2, 29)).toBe(true);
  });

  it.each([
    [2, 30],
    [4, 31],
    [6, 31],
    [9, 31],
    [11, 31],
    [13, 1],
    [0, 1],
    [1, 0],
    [1, 32],
  ])('rejects month %i day %i', (month, day) => {
    expect(isValidBirthDate(month, day)).toBe(false);
  });

  it('rejects non-integers', () => {
    expect(isValidBirthDate(1.5, 10)).toBe(false);
    expect(isValidBirthDate(1, 10.5)).toBe(false);
  });
});

describe('observedOccurrence — Feb 29', () => {
  const leapling: BirthDate = { month: 2, day: 29, year: 1996 };

  it('is observed on Feb 29 in a leap year', () => {
    expect(observedOccurrence(leapling, 2028)).toEqual(d(2028, 2, 29));
  });

  it('is observed on Feb 28 in a non-leap year', () => {
    expect(observedOccurrence(leapling, 2027)).toEqual(d(2027, 2, 28));
  });

  it('leaves every other birthday untouched', () => {
    expect(observedOccurrence({ month: 3, day: 15 }, 2027)).toEqual(d(2027, 3, 15));
    expect(observedOccurrence({ month: 2, day: 28 }, 2027)).toEqual(d(2027, 2, 28));
  });
});

describe('nextOccurrence', () => {
  it('returns this year when the birthday is still ahead', () => {
    expect(nextOccurrence({ month: 3, day: 15 }, d(2027, 1, 10))).toEqual(d(2027, 3, 15));
  });

  it('returns today when the birthday is today', () => {
    expect(nextOccurrence({ month: 3, day: 15 }, d(2027, 3, 15))).toEqual(d(2027, 3, 15));
  });

  it('rolls to next year once the birthday has passed', () => {
    expect(nextOccurrence({ month: 3, day: 15 }, d(2027, 3, 16))).toEqual(d(2028, 3, 15));
  });

  it('rolls a Feb 29 birthday to the next leap year correctly', () => {
    // 1 March 2027: Feb 28 2027 has passed, so the next observance is
    // Feb 29 2028 — a real one, because 2028 is a leap year.
    expect(nextOccurrence({ month: 2, day: 29 }, d(2027, 3, 1))).toEqual(d(2028, 2, 29));
  });

  it('observes a leapling on Feb 28 when that day is today', () => {
    expect(nextOccurrence({ month: 2, day: 29 }, d(2027, 2, 28))).toEqual(d(2027, 2, 28));
  });

  it('handles a 31 December birthday on 31 December', () => {
    expect(nextOccurrence({ month: 12, day: 31 }, d(2027, 12, 31))).toEqual(d(2027, 12, 31));
  });

  it('handles a 1 January birthday viewed from 31 December', () => {
    expect(nextOccurrence({ month: 1, day: 1 }, d(2026, 12, 31))).toEqual(d(2027, 1, 1));
  });
});

describe('daysUntilNextBirthday', () => {
  it('is 0 on the day itself', () => {
    expect(daysUntilNextBirthday({ month: 3, day: 15 }, d(2027, 3, 15))).toBe(0);
  });

  it('is 1 the day before', () => {
    expect(daysUntilNextBirthday({ month: 3, day: 15 }, d(2027, 3, 14))).toBe(1);
  });

  it('crosses a year boundary', () => {
    expect(daysUntilNextBirthday({ month: 1, day: 1 }, d(2026, 12, 31))).toBe(1);
  });

  it('is 364 the day after, when no leap day falls in the span', () => {
    // 16 Mar 2026 -> 15 Mar 2027. Feb 2027 has 28 days.
    expect(daysUntilNextBirthday({ month: 3, day: 15 }, d(2026, 3, 16))).toBe(364);
    // 16 Jan 2027 -> 15 Jan 2028, entirely ahead of 29 Feb 2028.
    expect(daysUntilNextBirthday({ month: 1, day: 15 }, d(2027, 1, 16))).toBe(364);
  });

  it('is 365 the day after, when a leap day falls in the span', () => {
    // 16 Mar 2027 -> 15 Mar 2028; the span contains 29 Feb 2028.
    expect(daysUntilNextBirthday({ month: 3, day: 15 }, d(2027, 3, 16))).toBe(365);
    // 2 Jan 2028 -> 1 Jan 2029; the span contains 29 Feb 2028.
    expect(daysUntilNextBirthday({ month: 1, day: 1 }, d(2028, 1, 2))).toBe(365);
  });
});

describe('reminderDateFor / occurrenceDateFor — the 1 January case', () => {
  it('a 1 Jan birthday reminds on 31 Dec of the previous year', () => {
    expect(reminderDateFor(d(2027, 1, 1), 1)).toEqual(d(2026, 12, 31));
  });

  it('and the occurrence year is the birthday year, not the send year', () => {
    // This is the assertion that protects the idempotency key every NYE.
    const sendDate = d(2026, 12, 31);
    const occurrence = occurrenceDateFor(sendDate, 1);
    expect(occurrence).toEqual(d(2027, 1, 1));
    expect(occurrence.year).toBe(2027);
    expect(occurrence.year).not.toBe(sendDate.year);
  });

  it('round-trips for any lead time', () => {
    for (const lead of [0, 1, 2, 7, 30]) {
      const occ = d(2027, 3, 15);
      expect(occurrenceDateFor(reminderDateFor(occ, lead), lead)).toEqual(occ);
    }
  });

  it('a 1 March birthday reminds on 29 Feb in a leap year', () => {
    expect(reminderDateFor(d(2028, 3, 1), 1)).toEqual(d(2028, 2, 29));
  });

  it('a 1 March birthday reminds on 28 Feb in a common year', () => {
    expect(reminderDateFor(d(2027, 3, 1), 1)).toEqual(d(2027, 2, 28));
  });
});

describe('birthDatesObservedOn — the sweep lookup', () => {
  it('normally matches only itself', () => {
    expect(birthDatesObservedOn(d(2027, 3, 15))).toEqual([{ month: 3, day: 15 }]);
  });

  it('28 Feb in a common year also catches leaplings', () => {
    expect(birthDatesObservedOn(d(2027, 2, 28))).toEqual([
      { month: 2, day: 28 },
      { month: 2, day: 29 },
    ]);
  });

  it('28 Feb in a leap year does NOT catch leaplings — they have their own day', () => {
    expect(birthDatesObservedOn(d(2028, 2, 28))).toEqual([{ month: 2, day: 28 }]);
  });

  it('29 Feb in a leap year matches leaplings', () => {
    expect(birthDatesObservedOn(d(2028, 2, 29))).toEqual([{ month: 2, day: 29 }]);
  });
});

describe('ages', () => {
  const chidi: BirthDate = { month: 3, day: 15, year: 1996 };

  it('reports the age being turned at an occurrence', () => {
    expect(ageAtOccurrence(chidi, 2027)).toBe(31);
  });

  it('returns null when the birth year is unknown', () => {
    expect(ageAtOccurrence({ month: 3, day: 15 }, 2027)).toBeNull();
    expect(currentAge({ month: 3, day: 15 }, d(2027, 6, 1))).toBeNull();
  });

  it('current age is one less until the birthday lands', () => {
    expect(currentAge(chidi, d(2027, 3, 14))).toBe(30);
    expect(currentAge(chidi, d(2027, 3, 15))).toBe(31);
    expect(currentAge(chidi, d(2027, 3, 16))).toBe(31);
  });

  it('a leapling ages on Feb 28 in common years', () => {
    const leapling: BirthDate = { month: 2, day: 29, year: 2000 };
    expect(currentAge(leapling, d(2027, 2, 27))).toBe(26);
    expect(currentAge(leapling, d(2027, 2, 28))).toBe(27);
  });
});

describe('calendar arithmetic is DST-proof', () => {
  it('addDays crosses a spring-forward boundary as one day', () => {
    // US DST 2027 begins 14 March.
    expect(addDays(d(2027, 3, 13), 1)).toEqual(d(2027, 3, 14));
    expect(daysBetween(d(2027, 3, 13), d(2027, 3, 14))).toBe(1);
  });

  it('addDays crosses a fall-back boundary as one day', () => {
    // US DST 2027 ends 7 November.
    expect(daysBetween(d(2027, 11, 6), d(2027, 11, 7))).toBe(1);
  });

  it('handles month and year ends', () => {
    expect(addDays(d(2027, 12, 31), 1)).toEqual(d(2028, 1, 1));
    expect(addDays(d(2028, 1, 1), -1)).toEqual(d(2027, 12, 31));
    expect(addDays(d(2028, 2, 28), 1)).toEqual(d(2028, 2, 29));
    expect(addDays(d(2027, 2, 28), 1)).toEqual(d(2027, 3, 1));
  });

  it('compares and formats', () => {
    expect(compareDates(d(2027, 1, 1), d(2027, 1, 2))).toBeLessThan(0);
    expect(compareDates(d(2027, 2, 1), d(2027, 1, 2))).toBeGreaterThan(0);
    expect(compareDates(d(2027, 1, 1), d(2027, 1, 1))).toBe(0);
    expect(formatISODate(d(2027, 3, 5))).toBe('2027-03-05');
  });
});

describe('todayIn — the same instant is a different date in different zones', () => {
  it('resolves the local date per zone', () => {
    // 2027-03-15T23:30Z: already the 16th in Lagos, still the 15th in New York.
    const instant = new Date('2027-03-15T23:30:00Z');
    expect(todayIn('Africa/Lagos', instant)).toEqual(d(2027, 3, 16));
    expect(todayIn('America/New_York', instant)).toEqual(d(2027, 3, 15));
    expect(todayIn('Pacific/Kiritimati', instant)).toEqual(d(2027, 3, 16));
    expect(todayIn('UTC', instant)).toEqual(d(2027, 3, 15));
  });

  it('throws on a bogus zone rather than silently using UTC', () => {
    expect(() => todayIn('Mars/Olympus_Mons', new Date())).toThrow(/Invalid time zone/);
  });
});

describe('instantAt — resolving "9am local" per user', () => {
  it('Lagos has no DST: 09:00 is always 08:00Z', () => {
    expect(instantAt(d(2027, 3, 14), 9, 'Africa/Lagos').toISOString()).toBe(
      '2027-03-14T08:00:00.000Z',
    );
    expect(instantAt(d(2027, 11, 14), 9, 'Africa/Lagos').toISOString()).toBe(
      '2027-11-14T08:00:00.000Z',
    );
  });

  it('New York shifts by an hour across the spring-forward boundary', () => {
    // The classic off-by-one-hour: same wall clock, different UTC instant.
    expect(instantAt(d(2027, 3, 13), 9, 'America/New_York').toISOString()).toBe(
      '2027-03-13T14:00:00.000Z', // EST, UTC-5
    );
    expect(instantAt(d(2027, 3, 14), 9, 'America/New_York').toISOString()).toBe(
      '2027-03-14T13:00:00.000Z', // EDT, UTC-4
    );
  });

  it('handles a sub-hour offset zone', () => {
    expect(instantAt(d(2027, 3, 14), 9, 'Asia/Kathmandu').toISOString()).toBe(
      '2027-03-14T03:15:00.000Z', // UTC+5:45
    );
  });

  it('handles a zone west of the date line', () => {
    expect(instantAt(d(2027, 3, 14), 9, 'Pacific/Auckland').toISOString()).toBe(
      '2027-03-13T20:00:00.000Z', // NZDT, UTC+13
    );
  });

  it('produces a real instant even if the wall-clock hour was skipped by DST', () => {
    // Lord Howe springs forward at 02:00 -> 02:30. Ask for an hour that exists
    // to confirm validity, and confirm a skipped hour still yields a Date.
    const skipped = instantAt(d(2027, 10, 3), 2, 'Australia/Lord_Howe');
    expect(skipped).toBeInstanceOf(Date);
    expect(Number.isNaN(skipped.getTime())).toBe(false);
  });
});

/**
 * §8: "100% of birthdays in the DB produce exactly one notification, on the
 * correct day-before, over a full simulated test year with a controllable
 * clock." This exercises the pure scheduling decision — which contacts a sweep
 * on day D picks up — independently of the database.
 */
describe('simulated year — exactly one reminder per birthday', () => {
  const LEAD = 1;

  const roster: Array<{ id: string; birth: BirthDate }> = [
    { id: 'new-years-day', birth: { month: 1, day: 1, year: 1990 } },
    { id: 'feb-28', birth: { month: 2, day: 28, year: 1985 } },
    { id: 'leapling', birth: { month: 2, day: 29, year: 1996 } },
    { id: 'mar-01', birth: { month: 3, day: 1 } },
    { id: 'mid-march', birth: { month: 3, day: 15, year: 1996 } },
    { id: 'independence', birth: { month: 7, day: 4, year: 2001 } },
    { id: 'new-years-eve', birth: { month: 12, day: 31, year: 1978 } },
  ];

  /** Replays the sweep's contact-selection logic across a date range. */
  function simulate(from: CalendarDate, to: CalendarDate) {
    const fired: Array<{ id: string; occurrenceYear: number; sentOn: CalendarDate }> = [];
    for (let day = from; compareDates(day, to) <= 0; day = addDays(day, 1)) {
      const target = occurrenceDateFor(day, LEAD);
      const pairs = birthDatesObservedOn(target);
      for (const person of roster) {
        const matches = pairs.some(
          (p) => p.month === person.birth.month && p.day === person.birth.day,
        );
        if (matches) {
          fired.push({ id: person.id, occurrenceYear: target.year, sentOn: day });
        }
      }
    }
    return fired;
  }

  // Sweep from 30 Dec 2026 so the 1 Jan 2027 reminder (sent 31 Dec 2026) is
  // inside the window, through the end of the 2028 leap year.
  const fired = simulate(d(2026, 12, 30), d(2028, 12, 30));

  it.each([2027, 2028])('every contact fires exactly once for occurrence year %i', (year) => {
    for (const person of roster) {
      const hits = fired.filter((f) => f.id === person.id && f.occurrenceYear === year);
      expect(hits, `${person.id} in ${year}`).toHaveLength(1);
    }
  });

  it('always fires exactly one day before the observed occurrence', () => {
    for (const hit of fired) {
      const person = roster.find((p) => p.id === hit.id)!;
      const observed = observedOccurrence(person.birth, hit.occurrenceYear);
      expect(daysBetween(hit.sentOn, observed), `${hit.id} ${hit.occurrenceYear}`).toBe(LEAD);
    }
  });

  it('never produces two reminders on the same day for the same contact', () => {
    const keys = fired.map((f) => `${f.id}:${formatISODate(f.sentOn)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('sends the leapling reminder on 27 Feb in a common year and 28 Feb in a leap year', () => {
    const hits = fired.filter((f) => f.id === 'leapling');
    expect(hits.find((h) => h.occurrenceYear === 2027)!.sentOn).toEqual(d(2027, 2, 27));
    expect(hits.find((h) => h.occurrenceYear === 2028)!.sentOn).toEqual(d(2028, 2, 28));
  });

  it('sends the 1 Jan reminder on 31 Dec of the preceding year', () => {
    const hit = fired.find((f) => f.id === 'new-years-day' && f.occurrenceYear === 2027)!;
    expect(hit.sentOn).toEqual(d(2026, 12, 31));
  });

  it('does not confuse Feb 28 and Feb 29 contacts in a leap year', () => {
    const feb28 = fired.find((f) => f.id === 'feb-28' && f.occurrenceYear === 2028)!;
    const leapling = fired.find((f) => f.id === 'leapling' && f.occurrenceYear === 2028)!;
    expect(feb28.sentOn).toEqual(d(2028, 2, 27));
    expect(leapling.sentOn).toEqual(d(2028, 2, 28));
  });
});
