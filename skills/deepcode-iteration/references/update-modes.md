# Update and verification workflows

Identify the source checkout, container mount and actual page URL or running application path first. A temporary build, `bin/` and an installed application can be different products. Do not infer which one is running from its display name.

## Select the update boundary

| Change | Current entrypoint | Observable result |
| --- | --- | --- |
| GUI development source | `make dev-deepcode-gui`, then open its actual development URL | The same page receives Vite HMR after the edit |
| TypeScript display plugin | `make ui-plugin UI_PLUGIN=<repo-relative-plugin-dir>` or `make ui-plugin-watch` | The declared compiled entry changes and the enabled plugin is replaced |
| Compiled display module or manifest | Edit the registered `deepcode-ui.json` and declared entry | Host watch replaces that module and releases old effects without a Kernel restart |
| Packaged GUI resources | `make ui-update UI_PACKAGE=<actual-package-dir>` | Update the selected package, then reload its interface; use the existing macOS signing path |
| Content of an already selected Skill/CLI plugin | Existing request preparation | The next model request captures new content; in-flight calls and pending approvals retain their binding |
| Saved model, permission, plugin registration or environment settings | Existing shared settings API | The next run captures the new configuration |
| Session, Kernel, native shell or compiled-in guidance | Corresponding service/package build and process restart | The target process loads the new build; a GUI-only copy is insufficient |

Replace placeholders with verified paths and read the current Makefile/scripts before running them. These entrypoints do not authorize ending the user's active task, replacing a live application or discarding unsaved state.

## Browser iteration

1. Distinguish a user project's preview from DeepCode's own UI. `browser.page` action `openSelf` uses installed resources. For source HMR, open the development server URL; for static HTML edits, reload the existing preview.
2. Use browser tools actually present in the run catalog. If needed, discover the computer-use contribution and activate it through the available Session tool. Retain the same `previewId` while editing, observing and interacting; do not invent a callable tool name.
3. If the page is hidden, a handle is stale or a service is not ready, inspect its binding, visibility, URL and original error. Repeated preview creation or fixed sleeps are not evidence of success. Closing a page does not stop its service; release only this task's owned resources.
4. Refresh the primary application through `browser.page` action `refreshInterface` or the existing interface shortcut. `scheduled` means queued, so observe the resulting page. `needsUser` means unsaved settings or an active save requires attention; it does not permit discarding that state.

A DOM `element.click()` does not prove operating-system pointer, `pointerdown`, drag or focus behavior. Use an interaction path capable of the behavior being tested; when the user retains manual acceptance, provide the exact target and remaining interaction instead of claiming success.

## Validation

Normal checks run in the correctly mounted project container. The current baseline entrypoint is `bash ./test.sh required`; inspect the script for its actual coverage. Select existing `cli` or `full` checks when the change affects those paths. Do not run every profile merely because this Skill was read. `static` proves only its registered static checks.

For prompt or delegated-review changes, inspect actual request structure and behavior. A fixture Provider demonstrates its controlled scenario; a real-model claim requires real Provider evidence. Verify new-Session behavior for persistent preferences, adding restart coverage when restart persistence is part of the change.

For authorized platform-package delivery, follow project requirements for a real CLI conversation and TUI/GUI startup using that target package. GUI startup, component preview, full interaction and another platform are separate results. Use the existing `DEEPCODE_USER_ROOT` when isolated data is needed; inspect current package entrypoints and cleanup ownership rather than assuming a web proxy can start an independent Kernel.

When builds fail, first check the entrypoint, environment and tracked inputs. Resolve missing-lock versus enforced-lock conflicts in the responsible build path, not by deleting every lockfile; root Cargo and tracked pnpm lock policies may differ. Preserve failures and stop repeated testing once the required checks and changed behavior are established.
