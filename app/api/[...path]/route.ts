import { assert, apiParams, DAY, id, now, publicIp } from '@/lib/core';
import {
  audit,
  authReadiness,
  clientIp,
  currentUser,
  db,
  env,
  hash,
  int,
  json,
  jsonBody,
  one,
  requireUser,
  rows,
  sameOrigin,
  settings,
  stmt,
  text,
  throttle,
  probeQuota,
  workerFetch,
} from '@/lib/server';
import {
  login,
  register,
  resetPassword,
  sendCode,
  setupAdmin,
  setupAvailable,
} from '@/lib/auth';
import {
  checkPayment,
  createOrder,
  paymentForm,
  verifyNotification,
} from '@/lib/commerce';
import { adminAction, adminSnapshot } from '@/lib/admin';
import { initialArticles } from '@/lib/content';
import { bindConfig, getConfig, purgeExpired, saveConfig } from '@/lib/configs';
import { equal } from '@/lib/core';
import { createBackup, remoteBackup, restoreBackup } from '@/lib/backup';
import { getArticleImage, saveArticleImage } from '@/lib/content-assets';
export const dynamic = 'force-dynamic';
async function ensureContentRevision() {
  const revision = await one(
    'SELECT value FROM settings WHERE key=?',
    'content_revision',
  );
  if (revision?.value === '2') return;
  await db().batch([
    ...initialArticles
      .filter((a) =>
        ['guide-start', 'guide-clock', 'terms', 'privacy', 'aup'].includes(
          a.id,
        ),
      )
      .map((a) =>
        stmt(
          'INSERT INTO articles(id,kind,title,body,published,updated_at) VALUES(?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,body=excluded.body,published=1,updated_at=excluded.updated_at',
          a.id,
          a.kind,
          a.title,
          a.body,
          now(),
        ),
      ),
    stmt(
      "INSERT INTO settings(key,value) VALUES('content_revision','2') ON CONFLICT(key) DO UPDATE SET value='2'",
    ),
  ]);
}
async function handle(req: Request) {
  const path = new URL(req.url).pathname.replace(/^\/api\//, ''),
    method = req.method;
  try {
    if (method === 'GET' && path.startsWith('content/image/'))
      return getArticleImage(path.split('/')[2]);
    if (path === 'maintenance/tick' && method === 'POST') {
      const s = await settings(),
        token = req.headers.get('authorization')?.replace(/^Bearer /, '');
      assert(
        s.worker_token && token && equal(token, s.worker_token),
        '维护令牌无效',
        401,
      );
      const deleted = await purgeExpired();
      let backup = null;
      if (s.backup_enabled) {
        const [hour, minute] = String(s.backup_time || '03:00')
            .split(':')
            .map(Number),
          count = Math.max(1, Math.min(24, Number(s.backup_daily_count || 1))),
          localNow = now() + 8 * 3600,
          day = Math.floor(localNow / DAY),
          start = day * DAY + hour * 3600 + minute * 60,
          elapsed = localNow - start,
          interval = Math.floor(DAY / count),
          index = Math.floor(elapsed / interval),
          slot = `${day}:${index}`;
        if (elapsed >= 0 && index < count && slot !== s.backup_last_slot) {
          backup = await remoteBackup();
          await stmt(
            "INSERT INTO settings(key,value) VALUES('backup_last_slot',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            JSON.stringify(slot),
          ).run();
        }
      }
      return json({ deleted, backup });
    }
    if (path === 'payment/notify') {
      assert(['GET', 'POST'].includes(method), '请求方法无效', 405);
      const q =
        method === 'GET'
          ? new URL(req.url).searchParams
          : new URLSearchParams(await req.text());
      await verifyNotification(apiParams(q));
      return new Response('success', {
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    if (path === 'node/sync' && method === 'POST') {
      const token =
        req.headers.get('x-msboost-node-token') ||
        req.headers.get('authorization')?.replace(/^Bearer /, '');
      assert(token && token.length === 64, '线路凭据无效', 401);
      const line = await one(
        'SELECT * FROM lines WHERE token_hash=?',
        await hash(token),
      );
      assert(line, '线路凭据无效', 401);
      const b = await jsonBody(req),
        t = now();
      const num = (v: any, min: number, max: number) =>
        typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
          ? v
          : null;
      const rtt = num(b.rtt_ms, 0, 60000),
        loss = num(b.loss_pct, 0, 100);
      await stmt(
        'UPDATE lines SET heartbeat_at=?,rtt_ms=?,loss_pct=?,cpu_pct=?,memory_pct=?,version=? WHERE id=?',
        t,
        rtt,
        loss,
        num(b.cpu_pct, 0, 100),
        num(b.memory_pct, 0, 100),
        String(b.version || '').slice(0, 50),
        line.id,
      ).run();
      await stmt(
        'INSERT INTO line_samples(id,line_id,at,rtt_ms,loss_pct) VALUES(?,?,?,?,?)',
        id(),
        line.id,
        t,
        rtt,
        loss,
      ).run();
      if (Array.isArray(b.relays))
        for (const r of b.relays.slice(0, 1000))
          if (
            typeof r.id === 'string' &&
            ['active', 'stopped', 'error'].includes(r.state) &&
            Number.isInteger(r.revision)
          )
            await stmt(
              'UPDATE relays SET current_bps=CASE WHEN reported_at IS NOT NULL AND ?>reported_at AND ?>=traffic_used_bytes THEN (?-traffic_used_bytes)*1.0/(?-reported_at) ELSE NULL END,reported_state=?,reported_revision=?,reported_at=?,last_error=?,traffic_used_bytes=MAX(traffic_used_bytes,?) WHERE id=? AND line_id=?',
              t,
              num(r.traffic_bytes, 0, Number.MAX_SAFE_INTEGER) || 0,
              num(r.traffic_bytes, 0, Number.MAX_SAFE_INTEGER) || 0,
              t,
              r.state,
              r.revision,
              t,
              String(r.error || '').slice(0, 200),
              num(r.traffic_bytes, 0, Number.MAX_SAFE_INTEGER) || 0,
              r.id,
              line.id,
            ).run();
      const desired = line.enabled
        ? await rows(
            'SELECT r.id,r.target_ip,r.target_port,r.protocol,r.listen_port,r.expires_at,r.speed_mbps,r.revision,CASE WHEN l.requires_front=1 THEN (SELECT host FROM fronts f WHERE f.relay_id=r.id) ELSE NULL END AS source_ip FROM relays r JOIN lines l ON l.id=r.line_id WHERE r.line_id=? AND r.suspended=0 AND r.expires_at>? AND (r.traffic_limit_bytes=0 OR r.traffic_used_bytes<r.traffic_limit_bytes) AND r.user_id IN (SELECT id FROM users WHERE disabled=0) AND (l.requires_front=0 OR EXISTS(SELECT 1 FROM fronts f WHERE f.relay_id=r.id))',
            line.id,
            t,
          )
        : [];
      await stmt(
        'DELETE FROM line_samples WHERE line_id=? AND at<?',
        line.id,
        t - 7 * DAY,
      ).run();
      await purgeExpired(line.id);
      return json({ server_time: t, lease_until: t + 180, relays: desired });
    }
    if (method === 'GET' && path === 'bootstrap') {
      await ensureContentRevision();
      const visitor = await currentUser(req);
      if (!visitor) {
        const s = await settings();
        const policies = await rows(
          "SELECT id,kind,title,body FROM articles WHERE published=1 AND id IN ('terms','privacy')",
        );
        return json({
          user: null,
          settings: {
            invite_required: s.invite_required,
            register_email_verification: s.register_email_verification,
            turnstile_enabled: s.turnstile_enabled,
            turnstile_site_key: s.turnstile_site_key,
            ...authReadiness(s),
            setup_available: await setupAvailable(),
          },
          articles: initialArticles
            .filter((a) => ['terms', 'privacy'].includes(a.id))
            .map((a) => policies.find((p) => p.id === a.id) || a),
        });
      }
      const [s, u, lines, plans, articles] = await Promise.all([
        settings(),
        currentUser(req),
        rows(
          'SELECT id,name,region,description,host,enabled,requires_front,heartbeat_at,probe_label,rtt_ms,loss_pct FROM lines WHERE enabled=1 ORDER BY created_at',
        ),
        rows('SELECT * FROM plans WHERE enabled=1 ORDER BY sort'),
        rows(
          'SELECT id,kind,title,body,updated_at FROM articles WHERE published=1 ORDER BY updated_at DESC',
        ),
      ]);
      const mine = u
        ? await rows(
            'SELECT r.*,l.name AS line_name,l.host AS relay_host,l.heartbeat_at,l.requires_front,EXISTS(SELECT 1 FROM config_files c WHERE c.relay_id=r.id) AS config_saved,(SELECT host FROM fronts f WHERE f.relay_id=r.id) AS front_host,(SELECT port FROM fronts f WHERE f.relay_id=r.id) AS front_port FROM relays r JOIN lines l ON l.id=r.line_id WHERE r.user_id=? ORDER BY r.expires_at DESC,r.created_at DESC LIMIT 1',
            u.id,
          )
        : [];
      return json({
        user: u,
        settings: {
          invite_required: s.invite_required,
          register_email_verification: s.register_email_verification,
          turnstile_enabled: s.turnstile_enabled,
          turnstile_site_key: s.turnstile_site_key,
          epay_alipay: s.epay_alipay,
          epay_wxpay: s.epay_wxpay,
          terms_confirmed: s.terms_confirmed,
          support_email: s.support_email,
          worker_ready: Boolean(s.worker_url && s.worker_token),
          ...authReadiness(s),
        },
        lines,
        plans,
        articles: articles.length ? articles : initialArticles,
        relays: mine,
        orders: u
          ? await rows(
              'SELECT o.*,l.name AS line_name FROM orders o JOIN relays r ON r.id=o.relay_id JOIN lines l ON l.id=r.line_id WHERE o.user_id=? ORDER BY o.created_at DESC LIMIT 100',
              u.id,
            )
          : [],
      });
    }
    if (method === 'GET' && path === 'status') {
      await requireUser(req);
      return json({
        lines: await rows(
          'SELECT id,name,region,enabled,heartbeat_at,probe_label,rtt_ms,loss_pct FROM lines',
        ),
        samples: await rows(
          'SELECT line_id,at,rtt_ms,loss_pct FROM line_samples WHERE at>? ORDER BY at DESC LIMIT 1000',
          now() - 3600,
        ),
      });
    }
    if (method === 'POST') sameOrigin(req);
    const b =
      method === 'POST'
        ? await jsonBody(
            req,
            path === 'admin/backup/restore'
              ? 8 * 1024 * 1024
              : path === 'admin/article-image'
                ? 5 * 1024 * 1024
                : 262144,
          )
        : {};
    if (method === 'POST' && path === 'auth/code')
      return json(await sendCode(req, b));
    if (method === 'POST' && path === 'auth/setup') {
      const result = await setupAdmin(req, b);
      return json({ ok: true }, 200, { 'Set-Cookie': result.cookie });
    }
    if (method === 'POST' && ['auth/login', 'auth/register'].includes(path)) {
      const result = await (path === 'auth/login'
        ? login(req, b)
        : register(req, b));
      return json({ ok: true }, 200, { 'Set-Cookie': result.cookie });
    }
    if (method === 'POST' && path === 'auth/reset')
      return json(await resetPassword(req, b));
    if (method === 'POST' && path === 'auth/logout') {
      const raw = req.headers
        .get('cookie')
        ?.match(/(?:^|;\s*)msboost_session=([a-f0-9]{64})/)?.[1];
      if (raw)
        await stmt('DELETE FROM sessions WHERE token=?', await hash(raw)).run();
      return json({ ok: true }, 200, {
        'Set-Cookie':
          'msboost_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
      });
    }
    if (path.startsWith('admin')) {
      const u = await requireUser(req, 'admin');
      if (method === 'GET' && path === 'admin/backup')
        return json(await createBackup(req, u));
      if (method === 'POST' && path === 'admin/backup/restore')
        return json(await restoreBackup(req, u, b), 200, {
          'Set-Cookie':
            'msboost_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
        });
      if (method === 'GET' && path === 'admin')
        return json(await adminSnapshot());
      if (method === 'POST' && path === 'admin/article-image')
        return json(await saveArticleImage(b.data_url));
      if (method === 'POST')
        return json(await adminAction(req, u, path.slice(6), b));
    }
    const u = await requireUser(req);
    if (method === 'POST' && path === 'relays/config') {
      await throttle('config:' + u.id, 10, 60);
      return json(
        await saveConfig(
          u,
          text(b.relay_id, 40, '转发 ID'),
          text(b.source, 131072, '配置'),
        ),
      );
    }
    if (method === 'POST' && path === 'relays/bind') {
      await throttle('config:' + u.id, 10, 60);
      return json(
        await bindConfig(
          u,
          text(b.relay_id, 40, '转发 ID'),
          text(b.line_id, 40, '线路'),
          text(b.source, 131072, '配置'),
          text(b.target_key, 40, '节点'),
        ),
      );
    }
    if (method === 'GET' && path.startsWith('relays/config/')) {
      return getConfig(
        u,
        path.split('/')[2],
        new URL(req.url).searchParams.get('front') === '1',
      );
    }
    if (
      method === 'POST' &&
      !(['vps/probe', 'vps/jobs'].includes(path) && u.role === 'admin')
    )
      await throttle('write:' + u.id, 100, 60);
    if (method === 'POST' && path === 'orders')
      return json(await createOrder(req, u, b));
    if (method === 'POST' && path === 'orders/pay')
      return json(await paymentForm(u, text(b.id, 50, '订单号')));
    if (method === 'POST' && path === 'orders/check')
      return json(await checkPayment(u, text(b.id, 50, '订单号')));
    if (method === 'POST' && path === 'orders/cancel') {
      await stmt(
        "UPDATE orders SET status='closed' WHERE id=? AND user_id=? AND status='pending'",
        b.id,
        u.id,
      ).run();
      return json({ ok: true });
    }
    if (method === 'GET' && path === 'tickets') {
      const staff = ['admin', 'support'].includes(u.role);
      return json({
        tickets: await rows(
          'SELECT t.*,u.email FROM tickets t JOIN users u ON u.id=t.user_id ' +
            (staff ? '' : 'WHERE t.user_id=? ') +
            'ORDER BY t.updated_at DESC LIMIT 100',
          ...(staff ? [] : [u.id]),
        ),
      });
    }
    if (method === 'POST' && path === 'tickets') {
      await throttle('tickets:' + u.id, 5, 3600);
      const tid = id();
      await db().batch([
        stmt(
          'INSERT INTO tickets(id,user_id,subject,category,order_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
          tid,
          u.id,
          text(b.subject, 120, '主题'),
          text(b.category, 30, '分类'),
          String(b.order_id || '').slice(0, 50),
          now(),
          now(),
        ),
        stmt(
          'INSERT INTO ticket_messages(id,ticket_id,user_id,body,created_at) VALUES(?,?,?,?,?)',
          id(),
          tid,
          u.id,
          text(b.body, 5000, '内容'),
          now(),
        ),
      ]);
      return json({ id: tid });
    }
    if (path.startsWith('tickets/')) {
      const tid = path.split('/')[1],
        ticket = await one('SELECT * FROM tickets WHERE id=?', tid);
      assert(
        ticket &&
          (ticket.user_id === u.id || ['admin', 'support'].includes(u.role)),
        '工单不存在',
        404,
      );
      if (method === 'GET')
        return json({
          ticket,
          messages: await rows(
            'SELECT m.id,m.body,m.created_at,u.role,u.email FROM ticket_messages m JOIN users u ON u.id=m.user_id WHERE m.ticket_id=? ORDER BY m.created_at',
            tid,
          ),
        });
      if (method === 'POST') {
        if (b.close) {
          await stmt(
            "UPDATE tickets SET status='closed',updated_at=? WHERE id=?",
            now(),
            tid,
          ).run();
        } else {
          await db().batch([
            stmt(
              'INSERT INTO ticket_messages(id,ticket_id,user_id,body,created_at) VALUES(?,?,?,?,?)',
              id(),
              tid,
              u.id,
              text(b.body, 5000, '回复'),
              now(),
            ),
            stmt(
              'UPDATE tickets SET status=?,updated_at=? WHERE id=?',
              u.role === 'customer' ? 'open' : 'answered',
              now(),
              tid,
            ),
          ]);
        }
        return json({ ok: true });
      }
    }
    if (method === 'GET' && path === 'vps/probe')
      return json(await probeQuota(u));
    if (method === 'POST' && path === 'vps/probe') {
      await probeQuota(u, true);
      assert(publicIp(b.ip), '请输入公网 IP');
      int(b.ssh_port, 1, 65535, 'SSH 端口');
      return json(
        await workerFetch(await settings(), '/probe', {
          ip: b.ip,
          ssh_port: b.ssh_port,
        }),
      );
    }
    if (method === 'GET' && path === 'vps/deploy-quota')
      return json(await probeQuota(u, false, 'deploy'));
    if (method === 'POST' && path === 'vps/jobs') {
      await probeQuota(u, true, 'deploy');
      assert(publicIp(b.ip), '请输入公网 IP');
      assert(['install', 'dd', 'front'].includes(b.kind), '任务类型无效');
      assert(b.confirm === b.ip, '请再次输入目标 IP 确认');
      assert(
        typeof b.password === 'string' &&
          b.password.length >= 1 &&
          b.password.length <= 256,
        'SSH 密码无效',
      );
      assert(
        typeof b.username === 'string' &&
          /^[a-z_][a-z0-9_-]{0,31}\$?$/i.test(b.username),
        'SSH 用户名无效',
      );
      int(b.ssh_port, 1, 65535, 'SSH 端口');
      if (b.kind === 'dd') {
        int(b.new_ssh_port, 20000, 59999, '新 SSH 端口');
      }
      assert(
        typeof b.fingerprint === 'string' &&
          /^SHA256:[A-Za-z0-9+/]+={0,2}$/.test(b.fingerprint),
        '请先确认 SSH 主机指纹',
      );
      const jid = id(),
        s = await settings();
      const relay =
        b.kind === 'front'
          ? await one(
              'SELECT r.*,l.host AS relay_host FROM relays r JOIN lines l ON l.id=r.line_id WHERE r.id=? AND r.user_id=? AND r.expires_at>? AND r.suspended=0',
              b.relay_id,
              u.id,
              now(),
            )
          : null;
      if (b.kind === 'front') {
        assert(relay, '请先开通有效转发');
        int(b.front_port, 1024, 65535, '前置监听端口');
        assert(b.ip !== relay.target_ip, '前置机应与落地 VPS 不同');
      }
      await stmt(
        'INSERT INTO provision_jobs(id,user_id,kind,ip,state,created_at,updated_at,relay_id) VALUES(?,?,?,?,?,?,?,?)',
        jid,
        u.id,
        b.kind,
        b.ip,
        'submitting',
        now(),
        now(),
        relay?.id || null,
      ).run();
      try {
        await workerFetch(s, '/jobs', {
          job_id: jid,
          owner_id: u.id,
          kind: b.kind,
          ip: b.ip,
          ssh_port: b.ssh_port,
          username: b.username,
          password: b.password,
          fingerprint: b.fingerprint,
          new_ssh_port: b.new_ssh_port,
          front_port: b.front_port,
          relay_host: relay?.relay_host,
          relay_port: relay?.listen_port,
          protocol: relay?.protocol,
          profile_name: u.email.split('@')[0],
        });
        await stmt(
          "UPDATE provision_jobs SET state='running',updated_at=? WHERE id=?",
          now(),
          jid,
        ).run();
      } catch (e) {
        await stmt(
          "UPDATE provision_jobs SET state='submission_unknown',updated_at=? WHERE id=?",
          now(),
          jid,
        ).run();
        throw e;
      }
      await audit(req, u.id, 'vps.' + b.kind, jid);
      return json({ id: jid });
    }
    if (method === 'GET' && path.startsWith('vps/jobs/')) {
      const jid = path.split('/')[2],
        job = await one(
          'SELECT * FROM provision_jobs WHERE id=? AND user_id=?',
          jid,
          u.id,
        );
      assert(job, '任务不存在', 404);
      const result = await workerFetch(
        await settings(),
        '/jobs/' + jid + '?owner_id=' + u.id,
      );
      if (typeof result.state === 'string')
        await stmt(
          'UPDATE provision_jobs SET state=?,updated_at=? WHERE id=?',
          result.state,
          now(),
          jid,
        ).run();
      if (
        job.kind === 'front' &&
        job.relay_id &&
        result.state === 'completed' &&
        result.front_port
      ) {
        const oldFront = await one(
          'SELECT job_id FROM fronts WHERE relay_id=?',
          job.relay_id,
        );
        if (oldFront?.job_id !== job.id)
          await db().batch([
            stmt(
              'INSERT INTO fronts(relay_id,host,port,job_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT(relay_id) DO UPDATE SET host=excluded.host,port=excluded.port,job_id=excluded.job_id,created_at=excluded.created_at',
              job.relay_id,
              job.ip,
              result.front_port,
              job.id,
              now(),
            ),
            stmt(
              'UPDATE relays SET revision=revision+1 WHERE id=?',
              job.relay_id,
            ),
          ]);
      }
      return json(result);
    }
    if (method === 'GET' && path === 'vps/jobs')
      return json({
        jobs: await rows(
          'SELECT id,kind,ip,state,created_at FROM provision_jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 30',
          u.id,
        ),
      });
    assert(false, '接口不存在', 404);
  } catch (e: any) {
    const status = Number(e.status) || 500;
    if (status === 500)
      console.error(
        'msboost.api.unexpected',
        JSON.stringify({
          stage: path === 'vps/probe' ? 'vps/probe' : 'api',
          name: e?.name,
          stack: String(e?.stack || '')
            .split('\n')
            .slice(1, 6)
            .join('\n'),
        }),
      );
    return json(
      {
        error:
          status === 500
            ? '服务暂时不可用，请稍后重试；若为新部署，请检查数据库迁移与服务配置。'
            : e.message,
      },
      status,
    );
  }
}
export const GET = handle;
export const POST = handle;
