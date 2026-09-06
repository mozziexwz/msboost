'use client';
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Download, Fingerprint, LoaderCircle, Terminal } from 'lucide-react';
import { downloadJson } from '@/lib/mieru';
import { api, Empty, Field, Notice, Picker } from './widgets';
export default function VpsTools({
  user,
  settings,
  relays,
  onLogin,
}: {
  user: any;
  settings: any;
  relays: any[];
  onLogin: () => void;
}) {
  const [kind, setKind] = useState('install'),
    [ip, setIp] = useState(''),
    [port, setPort] = useState(22),
    [username, setUsername] = useState('root'),
    [password, setPassword] = useState(''),
    [fingerprint, setFingerprint] = useState(''),
    [fingerprintConfirmed, setFingerprintConfirmed] = useState(false),
    [newPort, setNewPort] = useState(0),
    [confirm, setConfirm] = useState(''),
    [dialog, setDialog] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [job, setJob] = useState<any>(null),
    [jobId, setJobId] = useState('');
  const [relayId, setRelayId] = useState(''),
    [frontPort, setFrontPort] = useState(31000);
  useEffect(() => {
    setNewPort(20000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 40000));
  }, []);
  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    async function poll() {
      try {
        const result = await api('vps/jobs/' + jobId);
        if (!stop) setJob(result);
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    }
    poll();
    const timer = setInterval(poll, 5000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [jobId]);
  useEffect(() => {
    setFingerprint('');
    setFingerprintConfirmed(false);
  }, [ip, port]);
  async function probe() {
    setBusy(true);
    setError('');
    try {
      const r = await api('vps/probe', { ip, ssh_port: port });
      setFingerprint(r.fingerprint);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function run() {
    setBusy(true);
    setError('');
    try {
      const r = await api('vps/jobs', {
        kind,
        ip,
        ssh_port: port,
        username,
        password,
        fingerprint,
        new_ssh_port: newPort,
        confirm,
        relay_id: relayId,
        front_port: frontPort,
      });
      setJobId(r.id);
      setDialog(false);
      setPassword('');
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
          title="登录后免费使用 VPS 工具"
          body="支持在你自己的 Debian/Ubuntu VPS 上部署 Mieru，或重装为 Debian 12。"
        />
        <Button onClick={onLogin} className="mt-5">
          登录 / 注册
        </Button>
      </section>
    );
  return (
    <div className="work-grid">
      <section className="panel">
        <div className="panel-heading">
          <Terminal size={22} />
          <div>
            <h2>自有 VPS 工具</h2>
            <p>一次性部署 · SSH 凭据仅在任务运行时处理</p>
          </div>
          <span className="pill live ml-auto">免费</span>
        </div>
        <Tabs
          value={kind}
          onValueChange={(v) => setKind(String(v))}
          className="mt-6"
        >
          <TabsList>
            <TabsTrigger value="install">部署 Mieru</TabsTrigger>
            <TabsTrigger value="dd">DD 系统</TabsTrigger>
            <TabsTrigger value="front">自备前置机</TabsTrigger>
          </TabsList>
        </Tabs>
        {kind === 'front' && (
          <div className="front-chain">
            <strong>客户前置 VPS → MSBOOST 中转 → 客户落地 VPS</strong>
            <p>
              在自备入口 VPS
              安装转发服务，指向已购买的本站端口。套餐到期后，本站中转自动断流。
            </p>
            <div className="form-grid">
              <Field label="已购买的转发线路">
                <Picker
                  value={relayId}
                  onChange={setRelayId}
                  options={relays
                    .filter(
                      (r) => r.expires_at > Date.now() / 1000 && !r.suspended,
                    )
                    .map((r) => ({
                      value: r.id,
                      label: `${r.line_name} → ${r.target_host}:${r.target_port}`,
                    }))}
                />
              </Field>
              <Field label="前置监听端口">
                <Input
                  type="number"
                  min={1024}
                  max={65535}
                  value={frontPort}
                  onChange={(e) => setFrontPort(Number(e.target.value))}
                />
              </Field>
            </div>
          </div>
        )}
        <div className="form-grid mt-6">
          <Field label={kind === 'front' ? '前置 VPS 公网 IP' : 'VPS 公网 IP'}>
            <Input
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="你的服务器 IP"
            />
          </Field>
          <Field label="SSH 端口">
            <Input
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
            />
          </Field>
          <Field label="SSH 用户名">
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field label="SSH 密码">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
            />
          </Field>
        </div>
        {kind === 'dd' && (
          <div className="dd-warning">
            <strong>Debian 12 · 重装将清除系统及数据</strong>
            <p>
              新 SSH 用户为
              root，密码沿用本次提交的密码。请先备份，并确认可以使用云厂商救援控制台。
            </p>
            <Field label="重装后的随机 SSH 端口">
              <Input
                type="number"
                value={newPort}
                onChange={(e) => setNewPort(Number(e.target.value))}
              />
            </Field>
          </div>
        )}
        <div className="fingerprint">
          <Button
            variant="outline"
            disabled={busy || !ip || !settings.worker_ready}
            onClick={probe}
          >
            <Fingerprint size={16} />
            检查主机指纹
          </Button>
          {fingerprint && (
            <>
              <code>{fingerprint}</code>
              <label className="check-line">
                <Checkbox
                  checked={fingerprintConfirmed}
                  onCheckedChange={(v) => setFingerprintConfirmed(Boolean(v))}
                />
                我已核对这是我的服务器指纹
              </label>
            </>
          )}
        </div>
        <Notice text={error} />
        {!settings.worker_ready && (
          <Notice text="管理员尚未接入一次性执行服务器，暂不能发起部署。" />
        )}
        <Button
          disabled={
            busy ||
            !password ||
            !fingerprintConfirmed ||
            (kind === 'front' && !relayId) ||
            !settings.worker_ready
          }
          onClick={() => {
            setConfirm('');
            setDialog(true);
          }}
        >
          {' '}
          {busy ? (
            <LoaderCircle className="animate-spin" size={16} />
          ) : (
            <Terminal size={16} />
          )}{' '}
          {kind === 'install'
            ? '开始部署 Mieru'
            : kind === 'front'
              ? '部署前置转发'
              : '准备重装 Debian 12'}
        </Button>
        {job && (
          <div className="job-box">
            <div className="subheading">
              <h3>部署进度</h3>
              <span>{job.state}</span>
            </div>
            {job.events?.map((e: string, i: number) => (
              <p key={i}>{e}</p>
            ))}
            {job.error && <Notice text={job.error} />}
            {job.fingerprint && (
              <p>
                重装后的 SSH 指纹（请先与云控制台核对）：
                <code>{job.fingerprint}</code>
              </p>
            )}
            {kind === 'front' && job.state === 'completed' && (
              <Notice
                ok
                text="前置转发已部署。回到套餐与订单页，选择“前置配置”下载使用。"
              />
            )}
            {job.new_ssh_port && (
              <p>
                新 SSH 端口：<strong>{job.new_ssh_port}</strong>
              </p>
            )}
            {job.config && (
              <Button
                onClick={() =>
                  downloadJson(job.config, 'msboost-original-mieru.json')
                }
              >
                <Download size={16} />
                下载原始 Mieru 配置
              </Button>
            )}
            <small>配置结果仅临时保留 30 分钟，请及时下载。</small>
          </div>
        )}
      </section>
      <aside className="right-rail">
        <section className="panel prose">
          <h3>部署包含</h3>
          <p>安装 Mihomo 的 Mieru 入站，生成独立节点账号与随机 TCP 端口。</p>
          <p>
            加载 GFW 域名屏蔽规则。安装 chrony、tzdata，设置 UTC+8
            并等待校时成功。
          </p>
          <p>
            服务使用专属的 msboost-mieru 名称。完成后关闭 SSH 会话，客户 VPS
            不安装管理 Agent。
          </p>
        </section>
        <section className="help-card">
          <h3>公网可达性</h3>
          <p>
            需要放行新 Mieru 端口。云安全组不受 SSH
            内的防火墙命令控制，部署完成后仍需确认云厂商侧规则。
          </p>
        </section>
      </aside>
      <AlertDialog open={dialog} onOpenChange={setDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {kind === 'dd' ? '确认清除并重装此 VPS' : '确认部署到此 VPS'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {kind === 'dd'
                ? '此操作会清除系统数据。'
                : kind === 'front'
                  ? '将安装独立的前置转发服务并配置系统时间。'
                  : '将安装 Mieru 业务服务并配置系统时间。'}
              请再次输入目标 IP：{ip}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={ip}
          />
          <Notice text={error} />
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <Button
              variant={kind === 'dd' ? 'destructive' : 'default'}
              disabled={confirm !== ip || busy}
              onClick={run}
            >
              {busy ? '正在提交…' : '确认执行'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
