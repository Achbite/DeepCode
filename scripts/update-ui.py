#!/usr/bin/env python3
"""Publish a built UI bundle into an existing local DeepCode package."""
import argparse
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile


SURFACES = {"editor": ("web", "DeepCode.app"), "gui": ("web-deepcode-gui", "DeepCode-GUI.app")}


def targets_for(package, surface):
    """Use the same locations as the packaged native asset resolvers."""
    targets, apps = [], set()
    for name, (directory, app_name) in SURFACES.items():
        if surface != "all" and name != surface:
            continue
        app = package if package.name == app_name else package / app_name
        if app.is_dir():
            resources = app / "Contents/Resources" / directory
            if not resources.is_dir():
                raise ValueError(f"Packaged UI directory missing in {app}")
            targets.append((name, resources))
            apps.add(app)
        flat = package / directory
        if flat.is_dir():
            targets.append((name, flat))
    if not targets:
        raise ValueError(f"No {surface} UI assets found in package: {package}")
    return targets, sorted(apps)


def read_identity(assets, surface):
    directory = assets / SURFACES[surface][0]
    if not (directory / "index.html").is_file():
        raise ValueError(f"UI index.html missing: {directory}; run make ui first")
    identity = json.loads((directory / "frontend-build-info.json").read_text(encoding="utf-8"))
    if not isinstance(identity, dict) or identity.get("surface") != surface:
        raise ValueError(f"Frontend identity does not describe {surface}: {directory}")
    return directory, identity


def sign_apps(apps):
    for app in apps:
        # Refresh the outer bundle's resource seal. Nested binaries keep their
        # existing signatures; no native executable is rebuilt.
        subprocess.run(["codesign", "--force", "--sign", "-", str(app)], check=True)
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)


def update(assets, package, surface="all"):
    assets, package = assets.resolve(strict=True), package.resolve(strict=True)
    targets, apps = targets_for(package, surface)
    if apps and (sys.platform != "darwin" or shutil.which("codesign") is None):
        raise ValueError("Updating macOS .app resources requires codesign on the macOS host")
    sources = {name: read_identity(assets, name) for name, _ in targets}
    replacements = []
    signing_started = False
    try:
        # Copy every selected surface before replacing any published directory.
        for name, target in targets:
            source, _ = sources[name]
            if source == target or source in target.parents or target in source.parents:
                raise ValueError(f"UI source and target must be separate: {source}, {target}")
            # Staging must stay outside .app: its final resource seal must not
            # include temporary copies that disappear after codesign.
            scratch_parent = next((app.parent for app in apps if app in target.parents), target.parent)
            scratch = pathlib.Path(tempfile.mkdtemp(prefix=".ui-update-", dir=scratch_parent))
            replacement = (target, scratch / "next", scratch / "previous")
            replacements.append(replacement)
            shutil.copytree(source, replacement[1])
        for target, staging, previous in replacements:
            target.rename(previous)
            staging.rename(target)
        signing_started = bool(apps)
        sign_apps(apps)
    except Exception as error:
        restore_errors = []
        for target, _, previous in reversed(replacements):
            if not previous.exists():
                continue
            try:
                if target.exists():
                    shutil.rmtree(target)
                previous.rename(target)
            except OSError as restore_error:
                restore_errors.append(f"{restore_error}; original assets retained at {previous}")
        if signing_started:
            try:
                sign_apps(apps)
            except (OSError, subprocess.CalledProcessError) as restore_error:
                restore_errors.append(f"Original UI restored but bundle signing failed: {restore_error}")
        if restore_errors:
            raise RuntimeError(f"{error}\n" + "\n".join(restore_errors)) from error
        raise
    else:
        for _, _, previous in replacements:
            shutil.rmtree(previous)
    finally:
        for _, staging, previous in replacements:
            # A failed restoration keeps the user's original directory intact.
            if not previous.exists():
                shutil.rmtree(staging.parent)
    return [{"path": str(target), "frontend": sources[name][1]} for name, target in targets]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1] / "bin/ui")
    parser.add_argument("--package", type=pathlib.Path, required=True, help="existing bin/<platform> directory or macOS .app")
    parser.add_argument("--surface", choices=["all", *SURFACES], default="all")
    args = parser.parse_args()
    try:
        receipt = update(args.assets, args.package, args.surface)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"UI update failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"updated": receipt}, indent=2, ensure_ascii=False))
    print("UI assets updated. Reload or reopen the window to use them. Kernel and Session runtime were retained.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
