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
plans, structured plan revisions, task settlement, reconciliation, and review
narration.

Host owns workspace management, trusted user-decision capture, and projection.
Host does not canonicalize authority scopes, mint leases, or execute agent
tools.

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

## Run and trust boundary

Host resolves an opaque `workspaceBindingRef`. A Host-only `RunOpen` binds one
run permanently to that workspace, creates control epoch 1, and returns a run
capability to the Session transport adapter. The capability is never placed in
model context. A `runId` alone grants no access.

The local default settings ceiling covers workspace-local file reads and
writes. It does not itself authorize a mutation. Context reads can derive an
epoch-bound capability from the run trust settings. Mutations require a
confirmed PlanAction scope. Network, cross-workspace, and future process
capabilities require explicit settings and plan scope.

Mutation plans require user confirmation by default. An explicit Host setting
may allow automatic capability issuance inside a recorded trust lease, but the
plan revision must still be persisted and projected.

Ordinary Session and CLI commands use the untrusted command ingress. User
decisions use a distinct Host-only ingress protected by a short-lived
capability bound to the run, decision, expected versions, and digest. A payload
claim such as `trusted: true` has no meaning.

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
→ advance Kernel control epoch
→ supersede old leases and pending decisions
→ request cancellation
→ reduce Kernel facts
→ start the next provider turn
```

Cancellation is not rollback. Late decisions for stale epochs, contexts,
leases, cancelled invocations, or terminal invocations have no effect.

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
