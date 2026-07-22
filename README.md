# DeepCode

> Chinese translation: [README.zh-CN.md](README.zh-CN.md)

DeepCode v0.5.30 is a stable local-first AI coding workbench baseline. It keeps Agent session protocol, Kernel tool execution, permission audit, context compression, and Editor/GUI/CLI/TUI shells on one shared backend source of truth. This release stabilizes the Session protocol/parser and accepted-plan execution, makes the canonical Session timeline authoritative across the daemon and UI, drains bridge output concurrently, isolates Docker resources per worktree, and keeps active-checkout packaging deterministic while preserving clear provider, tool, session, kernel, and UI shell boundaries.

The retired sub-agent/DAG execution path has been removed in v0.5.30. Agent settings no longer expose sub-agent runtime controls, and Parent Session is the only orchestration authority that validates provider output and submits Kernel actions. A small number of optional request fields remain inert in Kernel client DTOs for transport compatibility; they do not restore the retired runtime.

Release documentation currently uses the `v0.5.30 stable baseline` label. Some Cargo and package metadata may still report `0.5.24`; that version metadata drift is tracked for a later release metadata pass and does not change the runtime boundary described here.

## Build And Release Mode

Regular development and Linux/Windows packaging run inside Docker/Colima:

```bash
make shell
bash ./build.sh
bash ./test.sh
```

`test.sh` is the only public repository test entrypoint. It selects registered
suites through `tests/registry.json`; use `bash ./test.sh --list` to inspect the
available profiles and suite IDs. With no selector it runs the required profile
and never reports a host-only static pass as the full gate. On a host, run
`bash ./test.sh --profile static` explicitly for host-safe checks; run the
default required profile inside the project container.

Protected test assets, fixtures, runners, registries, commands, and governance
files also pass the target-materialized test-change gate before merge. A
protected change requires the reviewed Test Change Request and a canonical
release-review record bound to the exact route, commits, policy, gate, manifest,
and TCR. The development task prepares the implementation and evidence; the
user decides whether it may proceed; a separately designated, read-only release
task rechecks the final facts and only merges or publishes after explicit user
authorization. The record is procedural audit data: it provides no
authentication, authorization proof, or proof that the two tasks are
independent. See `docs/test-change-request.md` and `docs/git-branch-flow.md`.
The first target that introduces this gate still requires an explicit one-time
user bootstrap review; there is no reusable bootstrap bypass.

The default checkout keeps the existing `deepcode-dev` container, shared
dependency caches, and host port `31246`. Persistent Git worktrees can opt into
local container isolation by copying `.deepcode-worktree.mk.example` to
`.deepcode-worktree.mk` and assigning a stable worktree ID plus an unused host
port. The local file is ignored by Git. Isolated worktrees share the image,
Cargo registry, and pnpm store, but use separate containers, `target` volumes,
and `node_modules` volumes. Newly created project containers start with Docker's
minimal init process so timed-out test descendants are reaped instead of
becoming PID 1 zombies. Run `make docker-info` before `make shell` to inspect
the effective mapping.

The default build target is the complete local distribution flow. Inside the
container, `bash ./build.sh` builds the shared GUI assets, DeepCode-GUI assets,
Linux/Windows Rust binaries, optional Linux Tauri shell, and the portable
package layout. On macOS, it can then submit a host-side packaging request for
the native Darwin release outputs.

Native macOS publishing is the explicit exception to the Docker-only build rule.
The Editor app, DeepCode-GUI app, CLI, TUI, TUI launcher, and Darwin Kernel are
macOS-native artifacts and must be produced by the macOS host package step. They
are not substituted by Linux container binaries.

Start the host package service once from the macOS host:

```bash
make macos-package-service
```

Then run the normal build inside the dev container:

```bash
bash ./build.sh
```

By default, Docker-side builds use `DEEPCODE_MACOS_PACKAGE_MODE=auto`: if the
host package service is running, the build queues one product-set transaction;
if it is not running, the Docker package still completes and macOS packaging is
skipped with a clear log message. For release verification that must fail when
macOS packaging is unavailable, use:

```bash
DEEPCODE_MACOS_PACKAGE_MODE=require bash ./build.sh
```

The macOS product set defaults to `DeepCode-GUI,DeepCode`. Both products share
one frontend preparation, Cargo dependency check, Darwin runtime build, source
fingerprint, and publish boundary. Unchanged frontend and Rust stages reuse
their input-keyed caches; `--clean-cache` is the explicit cache invalidation
path. A targeted request is allowed, but if another app already exists in the
shared package root the transaction automatically includes and refreshes it:

```bash
DEEPCODE_MACOS_PRODUCTS=DeepCode bash ./build.sh --stage package-macos
```

The same complete macOS package can be built directly on the macOS host:

```bash
make package-macos
```

Use the clean package entry when the packaged app appears to run an old Kernel:

```bash
make package-macos-clean
```

`make package-macos-clean` removes build/package artifacts such as the product `.app`, root sidecar binaries, packaged web assets, Tauri dist, and macOS target release binaries before rebuilding. It preserves package-local runtime data: `config/`, `sessions/`, `conversation-archives/`, and `kernel/`.

