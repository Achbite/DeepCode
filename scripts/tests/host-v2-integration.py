#!/usr/bin/env python3
"""Real Host v2 integration behind the repository test controller.

This suite is supporting development evidence, not final product acceptance.
Its fixed Provider instruction proves the real Provider -> Session -> Kernel v2
ToolIntent -> canonical facts -> Provider continuation chain without replacing
manual CLI/GUI/TUI experience validation.
"""

from __future__ import annotations

import hashlib
import http.client
import http.server
import ctypes
import errno
import functools
import json
import os
import pathlib
import re
import shutil
import signal
import socket
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parents[2]
TARGET_DIR = pathlib.Path(os.environ.get("CARGO_TARGET_DIR", ROOT / "target"))
DAEMON = TARGET_DIR / "debug" / "deepcode-kernel-daemon"
CLI = TARGET_DIR / "debug" / "deepcode-cli"
ABI_VERSION = "deepcode.kernel.abi.v2"
FACT_STORE_SCHEMA_VERSION = "6"
CURRENT_FACT_STORE_SCHEMA_CONTRACT = "deepcode.kernel.fact-store.v2.sqlite.6"
PREDECESSOR_FACT_STORE_SCHEMA_CONTRACT = "deepcode.kernel.fact-store.v2.sqlite.5"
CURRENT_FACT_STORE_FILE_NAME = "kernel-v2-sqlite-6.sqlite3"
PREDECESSOR_FACT_STORE_FILE_NAME = "kernel-v2.sqlite3"
HOST_HEADER = "x-deepcode-host-shell-capability"
PROVIDER_TRACE_CAPABILITY_HEADER = "x-deepcode-provider-trace-capability"
PROVIDER_TRACE_DIGEST_HEADER = "x-deepcode-provider-trace-digest"
FINAL_TEXT = "Host v2 integration completed through the real Session bridge."
PROVIDER_REASONING = (
    "The controlled Provider verified the current Session input before answering. "
    * 12_000
)
CLI_PROMPT = "Return the controlled Host integration response through the CLI."
CLI_TOOL_PROMPT = (
    "Use the current fs.read tool to read README.md, then answer only after "
    "the canonical tool result is available."
)
CLI_TOOL_FINAL_TEXT = (
    "README.md was read through the real Session and Kernel v2 tool chain."
)
CLI_DELETE_PLAN_PROMPT = (
    "Propose one PlanAction to delete host-delete-preview-owned.txt, but do "
    "not execute it without explicit user confirmation."
)
CLI_DELETE_REPLAN_TEXT = (
    "The rejected deletion Plan will not be replaced or executed."
)
CLI_DELETE_FINAL_TEXT = (
    "The deletion Plan was rejected and the test-owned file remains unchanged."
)
FIXED_TOOL_REASONING = (
    "Use only the exposed read tool, then rely on canonical Kernel facts."
)
FIXED_TOOL_CALL_ID = "call-host-v2-read-readme"
FIXED_TOOL_ID = "fs.read"
FIXED_PROVIDER_TOOL_NAME = "dcv2_66732e72656164"
FIXED_TOOL_ARGUMENTS = {"path": "README.md"}
DELETE_TARGET_RELATIVE_PATH = "host-delete-preview-owned.txt"
DELETE_PLAN_REASONING = (
    "The requested mutation requires an explicit Plan and canonical Kernel scope preview."
)
DELETE_PLAN_CALL_ID = "call-host-v2-delete-plan"
DELETE_TOOL_ID = "fs.delete"
DELETE_PROVIDER_TOOL_NAME = "dcv2_66732e64656c657465"
SESSION_PLAN_PROPOSAL_TOOL_NAME = "deepcode_session_plan_propose_v3"
DELETE_PLAN_ARGUMENTS = {
    "schemaVersion": "deepcode.session.plan-proposal.v3",
    "plan": {
        "title": "Delete the test-owned file",
        "objective": "Delete exactly one test-owned workspace file after approval.",
        "narrative": (
            "Preview the exact file deletion scope and wait for the user's decision."
        ),
        "actions": [
            {
                "toolId": DELETE_TOOL_ID,
                "scopeIntent": {
                    "kind": "resourceScope",
                    "data": {
                        "requestedResources": [
                            {
                                "kind": "workspacePath",
                                "data": {
                                    "path": DELETE_TARGET_RELATIVE_PATH,
                                    "access": "write",
                                },
                            }
                        ],
                    },
                },
            }
        ],
    },
}
TEST_API_KEY = "host-v2-integration-key"
EXEC_DAEMON_ARGUMENT = "--exec-owned-daemon"
CLEANUP_OWNERS_ARGUMENT = "--cleanup-owned-resources"
EXEC_SIGNAL_MASK_ENV = "DEEPCODE_HOST_V2_EXEC_SIGNAL_MASK"
EXEC_RELEASE_FD_ENV = "DEEPCODE_HOST_V2_EXEC_RELEASE_FD"
OWNER_RECORD_SCHEMA = "deepcode.test.owner-process-group.v1"
CONTROL_SIGNALS = frozenset({signal.SIGINT, signal.SIGTERM})
BRIDGE = (ROOT / "userspace/session-core/dist/hostBridgeV2.js").resolve()
NODE_TEXT = shutil.which("node")
NODE = pathlib.Path(NODE_TEXT).resolve() if NODE_TEXT else None
HOST_CAPABILITY_PATTERN = re.compile(r"dchostv2_[A-Za-z0-9]{64}")
CHILD_ENVIRONMENT_ALLOWLIST = (
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TZ",
    "USER",
)
PROVIDER_TRACE_EXPORT_RESULT_SUCCEEDED = (
    "succeeded_body_producer_fully_delivered"
)
PROVIDER_TRACE_EXPORT_RESULT_RECEIVER_CLOSED = "body_receiver_closed"
PROVIDER_TRACE_EXPORT_RESULT_DEADLINE_EXCEEDED = "export_deadline_exceeded"


class IntegrationFailure(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise IntegrationFailure(message)


def safe_diagnostic(value: Any, *secrets: str) -> str:
    text = " ".join(str(value).split())
    for secret in (TEST_API_KEY, *secrets):
        if secret:
            text = text.replace(secret, "<redacted>")
    text = HOST_CAPABILITY_PATTERN.sub("<redacted-host-capability>", text)
    return text[:8192]


def info(message: str) -> None:
    print(f"[INFO] {message}", flush=True)


def passed(message: str) -> None:
    print(f"[PASS] {message}", flush=True)


def authority_value(prefix: str, fill: str) -> str:
    return prefix + fill * 64


def reserve_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reserved:
        reserved.bind(("127.0.0.1", 0))
        return int(reserved.getsockname()[1])


def request_json(
    base_url: str,
    method: str,
    path: str,
    *,
    payload: Any | None = None,
    host_capability: str | None = None,
    timeout: float = 10.0,
) -> tuple[int, Any]:
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if host_capability is not None:
        headers[HOST_HEADER] = host_capability
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=body,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = int(response.status)
            raw = response.read()
    except urllib.error.HTTPError as error:
        status = int(error.code)
        raw = error.read()
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
        raise IntegrationFailure(f"{method} {path} transport failed: {error}") from error
    try:
        decoded = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise IntegrationFailure(
            f"{method} {path} returned non-JSON HTTP {status}"
        ) from error
    return status, decoded


def request_bytes(
    base_url: str,
    method: str,
    path: str,
    *,
    payload: Any | None = None,
    host_capability: str | None = None,
    extra_headers: dict[str, str] | None = None,
    timeout: float = 10.0,
) -> tuple[int, dict[str, str], bytes]:
    body = None
    headers = {"Accept": "application/x-ndjson, application/json"}
    if payload is not None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if host_capability is not None:
        headers[HOST_HEADER] = host_capability
    if extra_headers is not None:
        headers.update(extra_headers)
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=body,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = int(response.status)
            response_headers = {
                key.lower(): value for key, value in response.headers.items()
            }
            raw = response.read()
    except urllib.error.HTTPError as error:
        status = int(error.code)
        response_headers = {
            key.lower(): value for key, value in error.headers.items()
        }
        raw = error.read()
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
        raise IntegrationFailure(f"{method} {path} transport failed: {error}") from error
    return status, response_headers, raw


@dataclass
class HeldProviderTraceExport:
    connection: http.client.HTTPConnection
    response: http.client.HTTPResponse

    def close(self) -> None:
        try:
            self.response.close()
        finally:
            self.connection.close()


def open_unconsumed_provider_trace_export(
    daemon: OwnedDaemon,
    path: str,
    payload: dict[str, Any],
    capability: str,
    expected_trace_digest: str,
) -> HeldProviderTraceExport:
    parsed = urllib.parse.urlsplit(daemon.base_url)
    require(
        parsed.scheme == "http"
        and parsed.hostname == "127.0.0.1"
        and isinstance(parsed.port, int),
        "Provider trace export requires the owned loopback daemon",
    )
    encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    connection = http.client.HTTPConnection(
        parsed.hostname,
        parsed.port,
        timeout=10.0,
    )
    receive_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    receive_socket.settimeout(10.0)
    receive_socket.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
    receive_socket.connect((parsed.hostname, parsed.port))
    connection.sock = receive_socket
    try:
        connection.request(
            "POST",
            f"{path}/export",
            body=encoded,
            headers={
                "Accept": "application/x-ndjson",
                "Content-Type": "application/json",
                "Content-Length": str(len(encoded)),
                "Connection": "close",
                HOST_HEADER: daemon.host_capability,
                PROVIDER_TRACE_CAPABILITY_HEADER: capability,
            },
        )
        response = connection.getresponse()
        require(
            response.status == 200
            and response.getheader(PROVIDER_TRACE_DIGEST_HEADER)
            == expected_trace_digest,
            f"Unconsumed Provider trace export returned HTTP {response.status}",
        )
        return HeldProviderTraceExport(connection, response)
    except BaseException:
        connection.close()
        raise


def require_api_ok(status: int, body: Any, context: str) -> Any:
    require(status == 200, f"{context} returned HTTP {status}")
    if not isinstance(body, dict) or body.get("ok") is not True:
        code = body.get("error") if isinstance(body, dict) else "invalid_response"
        message = body.get("message") if isinstance(body, dict) else ""
        raise IntegrationFailure(f"{context} failed: {code}: {message}")
    require("data" in body, f"{context} omitted data")
    return body["data"]


class ProviderHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "DeepCodeHostV2IntegrationProvider"

    def do_POST(self) -> None:  # noqa: N802 - stdlib callback name
        server = self.server
        require(
            isinstance(server, ProviderServer),
            "provider server type is invalid",
        )
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        try:
            request = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_error(400)
            return
        if (
            self.path != "/v1/chat/completions"
            or self.headers.get("Authorization") != f"Bearer {TEST_API_KEY}"
            or not isinstance(request, dict)
            or request.get("model") != "host-v2-integration-model"
            or request.get("stream") is not True
        ):
            self.send_error(400)
            return
        with server.request_lock:
            server.requests.append(request)
        current_input = provider_current_input_text(request)
        if current_input == CLI_TOOL_PROMPT:
            if provider_current_input_target_kind(request) == "finalAnswer":
                require(
                    not request.get("tools"),
                    "fixed finalAnswer request exposed Provider tools",
                )
                chunks = provider_final_chunks(
                    CLI_TOOL_FINAL_TEXT,
                    reasoning=FIXED_TOOL_REASONING,
                )
            elif provider_request_has_tool_result(request, FIXED_TOOL_CALL_ID):
                chunks = provider_final_chunks(
                    "README.md evidence is sufficient; no additional tool is needed.",
                    reasoning=FIXED_TOOL_REASONING,
                )
            else:
                require(
                    provider_request_exposes_tool(
                        request,
                        FIXED_PROVIDER_TOOL_NAME,
                    ),
                    "fixed dispatch request omitted the current fs.read definition",
                )
                chunks = provider_tool_call_chunks(
                    reasoning=FIXED_TOOL_REASONING,
                )
        elif current_input == CLI_DELETE_PLAN_PROMPT:
            target_kind = provider_current_input_target_kind(request)
            guidance = provider_current_input_guidance(request)
            if target_kind == "finalAnswer":
                require(
                    not request.get("tools"),
                    "delete Plan finalAnswer request exposed Provider tools",
                )
                chunks = provider_final_chunks(
                    CLI_DELETE_FINAL_TEXT,
                    reasoning=DELETE_PLAN_REASONING,
                )
            elif guidance:
                require(
                    target_kind == "planning",
                    "delete Plan rejection did not re-enter a planning turn",
                )
                chunks = provider_final_chunks(
                    CLI_DELETE_REPLAN_TEXT,
                    reasoning=DELETE_PLAN_REASONING,
                )
            else:
                require(
                    target_kind == "planning"
                    and provider_request_exposes_tool(
                        request,
                        SESSION_PLAN_PROPOSAL_TOOL_NAME,
                    )
                    and not provider_request_exposes_tool(
                        request,
                        DELETE_PROVIDER_TOOL_NAME,
                    ),
                    "delete Plan request did not expose only the Session Plan control boundary",
                )
                chunks = provider_plan_proposal_chunks()
        else:
            chunks = provider_final_chunks(FINAL_TEXT)
        frames = [
            b"data: "
            + json.dumps(chunk, separators=(",", ":")).encode("utf-8")
            + b"\n\n"
            for chunk in chunks
        ]
        frames.append(b"data: [DONE]\n\n")
        encoded = b"".join(frames)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        for frame in frames:
            self.wfile.write(frame)
            self.wfile.flush()

    def log_message(self, _format: str, *_args: Any) -> None:
        return


def provider_final_chunks(
    text: str,
    *,
    reasoning: str = PROVIDER_REASONING,
) -> list[dict[str, Any]]:
    return [
        provider_reasoning_chunk(
            "chatcmpl-host-v2-integration",
            reasoning=reasoning,
        ),
        {
            "id": "chatcmpl-host-v2-integration",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "host-v2-integration-model",
            "choices": [
                {
                    "index": 0,
                    "delta": {"content": text},
                    "finish_reason": None,
                }
            ],
        },
        {
            "id": "chatcmpl-host-v2-integration",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "host-v2-integration-model",
            "choices": [
                {
                    "index": 0,
                    "delta": {},
                    "finish_reason": "stop",
                }
            ],
        },
        provider_usage_chunk(),
    ]


def provider_tool_call_chunks(
    *,
    reasoning: str = PROVIDER_REASONING,
) -> list[dict[str, Any]]:
    request_id = "chatcmpl-host-v2-integration-tool"
    return [
        provider_reasoning_chunk(request_id, reasoning=reasoning),
        {
            "id": request_id,
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "host-v2-integration-model",
            "choices": [
                {
                    "index": 0,
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": FIXED_TOOL_CALL_ID,
                                "type": "function",
                                "function": {
                                    "name": FIXED_PROVIDER_TOOL_NAME,
                                    "arguments": json.dumps(
                                        FIXED_TOOL_ARGUMENTS,
                                        separators=(",", ":"),
                                    ),
                                },
                            }
                        ]
                    },
                    "finish_reason": None,
                }
            ],
        },
        {
            "id": request_id,
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "host-v2-integration-model",
            "choices": [
                {
                    "index": 0,
                    "delta": {},
                    "finish_reason": "tool_calls",
                }
            ],
        },
        provider_usage_chunk(request_id),
    ]


def provider_plan_proposal_chunks() -> list[dict[str, Any]]:
    request_id = "chatcmpl-host-v2-integration-delete-plan"
    return [
        provider_reasoning_chunk(
            request_id,
            reasoning=DELETE_PLAN_REASONING,
        ),
        {
            "id": request_id,
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "host-v2-integration-model",
            "choices": [
                {
                    "index": 0,
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": DELETE_PLAN_CALL_ID,
                                "type": "function",
                                "function": {
                                    "name": SESSION_PLAN_PROPOSAL_TOOL_NAME,
                                    "arguments": json.dumps(
                                        DELETE_PLAN_ARGUMENTS,
                                        separators=(",", ":"),
                                    ),
                                },
                            }
                        ]
                    },
                    "finish_reason": None,
                }
            ],
        },
        {
            "id": request_id,
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "host-v2-integration-model",
            "choices": [
                {
                    "index": 0,
                    "delta": {},
                    "finish_reason": "tool_calls",
                }
            ],
        },
        provider_usage_chunk(request_id),
    ]


def provider_reasoning_chunk(
    request_id: str,
    *,
    reasoning: str = PROVIDER_REASONING,
) -> dict[str, Any]:
    return {
        "id": request_id,
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "host-v2-integration-model",
        "choices": [
            {
                "index": 0,
                "delta": {
                    "role": "assistant",
                    "reasoning_content": reasoning,
                },
                "finish_reason": None,
            }
        ],
    }


def provider_usage_chunk(
    request_id: str = "chatcmpl-host-v2-integration",
) -> dict[str, Any]:
    return {
        "id": request_id,
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "host-v2-integration-model",
        "choices": [],
        "usage": {
            "prompt_tokens": 8,
            "completion_tokens": 9,
            "total_tokens": 17,
        },
    }


def provider_current_input_payloads(
    request: dict[str, Any],
) -> list[dict[str, Any]]:
    messages = request.get("messages")
    if not isinstance(messages, list):
        return []
    current_inputs: list[dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if not isinstance(content, str):
            continue
        try:
            payload = json.loads(content)
        except json.JSONDecodeError:
            continue
        if (
            isinstance(payload, dict)
            and payload.get("schemaVersion")
            == "deepcode.session.provider-current-input.v2"
        ):
            current_inputs.append(payload)
    return current_inputs


def provider_current_input_text(request: dict[str, Any]) -> str | None:
    current_inputs = provider_current_input_payloads(request)
    if len(current_inputs) != 1:
        return None
    current_input = current_inputs[0].get("currentInput")
    text = current_input.get("text") if isinstance(current_input, dict) else None
    return text if isinstance(text, str) else None


def provider_current_input_target_kind(
    request: dict[str, Any],
) -> str | None:
    current_inputs = provider_current_input_payloads(request)
    if len(current_inputs) != 1:
        return None
    target = current_inputs[0].get("target")
    kind = target.get("kind") if isinstance(target, dict) else None
    return kind if isinstance(kind, str) else None


def provider_current_input_guidance(
    request: dict[str, Any],
) -> list[str]:
    current_inputs = provider_current_input_payloads(request)
    if len(current_inputs) != 1:
        return []
    guidance = current_inputs[0].get("guidance")
    if not isinstance(guidance, list):
        return []
    return [
        value
        for value in guidance
        if isinstance(value, str) and value.strip()
    ]


def provider_canonical_fact_payloads(
    request: dict[str, Any],
) -> list[dict[str, Any]]:
    messages = request.get("messages")
    if not isinstance(messages, list):
        return []
    payloads: list[dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if not isinstance(content, str):
            continue
        try:
            payload = json.loads(content)
        except json.JSONDecodeError:
            continue
        if (
            isinstance(payload, dict)
            and payload.get("schemaVersion")
            == "deepcode.session.provider-canonical-facts.v2"
        ):
            payloads.append(payload)
    return payloads


def provider_request_has_tool_result(
    request: dict[str, Any],
    call_id: str,
) -> bool:
    messages = request.get("messages")
    return isinstance(messages, list) and any(
        isinstance(message, dict)
        and message.get("role") == "tool"
        and message.get("tool_call_id") == call_id
        and isinstance(message.get("content"), str)
        and bool(message["content"].strip())
        for message in messages
    )


def provider_request_exposes_tool(
    request: dict[str, Any],
    wire_name: str,
) -> bool:
    tools = request.get("tools")
    return isinstance(tools, list) and any(
        isinstance(tool, dict)
        and tool.get("type") == "function"
        and isinstance(tool.get("function"), dict)
        and tool["function"].get("name") == wire_name
        for tool in tools
    )


class ProviderServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), ProviderHandler)
        self.requests: list[dict[str, Any]] = []
        self.errors: list[str] = []
        self.request_lock = threading.Lock()

    @property
    def port(self) -> int:
        return int(self.server_address[1])

    def request_count(self) -> int:
        with self.request_lock:
            return len(self.requests)

    def request_snapshot(self) -> list[dict[str, Any]]:
        with self.request_lock:
            return json.loads(json.dumps(self.requests))

    def handle_error(
        self,
        _request: Any,
        _client_address: tuple[str, int],
    ) -> None:
        error = sys.exc_info()[1]
        with self.request_lock:
            self.errors.append(safe_diagnostic(error or "unknown provider error"))

    def require_healthy(self) -> None:
        with self.request_lock:
            errors = list(self.errors)
        require(not errors, f"Provider server failed: {'; '.join(errors)}")

    def serve_guarded(self) -> None:
        try:
            self.serve_forever()
        except BaseException as error:
            with self.request_lock:
                self.errors.append(safe_diagnostic(error))


def assert_provider_received_current_input(
    request: dict[str, Any],
    expected_text: str,
) -> None:
    current_inputs = provider_current_input_payloads(request)
    require(
        len(current_inputs) == 1,
        "Provider request did not contain one exact current-input envelope",
    )
    current_input = current_inputs[0].get("currentInput")
    require(
        isinstance(current_input, dict)
        and current_input.get("text") == expected_text,
        "Provider request changed or omitted the CLI instruction",
    )


def assert_fixed_tool_provider_sequence(
    initial: dict[str, Any],
    continuation: dict[str, Any],
    final_answer: dict[str, Any],
) -> None:
    assert_provider_received_current_input(initial, CLI_TOOL_PROMPT)
    assert_provider_received_current_input(continuation, CLI_TOOL_PROMPT)
    assert_provider_received_current_input(final_answer, CLI_TOOL_PROMPT)
    require(
        provider_current_input_target_kind(initial) == "planning"
        and provider_current_input_target_kind(continuation) == "planning"
        and provider_current_input_target_kind(final_answer) == "finalAnswer",
        "fixed dispatch did not preserve planning continuation before bound finalAnswer",
    )
    require(
        provider_request_exposes_tool(initial, FIXED_PROVIDER_TOOL_NAME)
        and provider_request_exposes_tool(
            continuation,
            FIXED_PROVIDER_TOOL_NAME,
        ),
        "fixed planning requests did not expose the current fs.read definition",
    )
    require(
        not provider_request_has_tool_result(initial, FIXED_TOOL_CALL_ID),
        "initial fixed dispatch request already contained a tool result",
    )
    require(
        provider_request_has_tool_result(continuation, FIXED_TOOL_CALL_ID),
        "fixed planning continuation omitted the native tool result",
    )
    require(
        not final_answer.get("tools")
        and not provider_request_has_tool_result(
            final_answer,
            FIXED_TOOL_CALL_ID,
        ),
        "bound finalAnswer request exposed tools or raw native tool history",
    )
    for label, request in (
        ("planning continuation", continuation),
        ("bound finalAnswer", final_answer),
    ):
        fact_payloads = provider_canonical_fact_payloads(request)
        require(
            len(fact_payloads) == 1,
            f"{label} omitted the canonical Kernel fact envelope",
        )
        facts = fact_payloads[0].get("facts")
        require(
            isinstance(facts, list),
            f"{label} canonical Kernel fact envelope omitted facts",
        )
        completed = [
            fact
            for fact in facts
            if isinstance(fact, dict)
            and fact.get("factKind") == "toolCompleted"
        ]
        require(
            len(completed) == 1,
            f"{label} did not receive one canonical toolCompleted fact; "
            f"safeSummary={json.dumps(fixed_tool_provider_request_summary(request), separators=(',', ':'))}",
        )


