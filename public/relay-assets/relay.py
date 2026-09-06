#!/usr/bin/env python3
"""MSBOOST operator-side GOST supervisor. Never runs on customer landing VPSes."""
from __future__ import annotations
import hashlib
import ipaddress
import json
import os
import re
import signal
import socket
import statistics
import subprocess
import threading
import time
import urllib.request
from pathlib import Path

def valid_ip(value):
    try:
        address = ipaddress.ip_address(value)
        return address.is_global and not address.is_multicast
    except ValueError:
        return False

def endpoint(host, port):
    return f"[{host}]:{port}" if ':' in host else f"{host}:{port}"

def gost_config(rule, metrics_port=None):
    if not re.fullmatch(r'[a-f0-9]{32}', str(rule['id'])) or not valid_ip(rule['target_ip']):
        raise ValueError('invalid relay destination')
    for key in ('listen_port', 'target_port'):
        if not isinstance(rule[key], int) or not 1024 <= rule[key] <= 65535 and key == 'listen_port' or key == 'target_port' and not 1 <= rule[key] <= 65535:
            raise ValueError('invalid port')
    if rule['protocol'] not in ('TCP', 'UDP') or not 1 <= rule['speed_mbps'] <= 10000:
        raise ValueError('invalid protocol or speed')
    source_ip = rule.get('source_ip')
    if source_ip is not None and not valid_ip(source_ip):
        raise ValueError('invalid source admission')
    protocol = rule['protocol'].lower()
    rate = int(rule['speed_mbps'] * 1000000 / 8)
    listener = {'type': protocol}
    if protocol == 'udp':
        listener['metadata'] = {'keepAlive': True, 'ttl': '60s', 'readBufferSize': 65535}
    config = {
        'log': {'level': 'error'},
        'services': [{'name': 'msboost-' + rule['id'], 'addr': ':' + str(rule['listen_port']),
                      'handler': {'type': protocol}, 'listener': listener, 'limiter': 'paid',
                      'forwarder': {'nodes': [{'name': 'landing', 'addr': endpoint(rule['target_ip'], rule['target_port'])}]}}],
        # $ is the aggregate service budget, $$ would be per connection.
        'limiters': [{'name': 'paid', 'limits': [f'$ {rate}B {rate}B']}]}
    if metrics_port:
        config['metrics'] = {'addr': f'127.0.0.1:{metrics_port}', 'path': '/metrics'}
    if source_ip:
        config['services'][0]['admission'] = 'front-only'
        config['admissions'] = [{'name': 'front-only', 'whitelist': True, 'matchers': [source_ip]}]
    return config

def fingerprint_config(rule):
    return hashlib.sha256(json.dumps(gost_config(rule), sort_keys=True).encode()).hexdigest()

def remaining_seconds(rule, server_time, lease_until, elapsed=0):
    return max(0, min(rule['expires_at'], lease_until) - server_time - elapsed)

