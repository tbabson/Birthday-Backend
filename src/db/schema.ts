import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const notificationStatus = pgEnum('notification_status', [
  'pending',
  'sent',
  'failed',
  'skipped',
]);

export const notificationChannel = pgEnum('notification_channel', [
  'email',
  'push',
  'sms',
]);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash'),
    /** IANA zone name, e.g. 'Africa/Lagos'. Never a fixed offset — DST. */
    timezone: text('timezone').notNull().default('UTC'),
    /**
     * Fixed at 1 for v1 (§5.2). Kept as a column rather than hardcoded in
     * queries so a second reminder is a config change, not a refactor.
     */
    leadDays: smallint('lead_days').notNull().default(1),
    /** Hour of the day, in the user's own zone, that reminders are sent. */
    notifyHour: smallint('notify_hour').notNull().default(9),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_lower_idx').on(sql`lower(${t.email})`),
    check('users_notify_hour_range', sql`${t.notifyHour} BETWEEN 0 AND 23`),
    check('users_lead_days_range', sql`${t.leadDays} BETWEEN 0 AND 30`),
  ],
);

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /**
     * Month + day stored separately from year (§6.3). Storing a full DATE
     * forces you to invent a year for people whose age you don't know, and
     * age calculations then go quietly wrong.
     */
    birthMonth: smallint('birth_month').notNull(),
    birthDay: smallint('birth_day').notNull(),
    birthYear: smallint('birth_year'),
    tag: text('tag'),
    notes: text('notes'),
    photoUrl: text('photo_url'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // The sweep's index (§6.3).
    index('contacts_month_day_idx')
      .on(t.birthMonth, t.birthDay)
      .where(sql`deleted_at IS NULL`),
    index('contacts_user_idx').on(t.userId).where(sql`deleted_at IS NULL`),
    // Rejects Feb 30 and friends at the database level. Feb 29 is allowed:
    // it is a real birthday, observed on Feb 28 in non-leap years.
    check(
      'contacts_valid_month_day',
      sql`${t.birthMonth} BETWEEN 1 AND 12
          AND ${t.birthDay} BETWEEN 1 AND 31
          AND ${t.birthDay} <= CASE ${t.birthMonth}
              WHEN 2 THEN 29
              WHEN 4 THEN 30
              WHEN 6 THEN 30
              WHEN 9 THEN 30
              WHEN 11 THEN 30
              ELSE 31
            END`,
    ),
    check(
      'contacts_birth_year_range',
      sql`${t.birthYear} IS NULL OR ${t.birthYear} BETWEEN 1900 AND 2100`,
    ),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    /**
     * The year of the *birthday*, not the year the notification is sent.
     * A Jan 1 birthday fires its reminder on Dec 31 of the previous year;
     * keying on the send year silently breaks idempotency every New Year's
     * Eve (§6.4).
     */
    occurrenceYear: smallint('occurrence_year').notNull(),
    leadDays: smallint('lead_days').notNull(),
    channel: notificationChannel('channel').notNull().default('email'),
    status: notificationStatus('status').notNull().default('pending'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    providerMessageId: text('provider_message_id'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // The whole idempotency story (§6.2). A retried job, a double-scheduled
    // sweep, or a redeploy mid-run cannot produce a duplicate send — the
    // insert simply conflicts.
    uniqueIndex('notifications_idempotency_idx').on(
      t.contactId,
      t.occurrenceYear,
      t.leadDays,
      t.channel,
    ),
    index('notifications_pending_idx')
      .on(t.scheduledFor)
      .where(sql`status = 'pending'`),
    index('notifications_user_created_idx').on(t.userId, t.createdAt),
  ],
);

/**
 * Web Push endpoints (§5.3, channel v1.5).
 *
 * One row per browser/device, not per user — the same person installs the PWA
 * on a phone and a laptop and expects both to buzz. `endpoint` is unique
 * because that is the browser's own identifier for the subscription; a
 * re-subscribe with the same endpoint is an update, not a second device.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    /** Set when the push service reports the endpoint gone (404/410). */
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('push_subscriptions_endpoint_idx').on(t.endpoint),
    index('push_subscriptions_user_idx').on(t.userId).where(sql`expired_at IS NULL`),
  ],
);

/**
 * Extra people who receive this account's reminders.
 *
 * They get the email and nothing else — no login, no sight of the register,
 * no ability to change anything. Reminders still fire at the owner's delivery
 * hour in the owner's zone, because the schedule belongs to the register, not
 * to whoever is reading it.
 *
 * `confirmed_at` is the important column: an address receives nothing until
 * its owner clicks a confirmation link. Without that, adding a recipient is a
 * way to sign a stranger up for mail they never asked for.
 */
export const notificationRecipients = pgTable(
  'notification_recipients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    /** Optional human label, e.g. "Ada (wife)". */
    label: text('label'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('notification_recipients_user_email_idx').on(
      t.userId,
      sql`lower(${t.email})`,
    ),
    index('notification_recipients_user_idx').on(t.userId),
  ],
);

/** Server-side sessions. The cookie carries an opaque token; only its hash is stored. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_idx').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
  ],
);

/** Single-use magic-link tokens. Also hash-at-rest; consumed exactly once. */
export const magicLinkTokens = pgTable(
  'magic_link_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('magic_link_tokens_hash_idx').on(t.tokenHash),
    index('magic_link_tokens_user_idx').on(t.userId),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type NotificationRecipient = typeof notificationRecipients.$inferSelect;
export type NotificationStatus = (typeof notificationStatus.enumValues)[number];
export type NotificationChannel = (typeof notificationChannel.enumValues)[number];
