#!/usr/bin/env bash
# Shared, path-independent source identity for build and package tooling.
# This file only defines functions and is safe to source from another script.

deepcode_sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{ print $1 }'
  else
    shasum -a 256 | awk '{ print $1 }'
  fi
}

deepcode_sha256_file() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{ print $1 }'
  else
    shasum -a 256 "$path" | awk '{ print $1 }'
  fi
}

deepcode_physical_root() {
  local root="$1"
  (cd "$root" && pwd -P)
}

deepcode_source_commit() {
  local root="$1"
  git -C "$root" rev-parse HEAD
}

deepcode_source_status() {
  local root="$1"
  git -C "$root" status --porcelain=v1 --untracked-files=all
}

deepcode_source_dirty() {
  local root="$1"
  if [ -n "$(deepcode_source_status "$root")" ]; then
    printf '1\n'
  else
    printf '0\n'
  fi
}

deepcode_source_status_hash() {
  local root="$1"
  deepcode_source_status "$root" | deepcode_sha256_stream
}

deepcode_source_fingerprint() {
  local root="$1"
  if git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    {
      deepcode_source_commit "$root"
      git -C "$root" diff --binary --no-ext-diff HEAD --
      git -C "$root" ls-files --others --exclude-standard -z \
        | while IFS= read -r -d '' path; do
            printf 'untracked=%s\n' "$path"
            if [ -f "$root/$path" ]; then
              deepcode_sha256_file "$root/$path"
            elif [ -L "$root/$path" ]; then
              printf 'symlink=%s\n' "$(readlink "$root/$path")"
            fi
          done
    } | deepcode_sha256_stream
    return
  fi

  (
    cd "$root"
    find . \
      \( -type d \( -name .git -o -name node_modules -o -name target -o -name bin -o -name dist -o -name 'dist-*' -o -name .build-cache \) -prune \) -o \
      \( -type f ! -name .DS_Store ! -name '*.tsbuildinfo' -print \) \
      | LC_ALL=C sort \
      | while IFS= read -r path; do
          printf 'path=%s\n' "$path"
          deepcode_sha256_file "$root/${path#./}"
        done
  ) | deepcode_sha256_stream
}
