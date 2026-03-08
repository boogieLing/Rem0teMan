from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config_store import ConfigStore
from .local_runner import LocalRunner
from .models import ActionResponse, AppConfig, ServerStatsResponse
from .ssh_runner import SshRunner


class TimeoutRequest(BaseModel):
    timeout_seconds: int = Field(default=25, ge=1, le=120)


class RunScriptRequest(BaseModel):
    timeout_seconds: int = Field(default=600, ge=1, le=1800)


# 创建 FastAPI 应用并注册全部路由，作为项目唯一入口函数。
def create_app(base_dir: Path | None = None) -> FastAPI:
    resolved_base_dir = base_dir or Path(__file__).resolve().parent.parent
    config_path = resolved_base_dir / "config" / "servers.yaml"
    frontend_dir = resolved_base_dir / "frontend"

    store = ConfigStore(config_path=config_path)
    ssh_runner = SshRunner()
    local_runner = LocalRunner()

    app = FastAPI(title="Remote Server Manager", version="1.0.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.mount("/assets", StaticFiles(directory=frontend_dir), name="assets")

    # 返回当前全量配置，前端基于该数据做本地渲染与编辑。
    @app.get("/api/config", response_model=AppConfig)
    def get_config() -> AppConfig:
        return store.load_config()

    # 持久化配置变更，统一走模型校验确保结构合法。
    @app.put("/api/config", response_model=AppConfig)
    def update_config(payload: AppConfig) -> AppConfig:
        store.save_config(payload)
        return payload

    # 测试指定服务器 SSH 连接是否可达。
    @app.post("/api/servers/{server_id}/test-connection", response_model=ActionResponse)
    def test_connection(server_id: str, payload: TimeoutRequest) -> ActionResponse:
        config = store.load_config()
        server = store.get_server(config, server_id)
        if server is None:
            raise HTTPException(status_code=404, detail="服务器不存在")
        return ssh_runner.test_connection(server, timeout_seconds=payload.timeout_seconds)

    # 轻量采集远端基础指标，全部读取 /proc，适合定时轮询。
    @app.get("/api/servers/{server_id}/stats", response_model=ServerStatsResponse)
    def get_server_stats(
        server_id: str,
        timeout_seconds: int = Query(default=8, ge=1, le=60),
    ) -> ServerStatsResponse:
        config = store.load_config()
        server = store.get_server(config, server_id)
        if server is None:
            raise HTTPException(status_code=404, detail="服务器不存在")
        return ssh_runner.collect_server_stats(server, timeout_seconds=timeout_seconds)

    # 远端执行指定脚本配置，并返回标准输出与错误输出。
    @app.post(
        "/api/servers/{server_id}/projects/{project_id}/scripts/{script_id}/run",
        response_model=ActionResponse,
    )
    # 执行指定项目脚本，串联 server/project/script 三层校验后调用 SSH 执行器。
    def run_script(
        server_id: str,
        project_id: str,
        script_id: str,
        payload: RunScriptRequest,
    ) -> ActionResponse:
        config = store.load_config()
        server = store.get_server(config, server_id)
        if server is None:
            raise HTTPException(status_code=404, detail="服务器不存在")

        project = store.get_project(server, project_id)
        if project is None:
            raise HTTPException(status_code=404, detail="项目不存在")

        script = store.get_script(project, script_id)
        if script is None:
            raise HTTPException(status_code=404, detail="脚本不存在")

        if script.runner == "local":
            return local_runner.run_script(script, timeout_seconds=payload.timeout_seconds)

        return ssh_runner.run_script(server, script, timeout_seconds=payload.timeout_seconds)

    # 流式执行脚本，前端可按行增量消费输出并更新执行态。
    @app.post("/api/servers/{server_id}/projects/{project_id}/scripts/{script_id}/run-stream")
    def run_script_stream(
        server_id: str,
        project_id: str,
        script_id: str,
        payload: RunScriptRequest,
    ) -> StreamingResponse:
        config = store.load_config()
        server = store.get_server(config, server_id)
        if server is None:
            raise HTTPException(status_code=404, detail="服务器不存在")

        project = store.get_project(server, project_id)
        if project is None:
            raise HTTPException(status_code=404, detail="项目不存在")

        script = store.get_script(project, script_id)
        if script is None:
            raise HTTPException(status_code=404, detail="脚本不存在")

        if script.runner == "local":
            event_iter = local_runner.run_script_stream(script, timeout_seconds=payload.timeout_seconds)
        else:
            event_iter = ssh_runner.run_script_stream(server, script, timeout_seconds=payload.timeout_seconds)

        def ndjson_stream():
            for event in event_iter:
                yield f"{json.dumps(event, ensure_ascii=False)}\n"

        return StreamingResponse(
            ndjson_stream(),
            media_type="application/x-ndjson",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    # 提供前端入口页面。
    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(frontend_dir / "index.html")

    return app
