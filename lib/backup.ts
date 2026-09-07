import { assert, now } from './core';
import {
  audit,
  db,
  decrypt,
  encrypt,
  env,
  hash,
  rows,
  settings,
  stmt,
  workerFetch,
  type User,
} from './server';

const TABLES = {
  settings: ['key', 'value'],
  users: [
    'id',
    'email',
    'password',
    'role',
    'trial_used',
    'disabled',
    'created_at',
  ],
  invitations: [
    'id',
    'code_hash',
    'code_encrypted',
    'label',
    'max_uses',
    'uses',
    'expires_at',
    'enabled',
    'created_at',
  ],
  lines: [
    'id',
    'name',
    'region',
    'description',
    'host',
    'port_start',
    'port_end',
    'enabled',
    'requires_front',
    'token_hash',
    'heartbeat_at',
    'probe_label',
    'probe_ip',
    'rtt_ms',
    'loss_pct',
    'cpu_pct',
    'memory_pct',
    'version',
    'created_at',
  ],
  plans: [
    'id',
    'name',
    'days',
    'price_cents',
    'speed_mbps',
    'traffic_gb',
    'trial',
    'enabled',
    'sort',
  ],
  articles: ['id', 'kind', 'title', 'body', 'published', 'updated_at'],
  relays: [
    'id',
    'user_id',
    'line_id',
    'target_host',
    'target_ip',
    'target_port',
    'protocol',
    'listen_port',
    'expires_at',
    'speed_mbps',
    'traffic_limit_bytes',
    'traffic_used_bytes',
    'current_bps',
    'suspended',
    'revision',
    'reported_state',
    'reported_revision',
    'reported_at',
    'last_error',
    'created_at',
  ],
  orders: [
    'id',
    'user_id',
    'relay_id',
    'plan_id',
    'name',
    'days',
    'price_cents',
    'speed_mbps',
    'traffic_gb',
    'trial',
    'status',
    'channel',
    'provider_id',
    'trade_no',
    'created_at',
    'paid_at',
    'refund_state',
    'refund_note',
  ],
  grants: ['order_id', 'relay_id', 'days', 'applied', 'at'],
  tickets: [
    'id',
    'user_id',
    'subject',
    'category',
    'status',
    'order_id',
    'created_at',
    'updated_at',
  ],
  ticket_messages: ['id', 'ticket_id', 'user_id', 'body', 'created_at'],
  provision_jobs: [
    'id',
    'user_id',
    'kind',
    'ip',
    'state',
    'relay_id',
    'created_at',
    'updated_at',
  ],
  line_samples: ['id', 'line_id', 'at', 'rtt_ms', 'loss_pct'],
  config_files: ['relay_id', 'object_key', 'created_at'],
  fronts: ['relay_id', 'host', 'port', 'job_id', 'created_at'],
  audit_logs: ['id', 'actor_id', 'action', 'subject', 'ip', 'created_at'],
  content_assets: ['id', 'object_key', 'content_type', 'size', 'created_at'],
  backup_targets: [
    'id',
    'name',
    'host',
    'port',
    'username',
    'remote_path',
    'credential',
    'enabled',
    'created_at',
  ],
} as const;
type BackupTable = keyof typeof TABLES;
const INSERT_ORDER: BackupTable[] = [
  'settings',
  'users',
  'invitations',
  'lines',
  'plans',
  'articles',
  'relays',
  'orders',
  'grants',
  'tickets',
  'ticket_messages',
  'provision_jobs',
  'line_samples',
  'config_files',
  'fronts',
  'audit_logs',
  'content_assets',
  'backup_targets',
];
const DELETE_ORDER = [...INSERT_ORDER].reverse();

