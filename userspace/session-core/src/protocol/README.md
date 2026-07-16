# Session Protocol

This directory owns the current provider proposal protocol surface for
`@deepcode/session-core`.

- `protocolV4.ts` parses Agent Protocol v4 proposal envelopes.
- `protocolContract.ts` renders provider-facing protocol and tool-shape
  fragments used by prompt and repair builders.
- `types.ts` defines the parsed proposal/read-model shapes consumed by the
  Session driver.

Driver-level admission, canonicalization, and semantic validation stay under
`driver/proposal/`. They wrap this protocol parser but do not own the wire
schema.

Protocol v4 does not accept legacy provider aliases. Archived sessions use
their recorded schema version and are rejected before continuation when that
version does not match the active protocol and tool catalog.

Prompt rendering uses `RenderedProviderTurnContract` under `prompt/`; driver
runtime state uses `DriverProviderTurnFrame` under `driver/runFrame.ts`.
