import test from 'node:test';
import assert from 'node:assert/strict';
import { sqlite } from './bindings.ts';
import { GET, POST } from '../app/api/[...path]/route.ts';
import { hash } from '../lib/server.ts';
import { now, id, DAY } from '../lib/core.ts';

test('admin save, ticket ownership, and configuration validation workflows', async () => {
  const adminId = id(),
    customerId = id(),
    otherId = id();
  const adminToken = '1'.repeat(64),
    customerToken = '2'.repeat(64),
    otherToken = '3'.repeat(64);
  for (const [uid, role, token] of [
    [adminId, 'admin', adminToken],
    [customerId, 'customer', customerToken],
    [otherId, 'customer', otherToken],
  ]) {
    sqlite
      .prepare(
        'INSERT INTO users(id,email,password,role,created_at) VALUES(?,?,?,?,?)',
      )
      .run(uid, uid + '@qq.com', 'fixture', role, now());
    sqlite
      .prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)')
      .run(await hash(token), uid, now() + DAY);
  }
  async function api(path: string, token: string, body?: unknown) {
    const request = new Request('https://msboost.de/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: 'https://msboost.de',
        'Content-Type': 'application/json',
        Cookie: 'msboost_session=' + token,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const response = await (body === undefined ? GET(request) : POST(request));
    return { status: response.status, data: (await response.json()) as any };
  }
  assert.equal((await api('admin', customerToken)).status, 403);
  assert.equal((await api('admin/initialize', adminToken, {})).status, 200);
  const line = {
    name: '线路保存测试',
    region: '测试',
    host: '8.8.8.8',
    port_start: 31000,
    port_end: 31100,
    enabled: false,
    requires_front: true,
    probe_label: '新增时的探测说明',
    description: '测试线路',
  };
  const created = await api('admin/line', adminToken, line);
  assert.equal(created.status, 200);
  const snapshot = (await api('admin', adminToken)).data;
  assert.equal(snapshot.lines[0].probe_label, line.probe_label);
  assert.equal(snapshot.lines[0].requires_front, 1);
  const lid = snapshot.lines[0].id;
  const oldHash = sqlite
    .prepare('SELECT token_hash FROM lines WHERE id=?')
    .get(lid)!.token_hash;
  assert.equal(
    (
      await api('admin/line', adminToken, {
        ...line,
        id: lid,
        name: '线路编辑成功',
        probe_label: '更新后说明',
      })
    ).status,
    200,
  );
  const savedLine = (await api('admin', adminToken)).data.lines[0];
  assert.equal(savedLine.name, '线路编辑成功');
  assert.equal(savedLine.probe_label, '更新后说明');
  assert.equal(
    sqlite.prepare('SELECT token_hash FROM lines WHERE id=?').get(lid)!
      .token_hash,
    oldHash,
  );
  const plan = {
    id: 'qa-plan',
    name: '套餐保存测试',
    days: 1,
    price_cents: 0,
    speed_mbps: 1,
    sort: 0,
    trial: true,
    enabled: true,
  };
  assert.equal((await api('admin/plan', adminToken, plan)).status, 200);
  assert.equal(
    (
      await api('admin/plan', adminToken, {
        ...plan,
        name: '套餐编辑成功',
        speed_mbps: 100,
      })
    ).status,
    200,
  );
  assert.equal(
    (await api('admin', adminToken)).data.plans.find(
      (p: any) => p.id === plan.id,
    ).speed_mbps,
    100,
  );
  const freeRegular = await api('admin/plan', adminToken, {
    ...plan,
    id: 'free-regular',
    trial: false,
    days: 31,
    traffic_gb: 20,
  });
  assert.equal(freeRegular.status, 200);
  const invalid = await api('admin/plan', adminToken, {
    ...plan,
    id: 'too-long',
    days: 32,
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.data.error, /天数/);
  const article = {
    id: 'qa-article',
    kind: 'notice',
    title: '保存测试',
    body: '测试正文',
    published: false,
  };
  assert.equal((await api('admin/article', adminToken, article)).status, 200);
  assert.equal(
    (await api('admin/article', adminToken, { ...article, kind: 'guide' }))
      .status,
    200,
  );
  assert.equal(
    (await api('admin', adminToken)).data.articles.find(
      (a: any) => a.id === article.id,
    ).kind,
    'guide',
  );
  const invites = await api('admin/invite', adminToken, {
    count: 2,
    max_uses: 1,
    days: 7,
    label: '测试',
  });
  assert.equal(invites.data.codes.length, 2);
  assert.equal((await api('admin', adminToken)).data.invitations.length, 2);
  assert.equal(
    (
      await api('admin/settings', adminToken, {
        support_email: 'support@qq.com',
      })
    ).status,
    200,
  );
  assert.equal(
    (await api('admin', adminToken)).data.settings.support_email,
    'support@qq.com',
  );
  const ticket = await api('tickets', customerToken, {
    subject: '测试工单',
    category: 'connection',
    body: '测试描述',
  });
  assert.equal(ticket.status, 200);
  const ticketPath = 'tickets/' + ticket.data.id;
  assert.equal((await api(ticketPath, otherToken)).status, 404);
  assert.equal(
    (await api(ticketPath, adminToken, { body: '管理员回复' })).status,
    200,
  );
  assert.equal((await api(ticketPath, customerToken)).data.messages.length, 2);
  assert.equal(
    (await api(ticketPath, customerToken, { close: true })).status,
    200,
  );
  assert.equal(
    (await api(ticketPath, customerToken)).data.ticket.status,
    'closed',
  );
  assert.equal(
    (await api('vps/deploy-quota', adminToken)).data.unlimited,
    true,
  );
  assert.equal((await api('vps/probe', customerToken)).data.remaining, 10);
  assert.equal((await api('admin/backup', customerToken)).status, 403);
  assert.equal((await api('admin/backup', adminToken)).status, 200);
});
