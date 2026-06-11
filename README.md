# DeepCode

> Chinese translation: [README.zh-CN.md](README.zh-CN.md)

DeepCode is a local-first AI coding workbench experiment. Its goal is to keep Agent session protocol, Kernel tool execution, permission audit, context compression, and Editor/GUI/CLI/TUI shells on one shared backend source of truth. The project is still in an active architecture-closure phase. Current work prioritizes Kernel and Session stability over release-grade product guarantees.

## Current Status

- The Kernel daemon exposes `/api/health`, conversation archives, tool catalog, permission audit, workspace, Git, and internal browser APIs.
- The live session protocol is `deepcode.agent.protocol.v2` JSON Envelope only. Tagged Markdown protocol output is rejected by Kernel/session parsers.
- Editor is the full workbench package: file tree, Monaco-based editor surface, terminal, Agent panel, Git panel, and internal browser.
- DeepCode-GUI is a concise conversational GUI. It is not the full Editor.
- CLI and TUI reuse the same Kernel/session source of truth.
- Web Dev Host is only a development preview and protocol-debugging entry. It is not a formal UI package.

## UI Package Terms

DeepCode currently has four formal UI package forms:

| Name | Definition | Current Priority |
| --- | --- | --- |
| Editor / DeepCode Editor | Full packaged GUI workbench with an editor | First target for Git, internal browser, and workbench components |
| DeepCode-GUI / GUI | Concise conversational GUI | Reuses the same component flow after Editor stabilizes |
| CLI | Scriptable Host Shell | Automation and integration |
| TUI | Ratatui/Crossterm terminal UI | Lightweight local usage |

UI shells do not own a second Kernel, session truth, tool execution path, permission model, or user-preference store. Functional components, permissions, tool calls, and session orchestration are provided by Kernel/session. UI layers only own rendering, input, and interaction differences.

## Development Environment

Regular development and verification should run inside Docker/Colima:

```bash
make shell
bash ./build.sh
bash ./test.sh
```

macOS `.app` bundles and Darwin executables require a macOS host-side final packaging step. This is the explicit exception for native macOS app bundles:

```bash
make package-macos
```

Use the clean package entry when the packaged app appears to run an old Kernel:

```bash
make package-macos-clean
```

`make package-macos-clean` removes build/package artifacts such as the product `.app`, root sidecar binaries, packaged web assets, Tauri dist, and macOS target release binaries before rebuilding. It preserves package-local runtime data: `config/`, `sessions/`, `conversation-archives/`, and `kernel/`.

`make package-macos` calls `scripts/package-macos.sh` and writes:

```text
bin/macos-arm64/
  DeepCode.app
  DeepCode-GUI.app
  deepcode-kernel
  deepcode-cli
  deepcode-tui
  DeepCode-TUI.command
  web/
  config/
  sessions/
  conversation-archives/
  kernel/
  README.txt
```

The current macOS package is a local runnable package. It does not include DMG packaging, Developer ID signing, or notarization. The script creates a package-local writable config root and writes `build-info.json` for `/api/health` diagnostics.

If `/api/health` does not include `buildCommit`, `protocolVersion`, or `toolCatalogVersion`, or if a new run archive still shows an old Chinese tagged protocol prompt instead of `deepcode.agent.protocol.v2`, quit the running `DeepCode.app`, run `make package-macos-clean`, and reopen the app. The package script fails fast when the target app or its bundled `deepcode-kernel` is still running, because repackaging while the old process is alive can make review tests hit the stale Kernel.

## Session Protocol

Live plan output uses the `deepcode.agent.protocol.v2` JSON Envelope:

```json
{
  "schemaVersion": "deepcode.agent.protocol.v2",
  "kind": "answer",
  "outputLanguage": "en-US",
  "answer": {
    "format": "markdown",
    "content": "..."
  }
}
```

`kind` must be exactly one of:

- `answer`: read-only answers, explanations, identity/capability descriptions, and design discussion.
- `resourceRequest`: request more context through the Kernel resource resolver.
- `actionBundle`: reviewable execution draft, never authorization or execution fact.

Rules:

- Protocol fields, capabilities, tool schema, and code identifiers stay in English.
- Final answers and review summaries follow the user's language. Chinese is the default when language is unclear.
- `actionBundle.actions[].capability` uses capability namespace such as `workspace.write`, `workspace.delete`, and `network.egress`.
- Executor tool names such as `fs.write`, `fs.delete`, and `web.search` are complete-phase tool call names only.
- File write drafts use top-level `codeBlocks`; actions refer to them through `sourceBlockId`.
- The parser remains fail-closed. A parse failure may trigger exactly one controlled LLM repair attempt.

## Kernel Capabilities

The current Kernel-visible tool catalog includes:

- Files and search: `fs.list`, `fs.read`, `fs.diff`, `fs.write`, `fs.delete`, `code.search`
- Shell: `shell.propose`, `shell.exec`
- Web evidence: `web.search`, `web.fetch`
- Git: `git.status`, `git.diff`, `git.stage`, `git.unstage`, `git.commit`
- Internal browser: `browser.open`, `browser.reload`, `browser.snapshot`, `browser.inspect`, `browser.click`, `browser.type`, `browser.scroll`

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
- Codex, Claude, Gemini, and similar tools are described only as AI-assisted development tools or architecture / workflow / UX reference. DeepCode is not an upstream project, fork, or official affiliate of those projects.
- Codicons, Monaco, Tauri, React, Rust crates, Node packages, and other third-party dependencies remain under their respective licenses.

See also:

- [NOTICE.md](NOTICE.md)
- [ATTRIBUTION.md](ATTRIBUTION.md)
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- [CITATION.cff](CITATION.cff)

## License

DeepCode is licensed under the MIT License. See [LICENSE](LICENSE).
