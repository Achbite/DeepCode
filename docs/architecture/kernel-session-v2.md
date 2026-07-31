# Kernel–Session v2 protocol boundary

Status: frozen for the `kernel-session-protocol-cutover` batch.

The public ABI is `deepcode.kernel.abi.v2`. This is its first live version; no
v1 command, event, persistence, or mutation compatibility is part of the
contract.

## Ownership

Kernel owns the compiled tool registry, target and scope canonicalization,
workspace binding, settings ceilings, capability leases, admission, execution,
cancellation, resources, canonical facts, and audit evidence.

Session owns the loop, provider lifecycle, context and memory, natural-language
plans, structured plan revisions, task settlement, reconciliation, review
narration, and the semantic shared-conversation projection.

Host owns workspace management, trusted user-decision capture, projection
storage and transport, and user-initiated private-trace audit export. Host does
not reinterpret projection semantics, canonicalize authority scopes, mint
Kernel leases, or execute agent tools.

The effective authority for an invocation is the intersection of:

```text
Host-managed settings ceiling
∩ confirmed PlanAction scope
∩ effective compiled-tool availability
```

Model narration and Session-provided canonical values are never authority
inputs.

## Tool registry and context

The ABI identifies a tool by a validated namespaced string and raw JSON
arguments. Tool-specific Rust types stay behind the registry adapter.
Cross-language canonical digests use UTF-16 object-key ordering and permit only
JSON numbers that are IEEE-754 safe integers. Decimal, non-finite, and
out-of-safe-range numbers fail before persistence or authority admission rather
than acquiring different Rust and TypeScript digests.

The single compiled registry contains 19 identities. Thirteen are initially
ready. `fs.rename`, `git.status`, `git.diff`, `git.stage`, `git.unstage`, and
`git.commit` are compiled disabled and have no executor binding. A runtime
decision can revoke a ready tool but cannot enable a compiled-disabled tool.

Each registration owns:

- immutable identity, description, input schema, and prompt fragment;
- risk, effect class, scope model, and settings capability;
- canonicalizer, policy metadata, executor binding, verification, cleanup, and
  cancellation behavior.

`RunOpen` returns a safe `ToolContextBundle` containing the ready projection,
catalog and context versions, digests, schemas, and the compiled prompt block.
It never contains a run capability, user-decision capability, lease, secret, or
absolute workspace path. Session injects the block without rewriting it and
records the context version on every provider request and tool intent.

Availability changes are facts. A context invalidation makes old intents stale;
Session fetches the replacement once before the next provider turn.

## Session bootstrap and provider context

Before `RunOpen`, Host freezes the exact high-water and canonical root of the
Session's already durable public v2 `AgentEvent` prefix. The bootstrap carries
that root plus a bounded suffix, omitted count, and suffix digest. The bounded
suffix is the only prior-event source admitted to model memory: Session
strictly decodes only public v2 `user_msg` and `assistant_msg` text from it and
excludes the current Run. Prior-memory attachments are always empty: a prior
Session's message/session attachment references are not an active-set authority
source and cannot be resurrected without a separate durable
snapshot/delta/tombstone contract. Unsupported historical schemas fail closed.

Timeline projection is a separate data path. When the bounded bootstrap omits
events, Session reads the complete frozen prefix from a private, paginated Host
endpoint. Host chooses the immutable high-water from the durable Run bootstrap;
the client cannot widen it. Every page and continuation is bound to the exact
Session, Host Run, Kernel Run, snapshot digest, source root, and monotonic event
index, and the request still requires the process-private Run capability.
Session verifies page digests, continuity, the complete source root, and the
bootstrap suffix before projecting. These full-history pages never enter the
provider request, memory builder, capability scope, or authority calculation.
The current full-timeline projection transport remains explicitly bounded; an
oversized frozen prefix returns a typed projection-limit failure. Arbitrarily
long histories require a future delta or paginated Host/UI timeline contract,
not silent truncation.

Inside an active Run, earlier user text remains bounded Session-owned
conversation context. It is assembled with the frozen prior-Run memory, while
earlier attachments are never carried forward. Prior provider answers and
outcomes remain in their separate bounded outcome section.

For the current input UI, the attachment array is a complete effective snapshot,
not a capability. `message` entries are one-shot. `session` entries are retained
as a local draft and become durable only when the user sends the next input;
reload restores the latest committed input's `session` entries as a visible
draft. They are not injected until the user sends again, and every file read
still requires a normal Kernel `contextRead` ToolIntent. This draft behavior is
separate from prior-memory construction above and creates no hidden attachment
authority.

