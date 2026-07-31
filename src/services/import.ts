import { parse } from 'csv-parse/sync';
import { env } from '../config/env.js';
import { isValidBirthDate } from '../domain/dates.js';

/**
 * CSV import with column mapping (§5.4).
 *
 * Two steps on purpose. `previewCsv` reads the headers and a few rows so the
 * user can confirm which column is which; `parseRows` then applies that
 * mapping. Guessing silently is how you end up importing 400 people with their
 * months and days transposed and no way to tell.
 */

export interface CsvPreview {
  headers: string[];
  sampleRows: Array<Record<string, string>>;
  totalRows: number;
  /** Best guess per field, for pre-selecting the mapping UI. May be null. */
  suggestedMapping: ColumnMapping;
}

export interface ColumnMapping {
  name: string | null;
  /** A single column holding a whole date, e.g. "1996-03-15" or "15/03/1996". */
  birthDate?: string | null;
  /** Or three separate columns. Takes precedence over `birthDate` when set. */
  birthDay?: string | null;
  birthMonth?: string | null;
  birthYear?: string | null;
  tag?: string | null;
  notes?: string | null;
}

export interface ParsedContact {
  name: string;
  birthMonth: number;
  birthDay: number;
  birthYear: number | null;
  tag: string | null;
  notes: string | null;
}

export interface RowError {
  /** 1-based, counting the header as row 1, so it matches what a spreadsheet shows. */
  row: number;
  message: string;
}

export interface ParseResult {
  contacts: ParsedContact[];
  errors: RowError[];
}

export class ImportError extends Error {}

const HEADER_HINTS: Record<keyof ColumnMapping, string[]> = {
  name: ['name', 'full name', 'fullname', 'contact', 'person', 'first name'],
  birthDate: ['birthday', 'birth date', 'birthdate', 'date of birth', 'dob', 'date'],
  birthDay: ['day', 'birth day', 'birthday day'],
  birthMonth: ['month', 'birth month', 'birthday month'],
  birthYear: ['year', 'birth year', 'birthday year'],
  tag: ['tag', 'group', 'category', 'relationship', 'label'],
  notes: ['notes', 'note', 'comment', 'comments', 'description'],
};

