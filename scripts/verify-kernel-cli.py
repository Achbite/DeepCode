#!/usr/bin/env python3
"""Run Kernel CLI integration checks against isolated, real daemon processes."""

from __future__ import annotations

import argparse
import contextlib
import http.server
import json
import os
import pathlib
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from typing import Any, Iterator


PROTOCOL_VERSION = "deepcode.agent.protocol.v4"
CATALOG_VERSION = "deepcode.kernel.tools.v3"
DRAFT_SCHEMA_VERSION = "deepcode.agent.artifact-draft.v1"
TASK_INTENT_SCHEMA_VERSION = "deepcode.kernel.task-intent.v2"


def parse_args() -> argparse.Namespace:
    root = pathlib.Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--daemon-bin",
        type=pathlib.Path,
        default=root / "target/debug/deepcode-kernel-daemon",
    )
    parser.add_argument(
        "--cli-bin",
        type=pathlib.Path,
        default=root / "target/debug/deepcode-cli",
    )
    parser.add_argument(
        "--cases",
        type=pathlib.Path,
        default=root / "fixtures/kernel-tools-v3/verify-cases.jsonl",
    )
    parser.add_argument(
        "--provider-api",
        default=os.environ.get("DEEPCODE_VERIFY_PROVIDER_API", ""),
    )
    parser.add_argument(
        "--provider-prompt",
        default="Inspect the current workspace and report its top-level structure.",
    )
    return parser.parse_args()


def random_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex}"


def reserve_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def request_json(
    url: str,
    payload: dict[str, Any] | None = None,
    timeout: float = 10.0,
) -> dict[str, Any]:
    data = None
    headers: dict[str, str] = {}
    method = "GET"
    if payload is not None:
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
        method = "POST"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def kernel_command(api: str, command: dict[str, Any]) -> dict[str, Any]:
    reply = request_json(f"{api}/api/kernel/commands", {"command": command})
    if not reply.get("ok"):
        raise RuntimeError(f"Kernel command failed: {reply.get('error')}")
    return reply


def event(reply: dict[str, Any], kind: str) -> dict[str, Any]:
    for item in reply.get("events", []):
        if item.get("kind") == kind:
            return item
    raise RuntimeError(f"Kernel reply is missing {kind}: {reply}")


def events(reply: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    return [item for item in reply.get("events", []) if item.get("kind") == kind]


class EvidenceHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path.startswith("/search"):
            body = json.dumps(
                {
                    "results": [
                        {
                            "title": "result",
                            "url": "https://example.invalid/result",
                            "snippet": "external evidence",
                        }
                    ]
                }
            ).encode("utf-8")
            content_type = "application/json"
        elif self.path.startswith("/resource"):
            body = b"external evidence\n"
            content_type = "text/plain; charset=utf-8"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: Any) -> None:
        return


@contextlib.contextmanager
def evidence_server() -> Iterator[str]:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), EvidenceHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


