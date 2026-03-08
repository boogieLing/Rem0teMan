from __future__ import annotations

from pathlib import Path

import yaml

from .models import AppConfig, ProjectConfig, ScriptConfig, ServerConfig


class ConfigStore:
    # 初始化配置存储，固定配置文件路径供后续读取与落盘复用。
    def __init__(self, config_path: Path) -> None:
        self._config_path = config_path

    # 加载配置文件；不存在时自动生成默认结构，确保前端首次打开可正常工作。
    def load_config(self) -> AppConfig:
        if not self._config_path.exists():
            default_config = AppConfig()
            self.save_config(default_config)
            return default_config

        with self._config_path.open("r", encoding="utf-8") as file:
            loaded = yaml.safe_load(file) or {}

        return AppConfig.model_validate(loaded)

    # 保存全量配置，统一使用 UTF-8 和有序输出，保证手工编辑体验稳定。
    def save_config(self, config: AppConfig) -> None:
        self._config_path.parent.mkdir(parents=True, exist_ok=True)
        payload = config.model_dump(mode="json")
        with self._config_path.open("w", encoding="utf-8") as file:
            yaml.safe_dump(payload, file, allow_unicode=True, sort_keys=False)

    # 根据 server_id 获取服务器配置，用于连接测试和脚本执行。
    def get_server(self, config: AppConfig, server_id: str) -> ServerConfig | None:
        return next((server for server in config.servers if server.id == server_id), None)

    # 在指定服务器下定位项目，提供统一查找逻辑。
    def get_project(self, server: ServerConfig, project_id: str) -> ProjectConfig | None:
        return next((project for project in server.projects if project.id == project_id), None)

    # 在指定项目下定位脚本，避免 API 层重复遍历逻辑。
    def get_script(self, project: ProjectConfig, script_id: str) -> ScriptConfig | None:
        return next((script for script in project.scripts if script.id == script_id), None)
