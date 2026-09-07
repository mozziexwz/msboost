#!/usr/bin/env bash
# MSBOOST v2 panel installer. It uses this repository's pinned Compose file.
set -Eeuo pipefail

REPO_RAW_BASE="${MSBOOST_REPO_RAW_BASE:-https://raw.githubusercontent.com/mozziexwz/msboost/msboost-v2}"
INSTALL_DIR="${MSBOOST_INSTALL_DIR:-/opt/msboost}"

die() { printf 'MSBOOST install error: %s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*"; }
random_value() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48; }

[[ "$(id -u)" -eq 0 ]] || die "run as root"
command -v curl >/dev/null 2>&1 || die "curl is required"

if ! command -v docker >/dev/null 2>&1; then
  info "Installing Docker Engine"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"

if [[ -d "$INSTALL_DIR" && -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" && "${MSBOOST_FORCE:-0}" != "1" ]]; then
  die "$INSTALL_DIR is not empty; back it up first or use a different MSBOOST_INSTALL_DIR"
fi

install -d -m 0750 "$INSTALL_DIR"
curl -fsSL "$REPO_RAW_BASE/docker-compose-v4.yml" -o "$INSTALL_DIR/docker-compose.yml"

if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  postgres_password="$(random_value)"
  cat > "$INSTALL_DIR/.env" <<EOF
JWT_SECRET=$(random_value)
BACKEND_PORT=6365
FRONTEND_PORT=6366
FLUX_VERSION=2.2.0-alpha4
DB_TYPE=postgres
DATABASE_URL=postgresql://msboost:${postgres_password}@postgres:5432/msboost?sslmode=disable
POSTGRES_DB=msboost
POSTGRES_USER=msboost
POSTGRES_PASSWORD=${postgres_password}
EOF
  chmod 0600 "$INSTALL_DIR/.env"
fi

info "Starting MSBOOST v2 base containers"
docker compose --project-directory "$INSTALL_DIR" pull
docker compose --project-directory "$INSTALL_DIR" up -d
info "Panel: http://SERVER-IP:6366"
info "This is the FLVX-based v2 foundation; keep the upstream GPL and NOTICE files."
