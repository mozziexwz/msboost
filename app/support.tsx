'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Headphones, MessageSquare, Plus } from 'lucide-react';
import { api, Empty, Field, Notice, Picker, stamp } from './widgets';
export default function Support({
  user,
  onLogin,
}: {
  user: any;
  onLogin: () => void;
}) {
  const [tickets, setTickets] = useState<any[]>([]),
    [selected, setSelected] = useState<any>(null),
    [creating, setCreating] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [subject, setSubject] = useState(''),
    [category, setCategory] = useState('connection'),
    [body, setBody] = useState(''),
    [orderId, setOrderId] = useState('');
  async function load() {
    try {
      setTickets((await api('tickets')).tickets);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    if (user) load();
  }, [user]);
  async function open(id: string) {
    setCreating(false);
    setBody('');
    try {
      setSelected(await api('tickets/' + id));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api(
        creating ? 'tickets' : 'tickets/' + selected.ticket.id,
        creating ? { subject, category, body, order_id: orderId } : { body },
      );
      setBody('');
      await open(creating ? r.id : selected.ticket.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!user)
    return (
      <section className="panel">
        <Empty
          title="登录后查看工单"
          body="线路故障、订单和退款问题，都可以通过工单联系管理员。"
        />
        <Button className="mt-5" onClick={onLogin}>
          登录 / 注册
        </Button>
      </section>
    );
  return (
    <section className="panel">
      <div className="subheading">
        <h2>{user.role === 'customer' ? '我的工单' : '客服工作台'}</h2>
        <Button
          onClick={() => {
            setCreating(true);
            setSelected(null);
            setBody('');
          }}
        >
          <Plus size={16} />
          提交工单
        </Button>
      </div>
      <Notice text={error} />
      <div className="tickets-layout">
        <div className="ticket-list">
          {tickets.length ? (
            tickets.map((t) => (
              <button
                key={t.id}
                className={selected?.ticket.id === t.id ? 'selected' : ''}
                onClick={() => open(t.id)}
              >
                <span>
                  <MessageSquare size={16} />
                  <b>{t.subject}</b>
                </span>
                <small>
                  {t.status} · {stamp(t.updated_at)}
                </small>
                {user.role !== 'customer' && <small>{t.email}</small>}
              </button>
            ))
          ) : (
            <Empty title="暂无工单" body="有问题时，随时在这里联系我们。" />
          )}
        </div>
        <div>
          {creating ? (
            <form onSubmit={send} className="form-stack">
              <Field label="主题">
                <Input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  required
                  maxLength={120}
                />
              </Field>
              <Field label="问题类型">
                <Picker
                  value={category}
                  onChange={setCategory}
                  options={[
                    { value: 'connection', label: '连接 / 线路故障' },
                    { value: 'deployment', label: 'VPS 部署' },
                    { value: 'billing', label: '付款 / 退款' },
                    { value: 'other', label: '其他问题' },
                  ]}
                />
              </Field>
              <Field label="订单号（可选）">
                <Input
                  value={orderId}
                  onChange={(e) => setOrderId(e.target.value)}
                />
              </Field>
              <Field
                label="问题描述"
                hint="请提供发生时间与错误提示；不要在工单填写 SSH 密码、节点密码或支付密钥。"
              >
                <Textarea
                  rows={6}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  maxLength={5000}
                  required
                />
              </Field>
              <Button type="submit" disabled={busy}>{busy ? '正在提交…' : '提交工单'}</Button>
            </form>
          ) : selected ? (
            <>
              <div className="subheading">
                <h3>{selected.ticket.subject}</h3>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={selected.ticket.status === 'closed'}
                  onClick={async () => {
                    try {
                      await api('tickets/' + selected.ticket.id, {
                        close: true,
                      });
                      await open(selected.ticket.id);
                      await load();
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  关闭工单
                </Button>
              </div>
              <div className="messages">
                {selected.messages.map((m: any) => (
                  <article
                    className={m.role === 'customer' ? '' : 'staff-message'}
                    key={m.id}
                  >
                    <small>
                      {m.role === 'customer' ? '客户' : 'MSBOOST 客服'} ·{' '}
                      {stamp(m.created_at)}
                    </small>
                    <p>{m.body}</p>
                  </article>
                ))}
              </div>
              <form onSubmit={send} className="form-stack">
                <Textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="输入回复…"
                  maxLength={5000}
                  required
                />
                <Button type="submit" disabled={busy}>{busy ? '正在发送…' : '发送回复'}</Button>
              </form>
            </>
          ) : (
            <div className="ticket-placeholder">
              <Headphones size={36} />
              <p>选择一条工单查看对话</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
