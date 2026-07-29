#!/usr/bin/env python3
"""Real Host v2 integration behind the repository test controller."""

from __future__ import annotations

import http.server
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
import urllib.request
from dataclasses import dataclass
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parents[2]
TARGET_DIR = pathlib.Path(os.environ.get("CARGO_TARGET_DIR", ROOT / "target"))
DAEMON = TARGET_DIR / "debug" / "deepcode-kernel-daemon"
CLI = TARGET_DIR / "debug" / "deepcode-cli"
ABI_VERSION = "deepcode.kernel.abi.v2"
HOST_HEADER = "x-deepcode-host-shell-capability"
FINAL_TEXT = "Host v2 integration completed through the real Session bridge."
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
            or request.get("stream") is not False
        ):
            self.send_error(400)
            return
        with server.request_lock:
            server.requests.append(request)
        response = {
            "id": "chatcmpl-host-v2-integration",
            "object": "chat.completion",
            "created": 0,
            "model": "host-v2-integration-model",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": FINAL_TEXT,
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": 8,
                "completion_tokens": 9,
                "total_tokens": 17,
            },
        }
        encoded = json.dumps(response, separators=(",", ":")).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

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


@dataclass(frozen=True)
class CanonicalRunSnapshot:
    run_id: str
    high_water: int
    fact_sequences: tuple[tuple[str, int], ...]


def kernel_fact_store(config_root: pathlib.Path) -> pathlib.Path:
    return config_root / "kernel" / "kernel-v2.sqlite3"


def host_operation_store(config_root: pathlib.Path) -> pathlib.Path:
    return config_root / "sessions" / ".host-v2" / "host-kernel-v2.sqlite3"


def read_host_kernel_run_identity(
    config_root: pathlib.Path,
    session_id: str,
    host_run_id: str,
) -> str:
    database = host_operation_store(config_root)
    require(database.is_file(), "exact Host operation store is missing")
    try:
        with sqlite3.connect(
            f"file:{database}?mode=ro",
            uri=True,
            timeout=5.0,
        ) as connection:
            rows = connection.execute(
                "SELECT run_id, lifecycle FROM host_kernel_runs "
                "WHERE session_id = ?1 AND host_run_id = ?2",
                (session_id, host_run_id),
            ).fetchall()
    except sqlite3.Error as error:
        raise IntegrationFailure(
            f"Host operation identity query failed: {safe_diagnostic(error)}"
        ) from error
    require(len(rows) == 1, "Host operation store omitted the exact Run identity")
    run_id, lifecycle = rows[0]
    require(
        isinstance(run_id, str) and run_id and lifecycle == "Retired",
        "Host operation store did not durably retire the exact Kernel Run",
    )
    return run_id


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
        require(provider.request_count() == 1, "initial Host Run did not call Provider once")
        first_snapshot = canonical_run_snapshot(config_root, session_id, host_run_id)
        provider.require_healthy()
        passed("Host-owned workspace-bound RunOpen")
        passed("Canonical Run retirement facts and authority cleanup")

        first_process_group = owned.process_group
        stop_owned_process_group(owned, graceful=True)
        owned = None
        require(
            not process_group_exists(first_process_group),
            "first Host generation retained an owned child",
        )

        owned = start_daemon(config_root, port, owner_registry, generation=2)
        replayed_run = open_host_run(owned, session_id, config_root, caller_request)
        replayed_host_run_id = replayed_run.get("id") or replayed_run.get("runId")
        require(
            replayed_host_run_id == host_run_id,
            "restart replay changed the Host Run identity",
        )
        require(
            provider.request_count() == 1,
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
        run_cli(
            owned.base_url,
            owned.host_capability,
            ["daemon", "status"],
            expect_success=True,
        )
        passed("Daemon restart and exact caller replay")

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
