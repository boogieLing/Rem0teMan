#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fnmatch
import os
from pathlib import Path
import shlex
import sys
import tarfile
import tempfile
import time

import paramiko
import yaml


DEFAULT_EXCLUDES = [
    ".git",
    ".git/*",
    "node_modules",
    "node_modules/*",
    "build",
    "build/*",
    ".DS_Store",
]
DEFAULT_PRESERVE = [".env", ".env.*"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="把本地项目同步到远端并执行构建命令。")
    parser.add_argument("--config", required=True, help="servers.yaml 路径")
    parser.add_argument("--server", required=True, help="server id 或 server name")
    parser.add_argument("--local-path", required=True, help="本地项目目录")
    parser.add_argument("--remote-path", required=True, help="远端项目目录")
    parser.add_argument("--build-command", default="./docker-build.sh", help="远端构建命令")
    parser.add_argument("--connect-timeout", type=int, default=30, help="SSH 连接超时（秒）")
    parser.add_argument("--command-timeout", type=int, default=1800, help="远端命令超时（秒）")
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        help="可重复追加排除规则（glob）",
    )
    parser.add_argument(
        "--preserve",
        action="append",
        default=[],
        help="切换新版本前，从旧目录复制到新目录的一级文件名规则（glob）",
    )
    parser.add_argument(
        "--backup-keep",
        type=int,
        default=3,
        help="远端保留备份数量（默认 3）",
    )
    return parser.parse_args()


def should_exclude(rel_posix_path: str, patterns: list[str]) -> bool:
    normalized = rel_posix_path.lstrip("./")
    parts = normalized.split("/")
    for pattern in patterns:
        plain = pattern.strip().strip("/")
        if not plain:
            continue
        if fnmatch.fnmatch(normalized, pattern) or fnmatch.fnmatch(normalized, plain):
            return True
        for part in parts:
            if fnmatch.fnmatch(part, pattern) or fnmatch.fnmatch(part, plain):
                return True
    return False


def load_server(config_path: Path, server_ref: str) -> dict:
    with config_path.open("r", encoding="utf-8") as file:
        payload = yaml.safe_load(file) or {}
    servers = payload.get("servers") or []
    for server in servers:
        if server.get("id") == server_ref or server.get("name") == server_ref:
            return server
    raise RuntimeError(f"在配置中找不到服务器: {server_ref}")


def create_archive(local_path: Path, excludes: list[str]) -> tuple[Path, int, int]:
    temp_file = tempfile.NamedTemporaryFile(prefix="rsm-sync-", suffix=".tar.gz", delete=False)
    temp_path = Path(temp_file.name)
    temp_file.close()

    file_count = 0
    total_size = 0

    with tarfile.open(temp_path, "w:gz") as archive:
        for root, dirs, files in os.walk(local_path, topdown=True):
            root_path = Path(root)
            rel_root = root_path.relative_to(local_path).as_posix()
            if rel_root == ".":
                rel_root = ""

            kept_dirs: list[str] = []
            for dir_name in dirs:
                rel_dir = f"{rel_root}/{dir_name}" if rel_root else dir_name
                if should_exclude(rel_dir, excludes):
                    continue
                kept_dirs.append(dir_name)
            dirs[:] = kept_dirs

            for file_name in files:
                rel_file = f"{rel_root}/{file_name}" if rel_root else file_name
                if should_exclude(rel_file, excludes):
                    continue
                abs_file = root_path / file_name
                if not abs_file.is_file():
                    continue
                archive.add(abs_file, arcname=rel_file, recursive=False)
                file_count += 1
                total_size += abs_file.stat().st_size

    return temp_path, file_count, total_size


