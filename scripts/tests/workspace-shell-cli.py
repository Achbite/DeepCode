#!/usr/bin/env python3
"""Focused CLI/Plan/workspace Shell check. Run in a Linux namespace-capable environment.

Uses the existing local-agent fixture only for deterministic Provider input and
owned Host lifecycle. Commands, Plan confirmation and outputs use the real CLI.
"""
import http.server
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import threading

spec = importlib.util.spec_from_file_location("cli_fixture", Path(__file__).with_name("tool-input-cli-e2e.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
base = fixture.fixture
require = base.require

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
                self._send_tool_calls([shell('read', "printf 'workspace-cli 中文\\n'; git branch --show-current; node --version")])
            elif ordinal == 2:
                require(results['read']['outcome'] == 'completed', results['read'])
                require('workspace-cli 中文' in results['read']['output']['stdout'], 'Unicode output missing')
                self._send_tool_calls([('plan', names['plan'], {
                    'title': 'Generate an output file', 'summary': 'Write only within build, then verify command results.',
                    'steps': [{'stepId': 'generate', 'title': 'Generate and verify', 'details': 'Exercise the workspace Shell.', 'verification': ['Output exists; unrelated paths remain unchanged.']}],
                    'mutationManifest': [{'workspace': 'primary', 'operation': 'bash', 'executionScope': 'workspace', 'workspaceMode': 'write', 'command': 'generate build output', 'writablePaths': [{'path': 'build', 'kind': 'directory'}]}],
                })])
            elif ordinal == 3:
                self._send_tool_calls([shell('write', "printf 'generated 中文\\n' > build/output.txt; cat build/output.txt", workspaceMode='write')])
            elif ordinal == 4:
                require(results['write']['outcome'] == 'completed', results['write'])
                self._send_tool_calls([shell('outside', "printf unexpected > ../outside.txt", workspaceMode='write')])
            elif ordinal == 5:
                require(results['outside']['outcome'] == 'failed', results['outside'])
                require(results['outside']['output']['exitCode'] != 0, 'Outside write reported success')
                self._send_tool_calls([
                    shell('nonzero', "printf 'expected-failure\\n'; exit 7"),
                    shell('pty', 'read -r value; printf "PTY:%s\\n" "$value"; test -t 0', terminal={'stdin': 'hello-terminal\n'}),
                    shell('network', "python3 - <<'PY'\nimport socket\ntry:\n    socket.socket()\nexcept PermissionError:\n    print('offline-workspace')\nelse:\n    raise AssertionError('workspace socket was allowed')\nPY"),
                    shell('timeout', 'sleep 30 & wait', timeout=1),
                ])
            elif ordinal == 6:
                require(results['nonzero']['output']['exitCode'] == 7, results['nonzero'])
                require(results['pty']['outcome'] == 'completed' and results['pty']['output']['terminal'] is True, results['pty'])
                require('PTY:hello-terminal' in results['pty']['output']['stdout'], results['pty'])
                require(results['network']['outcome'] == 'completed', results['network'])
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
    status = json.loads(subprocess.check_output([str(base.DAEMON_BINARY), '--workspace-sandbox-status'], text=True))
    require(status['available'], f'Unsupported runtime environment: {status}')
    with tempfile.TemporaryDirectory(prefix='deepcode-workspace-shell-') as directory:
        root = Path(directory); workspace = root / 'workspace'; workspace.mkdir()
        subprocess.run(['git', 'init', '-q', '-b', 'workspace-test', str(workspace)], check=True)
        state = State(workspace)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        server.provider_state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        daemon = base.OwnedDaemon(root / 'config')
        try:
            base.write_configuration(daemon.config_root, f'http://127.0.0.1:{server.server_port}/v1', {
                'agent.permissions.workspaceMutation': 'plan', 'agent.permissions.external': 'deny',
            })
            daemon.start()
            session = base.create_session(daemon, workspace)['sessionId']
            fixture.cli(daemon, session, 'Inspect this workspace and generate the authorized output.', expected=5)
            state.assert_healthy()
            require(not (workspace / 'build/output.txt').exists(), 'Output created before Plan confirmation')
            result = fixture.cli(daemon, session, '确认')
            state.assert_healthy()
            require('workspace-shell-cli-complete' in result.stdout, result.stdout)
            require((workspace / 'build/output.txt').read_text() == 'generated 中文\n', 'Output file mismatch')
            require(not (root / 'outside.txt').exists(), 'Outside file was modified')
            projection = base.projection(daemon, session)
            require(projection['run']['status'] == 'completed', projection['run'])
            daemon.shutdown()
            print('[workspace-shell-cli] PASS: read, confirmed directory grant, Unicode write, outside write rejection, exit 7, real PTY, offline policy, timeout, final settlement and owned Host shutdown; 7 fixture Provider requests.')
        except BaseException:
            state.assert_healthy()
            print(daemon.log_tail())
            raise
        finally:
            daemon.close(); server.shutdown(); server.server_close(); thread.join(timeout=3)
            require(not thread.is_alive(), 'Provider fixture did not exit')

if __name__ == '__main__':
    main()
