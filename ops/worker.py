#!/usr/bin/env python3
"""Private operator-side one-shot SSH worker and fixed-template SMTP bridge.

Bind to loopback and put behind the provided TLS reverse proxy. Job secrets only
exist in process memory; no durable queue contains SSH credentials or results.
"""
from __future__ import annotations
import base64
import concurrent.futures
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import re
import secrets
import shlex
import smtplib
import socket
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from assets import release_asset

ROOT = Path(__file__).resolve().parent
JOBS = {}
LOCK = threading.RLock()
SLOTS = threading.BoundedSemaphore(int(os.environ.get('MAX_JOBS', '4')))
logging.getLogger('paramiko').setLevel(logging.CRITICAL)

def public_ip(value):
    try:
        address = ipaddress.ip_address(value)
        return address.is_global and not address.is_multicast
    except ValueError:
        return False

def validate_connection(data):
    if not public_ip(str(data.get('ip', ''))):
        raise ValueError('只支持公网 IP')
    if not isinstance(data.get('ssh_port'), int) or not 1 <= data['ssh_port'] <= 65535:
        raise ValueError('SSH 端口无效')

def key_fingerprint(key):
    return 'SHA256:' + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip('=')

def connect(data, authenticate=True):
    import paramiko
    validate_connection(data)
    transport = paramiko.Transport(socket.create_connection((data['ip'], data['ssh_port']), timeout=10))
    try:
        transport.start_client(timeout=10)
        actual = key_fingerprint(transport.get_remote_server_key())
        if authenticate:
            if not hmac.compare_digest(actual, data['fingerprint']):
                raise ValueError('SSH 主机指纹已变化，请重新核对')
            transport.auth_password(data['username'], data['password'], fallback=False)
        return transport, actual
    except Exception:
        transport.close()
        raise

def remote_failure(output):
    # Never expose raw remote stdout/stderr: it may contain credentials.
    stages = {
        'dependencies': '安装 APT 依赖失败，请检查软件源、磁盘空间及 apt 锁',
        'clock': '时间同步失败，请检查 chrony、NTP 连通性及系统权限',
        'binary_download': '下载 Mihomo 失败，请检查 GitHub 连通性及 /usr/local 磁盘空间',
        'checksum': 'Mihomo 发布文件校验失败，请重试下载',
        'unpack': '解压 Mihomo 失败，请检查 /usr/local 磁盘空间',
        'rules_download': '下载 GFW 规则失败，请检查 raw.githubusercontent.com 连通性',
        'config_check': 'Mihomo 配置校验失败，请检查内核兼容性及 /usr/local 是否允许执行',
        'service_start': 'msboost-mieru 服务启动失败，请检查客户 VPS 上的服务日志',
        'selftest': 'Mieru 本机端到端测试失败，请检查出站网络和服务状态',
        'result': '生成客户端配置失败，请检查 /run 剩余空间',
    }
    found = [line.removeprefix('MSBOOST_STAGE=') for line in output.decode(errors='replace').splitlines()
             if line.startswith('MSBOOST_STAGE=')]
    return stages.get(found[-1] if found else '', '远端步骤失败，请检查系统依赖、权限、网络与服务状态')

def command(transport, script, timeout=120, root=False):
    channel = transport.open_session(timeout=10)
    channel.set_combine_stderr(True)
    # SSH commands are fixed; all scripts and user values go through stdin.
    channel.exec_command('sudo -n bash -s' if root else 'bash -s')
    channel.sendall(script.encode())
    channel.shutdown_write()
    output = bytearray()
    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline:
            while channel.recv_ready():
                block = channel.recv(32768)
                if len(output) < 262144:
                    output.extend(block[:262144-len(output)])
            if channel.exit_status_ready() and not channel.recv_ready():
                status = channel.recv_exit_status()
                if status:
                    raise ValueError(remote_failure(output))
                return output.decode(errors='replace')
            time.sleep(0.05)
        raise TimeoutError('远端步骤超时，请勿重复重装，先检查 VPS 状态')
    finally:
        channel.close()

def update(job_id, **fields):
    with LOCK:
        if job_id in JOBS:
            JOBS[job_id].update(fields)

def event(job_id, message):
    with LOCK:
        JOBS[job_id]['events'].append(message)

