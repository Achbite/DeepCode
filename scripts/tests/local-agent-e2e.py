#!/usr/bin/env python3
"""验证本地 fixture Provider、两轮工具调用和共享投影；不承担真实 Provider 或发布验收。"""

from __future__ import annotations

import http.server
import json
import os
import secrets
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[2]
HOST_TOKEN_HEADER = "x-deepcode-host-shell-token"
COMMAND_VERSION = "deepcode.command.v3"
GENERATION_ONE = "SKILL_GENERATION_ONE"
GENERATION_TWO = "SKILL_GENERATION_TWO"
ATTACHMENT_CONTENT = "LOCAL_ATTACHMENT_CONTENT_MUST_NOT_REACH_PROVIDER"
PDF_CONTENT = "DEEPCODE_FIRST_PARTY_PDF_BINDING_OK"
CORE_TOOL_NAMES = [
    "fs.read", "fs.write", "fs.edit", "fs.delete",
    "bash", "web.search", "web.fetch", "session.read", "skill.read",
]
FIRST_PARTY_TOOL_OWNERS = {
    "github.search": "plugin://github@first-party",
    "github.read": "plugin://github@first-party",
    "arxiv.search": "plugin://arxiv@first-party",
    "arxiv.read": "plugin://arxiv@first-party",
    "pdf.read": "plugin://pdf@first-party",
}
FIRST_PARTY_PLUGIN_URIS = set(FIRST_PARTY_TOOL_OWNERS.values())
URL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def runtime_path(environment_name: str, default: Path) -> Path:
    configured = os.environ.get(environment_name)
    return Path(configured).resolve() if configured else default


DAEMON_BINARY = runtime_path(
    "DEEPCODE_E2E_DAEMON",
    ROOT / "target" / "debug" / "deepcode-kernel-daemon",
)
CLI_BINARY = runtime_path(
    "DEEPCODE_E2E_CLI",
    ROOT / "target" / "debug" / "deepcode-cli",
)
TUI_BINARY = runtime_path(
    "DEEPCODE_E2E_TUI",
    ROOT / "target" / "debug" / "deepcode-tui",
)
SESSION_BRIDGE = runtime_path(
    "DEEPCODE_E2E_SESSION_BRIDGE",
    ROOT / "userspace" / "session-core" / "dist" / "sessionServiceBridge.js",
)
MCP_SERVER = ROOT / "fixtures" / "skill-mcp-smoke" / "mcp" / "mcp-text-tools" / "server.py"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


