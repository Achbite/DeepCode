#!/usr/bin/env python3
"""Current build entrypoint and publisher behavior with disposable compiler outputs."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('package_runtime', ROOT / 'scripts/package-runtime.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)

# These commands stand in for native compilers/host availability only. The real
# build.sh owns target selection, shared preparation, error handling and cleanup.
STEP = r'''import json,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
config=json.loads((root/'fixture.json').read_text())
args=sys.argv[1:]
mac=Path(__file__).name=='macos-build-bridge.py'
action=args[0]
platform='macos' if mac else args[1] if action in ('--check','--package') else None
with (root/'calls.jsonl').open('a') as log:
    log.write(json.dumps({'action':action,'platform':platform})+'\n')
if action in ('--check','check'):
    sys.exit(config.get('check',{}).get(platform,0))
if action=='--shared':
    target=Path(args[1]);target.mkdir(parents=True)
    (target/'input.txt').write_text(config.get('content','current'))
elif action in ('--package','package'):
    shared=Path(args[args.index('--shared')+1] if mac else args[2])
    output=Path(args[args.index('--output')+1] if mac else args[3])
    status=config.get('build',{}).get(platform,0)
    if mac and status==130:(shared.parent/'macos-request').write_text('owned-request')
    if status:sys.exit(status)
    output.mkdir(parents=True,exist_ok=True)
    (output/(platform+'.txt')).write_text((shared/'input.txt').read_text())
elif action=='cancel':
    shared=Path(args[args.index('--shared')+1])
    assert shared.is_dir(), 'shared assets disappeared before host cancellation'
    sys.exit(config.get('cancel',0))
'''


def write(root, name, data):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def files(root):
    return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob('*') if p.is_file()}


class BuildTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix='deepcode-build-')
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        (self.root / 'scripts').mkdir()
        for name in ['build.sh', 'scripts/source-identity.sh']:
            shutil.copy2(ROOT / name, self.root / name)
        (self.root / 'scripts/step.py').write_text(STEP)
        (self.root / 'scripts/macos-build-bridge.py').write_text(STEP)
        (self.root / 'scripts/build-platforms.sh').write_text('#!/usr/bin/env bash\nexec python3 "$(dirname "$0")/step.py" "$@"\n')
        self.environment = {**os.environ, 'DEEPCODE_OUTPUT_DIR': str(self.root / 'output')}

    def build(self, config, *arguments):
        (self.root / 'fixture.json').write_text(json.dumps(config))
        return subprocess.run(['bash', str(self.root / 'build.sh'), *arguments], env=self.environment,
                              text=True, capture_output=True, timeout=20)

    def test_shared_content_is_prepared_once_and_changes_reach_selected_targets(self):
        for content in ['first', 'changed']:
            (self.root / 'calls.jsonl').write_text('')
            result = self.build({'content': content}, '--stage', 'package-linux', '--stage', 'package-macos')
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertEqual((self.root / 'output/linux.txt').read_text(), content)
            self.assertEqual((self.root / 'output/macos.txt').read_text(), content)
            self.assertFalse((self.root / 'output/windows.txt').exists())
            calls = [json.loads(line) for line in (self.root / 'calls.jsonl').read_text().splitlines()]
            self.assertEqual(sum(call['action'] == '--shared' for call in calls), 1)
            self.assertFalse((self.root / '.build-cache/build.lock').exists())

    def test_absent_platforms_and_host_failures_remain_distinct(self):
        result = self.build({'check': {'macos': 3}})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.root / 'output/linux.txt').exists())
        self.assertFalse((self.root / 'output/macos.txt').exists())
        for config, arguments in [
            ({'check': {'linux': 1, 'windows': 1, 'macos': 3}}, []),
            ({'check': {'windows': 1}}, ['--stage', 'package-windows']),
            ({'check': {'macos': 1}}, []),
            ({'build': {'linux': 7}}, ['--stage', 'package-linux']),
        ]:
            with self.subTest(config=config):
                self.assertNotEqual(self.build(config, *arguments).returncode, 0)

    def test_cancellation_releases_staging_only_after_host_acknowledges(self):
        result = self.build({'build': {'macos': 130}}, '--stage', 'package-macos')
        self.assertEqual(result.returncode, 130, result.stderr)
        self.assertFalse((self.root / '.build-cache/build.lock').exists())
        result = self.build({'build': {'macos': 130}, 'cancel': 1}, '--stage', 'package-macos')
        self.assertNotEqual(result.returncode, 0)
        lock = self.root / '.build-cache/build.lock'
        self.assertTrue(lock.is_dir())
        transaction = Path((lock / 'transaction').read_text().strip())
        self.assertTrue((transaction / 'shared/input.txt').is_file())


class PublicationTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix='deepcode-publish-')
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.stage, self.destination = self.root / 'stage', self.root / 'portable'
        self.archive = self.root / 'runtime.tar.gz'
        write(self.stage, 'web-deepcode-gui/index.html', b'current UI')
        write(self.stage, 'deepcode-cli', b'current CLI')
        write(self.destination, 'web-deepcode-gui/assets/obsolete.js', b'old chunk')
        write(self.destination, 'web/index.html', b'retired editor')
        write(self.destination, 'deepcode-cli', b'previous CLI')
        write(self.destination, 'config/settings.json', b'user settings')
        write(self.destination, 'runtime/session.sqlite3', b'user history')

    def test_complete_publication_removes_obsolete_programs_and_archives_only_programs(self):
        expected = files(self.stage)
        package.publish(self.stage, self.destination, self.archive)
        for name, data in expected.items():
            self.assertEqual((self.destination / name).read_bytes(), data)
        self.assertFalse((self.destination / 'web').exists())
        self.assertFalse((self.destination / 'web-deepcode-gui/assets/obsolete.js').exists())
        self.assertEqual((self.destination / 'config/settings.json').read_bytes(), b'user settings')
        self.assertEqual((self.destination / 'runtime/session.sqlite3').read_bytes(), b'user history')
        with tarfile.open(self.archive) as archive:
            actual = {str(Path(entry.name).relative_to(self.destination.name)): archive.extractfile(entry).read()
                      for entry in archive.getmembers() if entry.isfile()}
        self.assertEqual(actual, expected)

    def test_failed_publication_restores_previous_programs_and_archive(self):
        before = files(self.destination)
        self.archive.write_bytes(b'previous archive')
        rename = Path.rename
        def fail_install(path, target):
            if path.parent == self.stage:
                raise OSError('destination busy')
            return rename(path, target)
        with patch.object(Path, 'rename', fail_install):
            with self.assertRaisesRegex(OSError, 'destination busy'):
                package.publish(self.stage, self.destination, self.archive)
        self.assertEqual(files(self.destination), before)
        self.assertEqual(self.archive.read_bytes(), b'previous archive')

    @unittest.skipUnless(sys.platform == 'linux', 'mapped image fixture requires Linux')
    def test_mapped_windows_images_are_rejected_before_program_replacement(self):
        destination = self.root / 'win64'
        for name in ['node/bin/node.exe', 'deepcode-kernel.exe']:
            binary = destination / name
            binary.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(shutil.which('sleep'), binary)
            process = subprocess.Popen([str(binary), '30'])
            try:
                deadline = time.monotonic() + 5
                while Path(f'/proc/{process.pid}/exe').resolve() != binary:
                    if time.monotonic() >= deadline:
                        self.fail('owned process did not start')
                    time.sleep(0.01)
                before = files(destination)
                with self.assertRaises(OSError):
                    package.publish(self.stage, destination, self.archive)
                self.assertEqual(files(destination), before)
            finally:
                process.terminate()
                process.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
