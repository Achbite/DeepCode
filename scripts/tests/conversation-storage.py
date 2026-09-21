#!/usr/bin/env python3
"""Real conversation storage regression using an isolated Host and local Provider."""
from __future__ import annotations

from contextlib import closing
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import urllib.parse
import urllib.request

spec = importlib.util.spec_from_file_location("deepcode_test_support", Path(__file__).with_name("support.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
require = fixture.require
LONG_TEXT = "  原始资料🙂\n" + "保留每一行与末尾空白。  \n" * 1200


class ProviderHandler(fixture.MockProviderHandler):
    def do_POST(self) -> None:
        try:
            require(self.path.endswith("/chat/completions"), "Unexpected Provider endpoint")
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            self.provider_state.requests.append(body)
            self.send_response(200)
            self.send_header("content-type", "text/event-stream; charset=utf-8")
            self.send_header("connection", "close")
            self.end_headers()
            self._send_text(f"storage-message-{len(self.provider_state.requests)}")
        except BaseException as error:
            self.provider_state.record_failure(error)
            self.close_connection = True


def session_path(session_id: str) -> str:
    return "/api/conversation/sessions/" + urllib.parse.quote(session_id, safe="")


def request(daemon, path: str, *, method: str = "GET", body=None):
    return fixture.api_json(daemon.base_url, path, token=daemon.token, method=method, body=body, timeout=15)


def submit(daemon, provider, session_id: str, ordinal: int, text: str, references=()):
    catalog = request(daemon, "/api/conversation/plugins")
    reply = request(daemon, session_path(session_id) + "/commands", method="POST", body={
        "schemaVersion": fixture.COMMAND_VERSION,
        "type": "message.submit",
        "commandId": f"command:storage-{ordinal}",
        "sessionId": session_id,
        "text": text,
        "filesystemReferences": list(references),
        "pluginCatalogRevision": catalog["revision"],
        "pluginSelections": [],
    })
    require(reply.get("status") == "accepted", "Message was not accepted")
    result = fixture.wait_completed(daemon, provider, session_id, f"storage message {ordinal}")
    require(len(provider.requests) == ordinal, "Message did not reach the local Provider exactly once")
    return result


def upload(daemon, session_id: str, input_id: str, content: str):
    path = session_path(session_id) + "/input-resources/" + urllib.parse.quote(input_id, safe="")
    outgoing = urllib.request.Request(
        daemon.base_url + path, data=content.encode("utf-8"), method="POST",
        headers={"content-type": "text/plain; charset=utf-8", fixture.HOST_TOKEN_HEADER: daemon.token},
    )
    with fixture.URL_OPENER.open(outgoing, timeout=15) as response:
        return json.load(response)


def workspace_rows(config_root: Path, session_id: str):
    database = config_root / "data/agent-runtime/catalog.sqlite3"
    with closing(fixture.sqlite_read_only(database)) as connection:
        rows = connection.execute(
            "SELECT w.workspace_id, w.canonical_root, s.workspace_id IS NOT NULL "
            "FROM workspaces w LEFT JOIN session_workdirs s USING(workspace_id) "
            "WHERE w.owner_session_id = ? ORDER BY w.workspace_id", (session_id,),
        ).fetchall()
    return {identity: (Path(path), bool(working)) for identity, path, working in rows}


def run_storage_checks(root: Path, server, provider) -> None:
    config_root = root / "用户 数据"
    fixture.write_configuration(config_root, f"http://127.0.0.1:{server.server_port}/v1", {})
    daemons = []
    try:
        daemon = fixture.OwnedDaemon(config_root)
        daemons.append(daemon)
        daemon.start()
        created = request(daemon, "/api/conversation/sessions", method="POST", body={})
        session_id = created["sessionId"]
        require(not created.get("workspaceBindings"), "Fixture unexpectedly has a project")
        submit(daemon, provider, session_id, 1, "Create this session's working directory.")
        rows = workspace_rows(config_root, session_id)
        workdirs = [(identity, path) for identity, (path, working) in rows.items() if working]
        require(len(workdirs) == 1, "First message did not create exactly one working directory")
        workdir_id, workdir = workdirs[0]
        require(workdir.is_dir(), "Registered working directory does not exist")
        separator = "-" if os.name == "nt" else ":"
        require(workdir.name == "sha256" + separator + hashlib.sha256(session_id.encode()).hexdigest(),
                "Working directory naming changed unexpectedly for this platform")
        saved_file = workdir / "保留 内容.txt"
        saved_file.write_text("retained across restart\n", encoding="utf-8")

        source = root / "附件 文本.txt"
        source.write_text("original attachment\n", encoding="utf-8")
        references = request(daemon, session_path(session_id) + "/filesystem-references/resolve",
                             method="POST", body={"references": [{"kind": "file", "path": str(source)}]})
        require(len(references) == 1, "Attachment was not imported")
        rows = workspace_rows(config_root, session_id)
        snapshot = rows[references[0]["workspaceId"]][0] / references[0]["logicalPath"]
        source.write_text("changed source\n", encoding="utf-8")
        require(snapshot.read_text(encoding="utf-8") == "original attachment\n", "Snapshot followed the source")

        input_id = "input:粘贴 文本"
        uploaded = upload(daemon, session_id, input_id, LONG_TEXT)
        require(uploaded.get("ok") is True, f"Upload failed: {uploaded}")
        reference = uploaded["data"]["reference"]
        key = json.dumps([session_id, input_id], ensure_ascii=False, separators=(",", ":"))
        digest = "sha256:" + hashlib.sha256(key.encode()).hexdigest()
        require(reference["referenceId"] == "input-" + digest, "Existing reference identity changed")
        require(reference["workspaceId"] == "input-workspace-" + digest, "Existing workspace identity changed")
        require(upload(daemon, session_id, input_id, LONG_TEXT) == uploaded, "Identical upload was not idempotent")
        conflict = upload(daemon, session_id, input_id, "different content")
        require(conflict.get("ok") is False and "input_resource_identity_conflict" in conflict.get("message", ""),
                "A conflicting upload did not preserve its original error")

        projection = submit(daemon, provider, session_id, 2, LONG_TEXT, [*references, reference])
        pasted = [item for message in projection["messages"] for item in message.get("filesystemReferences", [])
                  if item.get("source") == "pastedText"]
        require(len({item["referenceId"] for item in pasted}) == 2, "Long message did not create its own text reference")
        rows = workspace_rows(config_root, session_id)
        for item in pasted:
            path = rows[item["workspaceId"]][0] / item["logicalPath"]
            require(path.read_bytes() == LONG_TEXT.encode(), "Stored text bytes changed")
        owned_paths = [path for path, _ in rows.values()]
        attachments_root = next(path for path, working in rows.values() if not working).parent
        daemon.shutdown()

        reopened = fixture.OwnedDaemon(config_root)
        daemons.append(reopened)
        reopened.start()
        require(saved_file.read_text(encoding="utf-8") == "retained across restart\n", "Saved file was lost")
        require(upload(reopened, session_id, input_id, LONG_TEXT) == uploaded, "Restart changed upload identity")
        submit(reopened, provider, session_id, 3, "Continue this same conversation.")
        reopened_rows = workspace_rows(config_root, session_id)
        require(reopened_rows == rows, "Restart or next message changed registered storage")
        require(reopened_rows[workdir_id] == (workdir, True), "Working directory was not reused")
        require(snapshot.read_text(encoding="utf-8") == "original attachment\n", "Restart lost the snapshot")
        request(reopened, session_path(session_id), method="DELETE")
        require(not workspace_rows(config_root, session_id), "Session deletion retained owned catalog entries")
        require(not attachments_root.exists(), "Session deletion retained the attachment directory")
        require(all(not path.exists() for path in owned_paths), "Session deletion retained owned storage")
        require(source.read_text(encoding="utf-8") == "changed source\n", "Session deletion touched the source")
        reopened.shutdown()
        provider.assert_healthy()
        print(f"[PASS] conversation storage ({os.name}): first message, attachment snapshot, text identities, "
              "conflict, long message, restart, reuse and cleanup", flush=True)
    finally:
        for daemon in reversed(daemons):
            daemon.close()


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="dc-storage-") as temporary:
        root = Path(temporary)
        provider = fixture.ProviderState(root)
        with http.server.ThreadingHTTPServer(("127.0.0.1", 0), ProviderHandler) as server:
            server.provider_state = provider
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                run_storage_checks(root, server, provider)
            finally:
                server.shutdown()
                thread.join(timeout=5)


if __name__ == "__main__":
    main()
