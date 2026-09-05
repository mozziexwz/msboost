#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ "$EUID" == 0 ]] || exit 1
command -v apt-get >/dev/null
[[ -z "$(ss -H -ltn "sport = :$MSBOOST_FRONT_PORT")" && -z "$(ss -H -lun "sport = :$MSBOOST_FRONT_PORT")" ]] || { echo 'MSBOOST_ERROR=前置机端口已被占用'; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq ca-certificates curl tar chrony tzdata >/dev/null
timedatectl set-timezone Asia/Singapore
systemctl enable --now chrony >/dev/null 2>&1
chronyc -a makestep 0.1 3 >/dev/null
chronyc -a burst 4/4 >/dev/null
chronyc waitsync 30 0.1 0 2 >/dev/null
TEMP_DIR=$(mktemp -d /run/msboost-front.XXXXXX)
trap '[[ "$TEMP_DIR" == /run/msboost-front.* ]] && rm -rf -- "$TEMP_DIR"' EXIT
curl -fsSL --retry 3 --connect-timeout 15 --max-time 180 "$MSBOOST_BINARY_URL" -o "$TEMP_DIR/gost.tar.gz"
printf '%s  %s\n' "$MSBOOST_BINARY_SHA" "$TEMP_DIR/gost.tar.gz" | sha256sum -c - >/dev/null
tar -xzf "$TEMP_DIR/gost.tar.gz" -C "$TEMP_DIR" gost
install -d -m 0755 /usr/local/lib/msboost-front
install -d -m 0700 /etc/msboost-front
install -m 0755 "$TEMP_DIR/gost" /usr/local/lib/msboost-front/msboostfront
printf '%s' "$MSBOOST_FRONT_CONFIG" | base64 -d > /etc/msboost-front/config.json
cat > /etc/systemd/system/msboost-front.service <<'EOF'
[Unit]
Description=MSBOOST customer-owned front relay
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/local/lib/msboost-front/msboostfront -C /etc/msboost-front/config.json
Restart=on-failure
RestartSec=3
KillMode=control-group
NoNewPrivileges=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now msboost-front.service >/dev/null 2>&1
sleep 2
systemctl is-active --quiet msboost-front.service
echo 'MSBOOST_EVENT=自备前置转发已启动，无管理 Agent'
