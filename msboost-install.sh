#!/usr/bin/env bash
# MSBOOST v2 panel installer. It uses this repository's pinned Compose file.
set -Eeuo pipefail

REPO_URL="${MSBOOST_REPO_URL:-https://github.com/mozziexwz/msboost.git}"
BRANCH="${MSBOOST_BRANCH:-msboost-v2}"
INSTALL_DIR="${MSBOOST_INSTALL_DIR:-/opt/msboost}"

die() { printf 'MSBOOST install error: %s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*"; }
# Avoid `tr | head` here: with `set -o pipefail`, head exits once it has
# collected enough bytes and tr receives SIGPIPE, making the installer abort
# immediately after cloning.  `od` reads a fixed amount, so the pipeline ends
# normally on every supported Debian/Ubuntu host.
random_value() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }

[[ "$(id -u)" -eq 0 ]] || die "run as root"
command -v curl >/dev/null 2>&1 || die "curl is required"

if ! command -v docker >/dev/null 2>&1; then
  info "Installing Docker Engine"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"

if [[ -e "$INSTALL_DIR" ]]; then
  die "$INSTALL_DIR already exists; choose an empty MSBOOST_INSTALL_DIR or back it up before reinstalling"
fi

if ! command -v git >/dev/null 2>&1; then
  info "Installing Git"
  apt-get update
  apt-get install -y git
fi

info "Downloading MSBOOST source branch: $BRANCH"
git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
cp "$INSTALL_DIR/docker-compose-v4.yml" "$INSTALL_DIR/docker-compose.yml"

if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  postgres_password="$(random_value)"
  cat > "$INSTALL_DIR/.env" <<EOF
JWT_SECRET=$(random_value)
BACKEND_PORT=6365
FRONTEND_PORT=6366
MSBOOST_VERSION=dev
DB_TYPE=postgres
DATABASE_URL=postgresql://msboost:${postgres_password}@postgres:5432/msboost?sslmode=disable
POSTGRES_DB=msboost
POSTGRES_USER=msboost
POSTGRES_PASSWORD=${postgres_password}
EOF
  chmod 0600 "$INSTALL_DIR/.env"
fi

info "Building MSBOOST v2 containers from source"
docker compose --project-directory "$INSTALL_DIR" build --pull
docker compose --project-directory "$INSTALL_DIR" up -d
info "Panel: http://SERVER-IP:6366"
info "This is the FLVX-based v2 foundation; keep the upstream GPL and NOTICE files."
