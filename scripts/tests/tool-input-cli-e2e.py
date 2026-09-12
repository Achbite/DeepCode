#!/usr/bin/env python3
"""Real CLI/Session/Kernel regression with deterministic Provider inputs; no GUI/TUI."""

from __future__ import annotations

import http.server
import importlib.util
import json
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Any


spec = importlib.util.spec_from_file_location(
    "local_agent_e2e", Path(__file__).with_name("local-agent-e2e.py")
)
assert spec is not None and spec.loader is not None
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
require = fixture.require
LONG_INPUT = "  原始任务与资料🙂\n" + "保持原文空白与每一项约束。  \n" * 2200
SCRIPT = "value='hello world'\nprintf '%s\\n' \"$value\"\ncat <<'END'\nliteral $value\nEND\n"
PHASES = [{"stepId": f"phase-{index}", "title": f"验证阶段 {index}", "details": "检查文本修改与执行结果。",
           "verification": [f"核对结果 {check}" for check in range(9)]} for index in range(13)]
WRITE_PATHS = [{"path": "build", "kind": "directory"}] + [
    {"path": f"build/output-{index}", "kind": "directory"} for index in range(128)
]
INTRO = {"type": "message", "id": "msg_cli_intro", "role": "assistant", "phase": "commentary",
         "status": "completed", "content": [{"type": "output_text", "text": "I will inspect the current file."}]}


def json_payloads(body: dict[str, Any]) -> list[dict[str, Any]]:
    result = []
    for message in body["messages"]:
        try:
            value = json.loads(message.get("content") or "")
            if isinstance(value, dict):
                result.append(value)
        except ValueError:
            pass
    return result


class ProviderState:
    def __init__(self, workspace: Path) -> None:
        self.workspace = workspace
        self.requests: list[dict[str, Any]] = []
        self.responses_requests: list[dict[str, Any]] = []
        self.failure: BaseException | None = None

    def record_failure(self, error: BaseException) -> None:
        self.failure = error

    def assert_healthy(self) -> None:
        if self.failure is not None:
            raise AssertionError(f"Provider fixture assertion: {self.failure}") from self.failure

    def inspect(self, body: dict[str, Any]) -> tuple[int, dict[str, str], dict[str, Any]]:
        self.requests.append(body)
        ordinal = len(self.requests)
        require(body["tools"] == self.requests[0]["tools"], "工具目录在轮次间变化")
        prefix = self.requests[0]["messages"]
        require(body["messages"][:len(prefix)] == prefix, "稳定消息前缀被重写")
        pending: set[str] = set()
        results = {}
        for message in body["messages"]:
            calls = message.get("tool_calls", [])
            if calls:
                require(not pending, "前一批工具调用尚未返回结果")
                pending.update(call["id"] for call in calls)
            elif message["role"] == "tool":
                call_id = message["tool_call_id"]
                require(call_id in pending, "工具结果没有对应调用")
                pending.remove(call_id)
                results[call_id] = json.loads(message["content"])
            else:
                require(not pending, "工具结果之前插入了下一条消息")
        require(not pending, "Provider 收到了缺失工具结果的历史")
        names = {}
        for tool in body["tools"]:
            function = tool["function"]
            properties = function["parameters"].get("properties", {})
            if "path" in properties and "startByte" in properties:
                names["read"] = function["name"]
                require("workspace" not in function["parameters"]["required"], "workspace 缺省未开放")
            elif "edits" in properties:
                names["edit"] = function["name"]
            elif "path" in properties and "content" in properties:
                names["write"] = function["name"]
            elif "command" in properties and "timeout" in properties:
                names["bash"] = function["name"]
            elif "mutationManifest" in properties:
                names["plan"] = function["name"]
            elif "sourceFactRef" in properties:
                names["progress"] = function["name"]
        require(len(names) == 6, f"缺少本次工具目录：{names}")
        return ordinal, names, results


