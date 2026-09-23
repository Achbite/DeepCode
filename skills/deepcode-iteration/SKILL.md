---
name: deepcode-iteration
description: Iterate on DeepCode itself, including its UI, Session/Agent Loop, Kernel tools and plugins; choose the owning layer and the correct update workflow. Not for developing unrelated projects with DeepCode.
---

# DeepCode iteration

Use this Skill for changes to DeepCode itself. Preserve whether the user requested analysis, a prototype, implementation or acceptance. Existing authorization and confirmed decisions remain valid; reading this Skill does not approve a Plan, grant execution permission or authorize publication.

Establish the actual source checkout, branch and existing changes. Read the effective project `AGENTS.md`, including applicable instructions in an outer worktree directory. Do not assume a personal path, a particular branch or that the running application uses this checkout. Recent conversations can explain decisions; use exact supplied session IDs with `session.read` and verify historical claims against current code. Do not scan unrelated user data for history.

Read resources with `skill.read`, name `deepcode-iteration`, and only the relevant relative path:

- [references/implementation-map.md](references/implementation-map.md): ownership, source entrypoints and plugin forms.
- [references/update-modes.md](references/update-modes.md): edit/preview/update workflows and verification.

## Implement at the owning layer

Trace the input, producer, contract, consumer and state owner before editing. Session owns the single Loop, context, interactions and semantic projection; Kernel owns tools, permissions and execution facts; shells present shared results and collect input. Approved changes can span layers without another architecture decision. Present a concrete recommendation only when new evidence exposes an unresolved public contract or material behavior choice.

For UI customization, first inspect existing components and display slots. Use the plugin form suited to the requested change; extend a slot only with data and actions from its existing owner. Do not give a display plugin a second conversation store, permission model or settings source. Keep ordinary tool changes out of the Loop unless its contract actually needs to change.

For tools and plugins, follow registration, availability, activation, request binding, execution, output and disposal. Writing a plugin, adding a source and successfully running a contribution are distinct outcomes. Prefer an appropriate existing CLI; use an established MCP integration when it is simpler and explain the concrete tradeoff.

Use the project's container for dependencies, normal builds and tests after checking its actual checkout mount. Host inspection needed to locate that environment still follows the current execution permission process; a read-only probe does not approve itself. Keep native packaging within the user's authorized platform scope.

## Make the change observable

Choose the update path from the reference: Vite HMR, UI plugin replacement, application interface reload, the next model request, the next run, or a core process restart. Edit, let the appropriate update occur, then observe the same target and exercise the changed behavior. A successful build alone does not establish that the current window or process loaded it.

Run the existing required checks and focused validation appropriate to the change. Follow the project's test-change rules before changing test assets. Keep prototype, fixture, real Provider, native GUI and other-platform evidence distinct; respect manual acceptance retained by the user.

Update directly affected user guidance or public plugin contracts. Report the behavior change, owning layer, update method, actual validation and relevant unverified items. Stop at the requested acceptance boundary. Whole-release cleanup and Git publication are separate scopes; proceed to them only when already requested.
