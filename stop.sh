#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${ROOT_DIR}/.runtime"
SUPERVISOR_PID_FILE="${RUNTIME_DIR}/supervisor.pid"
CHILD_PID_FILE="${RUNTIME_DIR}/uvicorn.pid"
HOST="${RSM_HOST:-127.0.0.1}"
PORT="${RSM_PORT:-8787}"

pid_cmd() {
  local pid="$1"
  ps -p "${pid}" -o command= 2>/dev/null || true
}

stop_pid() {
  local pid="$1"
  if ! kill -0 "${pid}" 2>/dev/null; then
    return 0
  fi

  kill "${pid}" 2>/dev/null || true
  for _ in $(seq 1 25); do
    if kill -0 "${pid}" 2>/dev/null; then
      sleep 0.2
    else
      break
    fi
  done

  if kill -0 "${pid}" 2>/dev/null; then
    kill -9 "${pid}" 2>/dev/null || true
  fi
}

find_supervisor_pid() {
  if [[ -f "${SUPERVISOR_PID_FILE}" ]]; then
    local pid
    pid="$(cat "${SUPERVISOR_PID_FILE}" 2>/dev/null || true)"
    if [[ "${pid}" =~ ^[0-9]+$ ]] && kill -0 "${pid}" 2>/dev/null; then
      local cmd
      cmd="$(pid_cmd "${pid}")"
      if [[ "${cmd}" == *"scripts/daemon_runner.sh"* ]]; then
        echo "${pid}"
        return 0
      fi
    fi
  fi

  local pid
  pid="$(pgrep -f "${ROOT_DIR}/scripts/daemon_runner.sh" | head -n 1 || true)"
  if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
    echo "${pid}"
    return 0
  fi

  return 1
}

find_uvicorn_pid() {
  if [[ -f "${CHILD_PID_FILE}" ]]; then
    local pid
    pid="$(cat "${CHILD_PID_FILE}" 2>/dev/null || true)"
    if [[ "${pid}" =~ ^[0-9]+$ ]] && kill -0 "${pid}" 2>/dev/null; then
      local cmd
      cmd="$(pid_cmd "${pid}")"
      if [[ "${cmd}" == *"uvicorn app.api:create_app --factory"* ]]; then
        echo "${pid}"
        return 0
      fi
    fi
  fi

  local listen_pid
  listen_pid="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
  if [[ -n "${listen_pid}" ]] && kill -0 "${listen_pid}" 2>/dev/null; then
    local cmd
    cmd="$(pid_cmd "${listen_pid}")"
    if [[ "${cmd}" == *"uvicorn app.api:create_app --factory"* ]]; then
      echo "${listen_pid}"
      return 0
    fi
  fi

  return 1
}

stopped=0

if supervisor_pid="$(find_supervisor_pid)"; then
  stop_pid "${supervisor_pid}"
  stopped=1
fi

if uvicorn_pid="$(find_uvicorn_pid)"; then
  stop_pid "${uvicorn_pid}"
  stopped=1
fi

rm -f "${SUPERVISOR_PID_FILE}" "${CHILD_PID_FILE}"

if [[ "${stopped}" -eq 1 ]]; then
  echo "服务已停止: ${HOST}:${PORT}"
else
  echo "未检测到运行中的服务。"
fi