class ProviderHandler(fixture.MockProviderHandler):
    def do_POST(self) -> None:  # noqa: N802
        if self.path.endswith("/responses"):
            self.respond_native()
            return
        headers_sent = False
        try:
            require(self.path.endswith("/chat/completions"), "Provider endpoint 不匹配")
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            ordinal, names, results = self.provider_state.inspect(body)
            self.send_response(200)
            self.send_header("content-type", "text/event-stream; charset=utf-8")
            self.send_header("connection", "close")
            self.end_headers()
            headers_sent = True
            if ordinal == 1:
                self._send_tool_calls([
                    ("read-default", names["read"], {"path": "probe.txt"}),
                    ("bad-timeout", names["bash"], {"command": "pwd", "executionScope": "host", "timeout": 601}),
                    ("bad-field", names["edit"], {"path": "probe.txt", "workspaceMode": "write", "edits": [{"oldText": "alpha", "newText": "ALPHA"}]}),
                    ("bad-workspace", names["read"], {"path": "probe.txt", "workspace": "workspace99"}),
                    ("shell-format", names["bash"], {"command": SCRIPT, "executionScope": "host"}),
                ])
            elif ordinal == 2:
                require(results["read-default"]["outcome"] == "completed", "默认 workspace 文件读取失败")
                for call_id, path, rule in [("bad-timeout", "$.timeout", "maximum"), ("bad-field", "$.workspaceMode", "additionalProperties")]:
                    rejected = results[call_id]
                    require(rejected["status"] == "inputRejected" and rejected["executed"] is False, "非法输入被执行")
                    require(any(issue["path"] == path and issue["rule"] == rule for issue in rejected["error"]["issues"]), "字段诊断没有到达 Provider")
                require("primary" in results["bad-workspace"]["error"]["message"], "句柄拒绝未列出合法值")
                require(results["shell-format"]["outcome"] == "completed", "合法多行命令未执行")
                self._send_tool_calls([("plan", names["plan"], {
                    "title": "修复 probe.txt", "summary": "按读取到的文本修改并验证。",
                    "steps": PHASES,
                    "mutationManifest": [
                        {"workspace": "primary", "operation": "fs.edit", "target": "probe.txt"},
                        {"workspace": "primary", "operation": "bash", "workspaceMode": "write", "executionScope": "workspace", "command": "make build", "writablePaths": WRITE_PATHS},
                        {"workspace": "primary", "operation": "fs.edit", "target": "src", "targetKind": "directoryTree"},
                    ] + [{"workspace": "primary", "operation": "fs.write", "target": f"reserved/target-{index}.txt"} for index in range(126)],
                })])
            elif ordinal == 3:
                self._send_tool_calls([("edit-mismatch", names["edit"], {"path": "probe.txt", "edits": [
                    {"oldText": "alpha", "newText": "ALPHA"},
                    {"oldText": "missing", "newText": "replacement"},
                ]}),
                    ("directory-create", names["write"], {"path": "src/nested/new.txt", "content": "created within approved directory\n"}),
                    ("outside-scope", names["write"], {"path": "extra/new.txt", "content": "expanded scope\n"}),
                ])
            elif ordinal == 4:
                require(results["directory-create"]["outcome"] == "completed", "目录授权未覆盖后代新文件")
                require((self.provider_state.workspace / "src/nested/new.txt").read_text() == "created within approved directory\n", "目录内文件内容不符")
                denied = results["outside-scope"]
                require(denied["outcome"] == "denied" and denied["error"]["code"] == "workspace_mutation_plan_required", "范围外写入未被拒绝")
                require("extra/new.txt" in denied["error"]["message"] and "directoryTree" in denied["error"]["message"], "拒绝未说明目标和已确认范围")
                require(not (self.provider_state.workspace / "extra/new.txt").exists(), "未确认的范围已执行")
                failed = results["edit-mismatch"]
                require(failed["outcome"] == "failed" and failed["error"]["code"] == "patch_match_not_found", "编辑原始错误码丢失")
                require(failed["output"]["details"]["editIndex"] == 1, "编辑诊断没有失败索引")
                require((self.provider_state.workspace / "probe.txt").read_text() == "alpha\nbeta\n", "失败批次部分修改了文件")
                self._send_tool_calls([("edit-corrected", names["edit"], {"path": "probe.txt", "edits": [{"oldText": "alpha", "newText": "ALPHA"}]})])
            elif ordinal == 5:
                require(results["edit-corrected"]["outcome"] == "completed", "纠正后编辑失败")
                require((self.provider_state.workspace / "probe.txt").read_text() == "ALPHA\nbeta\n", "修改内容不正确")
                preview = results["edit-corrected"]["output"]["editPreview"]
                require(preview["hunks"][0]["before"] == "alpha\n" and preview["hunks"][0]["after"] == "ALPHA\n" and not preview["truncated"], "实际编辑摘要未到达模型")
                todo = next(value for value in reversed(json_payloads(body)) if value.get("type") == "todo.current")
                self._send_tool_calls([("progress", names["progress"], {
                    "sourceFactRef": results["edit-corrected"]["recordId"],
                    "updates": [{"todoId": item["todoId"], "status": "completed" if index == 0 else "inProgress"} for index, item in enumerate(todo["items"])],
                })])
            elif ordinal == 6:
                self._send_tool_calls([("extend-scope", names["plan"], {
                    "mode": "extendScope", "summary": "新增 extra 目录写入范围，阶段及验收不变。",
                    "mutationManifest": [{"workspace": "primary", "operation": "fs.write", "target": "extra", "targetKind": "directoryTree"}],
                })])
            elif ordinal == 7:
                todo = next(value for value in reversed(json_payloads(body)) if value.get("type") == "todo.current")
                require(todo["sourcePlanRevision"] == 2 and [item["status"] for item in todo["items"]] == ["completed"] + ["inProgress"] * 12, "确认范围补充丢失阶段进度")
                self._send_tool_calls([
                    ("expanded-create", names["write"], {"path": "extra/new.txt", "content": "expanded scope\n"}),
                    ("pipeline-status", names["bash"], {"executionScope": "host", "command": "set -o pipefail\n(printf 'expected failure\\n'; exit 7) | tail -1"}),
                    ("expected-nonzero", names["bash"], {"executionScope": "host", "command": "if (exit 7); then rc=0; else rc=$?; fi\ntest \"$rc\" -eq 7"}),
                ])
            elif ordinal == 8:
                require(results["expanded-create"]["outcome"] == "completed", "确认范围补充后未执行")
                require((self.provider_state.workspace / "extra/new.txt").read_text() == "expanded scope\n", "补范围后内容不符")
                require(results["pipeline-status"]["outcome"] == "failed" and results["pipeline-status"]["output"]["exitCode"] == 7, "管道原始失败退出码丢失")
                require(results["expected-nonzero"]["outcome"] == "completed", "预期非零处理失败")
                todo = next(value for value in reversed(json_payloads(body)) if value.get("type") == "todo.current")
                self._send_tool_calls([("progress-final", names["progress"], {
                    "sourceFactRef": results["expanded-create"]["recordId"],
                    "updates": [{"todoId": item["todoId"], "status": "completed"} for item in todo["items"]],
                })])
            elif ordinal == 9:
                self._send_text("tool-input-cli-complete")
            elif ordinal == 10:
                message = next(message for message in reversed(body["messages"]) if message["role"] == "user")
                content = message["content"]
                require(LONG_INPUT not in content, "原文被重复塞入 Provider 文本")
                require("nextByte" in content, "模型未收到原文读取指导")
                references = json.loads(content[content.index("[{\"referenceId\""):])
                reference = next(item for item in references if item.get("source") == "pastedText")
                self._send_tool_calls([("read-pasted", names["read"], {"workspace": reference["workspace"], "path": reference["path"], "maxLines": 5000})])
            elif ordinal == 11:
                require(results["read-pasted"]["output"]["content"] == LONG_INPUT, "读取到的粘贴文本不完整")
                self._send_text("pasted-text-cli-complete")
            else:
                raise AssertionError(f"多余 Provider 请求：{ordinal}")
        except BaseException as error:
            self.provider_state.record_failure(error)
            if not headers_sent:
                self.send_error(500)
            self.close_connection = True

    def respond_native(self) -> None:
        headers_sent = False
        try:
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            requests = self.provider_state.responses_requests
            requests.append(body)
            ordinal = len(requests)
            require(body["tools"] == requests[0]["tools"], "Responses 工具目录发生变化")
            require(body["input"][:len(requests[0]["input"])] == requests[0]["input"], "Responses 稳定前缀被重写")
            if ordinal == 1:
                item = INTRO
            elif ordinal == 2:
                require(INTRO in body["input"], "独立 commentary 没有按原生项重放")
                read_tool = next(tool for tool in body["tools"] if "startByte" in tool.get("parameters", {}).get("properties", {}))
                item = {"type": "function_call", "id": "fc_cli_read", "call_id": "call_cli_read", "name": read_tool["name"],
                        "arguments": json.dumps({"path": "probe.txt"}), "status": "completed"}
            elif ordinal == 3:
                output = next(item for item in body["input"] if item.get("type") == "function_call_output" and item.get("call_id") == "call_cli_read")
                result = json.loads(output["output"])
                require(result["outcome"] == "completed" and result["output"]["content"] == "ALPHA\nbeta\n", "续跑中的真实工具结果缺失")
                item = {**INTRO, "id": "msg_cli_final", "phase": "final_answer",
                        "content": [{"type": "output_text", "text": "commentary-cli-complete"}]}
            else:
                raise AssertionError(f"多余 Responses 请求：{ordinal}")
            self.send_response(200)
            self.send_header("content-type", "text/event-stream; charset=utf-8")
            self.send_header("connection", "close")
            self.end_headers()
            headers_sent = True
            events = []
            if item["type"] == "message":
                events.append({"type": "response.output_text.delta", "output_index": 0, "delta": item["content"][0]["text"]})
            events.extend([
                {"type": "response.output_item.done", "output_index": 0, "item": item},
                {"type": "response.completed", "response": {}},
            ])
            for event in events:
                self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                self.wfile.flush()
        except BaseException as error:
            self.provider_state.record_failure(error)
            if not headers_sent:
                self.send_error(500)
            self.close_connection = True


