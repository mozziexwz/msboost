'use client';
import { useState } from 'react';
import { Download, Upload, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Field, Notice, api } from './widgets';

const enc = new TextEncoder(),
  dec = new TextDecoder();
function buffer(bytes: Uint8Array) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
function b64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 32768)
    s += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(s);
}
function unb64(s: string) {
  const raw = atob(s),
    out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
async function key(pass: string, salt: Uint8Array, usage: KeyUsage[]) {
  const base = await crypto.subtle.importKey(
    'raw',
    enc.encode(pass),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: buffer(salt), iterations: 310000 },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    usage,
  );
}
async function seal(data: unknown, pass: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: buffer(iv),
      additionalData: enc.encode('MSBOOST-BACKUP-v1'),
    },
    await key(pass, salt, ['encrypt']),
    enc.encode(JSON.stringify(data)),
  );
  return JSON.stringify({
    magic: 'MSBOOST-BACKUP',
    version: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: 310000,
    salt: b64(salt),
    iv: b64(iv),
    ciphertext: b64(new Uint8Array(ciphertext)),
  });
}
async function openBackup(text: string, pass: string) {
  const box = JSON.parse(text);
  if (
    box.magic !== 'MSBOOST-BACKUP' ||
    box.version !== 1 ||
    box.iterations !== 310000
  )
    throw new Error('不是受支持的 MSBOOST 加密备份');
  const clear = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: buffer(unb64(box.iv)),
      additionalData: enc.encode('MSBOOST-BACKUP-v1'),
    },
    await key(pass, unb64(box.salt), ['decrypt']),
    buffer(unb64(box.ciphertext)),
  );
  return JSON.parse(dec.decode(clear));
}
export default function BackupCenter() {
  const [pass, setPass] = useState(''),
    [file, setFile] = useState<File | null>(null),
    [parsed, setParsed] = useState<any>(null),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [success, setSuccess] = useState('');
  async function download() {
    setBusy(true);
    setError('');
    try {
      if (pass.length < 12) throw new Error('备份口令至少 12 位');
      const data = await api('admin/backup');
      const blob = new Blob([await seal(data, pass)], {
          type: 'application/vnd.msboost.backup+json',
        }),
        a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `msboost-backup-${new Date().toISOString().slice(0, 10)}.msb`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      setSuccess('加密备份已下载。请把文件和口令分开保管。');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function inspect() {
    setBusy(true);
    setError('');
    setParsed(null);
    try {
      if (!file) throw new Error('请选择备份文件');
      if (file.size > 8 * 1024 * 1024) throw new Error('备份文件不能超过 8 MB');
      if (pass.length < 12) throw new Error('请输入创建备份时的口令');
      const data = await openBackup(await file.text(), pass);
      setParsed(data);
      setConfirm(true);
    } catch (e) {
      setError(
        e instanceof DOMException
          ? '口令错误或备份文件已损坏'
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }
  async function restore() {
    setBusy(true);
    setError('');
    try {
      const r = await api('admin/backup/restore', parsed);
      setSuccess(r.message);
      setConfirm(false);
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      setError((e as Error).message);
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="form-stack mt-6">
      <div className="settings-section">
        <h3>加密备份</h3>
        <p className="muted">
          备份站点设置、用户与工单、线路和转发、订单及财务记录。备份文件用本机口令加密，本站不保存口令。
        </p>
        <Field label="备份口令" hint="至少 12 位；丢失后无法恢复">
          <Input
            type="password"
            autoComplete="new-password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
        </Field>
        <Button onClick={download} disabled={busy || pass.length < 12}>
          {busy ? (
            <LoaderCircle className="animate-spin" size={16} />
          ) : (
            <Download size={16} />
          )}
          一键下载备份
        </Button>
      </div>
      <div className="settings-section">
        <h3>上传并恢复</h3>
        <p className="muted">
          恢复会整体替换当前业务数据并注销所有会话。不会恢复验证码、封禁记录或已从对象存储删除的配置文件内容。
        </p>
        <Input
          type="file"
          accept=".msb,application/json"
          onChange={(e) => {
            setFile(e.target.files?.[0] || null);
            setParsed(null);
          }}
        />
        <Button
          variant="outline"
          onClick={inspect}
          disabled={busy || !file || pass.length < 12}
        >
          <Upload size={16} />
          校验备份并准备恢复
        </Button>
      </div>
      <Notice text={error} />
      <Notice text={success} ok />
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认覆盖全部业务数据？</AlertDialogTitle>
            <AlertDialogDescription>
              备份时间：
              {parsed?.created_at
                ? new Date(parsed.created_at * 1000).toLocaleString('zh-CN')
                : '未知'}
              。恢复成功后需重新登录；中转将在下次心跳按恢复后的规则运行。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={restore}>确认恢复</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
