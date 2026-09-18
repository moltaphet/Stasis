> **SUPERSEDED - pre-hardening MVP.** This document describes the initial MVP
> design (states ARMED/PAUSED, INCONCLUSIVE verdict, single feed, no native escrow).
> The shipped contract has evolved past it: lifecycle states are
> ARMED/TRIPPED/RESTORED/RATE_LIMITED and verdicts are the discrete tiers
> NORMAL / ELEVATED_RISK / CRITICAL_BREACH / MALICIOUS_REPORT, with dual feeds and
> native GEN escrow. Current ground truth: ../../README.md and ./hardening-plan.md.

# Phase 0 Research: Autonomous Circuit Breaker

All Technical Context unknowns are resolved below. Findings are grounded in the
GenLayer documentation (storage, non-determinism, transaction context, EVM
interaction, direct-mode testing, and the GenVM linter) and the project constitution.

## R1: Non-deterministic adjudication and equivalence consensus

**Decision**: Perform telemetry fetch and LLM classification inside a single
`gl.vm.run_nondet_unsafe(leader_fn, validator_fn)` call. `leader_fn` calls
`gl.nondet.web.get(feed_url)` then `gl.nondet.exec_prompt(prompt)`, parses the model
output into a structured, deterministic result (a boolean `is_malicious` plus a
normalized reason code), and returns that structured result. `validator_fn`
independently re-derives its own classification and returns agreement only when its
verdict matches the leader's boolean verdict. The closure returns a parsed boolean,
never raw LLM or web text.

**Rationale**: The constitution mandates that every `gl.nondet.web.*` and
`gl.nondet.exec_prompt` call be wrapped in `gl.vm.run_nondet_unsafe`. Returning a
parsed boolean (not raw model text) avoids GenVM linter rule GL-S03, which flags
equivalence over raw non-deterministic output because such output varies across
validators and would never reach consensus. Reducing the LLM answer to an objective
boolean is the narrowest validation rule that captures the real requirement
(exploit or not), which is the documented best practice for designing for consensus.

**Alternatives considered**:
- `gl.eq_principle.strict_eq(fn)`: simpler, but the constitution specifically names
  `run_nondet_unsafe` as the required wrapper, and an explicit `validator_fn` gives
  precise control over the agreement rule. Rejected to honor the constitution and to
  keep the consensus rule explicit.
- Returning raw LLM JSON and comparing strings: rejected; violates GL-S03 and is
  non-reproducible across validators.

## R2: Deterministic state machine and storage-write placement

**Decision**: Keep all persistent state writes and lifecycle transitions
(ARMED to PAUSED to ARMED) in deterministic contract code, executed only after
`run_nondet_unsafe` returns. Before entering any non-det closure, copy needed storage
values into memory with `gl.storage.copy_to_memory` and pass only memory objects and
plain arguments into the closure.

**Rationale**: The documentation states that storage writes, cross-contract calls,
and message emission must happen outside non-det blocks, and that storage objects are
not accessible inside them. The constitution forbids mutating contract storage inside
non-deterministic closures. This split guarantees state changes are reproducible from
consensus-agreed values.

**Alternatives considered**: Writing verdict directly inside the closure: rejected;
prohibited by both the platform and the constitution.

## R3: EVM circuit-breaker dispatch

**Decision**: Model the target vault with `@gl.evm.contract_interface` exposing a
`Write.pause()` method and a `View.is_paused() -> bool` method. On a confirmed
malicious verdict, dispatch `TargetVault(target_address).emit().pause()`. This
external message executes on finalization by design. Mark the vault PAUSED in storage
in the same deterministic transaction that emits the message.

**Rationale**: The documentation shows EVM writes via
`Interface(addr).emit().method(...)` and states external messages to EVM contracts
can be emitted only on finality. The constitution requires dispatch via
`@gl.evm.contract_interface` with `.emit()` on transaction finalization. Finalization
gating ensures the protocol never records PAUSED for a halt that did not actually
dispatch, matching spec FR-013.

**Alternatives considered**: `on='accepted'` emission for speed: rejected; external
messages cannot be emitted on acceptance, and acceptance-time emission risks
duplicate or reverted sends across appeal rounds.

## R4: Mock target vault under direct-mode constraints