def platform_asset(transport, kind):
    architecture = command(transport, 'uname -m\n', timeout=15).strip()
    if architecture not in ('x86_64', 'aarch64', 'arm64'):
        raise ValueError('仅支持 x86_64 或 ARM64 VPS')
    if kind == 'install':
        version = os.environ.get('MIHOMO_VERSION', 'v1.19.30')
        candidates = ([f'mihomo-linux-amd64-v1-{version}.gz', f'mihomo-linux-amd64-compatible-{version}.gz', f'mihomo-linux-amd64-{version}.gz']
                      if architecture == 'x86_64' else [f'mihomo-linux-arm64-{version}.gz', f'mihomo-linux-arm64-v8-{version}.gz'])
        return release_asset('MetaCubeX/mihomo', version, candidates)
    version = os.environ.get('GOST_VERSION', 'v3.2.6')
    arch = 'amd64' if architecture == 'x86_64' else 'arm64'
    return release_asset('go-gost/gost', version, [f'gost_{version[1:]}_linux_{arch}.tar.gz', f'gost_{version[1:]}_linux_{arch}v1.tar.gz'])

def assignments(values):
    return ''.join(f'{key}={shlex.quote(str(value))}\n' for key, value in values.items())

def run_job(data):
    jid, transport = data['job_id'], None
    try:
        update(jid, state='running')
        event(jid, '正在连接 VPS 并验证 SSH 主机指纹')
        transport, _ = connect(data)
        root = command(transport, 'id -u\n', timeout=15).strip() != '0'
        if root:
            command(transport, 'test "$(id -u)" = 0\n', root=True, timeout=15)
        if data['kind'] == 'dd':
            if os.environ.get('DD_ENABLED', 'false').lower() != 'true':
                raise ValueError('管理员尚未启用 DD 重装执行')
            port = data['new_ssh_port']
            if not isinstance(port, int) or not 20000 <= port <= 59999:
                raise ValueError('新 SSH 端口无效')
            url = os.environ.get('REINSTALL_URL', 'https://raw.githubusercontent.com/bin456789/reinstall/main/reinstall.sh')
            if not url.startswith('https://raw.githubusercontent.com/bin456789/reinstall/'):
                raise ValueError('重装脚本必须来自指定的上游仓库')
            with urllib.request.urlopen(url, timeout=30) as response:
                script = response.read(4 * 1024 * 1024)
            expected = os.environ.get('REINSTALL_SHA256')
            if expected and not hmac.compare_digest(hashlib.sha256(script).hexdigest(), expected):
                raise ValueError('重装脚本校验值不匹配')
            event(jid, f'正在准备 Debian 12；新 SSH 端口 {port}')
            encoded = base64.b64encode(script).decode()
            password = shlex.quote(data['password'])
            dd = "set -e\numask 077\ninstall -d -m 0700 /root/msboost-dd\n"
            dd += f"printf '%s' {shlex.quote(encoded)} | base64 -d > /root/msboost-dd/reinstall.sh\n"
            dd += f"bash /root/msboost-dd/reinstall.sh debian 12 --password {password} --ssh-port {port} --username root\n"
            command(transport, dd, timeout=1800, root=root)
            # No blind retry beyond the reboot boundary.
            update(jid, state='reboot_requested', new_ssh_port=port)
            event(jid, '重装引导已准备完成，正在请求重启；SSH 断开不代表重装完成')
            try:
                command(transport, 'systemctl reboot\n', timeout=20, root=root)
            except Exception:
                pass
            transport.close()
            transport = None
            # A reinstall legitimately changes host keys. Do not send the user's
            # password to a newly observed key before the user checks it.
            data.pop('password', None)
            for _ in range(120):
                time.sleep(10)
                try:
                    probe, fingerprint = connect({'ip': data['ip'], 'ssh_port': port}, authenticate=False)
                    probe.close()
                    update(jid, state='awaiting_verification', fingerprint=fingerprint)
                    event(jid, '新 SSH 端口已响应，请核对新主机指纹并确认 Debian 安装状态')
                    break
                except Exception:
                    continue
            else:
                update(jid, state='needs_attention', error='未在等待时间内看到新 SSH 端口，请通过云控制台检查，不要直接重复 DD')
        else:
            event(jid, '正在获取固定版本的安装文件并验证发布校验值')
            binary_url, binary_sha = platform_asset(transport, data['kind'])
            values = {'MSBOOST_JOB_ID': jid, 'MSBOOST_PUBLIC_IP': data['ip'],
                      'MSBOOST_BINARY_URL': binary_url, 'MSBOOST_BINARY_SHA': binary_sha}
            if data['kind'] == 'front':
                front_port = data['front_port']
                if not isinstance(front_port, int) or not 1024 <= front_port <= 65535:
                    raise ValueError('前置端口无效')
                host, port, protocol = data['relay_host'], data['relay_port'], data['protocol'].lower()
                if protocol not in ('tcp', 'udp') or not isinstance(port, int) or not 1 <= port <= 65535:
                    raise ValueError('中转目标无效')
                if not re.fullmatch(r'[A-Za-z0-9.:-]{1,253}', host):
                    raise ValueError('中转主机无效')
                destination = f'[{host}]:{port}' if ':' in host else f'{host}:{port}'
                config = {'services': [{'name': 'msboost-front', 'addr': ':' + str(front_port),
                          'handler': {'type': protocol}, 'listener': {'type': protocol},
                          'forwarder': {'nodes': [{'name': 'msboost-line', 'addr': destination}]}}]}
                values.update(MSBOOST_FRONT_PORT=front_port, MSBOOST_FRONT_CONFIG=base64.b64encode(json.dumps(config).encode()).decode())
                remote = ROOT / 'remote-front.sh'
            else:
                remote = ROOT / 'remote-install.sh'
            event(jid, '正在安装业务服务、同步 UTC+8 时间并检查运行状态')
            output = command(transport, assignments(values) + remote.read_text(encoding='utf-8'), timeout=1200, root=root)
            if data['kind'] == 'install':
                result_path = f'/run/msboost-result-{jid}.json'
                # Reading over the same authenticated connection; result is not logged.
                content = command(transport, f'cat {shlex.quote(result_path)}\nrm -f -- {shlex.quote(result_path)}\n', timeout=20, root=root)
                config = json.loads(content)
                port = config['profiles'][0]['servers'][0]['portBindings'][0]['port']
                try:
                    with socket.create_connection((data['ip'], port), timeout=8):
                        pass
                    event(jid, f'公网 TCP/{port} 可达，Mieru 部署完成')
                except OSError:
                    event(jid, f'本机自测已通过，但公网 TCP/{port} 未连通，请放行云安全组及防火墙')
                update(jid, config=config, state='completed')
            else:
                update(jid, state='completed', front_port=data['front_port'])
                event(jid, f'前置转发已启动，请放行 TCP/UDP {data["front_port"]} 对应的配置协议端口')
    except ValueError as exc:
        update(jid, state='failed', error=str(exc)[:180])
    except Exception:
        update(jid, state='failed', error='连接或执行失败。请检查 SSH 密码、root/免密 sudo、APT/GitHub/NTP 网络及服务器状态。')
    finally:
        if transport:
            transport.close()
        data.clear()
        update(jid, finished_at=time.time())
        SLOTS.release()

