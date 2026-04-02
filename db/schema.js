import { pgTable, uuid, text, timestamp, pgEnum } from 'drizzle-orm/pg-core';

export const jobStatusEnum = pgEnum('job_status_enum', [
  'submitted',
  'runnable',
  'running',
  'succeeded',
  'failed'
]);

export const jobStatusenumValues = jobStatusEnum.enumValues;

export const jobStateTable = pgTable('jobs', {
  id: uuid().primaryKey().defaultRandom(),
  image: text().notNull(),
  cmd: text().default('null'),
  state: jobStatusEnum().default('submitted').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').$onUpdate(() => new Date()),
});