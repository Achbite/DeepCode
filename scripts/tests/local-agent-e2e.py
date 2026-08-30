#!/usr/bin/env python3
"""验证当前 Catalog、Session、Plan、Kernel 与三个 UI 壳的真实本地链路。"""

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
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[2]


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
HOST_TOKEN_HEADER = "x-deepcode-host-shell-token"
COMMAND_VERSION = "deepcode.command"
EXPECTED_CONTENT = "created once\n"
URL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
MARKERS = (
    "EXECUTE", "FEEDBACK", "PLAN_CANCEL", "CANCEL", "FAIL", "TODO", "AUTONOMY",
)
CLI_CANCELLED_EXIT = 8


class ProviderState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._requests: list[dict[str, Any]] = []
        self._counts = {marker: 0 for marker in MARKERS}
        self._forbidden_roots: list[str] = []
        self.cancel_started = threading.Event()
        self.release_cancel = threading.Event()
        self.todo_continuation_started = threading.Event()
        self.release_todo_continuation = threading.Event()

    def forbid_roots(self, roots: list[Path]) -> None:
        self._forbidden_roots = [str(root.resolve()) for root in roots]

    def register(
        self,
        body: dict[str, Any],
    ) -> tuple[str, int, str | None, set[str], dict[str, Any] | None]:
        messages = body.get("messages")
        if not isinstance(messages, list):
            raise AssertionError("Provider 请求缺少 messages")
        joined = "\n".join(
            str(message.get("content", ""))
            for message in messages
            if isinstance(message, dict)
        )
        marker = next((item for item in MARKERS if item in joined), "")
        if not marker:
            raise AssertionError(f"Provider 请求缺少 E2E 标记：{joined!r}")
        encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
        leaked = next((root for root in self._forbidden_roots if root in encoded), None)
        if leaked is not None:
            raise AssertionError(f"普通 Provider 请求泄露了 Host 私有 canonicalRoot：{leaked}")
        workspace_id: str | None = None
        binding_prefix = "当前 Session workspace binding（仅逻辑身份，不含绝对路径）："
        for message in messages:
            if not isinstance(message, dict) or message.get("role") != "system":
                continue
            content = message.get("content")
            if not isinstance(content, str) or not content.startswith(binding_prefix):
                continue
            bindings = json.loads(content.removeprefix(binding_prefix))
            if isinstance(bindings, list) and bindings and isinstance(bindings[0], dict):
                candidate = bindings[0].get("workspaceId")
                if isinstance(candidate, str):
                    workspace_id = candidate
            break
        tool_result_ids = {
            str(message.get("tool_call_id"))
            for message in messages
            if isinstance(message, dict)
            and message.get("role") == "tool"
            and isinstance(message.get("tool_call_id"), str)
        }
        tool_call_names: dict[str, str] = {}
        for message in messages:
            if not isinstance(message, dict) or message.get("role") != "assistant":
                continue
            calls = message.get("tool_calls")
            if not isinstance(calls, list):
                continue
            for call in calls:
                if not isinstance(call, dict) or not isinstance(call.get("id"), str):
                    continue
                function = call.get("function")
                if isinstance(function, dict) and isinstance(function.get("name"), str):
                    tool_call_names[call["id"]] = function["name"].replace("__", ".")
        completed_tool_names = {
            tool_call_names[call_id]
            for call_id in tool_result_ids
            if call_id in tool_call_names
        }
        todo_fact: dict[str, Any] | None = None
        for message in messages:
            if not isinstance(message, dict) or message.get("role") != "system":
                continue
            content = message.get("content")
            if not isinstance(content, str):
                continue
            try:
                candidate = json.loads(content)
            except json.JSONDecodeError:
                continue
            if isinstance(candidate, dict) and candidate.get("type") in {
                "todo.seeded", "todo.reconciled",
            }:
                todo_fact = candidate
        tools = body.get("tools")
        tool_names = {
            item.get("function", {}).get("name")
            for item in tools
            if isinstance(item, dict)
        } if isinstance(tools, list) else set()
        if not {
            "fs__create", "fs__list", "plan__publish", "interaction__request", "todo__progress",
        }.issubset(tool_names):
            raise AssertionError("普通 Provider 请求没有同时暴露 Kernel 工具与 Session control")
        if marker == "AUTONOMY":
            if "工作区内 fs.* 修改可直接执行" not in joined:
                raise AssertionError("完全访问工作区模式没有进入 Session 指令")
            if "process.shell 可直接用于工作区调试" not in joined:
                raise AssertionError("项目调试 Shell 的独立授权没有进入 Session 指令")
            if "有充分工作区事实时自行选择最小一致工程路线" not in joined:
                raise AssertionError("工程路线委托模式没有进入 Session 指令")
        with self._lock:
            self._requests.append(body)
            self._counts[marker] += 1
            ordinal = self._counts[marker]
        return marker, ordinal, workspace_id, completed_tool_names, todo_fact

    def count(self, marker: str | None = None) -> int:
        with self._lock:
            return len(self._requests) if marker is None else self._counts[marker]

    def models(self, marker: str) -> list[str]:
        with self._lock:
            result: list[str] = []
            for body in self._requests:
                messages = body.get("messages", [])
                joined = "\n".join(
                    str(message.get("content", ""))
                    for message in messages
                    if isinstance(message, dict)
                )
                if marker in joined and isinstance(body.get("model"), str):
                    result.append(body["model"])
            return result


class MockProviderHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def provider_state(self) -> ProviderState:
        return self.server.provider_state  # type: ignore[attr-defined]

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        try:
            if not self.path.endswith("/chat/completions"):
                self.send_error(404)
                return
            if self.headers.get("authorization") != "Bearer e2e-key":
                self.send_error(401)
                return
            length = int(self.headers.get("content-length", "0"))
            if length <= 0 or length > 8 * 1024 * 1024:
                self.send_error(400)
                return
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise AssertionError("Provider body 不是对象")
            marker, ordinal, workspace_id, completed_tool_names, todo_fact = (
                self.provider_state.register(body)
            )
            self.send_response(200)
            self.send_header("content-type", "text/event-stream; charset=utf-8")
            self.send_header("cache-control", "no-cache")
            self.send_header("connection", "close")
            self.end_headers()
            self._respond(marker, ordinal, workspace_id, completed_tool_names, todo_fact)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as error:  # Make mock failures visible to the caller.
            try:
                payload = json.dumps({"error": str(error)}).encode("utf-8")
                self.send_response(500)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.send_header("connection", "close")
                self.end_headers()
                self.wfile.write(payload)
            except Exception:
                pass

    def _respond(
        self,
        marker: str,
        ordinal: int,
        workspace_id: str | None,
        completed_tool_names: set[str],
        todo_fact: dict[str, Any] | None,
    ) -> None:
        if marker == "CANCEL":
            self._send_text("正在等待可取消的 Provider 响应。")
            self.provider_state.cancel_started.set()
            self.provider_state.release_cancel.wait(20)
            self._send_done()
            return
        if marker == "FAIL":
            self._send_tool_call(
                "正在提交一个字段非法的 Plan 以验证失败边界。",
                f"plan:invalid:{ordinal}",
                "plan__publish",
                {
                    "title": "无效 Plan",
                    "summary": "这个 Plan 缺少步骤。",
                    "steps": [],
                    "mutationManifest": [],
                },
            )
            self._send_done()
            return
        if workspace_id is None:
            raise AssertionError(f"{marker} Provider 请求缺少逻辑 workspaceId")
        if marker == "EXECUTE":
            if ordinal == 1:
                self._send_tool_call(
                    "正在核对目标并准备一个精确的写入计划。",
                    "plan:execute",
                    "plan__publish",
                    {
                        "title": "创建验收文件",
                        "summary": "只创建一个精确目标。",
                        "steps": [{
                            "stepId": "step:create",
                            "title": "创建验收文件",
                            "details": "创建 executed.txt 并核对工具回执。",
                            "verification": ["executed.txt 内容与预期一致。"],
                        }],
                        "mutationManifest": [{
                            "workspaceId": workspace_id,
                            "operation": "fs.create",
                            "target": "executed.txt",
                        }],
                    },
                )
            elif ordinal == 2 and "fs.create" not in completed_tool_names:
                self._send_tool_call(
                    "计划已确认，正在创建唯一目标文件。",
                    "e2e-call-execute",
                    "fs__create",
                    {
                        "workspaceId": workspace_id,
                        "path": "executed.txt",
                        "content": EXPECTED_CONTENT,
                    },
                )
            elif ordinal == 3 and "fs.create" in completed_tool_names:
                self._send_text("已完成 **Plan 授权** 的文件创建。", finish_reason="stop")
            else:
                raise AssertionError(
                    f"EXECUTE Provider 轮次异常：ordinal={ordinal}, results={completed_tool_names}"
                )
        elif marker == "FEEDBACK":
            if ordinal == 1:
                self._send_tool_call(
                    "正在形成可调整的计划。",
                    "plan:feedback",
                    "plan__publish",
                    {
                        "title": "创建反馈文件",
                        "summary": "创建初始目标。",
                        "steps": [{
                            "stepId": "step:feedback",
                            "title": "创建反馈文件",
                            "details": "创建 feedback.txt。",
                        }],
                        "mutationManifest": [{
                                "workspaceId": workspace_id,
                                "operation": "fs.create",
                                "target": "feedback.txt",
                        }],
                    },
                )
            elif ordinal == 2:
                self._send_tool_call(
                    "已按修订说明形成新的最终计划。",
                    "plan:feedback:revised",
                    "plan__publish",
                    {
                        "title": "说明修订目标",
                        "summary": "只说明 docs/notes.md，不执行写入。",
                        "steps": [{
                            "stepId": "step:feedback",
                            "title": "说明修订目标",
                            "details": "说明 docs/notes.md 的处理方案。",
                        }],
                        "mutationManifest": [],
                    },
                )
            elif ordinal == 3:
                self._send_text(
                    "修订 Plan 已确认，本轮未执行 workspace mutation。",
                    finish_reason="stop",
                )
            else:
                raise AssertionError("FEEDBACK Provider 轮次异常")
        elif marker == "PLAN_CANCEL":
            if ordinal == 1:
                self._send_tool_call(
                    "正在准备一个可取消的计划。",
                    "plan:ignore",
                    "plan__publish",
                    {
                        "title": "创建不应执行的文件",
                        "summary": "该 Plan 将由用户取消。",
                        "steps": [{
                            "stepId": "step:cancelled",
                            "title": "创建不应执行的文件",
                            "details": "创建 ignored.txt。",
                        }],
                        "mutationManifest": [{
                                "workspaceId": workspace_id,
                                "operation": "fs.create",
                                "target": "ignored.txt",
                        }],
                    },
                )
            elif ordinal == 2:
                self._send_text("已取消计划；没有执行任何修改。", finish_reason="stop")
            else:
                raise AssertionError("PLAN_CANCEL Provider 轮次异常")
        elif marker == "TODO":
            if ordinal == 1:
                self._send_tool_call(
                    "这是复杂任务；我先发布完整计划。",
                    "plan:todo",
                    "plan__publish",
                    {
                        "title": "读取目录并整理结论",
                        "summary": "读取项目结构、分析关键链路并形成回答。",
                        "steps": [
                            {
                                "stepId": "step:inspect",
                                "title": "读取项目结构",
                                "details": "读取工作区目录。",
                            },
                            {
                                "stepId": "step:analyze",
                                "title": "分析关键链路",
                                "details": "分析目录与代码事实。",
                            },
                            {
                                "stepId": "step:answer",
                                "title": "整理最终结论",
                                "details": "输出最终答复。",
                            },
                        ],
                        "mutationManifest": [],
                    },
                )
            elif ordinal == 2:
                if todo_fact is None:
                    raise AssertionError("TODO 确认后 Provider 没有收到 todo.seeded 事实")
                items = todo_fact.get("items")
                if not isinstance(items, list) or len(items) != 3:
                    raise AssertionError("TODO seeded items 无效")
                self._send_tool_calls(
                    "Plan 已确认并生成待办；我先读取目录结构。",
                    [
                        (
                            "todo:complex:start",
                            "todo__progress",
                            {
                                "planId": todo_fact["sourcePlanId"],
                                "revision": todo_fact["sourcePlanRevision"],
                                "updates": [
                                    {"todoId": items[0]["todoId"], "status": "inProgress"},
                                    {"todoId": items[1]["todoId"], "status": "pending"},
                                    {"todoId": items[2]["todoId"], "status": "pending"},
                                ],
                            },
                        ),
                        (
                            "e2e-call-todo-list",
                            "fs__list",
                            {"workspaceId": workspace_id, "path": ".", "depth": 2},
                        ),
                    ],
                )
            elif ordinal == 3 and "fs.list" in completed_tool_names:
                if todo_fact is None:
                    raise AssertionError("TODO continuation 缺少 durable Todo fact")
                items = todo_fact.get("items")
                if not isinstance(items, list) or len(items) != 3:
                    raise AssertionError("TODO continuation items 无效")
                self.provider_state.todo_continuation_started.set()
                self.provider_state.release_todo_continuation.wait(20)
                self._send_tool_call(
                    "目录读取完成；我正在收敛分析并更新待办。",
                    "todo:complex:done",
                    "todo__progress",
                    {
                        "planId": todo_fact["sourcePlanId"],
                        "revision": todo_fact["sourcePlanRevision"],
                        "updates": [
                            {"todoId": item["todoId"], "status": "completed"}
                            for item in items
                        ],
                    },
                )
            elif ordinal == 4:
                self._send_text("复杂任务的目录读取、链路分析与结论整理均已完成。", finish_reason="stop")
            else:
                raise AssertionError(
                    f"TODO Provider 轮次异常：ordinal={ordinal}, results={completed_tool_names}"
                )
        elif marker == "AUTONOMY":
            if ordinal == 1 and "fs.create" not in completed_tool_names:
                self._send_tool_call(
                    "当前工作区允许直接修改；无需发布权限门禁 Plan。",
                    "e2e-call-autonomy",
                    "fs__create",
                    {
                        "workspaceId": workspace_id,
                        "path": "autonomy.txt",
                        "content": "workspace autonomy\n",
                    },
                )
            elif ordinal == 2 and "fs.create" in completed_tool_names:
                self._send_text("已在绑定工作区内直接完成修改。", finish_reason="stop")
            else:
                raise AssertionError(
                    f"AUTONOMY Provider 轮次异常：ordinal={ordinal}, "
                    f"results={completed_tool_names}"
                )
        else:
            raise AssertionError(f"未知 E2E marker：{marker}")
        self._send_done()

    def _send_text(self, content: str, finish_reason: str | None = None) -> None:
        self._send_payload({
            "choices": [{
                "index": 0,
                "delta": {"content": content},
                "finish_reason": finish_reason,
            }],
            "usage": {"prompt_tokens": 120, "completion_tokens": 24},
        })

    def _send_tool_call(
        self,
        content: str,
        call_id: str,
        name: str,
        arguments: dict[str, Any],
    ) -> None:
        self._send_tool_calls(content, [(call_id, name, arguments)])

    def _send_tool_calls(
        self,
        content: str,
        calls: list[tuple[str, str, dict[str, Any]]],
    ) -> None:
        self._send_payload({
            "choices": [{
                "index": 0,
                "delta": {
                    "content": content,
                    "tool_calls": [
                        {
                            "index": index,
                            "id": call_id,
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": json.dumps(arguments, separators=(",", ":")),
                            },
                        }
                        for index, (call_id, name, arguments) in enumerate(calls)
                    ],
                },
                "finish_reason": "tool_calls",
            }],
            "usage": {"prompt_tokens": 140, "completion_tokens": 30},
        })

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
            except Exception:
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


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


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


