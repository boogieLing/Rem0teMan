#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/.runtime"
UVICORN_BIN="${ROOT_DIR}/.venv/bin/uvicorn"
CHILD_PID_FILE="${RUNTIME_DIR}/uvicorn.pid"
UVICORN_LOG="${RUNTIME_DIR}/uvicorn.log"
SUPERVISOR_LOG="${RUNTIME_DIR}/supervisor.log"

HOST="${1:-127.0.0.1}"
PORT="${2:-8787}"

mkdir -p "${RUNTIME_DIR}"

if [[ ! -x "${UVICORN_BIN}" ]]; then
  echo "[$(date '+%F %T')] uvicorn 不存在: ${UVICORN_BIN}" >> "${SUPERVISOR_LOG}"
  exit 1
fi

child_pid=""

terminate() {
  echo "[$(date '+%F %T')] supervisor 收到停止信号" >> "${SUPERVISOR_LOG}"
  if [[ -n "${child_pid}" ]] && kill -0 "${child_pid}" 2>/dev/null; then
    kill "${child_pid}" 2>/dev/null || true
    for _ in $(seq 1 25); do
      if kill -0 "${child_pid}" 2>/dev/null; then
        sleep 0.2
      else
        break
      fi
    done
    if kill -0 "${child_pid}" 2>/dev/null; then
      kill -9 "${child_pid}" 2>/dev/null || true
    fi
  fi
  rm -f "${CHILD_PID_FILE}"
  exit 0
}

trap terminate TERM INT HUP

while true; do
  echo "[$(date '+%F %T')] 启动 uvicorn: ${HOST}:${PORT}" >> "${SUPERVISOR_LOG}"
  "${UVICORN_BIN}" app.api:create_app --factory --host "${HOST}" --port "${PORT}" >> "${UVICORN_LOG}" 2>&1 &
  child_pid="$!"
  echo "${child_pid}" > "${CHILD_PID_FILE}"

  if wait "${child_pid}"; then
    exit_code=0
  else
    exit_code=$?
  fi

  echo "[$(date '+%F %T')] uvicorn 退出，code=${exit_code}，2 秒后重启" >> "${SUPERVISOR_LOG}"
  rm -f "${CHILD_PID_FILE}"
  child_pid=""
  sleep 2

done
