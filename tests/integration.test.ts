import test from 'node:test';
import assert from 'node:assert/strict';
import { env, sqlite, objects } from './bindings.ts';
import { id, now, DAY } from '../lib/core.ts';
import { createOrder, settleOrder } from '../lib/commerce.ts';
import { saveConfig, getConfig, purgeExpired } from '../lib/configs.ts';
import { encrypt, stmt, one } from '../lib/server.ts';
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
