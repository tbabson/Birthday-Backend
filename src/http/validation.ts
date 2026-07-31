import { z } from 'zod';
import { isValidBirthDate, isValidZone } from '../domain/dates.js';

const trimmed = (max: number) => z.string().trim().min(1).max(max);

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const timezoneSchema = z
  .string()
  .trim()
  .max(64)
  .refine(isValidZone, { message: 'Not a recognised IANA time zone name' });

/**
 * Month/day are validated together, and Feb 29 is deliberately allowed — it is
 * a real birthday. This mirrors the `contacts_valid_month_day` constraint so
 * the API rejects bad dates with a readable message before the database
 * rejects them with a constraint name.
 */
const birthFields = {
  birthMonth: z.number().int().min(1).max(12),
  birthDay: z.number().int().min(1).max(31),
  birthYear: z.number().int().min(1900).max(2100).nullish(),
};

const validBirthDate = <T extends { birthMonth: number; birthDay: number }>(
  value: T,
  ctx: z.RefinementCtx,
) => {
  if (!isValidBirthDate(value.birthMonth, value.birthDay)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['birthDay'],
      message: `There is no day ${value.birthDay} in month ${value.birthMonth}`,
    });
  }
};

export const createContactSchema = z
  .object({
    name: trimmed(200),
    ...birthFields,
    tag: z.string().trim().max(50).nullish(),
    notes: z.string().trim().max(2000).nullish(),
    photoUrl: z.string().trim().url().max(1000).nullish(),
  })
  .superRefine(validBirthDate);

export const updateContactSchema = z
  .object({
    name: trimmed(200).optional(),
    birthMonth: birthFields.birthMonth.optional(),
    birthDay: birthFields.birthDay.optional(),
    birthYear: z.number().int().min(1900).max(2100).nullish(),
    tag: z.string().trim().max(50).nullish(),
    notes: z.string().trim().max(2000).nullish(),
    photoUrl: z.string().trim().url().max(1000).nullish(),
  })
  .superRefine((value, ctx) => {
    // Only check the pair when both halves are present or derivable; a patch
    // that moves only the day is validated against the stored month upstream.
    if (value.birthMonth !== undefined && value.birthDay !== undefined) {
      validBirthDate({ birthMonth: value.birthMonth, birthDay: value.birthDay }, ctx);
    }
  });

export const magicLinkSchema = z.object({
  email: emailSchema,
  timezone: timezoneSchema.optional(),
});

export const updateMeSchema = z.object({
  timezone: timezoneSchema.optional(),
  notifyHour: z.number().int().min(0).max(23).optional(),
});

export const listContactsQuerySchema = z.object({
  tag: z.string().trim().max(50).optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['next_birthday', 'name', 'created_at']).default('next_birthday'),
  includeDeleted: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export const upcomingQuerySchema = z.object({
  window: z.coerce.number().int().min(1).max(366).default(30),
});

export const calendarQuerySchema = z.object({
  year: z.coerce.number().int().min(1900).max(2100).optional(),
});

export const notificationsQuerySchema = z.object({
  status: z.enum(['pending', 'sent', 'failed', 'skipped']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const idParamSchema = z.object({ id: z.string().uuid() });