def expect_api_error(
    daemon: OwnedDaemon,
    path: str,
    code: str,
    *,
    method: str = "GET",
    body: dict[str, Any] | None = None,
) -> None:
    envelope = api_envelope(
        daemon.base_url,
        path,
        token=daemon.token,
        method=method,
        body=body,
    )
    require(envelope.get("ok") is False, f"{path} 意外成功")
    require(envelope.get("error") == code, f"{path} 错误码漂移：{envelope}")


def projection(daemon: OwnedDaemon, session_id: str) -> dict[str, Any]:
    path_id = urllib.parse.quote(session_id, safe="")
    value = api_json(
        daemon.base_url,
        f"/api/conversation/sessions/{path_id}/projection",
        token=daemon.token,
    )
    require(isinstance(value, dict), "SessionProjection 不是对象")
    require(value.get("schemaVersion") == "deepcode.session-projection", "投影协议不是当前值")
    require(value.get("sessionId") == session_id, "SessionProjection identity 漂移")
    return value


def wait_projection(
    daemon: OwnedDaemon,
    session_id: str,
    predicate: Callable[[dict[str, Any]], bool],
    label: str,
) -> dict[str, Any]:
    def current_if_ready() -> dict[str, Any] | None:
        current = projection(daemon, session_id)
        if predicate(current):
            return current
        run = current.get("run") or {}
        if run.get("status") in {"completed", "failed", "cancelled", "indeterminate"}:
            raise AssertionError(
                f"Session 在到达 {label} 前已终止："
                f"status={run.get('status')} error={current.get('terminalError')}"
            )
        return None

    return wait_until(current_if_ready, 15, f"Session 未到达 {label}")


def shell_environment(daemon: OwnedDaemon) -> dict[str, str]:
    environment = os.environ.copy()
    environment["DEEPCODE_HOST_SHELL_TOKEN"] = daemon.token
    environment["DEEPCODE_CLI_RUN_TIMEOUT_MS"] = "15000"
    return environment