def cli(daemon: Any, session_id: str, text: str, expected: int = 0) -> subprocess.CompletedProcess[str]:
    result = subprocess.run([
        str(fixture.CLI_BINARY), "--api", daemon.base_url, "--no-auto-start-kernel",
        "--session", session_id, "--plain", "ask", text,
    ], cwd=fixture.ROOT, env=fixture.shell_environment(daemon), capture_output=True, text=True, timeout=45)
    require(result.returncode == expected, f"CLI 退出 {result.returncode}，预期 {expected}\n{result.stdout}\n{result.stderr}")
    return result


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="deepcode-tool-input-cli-") as directory:
        root = Path(directory)
        workspace = root / "workspace"
        workspace.mkdir()
        (workspace / "probe.txt").write_text("alpha\nbeta\n")
        state = ProviderState(workspace)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), ProviderHandler)
        server.provider_state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        daemon = fixture.OwnedDaemon(root / "config")
        try:
            fixture.write_configuration(daemon.config_root, f"http://127.0.0.1:{server.server_port}/v1", {
                "agent.permissions.workspaceMutation": "plan", "agent.permissions.external": "allow",
            })
            profiles_path = daemon.config_root / "config/user/local/settings/llm-profiles.json"
            profiles = json.loads(profiles_path.read_text())
            profiles["profiles"][0]["maxOutputTokens"] = 16384
            profiles["profiles"].append({**profiles["profiles"][0], "id": "e2e-responses", "kind": "responses"})
            profiles_path.write_text(json.dumps(profiles))
            daemon.start()
            session = fixture.create_session(daemon, workspace)
            session_id = session["sessionId"]
            cli(daemon, session_id, "读取 probe.txt，检查工具反馈并按 Plan 修复。", expected=5)
            state.assert_healthy()
            waiting = fixture.projection(daemon, session_id)
            require(waiting["pendingPlan"]["mutationManifest"][1]["writablePaths"] == WRITE_PATHS, "Plan 写入范围未完整保留")
            require(len(waiting["pendingPlan"]["steps"]) == 13 and len(waiting["pendingPlan"]["mutationManifest"]) == 129, "计划被旧数量限制截断")
            first_plan = waiting["pendingPlan"]
            cli(daemon, session_id, "确认", expected=5)
            state.assert_healthy()
            extension = fixture.projection(daemon, session_id)
            require(extension["pendingPlan"]["planId"] == first_plan["planId"] and extension["pendingPlan"]["revision"] == 2, "范围补充没有沿用当前 Plan")
            require(extension["pendingPlan"]["steps"] == first_plan["steps"], "只补范围重写了阶段或验收")
            require(extension["pendingPlan"]["summary"].startswith(first_plan["summary"] + "\n\n"), "只补范围丢失原目标摘要")
            require(len(extension["pendingPlan"]["mutationManifest"]) == 130, "范围补充未保留完整原清单")
            expected_statuses = ["completed"] + ["inProgress"] * 12
            require([item["status"] for item in extension["todoList"]["items"]] == expected_statuses, "待确认修订重置进度")
            require(not (workspace / "extra/new.txt").exists(), "范围补充确认前发生写入")
            require("tool-input-cli-complete" in cli(daemon, session_id, "确认").stdout, "CLI 未输出完成正文")
            state.assert_healthy()
            after_extension = fixture.projection(daemon, session_id)
            require(after_extension["plans"][-1]["steps"] == first_plan["steps"], "确认后阶段及验收被重写")
            require([item["todoId"] for item in after_extension["todoList"]["items"]] == [item["todoId"] for item in extension["todoList"]["items"]], "确认后 Todo 身份改变")
            require("pasted-text-cli-complete" in cli(daemon, session_id, LONG_INPUT).stdout, "CLI 未完成粘贴原文读取")
            state.assert_healthy()
            completed = fixture.projection(daemon, session_id)
            require(completed["run"]["status"] == "completed", "最终 Session 未完成")
            user = next(message for message in reversed(completed["messages"]) if message["role"] == "user")
            require(user["content"] == "", "长文本转换泄漏了内部指导到用户气泡")
            require(user["filesystemReferences"][0]["source"] == "pastedText", "长文本来源丢失")
            require(len(completed["todoList"]["items"]) == 13 and all(item["status"] == "completed" for item in completed["todoList"]["items"]), "阶段进度没有完整更新")
            native_session_id = fixture.create_session(daemon, workspace)["sessionId"]
            reply = fixture.api_json(daemon.base_url, f"/api/conversation/sessions/{native_session_id}/commands", token=daemon.token, method="POST", body={
                "schemaVersion": "deepcode.command.v3", "type": "session.model-settings.set", "commandId": "command:responses-profile",
                "sessionId": native_session_id, "settings": {"profileId": "e2e-responses", "reasoningEffortOverride": None},
            })
            require(reply["status"] == "accepted", "Responses profile 未接受")
            native_output = cli(daemon, native_session_id, "检查当前文件并说明结果。")
            require("commentary-cli-complete" in native_output.stdout, "CLI 在过程说明后提前结束")
            state.assert_healthy()
            native_projection = fixture.projection(daemon, native_session_id)
            require(native_projection["run"]["status"] == "completed", "commentary 续跑未完成")
            daemon.shutdown()
            runtime = daemon.config_root / "runtime" / "agent-runtime"
            with fixture.sqlite_read_only(runtime / "session.sqlite3") as connection:
                rows = connection.execute("SELECT event_type, call_id, payload_json FROM session_events WHERE session_id IN (?,?) ORDER BY session_id, sequence", (session_id, native_session_id)).fetchall()
                requested = {call_id for kind, call_id, _ in rows if kind == "tool.requested"}
                terminal = {call_id for kind, call_id, _ in rows if kind in {"tool.completed", "tool.input-rejected", "tool.interrupted"}}
                require(requested == terminal, "工具调用缺少持久化终态")
                require(sum(kind == "run.runtime.released" for kind, _, _ in rows) == 3, "三个 run 未全部释放 runtime")
                native_run = native_projection["run"]["runId"]
                native_events = [json.loads(row[0]) for row in connection.execute(
                    "SELECT payload_json FROM session_events WHERE session_id=? AND run_id=? AND event_type='provider.turn.settled' ORDER BY sequence", (native_session_id, native_run))]
                require(len(native_events) == 3, "独立说明、工具调用和最终回答没有保持同一 run")
                require(native_events[0]["orderedCallIds"] == [] and native_events[0]["orderedOutputBlocks"][0]["kind"] == "narrative", "commentary 被持久化为最终答复")
            with fixture.sqlite_read_only(runtime / "tool-record.sqlite3") as connection:
                records = [json.loads(row[0]) for row in connection.execute("SELECT record_json FROM tool_records WHERE session_id=?", (session_id,))]
                shell = next(record for record in records if record["toolName"] == "bash")
                require(shell["input"]["command"] == SCRIPT, "Bash 脚本被改写")
                require(any(record.get("error", {}).get("code") == "patch_match_not_found" for record in records), "原始编辑失败未落库")
            require(len(state.requests) == 11, "Provider 调用次数不符")
            require(len(state.responses_requests) == 3, "Responses 续跑调用次数不符")
            print("[cli-e2e] PASS: directory scope, denied outside write, confirmed scope extension preserving phases, edit preview and shell exit status; 13 phases/129 initial targets, pasted text, native commentary/tool/final continuation, paired history and 3 runtime releases (fixture Provider; no GUI)")
        except BaseException:
            state.assert_healthy()
            print(daemon.log_tail())
            raise
        finally:
            daemon.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)
            require(not thread.is_alive(), "Provider fixture 未退出")


if __name__ == "__main__":
    main()