def fixed_tool_provider_request_summary(request: dict[str, Any]) -> dict[str, Any]:
    fact_payloads = provider_canonical_fact_payloads(request)
    fact_kinds = [
        fact.get("factKind")
        for payload in fact_payloads
        for fact in (
            payload.get("facts")
            if isinstance(payload.get("facts"), list)
            else []
        )
        if isinstance(fact, dict) and isinstance(fact.get("factKind"), str)
    ]
    messages = request.get("messages")
    return {
        "targetKind": provider_current_input_target_kind(request),
        "toolCount": len(request.get("tools", []))
        if isinstance(request.get("tools"), list)
        else None,
        "messageRoles": [
            message.get("role")
            for message in messages
            if isinstance(message, dict)
        ]
        if isinstance(messages, list)
        else None,
        "hasNativeToolResult": provider_request_has_tool_result(
            request,
            FIXED_TOOL_CALL_ID,
        ),
        "canonicalFactKinds": fact_kinds,
    }


@dataclass(frozen=True)
class ProcessIdentity:
    pid: int
    process_group: int
    session_id: int
    start_identity: str
    effective_uid: int
    pid_namespace: str
    executable: str
    state: str


@dataclass(frozen=True)
class OwnerRecord:
    owner_id: str
    leader_pid: int
    process_group: int
    process_session_id: int
    start_identity: str
    effective_uid: int
    pid_namespace: str
    allowed_executables: tuple[str, ...]
    run_root: str
    config_root: str
    daemon_instance_id: str
    listen_host: str
    port: int

    def material(self) -> dict[str, Any]:
        return {
            "schemaVersion": OWNER_RECORD_SCHEMA,
            "leaderPid": self.leader_pid,
            "processGroupId": self.process_group,
            "processSessionId": self.process_session_id,
            "startIdentity": self.start_identity,
            "effectiveUid": self.effective_uid,
            "pidNamespace": self.pid_namespace,
            "allowedExecutables": list(self.allowed_executables),
            "runRoot": self.run_root,
            "configRoot": self.config_root,
            "daemonInstanceId": self.daemon_instance_id,
            "listenHost": self.listen_host,
            "port": self.port,
        }

    def to_json(self) -> dict[str, Any]:
        return {**self.material(), "ownerId": self.owner_id}

    @classmethod
    def create(
        cls,
        identity: ProcessIdentity,
        *,
        allowed_executables: tuple[str, ...],
        run_root: pathlib.Path,
        config_root: pathlib.Path,
        daemon_instance_id: str,
        port: int,
    ) -> "OwnerRecord":
        provisional = cls(
            owner_id="",
            leader_pid=identity.pid,
            process_group=identity.process_group,
            process_session_id=identity.session_id,
            start_identity=identity.start_identity,
            effective_uid=identity.effective_uid,
            pid_namespace=identity.pid_namespace,
            allowed_executables=allowed_executables,
            run_root=str(run_root),
            config_root=str(config_root),
            daemon_instance_id=daemon_instance_id,
            listen_host="127.0.0.1",
            port=port,
        )
        owner_id = "sha256:" + hashlib.sha256(
            json.dumps(
                provisional.material(),
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=True,
            ).encode("utf-8")
        ).hexdigest()
        return cls(**{**provisional.__dict__, "owner_id": owner_id})

    @classmethod
    def decode(cls, value: Any) -> "OwnerRecord":
        require(isinstance(value, dict), "owner registry record must be an object")
        allowed_keys = {
            "schemaVersion",
            "ownerId",
            "leaderPid",
            "processGroupId",
            "processSessionId",
            "startIdentity",
            "effectiveUid",
            "pidNamespace",
            "allowedExecutables",
            "runRoot",
            "configRoot",
            "daemonInstanceId",
            "listenHost",
            "port",
        }
        require(set(value) == allowed_keys, "owner registry record fields are invalid")
        require(value.get("schemaVersion") == OWNER_RECORD_SCHEMA, "owner registry schema is unsupported")
        executables = value.get("allowedExecutables")
        require(
            isinstance(executables, list)
            and executables
            and all(isinstance(item, str) and item for item in executables),
            "owner executable identity is invalid",
        )
        record = cls(
            owner_id=str(value.get("ownerId", "")),
            leader_pid=value.get("leaderPid"),
            process_group=value.get("processGroupId"),
            process_session_id=value.get("processSessionId"),
            start_identity=str(value.get("startIdentity", "")),
            effective_uid=value.get("effectiveUid"),
            pid_namespace=str(value.get("pidNamespace", "")),
            allowed_executables=tuple(executables),
            run_root=str(value.get("runRoot", "")),
            config_root=str(value.get("configRoot", "")),
            daemon_instance_id=str(value.get("daemonInstanceId", "")),
            listen_host=str(value.get("listenHost", "")),
            port=value.get("port"),
        )
        require(
            isinstance(record.leader_pid, int)
            and record.leader_pid > 1
            and record.process_group == record.leader_pid
            and record.process_session_id == record.leader_pid,
            "owner leader/process-group identity is invalid",
        )
        require(
            isinstance(record.effective_uid, int)
            and record.effective_uid >= 0
            and record.start_identity
            and record.pid_namespace,
            "owner process identity is incomplete",
        )
        require(
            record.listen_host == "127.0.0.1"
            and isinstance(record.port, int)
            and 0 < record.port < 65_536,
            "owner listener identity is invalid",
        )
        run_root = pathlib.Path(record.run_root)
        config_root = pathlib.Path(record.config_root)
        require(
            run_root.is_absolute()
            and config_root.is_absolute()
            and config_root.is_relative_to(run_root),
            "owner root identity is invalid",
        )
        expected = OwnerRecord.create(
            ProcessIdentity(
                pid=record.leader_pid,
                process_group=record.process_group,
                session_id=record.process_session_id,
                start_identity=record.start_identity,
                effective_uid=record.effective_uid,
                pid_namespace=record.pid_namespace,
                executable=record.allowed_executables[0],
                state="?",
            ),
            allowed_executables=record.allowed_executables,
            run_root=run_root,
            config_root=config_root,
            daemon_instance_id=record.daemon_instance_id,
            port=record.port,
        )
        require(record.owner_id == expected.owner_id, "owner registry digest is invalid")
        return record


@dataclass(frozen=True)
class OwnerObservation:
    state: str
    detail: str
    member_pids: tuple[int, ...] = ()


@functools.lru_cache(maxsize=1)
def _host_boot_identity() -> str:
    boot_id_path = pathlib.Path("/proc/sys/kernel/random/boot_id")
    if boot_id_path.is_file():
        return "linux:" + boot_id_path.read_text(encoding="ascii").strip()
    try:
        completed = subprocess.run(
            ["sysctl", "-n", "kern.boottime"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2.0,
            check=True,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise IntegrationFailure(f"host boot identity is unavailable: {safe_diagnostic(error)}") from error
    return "host:" + completed.stdout.strip()


def _linux_process_stat(pid: int) -> tuple[str, int, int, str]:
    try:
        raw = pathlib.Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    except FileNotFoundError as error:
        raise ProcessLookupError(pid) from error
    except PermissionError:
        raise
    except OSError as error:
        raise IntegrationFailure(f"process stat is unavailable for pid {pid}: {safe_diagnostic(error)}") from error
    close = raw.rfind(")")
    require(close > 0, f"process stat is invalid for pid {pid}")
    fields = raw[close + 2 :].split()
    require(len(fields) > 19, f"process stat is truncated for pid {pid}")
    return fields[0], int(fields[2]), int(fields[3]), fields[19]


class _DarwinProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ("pbi_flags", ctypes.c_uint32),
        ("pbi_status", ctypes.c_uint32),
        ("pbi_xstatus", ctypes.c_uint32),
        ("pbi_pid", ctypes.c_uint32),
        ("pbi_ppid", ctypes.c_uint32),
        ("pbi_uid", ctypes.c_uint32),
        ("pbi_gid", ctypes.c_uint32),
        ("pbi_ruid", ctypes.c_uint32),
        ("pbi_rgid", ctypes.c_uint32),
        ("pbi_svuid", ctypes.c_uint32),
        ("pbi_svgid", ctypes.c_uint32),
        ("rfu_1", ctypes.c_uint32),
        ("pbi_comm", ctypes.c_char * 16),
        ("pbi_name", ctypes.c_char * 32),
        ("pbi_nfiles", ctypes.c_uint32),
        ("pbi_pgid", ctypes.c_uint32),
        ("pbi_pjobc", ctypes.c_uint32),
        ("e_tdev", ctypes.c_uint32),
        ("e_tpgid", ctypes.c_uint32),
        ("pbi_nice", ctypes.c_int32),
        ("pbi_start_tvsec", ctypes.c_uint64),
        ("pbi_start_tvusec", ctypes.c_uint64),
    ]


@functools.lru_cache(maxsize=1)
def _darwin_libraries() -> tuple[Any, Any]:
    require(os.uname().sysname == "Darwin", "Darwin process APIs are unavailable")
    try:
        libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    except OSError as error:
        raise IntegrationFailure(
            f"Darwin process libraries are unavailable: {safe_diagnostic(error)}"
        ) from error
    libproc.proc_pidinfo.argtypes = [
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_uint64,
        ctypes.c_void_p,
        ctypes.c_int,
    ]
    libproc.proc_pidinfo.restype = ctypes.c_int
    libproc.proc_pidpath.argtypes = [
        ctypes.c_int,
        ctypes.c_void_p,
        ctypes.c_uint32,
    ]
    libproc.proc_pidpath.restype = ctypes.c_int
    libc.sysctl.argtypes = [
        ctypes.POINTER(ctypes.c_int),
        ctypes.c_uint,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_size_t),
        ctypes.c_void_p,
        ctypes.c_size_t,
    ]
    libc.sysctl.restype = ctypes.c_int
    return libproc, libc


def _raise_process_api_error(pid: int, context: str) -> None:
    error_number = ctypes.get_errno()
    if error_number in (errno.ESRCH, errno.ENOENT):
        raise ProcessLookupError(pid)
    if error_number in (errno.EPERM, errno.EACCES):
        raise PermissionError(error_number, os.strerror(error_number), pid)
    raise IntegrationFailure(
        f"{context} failed for pid {pid}: "
        f"{safe_diagnostic(os.strerror(error_number) if error_number else 'unknown error')}"
    )


def _darwin_process_info(pid: int) -> _DarwinProcBsdInfo:
    libproc, _ = _darwin_libraries()
    info = _DarwinProcBsdInfo()
    ctypes.set_errno(0)
    read = libproc.proc_pidinfo(
        pid,
        3,  # PROC_PIDTBSDINFO
        0,
        ctypes.byref(info),
        ctypes.sizeof(info),
    )
    if read == 0:
        _raise_process_api_error(pid, "proc_pidinfo")
    require(read == ctypes.sizeof(info), f"proc_pidinfo was truncated for pid {pid}")
    require(info.pbi_pid == pid, f"proc_pidinfo changed identity for pid {pid}")
    return info


def _darwin_process_path(pid: int, *, zombie: bool) -> str:
    libproc, _ = _darwin_libraries()
    buffer = ctypes.create_string_buffer(4096)
    ctypes.set_errno(0)
    read = libproc.proc_pidpath(pid, buffer, len(buffer))
    if read <= 0:
        if zombie and ctypes.get_errno() in (0, errno.ESRCH, errno.ENOENT):
            return ""
        _raise_process_api_error(pid, "proc_pidpath")
    try:
        path = os.fsdecode(buffer.raw[:read].split(b"\0", 1)[0])
        return str(pathlib.Path(path).resolve(strict=True))
    except (OSError, UnicodeError) as error:
        raise IntegrationFailure(
            f"Darwin executable identity is invalid for pid {pid}: {safe_diagnostic(error)}"
        ) from error


def _darwin_process_arguments(pid: int) -> bytes:
    _, libc = _darwin_libraries()
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2, pid
    size = ctypes.c_size_t(0)
    ctypes.set_errno(0)
    if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0:
        _raise_process_api_error(pid, "KERN_PROCARGS2 size query")
    require(0 < size.value <= 16 * 1024 * 1024, "Darwin process arguments are unbounded")
    buffer = ctypes.create_string_buffer(size.value)
    ctypes.set_errno(0)
    if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
        _raise_process_api_error(pid, "KERN_PROCARGS2 read")
    return bytes(buffer.raw[: size.value])