def run_cli(
    daemon: OwnedDaemon,
    *arguments: str,
    timeout: float = 18,
) -> subprocess.CompletedProcess[str]:
    require(CLI_BINARY.is_file(), f"缺少 CLI：{CLI_BINARY}")
    return subprocess.run(
        [
            str(CLI_BINARY),
            "--api", daemon.base_url,
            "--no-auto-start-kernel",
            *arguments,
        ],
        cwd=ROOT,
        env=shell_environment(daemon),
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def run_tui(
    daemon: OwnedDaemon,
    session_id: str,
    *,
    input_text: str | None = None,
    smoke: bool = False,
    timeout: float = 18,
) -> subprocess.CompletedProcess[str]:
    require(TUI_BINARY.is_file(), f"缺少 TUI：{TUI_BINARY}")
    arguments = [
        str(TUI_BINARY),
        "--api", daemon.base_url,
        "--no-auto-start-kernel",
        "--session", session_id,
    ]
    if smoke:
        arguments.append("--smoke")
    return subprocess.run(
        arguments,
        cwd=ROOT,
        env=shell_environment(daemon),
        input=input_text,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def create_session(
    daemon: OwnedDaemon,
    *,
    workspace_paths: list[Path] | None = None,
    project_id: str | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {}
    if workspace_paths is not None:
        body["workspacePaths"] = [str(path) for path in workspace_paths]
    if project_id is not None:
        body["projectId"] = project_id
    value = api_json(
        daemon.base_url,
        "/api/conversation/sessions",
        token=daemon.token,
        method="POST",
        body=body,
        timeout=12,
    )
    require(isinstance(value, dict), "create Session 未返回 projection")
    require(isinstance(value.get("sessionId"), str), "Session id 无效")
    return value


def command(daemon: OwnedDaemon, session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    path_id = urllib.parse.quote(session_id, safe="")
    value = api_json(
        daemon.base_url,
        f"/api/conversation/sessions/{path_id}/commands",
        token=daemon.token,
        method="POST",
        body=payload,
        timeout=15,
    )
    require(isinstance(value, dict), "command reply 不是对象")
    return value


def message_command(session_id: str, command_id: str, text: str) -> dict[str, Any]:
    return {
        "schemaVersion": COMMAND_VERSION,
        "type": "message.submit",
        "commandId": command_id,
        "sessionId": session_id,
        "text": text,
    }


def plan_command(
    session_id: str,
    command_id: str,
    run_id: str,
    plan: dict[str, Any],
    response: dict[str, Any],
) -> dict[str, Any]:
    return {
        "schemaVersion": COMMAND_VERSION,
        "type": "plan.respond",
        "commandId": command_id,
        "sessionId": session_id,
        "runId": run_id,
        "planId": plan["planId"],
        "revision": plan["revision"],
        "response": response,
    }


def run_execute(
    daemon: OwnedDaemon,
    workspace: Path,
    provider: ProviderState,
) -> tuple[str, str, int, str]:
    created = create_session(daemon, workspace_paths=[workspace])
    session_id = created["sessionId"]
    workspace_id = created["workspaceBindings"][0]["workspaceId"]
    original = message_command(
        session_id,
        "command:execute:start",
        "E2E EXECUTE：先给出结构化计划，再创建文件。",
    )
    reply = command(daemon, session_id, original)
    require(reply.get("status") == "accepted", "EXECUTE 消息未接纳")
    waiting = wait_projection(
        daemon,
        session_id,
        lambda item: (item.get("run") or {}).get("status") == "waiting"
        and item.get("pendingPlan") is not None,
        "EXECUTE Plan waiting",
    )
    run_id = waiting["run"]["runId"]
    plan = waiting["pendingPlan"]
    require(plan.get("responseMode") == "confirmReviseOrCancel", "Plan responseMode 错误")
    require(plan.get("revision") == 1, "首个 Plan revision 错误")
    require(plan.get("title") == "创建验收文件", "Plan 标题错误")
    require(
        plan.get("mutationManifest") == [{
            "workspaceId": workspace_id,
            "operation": "fs.create",
            "target": "executed.txt",
        }],
        "Plan mutationManifest 没有精确 target",
    )
    require(
        any(
            "准备一个精确的写入计划" in item.get("content", "")
            for item in waiting.get("narratives", [])
        ),
        "Plan 前没有 LLM narrative",
    )
    require(not (workspace / "executed.txt").exists(), "Plan 选择前已经写入文件")

    switched = run_cli(
        daemon,
        "--session", session_id,
        "model", "e2e-secondary",
    )
    require(switched.returncode == 0, f"CLI 中途切换模型失败：{switched.stderr}")
    require("e2e-secondary" in switched.stdout, "CLI 没有确认中途模型切换")
    switched_projection = projection(daemon, session_id)
    require(
        (switched_projection.get("run") or {}).get("profileId") == "e2e-secondary",
        "中途模型选择没有进入共享投影",
    )

    resolved = run_tui(daemon, session_id, input_text="1\n/quit\n", timeout=25)
    require(resolved.returncode == 0, f"TUI 确认 Plan 失败：{resolved.stderr}")
    output = f"{resolved.stdout}\n{resolved.stderr}"
    require("Plan · revision 1" in output and "1. 创建验收文件" in output, "TUI 没有渲染完整 Plan")
    require("工具 fs.create [completed]" in output, "TUI 没有渲染完成的工具事实")
    require(
        "assistant: 已完成 **Plan 授权** 的文件创建。" in output,
        f"TUI 缺少最终回答：{output}",
    )
    final = wait_projection(
        daemon,
        session_id,
        lambda item: (item.get("run") or {}).get("status") == "completed",
        "EXECUTE completed",
    )
    require(final.get("pendingPlan") is None, "选择后 Plan 未从投影消失")
    require((workspace / "executed.txt").read_text() == EXPECTED_CONTENT, "执行文件内容错误")
    activities = [
        item for item in final.get("activities", [])
        if item.get("kind") == "tool"
        and (item.get("tool") or {}).get("operation") == "fs.create"
    ]
    require(
        len(activities) == 1 and activities[0].get("status") == "completed",
        "工具 activity 错误",
    )
    require(
        any(
            "计划已确认" in item.get("content", "")
            for item in final.get("narratives", [])
        ),
        "工具调用前没有 LLM 过渡性 narrative",
    )
    require(final.get("contextUsage", {}).get("inputTokens") == 120, "context usage 未进入投影")

    count_before = provider.count()
    replay = command(daemon, session_id, original)
    require(replay.get("status") == "replayed", "相同 commandId 未精确回放")
    require(replay.get("revision") == reply.get("revision"), "回放 revision 不是原始值")
    assert_count_stable(provider, count_before, 0.35, "命令回放重复调用 Provider")
    require((workspace / "executed.txt").read_text() == EXPECTED_CONTENT, "回放改变了工具结果")
    return session_id, run_id, int(final["revision"]), workspace_id


def run_feedback(daemon: OwnedDaemon, workspace: Path) -> tuple[str, str]:
    created = create_session(daemon, workspace_paths=[workspace])
    session_id = created["sessionId"]
    original = message_command(
        session_id,
        "command:feedback:start",
        "E2E FEEDBACK：给出计划并等待我调整。",
    )
    require(command(daemon, session_id, original).get("status") == "accepted", "FEEDBACK 未接纳")
    waiting = wait_projection(
        daemon,
        session_id,
        lambda item: item.get("pendingPlan") is not None,
        "FEEDBACK Plan waiting",
    )
    run_id = waiting["run"]["runId"]
    original_plan = waiting["pendingPlan"]
    feedback = "改为只说明 docs/notes.md，不执行写入"
    revised_reply = run_cli(daemon, "--session", session_id, "ask", feedback, timeout=25)
    require(revised_reply.returncode == 5, f"CLI Plan 修订没有停在新 Plan Gate：{revised_reply.stderr}")
    revised = wait_projection(
        daemon,
        session_id,
        lambda item: (item.get("pendingPlan") or {}).get("revision") == 2,
        "FEEDBACK revised Plan waiting",
    )
    require(revised["pendingPlan"]["planId"] == original_plan["planId"], "修订 PlanId 漂移")
    require(revised["pendingPlan"]["mutationManifest"] == [], "修订 Plan 意外保留 mutation")
    completed = run_cli(daemon, "--session", session_id, "ask", "确认", timeout=25)
    require(completed.returncode == 0, f"CLI 确认修订 Plan 失败：{completed.stderr}")
    output = f"{completed.stdout}\n{completed.stderr}"
    require("本轮未执行 workspace mutation" in output, "修订确认后没有 LLM 最终答复")
    final = wait_projection(
        daemon,
        session_id,
        lambda item: (item.get("run") or {}).get("status") == "completed",
        "FEEDBACK completed",
    )
    require(final.get("pendingPlan") is None, "修订确认后 Plan 未关闭")
    require(
        [(plan.get("revision"), plan.get("status")) for plan in final.get("plans", [])]
        == [(1, "superseded"), (2, "confirmed")],
        "Plan revision lifecycle 错误",
    )
    require(not (workspace / "feedback.txt").exists(), "反馈路线意外获得写入 authority")
    require(not (workspace / "docs" / "notes.md").exists(), "自然语言反馈被误当作 Plan")
    require(
        not any(item.get("kind") == "tool" for item in final.get("activities", [])),
        "反馈路线执行了工具",
    )
    return session_id, run_id


def run_plan_cancel(daemon: OwnedDaemon, workspace: Path) -> tuple[str, str]:
    created = create_session(daemon, workspace_paths=[workspace])
    session_id = created["sessionId"]
    original = message_command(
        session_id,
        "command:plan-cancel:start",
        "E2E PLAN_CANCEL：给出计划，我将明确取消。",
    )
    require(command(daemon, session_id, original).get("status") == "accepted", "PLAN_CANCEL 未接纳")
    waiting = wait_projection(
        daemon,
        session_id,
        lambda item: item.get("pendingPlan") is not None,
        "PLAN_CANCEL Plan waiting",
    )
    run_id = waiting["run"]["runId"]
    completed = run_cli(daemon, "--session", session_id, "cancel-plan", timeout=25)
    require(completed.returncode == 0, f"CLI 取消 Plan 失败：{completed.stderr}")
    output = f"{completed.stdout}\n{completed.stderr}"
    require("已取消计划" in output, "取消后没有 LLM 最终回答")
    final = wait_projection(
        daemon,
        session_id,
        lambda item: (item.get("run") or {}).get("status") == "completed",
        "PLAN_CANCEL completed",
    )
    require(final.get("pendingPlan") is None, "取消后 Plan 未关闭")
    require(final.get("plans", [])[0].get("status") == "cancelled", "Plan 未进入 cancelled")
    require(not (workspace / "ignored.txt").exists(), "取消后仍执行了 mutation")
    require(
        not any(item.get("kind") == "tool" for item in final.get("activities", [])),
        "取消路线执行了工具",
    )
    return session_id, run_id


def run_cancel(
    daemon: OwnedDaemon,
    workspace: Path,
    provider: ProviderState,
) -> tuple[str, str]:
    created = create_session(daemon, workspace_paths=[workspace])
    session_id = created["sessionId"]
    original = message_command(
        session_id,
        "command:cancel:start",
        "E2E CANCEL：输出进度后等待取消。",
    )
    require(command(daemon, session_id, original).get("status") == "accepted", "CANCEL 未接纳")
    wait_until(provider.cancel_started.is_set, 10, "Provider CANCEL 流未开始")
    running = wait_projection(
        daemon,
        session_id,
        lambda item: (item.get("run") or {}).get("status") == "running"
        and "可取消" in (item.get("assistantDraft") or {}).get("content", ""),
        "CANCEL running with transient assistant draft",
    )
    run_id = running["run"]["runId"]
    completed = run_cli(daemon, "--session", session_id, "cancel", run_id)
    require(
        completed.returncode == CLI_CANCELLED_EXIT,
        f"CLI cancel 未返回 cancelled 专用非零退出码：{completed.returncode}\n{completed.stderr}",
    )
    final = wait_projection(
        daemon,
        session_id,
        lambda item: (item.get("run") or {}).get("status") == "cancelled",
        "CANCEL cancelled",
    )
    require(final.get("pendingPlan") is None, "取消后仍有 Plan")
    require(final.get("pendingInteraction") is None, "取消后仍有 interaction")
    require(final.get("assistantDraft") is None, "取消后仍有 assistant draft")
    provider.release_cancel.set()
    return session_id, run_id


def run_failure(daemon: OwnedDaemon, workspace: Path) -> tuple[str, str]:
    created = create_session(daemon, workspace_paths=[workspace])
    session_id = created["sessionId"]
    original = message_command(
        session_id,
        "command:fail:start",
        "E2E FAIL：返回字段非法的 Session control call。",
    )
    require(command(daemon, session_id, original).get("status") == "accepted", "FAIL 未接纳")
    failed = wait_projection(
        daemon,
        session_id,
        lambda item: (item.get("run") or {}).get("status") == "failed",
        "FAIL failed",
    )
    run_id = failed["run"]["runId"]
    require(
        failed.get("terminalError", {}).get("code") == "session_control_plan_steps_invalid",
        f"FAIL 原始结构错误未保留：{failed.get('terminalError')}",
    )
    shown = run_cli(daemon, "--session", session_id, "show")
    require(shown.returncode == 6, f"CLI failed 状态必须非零 6，实际 {shown.returncode}")
    require(
        "session_control_plan_steps_invalid" in f"{shown.stdout}\n{shown.stderr}",
        "CLI 未显示失败根因",
    )
    return session_id, run_id


def run_todo(
    daemon: OwnedDaemon,
    workspace: Path,
    provider: ProviderState,
) -> tuple[str, str, int, str]:
    created = create_session(daemon, workspace_paths=[workspace])
    session_id = created["sessionId"]
    bindings = created.get("workspaceBindings", [])
    require(len(bindings) == 1, "TODO Session 没有固定单一 workspace binding")
    workspace_id = bindings[0].get("workspaceId")
    require(isinstance(workspace_id, str), "TODO Session workspaceId 缺失")
    original = message_command(
        session_id,
        "command:todo:start",
        "E2E TODO：这是复杂任务，请先形成 Todo，再读取目录并整理结论。",
    )
    require(command(daemon, session_id, original).get("status") == "accepted", "TODO 未接纳")
    plan_waiting = wait_projection(
        daemon,
        session_id,
        lambda item: item.get("pendingPlan") is not None,
        "TODO Plan waiting",
    )
    run_id = plan_waiting["run"]["runId"]
    confirm = command(
        daemon,
        session_id,
        plan_command(
            session_id,
            "command:todo:confirm",
            run_id,
            plan_waiting["pendingPlan"],
            {"kind": "confirm"},
        ),
    )
    require(confirm.get("status") == "accepted", "TODO Plan 确认未接纳")
    wait_until(
        provider.todo_continuation_started.is_set,
        12,
        "TODO 第二个 Provider turn 未开始",
    )
    active = wait_projection(
        daemon,
        session_id,
        lambda item: (item.get("run") or {}).get("status") == "running"
        and item.get("todoList") is not None
        and any(
            todo.get("status") == "inProgress"
            for todo in item["todoList"].get("items", [])
        ),
        "TODO active projection",
    )
    require(
        [todo.get("sourceStepId") for todo in active["todoList"]["items"]]
        == ["step:inspect", "step:analyze", "step:answer"],
        "复杂任务 Todo 与 Plan step 顺序映射错误",
    )
    list_activities = [
        item for item in active.get("activities", [])
        if item.get("kind") == "tool"
        and (item.get("tool") or {}).get("operation") == "fs.list"
    ]
    require(
        len(list_activities) == 1 and list_activities[0].get("status") == "completed",
        "复杂任务的 fs.list activity 未进入共享投影",
    )
    require(
        any(
            "生成待办" in item.get("content", "")
            for item in active.get("narratives", [])
        ),
        "复杂任务调用工具前缺少 LLM narrative",
    )

    provider.release_todo_continuation.set()
    final = wait_projection(
        daemon,
        session_id,
        lambda item: (item.get("run") or {}).get("status") == "completed",
        "TODO completed",
    )
    require(
        all(todo.get("status") == "completed" for todo in final["todoList"]["items"]),
        "复杂任务结束时 Todo 没有由 LLM 更新为 completed",
    )
    require(
        final.get("messages", [])[-1].get("content")
        == "复杂任务的目录读取、链路分析与结论整理均已完成。",
        "复杂任务最终回答错误",
    )
    cli = run_cli(daemon, "--session", session_id, "show")
    require(cli.returncode == 0, f"CLI 读取 Todo 共享投影失败：{cli.stderr}")
    require(
        "Todo" in cli.stdout and "[x] 读取项目结构" in cli.stdout,
        "CLI 没有渲染 Session Todo 投影",
    )
    tui = run_tui(daemon, session_id, smoke=True)
    require(tui.returncode == 0, f"TUI 读取 Todo 共享投影失败：{tui.stderr}")
    require(
        "Todo" in tui.stdout and "[x] 读取项目结构" in tui.stdout,
        "TUI 没有渲染 Session Todo 投影",
    )
    return session_id, run_id, int(final["revision"]), workspace_id


def assert_shells_read_shared_projection(
    daemon: OwnedDaemon,
    session_id: str,
    expected_revision: int,
    forbidden_root: Path,
) -> None:
    cli = run_cli(daemon, "--session", session_id, "show")
    require(cli.returncode == 0, f"CLI 读取共享投影失败：{cli.stderr}")
    cli_output = f"{cli.stdout}\n{cli.stderr}"
    require(
        f"session={session_id} revision={expected_revision}" in cli_output,
        "CLI 没有读取预期 SessionProjection revision",
    )
    require(
        "assistant: 已完成 **Plan 授权** 的文件创建。" in cli_output,
        "CLI 缺少共享 answer",
    )
    require("工具 fs.create [completed]" in cli_output, "CLI 缺少共享工具 activity")
    require(str(forbidden_root) not in cli_output, "CLI 普通投影泄露绝对路径")

    tui = run_tui(daemon, session_id, smoke=True)
    require(tui.returncode == 0, f"TUI 读取共享投影失败：{tui.stderr}")
    require(
        tui.stdout.startswith("DeepCode TUI\n")
        and f"session={session_id} revision={expected_revision}" in tui.stdout,
        "TUI 未从当前共享投影渲染精确 Session 身份",
    )
    require(
        f"session={session_id} revision={expected_revision}" in tui.stdout,
        "TUI 没有读取预期 SessionProjection revision",
    )
    require(
        "assistant: 已完成 **Plan 授权** 的文件创建。" in tui.stdout,
        "TUI 缺少共享 answer",
    )
    require("工具 fs.create [completed]" in tui.stdout, "TUI 缺少共享工具 activity")
    require(str(forbidden_root) not in tui.stdout, "TUI 普通投影泄露绝对路径")


def exercise_catalog(
    daemon: OwnedDaemon,
    primary: Path,
    secondary: Path,
) -> None:
    catalog = api_json(
        daemon.base_url,
        "/api/conversation/projects",
        token=daemon.token,
        method="POST",
        body={"title": "多目录项目", "workspacePaths": [str(primary), str(secondary)]},
    )
    require(isinstance(catalog, dict), "创建项目未返回 Catalog")
    project = next(item for item in catalog["projects"] if item["title"] == "多目录项目")
    project_id = project["id"]
    require(len(project["workspaceBindings"]) == 2, "项目没有保存多个 binding 模板")
    public_text = json.dumps(catalog, ensure_ascii=False)
    require("canonicalRoot" not in public_text, "普通 Catalog 暴露 canonicalRoot 字段")
    require(
        str(primary) not in public_text and str(secondary) not in public_text,
        "普通 Catalog 暴露路径",
    )

    management = api_json(
        daemon.base_url,
        "/api/conversation/catalog/manage",
        token=daemon.token,
    )
    roots = {item["canonicalRoot"] for item in management["workspaces"]}
    require(
        str(primary.resolve()) in roots and str(secondary.resolve()) in roots,
        "管理面板看不到真实路径",
    )

    existing = create_session(daemon, project_id=project_id)
    require(len(existing["workspaceBindings"]) == 2, "项目 Session 未取得创建快照")
    existing_id = existing["sessionId"]
    api_json(
        daemon.base_url,
        f"/api/conversation/projects/{urllib.parse.quote(project_id, safe='')}",
        token=daemon.token,
        method="PATCH",
        body={"workspacePaths": [str(primary)]},
    )
    require(
        len(projection(daemon, existing_id)["workspaceBindings"]) == 2,
        "已有 Session snapshot 被项目更新改写",
    )
    newer = create_session(daemon, project_id=project_id)
    require(len(newer["workspaceBindings"]) == 1, "新 Session 没有使用更新后的项目模板")
    newer_id = newer["sessionId"]

    independent = create_session(daemon)
    independent_id = independent["sessionId"]
    require(independent["workspaceBindings"] == [], "独立 Session 不应隐式获得 binding")
    moved_catalog = api_json(
        daemon.base_url,
        f"/api/conversation/sessions/{urllib.parse.quote(independent_id, safe='')}",
        token=daemon.token,
        method="PATCH",
        body={"projectId": project_id},
    )
    moved = next(item for item in moved_catalog["sessions"] if item["id"] == independent_id)
    require(moved["projectId"] == project_id, "Session 归类没有变化")
    require(moved["workspaceBindings"] == [], "移入项目静默新增了 workspace grant")
    require(
        projection(daemon, independent_id)["workspaceBindings"] == [],
        "Session 投影 snapshot 被归类改写",
    )

    for session_id in (existing_id, newer_id, independent_id):
        path_id = urllib.parse.quote(session_id, safe="")
        api_json(
            daemon.base_url,
            f"/api/conversation/sessions/{path_id}",
            token=daemon.token,
            method="DELETE",
        )
        expect_api_error(
            daemon,
            f"/api/conversation/sessions/{path_id}/projection",
            "session_not_found",
        )
    api_json(
        daemon.base_url,
        f"/api/conversation/projects/{urllib.parse.quote(project_id, safe='')}",
        token=daemon.token,
        method="DELETE",
    )
    final_catalog = api_json(
        daemon.base_url,
        "/api/conversation/catalog",
        token=daemon.token,
    )
    require(final_catalog["projects"] == [], "项目删除后仍在 Catalog")
    require(
        all(
            item["id"] not in {existing_id, newer_id, independent_id}
            for item in final_catalog["sessions"]
        ),
        "删除的对话仍在 Catalog",
    )


def assert_count_stable(
    provider: ProviderState,
    expected: int,
    duration: float,
    message: str,
) -> None:
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        require(provider.count() == expected, message)
        time.sleep(0.05)


def inspect_sqlite(
    config_root: Path,
    expected_runs: dict[str, tuple[str, str]],
    execute_session: str,
    execute_workspace_id: str,
    expected_todo_workspace_id: str,
) -> None:
    runtime_root = config_root / "runtime" / "agent-runtime"
    catalog_path = runtime_root / "catalog.sqlite3"
    session_path = runtime_root / "session.sqlite3"
    record_path = runtime_root / "tool-record.sqlite3"
    expected_versions = {
        catalog_path: 1,
        session_path: 2,
        record_path: 1,
    }
    for path, expected_version in expected_versions.items():
        require(path.is_file(), f"当前 Store 未落盘：{path.name}")
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as connection:
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            require(
                version == expected_version,
                f"{path.name} user_version 不是 {expected_version}",
            )

    with sqlite3.connect(f"file:{session_path}?mode=ro", uri=True) as connection:
        rows = connection.execute(
            "SELECT session_id, sequence, event_type, run_id, call_id, payload_json "
            "FROM session_events ORDER BY session_id, sequence"
        ).fetchall()
        by_session: dict[str, list[dict[str, Any]]] = {}
        for session_id, sequence, event_type, run_id, call_id, encoded in rows:
            event = {
                "sequence": sequence,
                "type": event_type,
                "runId": run_id,
                "callId": call_id,
                "payload": json.loads(encoded),
            }
            by_session.setdefault(session_id, []).append(event)
        require(set(by_session) == set(expected_runs), "Session Store 出现意外 Session")
        for session_id, events in by_session.items():
            require(
                [event["sequence"] for event in events] == list(range(1, len(events) + 1)),
                f"{session_id} sequence 不连续",
            )
            require(
                not any(
                    event["type"] in {"executor.started", "run.settling", "assistant.chunk"}
                    for event in events
                ),
                "A1-min/A1-transient 不应新增 executor.started、run.settling 或 assistant.chunk",
            )
            run_id, expected_outcome = expected_runs[session_id]
            settlements = [
                event for event in events
                if event["type"] == "run.settled" and event["runId"] == run_id
            ]
            require(len(settlements) == 1, f"{session_id} settlement 数量不是 1")
            payload = settlements[0]["payload"]
            require(payload.get("outcome") == expected_outcome, f"{session_id} outcome 错误")
            if expected_outcome == "completed":
                require(
                    set(payload) == {"outcome", "finalMessageId"},
                    "completed settlement 字段错误",
                )
                require(
                    any(
                        event["type"] == "message.committed"
                        and event["runId"] == run_id
                        and event["payload"].get("role") == "assistant"
                        and event["payload"].get("messageId") == payload["finalMessageId"]
                        for event in events
                    ),
                    "completed settlement 未绑定 LLM answer",
                )
            elif expected_outcome == "cancelled":
                require(payload == {"outcome": "cancelled"}, "cancelled settlement 字段错误")
            else:
                require(
                    payload.get("error", {}).get("code")
                    == "session_control_plan_steps_invalid",
                    "失败根因漂移",
                )

        execute_confirmations = [
            event for event in by_session[execute_session]
            if event["type"] == "plan.confirmed"
        ]
        require(len(execute_confirmations) == 1, "EXECUTE Plan confirmation 数量错误")
        confirmed = execute_confirmations[0]["payload"]
        require(confirmed.get("revision") == 1, "Plan confirmation revision 错误")
        authorities = confirmed.get("authorities", [])
        require(len(authorities) == 1, "Plan 确认没有产生单一 authority")
        authority = authorities[0]
        require(authority["sessionId"] == execute_session, "PlanAuthority sessionId 错误")
        require("runId" not in authority, "PlanAuthority 不应绑定单一 runId")
        require(authority["revision"] == 1, "PlanAuthority revision 错误")
        require(authority["decisionId"] == confirmed["decisionId"], "PlanAuthority decisionId 错误")
        require(authority["workspaceId"] == execute_workspace_id, "PlanAuthority workspaceId 错误")
        require(
            authority["coveredOperations"] == [{
                "workspaceId": execute_workspace_id,
                "operation": "fs.create",
                "target": "executed.txt",
            }],
            "PlanAuthority coverage 错误",
        )

        feedback_session = next(
            sid for sid, (_, outcome) in expected_runs.items()
            if outcome == "completed"
            and sid != execute_session
            and any(
                event["payload"].get("providerCallId") == "plan:feedback"
                for event in by_session[sid]
                if event["type"] == "plan.published"
            )
        )
        feedback_events = by_session[feedback_session]
        require(
            len([event for event in feedback_events if event["type"] == "plan.revision.requested"]) == 1,
            "Plan revision request 事实错误",
        )
        require(
            len([event for event in feedback_events if event["type"] == "plan.superseded"]) == 1,
            "旧 Plan revision 未 supersede",
        )
        revised_confirmation = next(
            event["payload"] for event in feedback_events
            if event["type"] == "plan.confirmed"
        )
        require(revised_confirmation["revision"] == 2, "修订 Plan revision 错误")
        require(revised_confirmation["authorities"] == [], "无 mutation 修订 Plan 意外产生 authority")

        plan_cancel_session = next(
            sid for sid, (_, outcome) in expected_runs.items()
            if outcome == "completed"
            and sid != execute_session
            and any(
                event["payload"].get("providerCallId") == "plan:ignore"
                for event in by_session[sid]
                if event["type"] == "plan.published"
            )
        )
        require(
            len([
                event for event in by_session[plan_cancel_session]
                if event["type"] == "plan.cancelled"
            ]) == 1,
            "Plan cancel 事实错误",
        )
        require(
            not any(
                event["type"] == "plan.confirmed"
                for event in by_session[plan_cancel_session]
            ),
            "Plan cancel 意外产生 confirmation",
        )

        todo_sessions = [
            sid for sid, events in by_session.items()
            if any(event["type"] == "todo.progressed" for event in events)
        ]
        require(len(todo_sessions) == 1, f"复杂任务 Todo Session 数量错误：{todo_sessions}")
        todo_seed = next(
            event for event in by_session[todo_sessions[0]]
            if event["type"] == "todo.seeded"
        )
        require(
            [item["sourceStepId"] for item in todo_seed["payload"]["items"]]
            == ["step:inspect", "step:analyze", "step:answer"],
            "Todo seed 没有绑定 Plan steps",
        )
        todo_events = [
            event for event in by_session[todo_sessions[0]]
            if event["type"] == "todo.progressed"
        ]
        require(
            [event["payload"]["providerCallId"] for event in todo_events]
            == ["todo:complex:start", "todo:complex:done"],
            "Todo durable Provider 调用顺序错误",
        )
        require(
            [item["status"] for item in todo_events[0]["payload"]["updates"]]
            == ["inProgress", "pending", "pending"],
            "Todo 初始状态错误",
        )
        require(
            all(item["status"] == "completed" for item in todo_events[1]["payload"]["updates"]),
            "Todo 完成状态错误",
        )
        require(
            any(
                event["type"] == "plan.completed"
                for event in by_session[todo_sessions[0]]
            ),
            "Todo 全部完成后 Plan 未进入 completed",
        )

        command_counts = dict(connection.execute(
            "SELECT session_id, COUNT(*) FROM session_commands GROUP BY session_id"
        ).fetchall())
        expected_command_counts = {
            execute_session: 3,
            feedback_session: 3,
            plan_cancel_session: 2,
            todo_sessions[0]: 2,
        }
        for session_id, (_, outcome) in expected_runs.items():
            if session_id not in expected_command_counts:
                expected_command_counts[session_id] = 2 if outcome == "cancelled" else 1
        require(
            command_counts == expected_command_counts,
            f"命令 durable 数量错误：{command_counts}",
        )
        execute_tool_call_id = next(
            event["callId"] for event in by_session[execute_session]
            if event["type"] == "tool.requested"
            and event["payload"].get("providerCallId") == "e2e-call-execute"
        )
        todo_tool_call_id = next(
            event["callId"] for event in by_session[todo_sessions[0]]
            if event["type"] == "tool.requested"
            and event["payload"].get("providerCallId") == "e2e-call-todo-list"
        )

    with sqlite3.connect(f"file:{record_path}?mode=ro", uri=True) as connection:
        rows = connection.execute(
            "SELECT call_id, workspace_id, operation, logical_targets_json, record_json "
            "FROM tool_records ORDER BY call_id"
        ).fetchall()
        require(len(rows) == 2, "ToolRecord 数量错误")
        rows_by_call = {row[0]: row for row in rows}
        require(
            set(rows_by_call) == {execute_tool_call_id, todo_tool_call_id},
            "ToolRecord 没有绑定 Session LogicalCallId",
        )
        call_id, workspace_id, operation, logical_targets, encoded = rows_by_call[
            execute_tool_call_id
        ]
        record = json.loads(encoded)
        require(call_id == execute_tool_call_id, "ToolRecord callId 错误")
        require(workspace_id == execute_workspace_id, "ToolRecord workspaceId 错误")
        require(operation == "fs.create", "ToolRecord operation 错误")
        require(json.loads(logical_targets) == ["executed.txt"], "ToolRecord logical targets 错误")
        require(record.get("outcome") == "completed", "ToolRecord outcome 错误")
        require(
            record.get("input") == {
                "workspaceId": execute_workspace_id,
                "path": "executed.txt",
                "content": EXPECTED_CONTENT,
            },
            "ToolRecord 原始 input 漂移",
        )
        require(
            record.get("authority", {}).get("source") == "plan",
            "mutation 未使用 PlanAuthority",
        )
        prepared = record.get("preparedEffect", {})
        require(prepared.get("workspaceId") == execute_workspace_id, "PreparedEffect workspaceId 错误")
        require(prepared.get("operation") == "fs.create", "PreparedEffect operation 错误")
        require(prepared.get("logicalTargets") == ["executed.txt"], "PreparedEffect target 错误")
        require(
            prepared.get("canonicalInvocation", {}).get("arguments", {}).get("path")
            == "executed.txt",
            "PreparedEffect canonical invocation 错误",
        )
        todo_call_id, todo_workspace_id, todo_operation, todo_targets, todo_encoded = rows_by_call[
            todo_tool_call_id
        ]
        todo_record = json.loads(todo_encoded)
        require(todo_call_id == todo_tool_call_id, "Todo ToolRecord callId 错误")
        require(
            todo_workspace_id == expected_todo_workspace_id,
            "Todo ToolRecord workspaceId 错误",
        )
        require(todo_operation == "fs.list", "Todo ToolRecord operation 错误")
        require(json.loads(todo_targets) == ["."], "Todo ToolRecord logical targets 错误")
        require(todo_record.get("outcome") == "completed", "Todo ToolRecord outcome 错误")
        require(
            todo_record.get("authority") == {
                "decision": "allow",
                "source": "workspaceBinding",
                "workspaceId": expected_todo_workspace_id,
            },
            "复杂任务目录读取没有使用当前 Session 的精确 workspace binding authority",
        )

    with sqlite3.connect(f"file:{catalog_path}?mode=ro", uri=True) as connection:
        require(
            connection.execute("SELECT COUNT(*) FROM projects").fetchone()[0] == 0,
            "删除项目后仍有项目",
        )
        session_ids = {
            row[0] for row in connection.execute("SELECT session_id FROM session_catalog")
        }
        require(session_ids == set(expected_runs), "Catalog 和 Session Store 的 Session 不一致")
        columns = {
            row[1] for row in connection.execute("PRAGMA table_info(session_catalog)")
        }
        require(
            columns == {
                "session_id",
                "title",
                "project_id",
                "workspace_bindings_json",
                "profile_id",
                "created_at",
                "updated_at",
            },
            f"Catalog Session 列不符合当前合同：{sorted(columns)}",
        )


def write_configuration(
    config_root: Path,
    provider_url: str,
    *,
    workspace_mutation: str = "plan",
    engineering_decisions: str = "ask",
) -> None:
    settings = config_root / "config" / "user" / "local" / "settings"
    settings.mkdir(parents=True)
    profile = {
        "profiles": [
            {
                "id": "e2e-primary",
                "name": "Local E2E Primary",
                "kind": "openaiCompatible",
                "providerFlavor": "openai",
                "baseUrl": provider_url,
                "model": "mock-primary",
                "contextWindowTokens": 4096,
                "maxOutputTokens": 1024,
                "enabled": True,
            },
            {
                "id": "e2e-secondary",
                "name": "Local E2E Secondary",
                "kind": "openaiCompatible",
                "providerFlavor": "openai",
                "baseUrl": provider_url,
                "model": "mock-secondary",
                "contextWindowTokens": 4096,
                "maxOutputTokens": 1024,
                "enabled": True,
            },
        ],
        "defaultProfileId": "e2e-primary",
    }
    (settings / "llm-profiles.json").write_text(
        json.dumps(profile, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    user_settings = {
        "gui.colorTheme": "light",
        "agent.permissions.workspaceMutation": workspace_mutation,
        "agent.permissions.engineeringDecisions": engineering_decisions,
    }
    (settings / "user-settings.json").write_text(
        json.dumps(user_settings, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def run_workspace_autonomy(daemon: OwnedDaemon, workspace: Path) -> None:
    created = create_session(daemon, workspace_paths=[workspace])
    session_id = created["sessionId"]
    workspace_id = created["workspaceBindings"][0]["workspaceId"]
    reply = command(
        daemon,
        session_id,
        message_command(
            session_id,
            "command:autonomy:start",
            "E2E AUTONOMY：直接完成绑定工作区修改，不发布 Plan。",
        ),
    )
    require(reply.get("status") == "accepted", "AUTONOMY 消息未接纳")
    completed = wait_projection(
        daemon,
        session_id,
        lambda item: (item.get("run") or {}).get("status") == "completed",
        "AUTONOMY completed",
    )
    require(completed.get("plans") == [], "关闭 Plan 门禁后仍发布了 Plan")
    require(completed.get("todoList") is None, "无 Plan 的直接修改意外生成 Todo")
    require(
        (workspace / "autonomy.txt").read_text(encoding="utf-8")
        == "workspace autonomy\n",
        "完全访问工作区模式没有创建目标文件",
    )

    record_path = (
        daemon.config_root / "runtime" / "agent-runtime" / "tool-record.sqlite3"
    )
    with sqlite3.connect(f"file:{record_path}?mode=ro", uri=True) as connection:
        rows = connection.execute(
            "SELECT workspace_id, operation, record_json FROM tool_records"
        ).fetchall()
    require(len(rows) == 1, "AUTONOMY ToolRecord 数量错误")
    record_workspace_id, operation, encoded = rows[0]
    record = json.loads(encoded)
    require(record_workspace_id == workspace_id, "AUTONOMY workspaceId 错误")
    require(operation == "fs.create", "AUTONOMY operation 错误")
    require(
        record.get("authority") == {
            "decision": "allow",
            "source": "userSetting",
            "authorityId": "user-setting:agent.permissions.workspaceMutation",
            "workspaceId": workspace_id,
        },
        "AUTONOMY 写入没有使用显式工作区权限设置",
    )


def main() -> None:
    provider_state = ProviderState()
    provider_server = MockProviderServer(provider_state)
    provider_thread = threading.Thread(target=provider_server.serve_forever, daemon=True)
    provider_thread.start()
    daemon_one: OwnedDaemon | None = None
    daemon_two: OwnedDaemon | None = None
    daemon_three: OwnedDaemon | None = None
    try:
        with tempfile.TemporaryDirectory(prefix="deepcode-agent-runtime-e2e-") as temporary:
            root = Path(temporary)
            config_root = root / "config-root"
            primary = root / "primary-workspace"
            secondary = root / "secondary-workspace"
            config_root.mkdir()
            primary.mkdir()
            secondary.mkdir()
            provider_state.forbid_roots([primary, secondary])
            provider_url = f"http://127.0.0.1:{provider_server.server_port}/v1"
            write_configuration(config_root, provider_url)

            daemon_one = OwnedDaemon(config_root)
            daemon_one.start()
            settings = api_json(
                daemon_one.base_url,
                "/api/user-settings",
                token=daemon_one.token,
            )
            require(
                settings.get("settings", {}).get("gui.colorTheme") == "light",
                "当前用户设置没有进入 Host 投影",
            )
            exercise_catalog(daemon_one, primary, secondary)

            execute_session, execute_run, execute_revision, workspace_id = run_execute(
                daemon_one,
                primary,
                provider_state,
            )
            feedback_session, feedback_run = run_feedback(daemon_one, primary)
            plan_cancel_session, plan_cancel_run = run_plan_cancel(daemon_one, primary)
            cancel_session, cancel_run = run_cancel(daemon_one, primary, provider_state)
            failure_session, failure_run = run_failure(daemon_one, primary)
            todo_session, todo_run, todo_revision, todo_workspace_id = run_todo(
                daemon_one,
                primary,
                provider_state,
            )
            require(provider_state.count("EXECUTE") == 3, "EXECUTE Provider 调用数错误")
            require(provider_state.count("FEEDBACK") == 3, "FEEDBACK Provider 调用数错误")
            require(provider_state.count("PLAN_CANCEL") == 2, "PLAN_CANCEL Provider 调用数错误")
            require(provider_state.count("CANCEL") == 1, "CANCEL Provider 调用数错误")
            require(provider_state.count("FAIL") == 2, "FAIL Provider 调用数错误")
            require(provider_state.count("TODO") == 4, "TODO Provider 调用数错误")
            require(
                provider_state.models("EXECUTE") == [
                    "mock-primary", "mock-secondary", "mock-secondary",
                ],
                f"中途模型切换未作用于后续 Provider 调用："
                f"{provider_state.models('EXECUTE')}",
            )
            assert_shells_read_shared_projection(
                daemon_one,
                execute_session,
                execute_revision,
                primary,
            )
            expected_runs = {
                execute_session: (execute_run, "completed"),
                feedback_session: (feedback_run, "completed"),
                plan_cancel_session: (plan_cancel_run, "completed"),
                cancel_session: (cancel_run, "cancelled"),
                failure_session: (failure_run, "failed"),
                todo_session: (todo_run, "completed"),
            }
            calls_before_restart = provider_state.count()
            daemon_one.shutdown()
            inspect_sqlite(
                config_root,
                expected_runs,
                execute_session,
                workspace_id,
                todo_workspace_id,
            )
            daemon_two = OwnedDaemon(config_root)
            daemon_two.start()
            recovered = projection(daemon_two, execute_session)
            require(
                (recovered.get("run") or {}).get("status") == "completed",
                "重启后 completed 丢失",
            )
            require(int(recovered["revision"]) == execute_revision, "重启后 projection revision 漂移")
            require(
                (primary / "executed.txt").read_text() == EXPECTED_CONTENT,
                "重启后文件事实改变",
            )
            recovered_todo = projection(daemon_two, todo_session)
            require(
                (recovered_todo.get("run") or {}).get("status") == "completed",
                "重启后复杂任务 completed 丢失",
            )
            require(
                int(recovered_todo["revision"]) == todo_revision,
                "重启后 Todo projection revision 漂移",
            )
            require(
                all(
                    item.get("status") == "completed"
                    for item in (recovered_todo.get("todoList") or {}).get("items", [])
                ),
                "重启后 durable Todo 投影丢失",
            )
            assert_count_stable(
                provider_state,
                calls_before_restart,
                0.35,
                "恢复 settled Session 时重复调用 Provider",
            )
            daemon_two.shutdown()
            inspect_sqlite(
                config_root,
                expected_runs,
                execute_session,
                workspace_id,
                todo_workspace_id,
            )
            autonomy_config_root = root / "autonomy-config-root"
            autonomy_workspace = root / "autonomy-workspace"
            autonomy_config_root.mkdir()
            autonomy_workspace.mkdir()
            provider_state.forbid_roots([primary, secondary, autonomy_workspace])
            write_configuration(
                autonomy_config_root,
                provider_url,
                workspace_mutation="allow",
                engineering_decisions="delegate",
            )
            daemon_three = OwnedDaemon(autonomy_config_root)
            daemon_three.start()
            run_workspace_autonomy(daemon_three, autonomy_workspace)
            require(provider_state.count("AUTONOMY") == 2, "AUTONOMY Provider 调用数错误")
            daemon_three.shutdown()
            print(
                "[local-agent-e2e] PASS "
                "plan/todo/autonomy/catalog/snapshot/replay/restart/cli/tui/failure"
            )
    finally:
        provider_state.release_cancel.set()
        provider_state.release_todo_continuation.set()
        if daemon_two is not None:
            daemon_two.close()
        if daemon_three is not None:
            daemon_three.close()
        if daemon_one is not None:
            daemon_one.close()
        provider_server.shutdown()
        provider_server.server_close()
        provider_thread.join(timeout=3)


if __name__ == "__main__":
    main()
