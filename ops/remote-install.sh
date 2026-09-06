#!/usr/bin/env bash
# Run by worker.py over an authenticated, fingerprint-checked SSH session.
# MSBOOST_* assignments are supplied via stdin; never log this input.
set -Eeuo pipefail
umask 077
[[ "$EUID" == 0 ]] || { echo 'MSBOOST_ERROR=root or passwordless sudo required'; exit 1; }
command -v apt-get >/dev/null
command -v systemctl >/dev/null
export DEBIAN_FRONTEND=noninteractive
echo 'MSBOOST_STAGE=dependencies'
echo 'MSBOOST_EVENT=正在安装依赖和时间同步服务'
apt-get update -qq >/dev/null
apt-get install -y -qq chrony tzdata ca-certificates curl gzip iproute2 >/dev/null
echo 'MSBOOST_STAGE=clock'
timedatectl set-timezone Asia/Singapore
systemctl enable --now chrony >/dev/null 2>&1
chronyc -a makestep 0.1 3 >/dev/null
chronyc -a burst 4/4 >/dev/null
chronyc waitsync 30 0.1 0 2 >/dev/null || { echo 'MSBOOST_ERROR=时间同步尚未完成，请检查 NTP 连通性'; exit 1; }
if command -v hwclock >/dev/null; then
  hwclock --systohc --utc 2>/dev/null || echo 'MSBOOST_EVENT=系统时间已同步；此 VPS 无可写硬件时钟'
fi
echo 'MSBOOST_EVENT=系统时间已同步，UTC+8'
install -d -m 0755 /usr/local/lib/msboost
install -d -m 0700 /etc/msboost-mieru /etc/msboost-mieru/ruleset
TEMP_DIR=$(mktemp -d /run/msboost-install.XXXXXX)
BIN_DIR=''
cleanup() {
  [[ "$TEMP_DIR" == /run/msboost-install.* ]] && rm -rf -- "$TEMP_DIR"
  if [[ "$BIN_DIR" == /usr/local/lib/msboost/.install.* ]]; then rm -rf -- "$BIN_DIR"; fi
}
trap cleanup EXIT
echo 'MSBOOST_STAGE=binary_download'
# /run can be a tiny noexec tmpfs. Only small private configurations belong there.
BIN_DIR=$(mktemp -d /usr/local/lib/msboost/.install.XXXXXX)
curl -fsSL --retry 3 --connect-timeout 15 --max-time 180 "$MSBOOST_BINARY_URL" -o "$BIN_DIR/core.gz"
echo 'MSBOOST_STAGE=checksum'
printf '%s  %s\n' "$MSBOOST_BINARY_SHA" "$BIN_DIR/core.gz" | sha256sum -c - >/dev/null
echo 'MSBOOST_STAGE=unpack'
gzip -dc "$BIN_DIR/core.gz" > "$BIN_DIR/mihomo"
chmod 0755 "$BIN_DIR/mihomo"
echo 'MSBOOST_STAGE=rules_download'
curl -fsSL --retry 3 --connect-timeout 15 --max-time 60 https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/gfw.mrs -o "$TEMP_DIR/gfw.mrs"
[[ -s "$TEMP_DIR/gfw.mrs" ]]
PORT=''
for _ in $(seq 1 100); do
  RAW=$(od -An -N2 -tu2 /dev/urandom | tr -d ' ')
  CANDIDATE=$((20000 + RAW % 40000))
  if [[ -z "$(ss -H -ltn "sport = :$CANDIDATE")" ]]; then PORT=$CANDIDATE; break; fi
done
[[ -n "$PORT" ]] || { echo 'MSBOOST_ERROR=没有可用 TCP 端口'; exit 1; }
NODE_USER="mieru-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
NODE_PASS="$(od -An -N20 -tx1 /dev/urandom | tr -d ' \n')"
cat > "$TEMP_DIR/config.yaml" <<EOF
mode: rule
log-level: warning
find-process-mode: off
listeners:
  - name: mieru-in
    type: mieru
    listen: 0.0.0.0
    port: $PORT
    transport: TCP
    users:
      $NODE_USER: "$NODE_PASS"
rule-providers:
  gfw-block:
    type: http
    behavior: domain
    format: mrs
    path: /etc/msboost-mieru/ruleset/gfw.mrs
    url: https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/gfw.mrs
    interval: 86400
rules:
  - RULE-SET,gfw-block,REJECT
  - MATCH,DIRECT
