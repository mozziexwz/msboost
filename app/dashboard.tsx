'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Cable,
  Check,
  ChevronRight,
  CloudUpload,
  Download,
  FileJson,
  Globe2,
  Headphones,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Radio,
  Server,
  Settings2,
  ShieldCheck,
  Terminal,
  Wallet,
} from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import MapleIcon from './maple-icon';
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
import {
  parseConfig,
  rewriteConfig,
  downloadJson,
  type MieruConfig,
  type Target,
} from '@/lib/mieru';
import {
  api,
  AuthDialog,
  Empty,
  Field,
  Loading,
  Notice,
  money,
  stamp,
} from './widgets';
import VpsTools from './vps-tools';
import AdminPanel from './admin-panel';
import Support from './support';
import Markdown from './markdown';
import GuideReader from './guide-reader';
const links = [
  { id: 'guides', icon: BookOpen, label: '教程（必看）' },
  { id: 'vps', icon: Terminal, label: 'VPS 节点部署' },
  { id: 'orders', icon: Wallet, label: '套餐与订单' },
  { id: 'relay', icon: LayoutDashboard, label: '隧道中转' },
  { id: 'tickets', icon: Headphones, label: '我的工单' },
];
const stateLabels: Record<string, string> = {
  pending: '等待处理',
  paid: '已支付',
  closed: '已关闭',
  payment_review: '已收款 · 待人工核查',
  refunded: '已退款',
  active: '已开通',
  stopped: '已停止',
  error: '部署失败',
};
function online(line: any) {
  return line.heartbeat_at && Date.now() / 1000 - line.heartbeat_at < 120;
}
function relayReady(r: any) {
  return (
    !r.suspended &&
    r.expires_at > Date.now() / 1000 &&
    (!r.traffic_limit_bytes || r.traffic_used_bytes < r.traffic_limit_bytes) &&
    r.reported_state === 'active' &&
    r.reported_revision === r.revision &&
    r.reported_at > Date.now() / 1000 - 120 &&
    online(r)
  );
}

