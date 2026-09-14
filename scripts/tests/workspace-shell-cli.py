#!/usr/bin/env python3
"""Focused CLI/Plan/workspace Shell check on Linux or initialized native Windows.

Uses the existing local-agent fixture only for deterministic Provider input and
owned Host lifecycle. Commands, Plan confirmation and outputs use the real CLI.
"""
import http.server
from contextlib import closing
import importlib.util
import json
import os
import sqlite3
from pathlib import Path
import subprocess
import tempfile
import threading

spec = importlib.util.spec_from_file_location("cli_fixture", Path(__file__).with_name("tool-input-cli-e2e.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
base = fixture.fixture
require = base.require
WINDOWS = os.name == 'nt'
SHELL = 'powershell' if WINDOWS else 'bash'


def command(bash, powershell):
    return powershell if WINDOWS else bash

class State(fixture.ProviderState):
    pass

class Provider(base.MockProviderHandler):
    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            ordinal, names, results = self.provider_state.inspect(body)
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.send_header('connection', 'close')
            self.end_headers()
            def shell(call, command, **extra):
                return (call, names['bash'], {'command': command, 'executionScope': 'workspace', 'workspaceMode': 'read', **extra})
            if ordinal == 1:
                self._send_tool_calls([
                    shell('read', command("printf 'workspace-cli 中文\\n'; git branch --show-current; node --version; cat README.txt", "Write-Output 'workspace-cli 中文'; whoami; node --version; Get-ChildItem -Force; Get-Content -LiteralPath README.txt -Encoding UTF8")),
                    shell('readonly', command('printf unexpected > readonly.txt', "$ErrorActionPreference = 'Stop'; Set-Content readonly.txt unexpected")),
                ])
            elif ordinal == 2:
                require(results['read']['outcome'] == 'completed', results['read'])
                require('workspace-cli 中文' in results['read']['output']['stdout'], 'Unicode output missing')
                require('workspace-read-ok' in results['read']['output']['stdout'], 'Workspace file was not read')
                if WINDOWS:
                    require('deepcode_' in results['read']['output']['stdout'].lower(), 'Shell did not run under the dedicated account')
                require(results['readonly']['outcome'] == 'failed', results['readonly'])
                require(results['readonly']['output']['exitCode'] != 0, 'Read-only write reported success')
                self._send_tool_calls([('plan', names['plan'], {
                    'title': 'Generate an output file', 'summary': 'Write only within build, then verify command results.',
                    'steps': [{'stepId': 'generate', 'title': 'Generate and verify', 'details': 'Exercise the workspace Shell.', 'verification': ['Output exists; unrelated paths remain unchanged.']}],
                    'mutationManifest': [{'workspace': 'primary', 'operation': SHELL, 'executionScope': 'workspace', 'workspaceMode': 'write', 'command': 'generate build output', 'writablePaths': [{'path': 'build', 'kind': 'directory'}]}],
                })])
            elif ordinal == 3:
                self._send_tool_calls([shell('write', command("printf 'generated 中文\\n' > build/output.txt; cat build/output.txt", "$ErrorActionPreference = 'Stop'; [IO.File]::WriteAllText((Join-Path (Get-Location) 'build/output.txt'), \"generated 中文`n\"); Get-Content build/output.txt"), workspaceMode='write')])
            elif ordinal == 4:
                require(results['write']['outcome'] == 'completed', results['write'])
                self._send_tool_calls([shell('outside', command("printf unexpected > ../outside.txt", "$ErrorActionPreference = 'Stop'; Set-Content ../outside.txt unexpected"), workspaceMode='write')])
            elif ordinal == 5:
                require(results['outside']['outcome'] == 'failed', results['outside'])
                require(results['outside']['output']['exitCode'] != 0, 'Outside write reported success')
                self._send_tool_calls([
                    shell('nonzero', command("printf 'expected-failure\\n'; exit 7", "Write-Output 'expected-failure'; exit 7")),
                    shell('pty', command('read -r value; printf "PTY:%s\\n" "$value"; test -t 0', "$value = [Console]::ReadLine(); Write-Output \"PTY:$value\"; if ([Console]::IsInputRedirected) { exit 9 }"), terminal={'stdin': 'hello-terminal\n'}),
                    shell('network', command("python3 - <<'PY'\nimport socket\ntry:\n    socket.socket()\nexcept PermissionError:\n    print('offline-workspace')\nelse:\n    raise AssertionError('workspace socket was allowed')\nPY", f"$ErrorActionPreference = 'Stop'; $client = [Net.Sockets.TcpClient]::new(); try {{ $client.Connect('127.0.0.1', {self.server.server_port}); throw 'workspace network was allowed' }} catch {{ if ($_.Exception.InnerException -isnot [Net.Sockets.SocketException] -or $_.Exception.InnerException.SocketErrorCode -ne [Net.Sockets.SocketError]::AccessDenied) {{ throw }}; Write-Output 'offline-workspace' }} finally {{ $client.Dispose() }}")),
                    shell('timeout', command('sleep 30 & wait', 'Start-Sleep -Seconds 30'), timeout=1),
                ])
            elif ordinal == 6:
                require(results['nonzero']['output']['exitCode'] == 7, results['nonzero'])
                require(results['pty']['outcome'] == 'completed' and results['pty']['output']['terminal'] is True, results['pty'])
                require('PTY:hello-terminal' in results['pty']['output']['stdout'], results['pty'])
                require(results['network']['outcome'] == 'completed', results['network'])
                require('offline-workspace' in results['network']['output']['stdout'], results['network'])
                require(results['timeout']['output']['timedOut'] is True, results['timeout'])
                todo = next(value for value in reversed(fixture.json_payloads(body)) if value.get('type') == 'todo.current')
                self._send_tool_calls([('complete-stage', names['progress'], {
                    'sourceFactRef': results['write']['recordId'],
                    'updates': [{'todoId': item['todoId'], 'status': 'completed'} for item in todo['items']],
                })])
            elif ordinal == 7:
                self._send_text('workspace-shell-cli-complete')
            else:
                raise AssertionError(f'Unexpected Provider request {ordinal}')
        except BaseException as error:
            self.provider_state.record_failure(error)
            self.close_connection = True

def main():
    status = json.loads(subprocess.check_output([str(base.DAEMON_BINARY), '--workspace-sandbox-status'], text=True, encoding='utf-8'))
    require(status['available'], f'Unsupported runtime environment: {status}')
    with tempfile.TemporaryDirectory(prefix='deepcode-workspace-shell-') as directory:
        root = Path(directory); workspace = root / 'workspace'; workspace.mkdir()
        (workspace / 'README.txt').write_text('workspace-read-ok\n', encoding='utf-8')
        subprocess.run(['git', 'init', '-q', '-b', 'workspace-test', str(workspace)], check=True)
        state = State(workspace)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        server.provider_state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        daemon = base.OwnedDaemon(root / 'config')
        try:
            base.write_configuration(daemon.config_root, f'http://127.0.0.1:{server.server_port}/v1', {
                'agent.permissions.workspaceMutation': 'plan', 'agent.permissions.external': 'deny',
                **({'agent.windows.shell': 'auto'} if WINDOWS else {}),
            })
            daemon.start()
            session = base.create_session(daemon, workspace)['sessionId']
            fixture.cli(daemon, session, 'Inspect this workspace and generate the authorized output.', expected=5)
            state.assert_healthy()
            require(not (workspace / 'build/output.txt').exists(), 'Output created before Plan confirmation')
            result = fixture.cli(daemon, session, '/reply 1')
            state.assert_healthy()
            require('workspace-shell-cli-complete' in result.stdout, result.stdout)
            require((workspace / 'build/output.txt').read_text(encoding='utf-8') == 'generated 中文\n', 'Output file mismatch')
            require(not (root / 'outside.txt').exists(), 'Outside file was modified')
            require(not (workspace / 'readonly.txt').exists(), 'Read-only command created a file')
            projection = base.projection(daemon, session)
            require(projection['run']['status'] == 'completed', projection['run'])
            with closing(sqlite3.connect(f'{(daemon.config_root / "runtime/agent-runtime/session.sqlite3").as_uri()}?mode=ro', uri=True)) as database:
                require(database.execute("select count(*) from session_events where event_type='approval.requested'").fetchone()[0] == 0, 'Workspace execution unexpectedly requested approval')
                runtime = json.loads(database.execute("select payload_json from session_events where event_type='run.started' order by sequence limit 1").fetchone()[0])['runtimeSnapshot']
                print('[workspace-shell-cli] selected environment:', json.dumps(runtime['environment']['shell']))
            daemon.shutdown()
            print('[workspace-shell-cli] PASS: read, confirmed directory grant, Unicode write, outside write rejection, exit 7, real PTY, offline policy, timeout, final settlement and owned Host shutdown; 7 fixture Provider requests.')
        except BaseException:
            print(daemon.log_tail())
            store = daemon.config_root / 'runtime/agent-runtime/session.sqlite3'
            if store.exists():
                with closing(sqlite3.connect(f'{store.as_uri()}?mode=ro', uri=True)) as database:
                    for kind, payload in database.execute("select event_type,payload_json from session_events where event_type in ('tool.requested','tool.started','tool.completed','run.settled') order by sequence"):
                        print(kind, payload[:4000])
            state.assert_healthy()
            raise
        finally:
            daemon.close(); server.shutdown(); server.server_close(); thread.join(timeout=3)
            require(not thread.is_alive(), 'Provider fixture did not exit')

if __name__ == '__main__':
    main()
