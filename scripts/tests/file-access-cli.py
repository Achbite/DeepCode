#!/usr/bin/env python3
"""Actual file/Shell effects through the CLI; deterministic Provider input only."""
import http.server
import importlib.util
import json
from pathlib import Path
import shlex
import tempfile
import threading
import urllib.request
import urllib.parse

spec = importlib.util.spec_from_file_location('support', Path(__file__).with_name('support.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
require = fixture.require


class Provider(fixture.MockProviderHandler):
    def do_POST(self):
        state = self.provider_state
        try:
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            ordinal, names, results = state.inspect(body)
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.send_header('connection', 'close')
            self.end_headers()
            if ordinal == 1:
                self._send_tool_calls([('read-external', names['read'], {'path': str(state.external)})])
            elif ordinal == 2:
                require(results['read-external']['outcome'] == 'completed', results['read-external'])
                self._send_tool_calls([
                    ('shell-same-file', names['bash'], {'command': f'cat {shlex.quote(str(state.external))}'}),
                    ('shell-sibling', names['bash'], {'command': 'sh -c ' + shlex.quote(f'cat {shlex.quote(str(state.sibling))}')}),
                    ('git-denied', names['bash'], {'command': "printf changed > .git/HEAD"}),
                    ('private-temp', names['bash'], {'command': 'printf temp > "$TMPDIR/owned"; cat "$TMPDIR/owned"; printf ":%s\\n" "$HOME"'}),
                ])
            elif ordinal == 3:
                require(results['shell-same-file']['outcome'] == 'completed', results['shell-same-file'])
                require(results['shell-same-file']['output']['stdout'] == 'external-ok', results['shell-same-file'])
                for call in ('shell-sibling', 'git-denied'):
                    require(results[call]['outcome'] == 'failed' and results[call]['output']['exitCode'] != 0, results[call])
                require(results['private-temp']['outcome'] == 'completed', results['private-temp'])
                self._send_tool_calls([('external-write', names['write'], {
                    'path': str(state.external), 'content': 'updated',
                })])
            elif ordinal == 4:
                require(results['external-write']['outcome'] == 'completed', results['external-write'])
                self._send_tool_calls([('git-approved', names['write'], {
                    'path': '.git/HEAD', 'content': 'approved',
                    'requestFileAccess': {'write': [str(state.workspace / '.git/HEAD')]},
                })])
            elif ordinal == 5:
                require(results['git-approved']['outcome'] == 'completed', results['git-approved'])
                self._send_text('file-scope-complete')
            else:
                require(ordinal % 2 == 0 or f'read-{ordinal-1}' in results, results)
                if ordinal % 2 == 0:
                    self._send_tool_calls([(f'read-{ordinal}', names['read'], {'path': str(state.external)})])
                else:
                    require(results[f'read-{ordinal-1}']['outcome'] == ('denied' if ordinal == 11 else 'completed'), results)
                    self._send_text('file-scope-complete')
        except BaseException as error:
            state.record_failure(error)
            self.close_connection = True


def check_resource_tree(daemon, session, workspace):
    base = f'/api/conversation/sessions/{urllib.parse.quote(session, safe="")}/resources/'
    roots = fixture.api_json(daemon.base_url, base + 'roots', token=daemon.token)
    project = next(root for root in roots if root['category'] == 'project')['resource']
    require(any(root['category'] == 'session' for root in roots), 'Missing session files root')
    request = urllib.request.Request(daemon.base_url + base + 'watch', method='POST',
        headers={'content-type': 'application/json', fixture.HOST_TOKEN_HEADER: daemon.token},
        data=json.dumps({'resources': [project]}).encode())
    def event(stream):
        name, data = '', ''
        while True:
            line = stream.readline().decode().strip()
            if not line and data: return name, json.loads(data)
            if line.startswith('event:'): name = line[6:].strip()
            if line.startswith('data:'): data = line[5:].strip()
    with fixture.URL_OPENER.open(request, timeout=5) as stream:
        require(event(stream)[0] == 'ready', 'Watch did not register')
        target = workspace / 'watched.txt'
        target.write_text('current')
        require(event(stream) == ('change', {'indices': [0]}), 'Directory change was not delivered')
        entries = fixture.api_json(daemon.base_url, base + 'list', token=daemon.token, method='POST', body=project)
        entry = next(entry for entry in entries if entry['name'] == 'watched.txt')
        read = fixture.api_json(daemon.base_url, base + 'read', token=daemon.token, method='POST', body=entry['resource'])
        require(read['content'] == 'current', 'Tree reference did not read current bytes')
        target.unlink()
        failure = fixture.api_envelope(daemon.base_url, base + 'read', token=daemon.token, method='POST', body=entry['resource'])
        require(not failure['ok'], 'Deleted current file produced substitute content')


def main():
    with tempfile.TemporaryDirectory(prefix='deepcode-file-access-') as directory:
        root = Path(directory)
        workspace = root / 'project'
        workspace.mkdir()
        (workspace / '.git').mkdir()
        (workspace / '.git/HEAD').write_text('ref: refs/heads/main\n')
        external, sibling = root / 'selected.txt', root / 'sibling.txt'
        external.write_text('external-ok')
        sibling.write_text('not-granted')
        state = fixture.ProviderState(workspace)
        state.external, state.sibling = external, sibling
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        server.provider_state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        daemon = fixture.OwnedDaemon(root / 'config')
        try:
            fixture.write_configuration(daemon.config_root, f'http://127.0.0.1:{server.server_port}/v1', {
                'agent.permissions.workspaceMutation': 'allow',
            })
            daemon.start()
            session = fixture.create_session(daemon, workspace)['sessionId']
            fixture.cli(daemon, session, 'Read the selected external file and check the file boundary.', expected=5)
            check_resource_tree(daemon, session, workspace)
            pending = fixture.projection(daemon, session)['pendingApproval']
            require(pending['preview']['fileAccess'] == {'read': [str(external)], 'write': []}, pending)
            fixture.cli(daemon, session, '/reply 5', expected=5)
            state.assert_healthy()
            require(external.read_text() == 'external-ok', 'Read grant allowed a write')
            pending = fixture.projection(daemon, session)['pendingApproval']
            require(pending['preview']['fileAccess']['write'] == [str(external)], pending)
            fixture.cli(daemon, session, '/reply 1', expected=5)
            require((workspace / '.git/HEAD').read_text() == 'ref: refs/heads/main\n', 'Git metadata changed without approval')
            pending = fixture.projection(daemon, session)['pendingApproval']
            require(pending['preview']['authorizationScopes'] == [], 'Git write offered a reusable grant')
            fixture.cli(daemon, session, '/reply 1')
            require(external.read_text() == 'updated', 'Approved external write did not execute')
            require((workspace / '.git/HEAD').read_text() == 'approved', 'Approved Git write did not execute')
            require(not fixture.projection(daemon, session)['shellAuthorizations'], 'Turn grant survived settlement')
            fixture.cli(daemon, session, 'Read that file again in a new turn.', expected=5)
            fixture.cli(daemon, session, '/reply 6')
            grant = fixture.projection(daemon, session)['shellAuthorizations'][0]
            require(grant['scope'] == 'sessionFiles', grant)
            base = f'/api/conversation/sessions/{urllib.parse.quote(session, safe="")}/resources/'
            roots = fixture.api_json(daemon.base_url, base + 'roots', token=daemon.token)
            selected = next(root for root in roots if root['category'] == 'resource')['resource']
            require(selected['fileGrant']['authorityId'] == grant['authorityId'], 'Tree grant identity changed')
            require(fixture.api_json(daemon.base_url, base + 'read', token=daemon.token, method='POST', body=selected)['content'] == 'updated', 'Granted resource not readable')
            edited = next(activity['tool'] for activity in fixture.projection(daemon, session)['activities'] if activity.get('tool', {}).get('fileChanges'))
            change = {'recordId': edited['recordId'], 'index': 0}
            recorded = {'change': change, 'logicalPath': '', 'format': 'path'}
            require(fixture.api_json(daemon.base_url, base + 'read', token=daemon.token, method='POST', body=recorded)['path'] == str(external.resolve()), 'Diff did not resolve its associated file')
            denied = fixture.api_envelope(daemon.base_url, base + 'read', token=daemon.token, method='POST', body={**selected, 'logicalPath': '../sibling.txt'})
            require(not denied['ok'], 'Single-file grant exposed parent directory')
            fixture.cli(daemon, session, 'Read the conversation resource again.')
            fixture.cli(daemon, session, '/revoke ' + grant['authorityId'])
            denied = fixture.api_envelope(daemon.base_url, base + 'read', token=daemon.token, method='POST', body=selected)
            require(not denied['ok'], 'Revoked tree resource remained readable')
            denied = fixture.api_envelope(daemon.base_url, base + 'read', token=daemon.token, method='POST', body=recorded)
            require(not denied['ok'], 'Historical diff bypassed current file access')
            external.unlink()
            history = fixture.api_json(daemon.base_url, base.replace('/resources/', '/changes/read'), token=daemon.token, method='POST', body=change)
            require(history['after'] == 'updated', 'Deleted current file invalidated recorded diff')
            external.write_text('updated')
            fixture.cli(daemon, session, 'Try the removed resource again.', expected=5)
            fixture.cli(daemon, session, '/reply 2')
            state.assert_healthy()
            daemon.shutdown()
            print('[file-access-cli] PASS: exact external file, shared fs/Shell grant, child-process isolation, external/Git write approval, private temp, turn expiry, session reuse and revocation')
        except BaseException:
            if state.failure is not None:
                print('Provider assertion:', state.failure, flush=True)
            if daemon.identity is not None:
                print(json.dumps(fixture.projection(daemon, session), ensure_ascii=False), flush=True)
            raise
        finally:
            daemon.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)
            require(not thread.is_alive(), 'Provider fixture did not exit')


if __name__ == '__main__':
    main()