def send_mail(data):
    email, code = data.get('email', ''), data.get('code', '')
    test_mail = data.get('purpose') == 'test'
    if not isinstance(email, str) or len(email) > 254 or not re.fullmatch(r'[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+', email) or (not test_mail and not re.fullmatch(r'\d{6}', code)):
        raise ValueError('无效的验证码邮件')
    config = data.get('smtp')
    if config is None:
        config = dict(host=os.environ.get('SMTP_HOST', 'smtp.qq.com'), port=int(os.environ.get('SMTP_PORT', '465')),
                      username=os.environ.get('SMTP_USER', ''), password=os.environ.get('SMTP_PASSWORD', ''),
                      **{'from': os.environ.get('SMTP_FROM', '')})
    if not isinstance(config, dict):
        raise ValueError('SMTP 配置无效')
    host, port = config.get('host', ''), config.get('port')
    if not isinstance(host, str) or not re.fullmatch(r'[a-zA-Z0-9.-]{1,253}', host) or port != 465:
        raise ValueError('SMTP 需要有效主机和 465 SSL/TLS 端口')
    for field in ('username', 'from'):
        if not isinstance(config.get(field), str) or not re.fullmatch(r'[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+', config[field]):
            raise ValueError('SMTP 邮箱格式无效')
    if not isinstance(config.get('password'), str) or not 1 <= len(config['password']) <= 2048:
        raise ValueError('SMTP 授权码未配置')
    addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if not addresses or not all(public_ip(item[4][0]) for item in addresses):
        raise ValueError('SMTP 主机必须解析到公网地址')
    message = EmailMessage()
    message['From'] = config['from']
    message['To'] = email
    message['Subject'] = 'MSBOOST 邮件配置测试' if test_mail else 'MSBOOST 邮箱验证码'
    message.set_content('这是一封由 MSBOOST 管理员手动发送的测试邮件。邮件发送配置正常。' if test_mail else f'你的 MSBOOST 验证码是：{code}\n\n10 分钟内有效。若非本人操作，请忽略此邮件。\nmsboost.de')
    with smtplib.SMTP_SSL(host, port,
                          context=ssl.create_default_context(), timeout=15) as smtp:
        smtp.login(config['username'], config['password'])
        smtp.send_message(message)

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def response(self, data, status=200):
        encoded = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)
    def authorized(self):
        expected = os.environ.get('WORKER_TOKEN', '')
        supplied = self.headers.get('Authorization', '').removeprefix('Bearer ')
        return len(expected) >= 32 and hmac.compare_digest(supplied, expected)
    def do_GET(self):
        if not self.authorized():
            return self.response({'error': 'Unauthorized'}, 401)
        parsed = urllib.parse.urlsplit(self.path)
        job_id = parsed.path.removeprefix('/jobs/')
        owner = urllib.parse.parse_qs(parsed.query).get('owner_id', [''])[0]
        with LOCK:
            job = JOBS.get(job_id)
            if not job or job['owner_id'] != owner:
                return self.response({'error': '任务不存在、执行器已重启或临时结果已过期'}, 404)
            return self.response({k: v for k, v in job.items() if k != 'owner_id'})
    def do_POST(self):
        if not self.authorized():
            return self.response({'error': 'Unauthorized'}, 401)
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 16384:
                return self.response({'error': '请求过大'}, 413)
            data = json.loads(self.rfile.read(size))
            if self.path == '/mail':
                send_mail(data)
                return self.response({'ok': True})
            if self.path == '/probe':
                transport, fingerprint = connect(data, authenticate=False)
                transport.close()
                return self.response({'fingerprint': fingerprint})
            if self.path == '/jobs':
                validate_connection(data)
                if not re.fullmatch(r'[a-f0-9]{32}', data.get('job_id', '')) or not re.fullmatch(r'[a-f0-9]{32}', data.get('owner_id', '')):
                    raise ValueError('任务 ID 无效')
                if data.get('kind') not in ('install', 'dd', 'front') or not re.fullmatch(r'[a-z_][a-z0-9_\-]{0,31}\$?', data.get('username', ''), re.I):
                    raise ValueError('无效的任务或用户名')
                if not isinstance(data.get('password'), str) or not 1 <= len(data['password']) <= 256:
                    raise ValueError('密码无效')
                if not re.fullmatch(r'SHA256:[A-Za-z0-9+/]+={0,2}', data.get('fingerprint', '')):
                    raise ValueError('缺少主机指纹确认')
                with LOCK:
                    if data['job_id'] in JOBS:
                        return self.response({'accepted': True})
                    if not SLOTS.acquire(blocking=False):
                        return self.response({'error': '执行服务器繁忙，请稍后重试'}, 429)
                    JOBS[data['job_id']] = {'owner_id': data['owner_id'], 'state': 'queued', 'events': [], 'created_at': time.time()}
                threading.Thread(target=run_job, args=(data,), daemon=True).start()
                return self.response({'accepted': True}, 202)
            return self.response({'error': 'Not found'}, 404)
        except ValueError as exc:
            return self.response({'error': str(exc)[:180]}, 400)
        except Exception:
            return self.response({'error': '执行服务暂不可用，请检查邮件/SSH/依赖配置'}, 502)

def housekeeping():
    while True:
        with LOCK:
            for jid, record in list(JOBS.items()):
                if record.get('finished_at', float('inf')) < time.time() - 1800:
                    del JOBS[jid]
        origin = os.environ.get('MSBOOST_ORIGIN', '').rstrip('/')
        if origin.startswith('https://'):
            try:
                req = urllib.request.Request(origin + '/api/maintenance/tick', data=b'{}',
                        headers={'Authorization': 'Bearer ' + os.environ['WORKER_TOKEN'], 'Content-Type': 'application/json'}, method='POST')
                with urllib.request.urlopen(req, timeout=15) as response:
                    response.read(4096)
            except Exception:
                pass
        time.sleep(60)

if __name__ == '__main__':
    if len(os.environ.get('WORKER_TOKEN', '')) < 32:
        raise SystemExit('Set a strong WORKER_TOKEN before starting')
    threading.Thread(target=housekeeping, daemon=True).start()
    ThreadingHTTPServer(('127.0.0.1', int(os.environ.get('WORKER_PORT', '8788'))), Handler).serve_forever()
