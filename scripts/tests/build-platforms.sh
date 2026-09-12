#!/usr/bin/env bash
# Focused checks for target selection and failure propagation; no compiler work.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
source "$REPO_ROOT/scripts/build-platforms.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
ROOT_DIR="$test_root"
clean_cache=0
kill_running=0

cat > "$ROOT_DIR/build.sh" <<'BUILD'
#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
printf '%s\n' "$*" >> "$root/calls"
if [ "$2" = package-windows ] && [ -f "$root/interrupt-windows" ]; then
  bash -c 'exit 130'
elif [ "$2" = package-windows ] && [ -f "$root/fail-windows" ]; then
  bash -c 'exit 7'
fi
printf '%s\n' "$2" >> "$root/outputs"
BUILD

# Model available/missing environments independently of the real machine.
build_platform_support() {
  case " $available " in
    *" $1 "*) return 0 ;;
    *) printf 'support environment absent\n'; return 1 ;;
  esac
}

available='linux windows macos'
run_all_platform_builds > "$test_root/log"
[ "$(wc -l < "$test_root/outputs" | tr -d ' ')" = 3 ]
grep -q 'built=3 skipped=0 failed=0' "$test_root/log"
grep -q '^--stage package-macos --no-kill-running$' "$test_root/calls"
printf '[build-platforms] all available targets built; macOS flags retained: PASS\n'

: > "$test_root/calls"
: > "$test_root/outputs"
available='linux macos'
run_all_platform_builds > "$test_root/log"
! grep -q package-windows "$test_root/calls"
grep -q 'windows: SKIPPED (support environment absent)' "$test_root/log"
[ "$(wc -l < "$test_root/outputs" | tr -d ' ')" = 2 ]
printf '[build-platforms] absent Windows support does not block other targets: PASS\n'

: > "$test_root/calls"
: > "$test_root/outputs"
touch "$test_root/fail-windows"
available='linux windows macos'
status=0
run_all_platform_builds > "$test_root/log" || status=$?
[ "$status" -ne 0 ]
grep -q 'windows: FAILED (exit=7;' "$test_root/log"
grep -q 'built=2 skipped=0 failed=1' "$test_root/log"
! grep -q package-windows "$test_root/outputs"
grep -q package-macos "$test_root/outputs"
printf '[build-platforms] build failure remains nonzero; later targets still build: PASS\n'

: > "$test_root/calls"
: > "$test_root/outputs"
touch "$test_root/interrupt-windows"
status=0
run_all_platform_builds > "$test_root/log" || status=$?
[ "$status" = 130 ]
! grep -q package-macos "$test_root/calls"
grep -q 'Build interrupted; remaining platforms were not started' "$test_root/log"
printf '[build-platforms] interruption stops the remaining targets: PASS\n'

: > "$test_root/calls"
: > "$test_root/outputs"
available=''
run_all_platform_builds > "$test_root/log"
[ ! -s "$test_root/calls" ]
[ ! -s "$test_root/outputs" ]
grep -q 'No new distribution was produced' "$test_root/log"
grep -q 'built=0 skipped=3 failed=0' "$test_root/log"
printf '[build-platforms] no environment reports no outputs: PASS\n'
