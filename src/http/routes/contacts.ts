import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { todayIn } from '../../domain/dates.js';
import { logger } from '../../logger.js';
import {
  createContact,
  getContact,
  listContacts,
  listTags,
  restoreContact,
  softDeleteContact,
  updateContact,
} from '../../repositories/contacts.js';
import { cancelPendingForContact } from '../../repositories/notifications.js';
import { buildContactViews, toContactView } from '../../services/contacts.js';
import { catchUpForContact } from '../../services/sweep.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { badRequest, notFound } from '../errors.js';
import {
  createContactSchema,
  idParamSchema,
  listContactsQuerySchema,
  updateContactSchema,
} from '../validation.js';
import { isValidBirthDate } from '../../domain/dates.js';

export const contactsRouter: Router = Router();

contactsRouter.use(requireAuth);

const writeLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.WRITE_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

contactsRouter.get('/', async (req, res) => {
  const user = currentUser(req);
  const { tag, q, sort, includeDeleted } = listContactsQuerySchema.parse(req.query);

  const rows = await listContacts(db, user.id, { tag, q, includeDeleted });
  res.json({ contacts: buildContactViews(rows, user, new Date(), sort) });
});

contactsRouter.get('/tags', async (req, res) => {
  const user = currentUser(req);
  res.json({ tags: await listTags(db, user.id) });
});

contactsRouter.get('/:id', async (req, res) => {
  const user = currentUser(req);
  const { id } = idParamSchema.parse(req.params);

  const contact = await getContact(db, user.id, id);
  if (!contact) throw notFound('Contact not found');

  res.json({ contact: toContactView(contact, todayIn(user.timezone, new Date())) });
});

contactsRouter.post('/', writeLimiter, async (req, res) => {
  const user = currentUser(req);
  const input = createContactSchema.parse(req.body);

  const contact = await createContact(db, user.id, input);

  // §6.4: the 09:00 sweep may already have run today. Without this, a contact
  // added the afternoon before their birthday gets no reminder at all.
  try {
    await catchUpForContact(user, contact);
  } catch (err) {
    logger.error({ err, contactId: contact.id }, 'catch-up check failed on create');
  }

  res.status(201).json({ contact: toContactView(contact, todayIn(user.timezone, new Date())) });
});

contactsRouter.patch('/:id', writeLimiter, async (req, res) => {
  const user = currentUser(req);
  const { id } = idParamSchema.parse(req.params);
  const patch = updateContactSchema.parse(req.body);

  const existing = await getContact(db, user.id, id);
  if (!existing || existing.deletedAt) throw notFound('Contact not found');

  // A patch that moves only the day (or only the month) has to be checked
  // against the stored half, or you can walk a 31 January contact into
  // 31 February in two valid-looking requests.
  const month = patch.birthMonth ?? existing.birthMonth;
  const day = patch.birthDay ?? existing.birthDay;
  if (!isValidBirthDate(month, day)) {
    throw badRequest(`There is no day ${day} in month ${month}`);
  }

  const contact = await updateContact(db, user.id, id, patch);
  if (!contact) throw notFound('Contact not found');

  const birthdayMoved =
    contact.birthMonth !== existing.birthMonth || contact.birthDay !== existing.birthDay;
  if (birthdayMoved) {
    try {
      await catchUpForContact(user, contact);
    } catch (err) {
      logger.error({ err, contactId: contact.id }, 'catch-up check failed on update');
    }
  }

  res.json({ contact: toContactView(contact, todayIn(user.timezone, new Date())) });
});

contactsRouter.delete('/:id', writeLimiter, async (req, res) => {
  const user = currentUser(req);
  const { id } = idParamSchema.parse(req.params);

  const contact = await softDeleteContact(db, user.id, id);
  if (!contact) throw notFound('Contact not found');

  // §6.4: cancel pending notifications on soft-delete.
  const cancelled = await cancelPendingForContact(db, user.id, id);

  res.json({ ok: true, cancelledNotifications: cancelled });
});

contactsRouter.post('/:id/restore', writeLimiter, async (req, res) => {
  const user = currentUser(req);
  const { id } = idParamSchema.parse(req.params);

  const contact = await restoreContact(db, user.id, id);
  if (!contact) throw notFound('Contact not found or not deleted');

  // A contact restored the day before their birthday needs the same catch-up
  // as a newly created one — the sweep that would have found them has run.
  try {
    await catchUpForContact(user, contact);
  } catch (err) {
    logger.error({ err, contactId: contact.id }, 'catch-up check failed on restore');
  }

  res.json({ contact: toContactView(contact, todayIn(user.timezone, new Date())) });
});