`make package-macos` calls `scripts/package-macos.sh` and writes the complete
macOS arm64 release package:

```text
bin/macos-arm64/
  DeepCode.app
  DeepCode-GUI.app
  deepcode-kernel
  DeepCode-TUI.command
  DeepCode-CLI.command
  libexec/DeepCode-TUI
  libexec/DeepCode-CLI
  web/
  DeepCode-GUI.app/Contents/MacOS/web-deepcode-gui/
  config/
  sessions/
  conversation-archives/
  kernel/
  build-info.json
  README.txt
```

The current macOS package is a local runnable package. It does not include DMG packaging, Developer ID signing, or notarization. The script creates a package-local writable config root and writes `build-info.json` for `/api/health` diagnostics.

The package transaction writes and validates both the current commit and a
content fingerprint, stages every app in the closed product set before
publishing, and refuses to publish a mixed product set if source files change
during the build. It also verifies that the shared Kernel and every published
app sidecar have identical hashes and build metadata. If
`/api/health` does not include `buildCommit`, `sourceFingerprint`,
`protocolVersion`, or `toolCatalogVersion`, quit the running app, run
`make package-macos-clean`, and reopen it.

## Git Branch And PR Workflow

`main` and `dev-main` are permanent protected branches and are updated only by
pull-request merge commits. Kernel, Session, UI, fix, hotfix, and approved
release work uses short-lived task branches. See
[docs/git-branch-flow.md](docs/git-branch-flow.md) for the guarded command-line
workflow, PR routes, shared hooks, audit, and post-merge cleanup rules.

## Current Status

- The Kernel daemon exposes `/api/health`, conversation archives, tool catalog, permission audit, workspace, Git, and internal browser APIs.
- The live session protocol is `deepcode.agent.protocol.v4` JSON Envelope only. Userspace Session DriverLoop owns prompt assembly, provider calls, parser, and one-shot repair. Tagged Markdown protocol output is rejected by the Session parser.
- Editor is the full workbench package: file tree, Monaco-based editor surface, terminal, Agent panel, Git panel, and internal browser. The right Agent panel is an embedded conversation panel that reuses the same Session projection and message semantics as DeepCode-GUI; it is not a separate Agent runtime.
- DeepCode-GUI is a concise conversational GUI. It is not the full Editor.
- GUI read-only analysis can be anchored by explicit attachments or by the project working directory remembered by Session. This is separate from Editor workspace binding, which remains the editing and file-tree isolation boundary.
- CLI and TUI reuse the same Kernel/session source of truth. Ordinary input, decisions, and cancel requests are submitted through the daemon shared Session Runtime run API; TUI renders the shared session timeline projection in a terminal surface.
- Web Dev Host is only a development preview and protocol-debugging entry. It is not a formal UI package.

## UI Package Terms

DeepCode currently has four formal UI package forms:

| Name                          | Definition                                 | Current Priority                                                 |
| ----------------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| Editor / DeepCode Editor      | Full packaged GUI workbench with an editor | First target for Git, internal browser, and workbench components |
| DeepCode-GUI / GUI(Recommend) | Concise conversational GUI                 | Reuses the same component flow after Editor stabilizes           |
| CLI                           | Scriptable Host Shell                      | Automation and integration                                       |
| TUI                           | Ratatui/Crossterm terminal UI              | Lightweight local usage                                          |

UI shells do not own a second Kernel, session truth, tool execution path, permission model, or user-preference store. Functional components, permissions, and tool calls are provided by Kernel/session. Conversation orchestration, context assembly, prompt envelopes, provider lifecycle, protocol parsing, and repair are owned by userspace Session DriverLoop. UI layers only own rendering, input, and interaction differences.

Editor workspace binding is an Editor concern for file tree display, editing, and code-change isolation. DeepCode-GUI can carry conversation roots from explicit attachments or a Session project working directory without requiring an Editor workspace. Writes, deletes, Git operations, terminal commands, and cross-project modifications still require reviewable plans, Kernel policy checks, and clear target disclosure.

Editor-only context such as workspace root, active file, selection, open tabs, and terminal cwd is Host context. It enters Session context assembly first; Kernel only sees ResourceManifest, WorkspaceBinding, capabilities, permissions, WorkUnits, and facts. The visible terminal is a UI surface, not an execution fact source for Agent commands.

## Session Protocol

Live provider-facing output uses the `deepcode.agent.protocol.v4` JSON Envelope:

```json
{
  "schemaVersion": "deepcode.agent.protocol.v4",
  "proposalId": "proposal-example",
  "kind": "answer",
  "source": "llm",
  "outputLanguage": "en-US",
  "referencedResourcePacketRefs": [],
  "answer": {
    "format": "markdown",
    "content": "..."
  }
}
```

`kind` must be exactly one of:

- `answer`: read-only answers, explanations, identity/capability descriptions, and design discussion.
- `resourceRequest`: request more context through Kernel `ResourceResolve` using manifest entry ids or root-relative paths exposed by Session.
- `actionBundle`: reviewable execution draft submitted as a proposal, never authorization or execution fact.

