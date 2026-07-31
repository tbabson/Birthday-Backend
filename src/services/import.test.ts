import { describe, expect, it } from 'vitest';
import { ImportError, parseBirthDateCell, parseRows, previewCsv } from './import.js';

const csv = (text: string) => Buffer.from(text, 'utf8');

describe('parseBirthDateCell', () => {
  it('reads ISO dates', () => {
    expect(parseBirthDateCell('1996-03-15')).toEqual({ month: 3, day: 15, year: 1996 });
    expect(parseBirthDateCell('2001-12-01')).toEqual({ month: 12, day: 1, year: 2001 });
  });

  it('reads ISO dates with no year', () => {
    expect(parseBirthDateCell('--03-15')).toEqual({ month: 3, day: 15, year: null });
    expect(parseBirthDateCell('03-15')).toEqual({ month: 3, day: 15, year: null });
  });

  it('assumes day-first for ambiguous slash dates', () => {
    // 03/04 is 3 April here, not 4 March. Documented, and the reason the
    // three-column mapping exists for anyone who needs certainty.
    expect(parseBirthDateCell('03/04/1996')).toEqual({ month: 4, day: 3, year: 1996 });
    expect(parseBirthDateCell('15/03/1996')).toEqual({ month: 3, day: 15, year: 1996 });
  });

  it('flips when the first number cannot be a day', () => {
    // 03/15 — there is no month 15, so this must be March 15th.
    expect(parseBirthDateCell('03/15')).toEqual({ month: 3, day: 15, year: null });
  });

  it('reads a leading four-digit year', () => {
    expect(parseBirthDateCell('1996/03/15')).toEqual({ month: 3, day: 15, year: 1996 });
  });

  it('expands two-digit years into the past', () => {
    expect(parseBirthDateCell('15/03/96')).toEqual({ month: 3, day: 15, year: 1996 });
    expect(parseBirthDateCell('15/03/01')).toEqual({ month: 3, day: 15, year: 2001 });
  });

  it('reads dot and space separators', () => {
    expect(parseBirthDateCell('15.03.1996')).toEqual({ month: 3, day: 15, year: 1996 });
    expect(parseBirthDateCell('15 03 1996')).toEqual({ month: 3, day: 15, year: 1996 });
  });

  it('reads month names in either order', () => {
    expect(parseBirthDateCell('15 March 1996')).toEqual({ month: 3, day: 15, year: 1996 });
    expect(parseBirthDateCell('March 15, 1996')).toEqual({ month: 3, day: 15, year: 1996 });
    expect(parseBirthDateCell('15 Mar')).toEqual({ month: 3, day: 15, year: null });
  });

  it('keeps 29 February', () => {
    expect(parseBirthDateCell('1996-02-29')).toEqual({ month: 2, day: 29, year: 1996 });
    expect(parseBirthDateCell('29/02')).toEqual({ month: 2, day: 29, year: null });
  });

  it('returns null for anything it cannot read', () => {
    expect(parseBirthDateCell('')).toBeNull();
    expect(parseBirthDateCell('   ')).toBeNull();
    expect(parseBirthDateCell('sometime in spring')).toBeNull();
    expect(parseBirthDateCell('n/a')).toBeNull();
  });
});

describe('previewCsv', () => {
  it('returns headers, a sample, and a suggested mapping', () => {
    const preview = previewCsv(
      csv(
        'Full Name,Date of Birth,Group,Notes\n' +
          'Chidi,1996-03-15,friends,Loves jollof\n' +
          'Ada,1990-01-01,family,\n',
      ),
    );

    expect(preview.headers).toEqual(['Full Name', 'Date of Birth', 'Group', 'Notes']);
    expect(preview.totalRows).toBe(2);
    expect(preview.sampleRows).toHaveLength(2);
    expect(preview.suggestedMapping.name).toBe('Full Name');
    expect(preview.suggestedMapping.birthDate).toBe('Date of Birth');
    expect(preview.suggestedMapping.tag).toBe('Group');
    expect(preview.suggestedMapping.notes).toBe('Notes');
  });

  it('prefers an exact header match over a partial one', () => {
    // Both "Birthday" and "Birthday Month" contain the word; the whole-date
    // column must not be assigned the month column.
    const preview = previewCsv(csv('Name,Birthday,Birthday Month\nA,1996-03-15,3\n'));
    expect(preview.suggestedMapping.birthDate).toBe('Birthday');
  });

  it('handles a BOM and quoted fields containing commas', () => {
    const preview = previewCsv(
      csv('﻿Name,Birthday,Notes\n"Smith, John",1996-03-15,"Owes me £20, allegedly"\n'),
    );
    expect(preview.headers).toEqual(['Name', 'Birthday', 'Notes']);
    expect(preview.sampleRows[0]!.Name).toBe('Smith, John');
    expect(preview.sampleRows[0]!.Notes).toBe('Owes me £20, allegedly');
  });

  it('rejects an empty file', () => {
    expect(() => previewCsv(csv(''))).toThrow(ImportError);
    expect(() => previewCsv(csv('Name,Birthday\n'))).toThrow(/no data rows/);
  });
});

