#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$EUID" == 0 && -f ./worker.py ]] || { echo 'Run as root from ops directory'; exit 1; }
apt-get update
apt-get install -y python3 python3-venv ca-certificates
id msboostworker >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin msboostworker
install -d -m 0755 /opt/msboost-worker
install -d -m 0700 /etc/msboost-worker
install -m 0644 ./worker.py ./assets.py ./remote-install.sh ./remote-front.sh ./requirements.txt /opt/msboost-worker/
python3 -m venv /opt/msboost-worker/venv
/opt/msboost-worker/venv/bin/pip install -r /opt/msboost-worker/requirements.txt
install -m 0644 ./msboost-worker.service /etc/systemd/system/msboost-worker.service
[[ -f /etc/msboost-worker/worker.env ]] || install -m 0600 ./worker.env.example /etc/msboost-worker/worker.env
systemctl daemon-reload
echo 'Edit /etc/msboost-worker/worker.env and configure an HTTPS reverse proxy.'
echo 'Then run: systemctl enable --now msboost-worker.service'
