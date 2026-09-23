#!/usr/bin/env python3
"""Verify user commands, delegated review and Kernel execution through the real CLI."""
import http.server
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading

spec = importlib.util.spec_from_file_location('deepcode_test_support', Path(__file__).with_name('support.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
require = fixture.require
COMMAND = "[IO.File]::AppendAllText((Join-Path (Get-Location) 'approved.txt'), \"approved`n\")" if os.name == 'nt' else "printf 'approved\\n' >> approved.txt"


class Provider(fixture.MockProviderHandler):
    def do_POST(self):
        state = self.provider_state
        try:
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.send_header('connection', 'close')
            self.end_headers()
            if not body.get('tools'):
                state.reviews += 1
                require(state.mode == 'review', 'Review ran without user delegation')
                require(body['model'] == 'mock-reviewer', 'The selected approval model was not used')
                require(body.get('reasoning_effort') == 'xhigh', 'The independent reviewer reasoning setting was not used')
                review = json.loads(body['messages'][-1]['content'])
                require(review['operation']['arguments']['command'] == COMMAND, 'Review did not receive the actual command')
                require(review['grant'] == 'thisCallOnly', 'Review changed the permission lifetime')
                self._send_text(json.dumps({'decision': 'allow', 'reason': 'The user requested this exact file operation in the delegated environment.'}))
                return
            ordinal, names, results = state.inspect(body)
            if ordinal <= 2:
                if ordinal == 2:
                    require(results['first']['outcome'] == 'completed', results['first'])
                self._send_tool_calls([('first' if ordinal == 1 else 'repeat', names['bash'], {
                    'command': COMMAND, 'requestHostPermission': 'Write the file explicitly requested by the user.',
                })])
            else:
                require(results['repeat']['outcome'] == 'completed', results['repeat'])
                self._send_text('permission-delegation-complete')
        except BaseException as error:
            state.record_failure(error)
            self.close_connection = True


def check_mode(mode):
    with tempfile.TemporaryDirectory(prefix=f'deepcode-permission-{mode}-') as directory:
        root = Path(directory)
        workspace = root / 'workspace'
        workspace.mkdir()
        state = fixture.ProviderState(workspace)
        state.mode, state.reviews = mode, 0
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        server.provider_state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        daemon = fixture.OwnedDaemon(root / 'config')
        try:
            fixture.write_configuration(daemon.config_root, f'http://127.0.0.1:{server.server_port}/v1', {})
            settings_root = daemon.config_root / 'config/user/local/settings'
            profiles_path = settings_root / 'llm-profiles.json'
            profiles = json.loads(profiles_path.read_text())
            reviewer = dict(profiles['profiles'][0], id='e2e-reviewer', name='Approval reviewer', model='mock-reviewer', thinking='enabled', reasoningEffort='high')
            profiles['profiles'].append(reviewer)
            profiles_path.write_text(json.dumps(profiles))
            (settings_root / 'user-settings.json').write_text(json.dumps({'agent.approvalReview.profileId': 'e2e-reviewer', 'agent.approvalReview.reasoningEffort': 'xhigh'}))
            daemon.start()
            session = fixture.create_session(daemon, workspace)['sessionId']
            fixture.cli(daemon, session, '/permissions ' + json.dumps({
                'agent.permissions.shell': mode, 'agent.permissions.shellAccess': 'full',
            }))
            result = fixture.cli(daemon, session, 'Append approved to approved.txt twice, using the same command.', expected=5 if mode == 'ask' else 0)
            state.assert_healthy()
            if mode == 'ask':
                pending = fixture.projection(daemon, session)
                require(pending['pendingApproval'] is not None, 'No pending user approval')
                require(not (workspace / 'approved.txt').exists(), 'Command executed before user approval')
                require(state.reviews == 0, 'Ask unexpectedly invoked a reviewer')
                result = fixture.cli(daemon, session, '/reply 3')
            state.assert_healthy()
            require('permission-delegation-complete' in result.stdout, result.stdout)
            require((workspace / 'approved.txt').read_text() == 'approved\napproved\n', 'Actual command did not run exactly twice')
            done = fixture.projection(daemon, session)
            require(done['run']['status'] == 'completed' and not done['shellAuthorizations'], 'Run grant remained active after settlement')
            require(state.reviews == (2 if mode == 'review' else 0), f'Unexpected reviewer count: {state.reviews}')
            daemon.shutdown()
            with fixture.sqlite_read_only(daemon.config_root / 'data/agent-runtime/session.sqlite3') as database:
                events = [(kind, json.loads(payload)) for kind, payload in database.execute(
                    'SELECT event_type,payload_json FROM session_events WHERE session_id=? ORDER BY sequence', (session,))]
            decisions = [payload for kind, payload in events if kind == 'approval.resolved']
            if mode == 'review':
                require(len(decisions) == 2 and all(decision['source'] == 'agent' and 'authorizationScope' not in decision for decision in decisions), 'Delegation did not remain limited to each call')
            elif mode == 'ask':
                require(len(decisions) == 1 and decisions[0]['source'] == 'user' and decisions[0]['authorizationScope'] == 'runCommand', 'Exact run grant was not reused')
            else:
                require(not decisions, 'Allow unexpectedly created an approval decision')
            require(sum(kind == 'run.runtime.released' for kind, _ in events) == 1, 'Runtime was not released')
            print(f'[permission-delegation-cli] PASS: {mode}, two actual executions, {state.reviews} reviews, correct authority and owned cleanup')
        except BaseException:
            print(daemon.log_tail())
            state.assert_healthy()
            raise
        finally:
            daemon.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)
            require(not thread.is_alive(), 'Provider fixture did not exit')


if __name__ == '__main__':
    for mode in ('ask', 'review', 'allow'):
        check_mode(mode)