Resource requests can target an exact manifest entry or a path under a Session
conversation root:

```json
{
  "schemaVersion": "deepcode.agent.protocol.v4",
  "proposalId": "proposal-context-request",
  "kind": "resourceRequest",
  "source": "llm",
  "outputLanguage": "en-US",
  "resourceRequest": {
    "version": "1",
    "id": "need-more-context",
    "reason": "Need more context from the attached project.",
    "items": [
      {
        "id": "entry-readme",
        "manifestEntryId": "manifest-entry-id",
        "reason": "Resolve a known manifest entry."
      },
      {
        "id": "project-file",
        "rootId": "conversation-root-id",
        "path": "relative/path.ext",
        "reason": "Resolve a file under a conversation root."
      }
    ]
  }
}
```

Rules:

- Protocol fields, capabilities, tool schema, and code identifiers stay in English.
- Final answers and review summaries follow the user's language. Chinese is the default when language is unclear.
- `resourceRequest.items[]` must include either `manifestEntryId` or `path`. `rootId` should be provided with `path` when more than one conversation root is available.
- `path` is resolved by Session under explicit attachments, the project working directory, or proven conversation roots, then submitted to Kernel `ResourceResolve`. Arbitrary absolute local paths generated by the LLM are invalid.
- `actionBundle.actions[].toolId` uses Kernel catalog ids such as `fs.write`, `fs.edit`, `fs.delete`, `web.search`, and `web.fetch`.
- File operations must use `fs.*` catalog ids; `workspace` is an authorized scope/root concept, not a tool namespace.
- File write drafts use top-level `contentBlocks`; actions refer to them through `contentBlockId`.
- The v4 parser remains fail-closed. A parse failure may trigger exactly one controlled LLM repair attempt in Session; Kernel validates structured proposals but does not assemble prompts or repair model output.

## Kernel Capabilities

The current Kernel-visible tool catalog includes:

| Area | Tool ids | Current status |
| --- | --- | --- |
| Files and search | `fs.read`, `fs.list`, `fs.glob`, `code.grep`, `fs.diff` | Executable read / search tools |
| Files and mutation | `fs.create`, `fs.write`, `fs.edit`, `fs.rename`, `fs.delete` | Executable only through Kernel proposal review, permission gate, and audit |
| Documents | `document.read` | Executable PDF text extraction with Kernel size, page, and output limits |
| Web evidence | `web.search`, `web.fetch` | Executable gated read-only external evidence |
| Git | `git.status`, `git.diff`, `git.stage`, `git.unstage`, `git.commit` | V1 formal Git range, gated for write operations |
| Git reserved | `git.push` | Reserved / blocked; not a current executable capability |
| Process reserved | `process.exec` | Registered but blocked; no command execution path is available in this release |
| Browser reserved | `browser.open`, `browser.reload`, `browser.snapshot`, `browser.inspect`, `browser.click`, `browser.type`, `browser.scroll` | Registered but blocked / reserved |
| Provider reserved | `provider.call` | Registered but blocked / reserved; provider transport remains daemon-owned |

High-risk capabilities must go through Kernel PermissionGate and audit. `fs.delete` is visible to the LLM, but it is a high-risk delete capability. If the user denies it, the Agent must not fall back to shell deletion.

## Archives and Copy

Conversation archives are written under `conversation-archives/` inside the user config root. Portable packages or `DEEPCODE_CONFIG_DIR` write to that configured root.

Each run keeps:

- `exports/complete.md`
- `exports/debug.json`
- `projection.jsonl`
- `transcript.jsonl`

Each session also has global chronological exports:

- `exports/chronological.md`
- `exports/chronological-debug.json`

The chronological export includes user messages, LLM requests, provider errors, plan/review records, user confirmations, and tool facts. GUI "copy chronological conversation" reads the session-level chronological export and no longer depends on a run having a final answer.

## LLM Providers

DeepCode supports OpenAI-compatible, Anthropic, and Ollama profiles. DeepCode includes best-effort support and optimization profiles for DeepSeek V4-compatible deployments.

This is an independent engineering adaptation and a respectful acknowledgement of the DeepSeek team's contributions to open AI research, frontier model development, and the broader pursuit of AGI. It does not imply formal affiliation, authorization, sponsorship, endorsement, partnership, or a long-term compatibility guarantee.

## Third Parties and Attribution

- The editor is a Monaco-based editor surface with limited VS Code-style workspace interoperability.
- Claude, ChatGPT, Gemini, and similar commercial AI coding agents are described only as optional development assistance or architecture / workflow / UX references. DeepCode is not an upstream project, fork, official derivative, sponsored project, endorsed project, or affiliate of those agents or their vendors.
- Codicons, Monaco, Tauri, React, Rust crates, Node packages, and other third-party dependencies remain under their respective licenses.

See also:

- [NOTICE.md](NOTICE.md)
- [ATTRIBUTION.md](ATTRIBUTION.md)
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- [CITATION.cff](CITATION.cff)

## License

DeepCode is licensed under the MIT License. See [LICENSE](LICENSE).
