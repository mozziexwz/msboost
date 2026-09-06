import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseConfig, rewriteConfig } from '../lib/mieru.ts';
import {
  apiParams,
  cents,
  DAY,
  durationGate,
  epaySign,
  normalizeEmail,
  publicIp,
} from '../lib/core.ts';
const sample = {
  profiles: [
    {
      profileName: 'home',
      user: { name: 'test', password: 'sample-secret-not-real' },
      servers: [
        {
          ipAddress: '8.8.8.8',
          domainName: '',
          portBindings: [{ port: 45001, protocol: 'TCP' }],
        },
        { ipAddress: '1.1.1.1', portBindings: [{ port: 99, protocol: 'TCP' }] },
      ],
      mtu: 1400,
    },
    {
      profileName: 'unused',
      user: { name: 'two', password: 'other-sample' },
      servers: [
        { ipAddress: '9.9.9.9', portBindings: [{ port: 45, protocol: 'UDP' }] },
      ],
    },
  ],
  activeProfile: 'home',
  socks5Port: 1080,
};
test('rewrite preserves credentials and client fields, removes direct fallback profiles and servers', () => {
  const p = parseConfig(JSON.stringify(sample)),
    before = structuredClone(p.config),
    r = rewriteConfig(p.config, p.targets[0], {
      host: 'line.msboost.de',
      port: 31000,
      name: '线路1',
    });
  assert.deepEqual(p.config, before);
  assert.equal(r.profiles.length, 1);
  assert.equal(r.profiles[0].servers.length, 1);
  assert.equal(r.profiles[0].user.password, 'sample-secret-not-real');
  assert.equal(r.profiles[0].servers[0].domainName, 'line.msboost.de');
  assert.equal(r.profiles[0].servers[0].ipAddress, '');
  assert.equal(r.socks5Port, 6666);
  assert.equal(r.profiles[0].servers[0].portBindings[0].protocol, 'TCP');
});
test('IPv6 relay is stored as an address rather than domain', () => {
  const p = parseConfig(JSON.stringify(sample)),
    r = rewriteConfig(p.config, p.targets[2], {
      host: '2606:4700:4700::1111',
      port: 31000,
      name: 'UDP',
    });
  assert.equal(r.profiles[0].servers[0].ipAddress, '2606:4700:4700::1111');
  assert.equal(r.profiles[0].servers[0].portBindings[0].protocol, 'UDP');
});
test('malformed JSON, invalid port ranges, oversized configs and mismatched targets fail explicitly', () => {
  assert.throws(() => parseConfig('[]'));
  assert.throws(() => parseConfig('{'));
  assert.throws(() => parseConfig(' '.repeat(131073)));
  const invalid = structuredClone(sample);
  (invalid.profiles[0].servers[0].portBindings[0] as any).portRange = '1-999';
  assert.throws(() => parseConfig(JSON.stringify(invalid)));
  const p = parseConfig(JSON.stringify(sample));
  assert.throws(() =>
    rewriteConfig(
      p.config,
      { ...p.targets[0], host: '1.1.1.1' },
      { host: 'relay.test', port: 10, name: 'x' },
    ),
  );
});
test('blocked private/special network destinations, including IPv4-mapped IPv6', () => {
  for (const ip of [
    '127.0.0.1',
    '0.0.0.0',
    '10.1.1.1',
    '172.16.1.1',
    '192.168.2.1',
    '169.254.169.254',
    '100.64.0.1',
    '224.1.1.1',
    '198.18.0.1',
    '192.0.2.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
  ])
    assert.equal(publicIp(ip), false, ip);
  assert.equal(publicIp('8.8.8.8'), true);
  assert.equal(publicIp('2606:4700:4700::1111'), true);
});
test('QQ aliases are supported but lookalike domains rejected', () => {
  assert.equal(normalizeEmail(' Example@qq.com '), 'example@qq.com');
  for (const e of [
    'a@qq.com.attacker.com',
    'a@foxmail.com',
    'a@qQ.com.evil',
    'a\r\nb@qq.com',
  ])
    assert.throws(() => normalizeEmail(e));
});
test('amount validation does not use floating point money arithmetic', () => {
  assert.equal(cents('12.01'), 1201);
  assert.equal(cents('0.1'), 10);
  for (const value of ['-1', '1.000', '1e2', 'Infinity', ' 1'])
    assert.throws(() => cents(value));
});
test('Epay signs decoded values, retains zero, excludes empty values and signature fields', () => {
  const p = { z: '0', a: '值&=', empty: '', sign: 'ignored', sign_type: 'MD5' };
  const expected = createHash('md5').update('a=值&=&z=0secret').digest('hex');
  assert.equal(epaySign(p, 'secret'), expected);
  assert.throws(() => apiParams(new URLSearchParams('pid=1&pid=2')));
});
test('30-day rule rejects strictly greater remaining time, not exactly 30 days', () => {
  assert.equal(durationGate(30 * DAY + 100, 100), false);
  assert.equal(durationGate(30 * DAY + 101, 100), true);
  assert.equal(durationGate(99, 100), false);
});
