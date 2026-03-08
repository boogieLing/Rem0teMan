#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PY_BIN="$ROOT_DIR/.venv/bin/python"

if [ ! -x "$PY_BIN" ]; then
    PY_BIN="python3"
fi

if ! "$PY_BIN" -c "import paramiko, yaml" >/dev/null 2>&1; then
    echo "[ERROR] Python 环境缺少依赖 paramiko/yaml，请先在 RemoteServerMan 目录安装依赖。" >&2
    echo "        建议执行: cd $ROOT_DIR && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt" >&2
    exit 1
fi

"$PY_BIN" "$SCRIPT_DIR/local_sync_project.py" \
    --config "$ROOT_DIR/config/servers.yaml" \
    --server "tencent-cloud" \
    --local-path "/Volumes/R0sORICO/work_dir/r0website_server" \
    --remote-path "/www/wwwroot/www.r0r0.pink/r0website_server" \
    --build-command "bash ./docker-build.sh" \
    --exclude ".runtime" \
    --exclude ".venv" \
    --exclude "*.log"
