from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator


class ScriptConfig(BaseModel):
    id: str
    name: str = Field(min_length=1)
    runner: Literal["remote", "local"] = "remote"
    command: str = Field(min_length=1)
    working_dir: str = Field(min_length=1)
    args: str = ""


class ProjectConfig(BaseModel):
    id: str
    name: str = Field(min_length=1)
    path: str = Field(min_length=1)
    description: str = ""
    scripts: list[ScriptConfig] = Field(default_factory=list)


class SshAuthConfig(BaseModel):
    auth_type: Literal["key", "password"] = "key"
    password: str = ""
    key_path: str = ""
    passphrase: str = ""

    # 校验认证配置，避免出现可保存但不可执行的无效 SSH 配置。
    @model_validator(mode="after")
    def validate_auth(self) -> "SshAuthConfig":
        if self.auth_type == "key" and not self.key_path.strip():
            raise ValueError("key 认证方式必须提供 key_path")
        if self.auth_type == "password" and not self.password.strip():
            raise ValueError("password 认证方式必须提供 password")
        return self


class ServerConfig(BaseModel):
    id: str
    name: str = Field(min_length=1)
    host: str = Field(min_length=1)
    port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(min_length=1)
    extra_ipv4: str = "None"
    ram: str = ""
    cpu_cores: str = ""
    operating_system: str = ""
    location: str = ""
    notes: str = ""
    tags: list[str] = Field(default_factory=list)
    auth: SshAuthConfig
    projects: list[ProjectConfig] = Field(default_factory=list)


class AppConfig(BaseModel):
    version: str = "1.0"
    servers: list[ServerConfig] = Field(default_factory=list)


class ActionResponse(BaseModel):
    success: bool
    message: str
    stdout: str = ""
    stderr: str = ""
    exit_code: int = 0


class ServerStats(BaseModel):
    sampled_at: str
    mem_total_mb: int
    mem_used_mb: int
    mem_used_pct: int = Field(ge=0, le=100)
    load1: float
    load5: float
    load15: float
    tcp_inuse: int = Field(ge=0)
    udp_inuse: int = Field(ge=0)
    tcp_established: int = Field(ge=0)
    net_rx_bytes: int = Field(ge=0)
    net_tx_bytes: int = Field(ge=0)


class ServerStatsResponse(BaseModel):
    success: bool
    message: str
    data: ServerStats | None = None
