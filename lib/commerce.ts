import {
  assert,
  cents,
  DAY,
  durationGate,
  epaySign,
  equal,
  id,
  now,
} from './core';
import {
  audit,
  db,
  env,
  int,
  one,
  resolveTarget,
  rows,
  settings,
  stmt,
  text,
  type User,
} from './server';

export function gateway(s: Record<string, any>) {
  assert(
    s.epay_url && s.epay_pid && s.epay_key,
    '易支付尚未配置，请联系管理员',
    503,
  );
  const u = new URL(s.epay_url);
  assert(
    u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash,
    '支付网关须为 HTTPS 地址',
  );
  return u.href.replace(/\/?$/, '/');
}
export async function settleOrder(
  orderId: string,
  tradeNo: string | null,
  provider: string,
) {
  const o = await one('SELECT * FROM orders WHERE id=?', orderId);
  assert(o, '订单不存在', 404);
  assert(o.provider_id === provider, '支付商户不匹配');
  if (o.status === 'paid' || o.status === 'refunded') {
    assert(o.trade_no === tradeNo, '交易号不匹配');
    return;
  }
  if (o.status !== 'pending') {
    await stmt(
      "UPDATE orders SET status='payment_review',trade_no=?,paid_at=? WHERE id=? AND status NOT IN ('paid','refunded')",
      tradeNo,
      now(),
      orderId,
    ).run();
    return;
  }
  const t = now();
  await db().batch([
    stmt(
      "INSERT OR IGNORE INTO grants(order_id,relay_id,days,applied,at) SELECT id,relay_id,days,0,? FROM orders WHERE id=? AND status='pending' AND (trial=0 OR EXISTS(SELECT 1 FROM users WHERE users.id=orders.user_id AND trial_used=0))",
      t,
      orderId,
    ),
    stmt(
      'UPDATE users SET trial_used=1 WHERE id=? AND EXISTS(SELECT 1 FROM grants g JOIN orders o ON o.id=g.order_id WHERE g.order_id=? AND g.applied=0 AND o.trial=1)',
      o.user_id,
      orderId,
    ),
    stmt(
      "UPDATE orders SET status='paid',trade_no=?,paid_at=? WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM grants WHERE order_id=?)",
      tradeNo,
      t,
      orderId,
      orderId,
    ),
    stmt(
      "UPDATE relays SET expires_at=MAX(expires_at,?)+(SELECT days*? FROM grants WHERE order_id=?),speed_mbps=?,traffic_limit_bytes=(SELECT CAST(traffic_gb AS INTEGER)*1073741824 FROM orders WHERE id=?),traffic_used_bytes=0,revision=revision+1,suspended=CASE WHEN target_ip='0.0.0.0' THEN 1 ELSE 0 END,reported_state='pending' WHERE id=? AND EXISTS(SELECT 1 FROM grants WHERE order_id=? AND applied=0)",
      t,
      DAY,
      orderId,
      o.speed_mbps,
      orderId,
      o.relay_id,
      orderId,
    ),
    stmt('UPDATE grants SET applied=1 WHERE order_id=? AND applied=0', orderId),
  ]);
  assert(
    await one('SELECT 1 AS ok FROM grants WHERE order_id=?', orderId),
    '体验套餐已领取',
    409,
  );
}
export async function createOrder(req: Request, u: User, b: any) {
  const s = await settings();
  assert(s.terms_confirmed, '套餐销售尚未开放', 503);
  const plan = await one(
    'SELECT * FROM plans WHERE id=? AND enabled=1',
    b.plan_id,
  );
  assert(plan, '套餐不可用');
  assert(!plan.trial || !u.trial_used, '每个账号仅可领取一次免费体验');
  const hasTarget = Boolean(b.target_host),
    targetHost = hasTarget
      ? text(b.target_host, 253, '节点地址')
      : 'pending.invalid',
    targetPort = hasTarget ? int(b.target_port, 1, 65535, '节点端口') : 1,
    protocol = hasTarget ? b.protocol : 'TCP';
  assert(['TCP', 'UDP'].includes(protocol), '无效的隧道协议');
  const targetIp = hasTarget ? await resolveTarget(targetHost) : '0.0.0.0';
  const own = await rows('SELECT host FROM lines');
  assert(
    !own.some((x) => x.host === targetHost || x.host === targetIp),
    '不能把 MSBOOST 线路作为转发目标',
  );
  await stmt(
    "UPDATE orders SET status='closed' WHERE user_id=? AND status='pending' AND created_at<?",
    u.id,
    now() - 1800,
  ).run();
  assert(
    !(await one(
      "SELECT id FROM orders WHERE user_id=? AND status='pending'",
      u.id,
    )),
    '有待支付订单，请先付款或取消',
    409,
  );
  let relay = await one(
    'SELECT * FROM relays WHERE user_id=? ORDER BY expires_at DESC,created_at DESC LIMIT 1',
    u.id,
  );
  if (relay) {
    assert(
      !durationGate(relay.expires_at),
      '当前线路剩余有效期超过 30 天，暂不能重复购买',
      409,
    );
    if (hasTarget)
      await stmt(
        "UPDATE relays SET target_host=?,target_ip=?,target_port=?,protocol=?,suspended=0,revision=revision+1,reported_state='pending' WHERE id=?",
        targetHost,
        targetIp,
        targetPort,
        protocol,
        relay.id,
      ).run();
  } else {
    const availableLines = await rows(
      'SELECT * FROM lines WHERE enabled=1 ORDER BY created_at',
    );
    assert(availableLines.length, '管理员尚未配置可用线路', 503);
    for (const candidate of availableLines) {
      const used = new Set(
        (
          await rows(
            'SELECT listen_port FROM relays WHERE line_id=?',
            candidate.id,
          )
        ).map((x) => x.listen_port),
      );
      for (
        let port = candidate.port_start;
        port <= candidate.port_end;
        port++
      ) {
        if (used.has(port)) continue;
        try {
          await stmt(
            'INSERT INTO relays(id,user_id,line_id,target_host,target_ip,target_port,protocol,listen_port,speed_mbps,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
            id(),
            u.id,
            candidate.id,
            targetHost,
            targetIp,
            targetPort,
            protocol,
            port,
            plan.speed_mbps,
            now(),
          ).run();
          break;
        } catch (e) {
          if (!String(e).includes('UNIQUE')) throw e;
        }
      }
      relay = await one('SELECT * FROM relays WHERE user_id=?', u.id);
      if (relay) break;
    }
    assert(relay, '所有线路端口均已用完', 409);
  }
  const channel = plan.price_cents === 0 ? 'free' : b.channel;
  assert(plan.price_cents >= 0, '套餐价格无效');
  assert(
    channel === 'free' ||
      (channel === 'alipay' && s.epay_alipay) ||
      (channel === 'wxpay' && s.epay_wxpay),
    '支付方式不可用',
  );
  const provider = channel === 'free' ? 'free' : gateway(s) + '#' + s.epay_pid;
  const orderId = 'MS' + id();
  await stmt(
    "INSERT INTO orders(id,user_id,relay_id,plan_id,name,days,price_cents,speed_mbps,traffic_gb,trial,channel,provider_id,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM orders WHERE user_id=? AND status='pending') AND EXISTS(SELECT 1 FROM users WHERE id=? AND (?=0 OR trial_used=0))",
    orderId,
    u.id,
    relay.id,
    plan.id,
    plan.name,
    plan.days,
    plan.price_cents,
    plan.speed_mbps,
    plan.traffic_gb,
    plan.trial,
    channel,
    provider,
    now(),
    u.id,
    u.id,
    plan.trial,
  ).run();
  assert(
    await one('SELECT id FROM orders WHERE id=?', orderId),
    '订单创建冲突，请刷新重试',
    409,
  );
  await audit(req, u.id, 'order.create', orderId);
  if (channel === 'free') await settleOrder(orderId, null, 'free');
  return { order_id: orderId, paid: channel === 'free' };
}
export async function paymentForm(u: User, orderId: string) {
  const o = await one(
    'SELECT * FROM orders WHERE id=? AND user_id=?',
    orderId,
    u.id,
  );
  assert(
    o && o.status === 'pending' && o.created_at > now() - 1800,
    '订单已失效',
    409,
  );
  const s = await settings(),
    base = gateway(s);
  assert(
    o.provider_id === base + '#' + s.epay_pid,
    '支付配置已变化，请取消后重新下单',
    409,
  );
  const origin = env.PUBLIC_ORIGIN;
  assert(
    origin && new URL(origin).protocol === 'https:',
    '请配置正式站点地址',
    503,
  );
  const p: Record<string, string> = {
    pid: String(s.epay_pid),
    type: o.channel,
    out_trade_no: o.id,
    notify_url: origin + '/api/payment/notify',
    return_url: origin + '/?view=orders',
    name: 'MSBOOST ' + o.name,
    money: (o.price_cents / 100).toFixed(2),
  };
  p.sign = epaySign(p, s.epay_key);
  p.sign_type = 'MD5';
  return { action: base + 'submit.php', params: p };
}
export async function verifyNotification(p: Record<string, string>) {
  const s = await settings();
  assert(p.sign_type === undefined || p.sign_type === 'MD5', '签名类型不支持');
  assert(
    p.sign && equal(epaySign(p, s.epay_key), p.sign.toLowerCase()),
    '支付签名无效',
    403,
  );
  assert(
    p.pid === String(s.epay_pid) && p.trade_status === 'TRADE_SUCCESS',
    '不是有效的成功通知',
  );
  const o = await one('SELECT * FROM orders WHERE id=?', p.out_trade_no);
  assert(
    o && cents(p.money) === o.price_cents && p.type === o.channel && p.trade_no,
    '订单支付信息不匹配',
  );
  await settleOrder(o.id, p.trade_no, gateway(s) + '#' + s.epay_pid);
}
export async function checkPayment(u: User, orderId: string) {
  const o = await one(
    'SELECT * FROM orders WHERE id=? AND user_id=?',
    orderId,
    u.id,
  );
  assert(o, '订单不存在', 404);
  if (o.status === 'paid') return { status: 'paid' };
  const s = await settings(),
    base = gateway(s);
  assert(
    o.provider_id === base + '#' + s.epay_pid,
    '支付渠道已变化，需人工对账',
    409,
  );
  const q = new URLSearchParams({
    act: 'order',
    pid: String(s.epay_pid),
    key: s.epay_key,
    out_trade_no: orderId,
  });
  const r = await fetch(base + 'api.php?' + q, {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  assert(r.ok, '查单失败', 502);
  const d = (await r.json()) as any;
  if (Number(d.code) === 1 && Number(d.status) === 1) {
    assert(
      String(d.pid) === String(s.epay_pid) &&
        d.out_trade_no === orderId &&
        cents(String(d.money)) === o.price_cents &&
        d.type === o.channel &&
        d.trade_no,
      '查单结果与订单不一致',
      502,
    );
    await settleOrder(o.id, String(d.trade_no), o.provider_id);
  }
  return {
    status: (await one('SELECT status FROM orders WHERE id=?', orderId)).status,
  };
}