EOF
install -m 0600 "$TEMP_DIR/gfw.mrs" /etc/msboost-mieru/ruleset/gfw.mrs
echo 'MSBOOST_STAGE=config_check'
"$BIN_DIR/mihomo" -d /etc/msboost-mieru -f "$TEMP_DIR/config.yaml" -t >/dev/null 2>&1
WAS_ACTIVE=0
systemctl is-active --quiet msboost-mieru.service && WAS_ACTIVE=1
[[ -f /etc/msboost-mieru/config.yaml ]] && cp -p /etc/msboost-mieru/config.yaml "$TEMP_DIR/old-config" || true
[[ -f /usr/local/lib/msboost/mihomo ]] && cp -p /usr/local/lib/msboost/mihomo "$BIN_DIR/old-bin" || true
rollback() {
  trap - ERR
  if [[ -f "$TEMP_DIR/old-config" && -f "$BIN_DIR/old-bin" ]]; then
    install -m 0600 "$TEMP_DIR/old-config" /etc/msboost-mieru/config.yaml
    install -m 0755 "$BIN_DIR/old-bin" /usr/local/lib/msboost/mihomo
    (( WAS_ACTIVE == 0 )) || systemctl restart msboost-mieru.service || true
  else systemctl stop msboost-mieru.service || true; fi
  echo 'MSBOOST_ERROR=Mieru 检查失败，已停止新服务或尝试恢复旧配置'
}
trap 'rollback' ERR
echo 'MSBOOST_EVENT=正在安装独立的 msboost-mieru 服务'
echo 'MSBOOST_STAGE=service_start'
systemctl stop msboost-mieru.service 2>/dev/null || true
install -m 0755 "$BIN_DIR/mihomo" /usr/local/lib/msboost/mihomo
install -m 0600 "$TEMP_DIR/config.yaml" /etc/msboost-mieru/config.yaml
cat > /etc/systemd/system/msboost-mieru.service <<'EOF'
[Unit]
Description=MSBOOST Mieru inbound with GFW domain deny list
After=network-online.target chrony.service
Wants=network-online.target
[Service]
ExecStart=/usr/local/lib/msboost/mihomo -d /etc/msboost-mieru -f /etc/msboost-mieru/config.yaml
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
UMask=0077
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now msboost-mieru.service >/dev/null 2>&1
sleep 2
if ! systemctl is-active --quiet msboost-mieru.service; then rollback; exit 1; fi
echo 'MSBOOST_STAGE=selftest'
TEST_PORT=''
for _ in $(seq 1 100); do
  CANDIDATE=$((20000 + $(od -An -N2 -tu2 /dev/urandom | tr -d ' ') % 40000))
  if [[ "$CANDIDATE" != "$PORT" && -z "$(ss -H -ltn "sport = :$CANDIDATE")" ]]; then TEST_PORT=$CANDIDATE; break; fi
done
[[ -n "$TEST_PORT" ]] || { rollback; exit 1; }
cat > "$TEMP_DIR/test.yaml" <<EOF
mode: rule
log-level: silent
listeners:
  - name: selftest
    type: socks
    listen: 127.0.0.1
    port: $TEST_PORT
proxies:
  - name: node
    type: mieru
    server: 127.0.0.1
    port: $PORT
    transport: TCP
    username: "$NODE_USER"
    password: "$NODE_PASS"
    multiplexing: MULTIPLEXING_LOW
rules:
  - MATCH,node
EOF
/usr/local/lib/msboost/mihomo -d "$TEMP_DIR" -f "$TEMP_DIR/test.yaml" >/dev/null 2>&1 &
TEST_PID=$!
trap 'kill "$TEST_PID" 2>/dev/null || true; cleanup' EXIT
sleep 1
if ! curl -fsS --retry 2 --proxy "socks5h://127.0.0.1:$TEST_PORT" --connect-timeout 8 --max-time 20 https://example.com/ -o /dev/null; then rollback; exit 1; fi
kill "$TEST_PID" 2>/dev/null || true
trap cleanup EXIT
echo 'MSBOOST_STAGE=result'
cat > "/run/msboost-result-${MSBOOST_JOB_ID}.json" <<EOF
{"profiles":[{"profileName":"default","user":{"name":"$NODE_USER","password":"$NODE_PASS"},"servers":[{"ipAddress":"$MSBOOST_PUBLIC_IP","domainName":"","portBindings":[{"port":$PORT,"protocol":"TCP"}]}],"mtu":1400}],"activeProfile":"default","rpcPort":8964,"socks5Port":1080,"loggingLevel":"INFO"}
EOF
echo 'MSBOOST_EVENT=Mieru 本机端到端验证通过'
echo "MSBOOST_PORT=$PORT"
