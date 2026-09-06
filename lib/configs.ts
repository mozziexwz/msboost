import { assert, id, now } from './core';
import {
  db,
  decrypt,
  encrypt,
  env,
  one,
  rows,
  stmt,
  type User,
} from './server';
import { parseConfig, rewriteConfig } from './mieru';
import { resolveTarget } from './server';
function bucket(): R2Bucket {
  assert(env.CONFIGS, '配置文件存储尚未接入', 503);
  return env.CONFIGS;
}
export async function saveConfig(u: User, relayId: string, source: string) {
  const r = await one(
    'SELECT r.*,l.host AS relay_host,l.name AS line_name FROM relays r JOIN lines l ON l.id=r.line_id WHERE r.id=? AND r.user_id=?',
    relayId,
    u.id,
  );
  assert(
    r && r.expires_at > now() && !r.suspended,
    '须先购买有效转发套餐',
    403,
  );
  const { config, targets } = parseConfig(source),
    target = targets.find(
      (t) =>
        t.host === r.target_host &&
        t.port === r.target_port &&
        t.protocol === r.protocol,
    );
  assert(target, '配置与此转发的原始节点不一致');
  const transformed = rewriteConfig(
    config,
    target,
    {
      host: r.relay_host,
      port: r.listen_port,
      name: r.line_name,
    },
    u.email.split('@')[0],
  );
  const key = 'paid/' + u.id + '/' + relayId + '/' + id() + '.enc';
  // Track every object before upload, so interrupted uploads never become untracked orphans.
  await stmt(
    'INSERT INTO config_garbage(object_key,delete_after) VALUES(?,?)',
    key,
    now() + 600,
  ).run();
  await bucket().put(key, await encrypt(JSON.stringify(transformed)), {
    httpMetadata: { contentType: 'application/octet-stream' },
  });
  try {
    await db().batch([
      stmt(
        'INSERT OR IGNORE INTO config_garbage(object_key,delete_after) SELECT object_key,? FROM config_files WHERE relay_id=?',
        now(),
        relayId,
      ),
      stmt(
        'INSERT INTO config_files(relay_id,object_key,created_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM relays WHERE id=? AND expires_at>? AND suspended=0) ON CONFLICT(relay_id) DO UPDATE SET object_key=excluded.object_key,created_at=excluded.created_at',
        relayId,
        key,
        now(),
        relayId,
        now(),
      ),
      stmt(
        'DELETE FROM config_garbage WHERE object_key IN (SELECT object_key FROM config_files WHERE relay_id=?)',
        relayId,
      ),
    ]);
    const active = await one(
      'SELECT object_key FROM config_files WHERE relay_id=?',
      relayId,
    );
    assert(active?.object_key === key, '套餐已到期或配置同时被更新', 409);
  } catch (e) {
    throw e;
  }
  return { saved: true };
}
export async function bindConfig(
  u: User,
  relayId: string,
  source: string,
  targetKey: string,
) {
  const relay = await one(
    'SELECT r.*,l.host AS relay_host FROM relays r JOIN lines l ON l.id=r.line_id WHERE r.id=? AND r.user_id=?',
    relayId,
    u.id,
  );
  assert(relay && relay.expires_at > now(), '请先购买有效套餐', 403);
  assert(
    !relay.suspended || relay.target_ip === '0.0.0.0',
    '此隧道已被管理员暂停',
    403,
  );
  assert(
    !relay.traffic_limit_bytes ||
      relay.traffic_used_bytes < relay.traffic_limit_bytes,
    '套餐流量已用尽',
    403,
  );
  const parsed = parseConfig(source),
    target = parsed.targets.find((t) => t.key === targetKey);
  assert(target, '请选择有效的节点');
  const targetIp = await resolveTarget(target.host);
  assert(
    targetIp !== relay.relay_host && target.host !== relay.relay_host,
    '不能把本站线路作为落地节点',
  );
  await db().batch([
    stmt(
      'INSERT OR IGNORE INTO config_garbage(object_key,delete_after) SELECT c.object_key,? FROM config_files c JOIN relays r ON r.id=c.relay_id WHERE r.user_id=? AND r.id<>?',
      now(),
      u.id,
      relayId,
    ),
    stmt(
      'DELETE FROM config_files WHERE relay_id IN (SELECT id FROM relays WHERE user_id=? AND id<>?)',
      u.id,
      relayId,
    ),
    stmt(
      "UPDATE relays SET suspended=1,revision=revision+1,reported_state='pending' WHERE user_id=? AND id<>?",
      u.id,
      relayId,
    ),
    stmt(
      'INSERT OR IGNORE INTO config_garbage(object_key,delete_after) SELECT object_key,? FROM config_files WHERE relay_id=?',
      now(),
      relayId,
    ),
    stmt('DELETE FROM config_files WHERE relay_id=?', relayId),
    stmt(
      "UPDATE relays SET target_host=?,target_ip=?,target_port=?,protocol=?,suspended=0,traffic_used_bytes=0,revision=revision+1,reported_state='pending' WHERE id=? AND user_id=?",
      target.host,
      targetIp,
      target.port,
      target.protocol,
      relayId,
      u.id,
    ),
  ]);
  await saveConfig(u, relayId, source);
  return { saved: true };
}
export async function getConfig(u: User, relayId: string, front = false) {
  const r = await one(
    'SELECT r.*,c.object_key,l.requires_front,l.name AS line_name FROM relays r JOIN config_files c ON c.relay_id=r.id JOIN lines l ON l.id=r.line_id WHERE r.id=? AND r.user_id=?',
    relayId,
    u.id,
  );
  assert(
    r && r.expires_at > now() && !r.suspended,
    '配置不存在、已到期或转发已暂停',
    404,
  );
  assert(
    !r.requires_front || front,
    '此线路必须先部署自备前置机并下载前置配置',
    403,
  );
  const obj = await bucket().get(r.object_key);
  assert(obj, '配置已删除，请重新上传原始文件生成', 404);
  const config = JSON.parse(await decrypt(await obj.text()));
  if (front) {
    const f = await one('SELECT * FROM fronts WHERE relay_id=?', relayId);
    assert(f, '尚未部署前置机');
    const server = config.profiles[0].servers[0];
    server.ipAddress = f.host;
    server.domainName = '';
    server.portBindings = [{ port: f.port, protocol: r.protocol }];
    config.profiles[0].profileName += ' · 自备前置';
    config.activeProfile = config.profiles[0].profileName;
  }
  return new Response(JSON.stringify(config, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(r.line_name + '.json')}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
export async function purgeExpired(lineId?: string) {
  if (!env.CONFIGS) return 0;
  const t = now(),
    scope =
      'SELECT c.object_key FROM config_files c JOIN relays r ON r.id=c.relay_id WHERE r.expires_at<=?' +
      (lineId ? ' AND r.line_id=?' : '');
  const args = lineId ? [t, lineId] : [t];
  await stmt(
    'UPDATE relays SET traffic_used_bytes=0,traffic_limit_bytes=0 WHERE expires_at<=?' +
      (lineId ? ' AND line_id=?' : ''),
    ...args,
  ).run();
  // Commit a durable deletion queue and revoke downloads together; failed R2 deletes retry.
  await db().batch([
    stmt(
      'INSERT OR IGNORE INTO config_garbage(object_key,delete_after) SELECT object_key,? FROM config_files WHERE object_key IN (' +
        scope +
        ')',
      t,
      ...args,
    ),
    stmt(
      'DELETE FROM config_files WHERE object_key IN (' + scope + ')',
      ...args,
    ),
  ]);
  const expired = await rows(
    'SELECT object_key FROM config_garbage WHERE delete_after<=? AND object_key NOT IN (SELECT object_key FROM config_files) LIMIT 100',
    t,
  );
  let count = 0;
  for (const c of expired) {
    try {
      await bucket().delete(c.object_key);
      await stmt(
        'DELETE FROM config_garbage WHERE object_key=?',
        c.object_key,
      ).run();
      count++;
    } catch {
      /* Keep the queue entry for the next maintenance heartbeat. */
    }
  }
  await db().batch([
    stmt('DELETE FROM sessions WHERE expires_at<=?', t),
    stmt('DELETE FROM email_codes WHERE expires_at<?', t - 3600),
    stmt(
      'DELETE FROM rate_limits WHERE reset_at<? AND blocked_until<?',
      t - DAY,
      t,
    ),
  ]);
  return count;
}
const DAY = 86400;