class DaemonProcess:
    def __init__(
        self,
        binary: pathlib.Path,
        runtime_root: pathlib.Path,
        port: int,
        search_endpoint: str,
    ) -> None:
        self.binary = binary
        self.runtime_root = runtime_root
        self.port = port
        self.search_endpoint = search_endpoint
        self.process: subprocess.Popen[bytes] | None = None
        self.log_path = runtime_root / "daemon.log"

    @property
    def api(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def ledger_path(self) -> pathlib.Path:
        return self.runtime_root / "ledger.jsonl"

    def start(self) -> None:
        self.stop()
        config_dir = self.runtime_root / "config"
        settings_dir = config_dir / "config/user/local/settings"
        settings_dir.mkdir(parents=True, exist_ok=True)
        settings = {
            "agent.web.search.endpointTemplate": (
                f"{self.search_endpoint}/search?query={{query}}&limit={{limit}}"
            ),
            "agent.permissions.workspaceRead": "allow",
            "agent.permissions.workspaceWrite": "ask",
            "agent.permissions.gitWrite": "ask",
            "agent.permissions.webRead": "allow",
            "agent.permissions.privateWebRead": "allow",
        }
        (settings_dir / "user-settings.json").write_text(
            json.dumps(settings), encoding="utf-8"
        )
        environment = os.environ.copy()
        environment.update(
            {
                "DEEPCODE_HOST": "127.0.0.1",
                "DEEPCODE_PORT": str(self.port),
                "DEEPCODE_CONFIG_DIR": str(config_dir),
                "DEEPCODE_LEDGER_PATH": str(self.ledger_path),
            }
        )
        log = self.log_path.open("ab")
        try:
            self.process = subprocess.Popen(
                [str(self.binary)],
                cwd=self.runtime_root,
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        finally:
            log.close()
        self.wait_until_ready()

    def wait_until_ready(self) -> None:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self.process is not None and self.process.poll() is not None:
                raise RuntimeError(
                    f"daemon exited during startup; log={self.log_path}"
                )
            try:
                health = request_json(f"{self.api}/api/health", timeout=0.3)
                if health.get("ok"):
                    return
            except (OSError, urllib.error.URLError, TimeoutError):
                pass
            time.sleep(0.1)
        raise RuntimeError(f"daemon did not become healthy; log={self.log_path}")

    def stop(self) -> None:
        if self.process is None:
            return
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.process = None

    def __enter__(self) -> "DaemonProcess":
        self.start()
        return self

    def __exit__(self, *_args: Any) -> None:
        self.stop()


def run_create(
    api: str,
    workspace: pathlib.Path,
    session_id: str,
    attachments: list[dict[str, Any]] | None = None,
) -> tuple[str, dict[str, Any]]:
    reply = kernel_command(
        api,
        {
            "kind": "runCreate",
            "requestId": random_id("run-create"),
            "sessionId": session_id,
            "input": {
                "text": "Kernel integration verification.",
                "attachments": attachments or [],
            },
            "workspaceBinding": {
                "workspaceId": random_id("workspace"),
                "workspaceHash": None,
                "openPath": str(workspace.resolve()),
                "activeFolderId": None,
                "folderHash": None,
            },
            "profileRef": None,
            "runOverrides": None,
        },
    )
    state = event(reply, "state.entered")
    return str(state["runId"]), state["stateContract"]


def verify_health(api: str) -> dict[str, Any]:
    health = request_json(f"{api}/api/health")
    data = health.get("data", health)
    if data.get("protocolVersion") != PROTOCOL_VERSION:
        raise RuntimeError(f"unexpected Agent Protocol: {data}")
    if data.get("toolCatalogVersion") != CATALOG_VERSION:
        raise RuntimeError(f"unexpected Tool Catalog: {data}")
    return {
        "protocolVersion": data.get("protocolVersion"),
        "toolCatalogVersion": data.get("toolCatalogVersion"),
        "toolCatalogHash": data.get("toolCatalogHash"),
        "buildCommit": data.get("buildCommit"),
    }


def verify_cli_matrix(
    cli_bin: pathlib.Path,
    api: str,
    workspace: pathlib.Path,
    cases: pathlib.Path,
    endpoint: str,
) -> dict[str, Any]:
    environment = os.environ.copy()
    environment["DEEPCODE_VERIFY_EXTERNAL_ENDPOINT"] = endpoint
    completed = subprocess.run(
        [
            str(cli_bin),
            "--api",
            api,
            "tools",
            "verify",
            "--workspace",
            str(workspace),
            "--cases",
            str(cases),
            "--approve-contract",
        ],
        env=environment,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"CLI tool matrix failed: {completed.stderr.strip()}\n{completed.stdout}"
        )
    result = json.loads(completed.stdout)
    if result.get("failed") != 0 or not result.get("coveragePassed"):
        raise RuntimeError(f"CLI tool matrix reported incomplete verification: {result}")
    return {
        "total": result.get("total"),
        "passed": result.get("passed"),
        "coveragePassed": result.get("coveragePassed"),
    }


def verify_symlink_boundary(
    cli_bin: pathlib.Path,
    api: str,
    workspace: pathlib.Path,
    external_root: pathlib.Path,
) -> dict[str, Any]:
    external_root.mkdir(parents=True, exist_ok=True)
    inside_target = workspace / f"{random_id('inside-target')}.txt"
    outside_target = external_root / f"{random_id('outside-target')}.txt"
    inside_link = workspace / f"{random_id('inside-link')}.txt"
    outside_link = workspace / f"{random_id('outside-link')}.txt"
    inside_target.write_text("inside\n", encoding="utf-8")
    outside_target.write_text("outside\n", encoding="utf-8")
    inside_link.symlink_to(inside_target)
    outside_link.symlink_to(outside_target)

    def run(tool_id: str, args: dict[str, Any], approve: bool = False) -> subprocess.CompletedProcess[str]:
        args_path = workspace.parent / f"{random_id('symlink-args')}.json"
        args_path.write_text(json.dumps(args), encoding="utf-8")
        command = [
            str(cli_bin),
            "--api",
            api,
            "tools",
            "run",
            tool_id,
            "--workspace",
            str(workspace),
            "--args-file",
            str(args_path),
        ]
        if approve:
            command.append("--approve-contract")
        return subprocess.run(
            command,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    inside_read = run("fs.read", {"path": inside_link.name})
    if inside_read.returncode != 0:
        raise RuntimeError(
            f"in-root symlink read failed: {inside_read.stderr.strip()}"
        )
    outside_read = run("fs.read", {"path": outside_link.name})
    if outside_read.returncode == 0:
        raise RuntimeError("out-of-root symlink read unexpectedly succeeded")
    mutation = run(
        "fs.delete",
        {
            "path": inside_link.name,
            "targetKind": "file",
            "recursive": False,
        },
        approve=True,
    )
    if mutation.returncode == 0:
        raise RuntimeError("symlink mutation unexpectedly succeeded")
    if not inside_link.is_symlink() or inside_target.read_text(encoding="utf-8") != "inside\n":
        raise RuntimeError("rejected symlink mutation changed the link or its target")
    if outside_target.read_text(encoding="utf-8") != "outside\n":
        raise RuntimeError("rejected out-of-root read changed external content")
    return {
        "inRootRead": "success",
        "outOfRootRead": "rejected",
        "mutation": "rejected",
    }


def verify_host_bridge(api: str, workspace: pathlib.Path) -> dict[str, Any]:
    target = workspace / f"{random_id('host')}.txt"
    target.write_text("host projection\n", encoding="utf-8")
    kernel_command(
        api,
        {
            "kind": "workspaceOpen",
            "requestId": random_id("workspace-open"),
            "path": str(workspace),
        },
    )
    reply = kernel_command(
        api,
        {
            "kind": "hostResourceQuery",
            "requestId": random_id("host-read"),
            "query": {
                "kind": "read",
                "folderId": None,
                "path": target.name,
            },
        },
    )
    inspection = event(reply, "host.inspection_completed")
    result = inspection["result"]
    if result.get("source") != "hostProjection":
        raise RuntimeError(f"Host query has unexpected source: {result}")
    if events(reply, "tool.completed"):
        raise RuntimeError("Host projection query emitted Agent ToolCompleted facts")

    transport = request_json(
        f"{api}/api/host/inspect",
        {
            "kind": "read",
            "folderId": None,
            "path": target.name,
        },
    )
    transport_result = transport.get("data", {})
    if transport_result.get("source") != "hostProjection":
        raise RuntimeError(f"Typed Host transport lost the Kernel source: {transport}")
    try:
        request_json(f"{api}/api/files/read?path={target.name}")
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise RuntimeError(f"Retired Host route returned HTTP {error.code}") from error
    else:
        raise RuntimeError("Retired Host file-read route is still live")
    return {
        "source": transport_result.get("source"),
        "queryKind": transport_result.get("queryKind"),
    }


def verify_external_resource_lease(
    api: str,
    workspace: pathlib.Path,
    external_root: pathlib.Path,
) -> dict[str, Any]:
    external_root.mkdir(parents=True, exist_ok=True)
    target = external_root / f"{random_id('external')}.txt"
    target.write_text("external lease\n", encoding="utf-8")
    resource_id = random_id("external-resource")
    first_session_id = random_id("external-session")
    first_run_id, _ = run_create(
        api,
        workspace,
        first_session_id,
        [
            {
                "resourceId": resource_id,
                "source": "userSelected",
                "kind": "directory",
                "absolutePath": str(external_root.resolve()),
            }
        ],
    )
    second_session_id = random_id("external-session")
    second_run_id, _ = run_create(
        api,
        workspace,
        second_session_id,
        [
            {
                "resourceId": resource_id,
                "source": "userSelected",
                "kind": "directory",
                "absolutePath": str(external_root.resolve()),
            }
        ],
    )
    manifest = {
        "id": random_id("manifest"),
        "workspaceScopeKey": random_id("scope"),
        "entries": [
            {
                "id": random_id("entry"),
                "kind": "file",
                "resourceId": resource_id,
                "rootId": resource_id,
                "path": target.name,
            }
        ],
    }

    def resolve(run_id: str, session_id: str) -> dict[str, Any]:
        reply = kernel_command(
            api,
            {
                "kind": "resourceResolve",
                "requestId": random_id("resource-resolve"),
                "runId": run_id,
                "sessionId": session_id,
                "request": {"manifest": manifest},
            },
        )
        packet = event(reply, "resource.packet_produced")["packet"]
        return packet["items"][0]

    first_before = resolve(first_run_id, first_session_id)
    second_before = resolve(second_run_id, second_session_id)
    if first_before.get("status") != "resolved" or second_before.get("status") != "resolved":
        raise RuntimeError(
            f"Run-scoped ExternalResourceLease did not resolve: first={first_before}, second={second_before}"
        )
    kernel_command(
        api,
        {
            "kind": "runCancel",
            "requestId": random_id("run-cancel"),
            "runId": first_run_id,
        },
    )
    first_after = resolve(first_run_id, first_session_id)
    second_after = resolve(second_run_id, second_session_id)
    if first_after.get("status") == "resolved":
        raise RuntimeError("ExternalResourceLease remained active after RunCancel")
    if second_after.get("status") != "resolved":
        raise RuntimeError("Cancelling one Run released another Run's external resource lease")
    return {
        "firstBefore": first_before.get("status"),
        "firstAfter": first_after.get("status"),
        "secondBefore": second_before.get("status"),
        "secondAfter": second_after.get("status"),
    }


def authorize_tool_plan(
    api: str,
    workspace: pathlib.Path,
    tool_id: str,
    targets: list[str],
) -> tuple[str, str, dict[str, Any]]:
    session_id = random_id("plan-session")
    run_id, state = run_create(api, workspace, session_id)
    catalog = state["toolCatalogSnapshot"]
    plan_id = random_id("plan")
    plan_hash = random_id("plan-hash")
    task_id = random_id("task")
    reviewed = kernel_command(
        api,
        {
            "kind": "planAuthorizationSubmit",
            "requestId": random_id("plan-submit"),
            "runId": run_id,
            "sessionId": session_id,
            "intent": {
                "schemaVersion": TASK_INTENT_SCHEMA_VERSION,
                "planId": plan_id,
                "planHash": plan_hash,
                "runId": run_id,
                "sessionId": session_id,
                "workspaceBindingHash": None,
                "catalogVersion": catalog["catalogVersion"],
                "catalogHash": catalog["catalogHash"],
                "tasks": [
                    {
                        "taskId": task_id,
                        "toolId": tool_id,
                        "targets": targets,
                        "dependsOn": [],
                        "args": {},
                    }
                ],
            },
        },
    )
    review = event(reviewed, "plan_authorization.reviewed")["review"]
    if review.get("status") != "confirmable":
        raise RuntimeError(f"Plan authorization is not confirmable: {review}")
    authorization = review["authorizationContract"]
    kernel_command(
        api,
        {
            "kind": "planAuthorizationDecisionSubmit",
            "requestId": random_id("plan-decision"),
            "runId": run_id,
            "sessionId": session_id,
            "decision": {
                "decisionId": random_id("decision"),
                "authorizationContractId": authorization["id"],
                "planId": plan_id,
                "planHash": plan_hash,
                "contractHash": authorization["contractHash"],
                "decision": "accept",
            },
        },
    )
    return run_id, session_id, authorization


def review_task_plan(
    api: str,
    workspace: pathlib.Path,
    tasks: list[dict[str, Any]],
) -> dict[str, Any]:
    session_id = random_id("dependency-session")
    run_id, state = run_create(api, workspace, session_id)
    catalog = state["toolCatalogSnapshot"]
    reviewed = kernel_command(
        api,
        {
            "kind": "planAuthorizationSubmit",
            "requestId": random_id("dependency-plan-submit"),
            "runId": run_id,
            "sessionId": session_id,
            "intent": {
                "schemaVersion": TASK_INTENT_SCHEMA_VERSION,
                "planId": random_id("dependency-plan"),
                "planHash": random_id("dependency-plan-hash"),
                "runId": run_id,
                "sessionId": session_id,
                "workspaceBindingHash": None,
                "catalogVersion": catalog["catalogVersion"],
                "catalogHash": catalog["catalogHash"],
                "tasks": tasks,
            },
        },
    )
    return event(reviewed, "plan_authorization.reviewed")["review"]


def verify_ordered_conflict_authorization(
    api: str,
    workspace: pathlib.Path,
) -> dict[str, Any]:
    target = random_id("dependency-target") + ".txt"
    first_task_id = random_id("dependency-create")
    second_task_id = random_id("dependency-edit")
    unordered = review_task_plan(
        api,
        workspace,
        [
            {
                "taskId": first_task_id,
                "toolId": "fs.create",
                "targets": [target],
                "dependsOn": [],
                "args": {},
            },
            {
                "taskId": second_task_id,
                "toolId": "fs.edit",
                "targets": [target],
                "dependsOn": [],
                "args": {},
            },
        ],
    )
    if unordered.get("status") != "needsRevision" or not any(
        "unordered_operation_conflict" in str(item)
        for item in unordered.get("diagnostics", [])
    ):
        raise RuntimeError(
            f"Unordered conflicting tasks were not rejected: {unordered}"
        )

    ordered = review_task_plan(
        api,
        workspace,
        [
            {
                "taskId": first_task_id,
                "toolId": "fs.create",
                "targets": [target],
                "dependsOn": [],
                "args": {},
            },
            {
                "taskId": second_task_id,
                "toolId": "fs.edit",
                "targets": [target],
                "dependsOn": [first_task_id],
                "args": {},
            },
        ],
    )
    if ordered.get("status") != "confirmable":
        raise RuntimeError(f"Ordered conflicting tasks were not confirmable: {ordered}")
    operations = ordered.get("authorizationContract", {}).get("operations", [])
    first_operation = next(
        (
            operation
            for operation in operations
            if operation.get("sourceTaskId") == first_task_id
            and not operation.get("internal")
        ),
        None,
    )
    second_operation = next(
        (
            operation
            for operation in operations
            if operation.get("sourceTaskId") == second_task_id
            and not operation.get("internal")
        ),
        None,
    )
    if not first_operation or not second_operation:
        raise RuntimeError(f"Ordered task operations are incomplete: {ordered}")
    if second_operation.get("dependsOn") != [first_operation.get("id")]:
        raise RuntimeError(f"Task dependency was not mapped to operation ids: {ordered}")
    unordered_hash = unordered.get("authorizationContract", {}).get("operationSetHash")
    ordered_hash = ordered.get("authorizationContract", {}).get("operationSetHash")
    if not unordered_hash or unordered_hash == ordered_hash:
        raise RuntimeError("Operation dependency did not affect the operation-set hash")
    return {
        "unorderedStatus": unordered.get("status"),
        "orderedStatus": ordered.get("status"),
        "mappedDependencyCount": len(second_operation.get("dependsOn", [])),
    }


def submit_tool_actions(
    api: str,
    run_id: str,
    session_id: str,
    authorization: dict[str, Any],
    actions: list[dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any]]:
    bundle_id = random_id("bundle")
    action_bundle = {
        "id": bundle_id,
        "goal": "Verify an exact multi-operation Kernel execution contract.",
        "actions": actions,
        "validationExpectations": [
            {
                "id": random_id("validation"),
                "description": "Kernel records terminal facts for every operation.",
            }
        ],
        "reviewExpectations": [
            {
                "id": random_id("review"),
                "description": "ReviewFacts reports every actual operation result.",
            }
        ],
    }
    proposed = kernel_command(
        api,
        {
            "kind": "proposalSubmit",
            "requestId": random_id("proposal-submit"),
            "runId": run_id,
            "sessionId": session_id,
            "proposal": {
                "schemaVersion": PROTOCOL_VERSION,
                "proposalId": random_id("proposal"),
                "runId": run_id,
                "sessionId": session_id,
                "source": "system",
                "kind": "actionBundle",
                "payload": {
                    "userPlanMarkdown": "Verify exact Kernel operations.",
                    "contentBlocks": [],
                    "actionBundle": action_bundle,
                    "authorizationContractId": authorization["id"],
                },
                "referencedResourcePacketRefs": [],
                "referencedEvidenceRefs": [],
                "parserDiagnostics": None,
            },
        },
    )
    report = event(proposed, "proposal.reviewed")["report"]
    contract = report["executionContract"]
    if report.get("status") != "authorizedByPlan" or contract.get("status") != "authorizedByPlan":
        raise RuntimeError(f"Execution contract was not authorized by the accepted plan: {report}")
    if report.get("requiredPermissions"):
        raise RuntimeError(f"Accepted plan unexpectedly retained permission gaps: {report}")
    return action_bundle, contract


def execute_tool_actions(
    api: str,
    run_id: str,
    session_id: str,
    action_bundle: dict[str, Any],
    contract: dict[str, Any],
) -> dict[str, Any]:
    return kernel_command(
        api,
        {
            "kind": "actionBatchSubmit",
            "requestId": random_id("batch-submit"),
            "runId": run_id,
            "sessionId": session_id,
            "batch": {
                "planId": action_bundle["id"],
                "contractId": contract["id"],
                "contractHash": contract["contractHash"],
                "contentBlocks": [],
                "actionBundle": action_bundle,
            },
        },
    )


def verify_mixed_delete_and_atomic_preflight(
    api: str,
    workspace: pathlib.Path,
) -> dict[str, Any]:
    directory_target = random_id("delete-directory")
    file_targets = [random_id("delete-file") + ".txt" for _ in range(2)]
    directory_path = workspace / directory_target
    directory_path.mkdir()
    (directory_path / (random_id("child") + ".txt")).write_text(
        "child\n", encoding="utf-8"
    )
    for target in file_targets:
        (workspace / target).write_text("delete\n", encoding="utf-8")
    targets = [directory_target, *file_targets]
    run_id, session_id, authorization = authorize_tool_plan(
        api, workspace, "fs.delete", targets
    )
    operations = authorization.get("operations", [])
    if len(operations) != len(targets):
        raise RuntimeError(f"Mixed delete did not expand one operation per target: {authorization}")
    for index, (operation, target) in enumerate(zip(operations, targets), start=1):
        expected_kind = "directory" if index == 1 else "file"
        if operation.get("id") != f"plan-op-{operation.get('sourceTaskId')}-{index}":
            raise RuntimeError(f"Mixed delete operation id is not deterministic: {operation}")
        if operation.get("targets") != [target]:
            raise RuntimeError(f"Mixed delete operation target is not exact: {operation}")
        if operation.get("targetKind") != expected_kind:
            raise RuntimeError(f"Mixed delete target kind is not Kernel-resolved: {operation}")
        if operation.get("recursive") != (expected_kind == "directory"):
            raise RuntimeError(f"Mixed delete recursive semantics are incorrect: {operation}")
    permission_bundles = authorization.get("permissionBundles", [])
    if len(permission_bundles) != 1 or len(permission_bundles[0].get("operationIds", [])) != 3:
        raise RuntimeError(f"Mixed delete permissions were not merged: {authorization}")

    actions = [
        {
            "actionId": random_id("delete-action"),
            "toolId": "fs.delete",
            "args": {
                "path": target,
                "targetKind": "directory" if index == 0 else "file",
                "recursive": index == 0,
            },
            "description": "Delete one exact target from the accepted Kernel plan.",
            "dependsOn": [],
        }
        for index, target in enumerate(targets)
    ]
    action_bundle, contract = submit_tool_actions(
        api, run_id, session_id, authorization, actions
    )
    completed = execute_tool_actions(
        api, run_id, session_id, action_bundle, contract
    )
    if events(completed, "permission.requested"):
        raise RuntimeError(f"Mixed delete requested permission after Plan acceptance: {completed}")
    tool_events = events(completed, "tool.completed")
    if len([item for item in tool_events if item.get("toolName") == "fs.delete" and item.get("ok")]) != 3:
        raise RuntimeError(f"Mixed delete did not complete every exact operation: {completed}")
    if any((workspace / target).exists() for target in targets):
        raise RuntimeError("Mixed delete left an accepted target behind")

    drift_targets = [random_id("preflight-file") + ".txt" for _ in range(3)]
    for target in drift_targets:
        (workspace / target).write_text("keep until preflight passes\n", encoding="utf-8")
    drift_run, drift_session, drift_authorization = authorize_tool_plan(
        api, workspace, "fs.delete", drift_targets
    )
    drift_actions = [
        {
            "actionId": random_id("preflight-delete"),
            "toolId": "fs.delete",
            "args": {"path": target, "targetKind": "file", "recursive": False},
            "description": "Delete one exact file after batch preflight.",
            "dependsOn": [],
        }
        for target in drift_targets
    ]
    drift_bundle, drift_contract = submit_tool_actions(
        api, drift_run, drift_session, drift_authorization, drift_actions
    )
    drift_path = workspace / drift_targets[1]
    drift_path.unlink()
    drift_path.mkdir()
    failed = execute_tool_actions(
        api, drift_run, drift_session, drift_bundle, drift_contract
    )
    if events(failed, "work_unit.started") or events(failed, "tool.completed"):
        raise RuntimeError(f"Mutation batch started before all targets passed preflight: {failed}")
    failures = events(failed, "work_unit.failed")
    if not any(item.get("error", {}).get("code") == "mutation_batch_preflight_failed" for item in failures):
        raise RuntimeError(f"Mutation batch did not report its preflight failure: {failed}")
    if not all((workspace / target).exists() for target in drift_targets):
        raise RuntimeError("Mutation batch preflight failure allowed a partial delete")
    return {
        "operationCount": len(operations),
        "permissionBundleCount": len(permission_bundles),
        "completedDeleteCount": 3,
        "preflightStartedWorkUnits": 0,
        "preflightSideEffects": 0,
    }


def fnv1a64(value: str) -> str:
    result = 0xCBF29CE484222325
    for byte in value.encode("utf-8"):
        result ^= byte
        result = (result * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"fnv1a64:{result:016x}"


def submit_draft(
    api: str,
    run_id: str,
    session_id: str,
    task_id: str,
    draft_id: str,
    slot_id: str,
    content_lines: list[str],
) -> None:
    serialized_lines = json.dumps(content_lines, separators=(",", ":"))
    frames = [
        {
            "schemaVersion": DRAFT_SCHEMA_VERSION,
            "partKind": "artifactChunk",
            "draftId": draft_id,
            "frameId": random_id("draft-frame"),
            "runId": run_id,
            "sessionId": session_id,
            "taskId": task_id,
            "slotId": slot_id,
            "sequence": 1,
            "contentLines": content_lines,
            "finalChunk": True,
            "contentHash": fnv1a64(serialized_lines),
            "expectedSlotIds": [slot_id],
        },
        {
            "schemaVersion": DRAFT_SCHEMA_VERSION,
            "partKind": "batchDone",
            "draftId": draft_id,
            "frameId": random_id("draft-done"),
            "runId": run_id,
            "sessionId": session_id,
            "taskId": task_id,
            "sequence": 2,
            "contentHash": fnv1a64("complete"),
            "expectedSlotIds": [slot_id],
            "metadata": {"summary": "complete"},
        },
    ]
    for frame in frames:
        kernel_command(
            api,
            {
                "kind": "draftLedgerSubmit",
                "requestId": random_id("draft-submit"),
                "runId": run_id,
                "sessionId": session_id,
                "frame": frame,
            },
        )


def verify_restart_permission_resume(
    daemon: DaemonProcess,
    workspace: pathlib.Path,
) -> dict[str, Any]:
    planned = workspace / f"{random_id('planned')}.txt"
    expanded = workspace / f"{random_id('expanded')}.txt"
    planned.write_text("planned\n", encoding="utf-8")
    expanded.write_text("before\n", encoding="utf-8")
    session_id = random_id("resume-session")
    run_id, state = run_create(daemon.api, workspace, session_id)
    catalog = state["toolCatalogSnapshot"]
    plan_id = random_id("plan")
    plan_hash = random_id("plan-hash")
    task_id = random_id("task")
    reviewed = kernel_command(
        daemon.api,
        {
            "kind": "planAuthorizationSubmit",
            "requestId": random_id("plan-submit"),
            "runId": run_id,
            "sessionId": session_id,
            "intent": {
                "schemaVersion": TASK_INTENT_SCHEMA_VERSION,
                "planId": plan_id,
                "planHash": plan_hash,
                "runId": run_id,
                "sessionId": session_id,
                "workspaceBindingHash": None,
                "catalogVersion": catalog["catalogVersion"],
                "catalogHash": catalog["catalogHash"],
                "tasks": [
                    {
                        "taskId": task_id,
                        "toolId": "fs.write",
                        "targets": [planned.name],
                        "dependsOn": [],
                        "args": {},
                    }
                ],
            },
        },
    )
    review = event(reviewed, "plan_authorization.reviewed")["review"]
    if review.get("status") != "confirmable":
        raise RuntimeError(f"Plan authorization is not confirmable: {review}")
    authorization = review["authorizationContract"]
    kernel_command(
        daemon.api,
        {
            "kind": "planAuthorizationDecisionSubmit",
            "requestId": random_id("plan-decision"),
            "runId": run_id,
            "sessionId": session_id,
            "decision": {
                "decisionId": random_id("decision"),
                "authorizationContractId": authorization["id"],
                "planId": plan_id,
                "planHash": plan_hash,
                "contractHash": authorization["contractHash"],
                "decision": "accept",
            },
        },
    )

    draft_id = random_id("draft")
    slot_id = random_id("slot")
    block_id = f"block-{slot_id}"
    content_lines = ["after restart"]
    submit_draft(
        daemon.api,
        run_id,
        session_id,
        task_id,
        draft_id,
        slot_id,
        content_lines,
    )
    action_id = random_id("action")
    bundle_id = random_id("bundle")
    content_blocks = [
        {
            "blockId": block_id,
            "targetPath": expanded.name,
            "operation": "overwrite",
            "contentLines": content_lines,
        }
    ]
    action_bundle = {
        "id": bundle_id,
        "goal": "Verify durable permission resume.",
        "actions": [
            {
                "actionId": action_id,
                "toolId": "fs.write",
                "args": {"path": expanded.name, "contentBlockId": block_id},
                "description": "Write the expanded target.",
                "dependsOn": [],
            }
        ],
        "validationExpectations": [
            {"id": random_id("validation"), "description": "Record terminal facts."}
        ],
        "reviewExpectations": [
            {"id": random_id("review"), "description": "Report the write fact."}
        ],
    }
    proposal = kernel_command(
        daemon.api,
        {
            "kind": "proposalSubmit",
            "requestId": random_id("proposal-submit"),
            "runId": run_id,
            "sessionId": session_id,
            "proposal": {
                "schemaVersion": PROTOCOL_VERSION,
                "proposalId": random_id("proposal"),
                "runId": run_id,
                "sessionId": session_id,
                "source": "system",
                "kind": "actionBundle",
                "payload": {
                    "userPlanMarkdown": "Verify a gated write.",
                    "contentBlocks": content_blocks,
                    "actionBundle": action_bundle,
                    "authorizationContractId": authorization["id"],
                },
                "referencedResourcePacketRefs": [],
                "referencedEvidenceRefs": [],
                "parserDiagnostics": None,
            },
        },
    )
    report = event(proposal, "proposal.reviewed")["report"]
    contract = report["executionContract"]
    if contract.get("status") != "awaitingUserApproval":
        raise RuntimeError(f"Scope expansion did not enter Kernel gate: {report}")
    waiting = kernel_command(
        daemon.api,
        {
            "kind": "actionBatchSubmit",
            "requestId": random_id("batch-submit"),
            "runId": run_id,
            "sessionId": session_id,
            "batch": {
                "planId": bundle_id,
                "contractId": contract["id"],
                "contractHash": contract["contractHash"],
                "contentBlocks": content_blocks,
                "actionBundle": action_bundle,
            },
        },
    )
    permission = event(waiting, "permission.requested")["request"]
    daemon.stop()
    daemon.start()
    resumed = kernel_command(
        daemon.api,
        {
            "kind": "permissionResolve",
            "requestId": random_id("permission-resolve"),
            "permissionId": permission["id"],
            "decision": "accept",
        },
    )
    completed = events(resumed, "tool.completed")
    if not any(
        item.get("toolName") == "fs.write" and item.get("ok") is True
        for item in completed
    ):
        raise RuntimeError(f"Permission resume did not complete fs.write: {resumed}")
    if expanded.read_text(encoding="utf-8") != "after restart":
        raise RuntimeError("Permission resume did not write the restored draft content")
    facts = kernel_command(
        daemon.api,
        {
            "kind": "reviewFactsGet",
            "requestId": random_id("review-facts"),
            "runId": run_id,
            "sessionId": session_id,
        },
    )
    review_facts = event(facts, "review.facts_produced")["facts"]
    if not review_facts.get("batchReviewReady"):
        raise RuntimeError(f"Resumed batch did not become review ready: {review_facts}")
    return {
        "permissionId": permission["id"],
        "toolCompleted": True,
        "batchReviewReady": True,
    }


def verify_provider(
    cli_bin: pathlib.Path,
    provider_api: str,
    workspace: pathlib.Path,
    prompt: str,
) -> dict[str, Any]:
    if not provider_api.strip():
        return {"status": "blocked(provider_unconfigured)"}
    completed = subprocess.run(
        [
            str(cli_bin),
            "--api",
            provider_api,
            "--workspace",
            str(workspace),
            "ask",
            prompt,
            "--plain",
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"real Provider CLI verification failed: {completed.stderr.strip()}"
        )
    return {"status": "runtime-verified", "outputBytes": len(completed.stdout.encode())}


def main() -> int:
    args = parse_args()
    for path in (args.daemon_bin, args.cli_bin, args.cases):
        if not path.exists():
            raise SystemExit(f"required verification input does not exist: {path}")
    with tempfile.TemporaryDirectory(prefix="deepcode-kernel-cli-") as temporary:
        root = pathlib.Path(temporary)
        workspace = root / "workspace"
        external_root = root / "external"
        workspace.mkdir()
        with evidence_server() as endpoint:
            daemon = DaemonProcess(
                args.daemon_bin.resolve(), root / "runtime", reserve_port(), endpoint
            )
            daemon.runtime_root.mkdir()
            with daemon:
                report = {
                    "health": verify_health(daemon.api),
                    "toolMatrix": verify_cli_matrix(
                        args.cli_bin.resolve(),
                        daemon.api,
                        workspace,
                        args.cases.resolve(),
                        endpoint,
                    ),
                    "symlinkBoundary": verify_symlink_boundary(
                        args.cli_bin.resolve(),
                        daemon.api,
                        workspace,
                        external_root,
                    ),
                    "hostBridge": verify_host_bridge(daemon.api, workspace),
                    "externalResourceLease": verify_external_resource_lease(
                        daemon.api, workspace, external_root
                    ),
                    "mixedDeletePreflight": verify_mixed_delete_and_atomic_preflight(
                        daemon.api, workspace
                    ),
                    "orderedConflictAuthorization": verify_ordered_conflict_authorization(
                        daemon.api, workspace
                    ),
                    "permissionResume": verify_restart_permission_resume(
                        daemon, workspace
                    ),
                    "provider": verify_provider(
                        args.cli_bin.resolve(),
                        args.provider_api,
                        workspace,
                        args.provider_prompt,
                    ),
                }
        print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
