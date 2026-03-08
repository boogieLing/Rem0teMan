#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${ROOT_DIR}/.runtime"
SUPERVISOR_SCRIPT="${ROOT_DIR}/scripts/daemon_runner.sh"
SUPERVISOR_PID_FILE="${RUNTIME_DIR}/supervisor.pid"
CHILD_PID_FILE="${RUNTIME_DIR}/uvicorn.pid"
UVICORN_LOG="${RUNTIME_DIR}/uvicorn.log"
SUPERVISOR_LOG="${RUNTIME_DIR}/supervisor.log"

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

wait_until_ready() {
  for _ in $(seq 1 60); do
    if curl -fsS "http://${HOST}:${PORT}/api/config" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

if [[ ! -x "${SUPERVISOR_SCRIPT}" ]]; then
  echo "未找到或不可执行: ${SUPERVISOR_SCRIPT}" >&2
  exit 1
fi

mkdir -p "${RUNTIME_DIR}"

if old_supervisor_pid="$(find_supervisor_pid)"; then
  echo "检测到已运行 supervisor PID=${old_supervisor_pid}，执行重启。"
  stop_pid "${old_supervisor_pid}"
fi

if old_uvicorn_pid="$(find_uvicorn_pid)"; then
  echo "检测到已运行 uvicorn PID=${old_uvicorn_pid}，执行重启。"
  stop_pid "${old_uvicorn_pid}"
fi

nohup "${SUPERVISOR_SCRIPT}" "${HOST}" "${PORT}" >/dev/null 2>&1 < /dev/null &
supervisor_pid="$!"
disown "${supervisor_pid}" 2>/dev/null || true
echo "${supervisor_pid}" > "${SUPERVISOR_PID_FILE}"

if wait_until_ready; then
  child_pid="$(cat "${CHILD_PID_FILE}" 2>/dev/null || true)"
  echo "服务已启动: http://${HOST}:${PORT} (supervisor=${supervisor_pid}, uvicorn=${child_pid})"
  exit 0
fi

echo "启动失败，请检查日志: ${SUPERVISOR_LOG} / ${UVICORN_LOG}" >&2
tail -n 80 "${SUPERVISOR_LOG}" 2>/dev/null || true
tail -n 80 "${UVICORN_LOG}" 2>/dev/null || true
stop_pid "${supervisor_pid}"
rm -f "${SUPERVISOR_PID_FILE}" "${CHILD_PID_FILE}"
exit 1
