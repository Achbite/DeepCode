#!/usr/bin/env python3
"""Real Host v2 integration behind the repository test controller."""

from __future__ import annotations

import http.server
import http.client
import json
import os
import pathlib
import re
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
from dataclasses import dataclass
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parents[2]
TARGET_DIR = pathlib.Path(os.environ.get("CARGO_TARGET_DIR", ROOT / "target"))
DAEMON = TARGET_DIR / "debug" / "deepcode-kernel-daemon"
CLI = TARGET_DIR / "debug" / "deepcode-cli"
ABI_VERSION = "deepcode.kernel.abi.v2"
HOST_HEADER = "x-deepcode-host-shell-capability"
PROVIDER_TRACE_CAPABILITY_HEADER = "x-deepcode-provider-trace-capability"
PROVIDER_TRACE_DIGEST_HEADER = "x-deepcode-provider-trace-digest"
FINAL_TEXT = "Host v2 integration completed through the real Session bridge."
PROVIDER_REASONING = (
    "The controlled Provider verified the current Session input before answering. "
    * 12_000
)
CLI_PROMPT = "Return the controlled Host integration response through the CLI."
TEST_API_KEY = "host-v2-integration-key"
EXEC_DAEMON_ARGUMENT = "--exec-owned-daemon"
EXEC_SIGNAL_MASK_ENV = "DEEPCODE_HOST_V2_EXEC_SIGNAL_MASK"
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
        chunks = [
            {
                "id": "chatcmpl-host-v2-integration",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "host-v2-integration-model",
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "role": "assistant",
                            "reasoning_content": PROVIDER_REASONING,
                        },
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
                        "delta": {"content": FINAL_TEXT},
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
            {
                "id": "chatcmpl-host-v2-integration",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "host-v2-integration-model",
                "choices": [],
                "usage": {
                    "prompt_tokens": 8,
                    "completion_tokens": 9,
                    "total_tokens": 17,
                },
            },
        ]
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
    messages = request.get("messages")
    require(isinstance(messages, list), "Provider request omitted messages")
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


@dataclass(frozen=True)
class OwnerRegistry:
    path: pathlib.Path

    def _read(self) -> list[int]:
        try:
            lines = self.path.read_text(encoding="utf-8").splitlines()
        except OSError as error:
            raise IntegrationFailure(
                f"owner PGID registry is unavailable: {safe_diagnostic(error)}"
            ) from error
        groups: list[int] = []
        for line in lines:
            require(line.isascii() and line.isdigit(), "owner PGID registry is invalid")
            process_group = int(line)
            require(process_group > 1, "owner PGID registry contains an unsafe group")
            groups.append(process_group)
        require(len(groups) == len(set(groups)), "owner PGID registry contains duplicates")
        return groups

    def _replace(self, groups: list[int]) -> None:
        temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
        try:
            with temporary.open("x", encoding="utf-8") as handle:
                os.fchmod(handle.fileno(), 0o600)
                for process_group in groups:
                    handle.write(f"{process_group}\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        except OSError as error:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
            raise IntegrationFailure(
                f"owner PGID registry update failed: {safe_diagnostic(error)}"
            ) from error

    def register(self, process_group: int) -> None:
        require(process_group > 1, "refusing to register an unsafe process group")
        groups = self._read()
        require(process_group not in groups, "owned process group is already registered")
        self._replace([*groups, process_group])

    def unregister(self, process_group: int) -> None:
        groups = self._read()
        require(process_group in groups, "owned process group was not registered")
        self._replace([group for group in groups if group != process_group])


@dataclass
class OwnedDaemon:
    process: subprocess.Popen[bytes]
    log_path: pathlib.Path
    log_handle: Any
    port: int
    host_capability: str
    instance_id: str
    owner_registry: OwnerRegistry
    owner_registered: bool = False

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def process_group(self) -> int:
        return self.process.pid

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
                "providerFlavor": "generic",
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
    require(
        encoded_mask == ""
        or all(part.isascii() and part.isdigit() for part in encoded_mask.split(",")),
        "owned daemon signal mask is invalid",
    )
    previous_mask = {
        signal.Signals(int(part))
        for part in encoded_mask.split(",")
        if part
    }
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
    environment[EXEC_SIGNAL_MASK_ENV] = ",".join(
        str(int(signal_number))
        for signal_number in sorted(previous_mask, key=int)
    )
    owned: OwnedDaemon | None = None

    try:
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
        )
        owned = OwnedDaemon(
            process=process,
            log_path=log_path,
            log_handle=log_handle,
            port=port,
            host_capability=host_capability,
            instance_id=instance_id,
            owner_registry=owner_registry,
        )
        owner_registry.register(owned.process_group)
        owned.owner_registered = True
    except BaseException as error:
        if owned is None:
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
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)

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