describe('parseRows', () => {
  const file = csv(
    'Name,Birthday,Group,Notes\n' +
      'Chidi,1996-03-15,friends,Loves jollof\n' +
      'Ada,1990-01-01,family,\n' +
      'Leapling,1996-02-29,friends,\n',
  );
  const mapping = { name: 'Name', birthDate: 'Birthday', tag: 'Group', notes: 'Notes' };

  it('maps every row', () => {
    const { contacts, errors } = parseRows(file, mapping);

    expect(errors).toHaveLength(0);
    expect(contacts).toHaveLength(3);
    expect(contacts[0]).toEqual({
      name: 'Chidi',
      birthMonth: 3,
      birthDay: 15,
      birthYear: 1996,
      tag: 'friends',
      notes: 'Loves jollof',
    });
    expect(contacts[2]).toMatchObject({ birthMonth: 2, birthDay: 29 });
  });

  it('reads three separate columns when mapped', () => {
    const split = csv('Who,D,M,Y\nChidi,15,3,1996\nNgozi,1,7,\n');
    const { contacts, errors } = parseRows(split, {
      name: 'Who',
      birthDay: 'D',
      birthMonth: 'M',
      birthYear: 'Y',
    });

    expect(errors).toHaveLength(0);
    expect(contacts[0]).toMatchObject({ birthMonth: 3, birthDay: 15, birthYear: 1996 });
    expect(contacts[1]).toMatchObject({ birthMonth: 7, birthDay: 1, birthYear: null });
  });

  it('reports bad rows without losing the good ones', () => {
    const messy = csv(
      'Name,Birthday\n' +
        'Good,1996-03-15\n' +
        'NoDate,\n' +
        ',1990-01-01\n' +
        'Impossible,1996-02-30\n' +
        'AlsoGood,1985-07-04\n',
    );

    const { contacts, errors } = parseRows(messy, { name: 'Name', birthDate: 'Birthday' });

    expect(contacts.map((c) => c.name)).toEqual(['Good', 'AlsoGood']);
    expect(errors).toHaveLength(3);
    // Row numbers match what a spreadsheet shows, header counted as row 1.
    expect(errors.map((e) => e.row)).toEqual([3, 4, 5]);
    expect(errors[1]!.message).toMatch(/Missing name/);
    expect(errors[2]!.message).toMatch(/no day 30 in month 2/);
  });

  it('keeps the contact when only the year is unusable', () => {
    // The birthday still works; only the age is unknown. Losing the whole
    // person over a typo in one column would be worse.
    const odd = csv('Name,D,M,Y\nChidi,15,3,1066\n');
    const { contacts, errors } = parseRows(odd, {
      name: 'Name',
      birthDay: 'D',
      birthMonth: 'M',
      birthYear: 'Y',
    });

    expect(errors).toHaveLength(0);
    expect(contacts[0]).toMatchObject({ birthMonth: 3, birthDay: 15, birthYear: null });
  });

  it('requires a name mapping and some form of date mapping', () => {
    expect(() => parseRows(file, { name: null })).toThrow(/must be mapped to "name"/);
    expect(() => parseRows(file, { name: 'Name' })).toThrow(/single birth date column/);
  });

  it('truncates over-long values rather than failing the row', () => {
    const long = csv(`Name,Birthday,Notes\n${'x'.repeat(500)},1996-03-15,${'y'.repeat(5000)}\n`);
    const { contacts } = parseRows(long, { name: 'Name', birthDate: 'Birthday', notes: 'Notes' });

    expect(contacts[0]!.name).toHaveLength(200);
    expect(contacts[0]!.notes).toHaveLength(2000);
  });
});
