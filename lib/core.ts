import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
export const DAY = 86400;
export function now() {
  return Math.floor(Date.now() / 1000);
}
export function id() {
  return crypto.randomUUID().replaceAll('-', '');
}
export function assert(
  condition: unknown,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new HttpError(message, status);
}
export class HttpError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
export function cents(value: string) {
  assert(/^\d{1,8}(\.\d{1,2})?$/.test(value), '金额格式无效');
  const [a, b = ''] = value.split('.');
  return Number(a) * 100 + Number(b.padEnd(2, '0'));
}
export function epaySign(params: Record<string, string>, key: string) {
  const text =
    Object.keys(params)
      .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '')
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&') + key;
  return createHash('md5').update(text, 'utf8').digest('hex');
}
export function equal(a: string, b: string) {
  let n = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    n |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return n === 0;
}
export function publicIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (kind === 6) {
    const h = ip.toLowerCase();
    return (
      /^[23]/.test(h) &&
      !h.startsWith('2001:db8:') &&
      !h.startsWith('2002:') &&
      !h.startsWith('2001:0:')
    );
  }
  return false;
}
export function normalizeEmail(value: unknown) {
  assert(typeof value === 'string' && value.length <= 254, '邮箱格式无效');
  const email = value.trim().toLowerCase();
  assert(/^[a-z0-9][a-z0-9._+-]*@qq\.com$/.test(email), '仅支持 @qq.com 邮箱');
  return email;
}
export function durationGate(expiresAt: number, t = now()) {
  return expiresAt - t > 30 * DAY;
}
export function apiParams(search: URLSearchParams) {
  const out: Record<string, string> = {};
  for (const [k, v] of search) {
    assert(!(k in out), '重复的支付参数');
    assert(/^[a-z_]+$/.test(k) && v.length < 2048, '支付参数无效');
    out[k] = v;
  }
  return out;
}