def _ps_field(pid: int, field: str) -> str:
    try:
        completed = subprocess.run(
            ["ps", "-o", f"{field}=", "-p", str(pid)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2.0,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise IntegrationFailure(f"process identity query failed for pid {pid}: {safe_diagnostic(error)}") from error
    if completed.returncode != 0 or not completed.stdout.strip():
        raise ProcessLookupError(pid)
    return completed.stdout.strip()


def capture_process_identity(pid: int) -> ProcessIdentity:
    proc_dir = pathlib.Path(f"/proc/{pid}")
    if proc_dir.is_dir():
        state, process_group, session_id, start_ticks = _linux_process_stat(pid)
        try:
            executable = str((proc_dir / "exe").resolve(strict=True))
            pid_namespace = os.readlink(proc_dir / "ns/pid")
            status_lines = (proc_dir / "status").read_text(encoding="ascii").splitlines()
            uid_line = next(
                (line for line in status_lines if line.startswith("Uid:")),
                "",
            )
            uid_fields = uid_line.split()
            require(len(uid_fields) >= 3, f"process effective UID is invalid for pid {pid}")
            effective_uid = int(uid_fields[2])
        except FileNotFoundError as error:
            if state == "Z":
                executable = ""
                pid_namespace = os.readlink(proc_dir / "ns/pid")
                effective_uid = proc_dir.stat().st_uid
            else:
                raise ProcessLookupError(pid) from error
        except PermissionError:
            raise
        verified_state, verified_group, verified_session, verified_start = (
            _linux_process_stat(pid)
        )
        require(
            (verified_group, verified_session, verified_start)
            == (process_group, session_id, start_ticks),
            f"process identity changed during observation for pid {pid}",
        )
        return ProcessIdentity(
            pid=pid,
            process_group=process_group,
            session_id=session_id,
            start_identity=f"{_host_boot_identity()}:{start_ticks}",
            effective_uid=effective_uid,
            pid_namespace=pid_namespace,
            executable=executable,
            state=verified_state,
        )

    require(os.uname().sysname == "Darwin", "unsupported process identity platform")
    info = _darwin_process_info(pid)
    zombie = info.pbi_status == 5  # SZOMB
    try:
        session_id = os.getsid(pid)
    except ProcessLookupError:
        raise
    except PermissionError:
        raise
    verified = _darwin_process_info(pid)
    require(
        (
            int(verified.pbi_pgid),
            int(verified.pbi_uid),
            int(verified.pbi_start_tvsec),
            int(verified.pbi_start_tvusec),
        )
        == (
            int(info.pbi_pgid),
            int(info.pbi_uid),
            int(info.pbi_start_tvsec),
            int(info.pbi_start_tvusec),
        ),
        f"Darwin process identity changed during observation for pid {pid}",
    )
    return ProcessIdentity(
        pid=pid,
        process_group=int(info.pbi_pgid),
        session_id=session_id,
        start_identity=(
            f"{_host_boot_identity()}:{int(info.pbi_start_tvsec)}:"
            f"{int(info.pbi_start_tvusec)}"
        ),
        effective_uid=int(info.pbi_uid),
        pid_namespace=f"host:{os.uname().sysname}:{_host_boot_identity()}",
        executable=_darwin_process_path(pid, zombie=zombie),
        state="Z" if zombie else str(int(info.pbi_status)),
    )


def process_group_member_pids(process_group: int) -> tuple[int, ...]:
    proc_root = pathlib.Path("/proc")
    members: list[int] = []
    if proc_root.is_dir():
        for entry in proc_root.iterdir():
            if not entry.name.isdigit():
                continue
            pid = int(entry.name)
            try:
                if os.getpgid(pid) == process_group:
                    members.append(pid)
            except ProcessLookupError:
                continue
            except PermissionError as error:
                raise IntegrationFailure(
                    f"process-group membership is not readable for pid {pid}: "
                    f"{safe_diagnostic(error)}"
                ) from error
        return tuple(sorted(members))
    try:
        completed = subprocess.run(
            ["ps", "-axo", "pid=,pgid="],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2.0,
            check=True,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise IntegrationFailure(f"process-group enumeration failed: {safe_diagnostic(error)}") from error
    for line in completed.stdout.splitlines():
        fields = line.split()
        if len(fields) == 2 and fields[0].isdigit() and fields[1].isdigit():
            if int(fields[1]) == process_group:
                members.append(int(fields[0]))
    return tuple(sorted(members))


def _current_pid_namespace() -> str:
    namespace = pathlib.Path("/proc/self/ns/pid")
    if namespace.exists():
        try:
            return os.readlink(namespace)
        except PermissionError as error:
            raise IntegrationFailure(
                f"cleanup PID namespace is not readable: {safe_diagnostic(error)}"
            ) from error
    return f"host:{os.uname().sysname}:{_host_boot_identity()}"


def _all_process_pids() -> tuple[int, ...]:
    proc_root = pathlib.Path("/proc")
    if proc_root.is_dir():
        return tuple(
            sorted(int(entry.name) for entry in proc_root.iterdir() if entry.name.isdigit())
        )
    try:
        completed = subprocess.run(
            ["ps", "-axo", "pid="],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2.0,
            check=True,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise IntegrationFailure(
            f"process enumeration failed: {safe_diagnostic(error)}"
        ) from error
    return tuple(
        sorted(
            int(line.strip())
            for line in completed.stdout.splitlines()
            if line.strip().isdigit()
        )
    )


def _process_arguments_and_environment(pid: int) -> bytes:
    proc_dir = pathlib.Path(f"/proc/{pid}")
    if proc_dir.is_dir():
        try:
            return (proc_dir / "cmdline").read_bytes() + (proc_dir / "environ").read_bytes()
        except FileNotFoundError as error:
            raise ProcessLookupError(pid) from error
        except PermissionError:
            raise
        except OSError as error:
            if error.errno in (errno.ESRCH, errno.ENOENT):
                raise ProcessLookupError(pid) from error
            raise IntegrationFailure(
                f"process arguments are unavailable for pid {pid}: {safe_diagnostic(error)}"
            ) from error
    return _darwin_process_arguments(pid)


def process_owner_binding(pid: int, record: OwnerRecord) -> bool | None:
    try:
        material = _process_arguments_and_environment(pid).split(b"\0")
    except ProcessLookupError:
        return False
    except PermissionError:
        return None
    expected = {
        f"DEEPCODE_CONFIG_DIR={record.config_root}".encode("utf-8"),
        f"DEEPCODE_HOST_INSTANCE_ID_V2={record.daemon_instance_id}".encode("utf-8"),
    }
    return expected.issubset(set(material))


def _normalized_absolute_path_reference(value: str) -> pathlib.Path | None:
    deleted_suffix = " (deleted)"
    if value.endswith(deleted_suffix):
        value = value[: -len(deleted_suffix)]
    if not value or not os.path.isabs(value):
        return None
    return pathlib.Path(os.path.normpath(value))


def _path_reference_is_within_owner_roots(
    value: str,
    roots: tuple[pathlib.Path, ...],
) -> bool:
    candidates = [value]
    if "=" in value:
        candidates.append(value.split("=", 1)[1])
    for candidate in candidates:
        path = _normalized_absolute_path_reference(candidate)
        if path is None:
            continue
        if any(path == root or path.is_relative_to(root) for root in roots):
            return True
    return False


def process_references_owner_roots(pid: int, record: OwnerRecord) -> bool | None:
    proc_dir = pathlib.Path(f"/proc/{pid}")
    roots = (pathlib.Path(record.run_root), pathlib.Path(record.config_root))
    try:
        tokens = [
            token.decode("utf-8", errors="ignore")
            for token in _process_arguments_and_environment(pid).split(b"\0")
            if token
        ]
        links: list[str] = []
        if proc_dir.is_dir():
            for link in (proc_dir / "cwd",):
                try:
                    links.append(os.readlink(link))
                except FileNotFoundError:
                    pass
                except PermissionError:
                    return None
            fd_dir = proc_dir / "fd"
            if fd_dir.is_dir():
                for entry in fd_dir.iterdir():
                    try:
                        links.append(os.readlink(entry))
                    except FileNotFoundError:
                        continue
                    except PermissionError:
                        return None
                    except OSError:
                        continue
    except ProcessLookupError:
        return False
    except PermissionError:
        return None
    return any(
        _path_reference_is_within_owner_roots(value, roots)
        for value in (*tokens, *links)
    )


def leader_binding_matches(record: OwnerRecord) -> bool | None:
    environment_binding = process_owner_binding(record.leader_pid, record)
    if environment_binding is not True:
        return environment_binding
    try:
        status, body = request_json(
            f"http://{record.listen_host}:{record.port}",
            "GET",
            "/api/host/identity",
            timeout=0.3,
        )
    except IntegrationFailure:
        return True
    identity = body.get("data") if status == 200 and isinstance(body, dict) else None
    http_binding = (
        isinstance(identity, dict)
        and identity.get("instanceId") == record.daemon_instance_id
        and identity.get("pid") == record.leader_pid
    )
    return http_binding


def _identity_matches_record(identity: ProcessIdentity, record: OwnerRecord) -> bool:
    executable_matches = identity.executable in record.allowed_executables
    if identity.state.startswith("Z") and not identity.executable:
        executable_matches = True
    return (
        identity.pid == record.leader_pid
        and identity.process_group == record.process_group
        and identity.session_id == record.process_session_id
        and identity.start_identity == record.start_identity
        and identity.effective_uid == record.effective_uid
        and identity.pid_namespace == record.pid_namespace
        and executable_matches
    )


def _member_is_owned(
    pid: int,
    identity: ProcessIdentity,
    record: OwnerRecord,
) -> bool | None:
    if (
        identity.process_group != record.process_group
        or identity.session_id != record.process_session_id
        or identity.effective_uid != record.effective_uid
        or identity.pid_namespace != record.pid_namespace
    ):
        return False
    binding = process_owner_binding(pid, record)
    if binding is True:
        return True
    roots = process_references_owner_roots(pid, record)
    if binding is None or roots is None:
        return None
    return roots


def _observe_owner_without_leader(
    record: OwnerRecord,
    initial_members: tuple[int, ...],
    reason: str,
) -> OwnerObservation:
    try:
        members = process_group_member_pids(record.process_group)
        exact_owned = owned_member_pids(record)
    except IntegrationFailure as error:
        return OwnerObservation("unverifiable", safe_diagnostic(error), initial_members)
    if exact_owned is None:
        return OwnerObservation(
            "unverifiable",
            f"{reason}; exact owner-bound members are not fully readable",
            members,
        )
    if record.leader_pid in members or record.leader_pid in exact_owned:
        return OwnerObservation(
            "unverifiable",
            f"{reason}; leader identity raced with group re-enumeration",
            members,
        )
    if not exact_owned:
        return OwnerObservation(
            "absent",
            f"{reason}; no exact root/instance-bound process remains",
            members,
        )
    if not members or not set(exact_owned).issubset(members):
        return OwnerObservation(
            "unverifiable",
            f"{reason}; exact owner-bound processes remain outside the numeric group",
            tuple(sorted(set((*members, *exact_owned)))),
        )

    observed_owned: list[int] = []
    unrelated: list[int] = []
    for pid in members:
        try:
            member = capture_process_identity(pid)
        except ProcessLookupError:
            return OwnerObservation(
                "unverifiable",
                f"{reason}; group membership changed during re-enumeration",
                members,
            )
        except PermissionError:
            return OwnerObservation(
                "permissionDenied",
                f"{reason}; orphan group member identity is not readable",
                members,
            )
        except IntegrationFailure as error:
            return OwnerObservation("unverifiable", safe_diagnostic(error), members)
        owned = _member_is_owned(pid, member, record)
        if owned is None:
            return OwnerObservation(
                "unverifiable",
                f"{reason}; orphan group ownership is unverifiable",
                members,
            )
        if owned:
            observed_owned.append(pid)
        else:
            unrelated.append(pid)
    if set(observed_owned) != set(exact_owned):
        return OwnerObservation(
            "unverifiable",
            f"{reason}; owner-bound member evidence changed during observation",
            members,
        )
    if unrelated:
        return OwnerObservation(
            "identityMismatch",
            "owned and unrelated processes share the numeric PGID",
            members,
        )
    return OwnerObservation(
        "exactOwnedSignalable",
        "leader exited but exact owned group members remain",
        members,
    )


def observe_owner(record: OwnerRecord) -> OwnerObservation:
    if os.geteuid() != record.effective_uid:
        return OwnerObservation(
            "permissionDenied",
            "cleanup EUID does not match the owner record",
        )
    try:
        if _current_pid_namespace() != record.pid_namespace:
            return OwnerObservation(
                "unverifiable",
                "cleanup PID namespace does not match the owner record",
            )
        members = process_group_member_pids(record.process_group)
    except IntegrationFailure as error:
        return OwnerObservation("unverifiable", safe_diagnostic(error))
    if not members:
        return OwnerObservation("absent", "process group has no members")

    if record.leader_pid in members:
        for _ in range(3):
            try:
                current = capture_process_identity(record.leader_pid)
                break
            except ProcessLookupError:
                current = None
                time.sleep(0)
            except PermissionError:
                return OwnerObservation(
                    "permissionDenied",
                    "leader identity is not readable",
                    members,
                )
            except IntegrationFailure as error:
                return OwnerObservation("unverifiable", safe_diagnostic(error), members)
        else:
            current = None
        if current is None:
            return _observe_owner_without_leader(
                record,
                members,
                "leader disappeared during exact identity observation",
            )
        if not _identity_matches_record(current, record):
            return OwnerObservation("identityMismatch", "leader identity changed", members)
        if not current.state.startswith("Z"):
            binding = leader_binding_matches(record)
            if binding is None:
                return OwnerObservation(
                    "unverifiable",
                    "leader root/instance binding is unverifiable",
                    members,
                )
            if not binding:
                return OwnerObservation(
                    "identityMismatch",
                    "leader root/instance binding changed",
                    members,
                )
        for pid in members:
            if pid == record.leader_pid:
                continue
            try:
                member = capture_process_identity(pid)
            except ProcessLookupError:
                continue
            except PermissionError:
                return OwnerObservation(
                    "permissionDenied",
                    "group member identity is not readable",
                    members,
                )
            except IntegrationFailure as error:
                return OwnerObservation("unverifiable", safe_diagnostic(error), members)
            if (
                member.process_group != record.process_group
                or member.session_id != record.process_session_id
                or member.effective_uid != record.effective_uid
                or member.pid_namespace != record.pid_namespace
            ):
                return OwnerObservation(
                    "identityMismatch",
                    "exact leader group contains an unrelated member",
                    members,
                )
        return OwnerObservation(
            "exactOwnedSignalable",
            "exact leader identity and group members are live",
            members,
        )

    return _observe_owner_without_leader(
        record,
        members,
        "registered leader is absent from the numeric process group",
    )


def _darwin_process_references_owner(pid: int, record: OwnerRecord) -> bool | None:
    try:
        info = _darwin_process_info(pid)
    except ProcessLookupError:
        return False
    except PermissionError:
        return None
    if int(info.pbi_uid) != record.effective_uid:
        return False
    try:
        session_id = os.getsid(pid)
    except ProcessLookupError:
        return False
    except PermissionError:
        return None

    binding = process_owner_binding(pid, record)
    roots = process_references_owner_roots(pid, record)
    try:
        verified = _darwin_process_info(pid)
        verified_session_id = os.getsid(pid)
    except ProcessLookupError:
        return False
    except PermissionError:
        return None
    if (
        int(verified.pbi_uid),
        int(verified.pbi_pgid),
        verified_session_id,
        int(verified.pbi_start_tvsec),
        int(verified.pbi_start_tvusec),
    ) != (
        int(info.pbi_uid),
        int(info.pbi_pgid),
        session_id,
        int(info.pbi_start_tvsec),
        int(info.pbi_start_tvusec),
    ):
        return None
    if binding is None or roots is None:
        return None
    return binding or roots


def owned_member_pids(record: OwnerRecord) -> tuple[int, ...] | None:
    owned: list[int] = []
    darwin = not pathlib.Path("/proc").is_dir() and os.uname().sysname == "Darwin"
    for pid in _all_process_pids():
        if darwin:
            referenced = _darwin_process_references_owner(pid, record)
            if referenced is None:
                return None
            if referenced:
                owned.append(pid)
            continue
        try:
            identity = capture_process_identity(pid)
        except ProcessLookupError:
            continue
        except PermissionError:
            return None
        except IntegrationFailure:
            if pid in (record.leader_pid, *process_group_member_pids(record.process_group)):
                return None
            continue
        if (
            identity.effective_uid != record.effective_uid
            or identity.pid_namespace != record.pid_namespace
        ):
            continue
        binding = process_owner_binding(pid, record)
        if binding is True:
            owned.append(pid)
        elif binding is None and (
            identity.process_group == record.process_group
            or identity.session_id == record.process_session_id
        ):
            return None
    return tuple(sorted(set(owned)))


@dataclass(frozen=True)
class OwnerRegistry:
    path: pathlib.Path

    def _read(self) -> list[OwnerRecord]:
        try:
            lines = self.path.read_text(encoding="utf-8").splitlines()
        except OSError as error:
            raise IntegrationFailure(
                f"owner identity registry is unavailable: {safe_diagnostic(error)}"
            ) from error
        records: list[OwnerRecord] = []
        for line in lines:
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise IntegrationFailure("owner identity registry contains invalid JSON") from error
            records.append(OwnerRecord.decode(value))
        identities = [record.owner_id for record in records]
        groups = [record.process_group for record in records]
        require(len(identities) == len(set(identities)), "owner registry contains duplicate identities")
        require(len(groups) == len(set(groups)), "owner registry contains duplicate process groups")
        return records

    def _replace(self, records: list[OwnerRecord]) -> None:
        temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
        try:
            with temporary.open("x", encoding="utf-8") as handle:
                os.fchmod(handle.fileno(), 0o600)
                for record in records:
                    handle.write(json.dumps(record.to_json(), sort_keys=True, separators=(",", ":")))
                    handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            directory = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except OSError as error:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
            raise IntegrationFailure(
                f"owner identity registry update failed: {safe_diagnostic(error)}"
            ) from error

    def register(self, record: OwnerRecord) -> None:
        records = self._read()
        require(
            all(existing.owner_id != record.owner_id for existing in records),
            "owner identity is already registered",
        )
        require(
            all(existing.process_group != record.process_group for existing in records),
            "owner process group is already registered",
        )
        self._replace([*records, record])

    def unregister(self, record: OwnerRecord) -> None:
        records = self._read()
        require(record in records, "exact owner identity was not registered")
        self._replace([existing for existing in records if existing != record])

    def contains_process_group(self, process_group: int) -> bool:
        return any(record.process_group == process_group for record in self._read())

    def contains(self, record: OwnerRecord) -> bool:
        return record in self._read()


@dataclass
class OwnedDaemon:
    process: subprocess.Popen[bytes]
    log_path: pathlib.Path
    log_handle: Any
    port: int
    host_capability: str
    instance_id: str
    owner_registry: OwnerRegistry
    owner_record: OwnerRecord
    owner_registered: bool = False

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def process_group(self) -> int:
        return self.owner_record.process_group

    def diagnostics(self) -> str:
        self.log_handle.flush()
        try:
            text = self.log_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return "daemon log unavailable"
        lines = [line for line in text.splitlines() if line.strip()]
        return safe_diagnostic(" ".join(lines[-30:]), self.host_capability)


def write_profile(config_root: pathlib.Path, provider_port: int) -> None:
    settings_dir = config_root / "config" / "user" / "local" / "settings"
    secrets_dir = config_root / "config" / "user" / "local" / "secrets"
    settings_dir.mkdir(parents=True)
    secrets_dir.mkdir(parents=True)
    profile = {
        "profiles": [
            {
                "id": "host-v2-integration-profile",
                "name": "Host v2 integration",
                "kind": "openaiCompatible",
                "providerFlavor": "openai",
                "reasoningTransport": "openaiPlaintext",
                "thinking": "enabled",
                "baseUrl": f"http://127.0.0.1:{provider_port}/v1",
                "model": "host-v2-integration-model",
                "contextWindowTokens": 65536,
                "maxOutputTokens": 4096,
                "temperature": 0.0,
                "enabled": True,
                "secretRef": "local-secret:host-v2-integration-profile",
            }
        ],
        "defaultProfileId": "host-v2-integration-profile",
        "storePath": None,
    }
    (settings_dir / "llm-profiles.json").write_text(
        json.dumps(profile, separators=(",", ":")),
        encoding="utf-8",
    )
    (secrets_dir / "llm-secrets.json").write_text(
        json.dumps(
            {"host-v2-integration-profile": TEST_API_KEY},
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )


def minimal_child_environment() -> dict[str, str]:
    require(NODE is not None and NODE.is_file(), "trusted Node runtime is unavailable")
    environment = {
        key: os.environ[key]
        for key in CHILD_ENVIRONMENT_ALLOWLIST
        if key in os.environ
    }
    trusted_path = [
        str(NODE.parent),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
    ]
    environment["PATH"] = os.pathsep.join(dict.fromkeys(trusted_path))
    return environment


def exec_owned_daemon_wrapper(daemon_path_text: str) -> None:
    encoded_mask = os.environ.pop(EXEC_SIGNAL_MASK_ENV, "")
    encoded_release_fd = os.environ.pop(EXEC_RELEASE_FD_ENV, "")
    require(
        encoded_mask == ""
        or all(part.isascii() and part.isdigit() for part in encoded_mask.split(",")),
        "owned daemon signal mask is invalid",
    )
    require(
        encoded_release_fd.isascii()
        and encoded_release_fd.isdigit()
        and int(encoded_release_fd) > 2,
        "owned daemon release descriptor is invalid",
    )
    previous_mask = {
        signal.Signals(int(part))
        for part in encoded_mask.split(",")
        if part
    }
    release_fd = int(encoded_release_fd)
    try:
        release = os.read(release_fd, 1)
    finally:
        os.close(release_fd)
    require(
        release == b"\x01",
        "owned daemon exec was not released by a durable owner registration",
    )
    daemon_path = pathlib.Path(daemon_path_text)
    require(
        daemon_path.is_absolute()
        and daemon_path == daemon_path.resolve(strict=True)
        and daemon_path.is_file()
        and os.access(daemon_path, os.X_OK),
        "owned daemon executable path is invalid",
    )
    signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
    os.execve(str(daemon_path), [str(daemon_path)], os.environ)


def start_daemon(
    config_root: pathlib.Path,
    port: int,
    owner_registry: OwnerRegistry,
    *,
    generation: int,
) -> OwnedDaemon:
    host_capability = authority_value("dchostv2_", str(generation))
    instance_id = authority_value("dcinstancev2_", chr(ord("a") + generation - 1))
    log_path = config_root / f"daemon-{generation}.log"
    log_handle = log_path.open("wb")
    environment = minimal_child_environment()
    environment.update(
        {
            "DEEPCODE_HOST": "127.0.0.1",
            "DEEPCODE_PORT": str(port),
            "DEEPCODE_CONFIG_DIR": str(config_root),
            "DEEPCODE_HOST_SHELL_CAPABILITY_V2": host_capability,
            "DEEPCODE_HOST_INSTANCE_ID_V2": instance_id,
            "DEEPCODE_LLM_API_KEY": TEST_API_KEY,
        }
    )
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, CONTROL_SIGNALS)
    release_read_fd = -1
    release_write_fd = -1
    environment[EXEC_SIGNAL_MASK_ENV] = ",".join(
        str(int(signal_number))
        for signal_number in sorted(previous_mask, key=int)
    )
    owned: OwnedDaemon | None = None
    process: subprocess.Popen[bytes] | None = None

    try:
        release_read_fd, release_write_fd = os.pipe()
        environment[EXEC_RELEASE_FD_ENV] = str(release_read_fd)
        process = subprocess.Popen(
            [
                sys.executable,
                "-B",
                "-I",
                "-S",
                str(pathlib.Path(__file__).resolve()),
                EXEC_DAEMON_ARGUMENT,
                str(DAEMON.resolve(strict=True)),
            ],
            cwd=ROOT,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            pass_fds=(release_read_fd,),
        )
        os.close(release_read_fd)
        release_read_fd = -1
        identity = capture_process_identity(process.pid)
        require(
            identity.process_group == process.pid
            and identity.session_id == process.pid
            and identity.process_group != os.getpgrp(),
            "daemon launcher did not enter its private process group",
        )
        allowed_executables = tuple(
            dict.fromkeys(
                (
                    str(pathlib.Path(sys.executable).resolve(strict=True)),
                    str(DAEMON.resolve(strict=True)),
                )
            )
        )
        require(
            identity.executable in allowed_executables,
            "daemon launcher executable identity is invalid",
        )
        owner_record = OwnerRecord.create(
            identity,
            allowed_executables=allowed_executables,
            run_root=owner_registry.path.parent.resolve(strict=True),
            config_root=config_root.resolve(strict=True),
            daemon_instance_id=instance_id,
            port=port,
        )
        owned = OwnedDaemon(
            process=process,
            log_path=log_path,
            log_handle=log_handle,
            port=port,
            host_capability=host_capability,
            instance_id=instance_id,
            owner_registry=owner_registry,
            owner_record=owner_record,
        )
        owner_registry.register(owner_record)
        owned.owner_registered = True
        require(
            os.write(release_write_fd, b"\x01") == 1,
            "daemon exec release was incomplete",
        )
        os.close(release_write_fd)
        release_write_fd = -1
    except BaseException as error:
        if release_write_fd >= 0:
            os.close(release_write_fd)
            release_write_fd = -1
        if release_read_fd >= 0:
            os.close(release_read_fd)
            release_read_fd = -1
        if owned is None or not owned.owner_registered:
            if process is not None:
                process.wait()
            log_handle.close()
        else:
            try:
                stop_owned_process_group(owned, graceful=False)
            except BaseException as cleanup_error:
                raise IntegrationFailure(
                    f"{safe_diagnostic(error, host_capability)}; spawn cleanup failed: "
                    f"{safe_diagnostic(cleanup_error, host_capability)}"
                ) from error
        raise
    finally:
        if release_write_fd >= 0:
            os.close(release_write_fd)
        if release_read_fd >= 0:
            os.close(release_read_fd)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)

    require(process is not None and owned is not None, "owned daemon registration is incomplete")
    try:
        if process.poll() is None:
            require(
                os.getpgid(process.pid) == owned.process_group
                and owned.process_group != os.getpgrp(),
                "daemon did not enter its registered private process group",
            )
        deadline = time.monotonic() + 30.0
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise IntegrationFailure(
                    f"daemon generation {generation} exited before readiness: "
                    f"{owned.diagnostics()}"
                )
            try:
                status, body = request_json(
                    owned.base_url,
                    "GET",
                    "/api/host/identity",
                    timeout=0.5,
                )
            except IntegrationFailure:
                time.sleep(0.05)
                continue
            if status == 200 and isinstance(body, dict) and body.get("ok") is True:
                identity = body.get("data")
                require(
                    isinstance(identity, dict)
                    and identity.get("instanceId") == instance_id
                    and identity.get("pid") == process.pid,
                    "daemon identity did not match the owned process",
                )
                return owned
            time.sleep(0.05)
        raise IntegrationFailure(
            f"daemon generation {generation} did not become ready: {owned.diagnostics()}"
        )
    except BaseException as error:
        try:
            stop_owned_process_group(owned, graceful=False)
        except BaseException as cleanup_error:
            raise IntegrationFailure(
                f"{safe_diagnostic(error, host_capability)}; startup cleanup failed: "
                f"{safe_diagnostic(cleanup_error, host_capability)}"
            ) from error
        raise


def _unsafe_owner_observation(
    record: OwnerRecord,
    observation: OwnerObservation,
    action: str,
) -> IntegrationFailure:
    return IntegrationFailure(
        f"{action} refused for owner {record.owner_id}: "
        f"{observation.state}: {observation.detail}"
    )


def _maybe_reap_exact_zombie(
    record: OwnerRecord,
    observation: OwnerObservation,
    process: subprocess.Popen[bytes] | None,
) -> bool:
    if (
        process is None
        or observation.state != "exactOwnedSignalable"
        or observation.member_pids != (record.leader_pid,)
    ):
        return False
    try:
        identity = capture_process_identity(record.leader_pid)
    except ProcessLookupError:
        return False
    except (PermissionError, IntegrationFailure):
        return False
    if not identity.state.startswith("Z") or not _identity_matches_record(identity, record):
        return False
    try:
        process.wait(timeout=0.2)
    except subprocess.TimeoutExpired:
        return False
    return True


def wait_for_owner_change(
    record: OwnerRecord,
    timeout: float,
    *,
    process: subprocess.Popen[bytes] | None,
) -> OwnerObservation:
    deadline = time.monotonic() + timeout
    while True:
        observation = observe_owner(record)
        if observation.state == "absent":
            return observation
        if observation.state == "exactOwnedSignalable" and _maybe_reap_exact_zombie(
            record,
            observation,
            process,
        ):
            continue
        if observation.state in ("identityMismatch", "permissionDenied"):
            return observation
        if time.monotonic() >= deadline:
            return observation
        time.sleep(0.05)


def signal_exact_owner(record: OwnerRecord, signal_number: int) -> OwnerObservation:
    observation = observe_owner(record)
    if observation.state == "absent":
        return observation
    if observation.state != "exactOwnedSignalable":
        raise _unsafe_owner_observation(
            record,
            observation,
            f"signal {signal.Signals(signal_number).name}",
        )
    try:
        os.killpg(record.process_group, signal_number)
    except ProcessLookupError:
        after = observe_owner(record)
        if after.state != "absent":
            raise _unsafe_owner_observation(
                record,
                after,
                f"post-ESRCH {signal.Signals(signal_number).name}",
            )
        return after
    except PermissionError as error:
        raise IntegrationFailure(
            f"signal {signal.Signals(signal_number).name} was denied for exact owner "
            f"{record.owner_id}; owner evidence was retained: {safe_diagnostic(error)}"
        ) from error
    except OSError as error:
        raise IntegrationFailure(
            f"signal {signal.Signals(signal_number).name} failed for exact owner "
            f"{record.owner_id}; owner evidence was retained: {safe_diagnostic(error)}"
        ) from error
    return observe_owner(record)


def require_owner_absence(record: OwnerRecord) -> None:
    remaining = owned_member_pids(record)
    if remaining is None:
        raise IntegrationFailure(
            f"owner {record.owner_id} absence is unverifiable; owner evidence was retained"
        )
    require(
        not remaining,
        f"owner {record.owner_id} still has root/instance-bound processes: "
        + ",".join(str(pid) for pid in remaining),
    )


def require_listener_rebindable(record: OwnerRecord) -> None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind((record.listen_host, record.port))
    except OSError as error:
        raise IntegrationFailure(
            f"owner {record.owner_id} listener {record.listen_host}:{record.port} "
            f"is not rebindable; owner evidence was retained: {safe_diagnostic(error)}"
        ) from error


def _host_identity_response_matches(record: OwnerRecord, body: Any) -> bool:
    identity = body.get("data") if isinstance(body, dict) and body.get("ok") is True else None
    return (
        isinstance(identity, dict)
        and identity.get("instanceId") == record.daemon_instance_id
        and identity.get("pid") == record.leader_pid
    )


def request_owned_host_shutdown(owned: OwnedDaemon) -> None:
    status, identity_body = request_json(
        owned.base_url,
        "GET",
        "/api/host/identity",
        timeout=0.5,
    )
    require(
        status == 200 and _host_identity_response_matches(owned.owner_record, identity_body),
        "Host shutdown preflight returned a different daemon identity",
    )
    status, body = request_json(
        owned.base_url,
        "POST",
        "/api/host/shutdown",
        payload={"expectedIdentity": identity_body["data"]},
        host_capability=owned.host_capability,
    )
    data = require_api_ok(status, body, "Host shutdown")
    identity = data.get("identity") if isinstance(data, dict) else None
    require(
        isinstance(data, dict)
        and data.get("accepted") is True
        and data.get("cleanupComplete") is True
        and isinstance(identity, dict)
        and identity.get("instanceId") == owned.instance_id
        and identity.get("pid") == owned.owner_record.leader_pid,
        "Host shutdown response returned a different daemon identity or incomplete cleanup",
    )


def cleanup_owner_record(
    registry: OwnerRegistry,
    record: OwnerRecord,
    *,
    process: subprocess.Popen[bytes] | None,
    graceful_owner: OwnedDaemon | None,
) -> None:
    failures: list[str] = []
    observation = observe_owner(record)
    if observation.state not in ("absent", "exactOwnedSignalable"):
        raise _unsafe_owner_observation(record, observation, "owner cleanup")

    if graceful_owner is not None and observation.state == "exactOwnedSignalable":
        try:
            request_owned_host_shutdown(graceful_owner)
        except IntegrationFailure as error:
            message = safe_diagnostic(error, graceful_owner.host_capability)
            if "different daemon identity" in message:
                raise IntegrationFailure(
                    f"{message}; no signal was sent and owner evidence was retained"
                ) from error
            failures.append(message)
        observation = wait_for_owner_change(record, 15.0, process=process)
        if observation.state == "exactOwnedSignalable":
            failures.append("owned daemon did not exit through the Host shutdown boundary")
        elif observation.state != "absent":
            raise _unsafe_owner_observation(record, observation, "post-shutdown cleanup")

    observation = observe_owner(record)
    if observation.state == "exactOwnedSignalable":
        signal_exact_owner(record, signal.SIGTERM)
        observation = wait_for_owner_change(record, 5.0, process=process)
    if observation.state == "exactOwnedSignalable":
        signal_exact_owner(record, signal.SIGKILL)
        observation = wait_for_owner_change(record, 5.0, process=process)
    if observation.state != "absent":
        raise _unsafe_owner_observation(record, observation, "final owner cleanup")

    require_owner_absence(record)
    if process is not None:
        try:
            process.wait(timeout=1.0)
        except subprocess.TimeoutExpired as error:
            raise IntegrationFailure(
                f"owner {record.owner_id} leader remained unreaped; owner evidence was retained"
            ) from error
    require_listener_rebindable(record)
    registry.unregister(record)
    if failures:
        raise IntegrationFailure("; ".join(failures))


def stop_owned_process_group(owned: OwnedDaemon, *, graceful: bool) -> None:
    try:
        cleanup_owner_record(
            owned.owner_registry,
            owned.owner_record,
            process=owned.process,
            graceful_owner=owned if graceful else None,
        )
    finally:
        if owned.owner_registered and not owned.owner_registry.contains(owned.owner_record):
            owned.owner_registered = False
        if not owned.log_handle.closed:
            owned.log_handle.close()


def run_cli(
    base_url: str,
    host_capability: str,
    arguments: list[str],
    *,
    expect_success: bool,
) -> subprocess.CompletedProcess[str]:
    environment = minimal_child_environment()
    environment["DEEPCODE_HOST_SHELL_CAPABILITY_V2"] = host_capability
    completed = subprocess.run(
        [
            str(CLI),
            "--api",
            base_url,
            "--no-auto-start-kernel",
            *arguments,
        ],
        cwd=ROOT,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=30.0,
        check=False,
    )
    if expect_success:
        require(
            completed.returncode == 0,
            f"CLI {' '.join(arguments)} failed: "
            f"{safe_diagnostic(completed.stderr, host_capability)}",
        )
    else:
        require(
            completed.returncode != 0,
            f"CLI {' '.join(arguments)} unexpectedly succeeded",
        )
    return completed


def validate_transport_lanes(daemon: OwnedDaemon) -> None:
    direct_run_open = {
        "abiVersion": ABI_VERSION,
        "requestId": "request-host-v2-direct-run-open",
        "command": {
            "kind": "runOpen",
            "data": {
                "workspaceBindingRef": "wsb_v2_" + "0" * 64,
                "inputId": "input-host-v2-direct-run-open",
                "opaqueInputRef": "host-v2-direct-run-open",
            },
        },
    }
    status, body = request_json(
        daemon.base_url,
        "POST",
        "/api/kernel/v2/commands",
        payload=direct_run_open,
        host_capability=daemon.host_capability,
    )
    require(status == 403, "Session command lane did not reject direct RunOpen")
    require(
        isinstance(body, dict) and body.get("code") == "host_authority_required",
        "Session command lane returned the wrong RunOpen authority error",
    )

    unauthorized_decision = {
        "abiVersion": ABI_VERSION,
        "requestId": "request-host-v2-untrusted-decision",
        "runId": "run-host-v2-untrusted-decision",
        "decisionCapability": "untrusted-decision-capability",
        "expectedControlEpoch": 1,
        "decision": {
            "kind": "revoke",
            "data": {
                "inputId": "input-host-v2-untrusted-decision",
                "decisionRef": "decision-host-v2-untrusted",
                "target": {
                    "kind": "capabilityLease",
                    "data": {"leaseId": "lease-host-v2-untrusted"},
                },
                "reason": "Host integration verifies the trusted decision lane.",
            },
        },
    }
    status, body = request_json(
        daemon.base_url,
        "POST",
        "/api/kernel/v2/user-decisions",
        payload=unauthorized_decision,
    )
    require(status == 403, "Decision lane accepted an unissued decision capability")
    require(
        isinstance(body, dict) and body.get("code") == "decision_capability_invalid",
        "Decision lane returned the wrong capability error",
    )


def validate_legacy_routes_rejected(daemon: OwnedDaemon) -> None:
    status, body = request_json(
        daemon.base_url,
        "POST",
        "/api/kernel/commands",
        payload={"command": {"kind": "healthCheck", "requestId": "legacy-request"}},
        host_capability=daemon.host_capability,
    )
    require(status == 404, "legacy /api/kernel/commands route remained reachable")
    require(
        isinstance(body, dict) and body.get("error") == "api_route_not_found",
        "legacy command route did not fail through the typed Host 404",
    )
    status, body = request_json(
        daemon.base_url,
        "GET",
        "/api/kernel/snapshot",
        host_capability=daemon.host_capability,
    )
    require(status == 404, "legacy /api/kernel/snapshot route remained reachable")
    require(
        isinstance(body, dict) and body.get("error") == "api_route_not_found",
        "legacy snapshot route did not fail through the typed Host 404",
    )


def create_session(daemon: OwnedDaemon) -> str:
    status, body = request_json(
        daemon.base_url,
        "POST",
        "/api/agent/sessions",
        payload={"title": "Host v2 integration"},
        host_capability=daemon.host_capability,
    )
    data = require_api_ok(status, body, "Session creation")
    require(isinstance(data, dict), "Session creation returned invalid data")
    session = data.get("session")
    if not isinstance(session, dict):
        session = data
    session_id = session.get("id") if isinstance(session, dict) else None
    require(isinstance(session_id, str) and session_id, "Session ID is missing")
    require(
        session.get("sessionSchemaVersion") == "deepcode.agent.session.v2"
        and session.get("kernelAbiVersion") == ABI_VERSION,
        "Session metadata did not use the v2 contract",
    )
    encoded_session_id = urllib.parse.quote(session_id, safe="")
    status, body = request_json(
        daemon.base_url,
        "PATCH",
        f"/api/agent/sessions/{encoded_session_id}",
        payload={"profileId": "host-v2-integration-profile"},
        host_capability=daemon.host_capability,
    )
    bound = require_api_ok(status, body, "Session Profile binding")
    require(isinstance(bound, dict), "Session Profile binding returned invalid data")
    bound_session = bound.get("session")
    if not isinstance(bound_session, dict):
        bound_session = bound
    require(
        isinstance(bound_session, dict)
        and bound_session.get("id") == session_id
        and bound_session.get("profileId") == "host-v2-integration-profile",
        "Session did not retain the exact controlled Provider Profile",
    )
    return session_id


def delete_session_and_require_private_storage_released(
    daemon: OwnedDaemon,
    config_root: pathlib.Path,
    session_id: str,
) -> None:
    status, body = request_json(
        daemon.base_url,
        "DELETE",
        f"/api/agent/sessions/{urllib.parse.quote(session_id, safe='')}",
        host_capability=daemon.host_capability,
        timeout=15.0,
    )
    require_api_ok(status, body, "Provider trace resource Session deletion")
    require(
        not (config_root / "sessions" / session_id).exists(),
        "Provider trace resource Session retained private storage after deletion",
    )


def read_agent_timeline(
    daemon: OwnedDaemon,
    session_id: str,
) -> dict[str, Any]:
    status, body = request_json(
        daemon.base_url,
        "GET",
        f"/api/agent/sessions/{urllib.parse.quote(session_id, safe='')}/timeline",
        host_capability=daemon.host_capability,
    )
    timeline = require_api_ok(status, body, "Shared Conversation Projection")
    require(
        isinstance(timeline, dict)
        and timeline.get("schemaVersion")
        == "deepcode.shared-conversation-projection.v2"
        and timeline.get("shapeVersion")
        == "deepcode.shared-conversation.work-segments.v2",
        "Session timeline did not use the exact Shared Projection v2 shape",
    )
    return timeline


def current_timeline_turn(timeline: dict[str, Any]) -> dict[str, Any]:
    run_projection = timeline.get("runProjection")
    turn_id = (
        run_projection.get("turnId")
        if isinstance(run_projection, dict)
        else None
    )
    turns = timeline.get("turns")
    turn = next(
        (
            candidate
            for candidate in turns
            if isinstance(candidate, dict) and candidate.get("id") == turn_id
        ),
        None,
    ) if isinstance(turns, list) else None
    require(
        isinstance(turn, dict),
        "Shared Projection omitted the current typed turn",
    )
    return turn


def require_delete_plan_waiting_projection(
    timeline: dict[str, Any],
) -> tuple[str, str]:
    run_projection = timeline.get("runProjection")
    require(
        isinstance(run_projection, dict)
        and run_projection.get("status") == "waitingUser"
        and run_projection.get("phase") == "waiting"
        and isinstance(run_projection.get("wait"), dict)
        and run_projection["wait"].get("kind") == "user",
        "delete Plan did not stop at the typed waitingUser boundary",
    )
    kernel_run_id = run_projection.get("runId")
    require(
        isinstance(kernel_run_id, str) and kernel_run_id,
        "delete Plan waiting projection omitted the exact Kernel Run",
    )
    interaction = timeline.get("interactionProjection")
    pending = (
        interaction.get("pending")
        if isinstance(interaction, dict)
        else None
    )
    require(
        isinstance(pending, dict)
        and pending.get("kind") == "plan"
        and pending.get("runId") == kernel_run_id
        and pending.get("targetId") == pending.get("planId"),
        "delete Plan did not expose one exact pending Plan interaction",
    )
    plan_revision = pending.get("targetId")
    require(
        isinstance(plan_revision, str) and plan_revision,
        "delete Plan interaction omitted its exact revision",
    )

    turn = current_timeline_turn(timeline)
    require(
        turn.get("workSegments") == [],
        "scope preview created a WorkSegment before any ToolIntent admission",
    )
    blocks = turn.get("blocks")
    plan_blocks = [
        block
        for block in blocks
        if isinstance(block, dict)
        and block.get("kind") == "plan"
        and block.get("confirmable") is True
        and isinstance(block.get("interaction"), dict)
        and block["interaction"].get("targetId") == plan_revision
    ] if isinstance(blocks, list) else []
    require(
        len(plan_blocks) == 1,
        "delete Plan did not publish one confirmable Plan block",
    )
    structured = plan_blocks[0].get("structuredProjection")
    sections = (
        structured.get("sections")
        if isinstance(structured, dict)
        else None
    )
    scope_sections = [
        section
        for section in sections
        if isinstance(section, dict)
        and section.get("sectionId") == "scopeApproval"
    ] if isinstance(sections, list) else []
    require(
        len(scope_sections) == 1,
        "delete Plan omitted its canonical scope approval section",
    )
    scope_items = scope_sections[0].get("items")
    require(
        isinstance(scope_items, list)
        and len(scope_items) == 1
        and isinstance(scope_items[0], dict)
        and scope_items[0].get("targetRefs")
        == [f"workspace:Write:{DELETE_TARGET_RELATIVE_PATH}"],
        "delete Plan canonical scope was not exactly the test-owned relative file",
    )
    task_projection = timeline.get("taskProjection")
    task_items = (
        task_projection.get("items")
        if isinstance(task_projection, dict)
        else None
    )
    require(
        isinstance(task_items, list)
        and len(task_items) == 1
        and isinstance(task_items[0], dict)
        and task_items[0].get("status") == "awaitingApproval",
        "delete Plan task did not remain awaitingApproval before user confirmation",
    )
    return kernel_run_id, plan_revision


def require_delete_plan_rejected_projection(
    timeline: dict[str, Any],
) -> None:
    run_projection = timeline.get("runProjection")
    require(
        isinstance(run_projection, dict)
        and run_projection.get("status") == "succeeded"
        and run_projection.get("phase") == "settled",
        "rejected delete Plan did not reach a terminal typed projection",
    )
    interaction = timeline.get("interactionProjection")
    require(
        interaction is None
        or (
            isinstance(interaction, dict)
            and interaction.get("pending") is None
        ),
        "rejected delete Plan retained a pending interaction",
    )
    task_projection = timeline.get("taskProjection")
    task_items = (
        task_projection.get("items")
        if isinstance(task_projection, dict)
        else None
    )
    require(
        isinstance(task_items, list)
        and len(task_items) == 1
        and isinstance(task_items[0], dict)
        and task_items[0].get("status") == "unexecuted",
        "rejected delete Plan was not projected as one unexecuted task",
    )
    turn = current_timeline_turn(timeline)
    require(
        turn.get("workSegments") == [],
        "rejected delete Plan synthesized tool work without an invocation",
    )
    blocks = turn.get("blocks")
    committed_finals = [
        block
        for block in blocks
        if isinstance(block, dict)
        and block.get("kind") == "assistant"
        and block.get("entryRole") == "finalAnswer"
        and block.get("durability") == "committed"
        and block.get("status") == "completed"
        and block.get("bodyMarkdown") == CLI_DELETE_FINAL_TEXT
    ] if isinstance(blocks, list) else []
    require(
        len(committed_finals) == 1,
        "rejected delete Plan lost its one bound committed finalAnswer",
    )


@dataclass(frozen=True)
class CanonicalRunSnapshot:
    run_id: str
    high_water: int
    fact_sequences: tuple[tuple[str, int], ...]


@dataclass(frozen=True)
class PredecessorFactStoreSnapshot:
    contents: bytes
    sha256: str


def kernel_fact_store(config_root: pathlib.Path) -> pathlib.Path:
    return config_root / "kernel" / CURRENT_FACT_STORE_FILE_NAME


def predecessor_kernel_fact_store(config_root: pathlib.Path) -> pathlib.Path:
    return config_root / "kernel" / PREDECESSOR_FACT_STORE_FILE_NAME


def fact_store_sidecars(database: pathlib.Path) -> tuple[pathlib.Path, ...]:
    return tuple(
        pathlib.Path(f"{database}{suffix}")
        for suffix in ("-journal", "-shm", "-wal")
    )


def fact_store_schema_meta(database: pathlib.Path) -> dict[str, str]:
    require(database.is_file(), f"fact store is missing: {database.name}")
    try:
        with sqlite3.connect(
            f"file:{database}?mode=ro",
            uri=True,
            timeout=5.0,
        ) as connection:
            rows = connection.execute(
                "SELECT key, value FROM schema_meta ORDER BY key"
            ).fetchall()
    except sqlite3.Error as error:
        raise IntegrationFailure(
            f"fact-store schema metadata query failed for {database.name}: "
            f"{safe_diagnostic(error)}"
        ) from error
    require(
        all(
            isinstance(key, str)
            and isinstance(value, str)
            and key
            for key, value in rows
        ),
        f"fact-store schema metadata is invalid for {database.name}",
    )
    return dict(rows)


def seed_incompatible_predecessor_fact_store(
    config_root: pathlib.Path,
) -> PredecessorFactStoreSnapshot:
    predecessor = predecessor_kernel_fact_store(config_root)
    current = kernel_fact_store(config_root)
    predecessor.parent.mkdir(parents=True, exist_ok=True)
    require(
        not predecessor.exists() and not current.exists(),
        "fact-store cutover fixture requires an unused config root",
    )
    try:
        with sqlite3.connect(predecessor, timeout=5.0) as connection:
            connection.execute(
                "CREATE TABLE schema_meta ("
                "key TEXT PRIMARY KEY NOT NULL,"
                "value TEXT NOT NULL"
                ") WITHOUT ROWID"
            )
            connection.executemany(
                "INSERT INTO schema_meta (key, value) VALUES (?1, ?2)",
                (
                    ("schema_version", FACT_STORE_SCHEMA_VERSION),
                    ("schema_contract", PREDECESSOR_FACT_STORE_SCHEMA_CONTRACT),
                    ("abi_version", ABI_VERSION),
                ),
            )
    except sqlite3.Error as error:
        raise IntegrationFailure(
            f"incompatible predecessor fact-store fixture could not be created: "
            f"{safe_diagnostic(error)}"
        ) from error
    require(
        not any(path.exists() for path in fact_store_sidecars(predecessor)),
        "predecessor fixture retained a SQLite sidecar before daemon startup",
    )
    contents = predecessor.read_bytes()
    require(contents, "predecessor fixture is empty")
    require(
        fact_store_schema_meta(predecessor)
        == {
            "abi_version": ABI_VERSION,
            "schema_contract": PREDECESSOR_FACT_STORE_SCHEMA_CONTRACT,
            "schema_version": FACT_STORE_SCHEMA_VERSION,
        },
        "predecessor fixture schema discriminator is invalid",
    )
    return PredecessorFactStoreSnapshot(
        contents=contents,
        sha256=hashlib.sha256(contents).hexdigest(),
    )


def host_startup_uses_current_contract_store_without_touching_incompatible_predecessor(
    owned: OwnedDaemon,
    config_root: pathlib.Path,
    predecessor_snapshot: PredecessorFactStoreSnapshot,
) -> None:
    deadline = time.monotonic() + 30.0
    last_observation = "health endpoint was not observed"
    while time.monotonic() < deadline:
        require(
            owned.process.poll() is None,
            f"daemon exited before authenticated readiness: {owned.diagnostics()}",
        )
        try:
            status, body = request_json(
                owned.base_url,
                "GET",
                "/api/health",
                timeout=0.5,
            )
        except IntegrationFailure as error:
            last_observation = safe_diagnostic(error, owned.host_capability)
            time.sleep(0.05)
            continue
        data = body.get("data") if isinstance(body, dict) else None
        readiness = (
            data.get("hostStartupReadinessV2")
            if isinstance(data, dict)
            else None
        )
        if (
            status == 200
            and isinstance(body, dict)
            and body.get("ok") is True
            and isinstance(data, dict)
            and data.get("service") == "deepcode-kernel-daemon"
            and data.get("ok") is True
            and data.get("status") == "ok"
            and data.get("kernel") == "ready"
            and isinstance(readiness, dict)
            and readiness.get("ready") is True
            and readiness.get("phase") == "ready"
        ):
            break
        last_observation = safe_diagnostic(body, owned.host_capability)
        time.sleep(0.05)
    else:
        raise IntegrationFailure(
            "daemon did not reach authenticated Host readiness after fact-store cutover: "
            f"{last_observation}; {owned.diagnostics()}"
        )

    predecessor = predecessor_kernel_fact_store(config_root)
    current = kernel_fact_store(config_root)
    current_meta = fact_store_schema_meta(current)
    require(
        current_meta
        == {
            "abi_version": ABI_VERSION,
            "schema_contract": CURRENT_FACT_STORE_SCHEMA_CONTRACT,
            "schema_version": FACT_STORE_SCHEMA_VERSION,
        },
        "daemon did not create the exact current fact-store schema discriminator",
    )
    predecessor_contents = predecessor.read_bytes()
    require(
        predecessor_contents == predecessor_snapshot.contents
        and hashlib.sha256(predecessor_contents).hexdigest()
        == predecessor_snapshot.sha256,
        "daemon changed the incompatible predecessor fact-store bytes",
    )
    require(
        fact_store_schema_meta(predecessor)
        == {
            "abi_version": ABI_VERSION,
            "schema_contract": PREDECESSOR_FACT_STORE_SCHEMA_CONTRACT,
            "schema_version": FACT_STORE_SCHEMA_VERSION,
        },
        "daemon changed the incompatible predecessor schema discriminator",
    )
    require(
        not any(path.exists() for path in fact_store_sidecars(predecessor)),
        "daemon opened the incompatible predecessor and created a SQLite sidecar",
    )


def require_no_execution_fact_domains(
    config_root: pathlib.Path,
    run_id: str,
    context: str,
) -> None:
    database = kernel_fact_store(config_root)
    require(database.is_file(), f"{context} canonical fact store is missing")
    try:
        with sqlite3.connect(
            f"file:{database}?mode=ro",
            uri=True,
            timeout=5.0,
        ) as connection:
            rows = connection.execute(
                "SELECT ledger_sequence, envelope_json FROM kernel_facts "
                "WHERE run_id = ?1 ORDER BY ledger_sequence",
                (run_id,),
            ).fetchall()
    except sqlite3.Error as error:
        raise IntegrationFailure(
            f"{context} canonical fact query failed: {safe_diagnostic(error)}"
        ) from error
    decoded: list[tuple[int, str, str]] = []
    for sequence, envelope_json in rows:
        try:
            envelope = json.loads(envelope_json)
            payload = envelope["payload"]
            domain = payload["domain"]
            fact_kind = payload["fact"]["kind"]
        except (KeyError, TypeError, json.JSONDecodeError) as error:
            raise IntegrationFailure(
                f"{context} canonical fact envelope is invalid"
            ) from error
        require(
            isinstance(domain, str) and isinstance(fact_kind, str),
            f"{context} canonical fact domain or kind is invalid",
        )
        decoded.append((int(sequence), domain, fact_kind))
    require(
        any(domain == "control" and fact_kind == "runOpened"
            for _, domain, fact_kind in decoded),
        f"{context} omitted the canonical runOpened fact",
    )
    forbidden = [
        (sequence, domain, fact_kind)
        for sequence, domain, fact_kind in decoded
        if domain in {"invocation", "effect", "resource", "cleanup"}
    ]
    require(
        not forbidden,
        f"{context} created execution facts before authorization: "
        + json.dumps(forbidden, separators=(",", ":")),
    )


def host_operation_store(config_root: pathlib.Path) -> pathlib.Path:
    return config_root / "sessions" / ".host-v3" / "host-kernel-v3.sqlite3"


def query_host_operation_snapshot(
    database: pathlib.Path,
    query: str,
    parameters: tuple[Any, ...],
) -> list[tuple[Any, ...]]:
    sidecars = [
        database.with_name(f"{database.name}-wal"),
        database.with_name(f"{database.name}-shm"),
    ]
    deadline = time.monotonic() + 5.0
    last_error: sqlite3.Error | None = None
    while time.monotonic() < deadline:
        if any(sidecar.exists() for sidecar in sidecars):
            time.sleep(0.05)
            continue
        try:
            with sqlite3.connect(
                f"file:{database}?mode=ro&immutable=1",
                uri=True,
                timeout=1.0,
            ) as connection:
                rows = connection.execute(query, parameters).fetchall()
        except sqlite3.Error as error:
            last_error = error
            time.sleep(0.05)
            continue
        if any(sidecar.exists() for sidecar in sidecars):
            time.sleep(0.05)
            continue
        return rows
    if last_error is not None:
        raise IntegrationFailure(
            f"Host operation snapshot query failed: {safe_diagnostic(last_error)}"
        ) from last_error
    raise IntegrationFailure("Host operation snapshot did not reach a stable WAL boundary")


def read_host_kernel_run_identity(
    config_root: pathlib.Path,
    session_id: str,
    host_run_id: str,
) -> str:
    database = host_operation_store(config_root)
    require(database.is_file(), "exact Host operation store is missing")
    rows = query_host_operation_snapshot(
        database,
        "SELECT run_id, lifecycle FROM host_kernel_runs "
        "WHERE session_id = ?1 AND host_run_id = ?2",
        (session_id, host_run_id),
    )
    require(len(rows) == 1, "Host operation store omitted the exact Run identity")
    run_id, lifecycle = rows[0]
    require(
        isinstance(run_id, str) and run_id and lifecycle == "Retired",
        "Host operation store did not durably retire the exact Kernel Run",
    )
    return run_id


def read_cli_ask_host_run_identity(
    config_root: pathlib.Path,
    session_id: str,
) -> str:
    database = host_operation_store(config_root)
    require(database.is_file(), "CLI Host operation store is missing")
    caller_rows = query_host_operation_snapshot(
        database,
        "SELECT caller_request_id, response_identity_json, drive_state, "
        "outcome_json, settled_at FROM host_caller_requests "
        "WHERE session_id = ?1 AND caller_request_id LIKE 'cli-ask-%' "
        "ORDER BY id",
        (session_id,),
    )
    require(len(caller_rows) == 1, "CLI ask did not create one exact caller identity")
    caller_request_id, response_identity_json, drive_state, outcome_json, settled_at = (
        caller_rows[0]
    )
    require(
        isinstance(caller_request_id, str)
        and caller_request_id.startswith("cli-ask-")
        and drive_state == "Driving"
        and isinstance(outcome_json, str)
        and isinstance(settled_at, str),
        "CLI ask caller identity was not durably settled",
    )
    try:
        response_identity = json.loads(response_identity_json)
    except (TypeError, json.JSONDecodeError) as error:
        raise IntegrationFailure("CLI caller response identity is invalid") from error
    host_run_id = (
        response_identity.get("hostRunId")
        if isinstance(response_identity, dict)
        else None
    )
    require(
        isinstance(host_run_id, str) and host_run_id,
        "CLI caller identity omitted its exact Host Run",
    )
    read_host_kernel_run_identity(config_root, session_id, host_run_id)
    return host_run_id


def canonical_run_snapshot(
    config_root: pathlib.Path,
    session_id: str,
    host_run_id: str,
) -> CanonicalRunSnapshot:
    run_id = read_host_kernel_run_identity(config_root, session_id, host_run_id)
    database = kernel_fact_store(config_root)
    require(
        database.is_file(),
        f"exact {CURRENT_FACT_STORE_FILE_NAME} fact store is missing",
    )
    try:
        with sqlite3.connect(
            f"file:{database}?mode=ro",
            uri=True,
            timeout=5.0,
        ) as connection:
            high_water_row = connection.execute(
                "SELECT COALESCE(MAX(ledger_sequence), 0) FROM kernel_facts"
            ).fetchone()
            fact_rows = connection.execute(
                "SELECT ledger_sequence, envelope_json FROM kernel_facts "
                "WHERE run_id = ?1 ORDER BY ledger_sequence",
                (run_id,),
            ).fetchall()
            forbidden_authority = connection.execute(
                "SELECT material_kind, lifecycle FROM authority_material "
                "WHERE run_id = ?1 "
                "AND lifecycle IN ('active', 'awaiting', 'bound', 'retirementPending') "
                "ORDER BY material_kind, material_id",
                (run_id,),
            ).fetchall()
    except sqlite3.Error as error:
        raise IntegrationFailure(
            f"canonical Kernel fact query failed: {safe_diagnostic(error)}"
        ) from error
    require(
        high_water_row is not None and isinstance(high_water_row[0], int),
        "canonical Kernel fact high-water is invalid",
    )
    require(
        not forbidden_authority,
        "retired Run retained live authority material: "
        + ",".join(f"{kind}:{lifecycle}" for kind, lifecycle in forbidden_authority),
    )
    expected: dict[str, list[int]] = {
        "runOpened": [],
        "runRetirementFenced": [],
        "runRetired": [],
    }
    for ledger_sequence, envelope_json in fact_rows:
        try:
            envelope = json.loads(envelope_json)
            fact = envelope["payload"]["fact"]
            kind = fact["kind"]
        except (KeyError, TypeError, json.JSONDecodeError) as error:
            raise IntegrationFailure(
                "canonical Kernel fact envelope is invalid"
            ) from error
        if kind in expected:
            try:
                fact_run_id = fact["data"]["runId"]
            except (KeyError, TypeError) as error:
                raise IntegrationFailure(
                    f"{kind} fact omitted its exact Kernel Run"
                ) from error
            require(
                fact_run_id == run_id,
                f"{kind} fact did not bind the exact Kernel Run",
            )
            expected[kind].append(int(ledger_sequence))
    for kind, sequences in expected.items():
        require(
            len(sequences) == 1,
            f"exact Kernel Run requires one {kind} fact, observed {len(sequences)}",
        )
    opened = expected["runOpened"][0]
    fenced = expected["runRetirementFenced"][0]
    retired = expected["runRetired"][0]
    require(
        opened < fenced < retired <= int(high_water_row[0]),
        "Kernel Run retirement facts are out of order",
    )
    return CanonicalRunSnapshot(
        run_id=run_id,
        high_water=int(high_water_row[0]),
        fact_sequences=tuple(
            (kind, sequences[0]) for kind, sequences in expected.items()
        ),
    )


def require_fixed_read_canonical_facts(
    config_root: pathlib.Path,
    snapshot: CanonicalRunSnapshot,
    expected_bytes: int,
) -> None:
    database = kernel_fact_store(config_root)
    try:
        with sqlite3.connect(
            f"file:{database}?mode=ro",
            uri=True,
            timeout=5.0,
        ) as connection:
            rows = connection.execute(
                "SELECT ledger_sequence, envelope_json FROM kernel_facts "
                "WHERE run_id = ?1 ORDER BY ledger_sequence",
                (snapshot.run_id,),
            ).fetchall()
    except sqlite3.Error as error:
        raise IntegrationFailure(
            f"fixed read canonical fact query failed: {safe_diagnostic(error)}"
        ) from error

    decoded: list[tuple[int, dict[str, Any]]] = []
    for sequence, envelope_json in rows:
        try:
            envelope = json.loads(envelope_json)
            fact = envelope["payload"]["fact"]
        except (KeyError, TypeError, json.JSONDecodeError) as error:
            raise IntegrationFailure(
                "fixed read canonical fact envelope is invalid"
            ) from error
        require(isinstance(fact, dict), "fixed read fact payload is invalid")
        decoded.append((int(sequence), fact))

    admitted = [
        (sequence, fact)
        for sequence, fact in decoded
        if fact.get("kind") == "toolIntentAdmitted"
        and isinstance(fact.get("data"), dict)
        and fact["data"].get("toolId") == FIXED_TOOL_ID
    ]
    completed = [
        (sequence, fact)
        for sequence, fact in decoded
        if fact.get("kind") == "toolCompleted"
        and isinstance(fact.get("data"), dict)
        and isinstance(fact["data"].get("output"), dict)
    ]
    observed = [
        (sequence, fact)
        for sequence, fact in decoded
        if isinstance(fact.get("kind"), str)
        and fact["kind"].startswith("toolObserved")
    ]
    require(
        len(admitted) == 1 and len(completed) == 1 and len(observed) == 1,
        "fixed fs.read did not produce one admitted, observed, and completed fact; "
        + json.dumps(
            {
                "factKinds": [fact.get("kind") for _, fact in decoded],
                "admittedCount": len(admitted),
                "observedCount": len(observed),
                "completedCount": len(completed),
                "completedOutputs": [
                    {
                        "payloadKind": data.get("output", {})
                        .get("payload", {})
                        .get("kind"),
                        "truncationKind": data.get("output", {})
                        .get("truncation", {})
                        .get("kind"),
                    }
                    for _, fact in decoded
                    for data in [fact.get("data")]
                    if fact.get("kind") == "toolCompleted"
                    and isinstance(data, dict)
                    and isinstance(data.get("output"), dict)
                ],
            },
            separators=(",", ":"),
        ),
    )
    admitted_sequence, admitted_fact = admitted[0]
    observed_sequence, observed_fact = observed[0]
    completed_sequence, completed_fact = completed[0]
    admitted_lineage = admitted_fact["data"].get("identity")
    observed_data = observed_fact.get("data")
    completed_data = completed_fact["data"]
    observed_lineage = (
        observed_data.get("identity") if isinstance(observed_data, dict) else None
    )
    completed_lineage = completed_data.get("identity")
    require(
        isinstance(admitted_lineage, dict)
        and isinstance(observed_lineage, dict)
        and isinstance(completed_lineage, dict)
        and admitted_lineage.get("invocationId")
        == observed_lineage.get("invocationId")
        == completed_lineage.get("invocationId")
        and observed_lineage.get("effectId")
        == completed_lineage.get("effectId")
        and observed_lineage.get("effectId") is not None
        and admitted_sequence < observed_sequence < completed_sequence,
        "fixed fs.read canonical lineage or fact order changed",
    )
    resource_scope = admitted_fact["data"].get("resourceScope")
    scope_data = (
        resource_scope.get("data") if isinstance(resource_scope, dict) else None
    )
    targets = scope_data.get("targets") if isinstance(scope_data, dict) else None
    require(
        isinstance(resource_scope, dict)
        and resource_scope.get("kind") == "workspace"
        and isinstance(targets, list)
        and len(targets) == 1
        and isinstance(targets[0], dict)
        and targets[0].get("relativePath") == "README.md"
        and targets[0].get("access") == "read",
        "fixed fs.read admission did not bind the canonical README.md read scope",
    )
    evidence = (
        observed_data.get("evidence") if isinstance(observed_data, dict) else None
    )
    evidence_data = evidence.get("data") if isinstance(evidence, dict) else None
    require(
        isinstance(evidence, dict)
        and evidence.get("kind") == "contentRead"
        and isinstance(evidence_data, dict)
        and evidence_data.get("byteLength") == expected_bytes,
        "fixed fs.read observation changed the canonical README.md byte count",
    )
    output = completed_data["output"]
    payload = output.get("payload")
    truncation = output.get("truncation")
    require(
        isinstance(payload, dict)
        and payload.get("kind") == "utf8Text"
        and isinstance(payload.get("data"), dict)
        and isinstance(payload["data"].get("text"), str)
        and isinstance(truncation, dict)
        and truncation.get("kind") == "complete",
        "fixed fs.read completion did not retain one complete UTF-8 result",
    )


def validate_fs_delete_plan_preview_rejection_without_effect(
    daemon: OwnedDaemon,
    config_root: pathlib.Path,
    workspace: pathlib.Path,
    provider: ProviderServer,
) -> None:
    target = workspace / DELETE_TARGET_RELATIVE_PATH
    target.write_bytes(b"owned delete preview sentinel\n")
    before_digest = hashlib.sha256(target.read_bytes()).hexdigest()
    session_id = create_session(daemon)
    provider_count_before = provider.request_count()

    plan_cli = run_cli(
        daemon.base_url,
        daemon.host_capability,
        [
            "--print",
            "--session",
            session_id,
            "--workspace",
            str(workspace),
            "ask",
            CLI_DELETE_PLAN_PROMPT,
        ],
        expect_success=False,
    )
    require(
        plan_cli.returncode == 5,
        "delete Plan CLI did not use the dedicated action-required exit code",
    )
    require(
        not plan_cli.stdout.strip(),
        "delete Plan CLI printed a final answer before the user decision",
    )
    provider_count_waiting = provider.request_count()
    require(
        provider_count_waiting == provider_count_before + 1,
        "delete Plan proposal did not use exactly one initial Provider request",
    )
    initial_request = provider.request_snapshot()[provider_count_before]
    assert_provider_received_current_input(
        initial_request,
        CLI_DELETE_PLAN_PROMPT,
    )
    require(
        provider_current_input_target_kind(initial_request) == "planning"
        and not provider_current_input_guidance(initial_request)
        and provider_request_exposes_tool(
            initial_request,
            SESSION_PLAN_PROPOSAL_TOOL_NAME,
        )
        and not provider_request_exposes_tool(
            initial_request,
            DELETE_PROVIDER_TOOL_NAME,
        ),
        "initial delete Plan request crossed the Session Plan-control boundary",
    )

    waiting_timeline = read_agent_timeline(daemon, session_id)
    kernel_run_id, plan_revision = require_delete_plan_waiting_projection(
        waiting_timeline
    )
    require_no_execution_fact_domains(
        config_root,
        kernel_run_id,
        "delete Plan preview",
    )
    require(
        target.is_file()
        and hashlib.sha256(target.read_bytes()).hexdigest() == before_digest,
        "delete Plan preview changed the test-owned file before confirmation",
    )

    try:
        rejected = run_cli(
            daemon.base_url,
            daemon.host_capability,
            [
                "--session",
                session_id,
                "decision",
                "plan",
                "reject",
                kernel_run_id,
                plan_revision,
            ],
            expect_success=True,
        )
    except subprocess.TimeoutExpired as error:
        requests_after_timeout = provider.request_snapshot()[
            provider_count_before:
        ]
        timeline_after_timeout = read_agent_timeline(daemon, session_id)
        run_after_timeout = timeline_after_timeout.get("runProjection")
        task_after_timeout = timeline_after_timeout.get("taskProjection")
        interaction_after_timeout = timeline_after_timeout.get(
            "interactionProjection"
        )
        raise IntegrationFailure(
            "delete Plan rejection timed out; safe state="
            + json.dumps(
                {
                    "providerTurns": [
                        {
                            "targetKind": provider_current_input_target_kind(request),
                            "guidanceCount": len(
                                provider_current_input_guidance(request)
                            ),
                            "toolCount": len(request.get("tools", []))
                            if isinstance(request.get("tools"), list)
                            else None,
                        }
                        for request in requests_after_timeout
                    ],
                    "run": {
                        "status": run_after_timeout.get("status"),
                        "phase": run_after_timeout.get("phase"),
                        "waitKind": (
                            run_after_timeout.get("wait", {}).get("kind")
                            if isinstance(run_after_timeout.get("wait"), dict)
                            else None
                        ),
                    }
                    if isinstance(run_after_timeout, dict)
                    else None,
                    "taskStatuses": [
                        item.get("status")
                        for item in task_after_timeout.get("items", [])
                        if isinstance(item, dict)
                    ]
                    if isinstance(task_after_timeout, dict)
                    else None,
                    "pendingInteraction": (
                        interaction_after_timeout.get("pending", {}).get("kind")
                        if isinstance(interaction_after_timeout, dict)
                        and isinstance(
                            interaction_after_timeout.get("pending"),
                            dict,
                        )
                        else None
                    ),
                },
                separators=(",", ":"),
            )
        ) from error
    require(
        CLI_DELETE_FINAL_TEXT in rejected.stdout,
        "delete Plan rejection did not print its bound committed finalAnswer",
    )
    provider_count_rejected = provider.request_count()
    require(
        provider_count_rejected == provider_count_before + 3,
        "delete Plan rejection did not use proposal, replan, and finalAnswer Provider turns",
    )
    requests = provider.request_snapshot()[
        provider_count_before:provider_count_rejected
    ]
    require(
        len(requests) == 3,
        "delete Plan Provider request snapshot changed during validation",
    )
    replan_request = requests[1]
    final_request = requests[2]
    for request in requests:
        assert_provider_received_current_input(
            request,
            CLI_DELETE_PLAN_PROMPT,
        )
    require(
        provider_current_input_target_kind(replan_request) == "planning"
        and bool(provider_current_input_guidance(replan_request))
        and provider_request_exposes_tool(
            replan_request,
            SESSION_PLAN_PROPOSAL_TOOL_NAME,
        )
        and provider_current_input_target_kind(final_request) == "finalAnswer"
        and not final_request.get("tools"),
        "delete Plan rejection did not preserve the replan and no-tools finalAnswer boundaries",
    )

    host_run_id = read_cli_ask_host_run_identity(config_root, session_id)
    terminal_snapshot = canonical_run_snapshot(
        config_root,
        session_id,
        host_run_id,
    )
    require(
        terminal_snapshot.run_id == kernel_run_id,
        "delete Plan rejection changed the exact Kernel Run identity",
    )
    require_no_execution_fact_domains(
        config_root,
        kernel_run_id,
        "rejected delete Plan",
    )
    require_delete_plan_rejected_projection(
        read_agent_timeline(daemon, session_id)
    )
    require(
        target.is_file()
        and hashlib.sha256(target.read_bytes()).hexdigest() == before_digest,
        "rejected delete Plan changed or removed the test-owned file",
    )
    delete_session_and_require_private_storage_released(
        daemon,
        config_root,
        session_id,
    )
    target.unlink()
    require(
        not target.exists(),
        "delete Plan contract did not release its test-owned sentinel",
    )
    provider.require_healthy()


def read_stable_current_session_run_store(
    config_root: pathlib.Path,
    session_id: str,
    run_id: str,
) -> tuple[bytes, list[dict[str, Any]]]:
    run_digest = hashlib.sha256(run_id.encode("utf-8")).hexdigest()
    session_root = config_root / "sessions" / session_id
    require(
        not (session_root / "kernel-v3").exists(),
        "current Session created the rejected pre-cutover kernel-v3 directory",
    )
    path = (
        session_root
        / "kernel-v2"
        / "session-runs"
        / f"{run_digest}.jsonl"
    )
    try:
        before = path.stat()
        raw = path.read_bytes()
        after = path.stat()
        records = [json.loads(line.decode("utf-8")) for line in raw.splitlines()]
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise IntegrationFailure(
            f"current pure-v2 Session Run store is unavailable: {safe_diagnostic(error)}"
        ) from error
    require(
        before.st_size == after.st_size
        and before.st_mtime_ns == after.st_mtime_ns
        and raw.endswith(b"\n"),
        "retired pure-v2 Session Run store changed during its read-only snapshot",
    )
    require(
        records and all(isinstance(record, dict) for record in records),
        "pure-v2 Session Run store contains a non-object record",
    )
    return raw, records


def exact_tool_context_ref(value: Any) -> tuple[int, str, str]:
    require(
        isinstance(value, dict)
        and set(value) == {"contextVersion", "catalogDigest", "contextDigest"}
        and isinstance(value.get("contextVersion"), int)
        and value["contextVersion"] > 0
        and re.fullmatch(r"sha256:[0-9a-f]{64}", str(value.get("catalogDigest")))
        is not None
        and re.fullmatch(r"sha256:[0-9a-f]{64}", str(value.get("contextDigest")))
        is not None,
        "kernel-v3 record contains an invalid ToolContext reference",
    )
    return (
        value["contextVersion"],
        value["catalogDigest"],
        value["contextDigest"],
    )


def provider_trace_metadata_for_run(
    daemon: OwnedDaemon,
    session_id: str,
    run_id: str,
) -> dict[str, Any]:
    encoded_session_id = urllib.parse.quote(session_id, safe="")
    status, body = request_json(
        daemon.base_url,
        "GET",
        f"/api/host/provider-traces/{encoded_session_id}",
        host_capability=daemon.host_capability,
    )
    data = require_api_ok(status, body, "Provider trace metadata list")
    require(
        isinstance(data, dict)
        and data.get("schemaVersion") == "deepcode.provider-trace-metadata-list.v1"
        and data.get("sessionId") == session_id
        and isinstance(data.get("traces"), list),
        "Provider trace metadata list is invalid",
    )
    matching = [
        trace
        for trace in data["traces"]
        if isinstance(trace, dict) and trace.get("runId") == run_id
    ]
    require(len(matching) == 1, "Host Run did not produce one exact sealed Provider trace")
    return matching[0]


def host_run_open_restart_and_replay_preserve_exact_snapshot_dispatch_terminal_and_cleanup(
    daemon: OwnedDaemon,
    config_root: pathlib.Path,
    session_id: str,
    canonical_snapshot: CanonicalRunSnapshot,
) -> bytes:
    raw, records = read_stable_current_session_run_store(
        config_root,
        session_id,
        canonical_snapshot.run_id,
    )
    require(
        TEST_API_KEY.encode("utf-8") not in raw
        and daemon.host_capability.encode("utf-8") not in raw,
        "pure-v2 Session Run store leaked Provider or Host authority material",
    )
    for record in records:
        require(
            record.get("schemaVersion") == "deepcode.session.kernel-persistence-record.v3"
            and record.get("sessionId") == session_id
            and record.get("runId") == canonical_snapshot.run_id
            and isinstance(record.get("recordId"), str)
            and isinstance(record.get("recordKind"), str)
            and re.fullmatch(
                r"sha256:[0-9a-f]{64}", str(record.get("recordDigest"))
            )
            is not None,
            "pure-v2 Session Run store contains an invalid record envelope",
        )
    require(
        len(records) == len({record["recordId"] for record in records}),
        "pure-v2 Session Run store contains a duplicate immutable record identity",
    )
    require(
        len(records) >= 5
        and records[0]["recordKind"] == "storeHeader"
        and records[0]["recordId"]
        == f"session-kernel-v3:{canonical_snapshot.run_id}:store"
        and records[0]["data"]
        == {"schemaVersion": "deepcode.session.kernel-persistence.v3"}
        and records[1]["recordKind"] == "toolContextSnapshot",
        "RunOpen did not durably write storeHeader and initial ToolContext snapshot first",
    )
    tool_context_records = [
        (index, record)
        for index, record in enumerate(records)
        if record["recordKind"] == "toolContextSnapshot"
    ]
    require(
        tool_context_records and tool_context_records[0][0] == 1,
        "RunOpen initial ToolContext snapshot was missing or appended late",
    )
    snapshots_by_ref: dict[tuple[int, str, str], int] = {}
    for index, snapshot_record in tool_context_records:
        snapshot_data = snapshot_record.get("data")
        require(
            isinstance(snapshot_data, dict)
            and snapshot_data.get("schemaVersion")
            == "deepcode.session.tool-context-snapshot.v3"
            and snapshot_data.get("runId") == canonical_snapshot.run_id
            and isinstance(snapshot_data.get("toolContext"), dict),
            "ToolContext snapshot did not use the exact strict v3 envelope",
        )
        context_ref = snapshot_data.get("contextRef")
        context_identity = exact_tool_context_ref(context_ref)
        tool_context = snapshot_data["toolContext"]
        require(
            tool_context.get("formatVersion") == "deepcode.kernel.tool-context.v2"
            and exact_tool_context_ref(
                {
                    key: tool_context.get(key)
                    for key in ("contextVersion", "catalogDigest", "contextDigest")
                }
            )
            == context_identity
            and snapshot_record["recordId"]
            == (
                f"session-kernel-v3:{canonical_snapshot.run_id}:tool-context:"
                f"{context_identity[2]}"
            )
            and context_identity not in snapshots_by_ref,
            "ToolContext snapshot changed its exact bundle or immutable identity",
        )
        snapshots_by_ref[context_identity] = index

    checkpoint_indices = [
        index
        for index, record in enumerate(records)
        if record["recordKind"] == "checkpoint"
    ]
    dispatch_indices = [
        index
        for index, record in enumerate(records)
        if record["recordKind"] == "providerTurnDispatch"
    ]
    terminal_indices = [
        index
        for index, record in enumerate(records)
        if record["recordKind"] == "providerTurnTerminal"
    ]
    require(
        checkpoint_indices
        and len(dispatch_indices) == 1
        and len(terminal_indices) == 1
        and min(checkpoint_indices) > 1
        and 1 < dispatch_indices[0] < terminal_indices[0],
        "checkpoint, Provider dispatch, and terminal did not follow the initial snapshot",
    )
    checkpoint_contexts: dict[int, tuple[int, str, str]] = {}
    for index in checkpoint_indices:
        checkpoint = records[index].get("data")
        checkpoint_context = (
            checkpoint.get("authority", {}).get("toolContext", {}).get("currentRef")
            if isinstance(checkpoint, dict)
            else None
        )
        checkpoint_identity = exact_tool_context_ref(checkpoint_context)
        snapshot_index = snapshots_by_ref.get(checkpoint_identity)
        require(
            snapshot_index is not None and snapshot_index < index,
            "durable checkpoint did not bind a previously persisted ToolContext snapshot",
        )
        checkpoint_contexts[index] = checkpoint_identity

    dispatch_record = records[dispatch_indices[0]]
    terminal_record = records[terminal_indices[0]]
    dispatch = dispatch_record.get("data")
    terminal = terminal_record.get("data")
    require(
        isinstance(dispatch, dict)
        and dispatch.get("schemaVersion") == "deepcode.session.provider-turn-dispatch.v3"
        and isinstance(dispatch.get("providerTurnId"), str)
        and dispatch["providerTurnId"]
        and isinstance(dispatch.get("authorityBinding"), dict)
        and dispatch["authorityBinding"].get("runId") == canonical_snapshot.run_id
        and re.fullmatch(r"sha256:[0-9a-f]{64}", str(dispatch.get("requestDigest")))
        is not None,
        "Provider dispatch did not durably bind its exact Run authority and request",
    )
    provider_turn_id = dispatch["providerTurnId"]
    require(
        dispatch_record["recordId"]
        == (
            f"session-kernel-v3:{canonical_snapshot.run_id}:provider-turn:"
            f"{provider_turn_id}:dispatch"
        )
        and isinstance(terminal, dict)
        and terminal.get("schemaVersion") == "deepcode.session.provider-turn-terminal.v3"
        and terminal.get("providerTurnId") == provider_turn_id
        and terminal.get("authorityBinding") == dispatch["authorityBinding"]
        and terminal.get("dispatchRef")
        == {
            "recordId": dispatch_record["recordId"],
            "recordDigest": dispatch_record["recordDigest"],
        }
        and terminal.get("terminalKind") == "completed"
        and terminal_record["recordId"]
        == (
            f"session-kernel-v3:{canonical_snapshot.run_id}:provider-turn:"
            f"{provider_turn_id}:terminal"
        ),
        "Provider terminal did not bind its exact dispatch and completed identity",
    )
    trace_ref = terminal.get("traceRef")
    require(
        isinstance(trace_ref, dict)
        and re.fullmatch(r"sha256:[0-9a-f]{64}", str(trace_ref.get("sealDigest")))
        is not None
        and re.fullmatch(r"sha256:[0-9a-f]{64}", str(trace_ref.get("terminalDigest")))
        is not None
        and isinstance(trace_ref.get("recordCount"), int)
        and trace_ref["recordCount"] >= 3,
        "completed Provider terminal lost its sealed Trace reference",
    )
    matching_reservations: list[tuple[int, tuple[int, str, str]]] = []
    for index in checkpoint_indices:
        checkpoint = records[index]["data"]
        reservation = checkpoint.get("active", {}).get("providerReservation")
        if (
            isinstance(reservation, dict)
            and reservation.get("providerTurnId") == provider_turn_id
        ):
            reservation_identity = exact_tool_context_ref(reservation.get("contextRef"))
            require(
                reservation_identity == checkpoint_contexts[index],
                "Provider reservation changed its checkpoint ToolContext identity",
            )
            matching_reservations.append((index, reservation_identity))
    require(
        matching_reservations
        and any(
            snapshots_by_ref[context_identity] < index < dispatch_indices[0]
            for index, context_identity in matching_reservations
        ),
        "Provider admission lacked a prior durable reservation and ToolContext snapshot",
    )

    metadata = provider_trace_metadata_for_run(
        daemon,
        session_id,
        canonical_snapshot.run_id,
    )
    require(
        metadata.get("providerTurnId") == provider_turn_id
        and metadata.get("terminalKind") == "completed"
        and metadata.get("requestDigest") == dispatch.get("requestDigest")
        and metadata.get("sealDigest") == trace_ref.get("sealDigest")
        and metadata.get("terminalDigest") == trace_ref.get("terminalDigest")
        and metadata.get("recordCount") == trace_ref.get("recordCount"),
        "Provider Trace metadata does not prove the durable dispatch/terminal pair",
    )
    return raw


def validate_provider_trace_export(
    daemon: OwnedDaemon,
    config_root: pathlib.Path,
    session_id: str,
    run_id: str,
) -> dict[str, Any]:
    encoded_session_id = urllib.parse.quote(session_id, safe="")
    metadata = provider_trace_metadata_for_run(daemon, session_id, run_id)
    provider_turn_id = metadata.get("providerTurnId")
    trace_digest = metadata.get("sealDigest")
    require(
        isinstance(provider_turn_id, str)
        and provider_turn_id
        and isinstance(trace_digest, str)
        and re.fullmatch(r"sha256:[0-9a-f]{64}", trace_digest) is not None
        and metadata.get("terminalKind") == "completed"
        and isinstance(metadata.get("recordCount"), int)
        and metadata["recordCount"] >= 3,
        "Provider trace metadata omitted its completed seal identity",
    )

    encoded_provider_turn_id = urllib.parse.quote(provider_turn_id, safe="")
    trace_path = (
        f"/api/host/provider-traces/{encoded_session_id}/"
        f"{encoded_provider_turn_id}"
    )
    request_id = "request-provider-trace-host-integration"
    mint_payload = {
        "runId": run_id,
        "traceDigest": trace_digest,
        "requestId": request_id,
    }
    status, body = request_json(
        daemon.base_url,
        "POST",
        f"{trace_path}/export-capability",
        payload=mint_payload,
        host_capability=daemon.host_capability,
    )
    capability_data = require_api_ok(
        status,
        body,
        "Provider trace export capability mint",
    )
    capability = (
        capability_data.get("capability")
        if isinstance(capability_data, dict)
        else None
    )
    payload_digest = (
        capability_data.get("payloadDigest")
        if isinstance(capability_data, dict)
        else None
    )
    require(
        isinstance(capability, str)
        and capability.startswith("provider-trace-v1.")
        and isinstance(payload_digest, str)
        and re.fullmatch(r"sha256:[0-9a-f]{64}", payload_digest) is not None
        and capability_data.get("expiresInSeconds") == 60,
        "Provider trace export capability binding is invalid",
    )
    export_payload = {
        **mint_payload,
        "payloadDigest": payload_digest,
    }
    status, response_headers, trace_bytes = request_bytes(
        daemon.base_url,
        "POST",
        f"{trace_path}/export",
        payload=export_payload,
        host_capability=daemon.host_capability,
        extra_headers={PROVIDER_TRACE_CAPABILITY_HEADER: capability},
    )
    require(status == 200, f"Provider trace export returned HTTP {status}")
    require(
        response_headers.get("cache-control") == "no-store"
        and response_headers.get("x-content-type-options") == "nosniff"
        and response_headers.get(PROVIDER_TRACE_DIGEST_HEADER) == trace_digest,
        "Provider trace export omitted required safe response headers",
    )
    try:
        records = [
            json.loads(line.decode("utf-8"))
            for line in trace_bytes.splitlines()
            if line
        ]
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise IntegrationFailure("Provider trace export is not valid JSONL") from error
    record_kinds = [
        record.get("recordKind") if isinstance(record, dict) else None
        for record in records
    ]
    require(
        len(records) == metadata["recordCount"]
        and record_kinds[0] == "request"
        and "rawUpstreamEnvelope" in record_kinds
        and "normalizedEvent" in record_kinds
        and record_kinds[-2:] == ["terminal", "seal"],
        "Provider trace export lost its chronological chain boundaries",
    )
    for secret in (TEST_API_KEY, daemon.host_capability, capability):
        require(
            secret.encode("utf-8") not in trace_bytes,
            "Provider trace archive leaked transport authority material",
        )

    replay_status, replay_headers, replay_bytes = request_bytes(
        daemon.base_url,
        "POST",
        f"{trace_path}/export",
        payload=export_payload,
        host_capability=daemon.host_capability,
        extra_headers={PROVIDER_TRACE_CAPABILITY_HEADER: capability},
    )
    require(
        replay_status == 200
        and replay_headers.get(PROVIDER_TRACE_DIGEST_HEADER) == trace_digest
        and replay_bytes == trace_bytes,
        "Provider trace exact request replay changed its verified export",
    )

    conflicting_payload = {**export_payload, "requestId": f"{request_id}-conflict"}
    conflict_status, _, conflict_bytes = request_bytes(
        daemon.base_url,
        "POST",
        f"{trace_path}/export",
        payload=conflicting_payload,
        host_capability=daemon.host_capability,
        extra_headers={PROVIDER_TRACE_CAPABILITY_HEADER: capability},
    )
    try:
        conflict = json.loads(conflict_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise IntegrationFailure("Provider trace conflict returned invalid JSON") from error
    require(
        conflict_status == 400
        and isinstance(conflict, dict)
        and conflict.get("error") == "provider_trace_capability_conflict",
        "Provider trace capability accepted a different request identity",
    )

    audit_path = (
        config_root
        / "sessions"
        / ".host-management-v2"
        / "provider-trace-audit.jsonl"
    )
    require(audit_path.is_file(), "Provider trace metadata audit is missing")
    audit_bytes = audit_path.read_bytes()
    try:
        audit_records = [
            json.loads(line.decode("utf-8"))
            for line in audit_bytes.splitlines()
            if line
        ]
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise IntegrationFailure("Provider trace audit is not valid JSONL") from error
    allowed_audit_keys = {
        "schemaVersion",
        "recordedAt",
        "action",
        "sessionId",
        "runId",
        "providerTurnId",
        "requestId",
        "payloadDigest",
        "traceDigest",
        "resultCode",
    }
    require(
        audit_records
        and all(
            isinstance(record, dict)
            and set(record).issubset(allowed_audit_keys)
            for record in audit_records
        ),
        "Provider trace audit contains non-metadata fields",
    )
    successful_exports = [
        record
        for record in audit_records
        if record.get("action") == "export"
        and record.get("sessionId") == session_id
        and record.get("runId") == run_id
        and record.get("providerTurnId") == provider_turn_id
        and record.get("requestId") == request_id
        and record.get("resultCode") == PROVIDER_TRACE_EXPORT_RESULT_SUCCEEDED
    ]
    require(
        len(successful_exports) == 2,
        "Provider trace full export and exact replay lacked success audits",
    )
    for forbidden in (
        TEST_API_KEY,
        daemon.host_capability,
        capability,
        FINAL_TEXT,
        PROVIDER_REASONING,
    ):
        require(
            forbidden.encode("utf-8") not in audit_bytes,
            "Provider trace audit leaked body or authority material",
        )
    return {
        "path": trace_path,
        "payload": export_payload,
        "capability": capability,
        "metadata": metadata,
        "byteLength": len(trace_bytes),
    }


def provider_trace_audit_path(config_root: pathlib.Path) -> pathlib.Path:
    return (
        config_root
        / "sessions"
        / ".host-management-v2"
        / "provider-trace-audit.jsonl"
    )


def try_read_provider_trace_audit(
    config_root: pathlib.Path,
) -> list[dict[str, Any]] | None:
    path = provider_trace_audit_path(config_root)
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return None
    if raw and not raw.endswith(b"\n"):
        return None
    records: list[dict[str, Any]] = []
    try:
        for line in raw.splitlines():
            if not line:
                continue
            record = json.loads(line.decode("utf-8"))
            if not isinstance(record, dict):
                return None
            records.append(record)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return records


def require_provider_trace_audit_snapshot(
    config_root: pathlib.Path,
) -> list[dict[str, Any]]:
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        records = try_read_provider_trace_audit(config_root)
        if records is not None:
            return records
        time.sleep(0.02)
    raise IntegrationFailure("Provider trace audit did not reach a complete JSONL boundary")


def require_provider_trace_audit_is_metadata_only(
    config_root: pathlib.Path,
    daemon: OwnedDaemon,
    extra_capabilities: list[str],
) -> None:
    audit_path = provider_trace_audit_path(config_root)
    records = require_provider_trace_audit_snapshot(config_root)
    allowed_audit_keys = {
        "schemaVersion",
        "recordedAt",
        "action",
        "sessionId",
        "runId",
        "providerTurnId",
        "requestId",
        "payloadDigest",
        "traceDigest",
        "resultCode",
    }
    require(
        records
        and all(set(record).issubset(allowed_audit_keys) for record in records),
        "Provider trace audit contains non-metadata fields",
    )
    audit_bytes = audit_path.read_bytes()
    forbidden_values = [
        TEST_API_KEY,
        daemon.host_capability,
        FINAL_TEXT,
        PROVIDER_REASONING,
        *extra_capabilities,
    ]
    for forbidden in forbidden_values:
        require(
            not forbidden or forbidden.encode("utf-8") not in audit_bytes,
            "Provider trace audit leaked body or authority material",
        )


def wait_for_provider_trace_export_audit(
    config_root: pathlib.Path,
    *,
    after_record_count: int,
    session_id: str,
    export: dict[str, Any],
    result_code: str,
    timeout: float,
) -> tuple[dict[str, Any], float]:
    metadata = export.get("metadata")
    payload = export.get("payload")
    require(
        isinstance(metadata, dict) and isinstance(payload, dict),
        "Provider trace export audit identity is incomplete",
    )
    run_id = metadata.get("runId")
    provider_turn_id = metadata.get("providerTurnId")
    request_id = payload.get("requestId")
    payload_digest = payload.get("payloadDigest")
    trace_digest = metadata.get("sealDigest")
    require(
        all(
            isinstance(value, str) and value
            for value in (
                run_id,
                provider_turn_id,
                request_id,
                payload_digest,
                trace_digest,
            )
        ),
        "Provider trace export audit identity omitted a bound field",
    )
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        records = try_read_provider_trace_audit(config_root)
        if records is not None and len(records) >= after_record_count:
            for record in records[after_record_count:]:
                if (
                    record.get("action") == "export"
                    and record.get("sessionId") == session_id
                    and record.get("runId") == run_id
                    and record.get("providerTurnId") == provider_turn_id
                    and record.get("requestId") == request_id
                    and record.get("payloadDigest") == payload_digest
                    and record.get("traceDigest") == trace_digest
                    and record.get("resultCode") == result_code
                ):
                    return record, time.monotonic()
        time.sleep(0.05)
    raise IntegrationFailure(
        "Provider trace export audit did not record "
        f"{result_code} for {request_id}"
    )


def mint_provider_trace_export(
    daemon: OwnedDaemon,
    replay: dict[str, Any],
    request_id: str,
) -> dict[str, Any]:
    metadata = replay.get("metadata")
    require(isinstance(metadata, dict), "Provider trace replay omitted metadata")
    run_id = metadata.get("runId")
    trace_digest = metadata.get("sealDigest")
    require(
        isinstance(run_id, str)
        and run_id
        and isinstance(trace_digest, str)
        and re.fullmatch(r"sha256:[0-9a-f]{64}", trace_digest) is not None,
        "Provider trace replay metadata omitted its immutable identity",
    )
    mint_payload = {
        "runId": run_id,
        "traceDigest": trace_digest,
        "requestId": request_id,
    }
    mint_started = time.monotonic()
    status, body = request_json(
        daemon.base_url,
        "POST",
        f"{replay['path']}/export-capability",
        payload=mint_payload,
        host_capability=daemon.host_capability,
    )
    mint_completed = time.monotonic()
    data = require_api_ok(status, body, "Provider trace resource capability mint")
    capability = data.get("capability") if isinstance(data, dict) else None
    payload_digest = data.get("payloadDigest") if isinstance(data, dict) else None
    require(
        isinstance(capability, str)
        and capability.startswith("provider-trace-v1.")
        and isinstance(payload_digest, str)
        and re.fullmatch(r"sha256:[0-9a-f]{64}", payload_digest) is not None
        and data.get("expiresInSeconds") == 60,
        "Provider trace resource capability binding is invalid",
    )
    return {
        "path": replay["path"],
        "payload": {**mint_payload, "payloadDigest": payload_digest},
        "capability": capability,
        "metadata": metadata,
        "mintStarted": mint_started,
        "mintCompleted": mint_completed,
    }


def require_provider_trace_export_session_busy(
    daemon: OwnedDaemon,
    config_root: pathlib.Path,
    session_id: str,
    export: dict[str, Any],
    *,
    after_record_count: int,
) -> None:
    status, _, raw = request_bytes(
        daemon.base_url,
        "POST",
        f"{export['path']}/export",
        payload=export["payload"],
        host_capability=daemon.host_capability,
        extra_headers={
            PROVIDER_TRACE_CAPABILITY_HEADER: export["capability"],
        },
    )
    try:
        body = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise IntegrationFailure(
            "Concurrent Provider trace export returned invalid JSON"
        ) from error
    require(
        status == 409
        and isinstance(body, dict)
        and body.get("error") == "provider_trace_export_session_busy",
        "Concurrent Provider trace export did not fail immediately with typed Session busy",
    )
    wait_for_provider_trace_export_audit(
        config_root,
        after_record_count=after_record_count,
        session_id=session_id,
        export=export,
        result_code="provider_trace_export_session_busy",
        timeout=5.0,
    )


def complete_provider_trace_export(
    daemon: OwnedDaemon,
    config_root: pathlib.Path,
    session_id: str,
    export: dict[str, Any],
) -> bytes:
    before = require_provider_trace_audit_snapshot(config_root)
    status, headers, raw = request_bytes(
        daemon.base_url,
        "POST",
        f"{export['path']}/export",
        payload=export["payload"],
        host_capability=daemon.host_capability,
        extra_headers={
            PROVIDER_TRACE_CAPABILITY_HEADER: export["capability"],
        },
        timeout=20.0,
    )
    trace_digest = export["metadata"]["sealDigest"]
    require(
        status == 200
        and headers.get(PROVIDER_TRACE_DIGEST_HEADER) == trace_digest
        and raw,
        "Provider trace sequential export did not fully deliver",
    )
    wait_for_provider_trace_export_audit(
        config_root,
        after_record_count=len(before),
        session_id=session_id,
        export=export,
        result_code=PROVIDER_TRACE_EXPORT_RESULT_SUCCEEDED,
        timeout=5.0,
    )
    return raw


def wait_until_monotonic(target: float) -> None:
    while True:
        remaining = target - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(remaining, 0.1))


def load_real_provider_trace_replay(
    daemon: OwnedDaemon,
    session_id: str,
    run_id: str,
) -> dict[str, Any]:
    encoded_session_id = urllib.parse.quote(session_id, safe="")
    status, body = request_json(
        daemon.base_url,
        "GET",
        f"/api/host/provider-traces/{encoded_session_id}",
        host_capability=daemon.host_capability,
    )
    data = require_api_ok(status, body, "Provider trace capacity metadata list")
    require(
        isinstance(data, dict)
        and data.get("schemaVersion") == "deepcode.provider-trace-metadata-list.v1"
        and data.get("sessionId") == session_id
        and isinstance(data.get("traces"), list),
        "Provider trace capacity metadata list is invalid",
    )
    matching = [
        trace
        for trace in data["traces"]
        if isinstance(trace, dict) and trace.get("runId") == run_id
    ]
    require(
        len(matching) == 1,
        "Provider trace capacity Session did not produce one exact sealed trace",
    )
    metadata = matching[0]
    provider_turn_id = metadata.get("providerTurnId")
    trace_digest = metadata.get("sealDigest")
    require(
        isinstance(provider_turn_id, str)
        and provider_turn_id
        and isinstance(trace_digest, str)
        and re.fullmatch(r"sha256:[0-9a-f]{64}", trace_digest) is not None
        and metadata.get("terminalKind") == "completed"
        and isinstance(metadata.get("rawSourceBytes"), int)
        and metadata["rawSourceBytes"] >= 512 * 1024,
        "Provider trace capacity test requires a real sealed backpressured archive",
    )
    return {
        "path": (
            f"/api/host/provider-traces/{encoded_session_id}/"
            f"{urllib.parse.quote(provider_turn_id, safe='')}"
        ),
        "metadata": metadata,
    }


def create_real_provider_trace_for_capacity(
    daemon: OwnedDaemon,
    config_root: pathlib.Path,
    workspace: pathlib.Path,
    session_id: str,
    ordinal: int,
) -> dict[str, Any]:
    prompt = f"{CLI_PROMPT} Capacity trace {ordinal}."
    cli_ask = run_cli(
        daemon.base_url,
        daemon.host_capability,
        [
            "--print",
            "--session",
            session_id,
            "--workspace",
            str(workspace),
            "ask",
            prompt,
        ],
        expect_success=True,
    )
    require(
        cli_ask.stdout.strip() == FINAL_TEXT,
        "Provider trace capacity Session did not complete its real CLI turn",
    )
    host_run_id = read_cli_ask_host_run_identity(config_root, session_id)
    snapshot = canonical_run_snapshot(config_root, session_id, host_run_id)
    replay = load_real_provider_trace_replay(
        daemon,
        session_id,
        snapshot.run_id,
    )
    return replay


def provider_trace_daemon_capacity_releases_owned_resources(
    daemon: OwnedDaemon,
    config_root: pathlib.Path,
    workspace: pathlib.Path,
) -> list[str]:
    session_ids: list[str] = []
    replays: list[dict[str, Any]] = []
    held_exports: list[tuple[str, dict[str, Any], HeldProviderTraceExport]] = []
    capabilities: list[str] = []
    primary_error: BaseException | None = None
    cleanup_errors: list[str] = []
    try:
        for ordinal in range(1, 10):
            session_id = create_session(daemon)
            session_ids.append(session_id)
            replay = create_real_provider_trace_for_capacity(
                daemon,
                config_root,
                workspace,
                session_id,
                ordinal,
            )
            replays.append(replay)
        require(
            len(set(session_ids)) == 9
            and len({replay["metadata"]["providerTurnId"] for replay in replays}) == 9
            and len({replay["metadata"]["sealDigest"] for replay in replays}) == 9,
            "Provider trace capacity test did not create nine distinct real traces",
        )

        exports = [
            mint_provider_trace_export(
                daemon,
                replay,
                f"request-provider-trace-daemon-capacity-{ordinal}",
            )
            for ordinal, replay in enumerate(replays, start=1)
        ]
        capabilities.extend(export["capability"] for export in exports)
        capacity_audit = require_provider_trace_audit_snapshot(config_root)
        for session_id, export in zip(session_ids[:8], exports[:8]):
            held_exports.append(
                (
                    session_id,
                    export,
                    open_unconsumed_provider_trace_export(
                        daemon,
                        export["path"],
                        export["payload"],
                        export["capability"],
                        export["metadata"]["sealDigest"],
                    ),
                )
            )

        capacity_export = exports[8]
        status, _, raw = request_bytes(
            daemon.base_url,
            "POST",
            f"{capacity_export['path']}/export",
            payload=capacity_export["payload"],
            host_capability=daemon.host_capability,
            extra_headers={
                PROVIDER_TRACE_CAPABILITY_HEADER: capacity_export["capability"],
            },
        )
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise IntegrationFailure(
                "Provider trace daemon capacity rejection returned invalid JSON"
            ) from error
        require(
            status == 409
            and isinstance(body, dict)
            and body.get("error") == "provider_trace_export_capacity_exceeded",
            "Ninth Provider trace export did not fail with typed daemon capacity",
        )
        wait_for_provider_trace_export_audit(
            config_root,
            after_record_count=len(capacity_audit),
            session_id=session_ids[8],
            export=capacity_export,
            result_code="provider_trace_export_capacity_exceeded",
            timeout=5.0,
        )

        for _, _, held in held_exports:
            held.close()
        for session_id, export, _ in held_exports:
            wait_for_provider_trace_export_audit(
                config_root,
                after_record_count=len(capacity_audit),
                session_id=session_id,
                export=export,
                result_code=PROVIDER_TRACE_EXPORT_RESULT_RECEIVER_CLOSED,
                timeout=10.0,
            )
        held_exports.clear()

        post_capacity = mint_provider_trace_export(
            daemon,
            replays[8],
            "request-provider-trace-after-daemon-capacity",
        )
        capabilities.append(post_capacity["capability"])
        require(
            complete_provider_trace_export(
                daemon,
                config_root,
                session_ids[8],
                post_capacity,
            ),
            "Provider trace daemon capacity permits were not released",
        )
    except BaseException as error:
        primary_error = error
    finally:
        for _, _, held in held_exports:
            try:
                held.close()
            except BaseException as error:
                cleanup_errors.append(
                    f"capacity export close: {safe_diagnostic(error)}"
                )
        for session_id in reversed(session_ids):
            try:
                delete_session_and_require_private_storage_released(
                    daemon,
                    config_root,
                    session_id,
                )
            except BaseException as error:
                cleanup_errors.append(
                    f"capacity Session {session_id} cleanup: {safe_diagnostic(error)}"
                )
    if primary_error is not None:
        if cleanup_errors:
            raise IntegrationFailure(
                f"{safe_diagnostic(primary_error)}; " + "; ".join(cleanup_errors)
            ) from primary_error
        raise primary_error.with_traceback(primary_error.__traceback__)
    require(
        not cleanup_errors,
        "Provider trace daemon capacity cleanup failed: " + "; ".join(cleanup_errors),
    )
    return capabilities


def provider_trace_export_deadline_and_concurrency_release_owned_resources(
    daemon: OwnedDaemon,
    config_root: pathlib.Path,
    session_id: str,
    replay: dict[str, Any],
    workspace: pathlib.Path,
) -> list[str]:
    require(
        isinstance(replay.get("byteLength"), int)
        and replay["byteLength"] >= 2 * 1024 * 1024,
        "Provider trace resource test requires a real backpressured archive",
    )
    trace_digest = replay["metadata"]["sealDigest"]
    capabilities: list[str] = []

    dropped = mint_provider_trace_export(
        daemon,
        replay,
        "request-provider-trace-drop-resource",
    )
    drop_busy = mint_provider_trace_export(
        daemon,
        replay,
        "request-provider-trace-drop-session-busy",
    )
    require(
        dropped["payload"]["requestId"] != drop_busy["payload"]["requestId"]
        and dropped["capability"] != drop_busy["capability"],
        "Provider trace Session busy check requires a separately minted request",
    )
    capabilities.extend([dropped["capability"], drop_busy["capability"]])
    drop_audit = require_provider_trace_audit_snapshot(config_root)
    held_drop = open_unconsumed_provider_trace_export(
        daemon,
        dropped["path"],
        dropped["payload"],
        dropped["capability"],
        trace_digest,
    )
    try:
        require_provider_trace_export_session_busy(
            daemon,
            config_root,
            session_id,
            drop_busy,
            after_record_count=len(drop_audit),
        )
    finally:
        held_drop.close()
    wait_for_provider_trace_export_audit(
        config_root,
        after_record_count=len(drop_audit),
        session_id=session_id,
        export=dropped,
        result_code=PROVIDER_TRACE_EXPORT_RESULT_RECEIVER_CLOSED,
        timeout=10.0,
    )
    require(
        len(complete_provider_trace_export(
            daemon,
            config_root,
            session_id,
            dropped,
        ))
        == replay["byteLength"],
        "Provider trace drop did not release its owned export resources",
    )

    deadline_export = mint_provider_trace_export(
        daemon,
        replay,
        "request-provider-trace-deadline-resource",
    )
    deadline_busy = mint_provider_trace_export(
        daemon,
        replay,
        "request-provider-trace-deadline-session-busy",
    )
    require(
        deadline_export["payload"]["requestId"]
        != deadline_busy["payload"]["requestId"]
        and deadline_export["capability"] != deadline_busy["capability"],
        "Provider trace deadline busy check requires a separately minted request",
    )
    capabilities.extend(
        [deadline_export["capability"], deadline_busy["capability"]]
    )
    wait_until_monotonic(deadline_export["mintCompleted"] + 15.0)
    deadline_audit = require_provider_trace_audit_snapshot(config_root)
    export_started = time.monotonic()
    held_deadline = open_unconsumed_provider_trace_export(
        daemon,
        deadline_export["path"],
        deadline_export["payload"],
        deadline_export["capability"],
        trace_digest,
    )
    try:
        require_provider_trace_export_session_busy(
            daemon,
            config_root,
            session_id,
            deadline_busy,
            after_record_count=len(deadline_audit),
        )
        _, deadline_observed = wait_for_provider_trace_export_audit(
            config_root,
            after_record_count=len(deadline_audit),
            session_id=session_id,
            export=deadline_export,
            result_code=PROVIDER_TRACE_EXPORT_RESULT_DEADLINE_EXCEEDED,
            timeout=60.0,
        )
    finally:
        held_deadline.close()
    require(
        58.0
        <= deadline_observed - deadline_export["mintStarted"]
        <= 66.0
        and 57.0
        <= deadline_observed - deadline_export["mintCompleted"]
        <= 65.0
        and 40.0 <= deadline_observed - export_started <= 52.0,
        "Provider trace Body deadline was not bound to capability remaining TTL",
    )

    after_deadline = mint_provider_trace_export(
        daemon,
        replay,
        "request-provider-trace-after-deadline",
    )
    capabilities.append(after_deadline["capability"])
    require(
        len(complete_provider_trace_export(
            daemon,
            config_root,
            session_id,
            after_deadline,
        ))
        == replay["byteLength"],
        "Provider trace deadline did not release its owned export resources",
    )
    capabilities.extend(
        provider_trace_daemon_capacity_releases_owned_resources(
            daemon,
            config_root,
            workspace,
        )
    )
    return capabilities


def append_profile_availability_fixture(
    config_root: pathlib.Path,
    profile_id: str,
    profile_revision: str,
) -> pathlib.Path:
    require(
        isinstance(profile_id, str) and profile_id,
        "Profile availability fixture requires a Profile id",
    )
    require(
        re.fullmatch(r"sha256:[0-9a-f]{64}", profile_revision) is not None,
        "Profile availability fixture requires an exact revision digest",
    )
    availability_dir = config_root / "sessions" / ".host-management-v2"
    availability_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    availability_path = availability_dir / "provider-profile-availability.jsonl"
    record = {
        "schemaVersion": "deepcode.provider-profile-availability.v1",
        "recordedAt": str(int(time.time() * 1000)),
        "profileId": profile_id,
        "profileRevision": profile_revision,
        "state": "unavailable",
        "reasonCode": "host_v2_integration_quarantine_fixture",
    }
    encoded = json.dumps(record, separators=(",", ":")).encode("utf-8") + b"\n"
    descriptor = os.open(
        availability_path,
        os.O_APPEND | os.O_CREAT | os.O_WRONLY,
        0o600,
    )
    try:
        offset = 0
        while offset < len(encoded):
            written = os.write(descriptor, encoded[offset:])
            require(written > 0, "Provider Profile availability fixture append stalled")
            offset += written
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.chmod(availability_path, 0o600)
    return availability_path


def read_profile_availability_records(path: pathlib.Path) -> list[dict[str, Any]]:
    require(path.is_file(), "Provider Profile availability ledger is missing")
    try:
        records = [
            json.loads(line.decode("utf-8"))
            for line in path.read_bytes().splitlines()
            if line
        ]
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise IntegrationFailure(
            "Provider Profile availability ledger is not valid JSONL"
        ) from error
    require(
        all(isinstance(record, dict) for record in records),
        "Provider Profile availability ledger contains a non-object record",
    )
    return records


def latest_profile_availability_state(
    records: list[dict[str, Any]],
    profile_id: str,
    profile_revision: str,
) -> str | None:
    state = None
    for record in records:
        if (
            record.get("profileId") == profile_id
            and record.get("profileRevision") == profile_revision
        ):
            state = record.get("state")
    require(
        state is None or state in {"available", "unavailable"},
        "Provider Profile availability ledger contains an invalid state",
    )
    return state


def profile_from_settings(data: Any, profile_id: str) -> dict[str, Any]:
    require(
        isinstance(data, dict) and isinstance(data.get("profiles"), list),
        "LLM Profile settings response is invalid",
    )
    matching = [
        profile
        for profile in data["profiles"]
        if isinstance(profile, dict) and profile.get("id") == profile_id
    ]
    require(len(matching) == 1, "LLM Profile settings omitted the exact Profile")
    return matching[0]


def provider_profile_quarantine_requires_explicit_reenable_intent(
    daemon: OwnedDaemon,
    config_root: pathlib.Path,
    trace_metadata: Any,
) -> None:
    require(
        isinstance(trace_metadata, dict),
        "Provider trace metadata is unavailable for Profile quarantine validation",
    )
    profile_id = trace_metadata.get("profileId")
    profile_revision = trace_metadata.get("profileRevision")
    require(
        isinstance(profile_id, str)
        and profile_id
        and isinstance(profile_revision, str)
        and re.fullmatch(r"sha256:[0-9a-f]{64}", profile_revision) is not None,
        "Provider trace metadata omitted its exact Profile revision",
    )

    status, body = request_json(
        daemon.base_url,
        "GET",
        "/api/llm/profiles",
        host_capability=daemon.host_capability,
    )
    stale_settings = require_api_ok(status, body, "LLM Profile settings before quarantine")
    stale_profile = profile_from_settings(stale_settings, profile_id)
    require(
        stale_profile.get("enabled") is True
        and stale_settings.get("defaultProfileId") == profile_id,
        "Provider trace Profile was not the effective Profile before quarantine",
    )
    stale_patch = {
        "profiles": stale_settings["profiles"],
        "defaultProfileId": stale_settings.get("defaultProfileId"),
    }

    alternate_revision = authority_value("sha256:", "d")
    unrelated_profile_id = "host-v2-integration-unrelated-profile"
    unrelated_revision = authority_value("sha256:", "e")
    require(
        profile_revision not in {alternate_revision, unrelated_revision},
        "Profile quarantine fixture revisions unexpectedly overlap",
    )
    availability_path = append_profile_availability_fixture(
        config_root,
        profile_id,
        profile_revision,
    )
    append_profile_availability_fixture(
        config_root,
        profile_id,
        alternate_revision,
    )
    append_profile_availability_fixture(
        config_root,
        unrelated_profile_id,
        unrelated_revision,
    )
    quarantined_records = read_profile_availability_records(availability_path)

    status, body = request_json(
        daemon.base_url,
        "GET",
        "/api/llm/profiles",
        host_capability=daemon.host_capability,
    )
    quarantined_settings = require_api_ok(
        status,
        body,
        "LLM Profile settings after quarantine",
    )
    require(
        profile_from_settings(quarantined_settings, profile_id).get("enabled") is False
        and quarantined_settings.get("defaultProfileId") == profile_id,
        "Quarantine changed the stored default identity or left the Profile effectively enabled",
    )

    status, body = request_json(
        daemon.base_url,
        "PATCH",
        "/api/llm/profiles",
        payload=stale_patch,
        host_capability=daemon.host_capability,
    )
    stale_result = require_api_ok(
        status,
        body,
        "Stale LLM Profile full-array save without re-enable intent",
    )
    require(
        profile_from_settings(stale_result, profile_id).get("enabled") is False
        and stale_result.get("defaultProfileId") == profile_id,
        "Stale full-array save cleared Profile quarantine without explicit intent",
    )
    records_after_stale_patch = read_profile_availability_records(availability_path)
    require(
        records_after_stale_patch == quarantined_records
        and latest_profile_availability_state(
            records_after_stale_patch,
            profile_id,
            profile_revision,
        )
        == "unavailable",
        "Save without re-enable intent changed the Profile availability ledger",
    )

    status, body = request_json(
        daemon.base_url,
        "PATCH",
        "/api/llm/profiles",
        payload={**stale_patch, "reenableProfileIds": [profile_id]},
        host_capability=daemon.host_capability,
    )
    reenabled_result = require_api_ok(
        status,
        body,
        "Explicit LLM Profile revision re-enable",
    )
    require(
        profile_from_settings(reenabled_result, profile_id).get("enabled") is True
        and reenabled_result.get("defaultProfileId") == profile_id,
        "Explicit re-enable did not restore the exact Profile revision",
    )

    final_records = read_profile_availability_records(availability_path)
    require(
        len(final_records) == len(quarantined_records) + 1
        and latest_profile_availability_state(
            final_records,
            profile_id,
            profile_revision,
        )
        == "available"
        and latest_profile_availability_state(
            final_records,
            profile_id,
            alternate_revision,
        )
        == "unavailable"
        and latest_profile_availability_state(
            final_records,
            unrelated_profile_id,
            unrelated_revision,
        )
        == "unavailable",
        "Explicit re-enable changed an unlisted Profile id or revision",
    )
    last_record = final_records[-1]
    require(
        last_record.get("profileId") == profile_id
        and last_record.get("profileRevision") == profile_revision
        and last_record.get("state") == "available"
        and last_record.get("reasonCode") == "user_profile_revision_saved",
        "Explicit re-enable availability fact did not bind the exact incoming Profile",
    )

    status, body = request_json(
        daemon.base_url,
        "GET",
        "/api/llm/profiles",
        host_capability=daemon.host_capability,
    )
    effective_settings = require_api_ok(
        status,
        body,
        "LLM Profile settings after explicit re-enable",
    )
    require(
        profile_from_settings(effective_settings, profile_id).get("enabled") is True
        and effective_settings.get("defaultProfileId") == profile_id,
        "Re-enabled exact Profile revision was not restored to effective selection",
    )


def require_provider_trace_capability_invalid_after_restart(
    daemon: OwnedDaemon,
    replay: dict[str, Any],
) -> None:
    status, _, raw = request_bytes(
        daemon.base_url,
        "POST",
        f"{replay['path']}/export",
        payload=replay["payload"],
        host_capability=daemon.host_capability,
        extra_headers={
            PROVIDER_TRACE_CAPABILITY_HEADER: replay["capability"],
        },
    )
    try:
        body = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise IntegrationFailure(
            "Restarted Provider trace capability check returned invalid JSON"
        ) from error
    require(
        status == 400
        and isinstance(body, dict)
        and body.get("error") == "provider_trace_capability_invalid",
        "Provider trace export capability survived daemon restart",
    )


def canonical_failure_diagnostics(config_root: pathlib.Path) -> str:
    database = kernel_fact_store(config_root)
    if not database.is_file():
        return "canonicalStore=missing"
    try:
        with sqlite3.connect(
            f"file:{database}?mode=ro",
            uri=True,
            timeout=5.0,
        ) as connection:
            facts = connection.execute(
                "SELECT ledger_sequence, envelope_json "
                "FROM kernel_facts ORDER BY ledger_sequence"
            ).fetchall()
            authority_material = connection.execute(
                "SELECT material_kind, control_epoch, lifecycle "
                "FROM authority_material ORDER BY material_kind, material_id"
            ).fetchall()
    except sqlite3.Error as error:
        return f"canonicalDiagnostics={safe_diagnostic(error)}"
    fact_kinds: list[str] = []
    for sequence, envelope_json in facts:
        try:
            envelope = json.loads(envelope_json)
            kind = envelope["payload"]["fact"]["kind"]
        except (KeyError, TypeError, json.JSONDecodeError):
            kind = "unknown"
        fact_kinds.append(f"{sequence}:{kind}")
    material_summary = ",".join(
        f"{kind}@{epoch}:{lifecycle}"
        for kind, epoch, lifecycle in authority_material
    )
    return safe_diagnostic(
        f"canonicalFacts=[{','.join(fact_kinds)}] "
        f"authorityMaterial=[{material_summary}]"
    )


def open_host_run(
    daemon: OwnedDaemon,
    session_id: str,
    config_root: pathlib.Path,
    request_payload: dict[str, Any],
) -> dict[str, Any]:
    status, body = request_json(
        daemon.base_url,
        "POST",
        f"/api/agent/sessions/{session_id}/runs",
        payload=request_payload,
        host_capability=daemon.host_capability,
        timeout=45.0,
    )
    try:
        data = require_api_ok(status, body, "Host-owned RunOpen")
    except IntegrationFailure as error:
        raise IntegrationFailure(
            f"{safe_diagnostic(error, daemon.host_capability)}; "
            f"{canonical_failure_diagnostics(config_root)}"
        ) from error
    require(isinstance(data, dict), "Host-owned RunOpen returned invalid data")
    run = data.get("run")
    require(isinstance(run, dict), "Host-owned RunOpen omitted the public Run")
    host_run_id = run.get("runId")
    require(
        isinstance(host_run_id, str) and host_run_id,
        "Host-owned RunOpen omitted its exact Host Run identity",
    )
    deadline = time.monotonic() + 45.0
    while run.get("status") == "running":
        require(
            time.monotonic() < deadline,
            "Host-owned Run remained running after its controlled Provider turn",
        )
        time.sleep(0.05)
        status, body = request_json(
            daemon.base_url,
            "GET",
            f"/api/agent/sessions/{urllib.parse.quote(session_id, safe='')}/runs/"
            f"{urllib.parse.quote(host_run_id, safe='')}",
            host_capability=daemon.host_capability,
            timeout=5.0,
        )
        polled = require_api_ok(status, body, "Host-owned Run reconciliation")
        require(
            isinstance(polled, dict) and isinstance(polled.get("run"), dict),
            "Host-owned Run reconciliation omitted the public Run",
        )
        run = polled["run"]
        require(
            run.get("runId") == host_run_id
            and run.get("sessionId") == session_id,
            "Host-owned Run reconciliation changed its exact identity",
        )
    observed = safe_diagnostic(
        json.dumps(
            {
                "status": run.get("status"),
                "message": run.get("message"),
            },
            separators=(",", ":"),
        ),
        daemon.host_capability,
    )
    require(
        run.get("status") == "completed",
        f"Host-owned Run did not complete: {observed}",
    )
    kernel_run_id = run.get("kernelRunId")
    require(
        isinstance(kernel_run_id, str) and kernel_run_id,
        "completed Host-owned Run omitted its exact Kernel Run identity",
    )
    status, body = request_json(
        daemon.base_url,
        "GET",
        f"/api/agent/sessions/{urllib.parse.quote(session_id, safe='')}/timeline",
        host_capability=daemon.host_capability,
    )
    timeline = require_api_ok(status, body, "Host-owned Run Shared Projection")
    require(
        isinstance(timeline, dict)
        and timeline.get("schemaVersion")
        == "deepcode.shared-conversation-projection.v2"
        and timeline.get("shapeVersion")
        == "deepcode.shared-conversation.work-segments.v2"
        and isinstance(timeline.get("runProjection"), dict)
        and timeline["runProjection"].get("runId") == kernel_run_id
        and timeline["runProjection"].get("status") == "succeeded",
        "completed Host-owned Run did not reconcile to its terminal typed Shared Projection",
    )
    turn_id = timeline["runProjection"].get("turnId")
    turns = timeline.get("turns")
    turn = next(
        (
            candidate
            for candidate in turns
            if isinstance(candidate, dict) and candidate.get("id") == turn_id
        ),
        None,
    ) if isinstance(turns, list) else None
    blocks = turn.get("blocks") if isinstance(turn, dict) else None
    committed_finals = [
        block
        for block in blocks
        if isinstance(block, dict)
        and block.get("kind") == "assistant"
        and block.get("entryRole") == "finalAnswer"
        and "providerPhase" not in block
        and block.get("durability") == "committed"
        and block.get("status") == "completed"
        and block.get("bodyMarkdown") == FINAL_TEXT
    ] if isinstance(blocks, list) else []
    require(
        len(committed_finals) == 1,
        "completed Host-owned Run lost its one committed finalAnswer in Shared Projection",
    )
    return run


def inspect_workspace_public_path(daemon: OwnedDaemon, workspace: pathlib.Path) -> None:
    status, body = request_json(
        daemon.base_url,
        "POST",
        "/api/workspaces/open",
        payload={"path": str(workspace)},
        host_capability=daemon.host_capability,
    )
    data = require_api_ok(status, body, "Host workspace open")
    require(isinstance(data, dict), "Host workspace open returned invalid data")
    spec = data.get("workspace")
    require(isinstance(spec, dict), "Host workspace open omitted the workspace")
    require(
        pathlib.Path(str(spec.get("rootPath"))).resolve() == workspace.resolve(),
        "Host workspace resolution changed the canonical root",
    )
    folders = spec.get("folders")
    require(
        isinstance(folders, list)
        and len(folders) == 1
        and pathlib.Path(str(folders[0].get("absolutePath"))).resolve()
        == workspace.resolve(),
        "Host workspace folder binding did not preserve the canonical root",
    )


def validated_owner_paths(
    run_root_argument: str | None = None,
    registry_argument: str | None = None,
) -> tuple[pathlib.Path, OwnerRegistry]:
    run_root_text = os.environ.get("DEEPCODE_HOST_V2_RUN_ROOT", "")
    registry_text = os.environ.get("DEEPCODE_HOST_V2_OWNER_PGIDS", "")
    require(run_root_text and registry_text, "shell owner guard is missing")
    if run_root_argument is not None or registry_argument is not None:
        require(
            run_root_argument is not None
            and registry_argument is not None
            and pathlib.Path(run_root_argument).resolve(strict=True)
            == pathlib.Path(run_root_text).resolve(strict=True)
            and pathlib.Path(registry_argument).resolve(strict=True)
            == pathlib.Path(registry_text).resolve(strict=True),
            "cleanup arguments do not match the exact shell owner guard",
        )
    raw_run_root = pathlib.Path(run_root_text)
    raw_registry = pathlib.Path(registry_text)
    try:
        run_lstat = raw_run_root.lstat()
        registry_lstat = raw_registry.lstat()
        run_root = raw_run_root.resolve(strict=True)
        registry_path = raw_registry.resolve(strict=True)
    except OSError as error:
        raise IntegrationFailure(
            f"shell owner guard paths are unavailable: {safe_diagnostic(error)}"
        ) from error
    require(
        stat.S_ISDIR(run_lstat.st_mode)
        and not raw_run_root.is_symlink()
        and run_lstat.st_uid == os.geteuid()
        and stat.S_IMODE(run_lstat.st_mode) == 0o700
        and run_root.name.startswith("deepcode-host-v2-run."),
        "shell owner run root identity, owner, or permissions are invalid",
    )
    require(
        stat.S_ISREG(registry_lstat.st_mode)
        and not raw_registry.is_symlink()
        and registry_lstat.st_uid == os.geteuid()
        and stat.S_IMODE(registry_lstat.st_mode) == 0o600
        and registry_path.parent == run_root
        and registry_path.name == "owned-pgids",
        "shell owner registry identity, owner, or permissions are invalid",
    )
    registry = OwnerRegistry(registry_path)
    for record in registry._read():
        require(
            pathlib.Path(record.run_root) == run_root
            and pathlib.Path(record.config_root).is_relative_to(run_root),
            "owner record is not bound to the exact cleanup root",
        )
    return run_root, registry


def remove_exact_run_root(run_root: pathlib.Path, registry: OwnerRegistry) -> None:
    require(not registry._read(), "owner registry is not empty; run root was retained")
    try:
        before = run_root.lstat()
    except FileNotFoundError:
        return
    require(
        stat.S_ISDIR(before.st_mode)
        and not run_root.is_symlink()
        and before.st_uid == os.geteuid()
        and stat.S_IMODE(before.st_mode) == 0o700,
        "run root changed identity before deletion",
    )
    shutil.rmtree(run_root, ignore_errors=False)
    require(not run_root.exists(), "exact run root remained after cleanup")


def cleanup_registered_owners(
    run_root: pathlib.Path,
    registry: OwnerRegistry,
    *,
    delete_run_root: bool,
) -> None:
    failures: list[str] = []
    for record in registry._read():
        try:
            cleanup_owner_record(
                registry,
                record,
                process=None,
                graceful_owner=None,
            )
        except BaseException as error:
            failures.append(safe_diagnostic(error))
    if failures:
        raise IntegrationFailure(
            "owner cleanup failed; registry and run root were retained: "
            + "; ".join(failures)
        )
    require(not registry._read(), "owner registry retained records after cleanup")
    if delete_run_root:
        remove_exact_run_root(run_root, registry)


def cleanup_owned_resources_mode(run_root_text: str, registry_text: str) -> None:
    require(
        os.environ.get("DEEPCODE_TEST_CONTROLLER") == "1"
        and os.environ.get("DEEPCODE_TEST_SUITE_ID") == "host.v2.integration",
        "owner cleanup mode must run through the exact Host integration suite",
    )
    run_root, registry = validated_owner_paths(run_root_text, registry_text)
    cleanup_registered_owners(run_root, registry, delete_run_root=True)


def assert_no_open_test_resources(test_root: pathlib.Path) -> None:
    proc_root = pathlib.Path("/proc")
    if proc_root.is_dir():
        root_text = str(test_root)
        for entry in proc_root.iterdir():
            if not entry.name.isdigit():
                continue
            try:
                cmdline = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode(
                    "utf-8", errors="ignore"
                )
                environment = (entry / "environ").read_bytes().replace(b"\0", b"\n").decode(
                    "utf-8", errors="ignore"
                )
            except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
                continue
            require(
                root_text not in cmdline and root_text not in environment,
                f"test-owned process {entry.name} remained after Host shutdown",
            )


def run() -> None:
    require(
        os.environ.get("DEEPCODE_TEST_CONTROLLER") == "1"
        and os.environ.get("DEEPCODE_TEST_SUITE_ID") == "host.v2.integration",
        "host-v2-integration.py must run through test.sh",
    )
    require(DAEMON.is_file() and os.access(DAEMON, os.X_OK), "daemon binary is missing")
    require(CLI.is_file() and os.access(CLI, os.X_OK), "CLI binary is missing")
    require(BRIDGE.is_file(), "Session Host bridge production asset is missing")
    require(NODE is not None and NODE.is_file(), "trusted Node runtime is missing")

    run_root, owner_registry = validated_owner_paths()

    test_root: pathlib.Path | None = None
    provider: ProviderServer | None = None
    provider_thread: threading.Thread | None = None
    provider_started = False
    owned: OwnedDaemon | None = None
    primary_error: BaseException | None = None
    cleanup_errors: list[str] = []
    try:
        test_root = pathlib.Path(
            tempfile.mkdtemp(prefix="host-integration.", dir=run_root)
        )
        provider = ProviderServer()
        provider_thread = threading.Thread(
            target=provider.serve_guarded,
            name="deepcode-host-v2-provider",
            daemon=True,
        )
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, CONTROL_SIGNALS)
        try:
            provider_thread.start()
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        provider_started = True
        config_root = test_root / "config-root"
        workspace = test_root / "workspace"
        workspace.mkdir(parents=True)
        (workspace / "README.md").write_text("Host v2 integration workspace\n", encoding="utf-8")
        write_profile(config_root, provider.port)
        predecessor_fact_store = seed_incompatible_predecessor_fact_store(config_root)
        port = reserve_port()

        owned = start_daemon(config_root, port, owner_registry, generation=1)
        host_startup_uses_current_contract_store_without_touching_incompatible_predecessor(
            owned,
            config_root,
            predecessor_fact_store,
        )
        passed(
            "Host startup uses current contract store without touching incompatible predecessor"
        )
        inspect_workspace_public_path(owned, workspace)
        passed("Host workspace resolution")

        validate_transport_lanes(owned)
        passed("Separate Session command and trusted decision lanes")

        validate_legacy_routes_rejected(owned)
        passed("Legacy Kernel routes rejected")

        session_id = create_session(owned)
        cli_status = run_cli(
            owned.base_url,
            owned.host_capability,
            ["daemon", "status"],
            expect_success=True,
        )
        require(
            "deepcode-kernel-daemon" in cli_status.stdout,
            "CLI daemon status did not identify the v2 Host",
        )
        cli_sessions = run_cli(
            owned.base_url,
            owned.host_capability,
            ["--no-workspace", "sessions", "list"],
            expect_success=True,
        )
        require(session_id in cli_sessions.stdout, "CLI did not consume public v2 Session data")
        removed_command = run_cli(
            owned.base_url,
            owned.host_capability,
            ["tools", "verify"],
            expect_success=False,
        )
        require(
            "unknown command" in removed_command.stderr,
            "CLI failed for a reason other than removed direct tool verification",
        )
        passed("CLI v2 public Host transport")

        provider_count_before_cli_ask = provider.request_count()
        cli_ask = run_cli(
            owned.base_url,
            owned.host_capability,
            [
                "--print",
                "--session",
                session_id,
                "--workspace",
                str(workspace),
                "ask",
                CLI_PROMPT,
            ],
            expect_success=True,
        )
        require(
            cli_ask.stdout.strip() == FINAL_TEXT,
            "CLI ask did not print the controlled Provider response: "
            f"stdout={safe_diagnostic(cli_ask.stdout, owned.host_capability)!r}; "
            f"stderr={safe_diagnostic(cli_ask.stderr, owned.host_capability)!r}",
        )
        provider_count_after_cli_ask = provider.request_count()
        require(
            provider_count_after_cli_ask == provider_count_before_cli_ask + 1,
            "CLI ask did not call the controlled Provider exactly once",
        )
        provider_requests = provider.request_snapshot()
        require(
            len(provider_requests) == provider_count_after_cli_ask,
            "Provider request snapshot changed while validating CLI ask",
        )
        assert_provider_received_current_input(provider_requests[-1], CLI_PROMPT)
        cli_host_run_id = read_cli_ask_host_run_identity(
            config_root,
            session_id,
        )
        cli_snapshot = canonical_run_snapshot(
            config_root,
            session_id,
            cli_host_run_id,
        )
        provider_trace_replay = validate_provider_trace_export(
            owned,
            config_root,
            session_id,
            cli_snapshot.run_id,
        )
        provider.require_healthy()
        passed("CLI ask through Session bridge and canonical Kernel facts")
        passed("Provider trace seal, bounded export, replay, and metadata-only audit")

        fixed_tool_session_id = create_session(owned)
        readme_path = workspace / "README.md"
        readme_before = readme_path.read_bytes()
        provider_count_before_fixed_tool = provider.request_count()
        try:
            fixed_tool_cli = run_cli(
                owned.base_url,
                owned.host_capability,
                [
                    "--print",
                    "--session",
                    fixed_tool_session_id,
                    "--workspace",
                    str(workspace),
                    "ask",
                    CLI_TOOL_PROMPT,
                ],
                expect_success=True,
            )
        except subprocess.TimeoutExpired as error:
            fixed_requests = provider.request_snapshot()[
                provider_count_before_fixed_tool:
            ]
            provider_errors: str | None = None
            try:
                provider.require_healthy()
            except IntegrationFailure as provider_error:
                provider_errors = safe_diagnostic(provider_error)
            raise IntegrationFailure(
                "fixed CLI tool chain timed out; safe Provider sequence="
                f"{json.dumps([fixed_tool_provider_request_summary(request) for request in fixed_requests], separators=(',', ':'))}; "
                f"providerErrors={provider_errors or 'none'}"
            ) from error
        require(
            fixed_tool_cli.stdout.strip() == CLI_TOOL_FINAL_TEXT,
            "fixed tool CLI turn did not print the post-Kernel Provider answer: "
            f"stdout={safe_diagnostic(fixed_tool_cli.stdout, owned.host_capability)!r}; "
            f"stderr={safe_diagnostic(fixed_tool_cli.stderr, owned.host_capability)!r}",
        )
        provider_count_after_fixed_tool = provider.request_count()
        require(
            provider_count_after_fixed_tool == provider_count_before_fixed_tool + 3,
            "fixed tool CLI turn did not use planning tool-call, planning continuation, and no-tools finalAnswer turns",
        )
        fixed_tool_requests = provider.request_snapshot()[
            provider_count_before_fixed_tool:provider_count_after_fixed_tool
        ]
        require(
            len(fixed_tool_requests) == 3,
            "fixed tool Provider request snapshot changed during validation",
        )
        assert_fixed_tool_provider_sequence(
            fixed_tool_requests[0],
            fixed_tool_requests[1],
            fixed_tool_requests[2],
        )
        fixed_tool_host_run_id = read_cli_ask_host_run_identity(
            config_root,
            fixed_tool_session_id,
        )
        fixed_tool_snapshot = canonical_run_snapshot(
            config_root,
            fixed_tool_session_id,
            fixed_tool_host_run_id,
        )
        require_fixed_read_canonical_facts(
            config_root,
            fixed_tool_snapshot,
            len(readme_before),
        )
        require(
            readme_path.read_bytes() == readme_before,
            "fixed fs.read distribution instruction mutated README.md",
        )
        delete_session_and_require_private_storage_released(
            owned,
            config_root,
            fixed_tool_session_id,
        )
        provider.require_healthy()
        passed(
            "Supporting evidence: fixed CLI instruction reached Session, Kernel fs.read, "
            "canonical facts, planning continuation, and bound finalAnswer; not final acceptance"
        )

        validate_fs_delete_plan_preview_rejection_without_effect(
            owned,
            config_root,
            workspace,
            provider,
        )
        passed(
            "fs_delete_plan_preview_requires_user_action_and_rejects_without_effect "
            "(supporting evidence only)"
        )

        provider_profile_quarantine_requires_explicit_reenable_intent(
            owned,
            config_root,
            provider_trace_replay["metadata"],
        )
        passed("Provider Profile quarantine requires exact explicit re-enable intent")

        provider_count_before_direct_run = provider.request_count()
        caller_request = {
            "op": "ask",
            "content": "Return the controlled Host integration response.",
            "workspacePath": str(workspace),
            "noWorkspace": False,
            "attachments": [],
            "decisionKind": None,
            "decision": None,
            "guidance": None,
            "runId": None,
            "targetId": None,
            "callerRequestId": "caller-host-v2-restart-replay",
        }
        first_run = open_host_run(owned, session_id, config_root, caller_request)
        host_run_id = first_run.get("id") or first_run.get("runId")
        require(isinstance(host_run_id, str) and host_run_id, "Host Run ID is missing")
        provider_count_after_direct_run = provider.request_count()
        require(
            provider_count_after_direct_run == provider_count_before_direct_run + 1,
            "initial Host Run did not call Provider once",
        )
        first_snapshot = canonical_run_snapshot(config_root, session_id, host_run_id)
        first_session_run_store_snapshot = (
            host_run_open_restart_and_replay_preserve_exact_snapshot_dispatch_terminal_and_cleanup(
                owned,
                config_root,
                session_id,
                first_snapshot,
            )
        )
        provider.require_healthy()
        passed("Host-owned workspace-bound RunOpen")
        passed("RunOpen v3 ToolContext, dispatch, terminal, and Trace ordering")
        passed("Canonical Run retirement facts and authority cleanup")

        first_host_capability = owned.host_capability
        first_owner_record = owned.owner_record
        stop_owned_process_group(owned, graceful=True)
        owned = None
        require(
            observe_owner(first_owner_record).state == "absent"
            and not owner_registry.contains(first_owner_record),
            "first Host generation retained an owned child or owner registration",
        )

        owned = start_daemon(config_root, port, owner_registry, generation=2)
        require_provider_trace_capability_invalid_after_restart(
            owned,
            provider_trace_replay,
        )
        replayed_run = open_host_run(owned, session_id, config_root, caller_request)
        replayed_host_run_id = replayed_run.get("id") or replayed_run.get("runId")
        require(
            replayed_host_run_id == host_run_id,
            "restart replay changed the Host Run identity",
        )
        require(
            provider.request_count() == provider_count_after_direct_run,
            "exact restart replay called Provider a second time",
        )
        replayed_snapshot = canonical_run_snapshot(
            config_root,
            session_id,
            host_run_id,
        )
        require(
            replayed_snapshot == first_snapshot,
            "exact restart replay changed canonical facts or their high-water",
        )
        replayed_session_run_store_snapshot, _ = read_stable_current_session_run_store(
            config_root,
            session_id,
            replayed_snapshot.run_id,
        )
        require(
            replayed_session_run_store_snapshot == first_session_run_store_snapshot,
            "daemon restart or exact caller replay rewrote the immutable pure-v2 Session Run store",
        )
        provider.require_healthy()
        passed("Provider trace export capability invalidated by daemon restart")
        run_cli(
            owned.base_url,
            owned.host_capability,
            ["daemon", "status"],
            expect_success=True,
        )
        passed("Daemon restart and exact caller replay")
        passed("Run v3 replay and prior owner cleanup")

        resource_session_id = create_session(owned)
        provider_count_before_resource_run = provider.request_count()
        resource_cli_ask = run_cli(
            owned.base_url,
            owned.host_capability,
            [
                "--print",
                "--session",
                resource_session_id,
                "--workspace",
                str(workspace),
                "ask",
                CLI_PROMPT,
            ],
            expect_success=True,
        )
        require(
            resource_cli_ask.stdout.strip() == FINAL_TEXT
            and provider.request_count() == provider_count_before_resource_run + 1,
            "Provider trace resource Session did not complete one real Provider turn",
        )
        resource_host_run_id = read_cli_ask_host_run_identity(
            config_root,
            resource_session_id,
        )
        resource_snapshot = canonical_run_snapshot(
            config_root,
            resource_session_id,
            resource_host_run_id,
        )
        resource_trace = validate_provider_trace_export(
            owned,
            config_root,
            resource_session_id,
            resource_snapshot.run_id,
        )
        resource_test_capabilities = (
            provider_trace_export_deadline_and_concurrency_release_owned_resources(
                owned,
                config_root,
                resource_session_id,
                resource_trace,
                workspace,
            )
        )
        delete_session_and_require_private_storage_released(
            owned,
            config_root,
            resource_session_id,
        )
        require_provider_trace_audit_is_metadata_only(
            config_root,
            owned,
            [
                first_host_capability,
                provider_trace_replay["capability"],
                resource_trace["capability"],
                *resource_test_capabilities,
            ],
        )
        provider.require_healthy()
        passed("Provider trace export deadline, concurrency, audit, and resource release")

        second_owner_record = owned.owner_record
        stop_owned_process_group(owned, graceful=True)
        owned = None
        require(
            observe_owner(second_owner_record).state == "absent"
            and not owner_registry.contains(second_owner_record),
            "second Host generation retained an owned child",
        )
        assert_no_open_test_resources(test_root)
    except BaseException as error:
        primary_error = error
    finally:
        if owned is not None:
            try:
                stop_owned_process_group(owned, graceful=False)
            except BaseException as error:
                cleanup_errors.append(
                    f"daemon cleanup: {safe_diagnostic(error, owned.host_capability)}"
                )
        if provider is not None:
            if provider_started:
                try:
                    provider.shutdown()
                except BaseException as error:
                    cleanup_errors.append(
                        f"provider shutdown: {safe_diagnostic(error)}"
                    )
            try:
                provider.server_close()
            except BaseException as error:
                cleanup_errors.append(
                    f"provider close: {safe_diagnostic(error)}"
                )
        if provider_thread is not None and provider_started:
            provider_thread.join(timeout=5.0)
            if provider_thread.is_alive():
                cleanup_errors.append("provider thread remained after shutdown")
        try:
            cleanup_registered_owners(
                run_root,
                owner_registry,
                delete_run_root=False,
            )
            if test_root is not None and test_root.exists():
                assert_no_open_test_resources(test_root)
                shutil.rmtree(test_root, ignore_errors=False)
        except BaseException as error:
            cleanup_errors.append(
                f"owner cleanup: {safe_diagnostic(error)}"
            )
    if primary_error is not None:
        if cleanup_errors:
            raise IntegrationFailure(
                f"{safe_diagnostic(primary_error)}; cleanup failed: "
                f"{'; '.join(cleanup_errors)}"
            ) from primary_error
        raise primary_error
    if cleanup_errors:
        raise IntegrationFailure(f"cleanup failed: {'; '.join(cleanup_errors)}")
    passed("Owned daemon, Host child, port, lock, and temporary directory cleanup")


def main() -> int:
    try:
        if len(sys.argv) == 3 and sys.argv[1] == EXEC_DAEMON_ARGUMENT:
            exec_owned_daemon_wrapper(sys.argv[2])
        elif len(sys.argv) == 4 and sys.argv[1] == CLEANUP_OWNERS_ARGUMENT:
            cleanup_owned_resources_mode(sys.argv[2], sys.argv[3])
        else:
            require(not sys.argv[1:], "unexpected host integration arguments")
            run()
    except IntegrationFailure as error:
        print(f"[FAIL] {safe_diagnostic(error)}", file=sys.stderr, flush=True)
        return 1
    except BaseException as error:
        print(
            f"[FAIL] unexpected host integration failure: {type(error).__name__}: "
            f"{safe_diagnostic(error)}",
            file=sys.stderr,
            flush=True,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
