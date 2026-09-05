import { assert, DAY, equal, id, normalizeEmail, now } from './core';
import {
  audit,
  authReadiness,
  clientIp,
  db,
  env,
  hash,
  hex,
  hmac,
  one,
  passwordHash,
  passwordValid,
  settings,
  smtpPayload,
  stmt,
  throttle,
  turnstile,
  workerFetch,
} from './server';
export async function setupAvailable() {
  return Boolean(
    env.APP_ENCRYPTION_KEY &&
    typeof env.ADMIN_SETUP_TOKEN === 'string' &&
    env.ADMIN_SETUP_TOKEN.length >= 32 &&
    env.OWNER_EMAIL &&
    !(await one("SELECT id FROM users WHERE role='admin' LIMIT 1")),
  );
}
export async function setupAdmin(req: Request, b: any) {
  await throttle('setup:' + clientIp(req), 5, 900);
  assert(await setupAvailable(), '管理员初始化未启用或已完成', 403);
  assert(
    typeof b.setup_token === 'string' &&
      equal(b.setup_token, env.ADMIN_SETUP_TOKEN),
    '初始化密钥无效',
    403,
  );
  const email = normalizeEmail(b.email);
  assert(
    email === String(env.OWNER_EMAIL).trim().toLowerCase(),
    '请输入部署时指定的管理员 QQ 邮箱',
    403,
  );
  const uid = id(),
    pw = await passwordHash(b.password);
  await stmt(
    "INSERT INTO users(id,email,password,role,created_at) SELECT ?,?,?,'admin',? WHERE NOT EXISTS(SELECT 1 FROM users WHERE role='admin')",
    uid,
    email,
    pw,
    now(),
  ).run();
  assert(
    await one('SELECT id FROM users WHERE id=?', uid),
    '管理员已初始化',
    409,
  );
  await audit(req, uid, 'admin.setup', email);
  return startSession(req, uid);
}
export async function sendCode(req: Request, b: any) {
  const s = await settings(),
    email = normalizeEmail(b.email);
  assert(['register', 'reset'].includes(b.purpose), '无效的验证码用途');
  assert(
    authReadiness(s).mail_ready,
    '邮件发送尚未启用，请联系管理员；已有账号仍可登录',
    503,
  );
  await throttle('mail-ip:' + clientIp(req), 10, 3600);
  await throttle('mail:' + email, 1, 60);
  await turnstile(req, b.token, 'email', s);
  const code = String(
      crypto.getRandomValues(new Uint32Array(1))[0] % 1000000,
    ).padStart(6, '0'),
    t = now();
  const digest = await hmac(`code:${email}:${b.purpose}:${code}`);
  await stmt(
    'INSERT INTO email_codes(email,digest,purpose,expires_at,sent_at) VALUES(?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET digest=excluded.digest,purpose=excluded.purpose,expires_at=excluded.expires_at,sent_at=excluded.sent_at,attempts=0,consumed=0',
    email,
    digest,
    b.purpose,
    t + 600,
    t,
  ).run();
  try {
    await workerFetch(s, '/mail', {
      email,
      code,
      purpose: b.purpose,
      smtp: smtpPayload(s),
    });
  } catch (e) {
    await stmt(
      'UPDATE email_codes SET consumed=1 WHERE email=? AND digest=?',
      email,
      digest,
    ).run();
    throw e;
  }
  return { message: '验证码已发送，10 分钟内有效' };
}
async function verifyCode(email: string, purpose: string, code: unknown) {
  assert(typeof code === 'string' && /^\d{6}$/.test(code), '请输入 6 位验证码');
  const r = await one('SELECT * FROM email_codes WHERE email=?', email);
  assert(
    r &&
      r.purpose === purpose &&
      !r.consumed &&
      r.expires_at > now() &&
      r.attempts < 5,
    '验证码已过期或尝试次数过多',
  );
  await stmt(
    'UPDATE email_codes SET attempts=attempts+1 WHERE email=?',
    email,
  ).run();
  const digest = await hmac(`code:${email}:${purpose}:${code}`);
  assert(equal(digest, r.digest), '验证码错误');
  return digest;
}
export async function register(req: Request, b: any) {
  const s = await settings();
  await throttle('register:' + clientIp(req), 10, 3600);
  await turnstile(req, b.token, 'register', s);
  const email = normalizeEmail(b.email),
    digest = await verifyCode(email, 'register', b.code);
  assert(
    !(await one('SELECT id FROM users WHERE email=?', email)),
    '该邮箱已注册',
  );
  assert(b.agreed === true, '请阅读并同意服务协议和隐私政策');
  const invitation =
    typeof b.invite === 'string' ? await hash(b.invite.trim()) : '';
  const owner =
    email ===
    String(env.OWNER_EMAIL || '')
      .trim()
      .toLowerCase();
  const required = s.invite_required && !owner;
  const invited = await one(
    'SELECT * FROM invitations WHERE code_hash=? AND enabled=1 AND uses<max_uses AND expires_at>?',
    invitation,
    now(),
  );
  assert(!required || invited, '邀请码无效或已用完');
  const uid = id(),
    pw = await passwordHash(b.password);
  await db().batch([
    stmt(
      'INSERT INTO users(id,email,password,role,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM email_codes WHERE email=? AND digest=? AND consumed=0 AND expires_at>? AND attempts<=5) AND (?=0 OR EXISTS(SELECT 1 FROM invitations WHERE code_hash=? AND enabled=1 AND uses<max_uses AND expires_at>?))',
      uid,
      email,
      pw,
      owner ? 'admin' : 'customer',
      now(),
      email,
      digest,
      now(),
      required ? 1 : 0,
      invitation,
      now(),
    ),
    stmt(
      'UPDATE invitations SET uses=uses+1 WHERE code_hash=? AND EXISTS(SELECT 1 FROM users WHERE id=?)',
      invited ? invitation : '',
      uid,
    ),
    stmt(
      'UPDATE email_codes SET consumed=1 WHERE email=? AND digest=? AND EXISTS(SELECT 1 FROM users WHERE id=?)',
      email,
      digest,
      uid,
    ),
  ]);
  assert(
    await one('SELECT id FROM users WHERE id=?', uid),
    '验证码或邀请码已失效，请重新尝试',
    409,
  );
  await audit(req, uid, 'auth.register', email);
  return startSession(req, uid);
}
async function startSession(req: Request, uid: string) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await stmt(
    'INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)',
    await hash(token),
    uid,
    now() + 7 * DAY,
  ).run();
  return {
    token,
    cookie: `msboost_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * DAY}${new URL(req.url).protocol === 'https:' ? '; Secure' : ''}`,
  };
}
export async function login(req: Request, b: any) {
  const s = await settings(),
    ip = clientIp(req),
    email = normalizeEmail(b.email),
    t = now();
  const blocked = await one(
    'SELECT blocked_until FROM rate_limits WHERE key=?',
    'login-ip:' + ip,
  );
  assert(
    !blocked || blocked.blocked_until <= t,
    '该 IP 登录失败过多，已暂时封禁',
    429,
  );
  await throttle('login-account:' + email, 20, 900);
  await turnstile(req, b.token, 'login', s);
  const u = await one('SELECT * FROM users WHERE email=?', email);
  const valid = u
    ? await passwordValid(b.password, u.password)
    : typeof b.password === 'string' &&
        b.password.length >= 10 &&
        b.password.length <= 128
      ? (await passwordHash(b.password, '0'.repeat(32)), false)
      : false;
  if (!u || !valid || u.disabled) {
    await stmt(
      'INSERT INTO rate_limits(key,count,reset_at,blocked_until) VALUES(?,1,?,0) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,reset_at=CASE WHEN reset_at<=? THEN ? ELSE reset_at END',
      'login-ip:' + ip,
      t + s.login_window_seconds,
      t,
      t,
      t + s.login_window_seconds,
    ).run();
    await stmt(
      'UPDATE rate_limits SET blocked_until=? WHERE key=? AND count>=?',
      t + s.ip_ban_seconds,
      'login-ip:' + ip,
      s.login_failure_threshold,
    ).run();
    await audit(req, null, 'auth.failed', email);
    assert(false, '邮箱或密码错误', 401);
  }
  await stmt('DELETE FROM rate_limits WHERE key=?', 'login-ip:' + ip).run();
  await audit(req, u.id, 'auth.login', email);
  return startSession(req, u.id);
}
export async function resetPassword(req: Request, b: any) {
  const s = await settings();
  await throttle('reset:' + clientIp(req), 10, 3600);
  await turnstile(req, b.token, 'reset', s);
  const email = normalizeEmail(b.email),
    digest = await verifyCode(email, 'reset', b.code),
    pw = await passwordHash(b.password),
    u = await one('SELECT id FROM users WHERE email=?', email);
  assert(u, '该邮箱尚未注册');
  await db().batch([
    stmt(
      'UPDATE users SET password=? WHERE id=? AND EXISTS(SELECT 1 FROM email_codes WHERE email=? AND digest=? AND consumed=0 AND expires_at>?)',
      pw,
      u.id,
      email,
      digest,
      now(),
    ),
    stmt('DELETE FROM sessions WHERE user_id=?', u.id),
    stmt(
      'UPDATE email_codes SET consumed=1 WHERE email=? AND digest=?',
      email,
      digest,
    ),
  ]);
  await audit(req, u.id, 'auth.reset', email);
  return { message: '密码已修改，请重新登录' };
}