async function keyId() {
  return (await hash(String(env.APP_ENCRYPTION_KEY || ''))).slice(0, 16);
}
export async function createBackup(req: Request, u: User) {
  const result = await backupPayload();
  await audit(
    req,
    u.id,
    'admin.backup.export',
    String(
      Object.values(result.tables).reduce((n, value) => n + value.length, 0),
    ),
  );
  return result;
}
export async function backupPayload() {
  const tables: Record<string, unknown[]> = {};
  for (const name of INSERT_ORDER)
    tables[name] = await rows(`SELECT ${TABLES[name].join(',')} FROM ${name}`);
  return {
    format: 'msboost-backup',
    version: 2,
    created_at: now(),
    key_id: await keyId(),
    scope: ['站点配置', '用户与工单', '转发规则', '订单与财务'],
    note: '不包含会话、验证码、登录封禁，以及 R2 中的配置文件内容；config_files 元数据只适用于恢复到同一站点。',
    tables,
  };
}
export async function remoteBackup() {
  const s = await settings(),
    targets = await rows('SELECT * FROM backup_targets WHERE enabled=1');
  assert(targets.length, '请先添加并启用备份服务器');
  const result = await workerFetch(s, '/backup', {
    filename: `msboost-${new Date().toISOString().replace(/[:.]/g, '-')}.json.enc`,
    data: await encrypt(JSON.stringify(await backupPayload())),
    targets: await Promise.all(
      targets.map(async (t) => ({
        host: t.host,
        port: t.port,
        username: t.username,
        password: await decrypt(t.credential),
        remote_path: t.remote_path,
      })),
    ),
  });
  return { saved: Number(result.saved || 0), total: targets.length };
}
function validate(data: any, current: User) {
  assert(
    data?.format === 'msboost-backup' && data.version === 2,
    '备份格式或版本不受支持',
  );
  assert(data.key_id && typeof data.key_id === 'string', '备份缺少密钥标识');
  assert(
    data.tables &&
      typeof data.tables === 'object' &&
      !Array.isArray(data.tables),
    '备份数据无效',
  );
  let total = 0;
  for (const [name, columns] of Object.entries(TABLES)) {
    const list = data.tables[name];
    assert(Array.isArray(list), `备份缺少 ${name}`);
    total += list.length;
    assert(total <= 50000, '备份记录过多，请使用平台级数据库恢复');
    for (const row of list) {
      assert(
        row && typeof row === 'object' && !Array.isArray(row),
        `${name} 记录无效`,
      );
      assert(
        Object.keys(row).length === columns.length &&
          columns.every((c) => c in row),
        `${name} 字段不匹配`,
      );
      for (const c of columns)
        assert(
          ['string', 'number'].includes(typeof row[c]) || row[c] === null,
          `${name} 字段类型无效`,
        );
    }
  }
  const owners = data.tables.users.filter((x: any) => x.role === 'admin');
  assert(
    owners.length === 1 && owners[0].email === current.email,
    '备份必须包含当前管理员邮箱，且只能有一个管理员',
  );
  assert(
    data.tables.users.filter((x: any) => x.role === 'support').length <= 1,
    '备份中的客服账号超过限制',
  );
}
function insertStatements(name: BackupTable, list: any[]) {
  if (!list.length) return [];
  const columns = TABLES[name],
    result: D1PreparedStatement[] = [];
  let part: any[] = [],
    size = 2;
  const flush = () => {
    if (!part.length) return;
    const select = columns.map((c) => `json_extract(value,'$.${c}')`).join(',');
    result.push(
      stmt(
        `INSERT INTO ${name}(${columns.join(',')}) SELECT ${select} FROM json_each(?)`,
        JSON.stringify(part),
      ),
    );
    part = [];
    size = 2;
  };
  for (const row of list) {
    const encoded = JSON.stringify(row);
    if (part.length && size + encoded.length > 100000) flush();
    part.push(row);
    size += encoded.length + 1;
  }
  flush();
  return result;
}
export async function restoreBackup(req: Request, u: User, data: any) {
  validate(data, u);
  assert(
    data.key_id === (await keyId()),
    '备份使用了不同的加密主密钥，不能恢复密钥和配置',
  );
  const statements: D1PreparedStatement[] = [
    stmt('DELETE FROM sessions'),
    stmt('DELETE FROM email_codes'),
    stmt('DELETE FROM rate_limits'),
    stmt('DELETE FROM config_garbage'),
    stmt(
      'INSERT INTO config_garbage(object_key,delete_after) SELECT object_key,? FROM config_files',
      now(),
    ),
    ...DELETE_ORDER.map((name) => stmt(`DELETE FROM ${name}`)),
  ];
  for (const name of INSERT_ORDER)
    statements.push(...insertStatements(name, data.tables[name]));
  statements.push(
    stmt(
      'DELETE FROM config_garbage WHERE object_key IN (SELECT object_key FROM config_files)',
    ),
  );
  await db().batch(statements);
  await audit(
    req,
    u.id,
    'admin.backup.restore',
    String(data.created_at || 'unknown'),
  );
  return {
    restored: true,
    message:
      '恢复完成。为确保权限一致，所有登录会话已注销，请使用恢复后的管理员密码重新登录。',
  };
}