def build_ssh_client(server: dict, connect_timeout: int) -> paramiko.SSHClient:
    auth = server.get("auth") or {}
    auth_type = str(auth.get("auth_type") or "").strip() or "key"

    connect_kwargs: dict[str, object] = {
        "hostname": server["host"],
        "port": int(server.get("port", 22)),
        "username": server["username"],
        "timeout": connect_timeout,
        "banner_timeout": max(connect_timeout + 8, 20),
        "auth_timeout": max(connect_timeout + 8, 20),
        "look_for_keys": False,
        "allow_agent": False,
    }
    if auth_type == "password":
        connect_kwargs["password"] = auth.get("password") or ""
    else:
        key_path = str(auth.get("key_path") or "").strip()
        if not key_path:
            raise RuntimeError("key 认证缺少 key_path")
        connect_kwargs["key_filename"] = str(Path(key_path).expanduser())
        passphrase = str(auth.get("passphrase") or "").strip()
        if passphrase:
            connect_kwargs["passphrase"] = passphrase

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(**connect_kwargs)
    return client


def run_remote_command(
    client: paramiko.SSHClient,
    command: str,
    timeout_seconds: int,
) -> tuple[int, str, str]:
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout_seconds)
    _ = stdin
    exit_code = stdout.channel.recv_exit_status()
    stdout_text = stdout.read().decode("utf-8", errors="replace")
    stderr_text = stderr.read().decode("utf-8", errors="replace")
    return exit_code, stdout_text, stderr_text


def format_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes} B"
    if size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KiB"
    return f"{size_bytes / (1024 * 1024):.1f} MiB"


def build_remote_release_script(
    *,
    remote_path: str,
    remote_archive_path: str,
    build_command: str,
    preserve_patterns: list[str],
    backup_keep: int,
) -> str:
    preserve_name_terms: list[str] = []
    for pattern in preserve_patterns:
        cleaned = pattern.strip()
        if not cleaned:
            continue
        preserve_name_terms.append(f"-name {shlex.quote(cleaned)}")
    if preserve_name_terms:
        joined = " -o ".join(preserve_name_terms)
        preserve_block = (
            'find "$TARGET" -mindepth 1 -maxdepth 1 \\( '
            f"{joined}"
            ' \\) -exec cp -a {} "$STAGE_DIR"/ \\;'
        )
    else:
        preserve_block = ":"
    backup_keep_safe = max(int(backup_keep), 0)

    return f"""
set -eu
TARGET={shlex.quote(remote_path)}
ARCHIVE={shlex.quote(remote_archive_path)}
BUILD_COMMAND={shlex.quote(build_command)}
BACKUP_KEEP={backup_keep_safe}

BASE_DIR=$(dirname "$TARGET")
TARGET_NAME=$(basename "$TARGET")
RELEASE_ROOT="$BASE_DIR/.rsm_releases_${{TARGET_NAME}}"
STAMP=$(date +%Y%m%d%H%M%S)
STAGE_DIR="$RELEASE_ROOT/stage_${{STAMP}}_$$"
BACKUP_DIR="$RELEASE_ROOT/backup_${{STAMP}}_$$"
HAD_OLD=0
SWITCHED=0

rollback() {{
  rc=$?
  if [ "$SWITCHED" -eq 0 ] && [ "$HAD_OLD" -eq 1 ] && [ -d "$BACKUP_DIR" ] && [ ! -e "$TARGET" ]; then
    mv "$BACKUP_DIR" "$TARGET" || true
  fi
  rm -f "$ARCHIVE" || true
  exit "$rc"
}}
trap rollback INT TERM HUP ERR

mkdir -p "$RELEASE_ROOT"
mkdir -p "$STAGE_DIR"
tar -xzf "$ARCHIVE" -C "$STAGE_DIR"

if [ -d "$TARGET" ]; then
{preserve_block}
fi

cd "$STAGE_DIR"
/bin/sh -lc "$BUILD_COMMAND"

if [ -d "$TARGET" ]; then
  mv "$TARGET" "$BACKUP_DIR"
  HAD_OLD=1
fi
mv "$STAGE_DIR" "$TARGET"
SWITCHED=1

rm -f "$ARCHIVE"
trap - INT TERM HUP ERR

echo "RSM_DEPLOY_TARGET=$TARGET"
if [ "$HAD_OLD" -eq 1 ]; then
  echo "RSM_DEPLOY_BACKUP=$BACKUP_DIR"
fi

if [ "$BACKUP_KEEP" -gt 0 ]; then
  backup_count=0
  for old_backup in $(ls -1dt "$RELEASE_ROOT"/backup_* 2>/dev/null); do
    backup_count=$((backup_count + 1))
    if [ "$backup_count" -gt "$BACKUP_KEEP" ]; then
      rm -rf "$old_backup"
    fi
  done
fi

find "$RELEASE_ROOT" -maxdepth 1 -type d -name 'stage_*' -mtime +1 -exec rm -rf {{}} +
"""


