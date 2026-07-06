# Session Protocol

This directory owns the current provider proposal protocol surface for
`@deepcode/session-core`.

- `protocolV3.ts` parses Agent Protocol v3 proposal envelopes.
- `protocolContract.ts` renders provider-facing protocol and tool-shape
  fragments used by prompt and repair builders.
- `types.ts` defines the parsed proposal/read-model shapes consumed by the
  Session driver.

Driver-level admission, canonicalization, and semantic validation stay under
`driver/proposal/`. They wrap this protocol parser but do not own the wire
schema.

Compatibility note:

- Parsed compatibility fields may remain in `types.ts` and `protocolV3.ts` so
  archived sessions can still be read.
- Provider-facing prompt and repair text should not teach deprecated graph or
  dependency fields unless a separate protocol migration explicitly restores
  them.
- Prompt rendering uses `RenderedProviderTurnContract` under `prompt/`; driver
  runtime state uses `DriverProviderTurnFrame` under `driver/runFrame.ts`.
