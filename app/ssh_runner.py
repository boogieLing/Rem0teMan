from __future__ import annotations

from datetime import datetime, timezone
import shlex
import socket
import time
from typing import Iterator

import paramiko

from .models import (
    ActionResponse,
    ScriptConfig,
    ServerConfig,
    ServerStats,
    ServerStatsResponse,
)


class SshRunner:
    # 判断认证异常是否属于超时场景，避免把瞬时超时误判为密码错误。
    def _is_auth_timeout(self, error: paramiko.AuthenticationException) -> bool:
        return "timeout" in str(error).lower()

    # 构建 SSH 客户端连接，兼容私钥和密码两种认证方式，并对瞬时网络抖动做有限重试。
    def _build_client(self, server: ServerConfig, timeout_seconds: int = 25) -> paramiko.SSHClient:
        connect_timeout = max(timeout_seconds, 10)
        banner_timeout = max(timeout_seconds + 8, 30)
        auth_timeout = max(timeout_seconds + 8, 30)
        connect_kwargs: dict[str, object] = {
            "hostname": server.host,
            "port": server.port,
            "username": server.username,
            "timeout": connect_timeout,
            "banner_timeout": banner_timeout,
            "auth_timeout": auth_timeout,
            "look_for_keys": False,
            "allow_agent": False,
        }

        if server.auth.auth_type == "key":
            connect_kwargs["key_filename"] = server.auth.key_path
            if server.auth.passphrase.strip():
                connect_kwargs["passphrase"] = server.auth.passphrase
        else:
            connect_kwargs["password"] = server.auth.password

        retryable_errors: tuple[type[Exception], ...] = (
            socket.timeout,
            TimeoutError,
            EOFError,
            OSError,
            paramiko.SSHException,
        )
        last_error: Exception | None = None
        max_attempts = 4

        for attempt in range(1, max_attempts + 1):
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            try:
                client.connect(**connect_kwargs)
                return client
            except paramiko.AuthenticationException as error:
                client.close()
                if self._is_auth_timeout(error):
                    last_error = error
                    if attempt < max_attempts:
                        time.sleep(1.5 * attempt)
                        continue
                raise
            except retryable_errors as error:
                client.close()
                last_error = error
                if attempt < max_attempts:
                    time.sleep(1.5 * attempt)
                    continue
                raise

        if last_error is not None:
            raise last_error
        raise RuntimeError("SSH 连接失败：未知错误")

    # 测试 SSH 基础连接可用性，返回统一结构供前端展示。
    def test_connection(self, server: ServerConfig, timeout_seconds: int = 25) -> ActionResponse:
        try:
            client = self._build_client(server, timeout_seconds=timeout_seconds)
            client.close()
            return ActionResponse(success=True, message="SSH 连接成功")
        except paramiko.AuthenticationException as error:
            if self._is_auth_timeout(error):
                return ActionResponse(success=False, message=f"SSH 连接超时: {error}")
            return ActionResponse(success=False, message=f"SSH 认证失败: {error}")
        except (paramiko.SSHException, socket.error, TimeoutError, OSError) as error:
            return ActionResponse(success=False, message=f"SSH 连接失败: {error}")

    # 统一执行远端命令并返回 exit code/stdout/stderr，避免重复逻辑。
    def _exec_remote_command(
        self,
        server: ServerConfig,
        command: str,
        timeout_seconds: int,
    ) -> tuple[int, str, str]:
        client = self._build_client(server, timeout_seconds=timeout_seconds)
        try:
            stdin, stdout, stderr = client.exec_command(command, timeout=timeout_seconds)
            _ = stdin
            exit_code = stdout.channel.recv_exit_status()
            stdout_text = stdout.read().decode("utf-8", errors="replace")
            stderr_text = stderr.read().decode("utf-8", errors="replace")
            return exit_code, stdout_text, stderr_text
        finally:
            client.close()

    # 统一拼接脚本命令，保持 run 与 run-stream 语义一致。
    def _build_script_command(self, script: ScriptConfig) -> str:
        command_parts = [script.command.strip()]
        if script.args.strip():
            command_parts.append(script.args.strip())
        command = " ".join(command_parts).strip()
        return f"cd {shlex.quote(script.working_dir)} && {command}"

    # 解析 key=value 文本输出，供轻量监控命令复用。
    def _parse_kv_output(self, stdout_text: str) -> dict[str, str]:
        parsed: dict[str, str] = {}
        for line in stdout_text.splitlines():
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if key:
                parsed[key] = value
        return parsed

    # 采集远端基础监控指标，全部来自 /proc，避免高开销命令。
    def collect_server_stats(
        self,
        server: ServerConfig,
        timeout_seconds: int = 8,
    ) -> ServerStatsResponse:
        remote_script = r"""
mt=$(awk '/MemTotal/{print $2; exit}' /proc/meminfo)
ma=$(awk '/MemAvailable/{print $2; exit}' /proc/meminfo)
if [ -z "$ma" ]; then
  ma=$(awk '/MemFree/{print $2; exit}' /proc/meminfo)
fi
if [ -z "$mt" ] || [ "$mt" -le 0 ]; then
  echo "ERROR=mem_total_missing"
  exit 2
fi
if [ -z "$ma" ]; then
  ma=0
fi
mu=$((mt-ma))
if [ "$mu" -lt 0 ]; then
  mu=0
fi
mp=$((mu * 100 / mt))

set -- $(awk '{print $1, $2, $3}' /proc/loadavg)
l1=${1:-0}
l5=${2:-0}
l15=${3:-0}

tcp_inuse=$(awk '/^TCP:/{for(i=1;i<=NF;i++){if($i=="inuse"){print $(i+1); exit}}}' /proc/net/sockstat)
udp_inuse=$(awk '/^UDP:/{for(i=1;i<=NF;i++){if($i=="inuse"){print $(i+1); exit}}}' /proc/net/sockstat)
[ -z "$tcp_inuse" ] && tcp_inuse=0
[ -z "$udp_inuse" ] && udp_inuse=0

est4=$(awk 'NR>1 && $4=="01"{c++} END{print c+0}' /proc/net/tcp)
if [ -f /proc/net/tcp6 ]; then
  est6=$(awk 'NR>1 && $4=="01"{c++} END{print c+0}' /proc/net/tcp6)
else
  est6=0
fi
est=$((est4 + est6))

set -- $(awk -F'[: ]+' 'NR>2 && $1!="lo"{rx+=$3; tx+=$11} END{print rx+0, tx+0}' /proc/net/dev)
rx=${1:-0}
tx=${2:-0}

echo "mem_total_kb=$mt"
echo "mem_used_kb=$mu"
echo "mem_used_pct=$mp"
echo "load1=$l1"
echo "load5=$l5"
echo "load15=$l15"
echo "tcp_inuse=$tcp_inuse"
echo "udp_inuse=$udp_inuse"
echo "tcp_established=$est"
echo "net_rx_bytes=$rx"
echo "net_tx_bytes=$tx"
"""
        remote_command = f"/bin/sh -lc {shlex.quote(remote_script)}"

        try:
            exit_code, stdout_text, stderr_text = self._exec_remote_command(
                server,
                remote_command,
                timeout_seconds=timeout_seconds,
            )
            if exit_code != 0:
                message = "监控采集失败"
                if stderr_text.strip():
                    message = f"{message}: {stderr_text.strip()}"
                return ServerStatsResponse(success=False, message=message)

            parsed = self._parse_kv_output(stdout_text)
            if "ERROR" in parsed:
                return ServerStatsResponse(success=False, message=f"监控采集失败: {parsed['ERROR']}")

            mem_total_kb = int(parsed.get("mem_total_kb", "0"))
            mem_used_kb = int(parsed.get("mem_used_kb", "0"))
            if mem_total_kb <= 0:
                return ServerStatsResponse(success=False, message="监控采集失败: 内存数据无效")

            stats = ServerStats(
                sampled_at=datetime.now(timezone.utc).isoformat(),
                mem_total_mb=max(mem_total_kb // 1024, 0),
                mem_used_mb=max(mem_used_kb // 1024, 0),
                mem_used_pct=max(min(int(parsed.get("mem_used_pct", "0")), 100), 0),
                load1=float(parsed.get("load1", "0")),
                load5=float(parsed.get("load5", "0")),
                load15=float(parsed.get("load15", "0")),
                tcp_inuse=max(int(parsed.get("tcp_inuse", "0")), 0),
                udp_inuse=max(int(parsed.get("udp_inuse", "0")), 0),
                tcp_established=max(int(parsed.get("tcp_established", "0")), 0),
                net_rx_bytes=max(int(parsed.get("net_rx_bytes", "0")), 0),
                net_tx_bytes=max(int(parsed.get("net_tx_bytes", "0")), 0),
            )
            return ServerStatsResponse(success=True, message="监控采集成功", data=stats)
        except ValueError as error:
            return ServerStatsResponse(success=False, message=f"监控采集失败: 解析异常 {error}")
        except (paramiko.AuthenticationException, paramiko.SSHException, socket.error, TimeoutError, OSError) as error:
            return ServerStatsResponse(success=False, message=f"监控采集失败: {error}")

    # 在远端执行脚本配置，支持指定工作目录与附加参数。
    def run_script(
        self,
        server: ServerConfig,
        script: ScriptConfig,
        timeout_seconds: int = 30,
    ) -> ActionResponse:
        remote_command = self._build_script_command(script)

        try:
            exit_code, stdout_text, stderr_text = self._exec_remote_command(
                server,
                remote_command,
                timeout_seconds=timeout_seconds,
            )

            if exit_code == 0:
                return ActionResponse(
                    success=True,
                    message="脚本执行成功",
                    stdout=stdout_text,
                    stderr=stderr_text,
                    exit_code=exit_code,
                )

            return ActionResponse(
                success=False,
                message="脚本执行失败",
                stdout=stdout_text,
                stderr=stderr_text,
                exit_code=exit_code,
            )
        except (paramiko.AuthenticationException, paramiko.SSHException, socket.error, TimeoutError) as error:
            return ActionResponse(success=False, message=f"执行失败: {error}")

    # 流式执行远端脚本，按 stdout/stderr 增量产出事件。
    def run_script_stream(
        self,
        server: ServerConfig,
        script: ScriptConfig,
        timeout_seconds: int = 30,
    ) -> Iterator[dict[str, object]]:
        remote_command = self._build_script_command(script)
        client: paramiko.SSHClient | None = None

        try:
            client = self._build_client(server, timeout_seconds=timeout_seconds)
            stdin, stdout, stderr = client.exec_command(remote_command, get_pty=False)
            _ = stdin
            channel = stdout.channel

            start_time = time.monotonic()
            yield {"type": "state", "status": "running", "message": "脚本开始执行"}

            while True:
                emitted = False
                if channel.recv_ready():
                    chunk = channel.recv(4096)
                    if chunk:
                        emitted = True
                        yield {"type": "stdout", "text": chunk.decode("utf-8", errors="replace")}

                if channel.recv_stderr_ready():
                    chunk = channel.recv_stderr(4096)
                    if chunk:
                        emitted = True
                        yield {"type": "stderr", "text": chunk.decode("utf-8", errors="replace")}

                if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
                    break

                if timeout_seconds > 0 and (time.monotonic() - start_time) > timeout_seconds:
                    try:
                        channel.close()
                    except Exception:
                        pass
                    yield {
                        "type": "done",
                        "success": False,
                        "message": f"脚本执行超时（>{timeout_seconds}s）",
                        "exit_code": 124,
                    }
                    return

                if not emitted:
                    time.sleep(0.1)

            exit_code = channel.recv_exit_status()
            yield {
                "type": "done",
                "success": exit_code == 0,
                "message": "脚本执行成功" if exit_code == 0 else "脚本执行失败",
                "exit_code": exit_code,
            }
        except (paramiko.AuthenticationException, paramiko.SSHException, socket.error, TimeoutError, OSError) as error:
            yield {
                "type": "done",
                "success": False,
                "message": f"执行失败: {error}",
                "exit_code": 1,
            }
        finally:
            if client is not None:
                client.close()