class ProviderState:
    """Routes deterministic fixture responses by request order, never by prompt text."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._requests: list[dict[str, Any]] = []
        self._failures: list[str] = []
        self._old_wire_name: str | None = None
        self._new_wire_name: str | None = None
        self._daemon: OwnedDaemon | None = None
        self._session_id: str | None = None
        self._consumed_receipts: set[str] = set()
        self._last_receipt_sequence = 0
        self.first_request_started = threading.Event()
        self.release_first_request = threading.Event()

    def bind_session(self, daemon: OwnedDaemon, session_id: str) -> None:
        require(self._daemon is None, "Provider fixture 已绑定 Session")
        self._daemon = daemon
        self._session_id = session_id

    def register(self, body: dict[str, Any]) -> int:
        require(body.get("stream") is True, "Provider 请求未使用流式链路")
        require(isinstance(body.get("messages"), list), "Provider 请求缺少 messages")
        require(isinstance(body.get("tools"), list), "Provider 请求缺少 tools")
        with self._lock:
            self._requests.append(body)
            return len(self._requests)

    def inspect(self, ordinal: int, body: dict[str, Any]) -> dict[str, str]:
        tools_by_name = self.current_receipt_tools(ordinal, body)
        messages = body["messages"]
        joined = "\n".join(
            message_text(message.get("content"))
            for message in messages
            if isinstance(message, dict)
        )
        guidance_messages = [
            message_text(message.get("content"))
            for message in messages
            if isinstance(message, dict)
            and message.get("role") == "system"
            and message_text(message.get("content")).startswith("Active tool guidance:")
        ]
        require(len(guidance_messages) == 1, "Provider 请求没有唯一的基础工具 guidance")
        guidance = guidance_messages[0]
        require(
            f"- {tools_by_name['fs.read']['wireName']}: Read UTF-8 workspace text directly or in bounded segments."
            in guidance,
            "fs.read prompt snippet 未进入 Provider 请求",
        )
        require(
            "instead of shell commands such as cat or sed" in guidance,
            "fs.read 优先于 shell 文本读取的 guidance 缺失",
        )
        require(
            f"- {tools_by_name['bash']['wireName']}: List, search, discover, build, test, and run commands."
            in guidance,
            "bash prompt snippet 未进入 Provider 请求",
        )
        require(
            "Do not use this as the default way to read a known UTF-8 workspace text file."
            in guidance,
            "bash 与 fs.read 的职责边界 guidance 缺失",
        )
        require(
            f"- {tools_by_name['web.fetch']['wireName']}: Read bounded text from a known HTTP or HTTPS URL."
            in guidance,
            "web.fetch prompt snippet 未进入 Provider 请求",
        )
        require(
            "Do not use this as a substitute for unavailable search by guessing URLs"
            in guidance,
            "web.fetch 与搜索的职责边界 guidance 缺失",
        )
        require("filesystem or Bash tools" not in joined, "附件文本仍在指示 Bash 读取")
        mcp_server_id = "fixture-old" if ordinal <= 2 else "fixture-new"
        reverse_tool = tools_by_name.get(f"mcp.{mcp_server_id}.text.reverse")
        require(isinstance(reverse_tool, dict), "Provider 请求缺少当前代次的 MCP reverse 工具")
        require(
            reverse_tool.get("origin") == "extension"
            and reverse_tool.get("pluginUri") == f"plugin://{mcp_server_id}@mcp",
            "MCP reverse 工具没有绑定当前代次的 plugin owner",
        )
        wire_name = reverse_tool["wireName"]
        for name, plugin_uri in FIRST_PARTY_TOOL_OWNERS.items():
            tool = tools_by_name.get(name)
            require(
                isinstance(tool, dict)
                and tool.get("origin") == "extension"
                and tool.get("pluginUri") == plugin_uri,
                f"Provider 请求缺少精确 first-party 工具与 owner：{name}",
            )
        require(
            "Search GitHub repositories, code, and issues through GitHub's native API." in guidance
            and "Search arXiv paper metadata through its native Atom API." in guidance
            and "Read bounded page ranges from a PDF attached to the current workspace binding."
            in guidance,
            "first-party tool prompt contribution 未进入 Provider 请求",
        )
        results = {
            str(message.get("tool_call_id")): message_text(message.get("content"))
            for message in messages
            if isinstance(message, dict)
            and message.get("role") == "tool"
            and isinstance(message.get("tool_call_id"), str)
        }

        if ordinal == 1:
            require(GENERATION_ONE in joined, "第一轮首个请求未加载旧 Skill generation")
            require(GENERATION_TWO not in joined, "第一轮首个请求提前加载新 Skill generation")
            require('"workspace":"workspace2"' in joined, "文件引用未使用逻辑 workspace handle")
            require('"path":"e2e-note.txt"' in joined, "文件引用逻辑路径未进入首轮请求")
            require('"mediaType":"text/plain"' in joined, "文件引用 mediaType 未进入首轮请求")
            require(ATTACHMENT_CONTENT not in joined, "文件内容被错误嵌入首轮 Provider 请求")
            with self._lock:
                self._old_wire_name = wire_name
            self.first_request_started.set()
        elif ordinal == 2:
            require(GENERATION_ONE in joined, "同一 run 的 continuation 丢失旧 Skill snapshot")
            require(GENERATION_TWO not in joined, "同一 run 的 continuation 被新 Skill 改写")
            require(wire_name == self.old_wire_name(), "同一 run 的 MCP 工具目录发生变化")
            require(
                any("ahpla" in content for content in results.values()),
                "第一轮 MCP ToolRecord 未进入 Provider continuation",
            )
            require(
                any("Fixture search result" in content for content in results.values()),
                "第一轮 web.search ToolRecord 未进入 Provider continuation",
            )
            require(
                any("web-fetch-ok" in content for content in results.values()),
                "第一轮 web.fetch ToolRecord 未进入 Provider continuation",
            )
            require(
                any(ATTACHMENT_CONTENT in content for content in results.values()),
                "第一轮 fs.read 未按逻辑引用惰性读取文件快照",
            )
            require(
                any(PDF_CONTENT in content for content in results.values()),
                "第一轮 pdf.read 未从 Kernel prepared workspace binding 提取正文",
            )
        elif ordinal == 3:
            require(GENERATION_TWO in joined, "下一 run 未加载新 Skill generation")
            require(GENERATION_ONE not in joined, "下一 run 仍暴露旧 Skill generation")
            require(wire_name != self.old_wire_name(), "下一 run 未取得新的 MCP wire tool")
            with self._lock:
                self._new_wire_name = wire_name
        elif ordinal == 4:
            require(GENERATION_TWO in joined, "第二轮 continuation 丢失新 Skill snapshot")
            require(GENERATION_ONE not in joined, "第二轮 continuation 混入旧 Skill snapshot")
            require(wire_name == self.new_wire_name(), "第二轮 continuation 的 MCP 目录漂移")
            require(
                any("ateb" in content for content in results.values()),
                "第二轮 MCP ToolRecord 未进入 Provider continuation",
            )
            require(
                any("Fixture search result" in content for content in results.values()),
                "第二轮 web.search ToolRecord 未进入 Provider continuation",
            )
            require(
                any("web-fetch-ok" in content for content in results.values()),
                "第二轮 web.fetch ToolRecord 未进入 Provider continuation",
            )
        else:
            raise AssertionError(f"Provider 收到未登记的第 {ordinal} 个请求")
        return {
            "read": tools_by_name["fs.read"]["wireName"],
            "reverse": wire_name,
            "pdf": tools_by_name["pdf.read"]["wireName"],
            "search": tools_by_name["web.search"]["wireName"],
            "fetch": tools_by_name["web.fetch"]["wireName"],
        }

    def current_receipt_tools(
        self,
        ordinal: int,
        body: dict[str, Any],
    ) -> dict[str, dict[str, Any]]:
        require(self._daemon is not None and self._session_id is not None, "Provider fixture 尚未绑定 Session")
        current = projection(self._daemon, self._session_id)
        run = current.get("run")
        require(isinstance(run, dict) and run.get("status") == "running", "Provider 请求没有当前 running run")
        receipts = current.get("contextCompositions")
        require(isinstance(receipts, list), "当前投影缺少 context receipt")
        with self._lock:
            require(len(self._consumed_receipts) == ordinal - 1, "Provider 请求与 context receipt 消费次序不一致")
            pending = [
                receipt for receipt in receipts
                if isinstance(receipt, dict)
                and receipt.get("runId") == run.get("runId")
                and receipt.get("providerRequestId") not in self._consumed_receipts
            ]
            require(len(pending) == 1, "当前 run 没有唯一未消费的 context receipt")
            receipt = pending[0]
            request_id = receipt.get("providerRequestId")
            sequence = receipt.get("sequence")
            require(isinstance(request_id, str) and bool(request_id), "context receipt 缺少 Provider requestId")
            require(
                isinstance(sequence, int) and sequence > self._last_receipt_sequence,
                "context receipt sequence 没有前进",
            )
            require(receipt.get("purpose") == "agent", "fixture Provider 请求关联到错误的 context purpose")
            self._consumed_receipts.add(request_id)
            self._last_receipt_sequence = sequence

        receipt_tools = receipt.get("tools")
        require(isinstance(receipt_tools, list) and bool(receipt_tools), "context receipt 工具目录为空")
        tools_by_name: dict[str, dict[str, Any]] = {}
        wire_names: list[str] = []
        for tool in receipt_tools:
            require(isinstance(tool, dict), "context receipt 工具不是对象")
            canonical_name = tool.get("canonicalName")
            wire_name = tool.get("wireName")
            require(
                isinstance(canonical_name, str) and bool(canonical_name)
                and isinstance(wire_name, str) and bool(wire_name)
                and canonical_name not in tools_by_name and wire_name not in wire_names
                and tool.get("availability") == "callable",
                "context receipt 的 canonical/wire 映射缺失、重复或不可调用",
            )
            tools_by_name[canonical_name] = tool
            wire_names.append(wire_name)
        provider_wire_names = [
            item.get("function", {}).get("name")
            if isinstance(item, dict) and isinstance(item.get("function"), dict) else None
            for item in body["tools"]
        ]
        require(provider_wire_names == wire_names, "Provider 请求的工具目录与当前 context receipt 不一致")
        require(
            [tool["canonicalName"] for tool in receipt_tools if tool.get("origin") == "coreBuiltin"]
            == CORE_TOOL_NAMES,
            "Provider 基础九工具没有保持精确集合与顺序",
        )
        return tools_by_name

    def first_started(self) -> bool:
        self.assert_healthy()
        return self.first_request_started.is_set()

    def record_failure(self, error: BaseException) -> None:
        with self._lock:
            self._failures.append(f"{type(error).__name__}: {error}")

    def assert_healthy(self) -> None:
        with self._lock:
            failure = self._failures[0] if self._failures else None
        if failure is not None:
            raise AssertionError(f"Mock Provider 失败：{failure}")

    def count(self) -> int:
        with self._lock:
            return len(self._requests)

    def old_wire_name(self) -> str:
        with self._lock:
            value = self._old_wire_name
        require(value is not None, "旧 MCP wire name 尚未捕获")
        return value

    def new_wire_name(self) -> str:
        with self._lock:
            value = self._new_wire_name
        require(value is not None, "新 MCP wire name 尚未捕获")
        return value


class MockProviderHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def provider_state(self) -> ProviderState:
        return self.server.provider_state  # type: ignore[attr-defined]

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        headers_sent = False
        try:
            require(self.path.endswith("/chat/completions"), "Provider endpoint 不匹配")
            require(self.headers.get("authorization") == "Bearer e2e-key", "Provider 凭据不匹配")
            length = int(self.headers.get("content-length", "0"))
            require(0 < length <= 8 * 1024 * 1024, "Provider 请求长度无效")
            body = json.loads(self.rfile.read(length))
            require(isinstance(body, dict), "Provider body 不是对象")
            ordinal = self.provider_state.register(body)
            wire_names = self.provider_state.inspect(ordinal, body)

            self.send_response(200)
            self.send_header("content-type", "text/event-stream; charset=utf-8")
            self.send_header("cache-control", "no-cache")
            self.send_header("connection", "close")
            self.end_headers()
            headers_sent = True

            if ordinal == 1:
                require(
                    self.provider_state.release_first_request.wait(timeout=20),
                    "等待第一轮运行时更新超时",
                )
                self._send_tool_calls([
                    ("provider-call-read-one", wire_names["read"], {
                        "workspace": "workspace2",
                        "path": "e2e-note.txt",
                    }),
                    ("provider-call-one", wire_names["reverse"], {"text": "alpha"}),
                    ("provider-call-pdf-one", wire_names["pdf"], {
                        "workspace": "primary",
                        "path": "fixture.pdf",
                        "startPage": 1,
                        "endPage": 1,
                    }),
                    ("provider-call-search-one", wire_names["search"], {
                        "query": "fixture",
                        "limit": 1,
                    }),
                    ("provider-call-fetch-one", wire_names["fetch"], {
                        "url": f"http://127.0.0.1:{self.server.server_port}/fixture-resource",
                    }),
                ])
            elif ordinal == 2:
                self._send_text("round-one-complete")
            elif ordinal == 3:
                self._send_tool_calls([
                    ("provider-call-two", wire_names["reverse"], {"text": "beta"}),
                    ("provider-call-search-two", wire_names["search"], {
                        "query": "fixture",
                        "limit": 1,
                    }),
                    ("provider-call-fetch-two", wire_names["fetch"], {
                        "url": f"http://127.0.0.1:{self.server.server_port}/fixture-resource",
                    }),
                ])
            elif ordinal == 4:
                self._send_text("round-two-complete")
        except (BrokenPipeError, ConnectionResetError):
            return
        except BaseException as error:
            self.provider_state.record_failure(error)
            if not headers_sent:
                self.send_error(500)
            self.close_connection = True

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/fixture-resource":
            encoded = b"web-fetch-ok"
            self.send_response(200)
            self.send_header("content-type", "text/plain; charset=utf-8")
        elif parsed.path == "/search":
            encoded = json.dumps({
                "results": [{
                    "title": "Fixture search result",
                    "url": f"http://127.0.0.1:{self.server.server_port}/fixture-resource",
                    "snippet": "Local deterministic search evidence.",
                }],
            }, separators=(",", ":")).encode("utf-8")
            self.send_response(200)
            self.send_header("content-type", "application/json")
        else:
            self.send_error(404)
            return
        self.send_header("content-length", str(len(encoded)))
        self.send_header("connection", "close")
        self.end_headers()
        self.wfile.write(encoded)
        self.close_connection = True

    def _send_tool_calls(
        self,
        calls: list[tuple[str, str, dict[str, Any]]],
    ) -> None:
        self._send_payload({
            "choices": [{
                "index": 0,
                "delta": {
                    "tool_calls": [{
                        "index": index,
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": json.dumps(arguments, separators=(",", ":")),
                        },
                    } for index, (call_id, name, arguments) in enumerate(calls)],
                },
                "finish_reason": "tool_calls",
            }],
            "usage": provider_usage(),
        })
        self._send_done()

    def _send_text(self, content: str) -> None:
        self._send_payload({
            "choices": [{
                "index": 0,
                "delta": {"content": content},
                "finish_reason": "stop",
            }],
            "usage": provider_usage(),
        })
        self._send_done()

    def _send_payload(self, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        self.wfile.write(f"data: {encoded}\n\n".encode("utf-8"))
        self.wfile.flush()

    def _send_done(self) -> None:
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        self.close_connection = True

    def log_message(self, _format: str, *_args: object) -> None:
        return


class MockProviderServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, state: ProviderState) -> None:
        super().__init__(("127.0.0.1", 0), MockProviderHandler)
        self.provider_state = state


def provider_usage() -> dict[str, Any]:
    return {
        "prompt_tokens": 100,
        "completion_tokens": 10,
        "prompt_tokens_details": {"cached_tokens": 40},
    }


def message_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def write_pdf_fixture(path: Path, text: str) -> None:
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream = f"BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET\n".encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"
        ),
        b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n"
        + stream + b"endstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    encoded = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, value in enumerate(objects, start=1):
        offsets.append(len(encoded))
        encoded.extend(f"{index} 0 obj\n".encode("ascii"))
        encoded.extend(value)
        encoded.extend(b"\nendobj\n")
    xref_offset = len(encoded)
    encoded.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    encoded.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        encoded.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    encoded.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n"
        ).encode("ascii")
    )
    path.write_bytes(encoded)


class OwnedDaemon:
    def __init__(self, config_root: Path) -> None:
        self.config_root = config_root
        self.token = f"dchost_{secrets.token_hex(32)}"
        self.instance_id = f"dcinstance_{secrets.token_hex(32)}"
        self.port = free_port()
        self.base_url = f"http://127.0.0.1:{self.port}"
        self.log_file = tempfile.TemporaryFile(mode="w+b")
        self.process: subprocess.Popen[bytes] | None = None
        self.identity: dict[str, Any] | None = None

    def start(self) -> None:
        node = shutil.which("node")
        require(node is not None, "找不到 Node runtime")
        require(DAEMON_BINARY.is_file(), f"缺少 Daemon：{DAEMON_BINARY}")
        require(SESSION_BRIDGE.is_file(), f"缺少 Session bridge：{SESSION_BRIDGE}")
        environment = os.environ.copy()
        for name in list(environment):
            if name.lower() in {"http_proxy", "https_proxy", "all_proxy"}:
                environment.pop(name, None)
        environment.update({
            "DEEPCODE_HOST": "127.0.0.1",
            "DEEPCODE_PORT": str(self.port),
            "DEEPCODE_CONFIG_DIR": str(self.config_root),
            "DEEPCODE_HOST_SHELL_TOKEN": self.token,
            "DEEPCODE_HOST_INSTANCE_ID": self.instance_id,
            "DEEPCODE_SESSION_BRIDGE": str(SESSION_BRIDGE),
            "DEEPCODE_NODE": node,
            "DEEPCODE_LLM_API_KEY": "e2e-key",
            "NO_PROXY": "127.0.0.1,localhost",
            "no_proxy": "127.0.0.1,localhost",
            "RUST_BACKTRACE": "1",
        })
        self.process = subprocess.Popen(
            [str(DAEMON_BINARY)],
            cwd=ROOT,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=self.log_file,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

        def ready() -> dict[str, Any] | None:
            if self.process is not None and self.process.poll() is not None:
                raise AssertionError(
                    f"Daemon 提前退出 code={self.process.returncode}\n{self.log_tail()}"
                )
            try:
                value = api_json(self.base_url, "/api/host/identity")
                return value if isinstance(value, dict) else None
            except (OSError, ValueError, urllib.error.URLError):
                return None

        self.identity = wait_until(ready, 12, "Daemon 未进入 ready")
        require(self.identity.get("instanceId") == self.instance_id, "Daemon identity 不匹配")

    def shutdown(self) -> None:
        require(self.process is not None, "Daemon 尚未启动")
        require(self.identity is not None, "Daemon identity 不存在")
        receipt = api_json(
            self.base_url,
            "/api/host/shutdown",
            token=self.token,
            method="POST",
            body={"expectedIdentity": self.identity},
            timeout=15,
        )
        require(isinstance(receipt, dict), "shutdown receipt 不是对象")
        require(receipt.get("accepted") is True, "Daemon 未接受 shutdown")
        require(receipt.get("cleanupComplete") is True, "Daemon 资源未完整清理")
        require(receipt.get("identity") == self.identity, "shutdown identity 漂移")
        try:
            code = self.process.wait(timeout=10)
        except subprocess.TimeoutExpired as error:
            self.terminate_group()
            raise AssertionError("Daemon 接受 shutdown 后未退出") from error
        require(code == 0, f"Daemon shutdown 后退出码为 {code}\n{self.log_tail()}")

    def terminate_group(self) -> None:
        if self.process is None or self.process.poll() is not None:
            return
        try:
            os.killpg(self.process.pid, signal.SIGTERM)
            self.process.wait(timeout=3)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            if self.process.poll() is None:
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.process.wait(timeout=3)

    def close(self) -> None:
        self.terminate_group()
        self.log_file.close()

    def log_tail(self) -> str:
        self.log_file.flush()
        position = self.log_file.tell()
        self.log_file.seek(0)
        content = self.log_file.read().decode("utf-8", errors="replace")
        self.log_file.seek(position)
        return content[-12000:]


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as handle:
        handle.bind(("127.0.0.1", 0))
        return int(handle.getsockname()[1])


def wait_until(operation: Callable[[], Any], timeout: float, message: str) -> Any:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            value = operation()
            if value:
                return value
        except AssertionError:
            raise
        except Exception as error:
            last_error = error
        time.sleep(0.05)
    suffix = f": {last_error}" if last_error else ""
    raise AssertionError(f"{message}{suffix}")


def api_envelope(
    base_url: str,
    path: str,
    *,
    token: str | None = None,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    timeout: float = 5,
) -> dict[str, Any]:
    encoded = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
    headers = {"accept": "application/json"}
    if encoded is not None:
        headers["content-type"] = "application/json"
    if token is not None:
        headers[HOST_TOKEN_HEADER] = token
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=encoded,
        headers=headers,
        method=method,
    )
    try:
        with URL_OPENER.open(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        raw = error.read()
    envelope = json.loads(raw)
    require(isinstance(envelope, dict), f"{path} 返回的 envelope 不是对象")
    return envelope


def api_json(
    base_url: str,
    path: str,
    *,
    token: str | None = None,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    timeout: float = 5,
) -> Any:
    envelope = api_envelope(
        base_url,
        path,
        token=token,
        method=method,
        body=body,
        timeout=timeout,
    )
    require(
        envelope.get("ok") is True,
        f"{path} 失败：{envelope.get('error')} {envelope.get('message')}",
    )
    return envelope.get("data")


def projection(daemon: OwnedDaemon, session_id: str) -> dict[str, Any]:
    path_id = urllib.parse.quote(session_id, safe="")
    value = api_json(
        daemon.base_url,
        f"/api/conversation/sessions/{path_id}/projection",
        token=daemon.token,
    )
    require(isinstance(value, dict), "SessionProjection 不是对象")
    require(value.get("schemaVersion") == "deepcode.session-projection.v5", "投影协议不是当前值")
    require(value.get("sessionId") == session_id, "SessionProjection identity 漂移")
    return value


def wait_completed(
    daemon: OwnedDaemon,
    provider: ProviderState,
    session_id: str,
    label: str,
) -> dict[str, Any]:
    def current_if_ready() -> dict[str, Any] | None:
        provider.assert_healthy()
        current = projection(daemon, session_id)
        run = current.get("run") or {}
        if run.get("status") == "completed":
            return current
        if run.get("status") in {"failed", "cancelled", "indeterminate"}:
            raise AssertionError(
                f"Session 在到达 {label} 前终止：{run.get('status')} {current.get('terminalError')}"
                f"\ndaemon:\n{daemon.log_tail()}"
            )
        return None

    return wait_until(current_if_ready, 20, f"Session 未到达 {label}")


def create_session(daemon: OwnedDaemon, workspace_path: Path) -> dict[str, Any]:
    value = api_json(
        daemon.base_url,
        "/api/conversation/sessions",
        token=daemon.token,
        method="POST",
        body={"workspacePaths": [str(workspace_path)]},
        timeout=12,
    )
    require(isinstance(value, dict), "create Session 未返回 projection")
    require(isinstance(value.get("sessionId"), str), "Session id 无效")
    return value


def assert_unknown_attachment_fields_rejected(
    daemon: OwnedDaemon,
    session_id: str,
) -> None:
    path_id = urllib.parse.quote(session_id, safe="")
    envelope = api_envelope(
        daemon.base_url,
        f"/api/conversation/sessions/{path_id}/commands",
        token=daemon.token,
        method="POST",
        body={
            "schemaVersion": COMMAND_VERSION,
            "type": "message.submit",
            "commandId": "command-unknown-attachment-fields",
            "sessionId": session_id,
            "text": "unsupported attachment fields",
            "attachments": [],
            "directoryAttachments": [],
        },
        timeout=12,
    )
    require(envelope.get("ok") is False, "未声明的附件字段被当前 Session wire 合同接受")


def selected_plugin_catalog(daemon: OwnedDaemon, label: str) -> tuple[str, list[dict[str, Any]]]:
    catalog = api_json(
        daemon.base_url,
        "/api/conversation/plugins",
        token=daemon.token,
    )
    require(isinstance(catalog, dict), f"{label} PluginCatalogProjection 不是对象")
    revision = catalog.get("revision")
    plugins = catalog.get("plugins")
    require(isinstance(revision, str) and revision, f"{label} 插件目录 revision 无效")
    require(isinstance(plugins, list), f"{label} 插件目录不是数组")
    typed_plugins = [plugin for plugin in plugins if isinstance(plugin, dict)]
    require(len(typed_plugins) == len(plugins), f"{label} 插件目录项不是对象")
    uris = {plugin.get("uri") for plugin in typed_plugins}
    require(FIRST_PARTY_PLUGIN_URIS.issubset(uris), f"{label} 缺少 first-party 插件")
    require(
        len(typed_plugins) == 5
        and len([uri for uri in uris if isinstance(uri, str) and uri.endswith("@skill")]) == 1
        and len([uri for uri in uris if isinstance(uri, str) and uri.endswith("@mcp")]) == 1,
        f"{label} 必须精确暴露三项 first-party 插件及当前 Skill/MCP fixture",
    )
    return revision, typed_plugins


def submit_message(
    daemon: OwnedDaemon,
    session_id: str,
    command_id: str,
    text: str,
    filesystem_references: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    revision, plugins = selected_plugin_catalog(daemon, "message.submit")
    selections = []
    for index, plugin in enumerate(plugins):
        require(isinstance(plugin, dict), "插件目录项不是对象")
        uri = plugin.get("uri")
        label = plugin.get("displayName")
        require(isinstance(uri, str) and uri.startswith("plugin://"), "插件 URI 无效")
        require(isinstance(label, str) and label, "插件 label 无效")
        selections.append({
            "selectionId": f"{command_id}:plugin:{index + 1}",
            "uri": uri,
            "label": label,
        })
    path_id = urllib.parse.quote(session_id, safe="")
    value = api_json(
        daemon.base_url,
        f"/api/conversation/sessions/{path_id}/commands",
        token=daemon.token,
        method="POST",
        body={
            "schemaVersion": COMMAND_VERSION,
            "type": "message.submit",
            "commandId": command_id,
            "sessionId": session_id,
            "text": text,
            **({"filesystemReferences": filesystem_references} if filesystem_references else {}),
            "pluginCatalogRevision": revision,
            "pluginSelections": selections,
        },
        timeout=15,
    )
    require(isinstance(value, dict), "command reply 不是对象")
    require(value.get("status") == "accepted", "Session 未接纳 message.submit")
    return value


def start_cli_ask_with_file(
    daemon: OwnedDaemon,
    session_id: str,
    file_path: Path,
    text: str,
) -> subprocess.Popen[str]:
    _, plugins = selected_plugin_catalog(daemon, "CLI ask")
    command = [
        str(CLI_BINARY),
        "--api", daemon.base_url,
        "--no-auto-start-kernel",
        "--session", session_id,
        "--file", str(file_path),
        "--plain",
    ]
    for plugin in plugins:
        uri = plugin.get("uri") if isinstance(plugin, dict) else None
        require(isinstance(uri, str) and uri.startswith("plugin://"), "CLI ask 插件 URI 无效")
        command.extend(["--plugin", uri])
    command.extend(["ask", text])
    return subprocess.Popen(
        command,
        cwd=ROOT,
        env=shell_environment(daemon),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def plugin_settings(
    skill_root: Path,
    mount_id: str,
    server_id: str,
    server_name: str,
) -> dict[str, Any]:
    return {
        "skills.autoLoad": True,
        "skills.mounts": json.dumps([{
            "id": mount_id,
            "path": str(skill_root),
            "enabled": True,
        }], separators=(",", ":")),
        "mcp.autoLoad": True,
        "mcp.servers": json.dumps([{
            "id": server_id,
            "name": server_name,
            "transport": "stdio",
            "command": sys.executable,
            "args": str(MCP_SERVER),
            "enabled": True,
        }], separators=(",", ":")),
    }


def write_configuration(
    config_root: Path,
    provider_url: str,
    settings: dict[str, Any],
) -> None:
    settings_root = config_root / "config" / "user" / "local" / "settings"
    settings_root.mkdir(parents=True)
    profile = {
        "profiles": [{
            "id": "e2e-main",
            "name": "Local E2E",
            "kind": "openaiCompatible",
            "providerFlavor": "openai",
            "baseUrl": provider_url,
            "model": "mock-main",
            "contextWindowTokens": 8192,
            "maxOutputTokens": 512,
            "enabled": True,
        }],
        "defaultProfileId": "e2e-main",
    }
    (settings_root / "llm-profiles.json").write_text(
        json.dumps(profile, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (settings_root / "user-settings.json").write_text(
        json.dumps(settings, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def patch_plugins(
    daemon: OwnedDaemon,
    old_settings: dict[str, Any],
    new_settings: dict[str, Any],
) -> None:
    changed = {key: new_settings[key] for key in new_settings if new_settings[key] != old_settings[key]}
    result = api_json(
        daemon.base_url,
        "/api/user-settings",
        token=daemon.token,
        method="PATCH",
        body={"patches": changed},
    )
    require(result.get("activation") == "nextRun", "插件设置未声明 nextRun 激活")
    require(set(result.get("changedKeys", [])) == set(changed), "插件设置变更键不完整")

    snapshot = api_json(daemon.base_url, "/api/user-settings", token=daemon.token)
    for key in changed:
        require(snapshot["settings"].get(key) == new_settings[key], f"{key} 未写入保存设置")
        require(
            snapshot["runtimeSettings"].get(key) == old_settings[key],
            f"{key} 在当前 run 内提前激活",
        )


def assert_runtime_activated(daemon: OwnedDaemon, new_settings: dict[str, Any]) -> None:
    snapshot = api_json(daemon.base_url, "/api/user-settings", token=daemon.token)
    for key in ("skills.mounts", "mcp.servers"):
        require(
            snapshot["runtimeSettings"].get(key) == new_settings[key],
            f"{key} 未在下一 run 激活",
        )


def assert_projection_flow(value: dict[str, Any]) -> None:
    run = value.get("run") or {}
    require(run.get("status") == "completed", "最终 run 未完成")
    assistant_messages = [
        message for message in value.get("messages", []) if message.get("role") == "assistant"
    ]
    require(len(assistant_messages) == 2, "两轮基础链路没有形成两个 assistant 事实")
    require(assistant_messages[-1].get("content") == "round-two-complete", "最终消息数据流错误")
    completed_tools = [
        activity
        for activity in value.get("activities", [])
        if activity.get("kind") == "tool" and activity.get("status") == "completed"
    ]
    require(
        len(completed_tools) == 8,
        "两轮惰性文件读取/MCP/PDF/web 调用未形成八个 completed activity",
    )

    usage = value.get("tokenUsage") or {}
    require(usage.get("providerCallCount") == 4, "Provider 调用聚合错误")
    require(usage.get("reportedCallCount") == 4, "缓存报告调用聚合错误")
    require(usage.get("inputTokens") == 400, "输入 token 聚合错误")
    require(usage.get("outputTokens") == 40, "输出 token 聚合错误")
    require(usage.get("cacheReadInputTokens") == 160, "缓存读取 token 聚合错误")
    require(usage.get("cacheMissInputTokens") == 240, "缓存未命中 token 聚合错误")
    require(usage.get("cacheAvailable") is True, "缓存事实未标记 available")
    require(usage.get("cacheComplete") is True, "缓存事实未标记 complete")
    ratio = usage.get("cacheHitRatio")
    require(isinstance(ratio, (int, float)) and abs(ratio - 0.4) < 1e-12, "缓存命中率分母错误")


def sqlite_read_only(path: Path) -> sqlite3.Connection:
    require(path.is_file(), f"运行事实未落盘：{path.name}")
    return sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)


def assert_persisted_tool_bindings_and_release(config_root: Path, session_id: str) -> None:
    runtime_root = config_root / "runtime" / "agent-runtime"
    with sqlite_read_only(runtime_root / "session.sqlite3") as connection:
        started_rows = connection.execute(
            "SELECT run_id, payload_json FROM session_events "
            "WHERE session_id=? AND event_type='run.started' ORDER BY sequence",
            (session_id,),
        ).fetchall()
        lifecycle_rows = connection.execute(
            "SELECT run_id, event_type, sequence, payload_json FROM session_events "
            "WHERE session_id=? AND event_type IN "
            "('tool.completed','context.composed','run.finishing','run.runtime.released',"
            "'run.runtime.release_failed','run.settled') ORDER BY sequence",
            (session_id,),
        ).fetchall()
    require(len(started_rows) == 2, "两轮链路没有两个 run.started runtime snapshot")

    with sqlite_read_only(runtime_root / "tool-record.sqlite3") as connection:
        record_rows = connection.execute(
            "SELECT run_id, call_id, record_json FROM tool_records "
            "WHERE session_id=? ORDER BY completed_at, call_id",
            (session_id,),
        ).fetchall()
    require(len(record_rows) == 8, "两轮链路没有八个文件读取/MCP/PDF/web ToolRecord")
    records_by_run: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    for run_id, call_id, encoded in record_rows:
        records_by_run.setdefault(run_id, []).append((call_id, json.loads(encoded)))

    lifecycle_by_run: dict[str, list[tuple[str, int, dict[str, Any]]]] = {}
    for run_id, event_type, sequence, encoded in lifecycle_rows:
        lifecycle_by_run.setdefault(run_id, []).append((event_type, sequence, json.loads(encoded)))

    snapshots: list[dict[str, Any]] = []
    plugin_instances: list[str] = []
    first_receipts: list[dict[str, Any]] = []
    expected_io = [("alpha", "ahpla"), ("beta", "ateb")]
    for run_index, ((run_id, encoded), (expected_input, expected_output)) in enumerate(
        zip(started_rows, expected_io)
    ):
        payload = json.loads(encoded)
        runtime = payload.get("runtimeSnapshot")
        require(isinstance(runtime, dict), "run.started 缺少 runtimeSnapshot")
        workspace_bindings = payload.get("workspaceBindings")
        require(isinstance(workspace_bindings, list) and workspace_bindings, "run.started 缺少 workspace bindings")
        primary_workspace_id = workspace_bindings[0].get("workspaceId")
        require(isinstance(primary_workspace_id, str) and primary_workspace_id, "primary workspaceId 无效")
        runtime_tools = runtime.get("tools", [])
        require(isinstance(runtime_tools, list), "run runtime tools 不是数组")
        runtime_core_tools = [
            tool for tool in runtime_tools
            if isinstance(tool, dict) and tool.get("origin") == "coreBuiltin"
        ]
        require(
            [tool.get("name") for tool in runtime_core_tools]
            == sorted(CORE_TOOL_NAMES),
            "Kernel runtime snapshot 未包含精确九项基础工具",
        )
        runtime_tools_by_name = {
            tool.get("name"): tool for tool in runtime_tools if isinstance(tool, dict)
        }
        prompt_contributions = runtime.get("toolPromptContributions")
        require(isinstance(prompt_contributions, list), "run runtime 缺少 tool prompt snapshot")
        require(
            [item.get("canonicalToolName") for item in prompt_contributions]
            == [
                "fs.read", "bash", "web.fetch",
                "arxiv.read", "arxiv.search",
                "github.read", "github.search",
                "pdf.read",
            ],
            "run runtime 未按稳定顺序冻结 core/first-party tool guidance",
        )
        for contribution in prompt_contributions:
            tool_name = contribution.get("canonicalToolName")
            target = runtime_tools_by_name.get(tool_name)
            require(isinstance(target, dict), "tool prompt 指向不存在的 runtime tool")
            if tool_name in {"fs.read", "bash", "web.fetch"}:
                require(contribution.get("origin") == "coreBuiltin", "core tool prompt origin 漂移")
                require("pluginUri" not in contribution, "core tool prompt 错误携带 pluginUri")
            else:
                require(contribution.get("origin") == "extension", "first-party prompt origin 漂移")
                require(
                    contribution.get("pluginUri") in FIRST_PARTY_PLUGIN_URIS,
                    "first-party prompt 缺少精确 pluginUri",
                )
            require(
                contribution.get("preparedToolBindingRef") == target.get("toolBindingRef"),
                "tool prompt 没有绑定当前 run 的 prepared tool",
            )
        mcp_server_id = "fixture-old" if run_index == 0 else "fixture-new"
        reverse_tools = [
            tool
            for tool in runtime_tools
            if isinstance(tool, dict) and tool.get("name") == f"mcp.{mcp_server_id}.text.reverse"
        ]
        require(len(reverse_tools) == 1, "run snapshot 缺少唯一 MCP 工具 binding")
        tool = reverse_tools[0]
        require(tool.get("origin") == "extension", "MCP prepared tool 缺少 extension origin")
        require(
            tool.get("pluginUri") == f"plugin://{mcp_server_id}@mcp",
            "MCP prepared tool 缺少精确 pluginUri",
        )
        run_records = records_by_run.get(run_id, [])
        expected_record_count = 5 if run_index == 0 else 3
        require(
            len(run_records) == expected_record_count,
            f"当前 run 没有精确 {expected_record_count} 个 ToolRecord",
        )
        mcp_records = [entry for entry in run_records if entry[1].get("toolName") == tool.get("name")]
        require(len(mcp_records) == 1, "MCP ToolRecord 未唯一关联到 runtime tool")
        call_id, record = mcp_records[0]
        require(record.get("callId") == call_id, "ToolRecord callId 列与事实不一致")
        require(record.get("outcome") == "completed", "MCP ToolRecord 未完成")
        require(record.get("input", {}).get("text") == expected_input, "MCP 输入事实错误")
        require(expected_output in json.dumps(record.get("output"), ensure_ascii=False), "MCP 输出事实错误")
        require(
            record.get("extensionGenerationRef") == runtime.get("extensionGenerationRef"),
            "ToolRecord 与 run 的 ExtensionGenerationRef 不一致",
        )
        require(
            record.get("kernelCatalogSnapshotRef") == runtime.get("kernelCatalogSnapshotRef"),
            "ToolRecord 与 run 的 KernelCatalogSnapshotRef 不一致",
        )
        require(record.get("toolBindingRef") == tool.get("toolBindingRef"), "ToolBindingRef 未贯通")
        require(record.get("toolName") == tool.get("name"), "ToolRecord 工具名未贯通")
        prepared = record.get("preparedEffect") or {}
        require(prepared.get("origin") == "extension", "MCP 工具未标记为 extension contribution")
        require(prepared.get("toolBindingRef") == tool.get("toolBindingRef"), "PreparedEffect binding 漂移")
        plugin_instance = prepared.get("pluginInstanceRef")
        require(isinstance(plugin_instance, str) and plugin_instance, "MCP 缺少 PluginInstanceRef")
        plugin_instances.append(plugin_instance)
        web_records = {candidate.get("toolName"): candidate for _, candidate in run_records}
        if run_index == 0:
            pdf_tool = runtime_tools_by_name.get("pdf.read")
            require(isinstance(pdf_tool, dict), "run snapshot 缺少 pdf.read")
            require(pdf_tool.get("possibleEffects") == ["workspaceRead"], "pdf.read effect scope 错误")
            require(pdf_tool.get("pluginUri") == "plugin://pdf@first-party", "pdf.read plugin owner 错误")
            pdf_record = web_records.get("pdf.read")
            require(isinstance(pdf_record, dict), "第一轮缺少 pdf.read ToolRecord")
            require(pdf_record.get("outcome") == "completed", "pdf.read ToolRecord 未完成")
            require(pdf_record.get("input", {}).get("path") == "fixture.pdf", "pdf.read 输入路径漂移")
            require(
                PDF_CONTENT in json.dumps(pdf_record.get("output"), ensure_ascii=False),
                "pdf.read ToolRecord 未包含真实提取正文",
            )
            pdf_effect = pdf_record.get("preparedEffect") or {}
            require(pdf_effect.get("workspaceId") == primary_workspace_id, "pdf.read workspace binding 错误")
            require(pdf_effect.get("logicalTargets") == ["fixture.pdf"], "pdf.read logical target 漂移")
        require("Fixture search result" in json.dumps(
            web_records["web.search"].get("output"), ensure_ascii=False,
        ), "web.search 没有真实返回结构化结果")
        require("web-fetch-ok" in json.dumps(
            web_records["web.fetch"].get("output"), ensure_ascii=False,
        ), "web.fetch 没有真实获取 HTTP 内容")
        if run_index == 0:
            require(
                ATTACHMENT_CONTENT in json.dumps(
                    web_records["fs.read"].get("output"), ensure_ascii=False,
                ),
                "fs.read 没有从 Host 文件快照返回真实内容",
            )

        lifecycle = lifecycle_by_run.get(run_id, [])
        event_types = [event_type for event_type, _, _ in lifecycle]
        require("run.runtime.release_failed" not in event_types, "run runtime release 失败")
        for event_type in ("run.finishing", "run.runtime.released", "run.settled"):
            require(event_types.count(event_type) == 1, f"{event_type} 回执数量错误")
        positions = {event_type: sequence for event_type, sequence, _ in lifecycle}
        require(
            positions["run.finishing"] < positions["run.runtime.released"] < positions["run.settled"],
            "run release receipt 没有位于 finishing 与 settled 之间",
        )
        released_payload = next(
            event_payload for event_type, _, event_payload in lifecycle
            if event_type == "run.runtime.released"
        )
        require(released_payload.get("alreadyReleased") is False, "首次 release 被错误标为重放")
        require(
            len(released_payload.get("pluginInstanceRefs", [])) == 5,
            "release receipt 未列出当前 run 的三项 first-party/Skill/MCP plugin lease",
        )
        completed_order = [
            event_payload.get("record", {}).get("toolName")
            for event_type, _, event_payload in lifecycle
            if event_type == "tool.completed"
        ]
        expected_completed_order = (
            ["fs.read", tool.get("name"), "pdf.read", "web.search", "web.fetch"]
            if run_index == 0
            else [tool.get("name"), "web.search", "web.fetch"]
        )
        require(completed_order == expected_completed_order, "同一 Provider turn 的工具没有严格按请求顺序完成")
        receipts = [
            event_payload for event_type, _, event_payload in lifecycle
            if event_type == "context.composed"
        ]
        require(len(receipts) == 2, "每个 run 必须有 tool turn 与 continuation 两个 context receipt")
        for receipt in receipts:
            for field in (
                "stableCoreHash", "baseToolSchemaHash", "selectedPluginSnapshotHash",
            ):
                require(
                    isinstance(receipt.get(field), str)
                    and receipt[field].startswith("context-hash-v1:"),
                    f"context.composed 缺少 {field}",
                )
            require(
                isinstance(receipt.get("dynamicInstructionBytes"), int)
                and receipt["dynamicInstructionBytes"] > 0,
                "context.composed dynamicInstructionBytes 无效",
            )
            provider_tools = receipt.get("tools")
            require(isinstance(provider_tools, list) and provider_tools, "context receipt 工具目录为空")
            require(all(
                isinstance(item, dict)
                and isinstance(item.get("canonicalName"), str)
                and isinstance(item.get("wireName"), str)
                and item.get("origin") in {"coreBuiltin", "extension", "sessionControl"}
                and item.get("availability") == "callable"
                for item in provider_tools
            ), "context receipt 工具来源字段不完整")
        first_receipts.append(receipts[0])
        snapshots.append(runtime)

    for key in (
        "runRuntimeSnapshotRef",
        "extensionGenerationRef",
        "kernelCatalogSnapshotRef",
    ):
        require(snapshots[0].get(key) != snapshots[1].get(key), f"下一 run 未更新 {key}")
    require(snapshots[0]["tools"] != snapshots[1]["tools"], "下一 run 的工具 snapshot 未更新")
    prompt_bindings = [
        [item.get("preparedToolBindingRef") for item in snapshot["toolPromptContributions"]]
        for snapshot in snapshots
    ]
    require(prompt_bindings[0] != prompt_bindings[1], "下一 run 未重新绑定 tool prompt snapshot")
    prompt_content = [[
        {key: value for key, value in item.items() if key != "preparedToolBindingRef"}
        for item in snapshot["toolPromptContributions"]
    ] for snapshot in snapshots]
    require(prompt_content[0] == prompt_content[1], "稳定 core tool guidance 文本发生漂移")
    require(plugin_instances[0] != plugin_instances[1], "两代 MCP 复用了 PluginInstanceRef")
    require(
        first_receipts[0]["stableCoreHash"] == first_receipts[1]["stableCoreHash"],
        "两个 run 的稳定 System Prompt hash 漂移",
    )
    require(
        first_receipts[0]["baseToolSchemaHash"] == first_receipts[1]["baseToolSchemaHash"],
        "两个 run 的基础工具 schema hash 漂移",
    )
    require(
        first_receipts[0]["selectedPluginSnapshotHash"]
        != first_receipts[1]["selectedPluginSnapshotHash"],
        "插件代次更新后 selected plugin snapshot hash 未变化",
    )


def shell_environment(daemon: OwnedDaemon) -> dict[str, str]:
    environment = os.environ.copy()
    environment["DEEPCODE_HOST_SHELL_TOKEN"] = daemon.token
    environment["DEEPCODE_CLI_RUN_TIMEOUT_MS"] = "15000"
    return environment


def assert_shells_read_projection(
    daemon: OwnedDaemon,
    session_id: str,
    revision: int,
) -> None:
    require(CLI_BINARY.is_file(), f"缺少 CLI：{CLI_BINARY}")
    cli = subprocess.run(
        [
            str(CLI_BINARY),
            "--api", daemon.base_url,
            "--no-auto-start-kernel",
            "--session", session_id,
            "show",
        ],
        cwd=ROOT,
        env=shell_environment(daemon),
        check=False,
        capture_output=True,
        text=True,
        timeout=18,
    )
    require(cli.returncode == 0, f"CLI 读取共享投影失败：{cli.stderr}")
    require(
        f"session={session_id} revision={revision}" in f"{cli.stdout}\n{cli.stderr}",
        "CLI 没有读取精确 SessionProjection identity",
    )

    require(TUI_BINARY.is_file(), f"缺少 TUI：{TUI_BINARY}")
    tui = subprocess.run(
        [
            str(TUI_BINARY),
            "--api", daemon.base_url,
            "--no-auto-start-kernel",
            "--session", session_id,
            "--smoke",
        ],
        cwd=ROOT,
        env=shell_environment(daemon),
        check=False,
        capture_output=True,
        text=True,
        timeout=18,
    )
    require(tui.returncode == 0, f"TUI 读取共享投影失败：{tui.stderr}")
    require(
        f"session={session_id} revision={revision}" in tui.stdout,
        "TUI 没有读取精确 SessionProjection identity",
    )


def assert_provider_count_stable(provider: ProviderState, expected: int) -> None:
    deadline = time.monotonic() + 0.35
    while time.monotonic() < deadline:
        provider.assert_healthy()
        require(provider.count() == expected, "恢复 settled Session 时重复调用 Provider")
        time.sleep(0.05)


def main() -> None:
    require(MCP_SERVER.is_file(), f"缺少 MCP fixture：{MCP_SERVER}")
    provider = ProviderState()
    provider_server = MockProviderServer(provider)
    provider_thread = threading.Thread(target=provider_server.serve_forever, daemon=True)
    provider_thread.start()
    daemon_one: OwnedDaemon | None = None
    daemon_two: OwnedDaemon | None = None
    cli_ask: subprocess.Popen[str] | None = None
    try:
        with tempfile.TemporaryDirectory(prefix="deepcode-basic-loop-e2e-") as temporary:
            root = Path(temporary)
            config_root = root / "config-root"
            workspace_root = root / "workspace"
            skill_root = root / "runtime-skill"
            config_root.mkdir()
            workspace_root.mkdir()
            skill_root.mkdir()
            write_pdf_fixture(workspace_root / "fixture.pdf", PDF_CONTENT)
            attachment_file = root / "e2e-note.txt"
            attachment_file.write_text(ATTACHMENT_CONTENT, encoding="utf-8")
            skill_file = skill_root / "SKILL.md"
            skill_file.write_text(f"# Runtime fixture\n\n{GENERATION_ONE}\n", encoding="utf-8")

            old_plugins = plugin_settings(
                skill_root,
                "fixture-skill-old",
                "fixture-old",
                "Fixture Old",
            )
            new_plugins = plugin_settings(
                skill_root,
                "fixture-skill-new",
                "fixture-new",
                "Fixture New",
            )
            provider_url = f"http://127.0.0.1:{provider_server.server_port}/v1"
            user_settings = {
                "agent.systemPrompt": "",
                "agent.permissions.workspaceMutation": "plan",
                "agent.permissions.engineeringDecisions": "ask",
                "agent.permissions.networkRead": "allow",
                "agent.permissions.external": "allow",
                "agent.web.search.endpointTemplate": (
                    f"http://127.0.0.1:{provider_server.server_port}/search"
                    "?q={query}&limit={limit}"
                ),
                **old_plugins,
            }
            write_configuration(config_root, provider_url, user_settings)

            daemon_one = OwnedDaemon(config_root)
            daemon_one.start()
            created = create_session(daemon_one, workspace_root)
            session_id = created["sessionId"]
            provider.bind_session(daemon_one, session_id)
            creation_bindings = created.get("workspaceBindings")
            require(
                isinstance(creation_bindings, list) and len(creation_bindings) == 1,
                "新项目 Session 没有原子绑定唯一 workspace creation snapshot",
            )
            assert_unknown_attachment_fields_rejected(daemon_one, session_id)
            require(provider.count() == 0, "未声明附件字段的命令在拒绝前错误启动了 Provider")
            cli_ask = start_cli_ask_with_file(
                daemon_one,
                session_id,
                attachment_file,
                "第一轮链路输入。",
            )

            def first_provider_request_started() -> bool:
                provider.assert_healthy()
                if cli_ask is not None and cli_ask.poll() is not None:
                    cli_stdout, cli_stderr = cli_ask.communicate()
                    raise AssertionError(
                        "CLI 在首个 Provider 请求前退出"
                        f" code={cli_ask.returncode}"
                        f"\nstdout:\n{cli_stdout}"
                        f"\nstderr:\n{cli_stderr}"
                        f"\ndaemon:\n{daemon_one.log_tail()}"
                    )
                if daemon_one.process is not None and daemon_one.process.poll() is not None:
                    raise AssertionError(
                        "Daemon 在首个 Provider 请求前退出"
                        f" code={daemon_one.process.returncode}"
                        f"\n{daemon_one.log_tail()}"
                    )
                return provider.first_started()

            wait_until(
                first_provider_request_started,
                12,
                "第一轮 Provider 请求未开始",
            )

            skill_file.write_text(f"# Runtime fixture\n\n{GENERATION_TWO}\n", encoding="utf-8")
            patch_plugins(daemon_one, old_plugins, new_plugins)
            provider.release_first_request.set()
            first = wait_completed(daemon_one, provider, session_id, "first run completed")
            cli_stdout, cli_stderr = cli_ask.communicate(timeout=18)
            require(cli_ask.returncode == 0, f"CLI ask --file 失败：{cli_stderr}")
            require("round-one-complete" in cli_stdout, "CLI ask 未显示第一轮回答")
            cli_ask = None
            require(first.get("messages", [])[-1].get("content") == "round-one-complete", "第一轮回答未贯通")
            first_input = first.get("messages", [])[0]
            filesystem_references = first_input.get("filesystemReferences")
            require(isinstance(filesystem_references, list) and len(filesystem_references) == 1, "Host 未返回唯一文件引用")
            require(filesystem_references[0].get("logicalPath") == "e2e-note.txt", "逻辑文件名漂移")
            require(filesystem_references[0].get("mediaType") == "text/plain", "文本媒体类型漂移")
            require(
                set(filesystem_references[0]) == {
                    "referenceId", "workspaceId", "logicalPath", "displayName", "kind",
                    "mediaType", "byteLength",
                },
                "共享 SessionProjection 的文件引用字段不精确",
            )

            submit_message(daemon_one, session_id, "command-round-two", "第二轮链路输入。")
            final = wait_completed(daemon_one, provider, session_id, "second run completed")
            provider.assert_healthy()
            require(provider.count() == 4, "两轮 tool/continuation Provider 调用数不是四次")
            require(provider.old_wire_name() != provider.new_wire_name(), "MCP wire tool 未热更新")
            assert_runtime_activated(daemon_one, new_plugins)
            assert_projection_flow(final)
            final_revision = int(final["revision"])

            daemon_one.shutdown()
            assert_persisted_tool_bindings_and_release(config_root, session_id)

            daemon_two = OwnedDaemon(config_root)
            daemon_two.start()
            recovered = projection(daemon_two, session_id)
            require((recovered.get("run") or {}).get("status") == "completed", "重启后完成态丢失")
            require(int(recovered["revision"]) == final_revision, "重启后 projection revision 漂移")
            assert_projection_flow(recovered)
            assert_provider_count_stable(provider, 4)
            assert_shells_read_projection(daemon_two, session_id, final_revision)
            attachment_root = config_root / "runtime" / "agent-runtime" / "attachments"
            require(any(attachment_root.rglob("e2e-note.txt")), "Host 文件快照未持有到 Session 生命周期")
            path_id = urllib.parse.quote(session_id, safe="")
            api_json(
                daemon_two.base_url,
                f"/api/conversation/sessions/{path_id}",
                token=daemon_two.token,
                method="DELETE",
                timeout=12,
            )
            require(
                not attachment_root.exists() or not any(attachment_root.iterdir()),
                "Session 删除后 Host 文件快照仍然存在",
            )
            daemon_two.shutdown()

            print(
                "[local-agent-e2e] PASS "
                "basic-loop/sequential-tools/web/first-party-plugin/pdf-binding/cache/release/restart/"
                "filesystem-reference/shared-projection "
                "(CLI chain verification only; not GUI, package, or release acceptance)"
            )
    finally:
        provider.release_first_request.set()
        if cli_ask is not None:
            cli_ask.terminate()
            try:
                cli_ask.wait(timeout=3)
            except subprocess.TimeoutExpired:
                cli_ask.kill()
                cli_ask.wait(timeout=3)
        if daemon_two is not None:
            daemon_two.close()
        if daemon_one is not None:
            daemon_one.close()
        provider_server.shutdown()
        provider_server.server_close()
        provider_thread.join(timeout=3)


if __name__ == "__main__":
    main()
