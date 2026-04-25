#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
REQUESTED_FRONTEND_PORT="$FRONTEND_PORT"
BACKEND_PORT="${BACKEND_PORT:-8000}"
BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}"
LOG_DIR="${ROOT_DIR}/.logs"

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:${PATH}"

mkdir -p "$LOG_DIR"

backend_pid=""
frontend_pid=""

port_is_listening() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

frontend_looks_like_chess() {
  local port="$1"
  curl -fsS "http://localhost:${port}" 2>/dev/null | grep -qi "<title>Chess Review</title>"
}

resolve_frontend_port() {
  local preferred_port="$1"
  local first_free_port=""
  local port=""

  if ! port_is_listening "$preferred_port"; then
    FRONTEND_PORT="$preferred_port"
    FRONTEND_URL="http://localhost:${FRONTEND_PORT}"
    return 0
  fi

  if frontend_looks_like_chess "$preferred_port"; then
    FRONTEND_PORT="$preferred_port"
    FRONTEND_URL="http://localhost:${FRONTEND_PORT}"
    return 0
  fi

  for port in $(seq $((preferred_port + 1)) $((preferred_port + 20))); do
    if port_is_listening "$port"; then
      if frontend_looks_like_chess "$port"; then
        FRONTEND_PORT="$port"
        FRONTEND_URL="http://localhost:${FRONTEND_PORT}"
        return 0
      fi
      continue
    fi

    if [[ -z "$first_free_port" ]]; then
      first_free_port="$port"
    fi
  done

  if [[ -n "$first_free_port" ]]; then
    FRONTEND_PORT="$first_free_port"
    FRONTEND_URL="http://localhost:${FRONTEND_PORT}"
    return 0
  fi

  echo "Could not find a free frontend port near ${preferred_port}. Check local dev servers and try again."
  return 1
}

wait_for_url() {
  local url="$1"
  local label="$2"

  for _ in {1..60}; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done

  echo "${label} did not respond at ${url}. Check logs in ${LOG_DIR}."
  return 1
}

cleanup() {
  if [[ -n "$frontend_pid" ]] && kill -0 "$frontend_pid" >/dev/null 2>&1; then
    kill "$frontend_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "$backend_pid" ]] && kill -0 "$backend_pid" >/dev/null 2>&1; then
    kill "$backend_pid" >/dev/null 2>&1 || true
  fi
}

trap cleanup INT TERM

echo "Starting Chess Review from ${ROOT_DIR}"

resolve_frontend_port "$FRONTEND_PORT"

if [[ ! -f "${ROOT_DIR}/backend/.env" && -f "${ROOT_DIR}/backend/.env.example" ]]; then
  cp "${ROOT_DIR}/backend/.env.example" "${ROOT_DIR}/backend/.env"
fi

if [[ ! -f "${ROOT_DIR}/frontend/.env.local" && -f "${ROOT_DIR}/frontend/.env.example" ]]; then
  cp "${ROOT_DIR}/frontend/.env.example" "${ROOT_DIR}/frontend/.env.local"
fi

if [[ ! -x "${ROOT_DIR}/backend/.venv/bin/python" ]]; then
  echo "Creating backend virtual environment..."
  python3 -m venv "${ROOT_DIR}/backend/.venv"
fi

if [[ ! -f "${ROOT_DIR}/backend/.venv/.requirements-installed" || "${ROOT_DIR}/backend/requirements.txt" -nt "${ROOT_DIR}/backend/.venv/.requirements-installed" ]]; then
  echo "Installing backend dependencies..."
  "${ROOT_DIR}/backend/.venv/bin/pip" install -r "${ROOT_DIR}/backend/requirements.txt"
  touch "${ROOT_DIR}/backend/.venv/.requirements-installed"
fi

if [[ ! -d "${ROOT_DIR}/frontend/node_modules" ]]; then
  echo "Installing frontend dependencies..."
  npm install --prefix "${ROOT_DIR}/frontend"
fi

if port_is_listening "$BACKEND_PORT"; then
  echo "Backend already listening on ${BACKEND_URL}"
else
  echo "Starting backend on ${BACKEND_URL}"
  (
    cd "${ROOT_DIR}/backend"
    .venv/bin/uvicorn app.main:app --reload --host 127.0.0.1 --port "${BACKEND_PORT}"
  ) >"${LOG_DIR}/backend.log" 2>&1 &
  backend_pid="$!"
fi

if port_is_listening "$FRONTEND_PORT"; then
  echo "Frontend already listening on ${FRONTEND_URL}"
else
  if [[ "$FRONTEND_PORT" != "$REQUESTED_FRONTEND_PORT" ]]; then
    echo "Frontend port ${REQUESTED_FRONTEND_PORT} is busy with another app. Starting Chess Review on ${FRONTEND_URL} instead."
  else
    echo "Starting frontend on ${FRONTEND_URL}"
  fi
  (
    cd "${ROOT_DIR}/frontend"
    NEXT_PUBLIC_API_URL="${BACKEND_URL}" npm run dev -- --hostname 127.0.0.1 --port "${FRONTEND_PORT}"
  ) >"${LOG_DIR}/frontend.log" 2>&1 &
  frontend_pid="$!"
fi

wait_for_url "${BACKEND_URL}/api/health" "Backend"
wait_for_url "$FRONTEND_URL" "Frontend"

echo ""
echo "Chess Review is ready:"
echo "  App: ${FRONTEND_URL}"
echo "  API: ${BACKEND_URL}/api/health"
echo "  Logs: ${LOG_DIR}"

if command -v open >/dev/null 2>&1 && [[ "${NO_OPEN:-0}" != "1" ]]; then
  open "$FRONTEND_URL"
fi

if [[ -n "$backend_pid" || -n "$frontend_pid" ]]; then
  echo ""
  echo "Services started by this launcher are running. Press Ctrl+C to stop them."
  while true; do
    sleep 3600 &
    wait $!
  done
fi