**Decision**: Provide `contracts/mock_vault.py` as a GenLayer Intelligent Contract
stand-in that exposes `pause()` (write) and `is_paused()` (view) with an internal
`bool` flag. Direct-mode tests verify the guardian's trigger path drives a pause on
this stand-in via cross-contract invocation. The production dispatch path uses the
`@gl.evm.contract_interface` from R3 against a real EVM vault; the interface shape
(pause/is_paused) is identical, so the guardian code path is exercised faithfully.

**Rationale**: The documentation warns that `@gl.evm.contract_interface` calls beyond
value transfers are not functional in Studio, and direct mode runs contract code
in-process without a live EVM. A GenLayer IC stand-in lets the test suite assert the
end-to-end trigger, state flip, and idempotency without a live cross-chain target,
while the guardian keeps the constitution-mandated EVM interface for production.

**Alternatives considered**: A live testnet EVM Solidity contract in the direct
suite: rejected for the baseline; too heavy for fast direct tests. It is a candidate
for a later integration-test layer.

## R5: Deterministic incident timestamp and hashing

**Decision**: Capture the incident timestamp from the pinned transaction datetime
using `datetime.now(timezone.utc)`, storing Unix seconds as `u256` and the ISO 8601
string for the audit trail. Derive the incident hash deterministically from the
telemetry payload content (a content hash) so duplicate incidents are detectable.

**Rationale**: Transaction Context documents that the GenVM clock is deterministic
and pinned to the transaction datetime, so `datetime.now(timezone.utc)` is safe for
storage and comparisons across validators. Deriving the incident hash from payload
content gives a stable key for duplicate suppression (spec FR-014).

**Alternatives considered**: `time.time()`: avoided because `time` is on the linter's
discouraged-import list; `datetime` is used in official storage examples and is the
safer choice. Random or counter-based incident ids: rejected; not content-addressable
and cannot dedupe identical incidents.

## R6: Numeric representation for TVL and thresholds

**Decision**: Represent TVL drop threshold and any drop magnitude as integer basis
points in `u256`/`u32`. Perform threshold comparisons with integer arithmetic only.

**Rationale**: GenVM forbids `float()` in deterministic and consensus contexts (the
linter flags non-deterministic float usage), and the constitution bans raw `int` in
storage in favor of sized primitives. Basis points keep money math exact and
reproducible.

**Alternatives considered**: Floating-point percentages: rejected; non-deterministic
and linter-flagged.

## R7: Verification gates and test harness

**Decision**: Establish three ordered gates: (1) `scripts/ascii_scan.sh` pure-ASCII
scan of the repo; (2) `genvm-lint` on both contracts (header, forbidden imports,
non-det and GL-S03 rules); (3) pytest direct-mode suite in `tests/direct/` using
`direct_deploy`, `direct_vm.mock_web`, `direct_vm.mock_llm`, and `run_validator`,
with `direct_vm.strict_mocks = True`. The dashboard adds `tsc --noEmit` and
`next lint`.

**Rationale**: Direct mode runs in-process without Docker and mocks non-deterministic
calls by regex, enabling fast, deterministic tests of registration, false positives,
consensus exploit triggers, and pause execution. `run_validator` lets the suite prove
that a dissenting validator yields an undetermined (non-triggering) outcome. Strict
mocks catch stale patterns. The ASCII and linter gates enforce Principles I, II, and
III automatically.

**Alternatives considered**: Studio or full simulator integration tests as the
primary gate: deferred; slower and unnecessary for the baseline, and EVM calls are
not functional in Studio. Reserved for a later integration-test phase.

## Resolved unknowns summary

| Unknown from Technical Context | Resolution |
|--------------------------------|------------|
| Consensus mechanism for adjudication | R1: run_nondet_unsafe with explicit validator_fn returning a parsed boolean verdict |
| Where storage writes occur | R2: deterministic code after the non-det block; copy_to_memory before closures |
| EVM dispatch mechanism | R3: @gl.evm.contract_interface, emit().pause() on finalization |
| Testing the EVM target | R4: IC stand-in for direct mode; identical interface shape to production |
| Deterministic time and dedupe key | R5: transaction datetime; content-derived incident hash |
| Numeric handling | R6: integer basis points in u256/u32, no floats |
| Validation gates | R7: ASCII scan, genvm-lint, direct pytest, plus tsc/next lint |
