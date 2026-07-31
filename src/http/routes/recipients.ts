import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { getEmailProvider } from '../../email/provider.js';
import { renderRecipientConfirmation } from '../../email/templates.js';
import { logger } from '../../logger.js';
import {
  MAX_RECIPIENTS_PER_USER,
  addRecipient,
  countRecipients,
  confirmRecipient,
  deleteRecipient,
  deleteRecipientById,
  findRecipientById,
  listRecipients,
} from '../../repositories/recipients.js';
import { signRecipientLink, verifyRecipientLink } from '../../services/auth.js';
import { badRequest, notFound } from '../errors.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { emailSchema, idParamSchema } from '../validation.js';

export const recipientsRouter: Router = Router();

/** Tiny self-contained page — these links are opened by people with no account. */
function page(title: string, body: string, extra = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;padding:32px 20px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#14161a">
<div style="max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:24px">
<h1 style="margin:0 0 12px;font-size:20px">${title}</h1>${body}${extra}
</div></body></html>`;
}

// --- public links (no session; authenticated by HMAC) -----------------------

const linkLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

/**
 * Confirming is not destructive, so a GET is fine even though mail clients
 * prefetch links — the worst case is that someone who was going to say yes has
 * it recorded slightly early.
 */
recipientsRouter.get('/confirm', linkLimiter, async (req, res) => {
  const id = typeof req.query.r === 'string' ? req.query.r : '';
  const sig = typeof req.query.s === 'string' ? req.query.s : '';

  if (!id || !sig || !verifyRecipientLink(id, 'confirm', sig)) {
    res.status(400).type('html').send(page('That link is not valid', '<p>Ask for a new one.</p>'));
    return;
  }

  const ok = await confirmRecipient(db, id);
  if (!ok) {
    res
      .status(404)
      .type('html')
      .send(page('Nothing to confirm', '<p>This invitation no longer exists.</p>'));
    return;
  }

  res.type('html').send(
    page(
      "You're on the list",
      '<p style="color:#666d7a">You&rsquo;ll get an email the day before each birthday. ' +
        'Every reminder carries a link to stop.</p>',
    ),
  );
});

/**
 * Removal *is* destructive, so the GET only renders a button. A mail client
 * prefetching the link must not be able to unsubscribe someone by accident —
 * the same reasoning as the owner's unsubscribe route.
 */
recipientsRouter.get('/remove', linkLimiter, async (req, res) => {
  const id = typeof req.query.r === 'string' ? req.query.r : '';
  const sig = typeof req.query.s === 'string' ? req.query.s : '';

  if (!id || !sig || !verifyRecipientLink(id, 'remove', sig)) {
    res.status(400).type('html').send(page('That link is not valid', '<p>Nothing was changed.</p>'));
    return;
  }

  res.type('html').send(
    page(
      'Stop receiving these reminders?',
      '<p style="color:#666d7a">You will no longer get birthday reminders from this register.</p>',
      `<form method="post" action="/recipients/remove">
         <input type="hidden" name="r" value="${id}">
         <input type="hidden" name="s" value="${sig}">
         <button type="submit" style="width:100%;min-height:44px;margin-top:16px;border:0;border-radius:12px;background:#c02626;color:#fff;font-size:16px;font-weight:600">Yes, stop them</button>
       </form>`,
    ),
  );
});

recipientsRouter.post('/remove', linkLimiter, async (req, res) => {
  const id = typeof req.body?.r === 'string' ? req.body.r : '';
  const sig = typeof req.body?.s === 'string' ? req.body.s : '';

  if (!id || !sig || !verifyRecipientLink(id, 'remove', sig)) {
    res.status(400).type('html').send(page('That link is not valid', '<p>Nothing was changed.</p>'));
    return;
  }

  await deleteRecipientById(db, id);
  res.type('html').send(page('Removed', '<p style="color:#666d7a">You will not get any more of these.</p>'));
});

// --- owner-managed ----------------------------------------------------------

recipientsRouter.use(requireAuth);

function publicShape(r: { id: string; email: string; label: string | null; confirmedAt: Date | null; createdAt: Date }) {
  return {
    id: r.id,
    email: r.email,
    label: r.label,
    confirmed: r.confirmedAt !== null,
    createdAt: r.createdAt.toISOString(),
  };
}

recipientsRouter.get('/', async (req, res) => {
  const user = currentUser(req);
  const rows = await listRecipients(db, user.id);
  res.json({ recipients: rows.map(publicShape), max: MAX_RECIPIENTS_PER_USER });
});

const addSchema = z.object({
  email: emailSchema,
  label: z.string().trim().max(60).nullish(),
});

async function sendConfirmation(recipientId: string, email: string, ownerEmail: string) {
  const message = renderRecipientConfirmation({
    ownerEmail,
    confirmUrl: signRecipientLink(recipientId, 'confirm'),
  });
  await getEmailProvider().send({ ...message, to: email });
}

recipientsRouter.post('/', async (req, res) => {
  const user = currentUser(req);
  const { email, label } = addSchema.parse(req.body);

  if (email.toLowerCase() === user.email.toLowerCase()) {
    throw badRequest('You already receive these — no need to add yourself.');
  }

  const existing = await listRecipients(db, user.id);
  const alreadyThere = existing.some((r) => r.email.toLowerCase() === email.toLowerCase());
  if (!alreadyThere && existing.length >= MAX_RECIPIENTS_PER_USER) {
    throw badRequest(`You can add up to ${MAX_RECIPIENTS_PER_USER} extra recipients.`);
  }

  const recipient = await addRecipient(db, user.id, email, label ?? null);

  if (!recipient.confirmedAt) {
    try {
      await sendConfirmation(recipient.id, recipient.email, user.email);
    } catch (err) {
      logger.error({ err, recipientId: recipient.id }, 'confirmation email failed');
    }
  }

  logger.info({ userId: user.id, recipientId: recipient.id }, 'recipient added');
  res.status(201).json({ recipient: publicShape(recipient) });
});

recipientsRouter.post('/:id/resend', async (req, res) => {
  const user = currentUser(req);
  const { id } = idParamSchema.parse(req.params);

  const recipient = await findRecipientById(db, id);
  if (!recipient || recipient.userId !== user.id) throw notFound('Recipient not found');
  if (recipient.confirmedAt) throw badRequest('That address is already confirmed.');

  await sendConfirmation(recipient.id, recipient.email, user.email);
  res.json({ ok: true });
});

recipientsRouter.delete('/:id', async (req, res) => {
  const user = currentUser(req);
  const { id } = idParamSchema.parse(req.params);

  const removed = await deleteRecipient(db, user.id, id);
  if (!removed) throw notFound('Recipient not found');

  res.json({ ok: true });
});