class Supervisor:
    def __init__(self, binary, folder, max_relays=200):
        self.binary, self.folder, self.max_relays = binary, Path(folder), max_relays
        self.folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.running, self.reports = {}, {}
        self.usage_path = self.folder / 'traffic.json'
        try:
            self.usage = json.loads(self.usage_path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            self.usage = {}
        self.lock = threading.RLock()

    def save_usage(self):
        temp = self.folder / 'traffic.tmp'
        temp.write_text(json.dumps(self.usage), encoding='utf-8')
        os.chmod(temp, 0o600)
        temp.replace(self.usage_path)

    def traffic(self, key, item):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{item['metrics_port']}/metrics", timeout=2) as response:
                body = response.read(1024 * 1024).decode()
            raw = sum(int(float(v)) for v in re.findall(r'^gost_service_transfer_(?:input|output)_bytes_total\{[^}]*\}\s+([\d.eE+-]+)$', body, re.M))
            saved = self.usage.setdefault(key, {'revision': item['revision'], 'total': 0, 'last': 0})
            if saved.get('revision') != item['revision']:
                saved.update(revision=item['revision'], total=0, last=0)
            saved['total'] += max(0, raw - saved.get('last', 0))
            saved['last'] = raw
            self.save_usage()
            return saved['total']
        except (OSError, ValueError, KeyError):
            return int(self.usage.get(key, {}).get('total', 0))

    def stop(self, key, state='stopped', error=''):
        with self.lock:
            item = self.running.pop(key, None)
            if item:
                # Kill only the specific child created by this supervisor.
                # Closing listeners alone does not terminate existing TCP streams.
                item['process'].kill() if item['process'].poll() is None else None
                try:
                    item['process'].wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
                self.reports[key] = {'id': key, 'revision': item['revision'], 'state': state, 'error': error}
                item['file'].unlink(missing_ok=True)

    def expire(self):
        with self.lock:
            for key, item in list(self.running.items()):
                if time.monotonic() >= item['deadline'] or time.time() >= item['expires_at']:
                    self.stop(key)
                elif item['process'].poll() is not None:
                    self.stop(key, 'error', 'GOST 进程退出；检查端口是否被占用及二进制版本')

    def reconcile(self, response, elapsed=0):
        server_time = response['server_time']
        if abs(time.time() - server_time) > 120 or response['lease_until'] > server_time + 180:
            raise ValueError('clock skew or invalid lease')
        desired = response['relays']
        if len(desired) > self.max_relays:
            raise ValueError('node process capacity exceeded')
        with self.lock:
            desired_ids = {r['id'] for r in desired}
            for key in list(self.running):
                if key not in desired_ids:
                    self.stop(key)
            for rule in desired:
                key = rule['id']
                try:
                    config_hash = fingerprint_config(rule)
                    remaining = remaining_seconds(rule, server_time, response['lease_until'], elapsed)
                    if remaining <= 0:
                        self.stop(key)
                        continue
                    old = self.running.get(key)
                    if old and old['hash'] != config_hash:
                        self.stop(key)
                        old = None
                    if old:
                        old.update(deadline=time.monotonic() + remaining, expires_at=rule['expires_at'], revision=rule['revision'])
                    else:
                        path = self.folder / (key + '.json')
                        with socket.socket() as probe:
                            probe.bind(('127.0.0.1', 0))
                            metrics_port = probe.getsockname()[1]
                        path.write_text(json.dumps(gost_config(rule, metrics_port)), encoding='utf-8')
                        os.chmod(path, 0o600)
                        process = subprocess.Popen([self.binary, '-C', str(path)], stdin=subprocess.DEVNULL,
                                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        self.running[key] = {'process': process, 'file': path, 'hash': config_hash,
                                             'deadline': time.monotonic() + remaining,
                                             'expires_at': rule['expires_at'], 'revision': rule['revision'],
                                             'metrics_port': metrics_port}
                except (ValueError, KeyError, OSError, TypeError):
                    self.stop(key, 'error', '无效的转发配置或进程启动失败')
                    self.reports[key] = {'id': key, 'revision': rule.get('revision', 0), 'state': 'error', 'error': '配置校验或进程启动失败'}

    def snapshot(self):
        self.expire()
        with self.lock:
            result = dict(self.reports)
            for key, item in self.running.items():
                result[key] = {'id': key, 'revision': item['revision'], 'state': 'active', 'error': '',
                               'traffic_bytes': self.traffic(key, item)}
            return list(result.values())[-1000:]

    def close(self):
        with self.lock:
            for key in list(self.running):
                self.stop(key)

def ping_sample(target):
    # Explicitly label the probe as line-server -> configured public target.
    if not target or not valid_ip(target):
        return None, None
    try:
        run = subprocess.run(['ping', '-n', '-c', '10', '-i', '0.2', '-W', '1', target],
                             capture_output=True, text=True, timeout=14, env={**os.environ, 'LC_ALL': 'C'})
        values = [float(x) for x in re.findall(r'time[=<]([\d.]+)', run.stdout)]
        loss = re.search(r'([\d.]+)% packet loss', run.stdout)
        return (round(statistics.median(values), 2) if values else None,
                float(loss.group(1)) if loss else None)
    except (OSError, subprocess.TimeoutExpired):
        return None, None

def main():
    origin = os.environ['MSBOOST_ORIGIN'].rstrip('/')
    if not origin.startswith('https://'):
        raise SystemExit('MSBOOST_ORIGIN must be HTTPS')
    token = os.environ['NODE_TOKEN']
    supervisor = Supervisor(os.environ.get('GOST_BINARY', '/usr/local/lib/msboostgost/msboostgost'),
                            os.environ.get('GOST_STATE', '/var/lib/msboostgost'),
                            int(os.environ.get('MAX_RELAYS', '200')))
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    def synchronize():
        while not stop.is_set():
            rtt, loss = ping_sample(os.environ.get('PROBE_IP', ''))
            payload = {'version': 'msboost-supervisor/1', 'relays': supervisor.snapshot(), 'rtt_ms': rtt, 'loss_pct': loss}
            try:
                begin = time.monotonic()
                request = urllib.request.Request(origin + '/api/node/sync', data=json.dumps(payload).encode(),
                    headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, method='POST')
                with urllib.request.urlopen(request, timeout=15) as result:
                    response = json.load(result)
                supervisor.reconcile(response, time.monotonic() - begin)
            except Exception:
                # No request bodies, URLs with credentials, or tokens in logs.
                print('MSBOOST synchronization failed; existing short leases remain enforced.', flush=True)
            stop.wait(20)
    threading.Thread(target=synchronize, daemon=True).start()
    try:
        while not stop.wait(0.5):
            supervisor.expire()
    finally:
        supervisor.close()

if __name__ == '__main__':
    main()
