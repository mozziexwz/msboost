'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from '@/components/ui/input-otp';
import { AlertCircle, LoaderCircle, ShieldCheck } from 'lucide-react';
export async function api(path: string, body?: unknown): Promise<any> {
  const r = await fetch('/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: any;
  try {
    data = await r.json();
  } catch {
    throw new Error('服务响应无效，请稍后重试');
  }
  if (!r.ok) throw new Error(data.error || '操作失败');
  return data;
}
export function stamp(n?: number | null) {
  return n
    ? new Date(n * 1000).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
      })
    : '—';
}
export function money(c: number) {
  return '¥' + (c / 100).toFixed(2);
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Picker({
  value,
  onChange,
  options,
  placeholder = '请选择',
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  return (
    <Select value={value || null} onValueChange={(v) => onChange(v ?? '')}>
      <SelectTrigger className="w-full h-10">
        <SelectValue placeholder={placeholder}>
          {options.find((o) => o.value === value)?.label}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export function Notice({
  text: message,
  ok = false,
}: {
  text: string;
  ok?: boolean;
}) {
  return message ? (
    <div
      role={ok ? 'status' : 'alert'}
      className={ok ? 'form-success' : 'form-error'}
    >
      {message}
    </div>
  ) : null;
}
export function Loading() {
  return (
    <p className="loading">
      <LoaderCircle size={18} className="animate-spin" />
      正在加载…
    </p>
  );
}
export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-lines">
      <AlertCircle size={22} />
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
    </div>
  );
}
declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      remove: (id: string) => void;
    };
  }
}
export function Captcha({
  siteKey,
  action,
  onToken,
  reset,
}: {
  siteKey: string;
  action: string;
  onToken: (v: string) => void;
  reset: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onToken);
  cb.current = onToken;
  useEffect(() => {
    if (!siteKey) return;
    let widget: string | undefined,
      stopped = false;
    function mount() {
      if (!stopped && ref.current && window.turnstile && !widget)
        widget = window.turnstile.render(ref.current, {
          sitekey: siteKey,
          action,
          theme: 'light',
          callback: (v: string) => cb.current(v),
          'expired-callback': () => cb.current(''),
          'error-callback': () => cb.current(''),
        });
    }
    let script = document.querySelector<HTMLScriptElement>(
      'script[data-turnstile]',
    );
    if (!script) {
      script = document.createElement('script');
      script.src =
        'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.dataset.turnstile = 'true';
      document.head.appendChild(script);
    }
    script.addEventListener('load', mount);
    mount();
    return () => {
      stopped = true;
      script?.removeEventListener('load', mount);
      if (widget && window.turnstile) window.turnstile.remove(widget);
    };
  }, [siteKey, action, reset]);
  return siteKey ? (
    <div className="captcha" ref={ref} />
  ) : (
    <p className="setup-hint">
      <ShieldCheck size={16} />
      管理员尚未配置 Turnstile 验证
    </p>
  );
}
export function AuthDialog({
  open,
  onClose,
  onSuccess,
  settings,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  settings: any;
}) {
  const [mode, setMode] = useState<'login' | 'register' | 'reset'>('login'),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [code, setCode] = useState(''),
    [invite, setInvite] = useState(''),
    [agreed, setAgreed] = useState(false),
    [token, setToken] = useState(''),
    [action, setAction] = useState('login'),
    [reset, setReset] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [success, setSuccess] = useState(''),
    [count, setCount] = useState(0);
  useEffect(() => {
    if (!count) return;
    const t = setTimeout(() => setCount(count - 1), 1000);
    return () => clearTimeout(t);
  }, [count]);
  function switchMode(m: typeof mode) {
    setMode(m);
    setAction(m);
    setToken('');
    setReset((x) => x + 1);
    setError('');
    setSuccess('');
  }
  async function send() {
    if (action !== 'email') {
      setAction('email');
      setToken('');
      setError('请完成下方邮箱发送验证，再次点击发送验证码。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const r = await api('auth/code', {
        email,
        purpose: mode === 'reset' ? 'reset' : 'register',
        token,
      });
      setSuccess(r.message);
      setCount(60);
      setAction(mode);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setToken('');
      setReset((x) => x + 1);
    }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (action !== mode) {
      setAction(mode);
      setToken('');
      setError('请完成下方验证后继续。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('auth/' + mode, {
        email,
        password,
        code,
        invite,
        agreed,
        token,
      });
      setPassword('');
      if (mode === 'reset') {
        switchMode('login');
        setSuccess('密码已修改，请登录。');
      } else {
        onSuccess();
        onClose();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setToken('');
      setReset((x) => x + 1);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setPassword('');
          onClose();
        }
      }}
    >
      <DialogContent className="auth-dialog">
        <DialogHeader>
          <DialogTitle>
            {mode === 'login'
              ? '欢迎回到 MSBOOST'
              : mode === 'register'
                ? '创建你的账号'
                : '重置登录密码'}
          </DialogTitle>
          <DialogDescription>
            仅支持 QQ 邮箱
            {mode === 'register' && settings.invite_required
              ? ' · 当前需邀请码'
              : ''}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="form-stack">
          <Field label="QQ 邮箱">
            <Input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="yourname@qq.com"
              required
            />
          </Field>
          <Field
            label={mode === 'reset' ? '新密码' : '登录密码'}
            hint="10–128 位，建议包含字母、数字和符号"
          >
            <Input
              type="password"
              autoComplete={
                mode === 'login' ? 'current-password' : 'new-password'
              }
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={10}
              maxLength={128}
              required
            />
          </Field>
          {mode !== 'login' && (
            <>
              <Field label="邮箱验证码">
                <div className="inline-fields">
                  <InputOTP
                    value={code}
                    onChange={setCode}
                    maxLength={6}
                    pattern="^[0-9]*$"
                  >
                    <InputOTPGroup>
                      {Array.from({ length: 6 }, (_, i) => (
                        <InputOTPSlot key={i} index={i} />
                      ))}
                    </InputOTPGroup>
                  </InputOTP>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || count > 0 || !email}
                    onClick={send}
                  >
                    {count ? `${count}s` : '发送验证码'}
                  </Button>
                </div>
              </Field>
              {mode === 'register' && settings.invite_required && (
                <Field label="邀请码">
                  <Input
                    value={invite}
                    onChange={(e) => setInvite(e.target.value)}
                    placeholder="MS-…"
                  />
                </Field>
              )}
            </>
          )}
          {mode === 'register' && (
            <label className="check-line">
              <Checkbox
                checked={agreed}
                onCheckedChange={(v) => setAgreed(Boolean(v))}
              />
              我已阅读并同意服务协议及隐私政策
            </label>
          )}
          <Captcha
            siteKey={settings.turnstile_site_key || ''}
            action={action}
            onToken={setToken}
            reset={reset}
          />
          <Notice text={error} />
          <Notice text={success} ok />
          <Button className="w-full" type="submit" disabled={busy || !token}>
            {busy ? <LoaderCircle className="animate-spin" size={16} /> : null}
            {mode === 'login'
              ? '登录'
              : mode === 'register'
                ? '验证并注册'
                : '修改密码'}
          </Button>
        </form>
        <div className="auth-links">
          <button
            onClick={() =>
              switchMode(mode === 'register' ? 'login' : 'register')
            }
          >
            {mode === 'register' ? '已有账号，去登录' : '邀请码注册'}
          </button>
          <button
            onClick={() => switchMode(mode === 'reset' ? 'login' : 'reset')}
          >
            {mode === 'reset' ? '返回登录' : '忘记密码'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
