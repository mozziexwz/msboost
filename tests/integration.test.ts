import test from 'node:test';
import assert from 'node:assert/strict';
import { env, sqlite, objects } from './bindings.ts';
import { id, now, DAY } from '../lib/core.ts';
import { createOrder, settleOrder } from '../lib/commerce.ts';
import { saveConfig, getConfig, purgeExpired } from '../lib/configs.ts';
import { encrypt, stmt, one, hash, turnstile, hmac } from '../lib/server.ts';
import { createBackup, restoreBackup } from '../lib/backup.ts';
import {
  setupAdmin,
  setupAvailable,
  login,
  sendCode,
  register,
  resetPassword,
} from '../lib/auth.ts';
import { adminAction, adminSnapshot } from '../lib/admin.ts';
import { GET, POST } from '../app/api/[...path]/route.ts';
const req = new Request('https://msboost.de/api/orders', {
  method: 'POST',
  headers: { Origin: 'https://msboost.de', 'CF-Connecting-IP': '8.8.4.4' },
});
const user: any = {
  id: 'u1',
  email: 'one@qq.com',
  role: 'customer',
  trial_used: 0,
  disabled: 0,
};
const line = id();
function fixture() {
  sqlite.exec(
    'DELETE FROM fronts;DELETE FROM config_files;DELETE FROM grants;DELETE FROM orders;DELETE FROM relays;DELETE FROM line_samples;DELETE FROM provision_jobs;DELETE FROM sessions;DELETE FROM users;DELETE FROM lines;DELETE FROM plans;DELETE FROM settings;DELETE FROM audit_logs;',
  );
  objects.clear();
  sqlite
    .prepare('INSERT INTO users(id,email,password,created_at) VALUES(?,?,?,?)')
    .run(user.id, user.email, 'test-hash', now());
  sqlite
    .prepare(
      'INSERT INTO lines(id,name,region,host,port_start,port_end,enabled,token_hash,heartbeat_at,created_at) VALUES(?,?,?,?,?,?,1,?,?,?)',
    )
    .run(
      line,
      '线路1',
      '测试',
      'relay.msboost.de',
      31000,
      31100,
      'test-token',
      now(),
      now(),
    );
  sqlite
    .prepare(
      'INSERT INTO plans(id,name,days,price_cents,speed_mbps,trial,enabled) VALUES(?,?,1,0,50,1,1)',
    )
    .run('trial', '体验');
  sqlite
    .prepare(
      'INSERT INTO plans(id,name,days,price_cents,speed_mbps,trial,enabled) VALUES(?,?,30,1000,50,0,1)',
    )
    .run('month', '月卡');
  sqlite
    .prepare('INSERT INTO settings(key,value) VALUES(?,?)')
    .run('terms_confirmed', 'true');
}
const input = {
  line_id: line,
  plan_id: 'trial',
  target_host: '8.8.8.8',
  target_port: 45001,
  protocol: 'TCP',
  channel: 'alipay',
};
const source = JSON.stringify({
  profiles: [
    {
      profileName: 'mine',
      user: { name: 'customer', password: 'node-secret-test' },
      servers: [
        {
          ipAddress: '8.8.8.8',
          portBindings: [{ port: 45001, protocol: 'TCP' }],
        },
      ],
    },
  ],
  activeProfile: 'mine',
  socks5Port: 1080,
});
test('payment, expiry, storage and access integration', async (t) => {
  await t.test(
    'registration verification switch stays independent from invitations, QQ restriction and owner setup',
    async () => {
      fixture();
      await adminAction(req, { ...user, role: 'admin' }, 'settings', {
        register_email_verification: false,
      });
      const account = {
        email: 'newcustomer@qq.com',
        password: 'customer-password-test',
        agreed: true,
      };
      await assert.rejects(() => register(req, account), /邀请码/);
      await adminAction(req, { ...user, role: 'admin' }, 'settings', {
        invite_required: false,
      });
      await assert.rejects(
        () => register(req, { ...account, email: env.OWNER_EMAIL }),
        /仅支持 @qq.com 邮箱/,
      );
      await assert.rejects(() =>
        register(req, { ...account, email: 'other@gmail.com' }),
      );
      assert.ok((await register(req, account)).cookie);
      assert.equal(
        (await one('SELECT role FROM users WHERE email=?', account.email)).role,
        'customer',
      );
      await assert.rejects(
        () =>
          resetPassword(req, { ...account, password: 'replacement-password' }),
        /验证码/,
      );
      const bootstrap = (await (
        await GET(new Request('https://msboost.de/api/bootstrap'))
      ).json()) as any;
      assert.equal(bootstrap.settings.mail_ready, false);
      assert.equal(bootstrap.settings.auth_ready, true);
    },
  );
  await t.test(
    'enabled registration verification rejects missing codes and accepts a valid one exactly once',
    async () => {
      fixture();
      await adminAction(req, { ...user, role: 'admin' }, 'settings', {
        invite_required: false,
        register_email_verification: true,
      });
      const account = {
        email: 'verifiedcustomer@qq.com',
        password: 'customer-password-test',
        agreed: true,
      };
      await assert.rejects(() => register(req, account), /验证码/);
      const digest = await hmac('code:' + account.email + ':register:123456');
      await stmt(
        'INSERT INTO email_codes(email,digest,purpose,expires_at,sent_at) VALUES(?,?,?,?,?)',
        account.email,
        digest,
        'register',
        now() + 600,
        now(),
      ).run();
      assert.ok((await register(req, { ...account, code: '123456' })).cookie);
      assert.equal(
        (
          await one(
            'SELECT consumed FROM email_codes WHERE email=?',
            account.email,
          )
        ).consumed,
        1,
      );
    },
  );
  await t.test(
    'owner setup works before SMTP and is single use; existing owner login remains available',
    async () => {
      fixture();
      env.ADMIN_SETUP_TOKEN = 'setup-test-'.repeat(5);
      const credentials = {
        email: env.OWNER_EMAIL,
        password: 'setup-password-test',
        setup_token: env.ADMIN_SETUP_TOKEN,
      };
      try {
        await assert.rejects(() =>
          setupAdmin(req, { ...credentials, setup_token: 'invalid' }),
        );
        await assert.rejects(() =>
          setupAdmin(req, { ...credentials, email: 'other@qq.com' }),
        );
        const initialized = await setupAdmin(req, credentials);
        assert.ok(initialized.cookie.includes('HttpOnly'));
        assert.equal(await setupAvailable(), false);
        await assert.rejects(() => setupAdmin(req, credentials));
        assert.ok((await login(req, credentials)).cookie);
        await assert.rejects(() =>
          login(req, { ...credentials, email: 'customer@gmail.com' }),
        );
        await assert.rejects(
          () => sendCode(req, { email: env.OWNER_EMAIL, purpose: 'register' }),
          /邮件发送尚未启用/,
        );
      } finally {
        delete env.ADMIN_SETUP_TOKEN;
      }
    },
  );
  await t.test(
    'SMTP settings encrypt the authorization code and redact it from the administrator response',
    async () => {
      fixture();
      const admin = { ...user, role: 'admin' };
      await adminAction(req, admin, 'settings', {
        smtp_host: 'smtp.qq.com',
        smtp_port: 465,
        smtp_user: 'owner@qq.com',
        smtp_from: 'owner@qq.com',
        smtp_password: 'test-smtp-authorization',
        mail_enabled: false,
      });
      assert.ok(
        !(
          await one("SELECT value FROM settings WHERE key='smtp_password'")
        ).value.includes('test-smtp-authorization'),
      );
      const state = await adminSnapshot();
      assert.equal(state.settings.smtp_password_configured, true);
      assert.equal(state.settings.smtp_password, undefined);
      await assert.rejects(
        () => adminAction(req, admin, 'settings', { mail_enabled: true }),
        /启用邮件前/,
      );
    },
  );
  await t.test(
    'Turnstile can be disabled without an external verification call',
    async () => {
      await turnstile(req, '', 'login', { turnstile_enabled: false });
    },
  );
  await t.test(
    'backup restores settings, users, forwarding and finance',
    async () => {
      fixture();
      await stmt("UPDATE users SET role='admin' WHERE id=?", user.id).run();
      const admin = { ...user, role: 'admin' };
      await createOrder(req, admin, input);
      const backup = await createBackup(req, admin);
      await stmt("UPDATE plans SET name='changed' WHERE id='trial'").run();
      await restoreBackup(req, admin, backup);
      assert.equal(
        (await one("SELECT name FROM plans WHERE id='trial'"))!.name,
        '体验',
      );
      assert.equal((await one('SELECT COUNT(*) n FROM orders'))!.n, 1);
      assert.equal(
        (await one('SELECT role FROM users WHERE id=?', user.id))!.role,
        'admin',
      );
    },
  );
  await t.test(
    'failed object deletion remains queued and retries without restoring downloads',
    async () => {
      fixture();
      await createOrder(req, user, input);
      const r = await one('SELECT id FROM relays');
      await saveConfig(user, r.id, source);
      await stmt(
        'UPDATE relays SET expires_at=? WHERE id=?',
        now(),
        r.id,
      ).run();
      const remove = env.CONFIGS.delete;
      env.CONFIGS.delete = async () => {
        throw new Error('temporary storage outage');
      };
      try {
        assert.equal(await purgeExpired(), 0);
        assert.equal(await one('SELECT * FROM config_files'), null);
        assert.ok(await one('SELECT * FROM config_garbage'));
      } finally {
        env.CONFIGS.delete = remove;
      }
      assert.equal(await purgeExpired(), 1);
      assert.equal(objects.size, 0);
    },
  );
  await t.test(
    'replacement uploads retain one active configuration and collect all superseded files',
    async () => {
      fixture();
      await createOrder(req, user, input);
      const r = await one('SELECT id FROM relays');
      await Promise.allSettled([
        saveConfig(user, r.id, source),
        saveConfig(user, r.id, source),
      ]);
      await purgeExpired();
      assert.equal(objects.size, 1);
      assert.equal(
        ((await (await getConfig(user, r.id)).json()) as any).profiles[0].user
          .password,
        'node-secret-test',
      );
    },
  );
  await t.test(
    'double trial requests only create one entitlement',
    async () => {
      fixture();
      const r = await Promise.allSettled([
        createOrder(req, user, input),
        createOrder(req, user, input),
      ]);
      assert.equal(r.filter((v) => v.status === 'fulfilled').length, 1);
      assert.equal(
        (await one('SELECT trial_used FROM users WHERE id=?', user.id))
          .trial_used,
        1,
      );
      assert.equal((await one('SELECT COUNT(*) AS n FROM grants')).n, 1);
    },
  );
  await t.test(
    'duplicate paid notifications do not extend time twice',
    async () => {
      fixture();
      const r = await createOrder(req, user, input);
      const o = await one('SELECT * FROM orders WHERE id=?', r.order_id);
      const before = (
        await one('SELECT expires_at FROM relays WHERE id=?', o.relay_id)
      ).expires_at;
      await Promise.all(
        Array.from({ length: 10 }, () => settleOrder(r.order_id, null, 'free')),
      );
      assert.equal(
        (await one('SELECT expires_at FROM relays WHERE id=?', o.relay_id))
          .expires_at,
        before,
      );
    },
  );
  await t.test(
    'payment mutation batch rolls back when trade number conflicts',
    async () => {
      fixture();
      await createOrder(req, user, input);
      const relay = await one('SELECT id FROM relays');
      await stmt(
        "INSERT INTO orders(id,user_id,relay_id,plan_id,name,days,price_cents,speed_mbps,trial,channel,provider_id,status,trade_no,created_at) VALUES('already',?,?, 'month','paid',30,1000,50,0,'alipay','provider','paid','duplicate',?)",
        user.id,
        relay.id,
        now(),
      ).run();
      await stmt(
        "INSERT INTO orders(id,user_id,relay_id,plan_id,name,days,price_cents,speed_mbps,trial,channel,provider_id,created_at) VALUES('second',?,?,'month','pending',30,1000,50,0,'alipay','provider',?)",
        user.id,
        relay.id,
        now(),
      ).run();
      await assert.rejects(() =>
        settleOrder('second', 'duplicate', 'provider'),
      );
      assert.equal(
        await one("SELECT order_id FROM grants WHERE order_id='second'"),
        null,
      );
      assert.equal(
        (await one("SELECT status FROM orders WHERE id='second'")).status,
        'pending',
      );
    },
  );
  await t.test(
    'only transformed config is encrypted, ownership and exact expiry are enforced',
    async () => {
      fixture();
      await createOrder(req, user, input);
      const r = await one('SELECT id FROM relays');
      await saveConfig(user, r.id, source);
      const encrypted = [...objects.values()][0];
      assert.ok(
        !encrypted.includes('node-secret-test') &&
          !encrypted.includes('8.8.8.8'),
      );
      const d = (await (await getConfig(user, r.id)).json()) as any;
      assert.equal(d.profiles[0].servers[0].domainName, 'relay.msboost.de');
      assert.equal(d.profiles[0].user.password, 'node-secret-test');
      await assert.rejects(() => getConfig({ ...user, id: 'intruder' }, r.id));
      await stmt(
        'UPDATE relays SET expires_at=? WHERE id=?',
        now(),
        r.id,
      ).run();
      await assert.rejects(() => getConfig(user, r.id));
      assert.equal(await purgeExpired(), 1);
      assert.equal(objects.size, 0);
      assert.equal(await one('SELECT * FROM config_files'), null);
    },
  );
  await t.test(
    'self-owned front entry keeps upstream center and replaces only downloaded endpoint',
    async () => {
      fixture();
      await createOrder(req, user, input);
      const r = await one('SELECT id FROM relays');
      await saveConfig(user, r.id, source);
      await stmt(
        'INSERT INTO fronts(relay_id,host,port,job_id,created_at) VALUES(?,?,?,?,?)',
        r.id,
        '9.9.9.9',
        35000,
        'job',
        now(),
      ).run();
      const d = (await (await getConfig(user, r.id, true)).json()) as any;
      assert.equal(d.profiles[0].servers[0].ipAddress, '9.9.9.9');
      assert.equal(d.profiles[0].servers[0].portBindings[0].port, 35000);
      const center = (await (await getConfig(user, r.id)).json()) as any;
      assert.equal(
        center.profiles[0].servers[0].domainName,
        'relay.msboost.de',
      );
    },
  );
  await t.test(
    'required-front line blocks direct use and pins center admission to the front IP',
    async () => {
      fixture();
      const token = 'a'.repeat(64);
      await stmt(
        'UPDATE lines SET requires_front=1,token_hash=? WHERE id=?',
        await hash(token),
        line,
      ).run();
      await createOrder(req, user, input);
      const r = await one('SELECT id FROM relays');
      await saveConfig(user, r.id, source);
      await assert.rejects(() => getConfig(user, r.id));
      const sync = () =>
        POST(
          new Request('https://msboost.de/api/node/sync', {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + token,
              'Content-Type': 'application/json',
            },
            body: '{}',
          }),
        );
      assert.equal(((await (await sync()).json()) as any).relays.length, 0);
      await stmt(
        'INSERT INTO fronts(relay_id,host,port,job_id,created_at) VALUES(?,?,?,?,?)',
        r.id,
        '9.9.9.9',
        35000,
        'job',
        now(),
      ).run();
      const desired = ((await (await sync()).json()) as any).relays[0];
      assert.equal(desired.source_ip, '9.9.9.9');
      const config = (await (await getConfig(user, r.id, true)).json()) as any;
      assert.equal(config.profiles[0].servers[0].ipAddress, '9.9.9.9');
    },
  );
  await t.test(
    'expired config with a renewed lease is not deleted',
    async () => {
      fixture();
      await createOrder(req, user, input);
      const r = await one('SELECT id FROM relays');
      await saveConfig(user, r.id, source);
      await stmt(
        'UPDATE relays SET expires_at=? WHERE id=?',
        now() + DAY,
        r.id,
      ).run();
      assert.equal(await purgeExpired(), 0);
      assert.equal(objects.size, 1);
    },
  );
  await t.test(
    'anonymous bootstrap reveals no lines, prices or user resources and protected routes return 401',
    async () => {
      fixture();
      const b = (await (
        await GET(new Request('https://msboost.de/api/bootstrap'))
      ).json()) as any;
      assert.equal(b.user, null);
      assert.ok(!('lines' in b) && !('plans' in b) && !('relays' in b));
      for (const path of [
        'status',
        'admin',
        'tickets',
        'vps/jobs',
        'relays/config/test',
      ])
        assert.equal(
          (await GET(new Request('https://msboost.de/api/' + path))).status,
          401,
          path,
        );
    },
  );
  await t.test(
    'cross-origin mutation and unauthenticated node/maintenance access fail',
    async () => {
      fixture();
      const request = (path: string) =>
        new Request('https://msboost.de/api/' + path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://evil.test',
          },
          body: '{}',
        });
      assert.equal((await POST(request('orders'))).status, 403);
      assert.equal((await POST(request('node/sync'))).status, 401);
      assert.equal((await POST(request('maintenance/tick'))).status, 401);
    },
  );
});