Host also freezes the selected provider profile identity,
`contextWindowTokens`, and `maxOutputTokens`, bound to the immutable profile
revision digest. Session reserves the output budget and assembles provider
context deterministically in this order:

```text
Kernel fixedPrompt bytes
→ Session protocol contract
→ current input and attachments
→ bounded earlier current-Run user text and prior-Run memory
→ current Plan and decision
→ bounded prior provider outcomes
→ canonical Kernel facts
```

The Kernel prompt bytes and tool semantics are not rewritten. Each
Provider lifecycle records retain the profile binding, input budget, memory
snapshot/omission/digest, and deterministic trimming receipt, but lifecycle
records are not permanent conversation blocks. The replaceable run projection
may expose a safe current activity while the provider is active. Provider
completion records retain the provider profile, provider, model, and validated
nonnegative bounded token usage returned by the provider. The timeline
token-usage projection accepts documented snake_case and camelCase provider
counters; it does not synthesize cache telemetry.
`estimatedInputTokens` conservatively counts one budget unit per UTF-8 byte over
the actual message and encoded tool-definition envelope. This intentionally
underfills tokenizers whose tokens cover multiple bytes; it does not claim to
reproduce a provider's private tokenizer. Authoritative token usage is recorded
only from validated provider usage metadata.

## Run and trust boundary

Host resolves an opaque `workspaceBindingRef`. A Host-only `RunOpen` binds one
run permanently to that workspace, creates control epoch 1, and returns a run
capability to the Session transport adapter. The capability is never placed in
model context. A `runId` alone grants no access.

Input attachments contain only normalized workspace-relative paths and optional
opaque resource/folder identities. Host binds a supplied folder identity to the
Run's exact canonical root and rejects an unverifiable or different root; a CLI
Run without a trusted folder identity may only omit it. Attachments neither
resolve resources nor grant read authority by themselves.

The local default settings ceiling covers workspace-local file reads and
writes. It does not itself authorize a mutation. Context reads can derive an
epoch-bound capability from the run trust settings. Mutations require a
confirmed PlanAction scope. Network, cross-workspace, and future process
capabilities require explicit settings and plan scope.

The settings ceiling is captured when a Run is opened. A Host settings change
retires affected active Runs and applies to newly opened Runs; it does not
silently widen or narrow authority inside an existing Run.

Mutation plans require user confirmation by default. An explicit Host setting
may allow automatic capability issuance inside a recorded trust lease, but the
plan revision must still be persisted and projected.

Ordinary Session and CLI commands use the untrusted command ingress. User
decisions use a distinct Host-only ingress protected by a short-lived
capability bound to the run, decision, expected versions, and digest. A payload
claim such as `trusted: true` has no meaning.

The private prior-history read is transport-only and Run-bound. Its continuation
is a cursor, not a credential; it cannot replace the Run capability or be
reused across Runs. Appends after the frozen high-water are excluded and are
projected only through the current Run's durable projection history.

The browser-facing Host façade accepts only exact Plan/capability decisions and
authority revocations under Host-shell admission. For a revoke, Host first
persists the resolved Kernel Run, control epoch, decision, and request identity,
then consumes the process-private decision capability. An unknown response is
recovered by replaying that exact bound decision; Host never re-resolves a
lease or trust policy after the first revoke may have removed it.

## Plan scopes and invocation

Session persists both the natural-language plan and a structured scope
manifest. Kernel receives only the latter:

```text
planRevision
planActionId
operationId
toolId
requested resource scope or exact invocation scope
```

Kernel resolves and canonicalizes the scope and returns an authorization
summary plus digest. It may narrow or reject the request; it cannot silently
expand it. Host confirms the exact digest. Kernel then issues an immutable,
versioned capability lease bound to run, workspace, control epoch, plan
revision, tool context, and PlanAction.

A PlanAction lease is reusable inside the same epoch for the same approved
tools and resources. Every use still receives independent invocation, attempt,
effect, and fact identities.

Provider-native calls and parser-validated text frames normalize to:

```text
ToolIntent {
  toolId
  rawArguments
  operationId
  planActionRef | contextRead
  idempotencyKey
  toolContextVersion
}
```

Ordinary narration is not executable. Session sends a ToolIntent once. Kernel
revalidates schema, targets, settings, context, and lease:

- in scope: persist the attempt before the effect boundary and execute;
- missing scope: persist an `AwaitingCapability` invocation and release all
  executor resources before asking Host;
- allowed expansion: issue a new immutable lease version, re-resolve the
  target, create a new attempt, and continue the same invocation;
- denied expansion: persist denial and return structured guidance to Session;
- after an observable effect: never request an expansion or automatically
  continue; settle as observed failure or indeterminate.

For future tools whose resource effects cannot be bounded, the only reusable
authority form is an exact canonical invocation digest including command,
working directory, environment, and declared process or network effects.

## Control, facts, and recovery

New user authority is processed in this order:

```text
persist Session input
→ fence local Provider/output admission and checkpoint the pending input
→ advance Kernel control epoch
→ supersede old leases and pending decisions
→ request cancellation
→ reduce Kernel facts
→ start the next provider turn
```

Cancellation is not rollback. Late decisions for stale epochs, contexts,
leases, cancelled invocations, or terminal invocations have no effect.

An explicit user cancellation uses a private, high-priority Host–Session
control operation. It does not wait for the ordinary Provider-operation
admission lane and does not occupy the ordinary Run caller drive. Session first
fences new Provider output and effect/query transport, replays only pending
authority-reducing control requests, and submits the public
`InvocationCancel(currentForRun, userRequested)`. A pending mutation is never
first-dispatched or replayed by cancellation; without a no-effect proof the Run
becomes indeterminate and is safety-retired. Otherwise Session reconciles exact
fact barriers, checkpoints, and publishes a durably acknowledged
`run.cancelled` projection. Only after Host validates that exact caller,
operation, facts, and projection correlation may it retire Kernel authority and
the Host Run; the owned bridge is removed last. A lost or unverifiable
acknowledgement triggers safety cleanup, but it is indeterminate and must never
be presented as canonical cancellation.

The only execution fact store is the SQLite canonical fact store. Its public
domains are Control, Authorization, Invocation, Effect, Resource, and Cleanup.
Facts are queried with a run capability and a bounded ledger cursor. Status and
notifications are hints; facts are authoritative.

The Session lineage is:

```text
task / PlanAction
→ operation
→ lease and version
→ invocation and attempt
→ fact and effect
```

Exact request identity and payload digest are replayable. Reusing an identity
with another digest is a permanent conflict. Unknown transport outcomes are
recovered with the same identity or facts query. An indeterminate mutation is
never automatically retried.

Review binds to a fact-store high-water mark and compares the original plan,
approved scope amendments, actual effects, denied and unexecuted operations,
cleanup, and indeterminate state. New facts create a new review revision.
Unexecuted PlanActions are derived from the immutable Plan and canonical facts;
there is no separate `SkipPlanAction` mutation or narration-controlled shortcut.

For a Run that used a Plan or Kernel tools, a finalized Review is not the
terminal user answer. After actions, facts, cleanup, and indeterminate state
have settled, Session freezes the Review at an exact fact high-water and starts
a no-tools final-answer provider turn bound to the control epoch, plan
revision, review revision, and high-water. A changed high-water makes that
candidate stale without rerunning tools. Only a committed final answer, a
terminal final-answer failure, cancellation, or another canonical terminal
condition may complete the public turn and retire the Host Run. Pure
question-and-answer turns may complete in one provider turn.

## Shared conversation projection

The canonical public read model remains
`deepcode.shared-conversation-projection.v2`. Native records additionally
require:

```text
shapeVersion = deepcode.shared-conversation.work-segments.v1
```

Every native turn contains three coordinated collections:

```text
blocks       = user text, assistant commentary/final text, interactions,
               Review, and necessary diagnostics
workSegments = ordered Kernel/Session work derived from canonical facts
parts        = the sole public ordering of block and work-segment references
```

Provider lifecycle, wait changes, workflow stages, context refreshes,
cancellation requests, and ToolIntent submission update a replaceable
`runProjection` or an existing work segment. They do not append permanent
conversation cards. Reasoning, raw provider envelopes, raw tool arguments, and
raw AgentEvents never enter this read model.

Assistant text may carry the optional provider metadata
`commentary | final_answer`. Absence means unknown and is never inferred from
text. Structural settlement may assign an unknown no-tools response the public
final-answer role without rewriting the missing provider metadata. Commentary
is a hard boundary between adjacent work segments.