function normalise(header: string): string {
  return header.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function guessColumn(headers: string[], field: keyof ColumnMapping): string | null {
  const hints = HEADER_HINTS[field];
  // Exact match first, so a sheet with both "Birthday" and "Birthday Month"
  // does not assign the wrong one.
  for (const hint of hints) {
    const exact = headers.find((h) => normalise(h) === hint);
    if (exact) return exact;
  }
  for (const hint of hints) {
    const partial = headers.find((h) => normalise(h).includes(hint));
    if (partial) return partial;
  }
  return null;
}

function readCsv(buffer: Buffer): Array<Record<string, string>> {
  if (buffer.length === 0) throw new ImportError('The file is empty');
  if (buffer.length > env.IMPORT_MAX_BYTES) {
    throw new ImportError(`File is larger than ${env.IMPORT_MAX_BYTES} bytes`);
  }

  let rows: Array<Record<string, string>>;
  try {
    rows = parse(buffer, {
      columns: (header: string[]) => header.map((h) => h.trim()),
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
    });
  } catch (err) {
    throw new ImportError(`Could not read that CSV: ${(err as Error).message}`);
  }

  if (rows.length === 0) throw new ImportError('The file has no data rows');
  if (rows.length > env.IMPORT_MAX_ROWS) {
    throw new ImportError(`File has more than ${env.IMPORT_MAX_ROWS} rows`);
  }
  return rows;
}

export function previewCsv(buffer: Buffer): CsvPreview {
  const rows = readCsv(buffer);
  const headers = Object.keys(rows[0]!);

  return {
    headers,
    sampleRows: rows.slice(0, 5),
    totalRows: rows.length,
    suggestedMapping: {
      name: guessColumn(headers, 'name'),
      birthDate: guessColumn(headers, 'birthDate'),
      birthDay: guessColumn(headers, 'birthDay'),
      birthMonth: guessColumn(headers, 'birthMonth'),
      birthYear: guessColumn(headers, 'birthYear'),
      tag: guessColumn(headers, 'tag'),
      notes: guessColumn(headers, 'notes'),
    },
  };
}

/**
 * Parses a whole-date cell.
 *
 * ISO (`1996-03-15`) is unambiguous and tried first. Slash and dot formats are
 * genuinely ambiguous — `03/04` is March 4th in the US and 3rd April almost
 * everywhere else — so day-first is assumed, matching the `en-GB` rendering
 * used elsewhere, *except* where the first number cannot be a day. A caller
 * that needs certainty should map three separate columns instead.
 *
 * A year is optional throughout: `15/03` and `--03-15` are valid birthdays.
 */
export function parseBirthDateCell(
  raw: string,
): { month: number; day: number; year: number | null } | null {
  const value = raw.trim();
  if (!value) return null;

  // ISO 8601, with or without a year: 1996-03-15, --03-15, 03-15
  // The leading `-{0,2}` covers RFC 6350's year-less form, `--03-15`.
  const iso = /^(?:(\d{4})-)?-{0,2}(\d{1,2})-(\d{1,2})$/.exec(value);
  if (iso) {
    const year = iso[1] ? Number(iso[1]) : null;
    return { month: Number(iso[2]), day: Number(iso[3]), year };
  }

  // Day/month/year with / . or space separators, year optional.
  const parts = /^(\d{1,4})[/.\s](\d{1,2})(?:[/.\s](\d{2,4}))?$/.exec(value);
  if (parts) {
    let a = Number(parts[1]);
    let b = Number(parts[2]);
    let year = parts[3] ? Number(parts[3]) : null;

    // A leading 4-digit number is a year: 1996/03/15
    if (parts[1]!.length === 4) {
      const y = a;
      const month = b;
      const day = year ?? 0;
      return { month, day, year: y };
    }

    // Day-first unless the first number cannot be a day.
    let day = a;
    let month = b;
    if (a > 31 || (a <= 12 && b > 12)) {
      day = b;
      month = a;
    }

    if (year !== null && year < 100) {
      // Two-digit years: assume a birth date in the past century.
      const currentTwoDigit = new Date().getFullYear() % 100;
      year += year <= currentTwoDigit ? 2000 : 1900;
    }
    return { month, day, year };
  }

  // Month-name formats: "15 March 1996", "March 15, 1996"
  const named = /^(\d{1,2})?\s*([A-Za-z]{3,})\.?\s*(\d{1,2})?,?\s*(\d{4})?$/.exec(value);
  if (named) {
    const monthIndex = MONTH_NAMES.findIndex((m) => m.startsWith(named[2]!.toLowerCase().slice(0, 3)));
    if (monthIndex >= 0) {
      const day = named[1] ? Number(named[1]) : named[3] ? Number(named[3]) : NaN;
      if (Number.isFinite(day)) {
        return { month: monthIndex + 1, day, year: named[4] ? Number(named[4]) : null };
      }
    }
  }

  return null;
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function cell(row: Record<string, string>, column: string | null | undefined): string {
  if (!column) return '';
  return (row[column] ?? '').trim();
}

export function parseRows(buffer: Buffer, mapping: ColumnMapping): ParseResult {
  const rows = readCsv(buffer);

  if (!mapping.name) throw new ImportError('A column must be mapped to "name"');
  const hasSplitDate = Boolean(mapping.birthDay && mapping.birthMonth);
  if (!hasSplitDate && !mapping.birthDate) {
    throw new ImportError('Map either a single birth date column, or day and month columns');
  }

  const contacts: ParsedContact[] = [];
  const errors: RowError[] = [];

  rows.forEach((row, i) => {
    const rowNumber = i + 2; // +1 for zero-index, +1 for the header line.

    const name = cell(row, mapping.name);
    if (!name) {
      errors.push({ row: rowNumber, message: 'Missing name' });
      return;
    }

    let month: number;
    let day: number;
    let year: number | null;

    if (hasSplitDate) {
      day = Number(cell(row, mapping.birthDay));
      month = Number(cell(row, mapping.birthMonth));
      const rawYear = cell(row, mapping.birthYear);
      year = rawYear ? Number(rawYear) : null;

      if (!Number.isFinite(day) || !Number.isFinite(month)) {
        errors.push({ row: rowNumber, message: 'Day and month must be numbers' });
        return;
      }
    } else {
      const parsed = parseBirthDateCell(cell(row, mapping.birthDate));
      if (!parsed) {
        errors.push({
          row: rowNumber,
          message: `Could not read the date "${cell(row, mapping.birthDate)}"`,
        });
        return;
      }
      ({ month, day, year } = parsed);
    }

    if (!isValidBirthDate(month, day)) {
      errors.push({ row: rowNumber, message: `There is no day ${day} in month ${month}` });
      return;
    }

    if (year !== null && (!Number.isFinite(year) || year < 1900 || year > 2100)) {
      // A bad year is not worth losing the whole contact over — the birthday
      // still works, only the age is unknown.
      year = null;
    }

    contacts.push({
      name: name.slice(0, 200),
      birthMonth: month,
      birthDay: day,
      birthYear: year,
      tag: cell(row, mapping.tag).slice(0, 50) || null,
      notes: cell(row, mapping.notes).slice(0, 2000) || null,
    });
  });

  return { contacts, errors };
}
