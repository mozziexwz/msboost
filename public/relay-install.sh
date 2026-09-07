#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ "$EUID" == 0 ]] || { echo '请使用 root 执行'; exit 1; }
ORIGIN="${1:-}"
NODE_TOKEN="${2:-}"
PROBE_IP="${3:-}"
ASSET_ORIGIN="${4:-$ORIGIN}"
[[ "$ORIGIN" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || { echo '站点地址无效'; exit 1; }
[[ "$ASSET_ORIGIN" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || { echo '安装资源地址无效'; exit 1; }
[[ "$NODE_TOKEN" =~ ^[a-f0-9]{64}$ ]] || { echo '线路令牌无效'; exit 1; }
[[ -z "$PROBE_IP" || "$PROBE_IP" =~ ^[0-9a-fA-F:.]+$ ]] || { echo '探测地址无效'; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y python3 ca-certificates curl chrony tzdata iputils-ping
timedatectl set-timezone Asia/Singapore
systemctl enable --now chrony
chronyc -a makestep 0.1 3 || true
id msboostgost >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin msboostgost
install -d -m 0755 /opt/msboost /usr/local/lib/msboostgost
install -d -m 0700 /etc/msboostgost
install -d -m 0700 -o msboostgost -g msboostgost /var/lib/msboostgost
STAGE="$(mktemp -d /tmp/msboost-relay.XXXXXX)"
cleanup() { rm -rf -- "$STAGE"; }
trap cleanup EXIT
for file in relay.py assets.py install-binary.py msboostgost.service; do
  curl -fsSL --retry 3 "$ASSET_ORIGIN/relay-assets/$file" -o "$STAGE/$file"
done
install -m 0644 "$STAGE/relay.py" /opt/msboost/relay.py
install -m 0644 "$STAGE/assets.py" /opt/msboost/assets.py
python3 "$STAGE/install-binary.py" /usr/local/lib/msboostgost/msboostgost
install -m 0644 "$STAGE/msboostgost.service" /etc/systemd/system/msboostgost.service
cat > /etc/msboostgost/node.env <<EOF
MSBOOST_ORIGIN=$ORIGIN
NODE_TOKEN=$NODE_TOKEN
GOST_BINARY=/usr/local/lib/msboostgost/msboostgost
GOST_STATE=/var/lib/msboostgost
MAX_RELAYS=200
PROBE_IP=$PROBE_IP
EOF
chmod 0600 /etc/msboostgost/node.env
systemctl daemon-reload
systemctl enable msboostgost.service
systemctl restart msboostgost.service
systemctl is-active --quiet msboostgost.service
echo 'MSBOOST 服务已启动，正在等待首次同步…'
synced=0
for _ in $(seq 1 12); do
  if journalctl -u msboostgost.service --since '30 seconds ago' --no-pager | grep -q 'MSBOOST synchronization OK'; then
    synced=1
    break
  fi
  sleep 2
done
if [[ "$synced" == 1 ]]; then
  echo 'MSBOOST 转发机已成功同步，请刷新后台。'
else
  echo '服务已安装，但尚未确认同步成功。请查看下面的诊断信息：'
  journalctl -u msboostgost.service -n 8 --no-pager
fi
