from __future__ import annotations

import os
import selectors
import shlex
import subprocess
import time
from typing import Iterator

from .models import ActionResponse, ScriptConfig


class LocalRunner:
    # 统一拼接脚本命令，语义与远端执行保持一致：cd working_dir && command args。
    def _build_shell_command(self, script: ScriptConfig) -> str:
        command_parts = [script.command.strip()]
        if script.args.strip():
            command_parts.append(script.args.strip())
        command = " ".join(command_parts).strip()
        if not command:
            return ""
        return f"cd {shlex.quote(script.working_dir)} && {command}"

    # 在本机执行脚本命令，语义与远端执行保持一致：cd working_dir && command args。
    def run_script(self, script: ScriptConfig, timeout_seconds: int = 30) -> ActionResponse:
        shell_command = self._build_shell_command(script)
        if not shell_command:
            return ActionResponse(success=False, message="脚本执行失败: 命令为空", exit_code=1)

        env = os.environ.copy()
        env.setdefault("PYTHONUNBUFFERED", "1")

        try:
            completed = subprocess.run(
                ["/bin/sh", "-lc", shell_command],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout_seconds,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=env,
            )
            if completed.returncode == 0:
                return ActionResponse(
                    success=True,
                    message="本地脚本执行成功",
                    stdout=completed.stdout,
                    stderr=completed.stderr,
                    exit_code=completed.returncode,
                )
            return ActionResponse(
                success=False,
                message="本地脚本执行失败",
                stdout=completed.stdout,
                stderr=completed.stderr,
                exit_code=completed.returncode,
            )
        except subprocess.TimeoutExpired as error:
            stdout = error.stdout or ""
            stderr = error.stderr or ""
            return ActionResponse(
                success=False,
                message=f"本地脚本执行超时（>{timeout_seconds}s）",
                stdout=stdout,
                stderr=stderr,
                exit_code=124,
            )
        except OSError as error:
            return ActionResponse(success=False, message=f"本地脚本执行失败: {error}", exit_code=1)

    # 流式执行本地脚本，按 stdout/stderr 增量产出事件。
    def run_script_stream(
        self,
        script: ScriptConfig,
        timeout_seconds: int = 30,
    ) -> Iterator[dict[str, object]]:
        shell_command = self._build_shell_command(script)
        if not shell_command:
            yield {"type": "done", "success": False, "message": "脚本执行失败: 命令为空", "exit_code": 1}
            return

        env = os.environ.copy()
        env.setdefault("PYTHONUNBUFFERED", "1")

        process: subprocess.Popen[bytes] | None = None
        selector = selectors.DefaultSelector()
        timed_out = False

        try:
            process = subprocess.Popen(
                ["/bin/sh", "-lc", shell_command],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
            )
            if process.stdout is None or process.stderr is None:
                yield {"type": "done", "success": False, "message": "本地脚本执行失败: 无法读取输出", "exit_code": 1}
                return

            selector.register(process.stdout, selectors.EVENT_READ, data="stdout")
            selector.register(process.stderr, selectors.EVENT_READ, data="stderr")
            start_time = time.monotonic()
            yield {"type": "state", "status": "running", "message": "脚本开始执行"}

            while True:
                if timeout_seconds > 0 and (time.monotonic() - start_time) > timeout_seconds and process.poll() is None:
                    timed_out = True
                    process.kill()

                events = selector.select(timeout=0.15)
                for key, _ in events:
                    stream_type = str(key.data)
                    file_obj = key.fileobj
                    chunk = file_obj.read1(4096) if hasattr(file_obj, "read1") else file_obj.read(4096)
                    if not chunk:
                        try:
                            selector.unregister(file_obj)
                        except Exception:
                            pass
                        continue
                    yield {"type": stream_type, "text": chunk.decode("utf-8", errors="replace")}

                if process.poll() is not None and not events and selector.get_map():
                    for registered in list(selector.get_map().values()):
                        try:
                            selector.unregister(registered.fileobj)
                        except Exception:
                            pass

                if process.poll() is not None and not selector.get_map():
                    break

            exit_code = process.wait()
            if timed_out:
                yield {
                    "type": "done",
                    "success": False,
                    "message": f"本地脚本执行超时（>{timeout_seconds}s）",
                    "exit_code": 124,
                }
                return

            yield {
                "type": "done",
                "success": exit_code == 0,
                "message": "本地脚本执行成功" if exit_code == 0 else "本地脚本执行失败",
                "exit_code": exit_code,
            }
        except OSError as error:
            yield {"type": "done", "success": False, "message": f"本地脚本执行失败: {error}", "exit_code": 1}
        finally:
            try:
                selector.close()
            except Exception:
                pass
            if process is not None and process.poll() is None:
                process.kill()
