# Session Driver Boundaries

The driver is the Session orchestration layer. It wires provider turns,
resource context, proposal routing, accepted-plan execution, user decisions,
review assembly, and projection events. It does not own Kernel permission
semantics, tool execution, Kernel facts, or UI rendering.

`sessionDriverLoop.ts` is now a dispatcher and wiring surface. Further
extraction should happen only when it creates a stable class or factory
boundary. Do not split code only to reduce line count.

Top-level support files:

- `runFrame.ts`: driver run-frame, provider-turn frame, and loop runtime state
  types.
- `runtimeSupport.ts`: shared driver support helpers used by wiring and
  projection builders. Keep generic parsing, clipping, language, and diagnostic
  helpers here instead of growing the loop.

## Directories

- `context/`: context frames, resource requests, resource evidence, and
  resource resume orchestration.
- `diagnostics/`: driver and protocol diagnostic catalogs.
- `execution/`: accepted-plan cursor, scope, admission, task ledger, and action
  execution orchestration.
- `hooks/`: hook type and runtime placeholders. This area is intentionally not
  expanded in the current session-loop slimming work.
- `interactions/`: requirement, plan, permission, and review decision handlers.
- `pipelines/`: provider, native-tool, lifecycle, permission, compaction, and
  stop pipelines.
- `projection/`: projection read-model builders.
- `proposal/`: protocol gate, proposal router, semantic validation, and proposal
  handlers.
- `review/`: review handoff, review assembly, and answer facts context.

## Extraction Rules

Keep logic in `sessionDriverLoop.ts` when it is only phase transition,
constructor wiring, or cross-component glue.

Extract logic when it owns a coherent domain boundary, removes repeated Kernel
reply parsing, removes duplicated projection assembly, or prevents provider
prompt/repair entry points from drifting apart.

Provider behavior quality issues, such as repeated reads or weak plan task
shape, belong to ProviderTurnContract or PlanContract work. Do not solve those
by adding test-specific branches to the loop.
