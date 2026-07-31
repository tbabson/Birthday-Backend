import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { todayIn } from '../../domain/dates.js';
import { logger } from '../../logger.js';
import { bulkCreateContacts } from '../../repositories/contacts.js';
import { buildContactViews } from '../../services/contacts.js';
import { ImportError, previewCsv, parseRows } from '../../services/import.js';
import { catchUpForContact } from '../../services/sweep.js';
import { badRequest } from '../errors.js';
import { currentUser, requireAuth } from '../middleware/auth.js';

export const importRouter: Router = Router();

importRouter.use(requireAuth);

// §6.7: rate limits on auth and import. Import is the expensive endpoint —
// parsing and inserting thousands of rows — so it is limited harder than
// ordinary writes.
const importLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: Math.max(10, Math.floor(env.WRITE_RATE_LIMIT_MAX / 6)),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

// In memory: a contact CSV is small, and writing other people's personal data
// to a temp file on disk is a privacy liability for no benefit.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.IMPORT_MAX_BYTES, files: 1 },
});

const mappingSchema = z.object({
  name: z.string().min(1),
  birthDate: z.string().nullish(),
  birthDay: z.string().nullish(),
  birthMonth: z.string().nullish(),
  birthYear: z.string().nullish(),
  tag: z.string().nullish(),
  notes: z.string().nullish(),
});

function fileBuffer(req: Express.Request): Buffer {
  const file = (req as { file?: Express.Multer.File }).file;
  if (!file) throw badRequest('Attach a CSV file in the "file" field');
  return file.buffer;
}

/**
 * Step one: read the headers back so the user can confirm the mapping before
 * anything is written. Nothing is persisted here.
 */
importRouter.post('/preview', importLimiter, upload.single('file'), async (req, res) => {
  currentUser(req);
  try {
    res.json(previewCsv(fileBuffer(req)));
  } catch (err) {
    if (err instanceof ImportError) throw badRequest(err.message);
    throw err;
  }
});

/**
 * Step two: apply a confirmed mapping.
 *
 * Rows that cannot be read are reported rather than aborting the import — one
 * malformed date in a 300-row export should not cost the other 299.
 */
importRouter.post('/', importLimiter, upload.single('file'), async (req, res) => {
  const user = currentUser(req);

  const rawMapping = typeof req.body?.mapping === 'string' ? JSON.parse(req.body.mapping) : req.body?.mapping;
  const mapping = mappingSchema.parse(rawMapping ?? {});

  let parsed;
  try {
    parsed = parseRows(fileBuffer(req), mapping);
  } catch (err) {
    if (err instanceof ImportError) throw badRequest(err.message);
    throw err;
  }

  const { created, skipped } = await bulkCreateContacts(db, user.id, parsed.contacts);

  // §6.4 applies to imported contacts too: someone whose birthday is tomorrow
  // and whose row landed after today's sweep would otherwise be missed.
  let caughtUp = 0;
  for (const contact of created) {
    try {
      if (await catchUpForContact(user, contact)) caughtUp += 1;
    } catch (err) {
      logger.error({ err, contactId: contact.id }, 'catch-up check failed on import');
    }
  }

  const today = todayIn(user.timezone, new Date());

  res.status(201).json({
    imported: created.length,
    skippedAsDuplicates: skipped,
    remindersScheduled: caughtUp,
    failedRows: parsed.errors,
    contacts: buildContactViews(created, user, new Date()).slice(0, 50),
    today: `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`,
  });
});
