import { assert, DAY, id, now } from './core';
import {
  audit,
  authReadiness,
  db,
  defaultSettings,
  encrypt,
  hash,
  hex,
  int,
  one,
  rows,
  secretKeys,
  settings,
  smtpPayload,
  stmt,
  text,
  throttle,
  workerFetch,
  type User,
} from './server';
import { initialArticles } from './content';
export async function adminSnapshot() {
  const s = await settings();
  for (const k of secretKeys) {
    s[k + '_configured'] = Boolean(s[k]);
    delete s[k];
  }
  return {
    settings: s,
    lines: await rows(
      'SELECT id,name,region,description,host,port_start,port_end,enabled,requires_front,heartbeat_at,probe_label FROM lines',
    ),
    plans: await rows('SELECT * FROM plans ORDER BY sort'),
    invitations: await rows(
      'SELECT id,label,max_uses,uses,expires_at,enabled,created_at FROM invitations ORDER BY created_at DESC LIMIT 100',
    ),
    users: await rows(
      'SELECT id,email,role,trial_used,disabled,created_at FROM users ORDER BY created_at DESC LIMIT 200',
    ),
    audit: await rows(
      'SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100',
    ),
    articles: await rows('SELECT * FROM articles ORDER BY kind,title'),
    orders: await rows(
      'SELECT o.*,u.email,r.expires_at,r.suspended,l.name AS line_name FROM orders o JOIN users u ON u.id=o.user_id JOIN relays r ON r.id=o.relay_id JOIN lines l ON l.id=r.line_id ORDER BY o.created_at DESC LIMIT 100',
    ),
    bans: await rows(
      "SELECT key,count,reset_at,blocked_until FROM rate_limits WHERE key LIKE 'login-ip:%' AND blocked_until>?",
      now(),
    ),
  };
}
export async function adminAction(
  req: Request,
  u: User,
  action: string,
  b: any,
) {
  if (action === 'mail-test') {
    await throttle('mail-test:' + u.id, 3, 300);
    const s = await settings();
    assert(
      authReadiness({ ...s, mail_enabled: true }).mail_ready,
      '请先保存完整的 SMTP 与执行服务器配置',
    );
    await workerFetch(s, '/mail', {
      email: u.email,
      purpose: 'test',
      smtp: smtpPayload(s),
    });
    await audit(req, u.id, 'admin.mail-test', u.email);
    return { message: '测试邮件已提交给邮件服务器，请检查管理员邮箱' };
  } else if (action === 'initialize') {
    await db().batch([
      ...[
        {
          id: 'trial',
          name: '新人体验天卡',
          days: 1,
          price: 0,
          speed: 20,
          trial: 1,
        },
        { id: 'day', name: '1 天卡', days: 1, price: 0, speed: 50, trial: 0 },
        { id: 'week', name: '7 天卡', days: 7, price: 0, speed: 50, trial: 0 },
        {
          id: 'month',
          name: '30 天卡',
          days: 30,
          price: 0,
          speed: 50,
          trial: 0,
        },
      ].map((p, i) =>
        stmt(
          'INSERT OR IGNORE INTO plans(id,name,days,price_cents,speed_mbps,trial,enabled,sort) VALUES(?,?,?,?,?,?,0,?)',
          p.id,
          p.name,
          p.days,
          p.price,
          p.speed,
          p.trial,
          i,
        ),
      ),
      ...initialArticles.map((a) =>
        stmt(
          'INSERT OR IGNORE INTO articles(id,kind,title,body,published,updated_at) VALUES(?,?,?,?,1,?)',
          a.id,
          a.kind,
          a.title,
          a.body,
          now(),
        ),
      ),
    ]);
  } else if (action === 'settings') {
    const current = await settings();
    const merged = {
      ...current,
      ...Object.fromEntries(
        Object.entries(b).filter(
          ([k, v]) => !secretKeys.includes(k) || v !== '',
        ),
      ),
    };
    if (merged.mail_enabled)
      assert(
        authReadiness(merged).mail_ready,
        '启用邮件前请先填写 SMTP、授权码和执行服务器设置',
      );
    if (b.turnstile_enabled === true)
      assert(
        (b.turnstile_secret || current.turnstile_secret) &&
          b.turnstile_site_key,
        '启用 Turnstile 前请先填写 Site Key 和 Secret Key',
      );
    const updates = [];
    for (const [k, v] of Object.entries(b)) {
      assert(k in defaultSettings || secretKeys.includes(k), '未知设置项');
      if (secretKeys.includes(k)) {
        if (v === '') continue;
        assert(typeof v === 'string' && v.length <= 2048, '密钥格式无效');
        updates.push(
          stmt(
            'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            k,
            await encrypt(v),
          ),
        );
        continue;
      }
      if (
        [
          'invite_required',
          'register_email_verification',
          'turnstile_enabled',
          'mail_enabled',
          'epay_alipay',
          'epay_wxpay',
          'terms_confirmed',
        ].includes(k)
      )
        assert(typeof v === 'boolean', '设置值应为开关');
      else if (k === 'smtp_port')
        assert(v === 465, '当前邮件服务使用 465 端口和 SSL/TLS');
      else if (k === 'login_failure_threshold') int(v, 3, 30, '失败次数');
      else if (['login_window_seconds', 'ip_ban_seconds'].includes(k))
        int(v, 60, 86400, '时长');
      else if (k === 'retention_days') int(v, 30, 3650, '保存天数');
      else assert(typeof v === 'string' && v.length <= 2048, '设置值过长');
      if (k === 'smtp_host')
        assert(
          typeof v === 'string' && /^[a-z0-9.-]+$/i.test(v),
          'SMTP 主机格式无效',
        );
      if (['smtp_user', 'smtp_from'].includes(k) && v)
        assert(
          typeof v === 'string' && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v),
          '请输入有效邮件地址',
        );
      if (['worker_url', 'epay_url'].includes(k) && v) {
        const url = new URL(String(v));
        assert(
          url.protocol === 'https:' &&
            !url.username &&
            !url.password &&
            !url.hash &&
            !url.search,
          '接口地址必须为不含凭据的 HTTPS URL',
        );
      }
      updates.push(
        stmt(
          'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          k,
          JSON.stringify(v),
        ),
      );
    }
    if (updates.length) await db().batch(updates);
  } else if (action === 'line') {
    const lid = b.id || id(),
      token = hex(crypto.getRandomValues(new Uint8Array(32)));
    assert(/^[a-f0-9]{32}$/.test(lid), '线路 ID 无效');
    const host = text(b.host, 253, '线路公网地址');
    assert(/^[a-z0-9.:\-]+$/i.test(host), '线路地址无效');
    const start = int(b.port_start, 1024, 65535, '端口池起点'),
      end = int(b.port_end, start, 65535, '端口池终点');
    const existing = await one('SELECT * FROM lines WHERE id=?', lid);
    if (existing) {
      const bound = await one(
        'SELECT id FROM relays WHERE line_id=? LIMIT 1',
        lid,
      );
      assert(
        !bound ||
          (host === existing.host &&
            start === existing.port_start &&
            end === existing.port_end),
        '已有订单时不能直接更换线路地址或端口池',
      );
    }
    await stmt(
      'INSERT INTO lines(id,name,region,description,host,port_start,port_end,enabled,requires_front,token_hash,created_at,probe_label) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,region=excluded.region,description=excluded.description,host=excluded.host,port_start=excluded.port_start,port_end=excluded.port_end,enabled=excluded.enabled,requires_front=excluded.requires_front,probe_label=excluded.probe_label',
      lid,
      text(b.name, 60, '线路名'),
      text(b.region, 60, '地区'),
      String(b.description || '').slice(0, 300),
      host,
      start,
      end,
      b.enabled ? 1 : 0,
      b.requires_front ? 1 : 0,
      await hash(token),
      now(),
      String(b.probe_label || '线路服务器 → 配置的探测目标').slice(0, 100),
    ).run();
    if (
      existing &&
      Boolean(existing.requires_front) !== Boolean(b.requires_front)
    )
      await stmt(
        'UPDATE relays SET revision=revision+1 WHERE line_id=?',
        lid,
      ).run();
    await audit(req, u.id, 'admin.line', lid);
    return { id: lid, ...(!existing ? { node_token: token } : {}) };
  } else if (action === 'rotate-line-token') {
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    assert(await one('SELECT id FROM lines WHERE id=?', b.id), '线路不存在');
    await stmt(
      'UPDATE lines SET token_hash=? WHERE id=?',
      await hash(token),
      b.id,
    ).run();
    await audit(req, u.id, 'admin.rotate-node', b.id);
    return { node_token: token };
  } else if (action === 'plan') {
    const pid = b.id || id();
    assert(
      typeof pid === 'string' && /^[a-z0-9_-]{1,40}$/.test(pid),
      '套餐 ID 无效',
    );
    const days = int(b.days, 1, 365, '天数'),
      price = int(b.price_cents, 0, 10000000, '金额（分）'),
      speed = int(b.speed_mbps, 1, 10000, '带宽');
    assert(!b.trial || (days === 1 && price === 0), '体验卡必须为免费 1 天卡');
    assert(
      b.trial || !b.enabled || price > 0,
      '收费套餐启用前请设置大于零的价格',
    );
    await stmt(
      'INSERT INTO plans(id,name,days,price_cents,speed_mbps,trial,enabled,sort) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,days=excluded.days,price_cents=excluded.price_cents,speed_mbps=excluded.speed_mbps,trial=excluded.trial,enabled=excluded.enabled,sort=excluded.sort',
      pid,
      text(b.name, 60, '套餐名'),
      days,
      price,
      speed,
      b.trial ? 1 : 0,
      b.enabled ? 1 : 0,
      int(b.sort || 0, 0, 1000, '排序'),
    ).run();
  } else if (action === 'invite') {
    const count = int(b.count || 1, 1, 50, '生成数量'),
      uses = int(b.max_uses || 1, 1, 10000, '使用次数'),
      days = int(b.days || 7, 1, 365, '有效天数'),
      codes = [];
    for (let i = 0; i < count; i++) {
      const code =
        'MS-' + hex(crypto.getRandomValues(new Uint8Array(8))).toUpperCase();
      codes.push(code);
      await stmt(
        'INSERT INTO invitations(id,code_hash,label,max_uses,expires_at,created_at) VALUES(?,?,?,?,?,?)',
        id(),
        await hash(code),
        String(b.label || '邀请注册').slice(0, 100),
        uses,
        now() + days * DAY,
        now(),
      ).run();
    }
    await audit(req, u.id, 'admin.invites', String(count));
    return { codes };
  } else if (action === 'revoke-invite')
    await stmt('UPDATE invitations SET enabled=0 WHERE id=?', b.id).run();
  else if (action === 'article') {
    assert(['policy', 'guide', 'notice'].includes(b.kind), '文章类型无效');
    await stmt(
      'INSERT INTO articles(id,kind,title,body,published,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,body=excluded.body,published=excluded.published,updated_at=excluded.updated_at',
      b.id || id(),
      b.kind,
      text(b.title, 150, '标题'),
      text(b.body, 20000, '正文'),
      b.published ? 1 : 0,
      now(),
    ).run();
  } else if (action === 'user') {
    assert(b.id !== u.id, '不能禁用当前管理员');
    assert(['customer', 'support'].includes(b.role), '角色无效');
    assert(
      b.role !== 'support' ||
        !(await one(
          "SELECT id FROM users WHERE role='support' AND id<>?",
          b.id,
        )),
      '当前最多配置一名客服',
    );
    await stmt(
      "UPDATE users SET role=?,disabled=? WHERE id=? AND role<>'admin'",
      b.role,
      b.disabled ? 1 : 0,
      b.id,
    ).run();
    if (b.disabled)
      await stmt('DELETE FROM sessions WHERE user_id=?', b.id).run();
  } else if (action === 'unban')
    await stmt(
      'DELETE FROM rate_limits WHERE key=?',
      text(b.key, 100, '封禁记录'),
    ).run();
  else if (action === 'relay') {
    const relay = await one('SELECT * FROM relays WHERE id=?', b.id);
    assert(relay, '转发不存在');
    await stmt(
      "UPDATE relays SET suspended=?,revision=revision+1,reported_state='pending' WHERE id=?",
      b.suspended ? 1 : 0,
      b.id,
    ).run();
  } else if (action === 'refund-record') {
    const o = await one('SELECT * FROM orders WHERE id=?', b.id);
    assert(o && ['paid', 'payment_review'].includes(o.status), '订单不能退款');
    assert(
      ['submitted', 'unknown', 'completed', 'rejected'].includes(b.state),
      '退款状态无效',
    );
    const note = text(b.note, 1000, '退款说明');
    if (b.state === 'completed')
      await db().batch([
        stmt(
          "UPDATE relays SET expires_at=MAX(?,expires_at-?),revision=revision+1,reported_state='pending' WHERE id=? AND EXISTS(SELECT 1 FROM orders WHERE id=? AND status='paid')",
          now(),
          o.days * DAY,
          o.relay_id,
          o.id,
        ),
        stmt(
          "UPDATE orders SET status='refunded',refund_state='completed',refund_note=? WHERE id=? AND status IN ('paid','payment_review')",
          note,
          o.id,
        ),
      ]);
    else
      await stmt(
        'UPDATE orders SET refund_state=?,refund_note=? WHERE id=?',
        b.state,
        note,
        o.id,
      ).run();
  } else assert(false, '管理操作不存在', 404);
  await audit(
    req,
    u.id,
    'admin.' + action,
    typeof b.id === 'string' ? b.id : action,
  );
  return { ok: true };
}
