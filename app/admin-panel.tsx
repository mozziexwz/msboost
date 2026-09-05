'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Plus, RefreshCw, Save, Settings2 } from 'lucide-react';
import BackupCenter from './backup-center';
import {
  api,
  Empty,
  Field,
  Loading,
  Notice,
  Picker,
  stamp,
  money,
} from './widgets';
export default function AdminPanel({ onRefresh }: { onRefresh: () => void }) {
  const [data, setData] = useState<any>(null),
    [tab, setTab] = useState('settings'),
    [error, setError] = useState(''),
    [success, setSuccess] = useState(''),
    [busy, setBusy] = useState(false),
    [edit, setEdit] = useState<any>(null),
    [secret, setSecret] = useState('');
  async function load() {
    try {
      setData(await api('admin'));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    load();
  }, []);
  async function act(action: string, b: any) {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const r = await api('admin/' + action, b);
      if (r.codes) setSecret(r.codes.join('\n'));
      if (r.node_token)
        setSecret(
          `线路 ID：${r.id || b.id}\nNODE_TOKEN=${r.node_token}\n\n只显示此次。请保存到你自己的线路服务器配置文件中。`,
        );
      setSuccess('已保存');
      setEdit(null);
      await load();
      onRefresh();
      return r;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <>
        <Notice text={error} />
        <Loading />
      </>
    );
  const s = data.settings;
  return (
    <section className="panel admin-panel">
      <div className="subheading">
        <h2>管理员控制台</h2>
        <div className="inline-fields">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => act('initialize', {})}
          >
            初始化默认套餐与文档
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={load}
            aria-label="刷新"
          >
            <RefreshCw size={16} />
          </Button>
        </div>
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
        <TabsList className="admin-tabs">
          {[
            ['settings', '站点设置'],
            ['lines', '转发线路'],
            ['plans', '套餐'],
            ['invitations', '邀请码'],
            ['orders', '订单 / 退款'],
            ['users', '用户'],
            ['articles', '公告 / 文档'],
            ['audit', '审计 / 封禁'],
            ['backup', '备份 / 恢复'],
          ].map(([v, l]) => (
            <TabsTrigger key={v} value={v}>
              {l}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Notice text={error} />
      <Notice text={success} ok />
      {tab === 'settings' && (
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            const patch = Object.fromEntries(
              Object.entries(s).filter(([k]) => !k.endsWith('_configured')),
            );
            act('settings', patch);
          }}
        >
          <div className="settings-section">
            <h3>注册与登录</h3>
            <div className="setting-toggle">
              <div>
                <b>邀请制注册</b>
                <p>开启时，新用户须提供有效邀请码</p>
              </div>
              <Switch
                checked={s.invite_required}
                onCheckedChange={(v) =>
                  setData({ ...data, settings: { ...s, invite_required: v } })
                }
              />
            </div>
            <div className="form-grid">
              {[
                ['login_failure_threshold', '登录失败封禁阈值'],
                ['login_window_seconds', '失败累计窗口（秒）'],
                ['ip_ban_seconds', '封禁时长（秒）'],
              ].map(([k, l]) => (
                <Field key={k} label={l}>
                  <Input
                    type="number"
                    value={s[k]}
                    onChange={(e) =>
                      setData({
                        ...data,
                        settings: { ...s, [k]: Number(e.target.value) },
                      })
                    }
                  />
                </Field>
              ))}
            </div>
          </div>
          <div className="settings-section">
            <h3>Cloudflare Turnstile</h3>
            <div className="setting-toggle">
              <div>
                <b>启用人机验证</b>
                <p>关闭时登录、注册、发验证码和重置密码不要求 Turnstile</p>
              </div>
              <Switch
                checked={s.turnstile_enabled}
                onCheckedChange={(v) =>
                  setData({ ...data, settings: { ...s, turnstile_enabled: v } })
                }
              />
            </div>
            <div className="form-grid">
              {[
                ['turnstile_site_key', 'Site Key'],
                ['turnstile_secret', 'Secret Key'],
                ['turnstile_hostnames', '允许的域名（逗号分隔）'],
              ].map(([k, l]) => (
                <Field
                  key={k}
                  label={l}
                  hint={
                    s[k + '_configured'] ? '已配置；留空保留原密钥' : undefined
                  }
                >
                  <Input
                    type={k.endsWith('secret') ? 'password' : 'text'}
                    autoComplete="off"
                    value={s[k] || ''}
                    onChange={(e) =>
                      setData({
                        ...data,
                        settings: { ...s, [k]: e.target.value },
                      })
                    }
                  />
                </Field>
              ))}
            </div>
          </div>
          <div className="settings-section">
            <h3>易支付 · V1 / MD5</h3>
            <p className="muted">
              适用于支持 submit.php、MD5 签名和标准通知的网关。平台采用 V2/RSA
              时需要另行适配。
            </p>
            <div className="form-grid">
              {[
                ['epay_url', '支付网关地址'],
                ['epay_pid', '商户号 PID'],
                ['epay_key', '商户密钥 KEY'],
              ].map(([k, l]) => (
                <Field
                  key={k}
                  label={l}
                  hint={s[k + '_configured'] ? '已配置；留空保留' : undefined}
                >
                  <Input
                    type={k === 'epay_key' ? 'password' : 'text'}
                    value={s[k] || ''}
                    autoComplete="off"
                    onChange={(e) =>
                      setData({
                        ...data,
                        settings: { ...s, [k]: e.target.value },
                      })
                    }
                    placeholder={
                      k === 'epay_url'
                        ? 'https://your-payment-provider.example/'
                        : ''
                    }
                  />
                </Field>
              ))}
            </div>
            <div className="inline-fields mt-4">
              <label className="check-line">
                <Switch
                  checked={s.epay_alipay}
                  onCheckedChange={(v) =>
                    setData({ ...data, settings: { ...s, epay_alipay: v } })
                  }
                />
                支付宝
              </label>
              <label className="check-line">
                <Switch
                  checked={s.epay_wxpay}
                  onCheckedChange={(v) =>
                    setData({ ...data, settings: { ...s, epay_wxpay: v } })
                  }
                />
                微信支付
              </label>
            </div>
          </div>
          <div className="settings-section">
            <h3>一次性部署与邮件服务器</h3>
            <div className="form-grid">
              {[
                ['worker_url', 'HTTPS 服务地址'],
                ['worker_token', '服务令牌'],
                ['support_email', '客服邮箱'],
              ].map(([k, l]) => (
                <Field
                  key={k}
                  label={l}
                  hint={s[k + '_configured'] ? '已配置；留空保留' : undefined}
                >
                  <Input
                    type={k === 'worker_token' ? 'password' : 'text'}
                    value={s[k] || ''}
                    autoComplete="off"
                    onChange={(e) =>
                      setData({
                        ...data,
                        settings: { ...s, [k]: e.target.value },
                      })
                    }
                  />
                </Field>
              ))}
            </div>
          </div>
          <div className="setting-toggle">
            <div>
              <b>开放套餐销售</b>
              <p>请先确认价格、线路、付款通道以及已补充的运营条款</p>
            </div>
            <Switch
              checked={s.terms_confirmed}
              onCheckedChange={(v) =>
                setData({ ...data, settings: { ...s, terms_confirmed: v } })
              }
            />
          </div>
          <Button disabled={busy}>
            <Save size={16} />
            保存设置
          </Button>
        </form>
      )}
      {tab === 'lines' && (
        <>
          <div className="subheading mt-6">
            <p className="muted">
              仅在你的线路服务器安装
              msboostgost。每条转发独立限速，到期停止进程。
            </p>
            <Button
              onClick={() =>
                setEdit({
                  kind: 'line',
                  name: '',
                  region: '',
                  host: '',
                  port_start: 30000,
                  port_end: 39999,
                  enabled: false,
                  requires_front: false,
                })
              }
            >
              <Plus size={16} />
              接入线路
            </Button>
          </div>
          {!data.lines.length ? (
            <Empty
              title="还没有转发线路"
              body="添加线路后，保存生成的专用令牌，按部署说明安装线路程序。"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {['线路', '公网地址', '端口池', '状态', '操作'].map((l) => (
                    <TableHead key={l}>{l}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.lines.map((l: any) => (
                  <TableRow key={l.id}>
                    <TableCell>
                      <b>{l.name}</b>
                      <small>{l.region}</small>
                    </TableCell>
                    <TableCell>{l.host}</TableCell>
                    <TableCell>
                      {l.port_start}–{l.port_end}
                    </TableCell>
                    <TableCell>
                      {l.enabled ? '启用' : '暂停销售'}
                      {l.requires_front && <small>强制自备前置机</small>}
                      <small>{stamp(l.heartbeat_at)}</small>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setEdit({
                            ...l,
                            enabled: Boolean(l.enabled),
                            requires_front: Boolean(l.requires_front),
                            kind: 'line',
                          })
                        }
                      >
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => act('rotate-line-token', { id: l.id })}
                      >
                        重置令牌
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
      {tab === 'backup' && <BackupCenter />}
      {tab === 'plans' && (
        <>
          <div className="subheading mt-6">
            <p className="muted">
              体验资格按账号永久记一次；超过 30 天剩余有效期时暂停该线路续购。
            </p>
            <Button
              onClick={() =>
                setEdit({
                  kind: 'plan',
                  name: '',
                  days: 1,
                  price_cents: 0,
                  speed_mbps: 50,
                  trial: false,
                  enabled: false,
                  sort: 0,
                })
              }
            >
              <Plus size={16} />
              添加套餐
            </Button>
          </div>
          <div className="plans-grid">
            {data.plans.map((p: any) => (
              <div className="plan-card" key={p.id}>
                <span className="tag">
                  {p.trial ? '每账号限一次' : `${p.days} 天`}
                </span>
                <h3>{p.name}</h3>
                <strong>{money(p.price_cents)}</strong>
                <p>
                  {p.speed_mbps} Mbps · {p.enabled ? '已上架' : '未上架'}
                </p>
                <Button
                  variant="outline"
                  onClick={() =>
                    setEdit({
                      ...p,
                      trial: Boolean(p.trial),
                      enabled: Boolean(p.enabled),
                      kind: 'plan',
                    })
                  }
                >
                  编辑套餐
                </Button>
              </div>
            ))}
          </div>
        </>
      )}
      {tab === 'invitations' && (
        <>
          <div className="subheading mt-6">
            <h3>邀请码</h3>
            <Button
              onClick={() =>
                setEdit({
                  kind: 'invite',
                  label: '邀请注册',
                  count: 1,
                  max_uses: 1,
                  days: 7,
                })
              }
            >
              <Plus size={16} />
              生成邀请码
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                {['备注', '使用次数', '有效期', '操作'].map((l) => (
                  <TableHead key={l}>{l}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.invitations.map((v: any) => (
                <TableRow key={v.id}>
                  <TableCell>{v.label}</TableCell>
                  <TableCell>
                    {v.uses}/{v.max_uses}
                  </TableCell>
                  <TableCell>{stamp(v.expires_at)}</TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!v.enabled}
                      onClick={() => act('revoke-invite', { id: v.id })}
                    >
                      {v.enabled ? '撤销' : '已撤销'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
      {tab === 'orders' && (
        <>
          <p className="muted mt-6">
            退款先通过支付平台核实并执行，再记录实际结果；本站不会依据未确认的接口响应重复退款。
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                {['客户 / 订单', '套餐', '金额', '状态', '操作'].map((l) => (
                  <TableHead key={l}>{l}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.orders.map((o: any) => (
                <TableRow key={o.id}>
                  <TableCell>
                    {o.email}
                    <small className="mono">{o.id}</small>
                  </TableCell>
                  <TableCell>
                    {o.name}
                    <small>{o.line_name}</small>
                  </TableCell>
                  <TableCell>{money(o.price_cents)}</TableCell>
                  <TableCell>
                    {o.status}
                    <small>{o.refund_state}</small>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!['paid', 'payment_review'].includes(o.status)}
                      onClick={() =>
                        setEdit({
                          kind: 'refund-record',
                          id: o.id,
                          state: 'submitted',
                          note: '',
                        })
                      }
                    >
                      记录退款
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        act('relay', {
                          id: o.relay_id,
                          suspended: !o.suspended,
                        })
                      }
                    >
                      {o.suspended ? '恢复线路' : '暂停线路'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
      {tab === 'users' && (
        <Table className="mt-6">
          <TableHeader>
            <TableRow>
              {['邮箱', '角色', '体验', '操作'].map((l) => (
                <TableHead key={l}>{l}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.users.map((v: any) => (
              <TableRow key={v.id}>
                <TableCell>{v.email}</TableCell>
                <TableCell>{v.role}</TableCell>
                <TableCell>{v.trial_used ? '已领取' : '未领取'}</TableCell>
                <TableCell>
                  {v.role !== 'admin' && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          act('user', {
                            id: v.id,
                            role: v.role,
                            disabled: !v.disabled,
                          })
                        }
                      >
                        {v.disabled ? '启用' : '禁用'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          act('user', {
                            id: v.id,
                            role: v.role === 'support' ? 'customer' : 'support',
                            disabled: Boolean(v.disabled),
                          })
                        }
                      >
                        {v.role === 'support' ? '撤销客服' : '设为客服'}
                      </Button>
                    </>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {tab === 'articles' && (
        <>
          <div className="subheading mt-6">
            <h3>公告、指南与服务条款</h3>
            <Button
              onClick={() =>
                setEdit({
                  kind: 'article',
                  article_kind: 'notice',
                  title: '',
                  body: '',
                  published: true,
                })
              }
            >
              <Plus size={16} />
              新建文章
            </Button>
          </div>
          {data.articles.map((a: any) => (
            <div className="article-row" key={a.id}>
              <div>
                <b>{a.title}</b>
                <small>
                  {a.kind} · {a.published ? '已发布' : '草稿'}
                </small>
              </div>
              <Button
                variant="outline"
                onClick={() =>
                  setEdit({
                    ...a,
                    kind: 'article',
                    article_kind: a.kind,
                    published: Boolean(a.published),
                  })
                }
              >
                编辑
              </Button>
            </div>
          ))}
        </>
      )}
      {tab === 'audit' && (
        <>
          <h3 className="mt-6">当前登录封禁</h3>
          {data.bans.map((b: any) => (
            <div className="article-row" key={b.key}>
              <span>
                {b.key}
                <small>封禁至 {stamp(b.blocked_until)}</small>
              </span>
              <Button
                variant="outline"
                onClick={() => act('unban', { key: b.key })}
              >
                解除
              </Button>
            </div>
          ))}
          <h3 className="my-6">操作审计</h3>
          <Table>
            <TableHeader>
              <TableRow>
                {['时间', '操作', '对象', '来源 IP'].map((l) => (
                  <TableHead key={l}>{l}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.audit.map((a: any) => (
                <TableRow key={a.id}>
                  <TableCell>{stamp(a.created_at)}</TableCell>
                  <TableCell>{a.action}</TableCell>
                  <TableCell>{a.subject}</TableCell>
                  <TableCell>{a.ip}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
      <Dialog open={Boolean(edit)} onOpenChange={(v) => !v && setEdit(null)}>
        <DialogContent className="edit-dialog">
          <DialogHeader>
            <DialogTitle>
              编辑
              {
                (
                  {
                    line: '线路',
                    plan: '套餐',
                    invite: '邀请码',
                    article: '文章',
                    'refund-record': '退款记录',
                  } as any
                )[edit?.kind]
              }
            </DialogTitle>
            <DialogDescription>保存后立即更新后台配置</DialogDescription>
          </DialogHeader>
          {edit && (
            <form
              className="form-stack"
              onSubmit={(e) => {
                e.preventDefault();
                const { kind, article_kind, ...body } = edit;
                act(
                  kind,
                  kind === 'article' ? { ...body, kind: article_kind } : body,
                );
              }}
            >
              {edit.kind === 'article' ? (
                <>
                  <Field label="类型">
                    <Picker
                      value={edit.article_kind}
                      onChange={(v) => setEdit({ ...edit, article_kind: v })}
                      options={[
                        { value: 'notice', label: '故障 / 维护公告' },
                        { value: 'guide', label: '使用指南' },
                        { value: 'policy', label: '服务条款' },
                      ]}
                    />
                  </Field>
                  <Field label="标题">
                    <Input
                      value={edit.title}
                      onChange={(e) =>
                        setEdit({ ...edit, title: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="正文">
                    <Textarea
                      rows={12}
                      value={edit.body}
                      onChange={(e) =>
                        setEdit({ ...edit, body: e.target.value })
                      }
                    />
                  </Field>
                </>
              ) : edit.kind === 'refund-record' ? (
                <>
                  <Field label="退款状态">
                    <Picker
                      value={edit.state}
                      onChange={(v) => setEdit({ ...edit, state: v })}
                      options={[
                        { value: 'submitted', label: '已提交渠道' },
                        { value: 'unknown', label: '结果未知，待核查' },
                        { value: 'completed', label: '已确认退款完成' },
                        { value: 'rejected', label: '退款未获批准' },
                      ]}
                    />
                  </Field>
                  <Field label="核实说明 / 渠道退款单号">
                    <Textarea
                      value={edit.note}
                      onChange={(e) =>
                        setEdit({ ...edit, note: e.target.value })
                      }
                    />
                  </Field>
                  <p className="muted">
                    确认完成后，将扣除该订单对应的有效天数并通知线路服务器。
                  </p>
                </>
              ) : (
                <div className="form-grid">
                  {(edit.kind === 'line'
                    ? [
                        ['name', '线路名称'],
                        ['region', '地区 / 运营商'],
                        ['host', '公网 IP 或域名'],
                        ['port_start', '专属端口池起点'],
                        ['port_end', '专属端口池终点'],
                        ['probe_label', '延迟探测路径说明'],
                        ['description', '线路说明'],
                      ]
                    : edit.kind === 'plan'
                      ? [
                          ['name', '套餐名称'],
                          ['days', '有效天数'],
                          ['price_cents', '价格（分）'],
                          ['speed_mbps', '每方向带宽 Mbps'],
                          ['sort', '排序'],
                        ]
                      : [
                          ['label', '备注'],
                          ['count', '生成数量'],
                          ['max_uses', '每个码可用次数'],
                          ['days', '有效天数'],
                        ]
                  ).map(([k, l]) => (
                    <Field key={k} label={l}>
                      <Input
                        type={
                          [
                            'port_start',
                            'port_end',
                            'days',
                            'price_cents',
                            'speed_mbps',
                            'sort',
                            'count',
                            'max_uses',
                          ].includes(k)
                            ? 'number'
                            : 'text'
                        }
                        value={edit[k] ?? ''}
                        onChange={(e) =>
                          setEdit({
                            ...edit,
                            [k]:
                              e.target.type === 'number'
                                ? Number(e.target.value)
                                : e.target.value,
                          })
                        }
                      />
                    </Field>
                  ))}
                </div>
              )}
              {['line', 'plan'].includes(edit.kind) && (
                <label className="check-line">
                  <Switch
                    checked={Boolean(edit.enabled)}
                    onCheckedChange={(v) => setEdit({ ...edit, enabled: v })}
                  />
                  启用
                </label>
              )}
              {edit.kind === 'plan' && (
                <label className="check-line">
                  <Switch
                    checked={Boolean(edit.trial)}
                    onCheckedChange={(v) => setEdit({ ...edit, trial: v })}
                  />
                  免费新人体验
                </label>
              )}
              {edit.kind === 'line' && (
                <label className="check-line">
                  <Switch
                    checked={Boolean(edit.requires_front)}
                    onCheckedChange={(v) =>
                      setEdit({ ...edit, requires_front: v })
                    }
                  />
                  必须使用客户自备前置机
                </label>
              )}
              {edit.kind === 'article' && (
                <label className="check-line">
                  <Switch
                    checked={Boolean(edit.published)}
                    onCheckedChange={(v) => setEdit({ ...edit, published: v })}
                  />
                  发布
                </label>
              )}
              <Notice text={error} />
              <Button disabled={busy}>
                <Save size={16} />
                保存
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(secret)} onOpenChange={(v) => !v && setSecret('')}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>请立即保存</DialogTitle>
            <DialogDescription>
              关闭后无法再次查看原始令牌或邀请码
            </DialogDescription>
          </DialogHeader>
          <pre className="secret-output">{secret}</pre>
          <Button onClick={() => navigator.clipboard.writeText(secret)}>
            复制
          </Button>
        </DialogContent>
      </Dialog>
    </section>
  );
}
