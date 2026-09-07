#!/usr/bin/env bash
# MSBOOST self-hosted bootstrap installer.
# It installs a pinned, upstream FLVX-based Docker stack. It does not migrate
# the legacy Cloudflare Sites data and it never writes SSH credentials.
set -Eeuo pipefail

REPO_RAW_BASE="${MSBOOST_REPO_RAW_BASE:-https://raw.githubusercontent.com/mozziexwz/msboost/main}"
INSTALL_DIR="${MSBOOST_INSTALL_DIR:-/opt/msboost}"

die() { printf 'MSBOOST install error: %s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*"; }

[[ "$(id -u)" -eq 0 ]] || die "run as root (or use sudo bash)"
command -v curl >/dev/null 2>&1 || die "curl is required"

if ! command -v docker >/dev/null 2>&1; then
  info "Docker is not installed; installing Docker Engine from get.docker.com"
  curl -fsSL https://get.docker.com | sh
fi

docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"

if [[ -e "$INSTALL_DIR" ]] && [[ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]] && [[ "${MSBOOST_FORCE:-0}" != "1" ]]; then
  die "$INSTALL_DIR is not empty; set MSBOOST_FORCE=1 only after you have backed it up"
fi

install -d -m 0750 "$INSTALL_DIR"
curl -fsSL "$REPO_RAW_BASE/selfhost/docker-compose.yml" -o "$INSTALL_DIR/docker-compose.yml"
curl -fsSL "$REPO_RAW_BASE/selfhost/.env.example" -o "$INSTALL_DIR/.env.example"
curl -fsSL "$REPO_RAW_BASE/selfhost/NOTICE-FLVX.md" -o "$INSTALL_DIR/NOTICE-FLVX.md"

random_value() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    tr -dc 'A-Za-z0-9' </dev/urandom | head -c 64
  fi
}

if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  POSTGRES_PASSWORD="$(random_value)"
  JWT_SECRET="$(random_value)"
  sed \
    -e "s|replace-with-a-long-random-password|$POSTGRES_PASSWORD|" \
    -e "s|replace-with-a-long-random-secret|$JWT_SECRET|" \
    "$INSTALL_DIR/.env.example" > "$INSTALL_DIR/.env"
  chmod 0600 "$INSTALL_DIR/.env"
fi

info "Pulling the pinned MSBOOST self-hosted bootstrap images"
docker compose --project-directory "$INSTALL_DIR" pull
docker compose --project-directory "$INSTALL_DIR" up -d

info "Waiting for the panel backend health check"
for attempt in $(seq 1 30); do
  if docker inspect --format '{{.State.Health.Status}}' msboost-backend 2>/dev/null | grep -qx healthy; then
    panel_port="$(grep '^PANEL_PORT=' "$INSTALL_DIR/.env" | cut -d= -f2)"
    info "Installed. Open http://SERVER-IP:${panel_port:-6366}"
    info "Before public use, change the upstream default administrator password."
    exit 0
  fi
  sleep 2
done

docker compose --project-directory "$INSTALL_DIR" ps >&2 || true
die "containers started but the backend did not become healthy; inspect logs with: docker compose --project-directory $INSTALL_DIR logs --tail=100"