export default function Dashboard() {
  const [data, setData] = useState<any>(null),
    [loading, setLoading] = useState(true),
    [view, setView] = useState('relay'),
    [auth, setAuth] = useState(false),
    [parsed, setParsed] = useState<{
      config: MieruConfig;
      targets: Target[];
    } | null>(null),
    [targetKey, setTargetKey] = useState(''),
    [lineId, setLineId] = useState(''),
    [planId, setPlanId] = useState(''),
    [channel, setChannel] = useState('alipay'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [success, setSuccess] = useState(''),
    [article, setArticle] = useState<any>(null);
  const [showFront, setShowFront] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const saving = useRef(new Set<string>());
  const refresh = useCallback(async () => {
    try {
      const d = await api('bootstrap');
      setData(d);
      if (!d.user) {
        setParsed(null);
        setView('relay');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    refresh();
    const q = new URLSearchParams(location.search).get('view');
    if (q && (q === 'admin' || links.some((l) => l.id === q))) setView(q);
  }, [refresh]);
  useEffect(() => {
    if (!data?.user) return;
    const timer = setInterval(refresh, 20000);
    return () => clearInterval(timer);
  }, [data?.user?.id, refresh]);
  const target = parsed?.targets.find((t) => t.key === targetKey),
    line = data?.lines?.find((l: any) => l.id === lineId),
    plan = data?.plans?.find((p: any) => p.id === planId);
  const user = data?.user,
    settings = data?.settings || {},
    myRelays = data?.relays || [],
    liveRelays = myRelays.filter(
      (r: any) => r.expires_at > Date.now() / 1000 && !r.suspended,
    ),
    activeSubscription = myRelays.find(
      (r: any) => r.expires_at > Date.now() / 1000,
    );
  function navigate(v: string) {
    setView(v);
    setError('');
    setSuccess('');
    window.history.replaceState(null, '', '?view=' + v);
  }
  function importText(text: string) {
    const p = parseConfig(text);
    setParsed(p);
    setTargetKey(
      p.targets.find(
        (t) =>
          p.config.profiles[t.profile].profileName === p.config.activeProfile,
      )?.key || p.targets[0].key,
    );
    setError('');
    setSuccess('原始配置已在浏览器解析；购买后将加密保存转发配置。');
    return {
      targets: p.targets.map((t) => ({
        name: t.name,
        host: t.host,
        port: t.port,
        protocol: t.protocol,
      })),
    };
  }
  async function upload(f?: File) {
    if (!f) return;
    try {
      if (f.size > 131072) throw new Error('配置文件不能超过 128 KB');
      importText(await f.text());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (file.current) file.current.value = '';
    }
  }
  useEffect(() => {
    if (!user || !parsed) return;
    for (const r of myRelays) {
      const t = parsed.targets.find(
        (t) =>
          t.host === r.target_host &&
          t.port === r.target_port &&
          t.protocol === r.protocol,
      );
      if (
        !t ||
        r.expires_at <= Date.now() / 1000 ||
        r.config_saved ||
        r.suspended ||
        saving.current.has(r.id)
      )
        continue;
      saving.current.add(r.id);
      api('relays/config', {
        relay_id: r.id,
        source: JSON.stringify(parsed.config),
      })
        .then(() => refresh())
        .catch((e: Error) => setError('转发配置保存失败：' + e.message))
        .finally(() => saving.current.delete(r.id));
    }
  }, [parsed, data?.relays, user?.id, refresh]);
  useEffect(() => {
    if (!user) return;
    const context = (document as any).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    Promise.resolve(
      context.registerTool(
        {
          name: 'msboost_import_mieru_config',
          title: '导入 MSBOOST 直连配置',
          description:
            '在当前已登录浏览器解析 MSBOOST JSON 并选择节点；不创建订单。已有有效套餐时会自动加密保存转换后的配置。',
          inputSchema: {
            type: 'object',
            properties: { json: { type: 'string', maxLength: 131072 } },
            required: ['json'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: (input: any) => {
            if (
              !input ||
              typeof input.json !== 'string' ||
              Object.keys(input).some((k) => k !== 'json')
            )
              throw new Error('需要有效 JSON 字符串');
            return importText(input.json);
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => {});
    return () => lifecycle.abort();
  }, [user?.id]);
  async function order() {
    if (!user) {
      setAuth(true);
      return;
    }
    if (!plan) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const o = await api('orders', {
        plan_id: plan.id,
        channel,
      });
      await refresh();
      navigate('orders');
      setSuccess(
        o.paid
          ? '套餐已开通，请上传直连配置并绑定节点。'
          : '订单已创建，请在订单列表完成支付。',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function bindTunnel() {
    if (!activeSubscription || !parsed || !target || !line) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      await api('relays/bind', {
        relay_id: activeSubscription.id,
        line_id: line.id,
        source: JSON.stringify(parsed.config),
        target_key: target.key,
      });
      await refresh();
      setSuccess(
        '节点已绑定，旧目标和旧配置已立即失效；线路服务器正在应用新配置。',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function pay(id: string) {
    setBusy(true);
    setError('');
    try {
      const p = await api('orders/pay', { id });
      const form = document.createElement('form');
      form.method = 'POST';
      form.target = '_blank';
      form.action = p.action;
      for (const [k, v] of Object.entries(p.params)) {
        const field = document.createElement('input');
        field.type = 'hidden';
        field.name = k;
        field.value = String(v);
        form.appendChild(field);
      }
      document.body.appendChild(form);
      form.submit();
      form.remove();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function orderAction(action: string, id: string) {
    setBusy(true);
    setError('');
    try {
      const r = await api('orders/' + action, { id });
      await refresh();
      setSuccess(
        action === 'check'
          ? r.status === 'paid'
            ? '支付已确认。'
            : '尚未查到已支付结果，请稍后刷新。'
          : '订单已取消。',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function download(r: any, front = false) {
    try {
      if (!relayReady(r)) throw new Error('转发尚未就绪、已到期或线路状态过期');
      const t = parsed?.targets.find(
        (t) =>
          t.host === r.target_host &&
          t.port === r.target_port &&
          t.protocol === r.protocol,
      );
      if (!r.config_saved && (!parsed || !t)) {
        navigate('relay');
        setError(
          '中转配置尚未保存，请导入对应直连配置生成。付费配置加密保存，到期自动清理。',
        );
        return;
      }
      if (!r.config_saved && parsed)
        await api('relays/config', {
          relay_id: r.id,
          source: JSON.stringify(parsed.config),
        });
      const saved = await api(
        'relays/config/' + r.id + (front ? '?front=1' : ''),
      );
      downloadJson(
        saved,
        front ? `${r.line_name}-前置.json` : `${r.line_name}.json`,
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function logout() {
    try {
      await api('auth/logout', {});
      setData({ user: null, settings, articles: data?.articles || [] });
      setParsed(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (loading)
    return (
      <div className="login-screen">
        <Loading />
      </div>
    );
  if (!user)
    return (
      <main className="login-screen">
        <div className="login-brand">
          <MapleIcon size={32} />
          MSBOOST
        </div>
        <div className="login-card">
          <div className="login-symbol">
            <MapleIcon size={44} />
          </div>
          <h1>登录部署你的专属游戏节点</h1>
          <p className="muted">
            注册前须知：本站仅协助部署节点，需自备服务器再使用本站服务
          </p>
          <Button className="login-cta" onClick={() => setAuth(true)}>
            登录 / 注册
            <ArrowRight size={18} />
          </Button>
          <p className="privacy-line">
            <ShieldCheck size={15} />
            登录后可使用本站所有功能
          </p>
          <Notice text={error} />
          {data && !settings.auth_ready && (
            <p className="setup-hint">
              邮件或注册服务尚未启用，注册暂未开放。已有账号可尝试登录。
            </p>
          )}
          <div className="login-policy">
            {(data?.articles || [])
              .filter((a: any) => ['terms', 'privacy'].includes(a.id))
              .map((a: any) => (
                <button key={a.id} onClick={() => setArticle(a)}>
                  {a.id === 'terms' ? '服务协议' : '隐私政策'}
                </button>
              ))}
          </div>
        </div>
        <p className="login-footer">© {new Date().getFullYear()} MSBOOST</p>
        <AuthDialog
          open={auth}
          onClose={() => setAuth(false)}
          onSuccess={refresh}
          settings={settings}
          articles={data?.articles || []}
        />
        <ArticleDialog article={article} onClose={() => setArticle(null)} />
      </main>
    );
  const title =
    view === 'admin'
      ? '管理后台'
      : links.find((l) => l.id === view)?.label || '隧道中转';
  return (
    <SidebarProvider
      style={{ '--sidebar-width': '15.5rem' } as React.CSSProperties}
    >
      <Sidebar className="brand-sidebar">
        <SidebarHeader>
          <button onClick={() => navigate('relay')} className="brand">
            <span>
              <MapleIcon size={30} />
            </span>
            MSBOOST<b>BETA</b>
          </button>
          <p className="sidebar-sub">GAME NETWORK</p>
        </SidebarHeader>
        <SidebarContent>
          <p className="nav-label">工作空间</p>
          <SidebarMenu>
            {[
              ...links,
              ...(user.role === 'admin'
                ? [{ id: 'admin', icon: Settings2, label: '管理后台' }]
                : []),
            ].map(({ id, icon: Icon, label }) => (
              <SidebarMenuItem key={id}>
                <SidebarMenuButton
                  isActive={view === id}
                  onClick={() => navigate(id)}
                >
                  <Icon size={18} />
                  <span>{label}</span>
                  {view === id && (
                    <ChevronRight className="ml-auto" size={14} />
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarContent>
        <SidebarFooter>
          <div className="sidebar-note">
            <ShieldCheck size={20} />
            <p>
              你的 VPS，你的配置<small>付费配置加密保存，到期清理</small>
            </p>
          </div>
          <div className="domain-label">
            <Globe2 size={14} />
            msboost.de
            <ArrowUpRight className="ml-auto" size={14} />
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="topbar">
          <div>
            <SidebarTrigger />
            <span className="muted">工作空间</span>
            <ChevronRight size={14} />
            <strong>{title}</strong>
          </div>
          <div className="account-menu">
            <span>{user.email}</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="退出登录"
              onClick={logout}
            >
              <LogOut size={17} />
            </Button>
          </div>
        </header>
        <main className="workspace">
          <div className="page-heading">
            <div>
              <p className="eyebrow">YOUR NEXT CONNECTION</p>
              <h1>
                {view === 'relay' ? '让每一次连接，更进一步' : title}
                <span>。</span>
              </h1>
              <p className="muted">
                {view === 'relay'
                  ? '先购买套餐，再上传直连配置建立游戏隧道。'
                  : view === 'orders'
                    ? '管理有效期、订单与配置下载。'
                    : 'MSBOOST · 你的专属线路工作空间'}
              </p>
            </div>
            <button className="pill" onClick={() => navigate('relay')}>
              <Radio size={14} />
              {(data.lines || []).filter(online).length} 条线路在线
            </button>
          </div>
          <Notice text={error} />
          <Notice text={success} ok />
          {view === 'relay' && (
            <>
              <div className="summary-grid">
                <div className="summary">
                  <span>
                    我的转发
                    <Cable size={18} />
                  </span>
                  <strong>
                    {myRelays.filter(relayReady).length}
                    <small>条</small>
                  </strong>
                  <p>已在服务器确认生效</p>
                </div>
                <div className="summary">
                  <span>
                    有效套餐
                    <Wallet size={18} />
                  </span>
                  <strong>
                    {liveRelays.length}
                    <small>条线路</small>
                  </strong>
                  <p>有效期连续计算 · 到期自动停用</p>
                </div>
                <button
                  className="summary accent-summary text-left"
                  onClick={() => navigate('vps')}
                >
                  <span>
                    自有 VPS 部署
                    <Terminal size={18} />
                  </span>
                  <strong>
                    免费
                    <ArrowUpRight size={25} />
                  </strong>
                  <p>重装系统 / 部署 MSBOOST 节点 / 自动校时</p>
                </button>
              </div>
              <div className="work-grid">
                <section className="panel">
                  <div className="panel-heading">
                    <div className="section-number">01</div>
                    <div>
                      <h2>创建转发</h2>
                      <p>从你现有的节点配置开始</p>
                    </div>
                    <FileJson className="ml-auto muted" size={21} />
                  </div>
                  <div className="steps">
                    <span className="current">
                      <b>1</b>导入配置
                    </span>
                    <i />
                    <span className={parsed ? 'current' : ''}>
                      <b>2</b>选择线路
                    </span>
                    <i />
                    <span>
                      <b>3</b>下载使用
                    </span>
                  </div>
                  <input
                    ref={file}
                    type="file"
                    accept=".json,application/json"
                    hidden
                    onChange={(e) => upload(e.target.files?.[0])}
                  />
                  <button
                    className="dropzone"
                    onClick={() => file.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      upload(e.dataTransfer.files[0]);
                    }}
                  >
                    <span className="upload-icon">
                      {parsed ? <Check size={28} /> : <CloudUpload size={28} />}
                    </span>
                    <strong>
                      {parsed ? '配置已识别' : '拖入你的 MSBOOST 直连配置'}
                    </strong>
                    <p>
                      {parsed
                        ? `${parsed.targets.length} 个节点 · 凭据仅在浏览器中解析`
                        : '或点击选择文件，仅支持 .json · 最大 128 KB'}
                    </p>
                    <span className="fake-button">
                      {parsed ? '重新选择' : '选择配置文件'}
                      <ArrowRight size={15} />
                    </span>
                  </button>
                  {parsed && (
                    <div className="selection-block">
                      <h3>选择直连节点</h3>
                      <div className="selection-grid">
                        {parsed.targets.map((t) => (
                          <button
                            type="button"
                            key={t.key}
                            className={`selection-card ${targetKey === t.key ? 'selected' : ''}`}
                            onClick={() => setTargetKey(t.key)}
                          >
                            <b>{t.name}</b>
                            <small>
                              {t.host}:{t.port} · {t.protocol}
                            </small>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="selection-block">
                    <h3>选择中转线路</h3>
                    <div className="selection-grid">
                      {data.lines.map((l: any) => (
                        <button
                          type="button"
                          key={l.id}
                          className={`selection-card ${lineId === l.id ? 'selected' : ''}`}
                          disabled={!online(l)}
                          onClick={() => setLineId(l.id)}
                        >
                          <b>{l.name}</b>
                          <small>
                            {l.region || '优化线路'}
                            {l.requires_front ? ' · 需自备前置机' : ''}
                          </small>
                          <span className={online(l) ? 'good' : ''}>
                            {online(l) ? '在线可用' : '当前离线'}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="privacy-line">
                    <LockKeyhole size={14} />
                    <span>
                      原始文件本地解析；购买后加密保存转发配置，到期自动清理。
                    </span>
                  </div>
                  <div className="panel-divider" />
                  {!activeSubscription ? (
                    <Empty
                      title="请先购买套餐"
                      body="购买有效天数后，才能上传并绑定节点配置。"
                    />
                  ) : (
                    <div className="checkout-row">
                      <span>
                        套餐有效至 {stamp(activeSubscription.expires_at)}
                        <small>更换目标会让旧 IP、旧端口和旧配置立即失效</small>
                      </span>
                      <Button
                        disabled={
                          busy || !parsed || !target || !line || !online(line)
                        }
                        onClick={bindTunnel}
                      >
                        保存并应用隧道 <ArrowRight size={16} />
                      </Button>
                    </div>
                  )}
                  {!activeSubscription && (
                    <Button
                      variant="outline"
                      onClick={() => navigate('orders')}
                    >
                      前往购买套餐
                    </Button>
                  )}
                </section>
                <aside className="right-rail">
                  <section className="panel journey">
                    <div className="subheading">
                      <h3>一份配置，即刻出发</h3>
                      <ArrowUpRight size={18} />
                    </div>
                    {[
                      {
                        icon: Server,
                        title: '你的 VPS',
                        sub: '保留现有 MSBOOST 节点',
                      },
                      {
                        icon: MapleIcon,
                        title: 'MSBOOST 优化线路',
                        sub: '独立端口 · 套餐带宽',
                      },
                      {
                        icon: Download,
                        title: '下载转发配置',
                        sub: '导入兼容客户端使用',
                      },
                    ].map(({ icon: Icon, title, sub }, i) => (
                      <div key={title}>
                        {i > 0 && <div className="journey-link" />}
                        <div
                          className={`journey-row ${i === 1 ? 'featured' : ''}`}
                        >
                          <span>
                            <Icon size={19} />
                          </span>
                          <div>
                            <b>{title}</b>
                            <p>{sub}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </section>
                  <section className="help-card">
                    <Terminal size={23} />
                    <h3>还没有 MSBOOST 节点？</h3>
                    <p>使用 VPS 节点部署，完成安装和 UTC+8 时间同步。</p>
                    <Button variant="outline" onClick={() => navigate('vps')}>
                      打开 VPS 节点部署
                      <ArrowRight size={16} />
                    </Button>
                  </section>
                  <div className="rail-note">
                    <ShieldCheck size={17} />
                    <p>
                      服务限游戏用途。默认屏蔽 GFW
                      名单域名，该名单不等于游戏白名单。
                    </p>
                  </div>
                </aside>
              </div>
            </>
          )}
          {view === 'orders' && (
            <div className="section-stack">
              <section className="panel">
                <div className="subheading">
                  <h2>购买套餐</h2>
                  <span>先购买有效天数，再配置隧道</span>
                </div>
                <div className="selection-block mt-5">
                  <h3>选择套餐时长</h3>
                  <div className="selection-grid plan-selection-grid">
                    {data.plans
                      .filter((p: any) => !(p.trial && user.trial_used))
                      .map((p: any) => (
                        <button
                          type="button"
                          key={p.id}
                          className={`selection-card plan-selection-card ${planId === p.id ? 'selected' : ''}`}
                          onClick={() => setPlanId(p.id)}
                        >
                          <b>{p.name}</b>
                          <strong>{p.days} 天</strong>
                          <small>
                            {p.speed_mbps} Mbps ·{' '}
                            {p.traffic_gb ? `${p.traffic_gb} GB` : '不限流量'}
                          </small>
                          <span>
                            {p.price_cents === 0
                              ? '免费'
                              : money(p.price_cents)}
                          </span>
                        </button>
                      ))}
                  </div>
                </div>
                {plan && plan.price_cents > 0 && (
                  <div className="selection-block mt-5">
                    <h3>选择支付方式</h3>
                    <div className="selection-grid payment-selection-grid">
                      {[
                        ...(settings.epay_alipay ? [['alipay', '支付宝']] : []),
                        ...(settings.epay_wxpay ? [['wxpay', '微信支付']] : []),
                      ].map(([value, label]) => (
                        <button
                          type="button"
                          key={value}
                          className={`selection-card ${channel === value ? 'selected' : ''}`}
                          onClick={() => setChannel(value)}
                        >
                          <b>{label}</b>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="checkout-row">
                  <span>
                    {plan
                      ? `${plan.days} 天 · ${plan.speed_mbps} Mbps · ${plan.traffic_gb ? plan.traffic_gb + ' GB' : '不限流量'}`
                      : '请选择套餐时长'}
                    <small>套餐最长 31 天；新套餐流量覆盖原额度，不叠加</small>
                  </span>
                  <Button disabled={busy || !plan} onClick={order}>
                    {plan?.price_cents === 0 ? '立即领取' : '创建订单'}
                    <ArrowRight size={16} />
                  </Button>
                </div>
              </section>
              <section className="panel">
                <div className="subheading">
                  <h2>我的转发</h2>
                  <Button variant="outline" onClick={() => navigate('relay')}>
                    配置隧道
                  </Button>
                </div>
                {!myRelays.length ? (
                  <Empty
                    title="还没有转发"
                    body="先购买套餐，再上传直连配置建立隧道。"
                  />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {[
                          '线路 / 目标',
                          '转发入口',
                          '有效期（UTC+8）',
                          '状态',
                          '配置',
                        ].map((l) => (
                          <TableHead key={l}>{l}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {myRelays.map((r: any) => (
                        <TableRow key={r.id}>
                          <TableCell>
                            <b>{r.line_name}</b>
                            <small>
                              {r.target_host}:{r.target_port}
                            </small>
                          </TableCell>
                          <TableCell className="mono">
                            {r.relay_host}:{r.listen_port}
                            <small>
                              {r.protocol} · {r.speed_mbps} Mbps ·{' '}
                              {r.traffic_limit_bytes
                                ? `${(r.traffic_used_bytes / 1073741824).toFixed(2)} / ${(r.traffic_limit_bytes / 1073741824).toFixed(0)} GB`
                                : '不限流量'}
                            </small>
                          </TableCell>
                          <TableCell>{stamp(r.expires_at)}</TableCell>
                          <TableCell>
                            {r.traffic_limit_bytes &&
                            r.traffic_used_bytes >= r.traffic_limit_bytes
                              ? '流量已用尽'
                              : r.suspended
                                ? r.target_ip === '0.0.0.0'
                                  ? '等待绑定节点'
                                  : '已暂停'
                                : r.expires_at < Date.now() / 1000
                                  ? '已到期'
                                  : relayReady(r)
                                    ? '转发中'
                                    : stateLabels[r.reported_state] ||
                                      '等待线路确认'}
                            {r.last_error && (
                              <small className="text-red-600">
                                {r.last_error}
                              </small>
                            )}
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={
                                !relayReady(r) || Boolean(r.requires_front)
                              }
                              onClick={() => download(r)}
                            >
                              <Download size={15} />
                              {r.requires_front ? '仅限前置配置' : '下载'}
                            </Button>
                            {r.front_host ? (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={!relayReady(r)}
                                onClick={() => download(r, true)}
                              >
                                前置配置
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={r.expires_at < Date.now() / 1000}
                                onClick={() => navigate('vps')}
                              >
                                自备前置机
                              </Button>
                            )}
                            {r.front_host && (
                              <small>
                                {r.front_host}:{r.front_port} → 本站 → 落地
                              </small>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </section>
              <section className="panel">
                <h2>订单记录</h2>
                {!data.orders.length ? (
                  <Empty
                    title="暂无订单"
                    body="购买记录和付款状态会显示在这里。"
                  />
                ) : (
                  <Table className="mt-4">
                    <TableHeader>
                      <TableRow>
                        {['订单', '套餐', '金额', '状态', '操作'].map((l) => (
                          <TableHead key={l}>{l}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.orders.map((o: any) => (
                        <TableRow key={o.id}>
                          <TableCell>
                            <span className="mono">{o.id.slice(0, 14)}…</span>
                            <small>{stamp(o.created_at)}</small>
                          </TableCell>
                          <TableCell>
                            {o.name}
                            <small>{o.line_name}</small>
                          </TableCell>
                          <TableCell>{money(o.price_cents)}</TableCell>
                          <TableCell>
                            {stateLabels[o.status] || o.status}
                            {o.refund_state && (
                              <small>退款：{o.refund_state}</small>
                            )}
                          </TableCell>
                          <TableCell>
                            {o.status === 'pending' ? (
                              <div className="inline-fields">
                                <Button
                                  size="sm"
                                  disabled={busy}
                                  onClick={() => pay(o.id)}
                                >
                                  去支付
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() => orderAction('check', o.id)}
                                >
                                  查单
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busy}
                                  onClick={() => orderAction('cancel', o.id)}
                                >
                                  取消
                                </Button>
                              </div>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => navigate('tickets')}
                              >
                                联系售后
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </section>
            </div>
          )}
          {view === 'relay' && (
            <div className="section-stack">
              <section className="panel">
                <div className="subheading">
                  <h2>线路状态与实时质量</h2>
                  <span>每 20 秒刷新</span>
                </div>
                <p className="muted">
                  延迟与丢包来自每条线路标注的探测路径，不代表你的设备到游戏的实际质量。无响应或未测量时显示“—”。
                </p>
                {!data.lines.length ? (
                  <Empty
                    title="没有已接入的线路"
                    body="运营方接入线路程序并指定探测目标后，开始显示真实监测值。"
                  />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {[
                          '线路',
                          '状态',
                          '探测路径',
                          'RTT',
                          '丢包',
                          '最近心跳',
                        ].map((l) => (
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
                          <TableCell>
                            <span className={`pill ${online(l) ? 'live' : ''}`}>
                              {online(l) ? '在线' : '离线 / 过期'}
                            </span>
                          </TableCell>
                          <TableCell>{l.probe_label}</TableCell>
                          <TableCell>
                            {online(l) && l.rtt_ms !== null
                              ? l.rtt_ms.toFixed(1) + ' ms'
                              : '—'}
                          </TableCell>
                          <TableCell>
                            {online(l) && l.loss_pct !== null
                              ? l.loss_pct.toFixed(1) + '%'
                              : '—'}
                          </TableCell>
                          <TableCell>{stamp(l.heartbeat_at)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </section>
              <section className="panel">
                <h2>故障与维护公告</h2>
                {data.articles
                  .filter((a: any) => a.kind === 'notice')
                  .map((a: any) => (
                    <button
                      className="article-row w-full text-left"
                      key={a.id}
                      onClick={() => setArticle(a)}
                    >
                      <span>
                        {a.title}
                        <small>{stamp(a.updated_at)}</small>
                      </span>
                      <ChevronRight size={17} />
                    </button>
                  ))}
                {!data.articles.some((a: any) => a.kind === 'notice') && (
                  <p className="muted mt-4">暂无已发布公告</p>
                )}
              </section>
            </div>
          )}
          {view === 'vps' && (
            <VpsTools
              user={user}
              settings={settings}
              relays={myRelays}
              onLogin={() => setAuth(true)}
            />
          )}
          {view === 'relay' && activeSubscription && (
            <section className="panel mt-6">
              <h2>前置入口（可选）</h2>
              <p>
                {activeSubscription.requires_front
                  ? '当前线路要求自备前置机，请完成部署后下载前置配置。'
                  : '所有线路均支持自备前置机，也可以直接使用中转配置。'}
              </p>
              <Button
                variant="outline"
                onClick={() => setShowFront(!showFront)}
              >
                {showFront ? '收起前置机设置' : '配置自备前置机'}
              </Button>
            </section>
          )}
          {view === 'relay' &&
            activeSubscription &&
            (showFront || Boolean(activeSubscription.requires_front)) && (
              <VpsTools
                user={user}
                settings={settings}
                relays={myRelays}
                onLogin={() => setAuth(true)}
                frontOnly
              />
            )}
          {view === 'tickets' && (
            <Support user={user} onLogin={() => setAuth(true)} />
          )}
          {view === 'admin' && user.role === 'admin' && (
            <AdminPanel onRefresh={refresh} />
          )}
          {view === 'guides' && <GuideReader articles={data.articles} />}
          <footer className="page-footer">
            <span>© {new Date().getFullYear()} MSBOOST</span>
            <div>
              {['terms', 'privacy', 'refund', 'aup'].map((id) => (
                <button
                  key={id}
                  onClick={() =>
                    setArticle(data.articles.find((a: any) => a.id === id))
                  }
                >
                  {
                    (
                      {
                        terms: '服务协议',
                        privacy: '隐私政策',
                        refund: '退款规则',
                        aup: '使用政策',
                      } as any
                    )[id]
                  }
                </button>
              ))}
            </div>
            <span>北京时间 UTC+8</span>
          </footer>
        </main>
      </SidebarInset>
      <ArticleDialog article={article} onClose={() => setArticle(null)} />
    </SidebarProvider>
  );
}
function ArticleDialog({
  article,
  onClose,
}: {
  article: any;
  onClose: () => void;
}) {
  return (
    <Dialog open={Boolean(article)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="article-dialog">
        <DialogHeader>
          <DialogTitle>{article?.title}</DialogTitle>
          <DialogDescription>MSBOOST 服务信息</DialogDescription>
        </DialogHeader>
        <div className="prose article-body">
          <Markdown body={article?.body || ''} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
