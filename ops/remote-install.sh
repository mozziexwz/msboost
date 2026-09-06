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
# A repeated deployment is a replacement. Remove both the current MSBOOST
# service and names used by older releases before installing the new node.
systemctl disable --now msboost-node.service 2>/dev/null || true
systemctl disable --now msboost-mieru.service 2>/dev/null || true
rm -f -- /etc/systemd/system/msboost-node.service /etc/systemd/system/msboost-mieru.service
rm -rf -- /etc/msboost-node /etc/msboost-mieru
rm -f -- /usr/local/lib/msboost/core /usr/local/lib/msboost/mihomo
systemctl daemon-reload
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
install -d -m 0700 /etc/msboost-node /etc/msboost-node/ruleset
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
NODE_USER="${MSBOOST_PROFILE_NAME:-msboost}"
NODE_PASS="$(od -An -N20 -tx1 /dev/urandom | tr -d ' \n')"
cat > "$TEMP_DIR/config.yaml" <<EOF
mode: rule
log-level: warning
find-process-mode: off
listeners:
  - name: msboost-in
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
    path: /etc/msboost-node/ruleset/gfw.mrs
    url: https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/gfw.mrs
    interval: 86400
rules:
  - DOMAIN-SUFFIX,gtop100.com,DIRECT
  - DOMAIN-SUFFIX,nexon.com,DIRECT
  - DOMAIN-SUFFIX,nexon.net,DIRECT
  - DOMAIN-SUFFIX,nexon.co.kr,DIRECT
  - DOMAIN-SUFFIX,maplestory.com,DIRECT
  - DOMAIN-SUFFIX,maplestory.net,DIRECT
  - DOMAIN-SUFFIX,maplestory.nexon.com,DIRECT
  - DOMAIN-SUFFIX,maplestory.nexon.net,DIRECT
  - DOMAIN-SUFFIX,maplestorym.nexon.com,DIRECT
  - DOMAIN-SUFFIX,steampowered.com,DIRECT
  - DOMAIN-SUFFIX,steamcommunity.com,DIRECT
  - DOMAIN-SUFFIX,steamgames.com,DIRECT
  - DOMAIN-SUFFIX,steamusercontent.com,DIRECT
  - DOMAIN-SUFFIX,steamcontent.com,DIRECT
  - DOMAIN-SUFFIX,steamstatic.com,DIRECT
  - DOMAIN-SUFFIX,akamaihd.net,DIRECT
  - DOMAIN-SUFFIX,discord.com,DIRECT
  - DOMAIN-SUFFIX,discord.gg,DIRECT
  - DOMAIN-SUFFIX,discordapp.com,DIRECT
  - DOMAIN-SUFFIX,discordapp.net,DIRECT
  - RULE-SET,gfw-block,REJECT
  - MATCH,DIRECT
EOF
install -m 0600 "$TEMP_DIR/gfw.mrs" /etc/msboost-node/ruleset/gfw.mrs
echo 'MSBOOST_STAGE=config_check'
"$BIN_DIR/mihomo" -d /etc/msboost-node -f "$TEMP_DIR/config.yaml" -t >/dev/null 2>&1
rollback() {
  trap - ERR
  systemctl stop msboost-node.service 2>/dev/null || true
  echo 'MSBOOST_ERROR=MSBOOST 节点检查失败，已停止新服务'
}
trap 'rollback' ERR
echo 'MSBOOST_EVENT=正在安装独立的 msboost-node 服务'
echo 'MSBOOST_STAGE=service_start'
install -m 0755 "$BIN_DIR/mihomo" /usr/local/lib/msboost/core
install -m 0600 "$TEMP_DIR/config.yaml" /etc/msboost-node/config.yaml
cat > /etc/systemd/system/msboost-node.service <<'EOF'
[Unit]
Description=MSBOOST game node
After=network-online.target chrony.service
Wants=network-online.target
[Service]
ExecStart=/usr/local/lib/msboost/core -d /etc/msboost-node -f /etc/msboost-node/config.yaml
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
UMask=0077
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now msboost-node.service >/dev/null 2>&1
sleep 2
if ! systemctl is-active --quiet msboost-node.service; then rollback; exit 1; fi
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
/usr/local/lib/msboost/core -d "$TEMP_DIR" -f "$TEMP_DIR/test.yaml" >/dev/null 2>&1 &
TEST_PID=$!
trap 'kill "$TEST_PID" 2>/dev/null || true; cleanup' EXIT
sleep 1
if ! curl -fsS --retry 2 --proxy "socks5h://127.0.0.1:$TEST_PORT" --connect-timeout 8 --max-time 20 https://example.com/ -o /dev/null; then rollback; exit 1; fi
kill "$TEST_PID" 2>/dev/null || true
trap cleanup EXIT
echo 'MSBOOST_STAGE=result'
cat > "/run/msboost-result-${MSBOOST_JOB_ID}.json" <<EOF
{"profiles":[{"profileName":"$NODE_USER","user":{"name":"$NODE_USER","password":"$NODE_PASS"},"servers":[{"ipAddress":"$MSBOOST_PUBLIC_IP","domainName":"","portBindings":[{"port":$PORT,"protocol":"TCP"}]}],"mtu":1400}],"activeProfile":"$NODE_USER","rpcPort":8964,"socks5Port":6666,"loggingLevel":"INFO"}
EOF
echo 'MSBOOST_EVENT=MSBOOST 节点本机端到端验证通过'
echo "MSBOOST_PORT=$PORT"
