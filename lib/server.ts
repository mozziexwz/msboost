import { env as bindings } from 'cloudflare:workers';
import { assert, equal, id, now, publicIp, HttpError } from './core';
export const env = bindings as unknown as Record<string, any>;
export function db(): D1Database {
  assert(env.DB, '数据库尚未接入', 503);
  return env.DB;
}
export function stmt(sql: string, ...args: unknown[]) {
  return db()
    .prepare(sql)
    .bind(...args);
}
export async function one<T = any>(
  sql: string,
  ...args: unknown[]
): Promise<T | null> {
  return stmt(sql, ...args).first<T>();
}
export async function rows<T = any>(
  sql: string,
  ...args: unknown[]
): Promise<T[]> {
  return (await stmt(sql, ...args).all<T>()).results;
}
const encoder = new TextEncoder();
export function hex(b: ArrayBuffer | Uint8Array) {
  return Array.from(b instanceof Uint8Array ? b : new Uint8Array(b))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
function unhex(s: string) {
  return new Uint8Array((s.match(/.{2}/g) || []).map((x) => parseInt(x, 16)));
}
export async function hash(s: string) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(s)));
}
function rootSecret() {
  assert(
    typeof env.APP_ENCRYPTION_KEY === 'string' &&
      /^[a-f\d]{64}$/i.test(env.APP_ENCRYPTION_KEY),
    '请先配置 APP_ENCRYPTION_KEY',
    503,
  );
  return env.APP_ENCRYPTION_KEY as string;
}
export async function hmac(s: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(rootSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(s)));
}
export async function passwordHash(
  password: string,
  salt = hex(crypto.getRandomValues(new Uint8Array(16))),
) {
  assert(
    typeof password === 'string' &&
      password.length >= 10 &&
      password.length <= 128,
    '密码长度须为 10–128 位',
  );
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(await hmac('password:' + password)),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: unhex(salt), iterations: 100000 },
    key,
    256,
  );
  return `${salt}:${hex(bits)}`;
}
export async function passwordValid(password: string, stored: string) {
  if (
    typeof password !== 'string' ||
    password.length < 10 ||
    password.length > 128
  )
    return false;
  return equal(await passwordHash(password, stored.split(':')[0]), stored);
}
export async function encrypt(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12)),
    key = await crypto.subtle.importKey(
      'raw',
      unhex(rootSecret()),
      'AES-GCM',
      false,
      ['encrypt'],
    );
  return (
    hex(iv) +
    ':' +
    hex(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        encoder.encode(value),
      ),
    )
  );
}
export async function decrypt(value: string) {
  const [iv, data] = value.split(':'),
    key = await crypto.subtle.importKey(
      'raw',
      unhex(rootSecret()),
      'AES-GCM',
      false,
      ['decrypt'],
    );
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unhex(iv) },
      key,
      unhex(data),
    ),
  );
}
export const defaultSettings: Record<string, any> = {
  invite_required: true,
  register_email_verification: true,
  turnstile_enabled: false,
  mail_enabled: false,
  smtp_host: 'smtp.qq.com',
  smtp_port: 465,
  smtp_user: '',
  smtp_from: '',
  login_failure_threshold: 8,
  login_window_seconds: 900,
  ip_ban_seconds: 1800,
  turnstile_site_key: '',
  turnstile_hostnames: 'msboost.de',
  epay_url: '',
  epay_pid: '',
  epay_alipay: true,
  epay_wxpay: true,
  worker_url: '',
  support_email: '',
  retention_days: 90,
  backup_enabled: false,
  backup_mode: 'daily',
  backup_time: '03:00',
  backup_daily_count: 1,
  backup_last_slot: '',
  terms_confirmed: false,
};
export const secretKeys = [
  'turnstile_secret',
  'epay_key',
  'worker_token',
  'smtp_password',
];
export function authReadiness(s: Record<string, any>) {
  const login_ready = Boolean(
    env.APP_ENCRYPTION_KEY &&
    (!s.turnstile_enabled || (s.turnstile_site_key && s.turnstile_secret)),
  );
  const mail_ready = Boolean(
    s.mail_enabled &&
    s.worker_url &&
    s.worker_token &&
    s.smtp_host &&
    s.smtp_user &&
    s.smtp_from &&
    s.smtp_password,
  );
  return {
    login_ready,
    mail_ready,
    auth_ready: login_ready && (!s.register_email_verification || mail_ready),
  };
}
export function smtpPayload(s: Record<string, any>) {
  return {
    host: s.smtp_host,
    port: s.smtp_port,
    username: s.smtp_user,
    password: s.smtp_password,
    from: s.smtp_from,
  };
}
export async function settings() {
  const result: Record<string, any> = {
    ...defaultSettings,
    turnstile_site_key: env.TURNSTILE_SITE_KEY || '',
    turnstile_secret: env.TURNSTILE_SECRET_KEY || '',
    worker_url: env.WORKER_URL || '',
    worker_token: env.WORKER_TOKEN || '',
  };
  for (const r of await rows('SELECT key,value FROM settings'))
    result[r.key] = secretKeys.includes(r.key)
      ? await decrypt(r.value)
      : JSON.parse(r.value);
  return result;
}
export function clientIp(req: Request) {
  return req.headers.get('cf-connecting-ip') || '127.0.0.1';
}
export async function audit(
  req: Request,
  actor: string | null,
  action: string,
  subject: string,
) {
  await stmt(
    'INSERT INTO audit_logs(id,actor_id,action,subject,ip,created_at) VALUES(?,?,?,?,?,?)',
    id(),
    actor,
    action,
    subject.slice(0, 180),
    clientIp(req),
    now(),
  ).run();
}
export async function probeQuota(
  user: { id: string; role: string },
  consume = false,
  scope: 'probe' | 'deploy' = 'probe',
) {
  const t = now();
  if (user.role === 'admin')
    return {
      unlimited: true,
      used: 0,
      remaining: null,
      reset_at: null,
      server_time: t,
    };
  const key =
    (scope === 'probe' ? 'vps-probe-v2:' : 'vps-deploy-v2:') + user.id;
  if (consume) {
    const accepted = await stmt(
      'INSERT INTO rate_limits(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,reset_at=CASE WHEN reset_at<=? THEN ? ELSE reset_at END WHERE reset_at<=? OR count<10 RETURNING count',
      key,
      t + 1800,
      t,
      t,
      t + 1800,
      t,
    ).first<any>();
    assert(
      accepted,
      (scope === 'probe' ? '主机指纹检查' : '部署提交') +
        '已用完 10 次，请等待页面冷却倒计时结束',
      429,
    );
  }
  const row = await one(
    'SELECT count,reset_at FROM rate_limits WHERE key=?',
    key,
  );
  const active = row && row.reset_at > t;
  const used = active ? Math.min(10, row.count) : 0;
  return {
    unlimited: false,
    used,
    remaining: 10 - used,
    reset_at: active ? row.reset_at : null,
    server_time: t,
  };
}
export async function throttle(key: string, max: number, seconds: number) {
  const t = now();
  const r = await stmt(
    'INSERT INTO rate_limits(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,reset_at=CASE WHEN reset_at<=? THEN ? ELSE reset_at END RETURNING count',
    key,
    t + seconds,
    t,
    t,
    t + seconds,
  ).first<any>();
  assert(r.count <= max, '请求过于频繁，请稍后重试', 429);
}
export async function turnstile(
  req: Request,
  token: unknown,
  action: string,
  s: Record<string, any>,
) {
  if (!s.turnstile_enabled) return;
  assert(s.turnstile_secret && s.turnstile_site_key, '人机验证尚未配置', 503);
  assert(
    typeof token === 'string' && token.length > 0 && token.length <= 2048,
    '请完成人机验证',
  );
  const response = await fetch(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: s.turnstile_secret,
        response: token,
        remoteip: clientIp(req),
        idempotency_key: crypto.randomUUID(),
      }),
      signal: AbortSignal.timeout(10000),
    },
  );
  assert(response.ok, '验证服务暂时不可用', 503);
  const r = (await response.json()) as any;
  assert(
    r.success &&
      r.action === action &&
      String(s.turnstile_hostnames)
        .split(',')
        .map((x) => x.trim())
        .includes(r.hostname),
    '人机验证失败或已过期，请重试',
  );
}
export type User = {
  id: string;
  email: string;
  role: string;
  trial_used: number;
  disabled: number;
};
export async function currentUser(req: Request) {
  const raw = req.headers
    .get('cookie')
    ?.match(/(?:^|;\s*)msboost_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (!raw) return null;
  return one<User>(
    'SELECT u.id,u.email,u.role,u.trial_used,u.disabled FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>? AND u.disabled=0',
    await hash(raw),
    now(),
  );
}
export async function requireUser(req: Request, role?: 'admin' | 'staff') {
  const u = await currentUser(req);
  assert(u, '请先登录', 401);
  assert(
    !role || u.role === 'admin' || (role === 'staff' && u.role === 'support'),
    '没有此操作权限',
    403,
  );
  return u;
}
export function sameOrigin(req: Request) {
  const origin = req.headers.get('origin');
  assert(
    origin === new URL(req.url).origin ||
      (env.PUBLIC_ORIGIN && origin === env.PUBLIC_ORIGIN),
    '请求来源无效',
    403,
  );
}
export async function jsonBody(req: Request, maxBytes = 262144) {
  assert(
    (req.headers.get('content-type') || '').includes('application/json'),
    '请使用 JSON 请求',
  );
  const text = await req.text();
  assert(encoder.encode(text).length <= maxBytes, '请求内容过大', 413);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError('无效 JSON');
  }
  assert(
    data && typeof data === 'object' && !Array.isArray(data),
    '请求格式无效',
  );
  return data;
}
export async function resolveTarget(host: string) {
  assert(typeof host === 'string' && host.length <= 253, '节点地址无效');
  if (publicIp(host)) return host;
  assert(
    !/^[\d.:]+$/.test(host) &&
      /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/i.test(host) &&
      host.includes('.') &&
      !host.endsWith('.local'),
    '仅支持公网 IP 或域名',
  );
  const url =
    'https://cloudflare-dns.com/dns-query?name=' +
    encodeURIComponent(host) +
    '&type=A';
  const r = await fetch(url, {
    headers: { Accept: 'application/dns-json' },
    signal: AbortSignal.timeout(8000),
  });
  assert(r.ok, '无法解析节点域名');
  const d = (await r.json()) as any;
  const ips = (d.Answer || [])
    .filter((a: any) => a.type === 1)
    .map((a: any) => a.data);
  assert(ips.length && ips.every(publicIp), '域名必须解析到公网 IPv4');
  return ips[0] as string;
}
export function int(v: unknown, min: number, max: number, label: string) {
  assert(
    Number.isInteger(v) && Number(v) >= min && Number(v) <= max,
    `${label}须在 ${min}–${max} 范围`,
  );
  return Number(v);
}
export function text(v: unknown, max: number, label: string) {
  assert(
    typeof v === 'string' && v.trim().length > 0 && v.length <= max,
    `${label}格式无效`,
  );
  return v.trim();
}
export function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}
export async function workerFetch(
  s: Record<string, any>,
  path: string,
  body?: unknown,
) {
  assert(s.worker_url && s.worker_token, 'VPS 执行服务器尚未接入', 503);
  const url = new URL(s.worker_url);
  assert(
    url.protocol === 'https:' && !url.username && !url.password,
    '执行服务器必须使用 HTTPS',
  );
  assert(
    typeof s.worker_token === 'string' &&
      /^[\x21-\x7e]{32,2048}$/.test(s.worker_token),
    '执行服务器令牌格式无效：请只粘贴随机令牌，不要包含空格、换行或 WORKER_TOKEN= 前缀',
  );
  let r: Response;
  try {
    r = await fetch(new URL(path, url).href, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: 'Bearer ' + s.worker_token,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
      redirect: 'manual',
    });
  } catch (e: any) {
    const message = String(e?.message || '');
    const category = /timeout|timed out|abort/i.test(message)
      ? 'timeout'
      : /certificate|ssl|tls/i.test(message)
        ? 'tls'
        : /dns|resolve/i.test(message)
          ? 'dns'
          : /header|ByteString|character/i.test(message)
            ? 'header'
            : /redirect/i.test(message)
              ? 'redirect'
              : 'transport';
    console.error(
      'msboost.worker.request_failed',
      JSON.stringify({
        category,
        name: e?.name,
        stage: path === '/probe' ? 'probe' : 'worker',
        stack: String(e?.stack || '')
          .split('\n')
          .slice(1, 5)
          .join('\n'),
      }),
    );
    throw new HttpError(
      `网站连接执行服务器失败（${category}）；请检查执行服务 HTTPS 地址、证书与访问规则`,
      502,
    );
  }
  assert(
    r.status < 300 || r.status >= 400,
    `执行服务器返回 HTTP ${r.status} 重定向；为保护凭据已停止请求，请配置直接可达的 HTTPS 接口`,
    502,
  );
  let d: any;
  try {
    d = await r.json();
  } catch {
    throw new HttpError('执行服务器响应无效', 502);
  }
  assert(r.ok, d.error || '执行服务器暂时不可用', r.status);
  return d;
}
