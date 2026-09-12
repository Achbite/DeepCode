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
            elif "command" in properties and "timeout" in properties:
                names["bash"] = function["name"]
            elif "mutationManifest" in properties:
                names["plan"] = function["name"]
            elif "sourceFactRef" in properties:
                names["progress"] = function["name"]
        require(len(names) == 5, f"缺少本次工具目录：{names}")
        return ordinal, names, results


class ProviderHandler(fixture.MockProviderHandler):
    def do_POST(self) -> None:  # noqa: N802
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
                    "steps": [{"stepId": "edit", "title": "修改文本", "details": "将 alpha 改为 ALPHA；检查失败批次不会部分落盘。"}],
                    "mutationManifest": [
                        {"workspace": "primary", "operation": "fs.edit", "target": "probe.txt"},
                        {"workspace": "primary", "operation": "bash", "workspaceMode": "write", "executionScope": "workspace", "command": "make build", "writablePaths": [{"path": "build", "kind": "directory"}]},
                    ],
                })])
            elif ordinal == 3:
                self._send_tool_calls([("edit-mismatch", names["edit"], {"path": "probe.txt", "edits": [
                    {"oldText": "alpha", "newText": "ALPHA"},
                    {"oldText": "missing", "newText": "replacement"},
                ]})])
            elif ordinal == 4:
                failed = results["edit-mismatch"]
                require(failed["outcome"] == "failed" and failed["error"]["code"] == "patch_match_not_found", "编辑原始错误码丢失")
                require(failed["output"]["details"]["editIndex"] == 1, "编辑诊断没有失败索引")
                require((self.provider_state.workspace / "probe.txt").read_text() == "alpha\nbeta\n", "失败批次部分修改了文件")
                self._send_tool_calls([("edit-corrected", names["edit"], {"path": "probe.txt", "edits": [{"oldText": "alpha", "newText": "ALPHA"}]})])
            elif ordinal == 5:
                require(results["edit-corrected"]["outcome"] == "completed", "纠正后编辑失败")
                require((self.provider_state.workspace / "probe.txt").read_text() == "ALPHA\nbeta\n", "修改内容不正确")
                todo = next(value for value in reversed(json_payloads(body)) if value.get("type") == "todo.current")
                self._send_tool_calls([("progress", names["progress"], {
                    "sourceFactRef": results["edit-corrected"]["recordId"],
                    "updates": [{"todoId": item["todoId"], "status": "completed"} for item in todo["items"]],
                })])
            elif ordinal == 6:
                self._send_text("tool-input-cli-complete")
            elif ordinal == 7:
                message = next(message for message in reversed(body["messages"]) if message["role"] == "user")
                content = message["content"]
                require(LONG_INPUT not in content, "原文被重复塞入 Provider 文本")
                require("nextByte" in content, "模型未收到原文读取指导")
                references = json.loads(content[content.index("[{\"referenceId\""):])
                reference = next(item for item in references if item.get("source") == "pastedText")
                self._send_tool_calls([("read-pasted", names["read"], {"workspace": reference["workspace"], "path": reference["path"], "maxLines": 5000})])
            elif ordinal == 8:
                require(results["read-pasted"]["output"]["content"] == LONG_INPUT, "读取到的粘贴文本不完整")
                self._send_text("pasted-text-cli-complete")
            else:
                raise AssertionError(f"多余 Provider 请求：{ordinal}")
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
            daemon.start()
            session = fixture.create_session(daemon, workspace)
            session_id = session["sessionId"]
            cli(daemon, session_id, "读取 probe.txt，检查工具反馈并按 Plan 修复。", expected=5)
            state.assert_healthy()
            waiting = fixture.projection(daemon, session_id)
            require(waiting["pendingPlan"]["mutationManifest"][1]["writablePaths"] == [{"path": "build", "kind": "directory"}], "Plan 写入范围未保留")
            require("tool-input-cli-complete" in cli(daemon, session_id, "确认").stdout, "CLI 未输出完成正文")
            state.assert_healthy()
            require("pasted-text-cli-complete" in cli(daemon, session_id, LONG_INPUT).stdout, "CLI 未完成粘贴原文读取")
            state.assert_healthy()
            completed = fixture.projection(daemon, session_id)
            require(completed["run"]["status"] == "completed", "最终 Session 未完成")
            user = next(message for message in reversed(completed["messages"]) if message["role"] == "user")
            require(user["content"] == "", "长文本转换泄漏了内部指导到用户气泡")
            require(user["filesystemReferences"][0]["source"] == "pastedText", "长文本来源丢失")
            daemon.shutdown()
            runtime = daemon.config_root / "runtime" / "agent-runtime"
            with fixture.sqlite_read_only(runtime / "session.sqlite3") as connection:
                rows = connection.execute("SELECT event_type, call_id, payload_json FROM session_events WHERE session_id=? ORDER BY sequence", (session_id,)).fetchall()
                requested = {call_id for kind, call_id, _ in rows if kind == "tool.requested"}
                terminal = {call_id for kind, call_id, _ in rows if kind in {"tool.completed", "tool.input-rejected", "tool.interrupted"}}
                require(requested == terminal, "工具调用缺少持久化终态")
                require(sum(kind == "run.runtime.released" for kind, _, _ in rows) == 2, "两个 run 未全部释放 runtime")
            with fixture.sqlite_read_only(runtime / "tool-record.sqlite3") as connection:
                records = [json.loads(row[0]) for row in connection.execute("SELECT record_json FROM tool_records WHERE session_id=?", (session_id,))]
                shell = next(record for record in records if record["toolName"] == "bash")
                require(shell["input"]["command"] == SCRIPT, "Bash 脚本被改写")
                require(any(record.get("error", {}).get("code") == "patch_match_not_found" for record in records), "原始编辑失败未落库")
            require(len(state.requests) == 8, "Provider 调用次数不符")
            print("[cli-e2e] PASS: tool defaults/rejections, atomic edit/correction, Plan, pasted text, paired history and runtime cleanup (fixture Provider; no GUI)")
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
