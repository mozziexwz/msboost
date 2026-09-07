'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { stamp } from './widgets';

type Relay = {
  id: string;
  email: string;
  line_name: string;
  target_ip: string;
  listen_port: number;
  target_host: string;
  target_port: number;
  protocol: string;
  reported_at: number | null;
  current_bps: number | null;
  traffic_used_bytes: number;
  expires_at: number;
  suspended: number;
  reported_state: string;
  heartbeat_at: number | null;
  line_enabled: number;
  reported_revision: number;
  revision: number;
  cpu_pct: number | null;
  memory_pct: number | null;
  version: string | null;
  rtt_ms: number | null;
  loss_pct: number | null;
  front_host: string | null;
  requires_front: number;
  last_error: string | null;
};

export default function RelayAdmin({
  relays,
  act,
  busy,
}: {
  relays: Relay[];
  act: (action: string, body: Record<string, unknown>) => Promise<unknown>;
  busy: boolean;
}) {
  const [detail, setDetail] = useState('');
  const [currentTime] = useState(() => Date.now() / 1000);
  return (
    <div className="section-stack relay-admin">
      <div>
        <h2>用户转发</h2>
        <p className="muted">
          速率按最近两次心跳的双向流量计算；超过两分钟未上报时显示未知。
        </p>
      </div>
      {!relays.length && <p>暂无转发记录</p>}
      <div className="relay-admin-grid">
        {relays.map((relay) => (
          <section className="plan-card" key={relay.id}>
            <div className="subheading">
              <div>
                <h3>{relay.email}</h3>
                <span>{relay.line_name}</span>
              </div>
              <span
                className={`pill ${relay.reported_state === 'active' ? 'live' : ''}`}
              >
                {relay.suspended ? '已暂停' : relay.reported_state}
              </span>
            </div>
            <p className="mono">
              {relay.target_ip === '0.0.0.0'
                ? '尚未绑定节点'
                : `${relay.listen_port} → ${relay.target_host}:${relay.target_port} (${relay.protocol})`}
            </p>
            <div className="relay-metrics">
              <span>
                <b>
                  {relay.reported_at !== null &&
                  relay.reported_at > currentTime - 120 &&
                  relay.current_bps != null
                    ? `${((relay.current_bps * 8) / 1_000_000).toFixed(3)} Mbps`
                    : '未知'}
                </b>
                当前速率
              </span>
              <span>
                <b>
                  {(relay.traffic_used_bytes / 1_073_741_824).toFixed(2)} GB
                </b>
                已用流量
              </span>
              <span>
                <b>{stamp(relay.expires_at)}</b>套餐到期
              </span>
            </div>
            <div className="inline-fields">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void act('relay', {
                    id: relay.id,
                    suspended: !relay.suspended,
                  })
                }
              >
                {relay.suspended ? '恢复' : '暂停'}
              </Button>
              <Button
                variant="outline"
                onClick={() => setDetail(detail === relay.id ? '' : relay.id)}
              >
                诊断
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      '删除此用户转发配置？套餐有效期与订单保留，旧转发将在执行机同步或租约到期时停止。',
                    )
                  )
                    void act('relay-delete', { id: relay.id });
                }}
              >
                删除转发
              </Button>
            </div>
            {detail === relay.id && (
              <div className="job-box">
                <p>
                  线路心跳：{stamp(relay.heartbeat_at)} ·{' '}
                  {relay.line_enabled ? '已启用' : '已停用'}
                </p>
                <p>
                  执行机上报：{stamp(relay.reported_at)} · 配置版本{' '}
                  {relay.reported_revision}/{relay.revision}
                </p>
                <p>
                  资源：CPU {relay.cpu_pct ?? '—'}% · 内存{' '}
                  {relay.memory_pct ?? '—'}% · {relay.version || '未上报版本'}
                </p>
                <p>
                  线路质量：{relay.rtt_ms ?? '—'} ms · 丢包{' '}
                  {relay.loss_pct ?? '—'}%
                </p>
                <p>
                  前置机：{relay.front_host || '未配置'}
                  {relay.requires_front ? '（此线路强制要求）' : '（可选）'}
                </p>
                <p>最近错误：{relay.last_error || '未上报错误'}</p>
                <p>
                  {!relay.heartbeat_at || relay.heartbeat_at < currentTime - 120
                    ? '线路失联：请检查转发机 msboostgost 服务日志。'
                    : relay.expires_at < currentTime
                      ? '套餐已到期。'
                      : relay.requires_front && !relay.front_host
                        ? '等待部置前置机。'
                        : relay.reported_revision !== relay.revision
                          ? '等待执行机应用新配置。'
                          : '已收到执行状态；此诊断不替代客户端游戏连通测试。'}
                </p>
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
