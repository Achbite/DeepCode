---
name: deepcode-release-audit
description: Audit and simplify DeepCode before release, remove redundant product prose, and synchronize its READMEs and user documentation with implemented behavior. Follow the requested analysis or editing scope; this Skill does not itself authorize packaging or publication.
---

# DeepCode release audit

Review the implementation and its user guidance together. Remove demonstrated redundancy while preserving supported behavior and architectural ownership. This is a preparation workflow, not a new release approval system.

Read the effective project `AGENTS.md` and establish the actual checkout, existing changes and intended release scope. Preserve the distinction between an analysis request and authorized cleanup. For analysis, return concrete accepted/rejected proposals; for requested simplification or documentation synchronization, implement the authorized changes and validate them.

Read resources with `skill.read`, name `deepcode-release-audit`, and only the relevant relative path:

- [references/simplification.md](references/simplification.md): consumer evidence, ownership and simplification decisions.
- [references/product-docs.md](references/product-docs.md): README structure, product prose and documentation consumers.

## Review and simplify

Start with the release changes and their directly affected callers. When the user requests the whole repository or every function/module, inventory maintained source and inspect implementations, functions, dynamic entrypoints and consumers across that scope. Record reviewed and unreviewed portions with reasons for excluding generated or external material. A symbol list, scanner output or diff-only review does not establish function-by-function coverage.

For each candidate, identify the actual maintenance cost, production consumers and data/resource owner. Decide to remove, merge, retain or request a material decision. Prioritize dead code, mirrored facts, duplicate adapters and repeated proofs. Keep independently necessary transactions, cancellation, terminal-outcome arbitration, public plugin contracts and boundary validation.

Implement local simplifications within confirmed contracts, including newly unused exports, configuration, styles and documentation links. A change to supported capability, a public port or unresolved semantics is a product decision rather than cleanup; explain the concrete choice before changing it. Do not turn speculative issues or project non-goals into release blockers.

## Synchronize product guidance

Align English and Chinese READMEs, affected `docs/product/` pages, installation guidance, plugin instructions, compiled-in document registration and packaging consumers. Describe available functionality, usage, configuration, update timing and limitations. Move development plans, internal implementation explanations and test/review receipts to their owning development material. Public extension APIs and explanations needed for a user's decision remain valid product content.

Clean redundant development narration from shipped UI copy while retaining permission scope, cost meaning, actionable instructions and real errors. Prototype explanations and example data belong to review surfaces, not the default product UI.

## Validate and hand over

Use the existing required checks and focused verification for the actual changes. Follow project test-change rules before editing test assets; removing tests, skipping checks or weakening assertions requires the corresponding decision. Tests being the only callers does not by itself justify deletion. For documentation-only changes, use appropriate static, link and content checks instead of automatically starting full runtime acceptance.

Verify commands, anchors, configuration keys and capability statements against their actual entrypoints. Distinguish source implementation, packaged contents, running resources and published downloads. Build or run platform packages only when that is in the task's authorized scope.

Deliver the coverage, implemented simplifications, significant retained/rejected candidates, documentation changes, validation and relevant remaining acceptance items. If prompt auditing is requested, provide the exact requested originals and translations. Stop at user acceptance unless subsequent Git actions were already authorized; do not infer commit, PR, merge or tag authority from this Skill. Follow the current project release process for any authorized continuation.