def main() -> int:
    args = parse_args()
    config_path = Path(args.config).expanduser().resolve()
    local_path = Path(args.local_path).expanduser().resolve()
    remote_path = args.remote_path.strip()
    excludes = [*DEFAULT_EXCLUDES, *args.exclude]
    preserve_patterns = [*DEFAULT_PRESERVE, *args.preserve]

    if not config_path.exists():
        print(f"[ERROR] 配置文件不存在: {config_path}", file=sys.stderr)
        return 1
    if not local_path.exists() or not local_path.is_dir():
        print(f"[ERROR] 本地目录不存在或不是目录: {local_path}", file=sys.stderr)
        return 1
    if not remote_path:
        print("[ERROR] 远端目录不能为空", file=sys.stderr)
        return 1

    server = load_server(config_path, args.server)
    server_name = server.get("name") or server.get("id")
    print(f"[INFO] 目标服务器: {server_name}")
    print(f"[INFO] 本地目录: {local_path}")
    print(f"[INFO] 远端目录: {remote_path}")
    print(f"[INFO] 排除规则: {', '.join(excludes)}")

    archive_path: Path | None = None
    client: paramiko.SSHClient | None = None

    started_at = time.time()
    try:
        archive_path, file_count, total_size = create_archive(local_path, excludes)
        archive_name = archive_path.name
        remote_archive_path = f"/tmp/{archive_name}"
        print(f"[INFO] 打包完成: {file_count} files, {format_size(total_size)}")

        client = build_ssh_client(server, connect_timeout=args.connect_timeout)
        print("[INFO] SSH 已连接，开始上传压缩包...")
        sftp = client.open_sftp()
        try:
            sftp.put(str(archive_path), remote_archive_path)
        finally:
            sftp.close()
        print(f"[INFO] 上传完成: {remote_archive_path}")

        remote_script = build_remote_release_script(
            remote_path=remote_path,
            remote_archive_path=remote_archive_path,
            build_command=args.build_command,
            preserve_patterns=preserve_patterns,
            backup_keep=args.backup_keep,
        )
        command = f"/bin/sh -lc {shlex.quote(remote_script)}"
        print("[INFO] 远端开始分阶段发布（stage 构建 -> 成功后切换）...")
        exit_code, stdout_text, stderr_text = run_remote_command(
            client,
            command,
            timeout_seconds=args.command_timeout,
        )
        if stdout_text.strip():
            print("[REMOTE STDOUT]")
            print(stdout_text.rstrip())
        if stderr_text.strip():
            print("[REMOTE STDERR]", file=sys.stderr)
            print(stderr_text.rstrip(), file=sys.stderr)
        if exit_code != 0:
            print(f"[ERROR] 远端命令执行失败，exit={exit_code}", file=sys.stderr)
            return exit_code

        elapsed = time.time() - started_at
        print(f"[INFO] 同步完成，耗时 {elapsed:.1f}s")
        return 0
    except Exception as error:
        print(f"[ERROR] 同步失败: {error}", file=sys.stderr)
        return 1
    finally:
        if client is not None:
            client.close()
        if archive_path is not None and archive_path.exists():
            archive_path.unlink()


if __name__ == "__main__":
    raise SystemExit(main())