def process_group_exists(process_group: int) -> bool:
    try:
        os.killpg(process_group, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def signal_process_group(process_group: int, signal_number: int) -> None:
    try:
        os.killpg(process_group, signal_number)
    except ProcessLookupError:
        pass


def wait_for_process_group_exit(process_group: int, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while process_group_exists(process_group) and time.monotonic() < deadline:
        time.sleep(0.05)
    return not process_group_exists(process_group)


def stop_owned_process_group(owned: OwnedDaemon, *, graceful: bool) -> None:
    process = owned.process
    failures: list[str] = []
    if process.poll() is None and graceful:
        try:
            status, body = request_json(
                owned.base_url,
                "POST",
                "/api/host/shutdown",
                payload={},
                host_capability=owned.host_capability,
            )
            data = require_api_ok(status, body, "Host shutdown")
            require(
                isinstance(data, dict)
                and data.get("accepted") is True
                and data.get("cleanupComplete") is True
                and data.get("identity", {}).get("instanceId") == owned.instance_id,
                "Host shutdown did not confirm owned-resource cleanup",
            )
        except IntegrationFailure as error:
            failures.append(safe_diagnostic(error, owned.host_capability))
    try:
        process.wait(timeout=15.0 if graceful else 1.0)
    except subprocess.TimeoutExpired:
        if graceful:
            failures.append("owned daemon did not exit through the Host shutdown boundary")
    if process_group_exists(owned.process_group):
        if graceful and process.poll() is not None:
            failures.append("Host shutdown left a daemon-owned child process")
        signal_process_group(owned.process_group, signal.SIGTERM)
        wait_for_process_group_exit(owned.process_group, 5.0)
    if process_group_exists(owned.process_group):
        signal_process_group(owned.process_group, signal.SIGKILL)
        wait_for_process_group_exit(owned.process_group, 5.0)
    try:
        process.wait(timeout=1.0)
    except subprocess.TimeoutExpired:
        failures.append("daemon leader remained unreaped after process-group cleanup")
    if not owned.log_handle.closed:
        owned.log_handle.close()
    if process_group_exists(owned.process_group):
        failures.append("daemon-owned process group still exists after cleanup")
    else:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                probe.bind(("127.0.0.1", owned.port))
        except OSError as error:
            failures.append(
                f"daemon listener port remained owned after shutdown: "
                f"{safe_diagnostic(error)}"
            )
    if owned.owner_registered and not process_group_exists(owned.process_group):
        try:
            owned.owner_registry.unregister(owned.process_group)
            owned.owner_registered = False
        except IntegrationFailure as error:
            failures.append(safe_diagnostic(error))
    if failures:
        raise IntegrationFailure("; ".join(failures))


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


@dataclass(frozen=True)
class CanonicalRunSnapshot:
    run_id: str
    high_water: int
    fact_sequences: tuple[tuple[str, int], ...]


def kernel_fact_store(config_root: pathlib.Path) -> pathlib.Path:
    return config_root / "kernel" / "kernel-v2.sqlite3"


def host_operation_store(config_root: pathlib.Path) -> pathlib.Path:
    return config_root / "sessions" / ".host-v2" / "host-kernel-v2.sqlite3"


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
    require(database.is_file(), "exact kernel-v2.sqlite3 fact store is missing")
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


def validate_provider_trace_export(
    daemon: OwnedDaemon,
    config_root: pathlib.Path,
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
    require(len(matching) == 1, "CLI Run did not produce one sealed Provider trace")
    metadata = matching[0]
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
        and quarantined_settings.get("defaultProfileId") is None,
        "Exact quarantined Profile revision remained effectively selectable",
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
        and stale_result.get("defaultProfileId") is None,
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
    observed = safe_diagnostic(
        json.dumps(
            {
                "status": run.get("status"),
                "message": run.get("message"),
                "finalText": run.get("finalText"),
            },
            separators=(",", ":"),
        ),
        daemon.host_capability,
    )
    require(
        run.get("status") == "completed",
        f"Host-owned Run did not complete: {observed}",
    )
    require(
        run.get("finalText") == FINAL_TEXT,
        f"Host-owned Run lost provider output: {observed}",
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

    run_root_text = os.environ.get("DEEPCODE_HOST_V2_RUN_ROOT", "")
    owner_registry_text = os.environ.get("DEEPCODE_HOST_V2_OWNER_PGIDS", "")
    require(run_root_text and owner_registry_text, "shell owner guard is missing")
    run_root = pathlib.Path(run_root_text).resolve()
    owner_registry_path = pathlib.Path(owner_registry_text).resolve()
    require(
        run_root.is_dir()
        and owner_registry_path.is_file()
        and owner_registry_path.parent == run_root
        and owner_registry_path.name == "owned-pgids",
        "shell owner guard paths are invalid",
    )
    owner_registry = OwnerRegistry(owner_registry_path)

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
        port = reserve_port()

        owned = start_daemon(config_root, port, owner_registry, generation=1)
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
            "CLI ask did not print the controlled Provider response",
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
        provider_profile_quarantine_requires_explicit_reenable_intent(
            owned,
            config_root,
            provider_trace_replay["metadata"],
        )
        provider.require_healthy()
        passed("CLI ask through Session bridge and canonical Kernel facts")
        passed("Provider trace seal, bounded export, replay, and metadata-only audit")
        passed("Provider Profile quarantine requires exact explicit re-enable intent")

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
            provider_count_after_direct_run == provider_count_after_cli_ask + 1,
            "initial Host Run did not call Provider once",
        )
        first_snapshot = canonical_run_snapshot(config_root, session_id, host_run_id)
        provider.require_healthy()
        passed("Host-owned workspace-bound RunOpen")
        passed("Canonical Run retirement facts and authority cleanup")

        first_host_capability = owned.host_capability
        first_process_group = owned.process_group
        stop_owned_process_group(owned, graceful=True)
        owned = None
        require(
            not process_group_exists(first_process_group),
            "first Host generation retained an owned child",
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
        provider.require_healthy()
        passed("Provider trace export capability invalidated by daemon restart")
        run_cli(
            owned.base_url,
            owned.host_capability,
            ["daemon", "status"],
            expect_success=True,
        )
        passed("Daemon restart and exact caller replay")

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

        second_process_group = owned.process_group
        stop_owned_process_group(owned, graceful=True)
        owned = None
        require(
            not process_group_exists(second_process_group),
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
        if test_root is not None and test_root.exists():
            try:
                assert_no_open_test_resources(test_root)
            except BaseException as error:
                cleanup_errors.append(
                    f"owned process audit: {safe_diagnostic(error)}"
                )
            try:
                shutil.rmtree(test_root, ignore_errors=False)
            except BaseException as error:
                cleanup_errors.append(
                    f"temporary directory cleanup: {safe_diagnostic(error)}"
                )
        if test_root is not None and test_root.exists():
            cleanup_errors.append("test-owned temporary directory remained")
        try:
            residual_groups = owner_registry._read()
            if residual_groups:
                cleanup_errors.append(
                    "shell owner registry retained daemon process groups"
                )
        except BaseException as error:
            cleanup_errors.append(
                f"owner registry audit: {safe_diagnostic(error)}"
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
