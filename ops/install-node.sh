#!/usr/bin/env bash
# Run from the uploaded ops directory on YOUR relay server.
set -Eeuo pipefail
[[ "$EUID" == 0 ]] || { echo 'Run as root'; exit 1; }
[[ -f ./relay.py && -f ./assets.py && -f ./msboostgost.service ]] || { echo 'Run from the ops directory'; exit 1; }
apt-get update
apt-get install -y python3 ca-certificates curl chrony tzdata iputils-ping
timedatectl set-timezone Asia/Singapore
systemctl enable --now chrony
chronyc -a makestep 0.1 3
chronyc -a burst 4/4
chronyc waitsync 30 0.1 0 2
id msboostgost >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin msboostgost
install -d -m 0755 /opt/msboost /usr/local/lib/msboostgost
install -d -m 0700 /etc/msboostgost
install -d -m 0700 -o msboostgost -g msboostgost /var/lib/msboostgost
install -m 0644 ./relay.py ./assets.py /opt/msboost/
python3 ./install-binary.py /usr/local/lib/msboostgost/msboostgost
install -m 0644 ./msboostgost.service /etc/systemd/system/msboostgost.service
if [[ ! -f /etc/msboostgost/node.env ]]; then
  install -m 0600 ./node.env.example /etc/msboostgost/node.env
fi
systemctl daemon-reload
echo 'Installed MSBOOST files. Existing gost services were not touched.'
echo 'Edit /etc/msboostgost/node.env, reserve its port range in your firewall/cloud security group, then:'
echo 'systemctl enable --now msboostgost.service'
