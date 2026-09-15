#!/usr/bin/env python3
"""Exercise the actual local UI publisher using disposable package directories."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("ui_update", Path(__file__).resolve().parents[1] / "update-ui.py")
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


def write(root, path, content):
    destination = root / path
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(content)


def files(root):
    return {str(path.relative_to(root)): path.read_bytes() for path in root.rglob("*") if path.is_file()}


class UiUpdateTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="deepcode-ui-publish-")
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.assets, self.package = self.root / "assets", self.root / "package"
        for surface, (directory, _) in updater.SURFACES.items():
            write(self.assets, f"{directory}/index.html", b'<script type="module" src="assets/new.js"></script>')
            write(self.assets, f"{directory}/assets/new.js", b"new frontend")
            write(self.assets, f"{directory}/pdfjs/wasm/font.wasm", b"local renderer asset")
            write(self.assets, f"{directory}/frontend-build-info.json", json.dumps({"surface": surface, "buildCommit": "ui-source"}).encode())
            write(self.package, f"{directory}/index.html", b"previous frontend")
            write(self.package, f"{directory}/assets/old.js", b"old chunk")
        for name in ["deepcode-kernel-daemon.exe", "DeepCode-GUI.exe", "session-runtime/sessionServiceBridge.js", "config/user-settings.json", "sessions/store.sqlite3", "build-info.json"]:
            write(self.package, name, f"keep original {name}".encode())

    def test_publishes_complete_assets_and_retains_runtime_and_data(self):
        before = files(self.package)
        receipt = updater.update(self.assets, self.package)
        self.assertEqual(len(receipt), 2)
        for directory, _ in updater.SURFACES.values():
            self.assertEqual(files(self.package / directory), files(self.assets / directory))
        for name, content in before.items():
            if name.split("/")[0] not in {"web", "web-deepcode-gui"}:
                self.assertEqual((self.package / name).read_bytes(), content)
        self.assertEqual(list(self.package.glob(".ui-update-*")), [])

    def test_selected_surface_does_not_touch_sibling(self):
        before = files(self.package / "web")
        updater.update(self.assets, self.package, "gui")
        self.assertEqual(files(self.package / "web"), before)
        self.assertEqual(files(self.package / "web-deepcode-gui"), files(self.assets / "web-deepcode-gui"))

    def test_incomplete_inputs_leave_package_untouched(self):
        before = files(self.package)
        (self.assets / "web-deepcode-gui/index.html").unlink()
        with self.assertRaisesRegex(ValueError, "index.html missing"):
            updater.update(self.assets, self.package)
        self.assertEqual(files(self.package), before)

    def test_failed_publication_restores_both_surfaces(self):
        before = files(self.package)
        rename = Path.rename

        def fail_second_publication(path, destination):
            if path.name == "next" and destination.name == "web-deepcode-gui":
                raise OSError("destination busy")
            return rename(path, destination)

        with patch.object(Path, "rename", fail_second_publication):
            with self.assertRaisesRegex(OSError, "destination busy"):
                updater.update(self.assets, self.package)
        self.assertEqual(files(self.package), before)
        self.assertEqual(list(self.package.glob(".ui-update-*")), [])

    def test_macos_native_and_standalone_paths_match_asset_resolvers(self):
        for directory, app in updater.SURFACES.values():
            write(self.package, f"{app}/Contents/Resources/{directory}/index.html", b"app frontend")
        targets, apps = updater.targets_for(self.package, "all")
        self.assertEqual(len(targets), 4)
        self.assertEqual({app.name for app in apps}, {"DeepCode.app", "DeepCode-GUI.app"})
        gui = self.package / "DeepCode-GUI.app"
        self.assertEqual(updater.targets_for(gui, "gui"), ([("gui", gui / "Contents/Resources/web-deepcode-gui")], [gui]))


if __name__ == "__main__":
    unittest.main()