A work segment has a stable identity and revision, lifecycle
`active | completed | cancelled | failed`, one orthogonal attention state, and
ordered operations. An operation is stable by Session `operationId`; Kernel
admission adds `invocationId`, while attempts remain nested evidence. Tool
arguments are never streamed publicly. Only catalog-validated tool identity,
Kernel-canonical targets, resource references, facts, and effect summaries may
populate a public operation.

The replaceable run projection carries `currentActivity` and `wait`. Current
activity codes are limited to:

```text
session.admitting
provider.awaitingFirstByte
provider.reasoning
provider.composing
resource.resolving
kernel.executing
session.validating
session.persisting
retry.backoff
```

Shells may render these semantics at different densities, but cannot convert
them into durable messages or parse localized text to derive state.

The Session timeline stream exposes only version-bound public snapshot/delta
data. A delta binds base and next revisions and atomically replaces complete
affected turns or root projections. Revision gaps require a fresh snapshot,
and terminal delivery is reconciled with a final snapshot. GUI, CLI, and TUI
use the same typed reducer.

Settled historical flat-v2 timelines are normalized read-only by preserving
the original block order, setting `workSegments = []`, and generating `parts`
as the same ordered block references. No legacy group field is added and no
tool, path, permission, or effect semantics are invented. Historical bytes
are not rewritten. An active v2 checkpoint or queue without the work-segment,
provider trace, and final-answer state returns `UnsupportedHistorySchema`.

## Provider streaming and private trace

OpenAI-compatible, Anthropic, and Ollama provider transports use one streaming
production path. Native completion is provider-specific:

- OpenAI-compatible requires `stop | tool_calls` and `[DONE]`;
- Anthropic requires `message_stop`;
- Ollama requires `done:true`.

EOF, disconnect, cancellation, unsupported finish reasons, and length or
content filtering are not successful completion. No ToolIntent is admitted
until the complete native response, provider protocol, durable trace, and
ordered tool-call queue checkpoint have all been validated.

Every provider turn, including the post-Review final answer, requires nonempty
readable reasoning through a profile-declared `reasoningTransport`. Supported
plaintext sources are OpenAI `reasoning_content`/`reasoning`, Anthropic
`thinking_delta`, and Ollama `thinking`/`reasoning`. Opaque, signed, or redacted
blocks do not satisfy the requirement. A profile without a statically
compatible transport remains visible but unavailable. Missing runtime
reasoning fails the turn before tools or final content and quarantines the exact
profile revision until explicit re-enable or a new configuration revision.

The daemon stores one plaintext `deepcode.session.provider-trace.v1` per
provider turn. It contains the exact serialized outbound request bytes,
normalized chronological events, raw upstream envelopes, terminal state, and a
monotonic digest chain and seal. The exact bytes archived for a request are the
bytes sent on the network. Secrets, authorization and cookie headers, Kernel
capabilities, and leases are excluded before trace serialization.

Trace publication follows archive-before-publication. Buffered data is flushed
after 250 ms or 16 KiB, whichever occurs first, and at request, response, and
terminal boundaries. Raw upstream source bytes have a 1 MiB soft per-turn
limit: the complete envelope that crosses the limit is archived once, then the
turn terminates without tool admission. One raw envelope and one outbound
request each have an independent 16 MiB hard limit. Trace directories use mode
0700 and files use 0600.

Archived Sessions retain traces. Explicit Session deletion uses visible,
retryable two-stage deletion. It does not claim cryptographic erasure or
removal from filesystem snapshots or backups.

Private trace contents have no Session/model, CLI, TUI, public projection,
Copy, Memory, GoalProjection, or cache ingress. A GUI Session-menu user action
may list metadata and mint a process-memory capability bound to the exact
Session, Run, trace digest, request identity, and payload digest. The
capability lasts 60 seconds, permits only idempotent replay of that one logical
request, and is invalid after daemon restart. Export revalidates the trace
chain and seal, uses no-store/nosniff response headers, and audits metadata and
result only.

## Host management and removal boundary

Workspace, inspection, skill administration, and audit are Host services.
Terminal, browser UI, and provider transport remain valid Host or Session
infrastructure. If an agent may invoke any such capability in the future, it
must be introduced as a normal compiled Kernel tool.

The final cutover has no live v1 route, v1 client, ActionBatch, WorkUnit,
ReviewGate, direct Runtime ledger access, dual catalog, dual write, downgrade,
archive decoder, or mutation compatibility. Historical bytes are not rewritten;
only their schema discriminator may be inspected to return
`UnsupportedHistorySchema`.
