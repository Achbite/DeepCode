# READMEs, product documentation and UI copy

Organize content around what its reader needs to accomplish. Verify the implementation, intended release contents and distribution paths before describing functionality. A confirmed development plan is not an available product feature.

## Content ownership

| Surface | Keep | Move or remove |
| --- | --- | --- |
| `README.md` / `README.zh-CN.md` | Product purpose, first use, capabilities, documentation links, concise installation/source-build entrypoint, license | Detailed engineering workflow, internal architecture rationale, test-profile inventories, PR/audit receipts and temporary plans |
| `docs/product/` | Current functionality, instructions, configuration/defaults, permission scope, update timing, limitations and public extension APIs/examples | Internal class inventories, reducer/journal mechanics, development proposals, refactoring history and future capability promises |
| `docs/distribution.md` and packaged README | Install/start/update/uninstall instructions, user directories, required user environment and platform limitations | Development-container maintenance, packaging implementation, test counts or branch state |
| Plugin READMEs and product Skills | Add/enable/configure/use a plugin; task workflows that reference product documentation | Duplicated full manuals, obsolete scaffolding notes, claims that source registration authorizes execution |
| Development docs, effective AGENTS and workflow Skills | Their respective architecture, implementation, development/test procedures and collaboration rules | Multiple copies of the same engineering policy in product docs |
| Task receipts and long-term plans | Execution evidence in receipts; stable architecture direction in plans | Temporary execution history in stable plans, or proposals presented as shipped features |

Reuse existing development documentation. If retained build/test instructions have no suitable owner, one `docs/development.md` linked briefly from README is sufficient; do not create a documentation system for a few moved paragraphs. Delete obsolete narration with no continuing value. Check inbound links and package consumers before moving files.

Plugin manifests, slots, inputs/actions, lifecycle contracts and user-directory rules affect real usage. Keep those public extension instructions even when they contain code. Separate them from internal implementation details; do not delete all technical explanation merely because it looks like development material.

## README baseline

Keep the repository's default language and language-switch links; the current main README is English with a Chinese counterpart. Align their capability claims, steps and link meaning. Preserve the existing language convention for detailed product pages rather than automatically duplicating the full documentation tree.

Use this content order where it fits the existing README, with corresponding translated headings. Omit empty sections:

```markdown
# DeepCode

One sentence explaining the product. Language switch and maintained release/download links.

## Quick start
Install or launch, connect a model, open a project, perform the first task.

## Features
Describe work users can accomplish with current capabilities.

## Documentation
Link to usage, model services, permissions/environments, plugins and updates.

## Build from source
Keep the minimum usable entrypoint; link detailed engineering steps to development docs.

## License
Link the license and existing attribution notices.
```

Use one level-one heading, consistent heading levels, blank lines around lists, language-tagged command blocks and repository-relative links. Use tables for comparisons rather than decorative layout, and ordinary Markdown emphasis instead of unnecessary HTML. Do not add badges, metrics or architecture slogans without a maintained purpose.

Quick start should support first use without an architecture tour. Source builds can be an installation route; detailed test procedures belong in development guidance. Verify downloadable assets before claiming Releases contains a package. Distinguish current source from a released version; do not infer a version change from a branch name.

## Product prose

- Trace implementation/configuration to the user action and then the documented claim. Keep unimplemented proposals in planning material. State relevant platform limits rather than implying every platform was verified.
- Remove development annotations, progress versions, ownership commentary, test results and review-only example prose from the default shipped UI. Keep permission/cost scope, actionable instructions, unfinished status and real errors; technical diagnostics may use the existing expandable detail surface.
- Check the consuming component, `config/i18n/en-US.json`, `config/i18n/zh-CN.json` and any other consumer of a changed string. Remove keys/styles only after they lose their actual consumers. Keep prototype explanations and mock data out of default product resources.
- Explain user-relevant update boundaries: plugin save, next request, next run, interface reload or core restart. Do not promise that all source edits hot-reload.

## Synchronization and validation

Check consumers affected by the change; verify these entrypoints in the current code:

1. English/Chinese READMEs and relevant `docs/product/*.md` claims, parameters, links and platform guidance.
2. `docs/distribution.md` and `scripts/package-runtime.py`, which produces the packaged README and copies documentation. Verify both repository and package-relative links when moving content.
3. `crates/deepcode-kernel-daemon/src/local_agent_product_tools.rs`: `doc.read` registration, `include_str!` resources and built-in Skills; related guidance under `skills/`. Not every product page is necessarily exposed through `doc.read`.
4. Affected plugin READMEs, public slot/schema descriptions, examples and shipped UI copy.

Compiled-in docs and Skills require the corresponding Kernel build and process restart. Report source changes, package contents and running built-in guidance separately. Documentation synchronization alone does not authorize a packaging or runtime-acceptance task.

For documentation-only changes, use existing static checks and focused link/anchor validation, and inspect actual commands and settings. Code changes carry their own required checks; reuse prior results only while they still cover the final changes. Matching prose does not prove matching behavior, and product docs should not accumulate test counts or acceptance claims.
