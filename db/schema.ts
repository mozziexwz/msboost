import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';
export const users = sqliteTable('users', {
  id: text().primaryKey(),
  email: text().notNull().unique(),
  password: text().notNull(),
  role: text().notNull().default('customer'),
  trial_used: integer().notNull().default(0),
  disabled: integer().notNull().default(0),
  created_at: integer().notNull(),
});
export const sessions = sqliteTable(
  'sessions',
  {
    token: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => users.id),
    expires_at: integer().notNull(),
  },
  (t) => [index('sessions_user').on(t.user_id)],
);
export const codes = sqliteTable('email_codes', {
  email: text().primaryKey(),
  digest: text().notNull(),
  purpose: text().notNull(),
  expires_at: integer().notNull(),
  sent_at: integer().notNull(),
  attempts: integer().notNull().default(0),
  consumed: integer().notNull().default(0),
});
export const invites = sqliteTable('invitations', {
  id: text().primaryKey(),
  code_hash: text().notNull().unique(),
  label: text().notNull(),
  max_uses: integer().notNull(),
  uses: integer().notNull().default(0),
  expires_at: integer().notNull(),
  enabled: integer().notNull().default(1),
  created_at: integer().notNull(),
});
export const limits = sqliteTable('rate_limits', {
  key: text().primaryKey(),
  count: integer().notNull(),
  reset_at: integer().notNull(),
  blocked_until: integer().notNull().default(0),
});
export const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value: text().notNull(),
});
export const lines = sqliteTable('lines', {
  id: text().primaryKey(),
  name: text().notNull(),
  region: text().notNull(),
  description: text().notNull().default(''),
  host: text().notNull(),
  port_start: integer().notNull(),
  port_end: integer().notNull(),
  enabled: integer().notNull().default(0),
  requires_front: integer().notNull().default(0),
  token_hash: text().notNull(),
  heartbeat_at: integer(),
  probe_label: text().notNull().default('线路服务器 → 配置的探测目标'),
  rtt_ms: real(),
  loss_pct: real(),
  cpu_pct: real(),
  memory_pct: real(),
  version: text(),
  created_at: integer().notNull(),
});
export const samples = sqliteTable(
  'line_samples',
  {
    id: text().primaryKey(),
    line_id: text()
      .notNull()
      .references(() => lines.id),
    at: integer().notNull(),
    rtt_ms: real(),
    loss_pct: real(),
  },
  (t) => [index('samples_line_time').on(t.line_id, t.at)],
);
export const plans = sqliteTable('plans', {
  id: text().primaryKey(),
  name: text().notNull(),
  days: integer().notNull(),
  price_cents: integer().notNull(),
  speed_mbps: integer().notNull(),
  trial: integer().notNull().default(0),
  enabled: integer().notNull().default(0),
  sort: integer().notNull().default(0),
});
export const relays = sqliteTable(
  'relays',
  {
    id: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => users.id),
    line_id: text()
      .notNull()
      .references(() => lines.id),
    target_host: text().notNull(),
    target_ip: text().notNull(),
    target_port: integer().notNull(),
    protocol: text().notNull(),
    listen_port: integer().notNull(),
    expires_at: integer().notNull().default(0),
    speed_mbps: integer().notNull(),
    suspended: integer().notNull().default(0),
    revision: integer().notNull().default(1),
    reported_state: text().notNull().default('pending'),
    reported_revision: integer().notNull().default(0),
    reported_at: integer(),
    last_error: text(),
    created_at: integer().notNull(),
  },
  (t) => [
    uniqueIndex('relay_line_port').on(t.line_id, t.listen_port),
    uniqueIndex('relay_user_line').on(t.user_id, t.line_id),
  ],
);
export const orders = sqliteTable(
  'orders',
  {
    id: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => users.id),
    relay_id: text()
      .notNull()
      .references(() => relays.id),
    plan_id: text()
      .notNull()
      .references(() => plans.id),
    name: text().notNull(),
    days: integer().notNull(),
    price_cents: integer().notNull(),
    speed_mbps: integer().notNull(),
    trial: integer().notNull().default(0),
    status: text().notNull().default('pending'),
    channel: text().notNull(),
    provider_id: text().notNull(),
    trade_no: text(),
    created_at: integer().notNull(),
    paid_at: integer(),
    refund_state: text(),
    refund_note: text(),
  },
  (t) => [
    index('orders_user_created').on(t.user_id, t.created_at),
    uniqueIndex('orders_provider_trade').on(t.provider_id, t.trade_no),
  ],
);
export const grants = sqliteTable('grants', {
  order_id: text()
    .primaryKey()
    .references(() => orders.id),
  relay_id: text()
    .notNull()
    .references(() => relays.id),
  days: integer().notNull(),
  applied: integer().notNull().default(0),
  at: integer().notNull(),
});
export const tickets = sqliteTable('tickets', {
  id: text().primaryKey(),
  user_id: text()
    .notNull()
    .references(() => users.id),
  subject: text().notNull(),
  category: text().notNull(),
  status: text().notNull().default('open'),
  order_id: text(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
});
export const messages = sqliteTable(
  'ticket_messages',
  {
    id: text().primaryKey(),
    ticket_id: text()
      .notNull()
      .references(() => tickets.id),
    user_id: text()
      .notNull()
      .references(() => users.id),
    body: text().notNull(),
    created_at: integer().notNull(),
  },
  (t) => [index('messages_ticket').on(t.ticket_id, t.created_at)],
);
export const articles = sqliteTable('articles', {
  id: text().primaryKey(),
  kind: text().notNull(),
  title: text().notNull(),
  body: text().notNull(),
  published: integer().notNull().default(0),
  updated_at: integer().notNull(),
});
export const audit = sqliteTable('audit_logs', {
  id: text().primaryKey(),
  actor_id: text(),
  action: text().notNull(),
  subject: text().notNull(),
  ip: text().notNull(),
  created_at: integer().notNull(),
});
export const jobs = sqliteTable('provision_jobs', {
  id: text().primaryKey(),
  user_id: text()
    .notNull()
    .references(() => users.id),
  kind: text().notNull(),
  ip: text().notNull(),
  state: text().notNull(),
  relay_id: text().references(() => relays.id),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
});
export const configFiles = sqliteTable('config_files', {
  relay_id: text()
    .primaryKey()
    .references(() => relays.id),
  object_key: text().notNull(),
  created_at: integer().notNull(),
});
export const configGarbage = sqliteTable('config_garbage', {
  object_key: text().primaryKey(),
  delete_after: integer().notNull(),
});
export const fronts = sqliteTable('fronts', {
  relay_id: text()
    .primaryKey()
    .references(() => relays.id),
  host: text().notNull(),
  port: integer().notNull(),
  job_id: text().notNull(),
  created_at: integer().notNull(),
});
