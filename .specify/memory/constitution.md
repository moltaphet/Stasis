<!--
Sync Impact Report
==================
Version change: (none) -> 1.0.0
Bump rationale: Initial ratification. The prior file contained only unfilled
  template placeholders; this is the first concrete adoption, so MAJOR = 1.

Modified principles:
  - [PRINCIPLE_1_NAME] -> I. Pure ASCII and English (NON-NEGOTIABLE)
  - [PRINCIPLE_2_NAME] -> II. GenVM Storage and Structure Discipline
  - [PRINCIPLE_3_NAME] -> III. Non-Deterministic Isolation
  - [PRINCIPLE_4_NAME] -> IV. EVM Emergency Dispatch
  - [PRINCIPLE_5_NAME] -> V. Autonomous Protocols Track Alignment

Added sections:
  - Additional Technical Constraints (was [SECTION_2_NAME])
  - Development Workflow and Quality Gates (was [SECTION_3_NAME])
  - Governance (populated)

Removed sections: none

Deferred TODOs: none. RATIFICATION_DATE set to first adoption date 2026-09-03.

Templates and downstream commands read this file at runtime; no template
source files were modified by this update.
-->

# Stasis Protocol Constitution

## Core Principles

### I. Pure ASCII and English (NON-NEGOTIABLE)

All contracts, tests, scripts, and documentation MUST be strictly pure ASCII
and pure English. Zero non-ASCII characters are permitted anywhere in the
repository, including em-dashes, smart quotes, arrows, accented letters, and
emoji. Use the hyphen-minus character for dashes and standard straight quotes
for quotation. Any file containing a byte outside the 0x00-0x7F range MUST be
rejected before merge.

Rationale: GenVM determinism, cross-validator reproducibility, and reliable
diff review all depend on a single unambiguous byte encoding. Hidden non-ASCII
characters produce silent equivalence failures and unreviewable diffs.

### II. GenVM Storage and Structure Discipline

Contract structure MUST follow GenVM conventions without exception:

- The file header MUST be exactly, byte for byte:
  `# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }`
- Persistent state MUST use GenVM state primitives: TreeMap, DynArray, Address,
  u256, and u32. Raw Python `dict`, `list`, or `int` MUST NEVER be used for
  persistent contract storage.
- Every storage class MUST be annotated with both `@allow_storage` and
  `@dataclass`.

Rationale: The pinned dependency hash guarantees a reproducible runtime across
validators. GenVM state primitives provide the deterministic, bounded, and
serializable storage semantics that raw Python containers cannot guarantee.

### III. Non-Deterministic Isolation

Non-deterministic execution MUST be fully isolated:

- Every `gl.nondet.web.*` call and every `gl.nondet.exec_prompt` call MUST be
  wrapped inside `gl.vm.run_nondet_unsafe`.
- Contract storage MUST NEVER be mutated inside a non-deterministic closure.
  State transitions derived from non-deterministic results MUST occur only in
  deterministic code after the closure returns and consensus is reached.

Rationale: Web reads and prompt executions are non-reproducible by nature.
Confining them to the sanctioned wrapper and forbidding storage mutation inside
them preserves validator consensus and prevents divergent state.

### IV. EVM Emergency Dispatch

Emergency halts and cross-chain effects MUST be dispatched to EVM through the
sanctioned interface:

- EVM interaction MUST use `@gl.evm.contract_interface`.
- Emergency halt dispatch MUST call `.emit()` on transaction finalization, so
  the effect is committed only when the GenLayer transaction is finalized.

Rationale: Binding emergency halts to finalization prevents premature or
orphaned cross-chain side effects and keeps the EVM view consistent with
finalized GenLayer state.

### V. Autonomous Protocols Track Alignment

All work MUST align with the Autonomous Protocols track of the GenLayer The
Tank Hackathon. Features, specifications, and plans MUST advance an autonomous,
self-governing protocol; scope that does not serve this track MUST be deferred
or rejected.

Rationale: A single, explicit track keeps the protocol design coherent and
every contribution measurable against the hackathon objective.

## Additional Technical Constraints

The GenVM and GenLayer stack is the mandatory runtime target. The following
constraints apply across all contract code:

- Contracts MUST pin the exact `Depends` hash defined in Principle II.
- Persistent storage MUST use only the primitives named in Principle II
  (TreeMap, DynArray, Address, u256, u32).
- Non-deterministic access to the web or to prompt execution MUST route through
  the wrapper named in Principle III.
- Cross-chain emergency dispatch MUST use the EVM interface and finalization
  emit pattern named in Principle IV.
- All source, tests, and docs MUST satisfy the pure ASCII and English rule in
  Principle I.

## Development Workflow and Quality Gates

- Every change MUST pass an automated pure-ASCII scan before merge; any byte
  outside 0x00-0x7F fails the gate.
- Every contract MUST be linted against the GenVM structure rules (header,
  storage primitives, `@allow_storage` plus `@dataclass`) before merge.
- Pull requests MUST document how the change preserves non-deterministic
  isolation and, where relevant, the EVM finalization emit path.
- Reviews MUST verify Autonomous Protocols track alignment for new features.
- Any deviation from a principle MUST be justified in writing and approved
  before merge, or the change MUST be reworked to comply.

## Governance

This constitution supersedes all other development practices for the Stasis
Protocol. When any guidance conflicts with this document, this document wins.

Amendment procedure: Proposed amendments MUST be submitted as a written change
to this file, MUST state the motivation and the affected principles, and MUST
be approved by project maintainers before merge. Each amendment MUST update the
version and the Last Amended date and MUST prepend an updated Sync Impact
Report.

Versioning policy (semantic versioning):
- MAJOR: Backward incompatible governance or principle removals or
  redefinitions.
- MINOR: A new principle or section is added, or existing guidance is
  materially expanded.
- PATCH: Clarifications, wording, and non-semantic refinements.

Compliance review: All pull requests and reviews MUST verify compliance with
every principle above. Non-compliant changes MUST NOT be merged. Complexity
that appears to violate a principle MUST be justified in writing or removed.

**Version**: 1.0.0 | **Ratified**: 2026-09-03 | **Last Amended**: 2026-09-03
