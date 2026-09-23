# Evidence-based simplification

Find a maintenance cost, trace consumers and ownership, compare the value of keeping it, and make the smallest complete change. Borrow this reasoning from other repositories without importing their storage design, Agent Notes, branch policy, test commands or dependency rules.

## Survey the requested scope

Start with large changes or complex modules. Search exact symbols, wire strings, events, settings keys and registration/loading paths, then read callers and adjacent lifecycle code. Distinguish production code, public user/plugin entrypoints, tests, examples and documentation. Examples and scripts can be installation, smoke or runtime entrypoints; inspect their use before treating them as disposable support material.

For a whole-repository review, cover Kernel/Runtime, Session/Protocol, GUI, CLI/TUI/Host, plugins/Skills and build/test support. Read large modules by function or related function group and record coverage. Counts are navigation aids, not proof of review. Inspect generated sources through their generator and consumer; avoid rereading copied build output to inflate coverage. Merge cross-module findings into one candidate instead of creating repeated work items.

A short task receipt can record location, consumers/owner, proposed change, behavior impact and decision/verification. Reuse the current receipt location; do not create another permanent fact database, fixed audit-ID system or Agent Notes hierarchy.

## Prove or reject candidates

| Candidate | Evidence supporting simplification | Reasons to retain it |
| --- | --- | --- |
| Unused function, export or setting | No actual caller after checking static references, dynamic registration, configuration and public entrypoints | External plugin API, runtime name lookup or packaging consumer |
| Mirrored structures | One owner already provides the fact; another representation only copies it without an independent purpose | Snapshot or request-binding semantics intentionally preserve a value across time |
| Repeated validation, clone, freeze or digest | The same input is proved repeatedly within the same ownership and lifetime boundary | Wire/persistence parsing, transactional state, idempotency or content integrity has a distinct responsibility |
| Forwarding layers and adapters | Combining them removes representations and maintenance while retaining errors/cancellation | Different supported protocols or owners actually need the seam |
| Async flags/promises/sentinels | Multiple mechanisms mirror the same state transition | Separate cancellation, first terminal outcome, rollback, process ownership or disposal completion |
| Hand-written infrastructure | A runtime builtin covers the needed semantics and replacement removes net complexity | Residual glue is larger, or a new dependency changes an unsettled contract |
| Comments and prose | Restating code, outdated status or narration of how a change was made | Explaining a non-obvious current constraint, unit, failure condition or cleanup requirement |

For defensive operations, ask where the value came from, who owns it next, whether it crossed a process/persistence/queue boundary, who can independently change it and what failure means. Typed internal calls do not justify removing external JSON parsing; conversely, do not copy the same proof through every readonly in-process call.

For asynchronous code, map resource owners and preparation, publication, execution, cancellation, completion and disposal. Consolidate duplicate representations of one fact, but retain independently living requests, processes, pages and modules.

For dependency replacements, consider runtime builtins first. Check current official documentation, maintenance and dependency cost for an actual third-party candidate. A material dependency or behavior choice needs explanation and the user's decision; fewer handwritten lines alone do not settle it.

## Close the change

An accepted candidate states the observable behavior retained and the maintenance surface removed. Give the strongest actual counterargument for retained/rejected candidates. No quota of findings or deletions is required.

After editing, search exact names and direct consumers again; update unused exports, build wiring, documentation and styles. Follow project rules for test assets rather than rewriting failures to match the new output. A historical test or architecture check can be stale, but its changed invariant must be explained.

Unchanged modules can be explicitly retained. Do not add hypothetical future capabilities or already resolved historical issues to the task. Keep coverage and execution history in the task receipt, not the long-term architecture plan.
