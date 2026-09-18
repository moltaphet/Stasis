> **SUPERSEDED - pre-hardening MVP.** This document describes the initial MVP
> design (states ARMED/PAUSED, INCONCLUSIVE verdict, single feed, no native escrow).
> The shipped contract has evolved past it: lifecycle states are
> ARMED/TRIPPED/RESTORED/RATE_LIMITED and verdicts are the discrete tiers
> NORMAL / ELEVATED_RISK / CRITICAL_BREACH / MALICIOUS_REPORT, with dual feeds and
> native GEN escrow. Current ground truth: ../../README.md and ./hardening-plan.md.

# Implementation Plan: Autonomous Circuit Breaker

**Branch**: `001-autonomous-circuit-breaker` | **Date**: 2026-09-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-autonomous-circuit-breaker/spec.md`

## Summary

Stasis Protocol is an autonomous emergency circuit breaker deployed as a GenLayer
Intelligent Contract. It registers EVM DeFi vaults, fetches live security telemetry
inside a non-deterministic block, adjudicates whether an incident is a genuine
exploit versus benign volatility using multi-validator equivalence consensus, and,
on a confirmed malicious verdict, emits an emergency pause message to the target EVM
vault on transaction finalization. The deliverable is four components: the guardian
Intelligent Contract, a mock target vault for cross-contract verification, a direct
mode test suite, and a Next.js dashboard for judges. All artifacts comply with the
project constitution: pure ASCII, GenVM storage primitives, strict non-deterministic
isolation, and finalization-gated EVM dispatch.

## Technical Context

**Language/Version**: Python 3.12 for the Intelligent Contracts (GenVM target,
pinned `Depends` header); TypeScript 5.x with Next.js 14 (App Router) for the
dashboard.

**Primary Dependencies**: GenLayer SDK / GenVM standard library (`genlayer` module:
`gl.vm.run_nondet_unsafe`, `gl.nondet.web.get`, `gl.nondet.exec_prompt`,
`gl.evm.contract_interface`, storage primitives); pytest with the GenLayer direct
mode plugin (`direct_deploy`, `direct_vm` fixtures); Next.js 14, React 18, the
GenLayer JS client for reads.

**Storage**: On-chain GenVM persistent storage only. `TreeMap` for the vault
registry keyed by target `Address`, `DynArray` for per-vault incident history,
`u256`/`u32`/`Address`/`bool` scalars inside `@allow_storage @dataclass` structs. No
raw Python `dict`, `list`, or `int` in persistent storage.

**Testing**: pytest direct mode for the contracts (in-process, no Docker), with
`mock_web` and `mock_llm` for non-deterministic calls and `run_validator` for
consensus assertions; the GenVM linter (`genvm-lint`) for structure and determinism
rules; a pure-ASCII scanner over the whole repository; `tsc --noEmit` typecheck plus
`next lint` for the dashboard.

**Target Platform**: GenLayer network (GenVM WebAssembly sandbox) for the contracts;
modern browsers served by a Node.js host for the dashboard.

**Project Type**: Web application (on-chain contract backend plus a web frontend),
with a dedicated contracts layer and a test harness.

**Performance Goals**: Adjudication latency is bounded by one web fetch plus one LLM
prompt per run and validator consensus; the demo must show an ARMED to PAUSED
transition within a single judge interaction. The dashboard must reflect on-chain
state changes on refresh or poll within a few seconds. No high-throughput target;
correctness and reproducibility dominate.

**Constraints**: Strict determinism outside non-deterministic blocks; no forbidden
imports (`os`, `random`, `time`) in contracts; deterministic time via the pinned
transaction datetime (`datetime.now(timezone.utc)`); EVM `emit()` restricted to
finalization; TVL and thresholds represented as integers in basis points (no floats).

**Scale/Scope**: Baseline supports many registered vaults in a single guardian
contract, a small fixed set of lifecycle states (ARMED, PAUSED) and verdicts
(NONE, BENIGN, MALICIOUS, INCONCLUSIVE), and a single dashboard surfacing the
registry plus a simulate-exploit control.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution version 1.0.0. Each principle maps to a concrete design commitment and
an automated or review gate.

| Principle | Design commitment | Gate |
|-----------|-------------------|------|
| I. Pure ASCII and English (NON-NEGOTIABLE) | Every file (contracts, tests, docs, dashboard source) is pure ASCII, English only. | Automated: `scripts/ascii_scan.sh` scans the repo for any byte outside 0x00-0x7F and fails CI on a hit. |
| II. GenVM Storage and Structure Discipline | Exact `Depends` header on both contracts; persistent state uses `TreeMap`, `DynArray`, `Address`, `u256`, `u32`; every storage struct is `@allow_storage @dataclass`. No raw `dict`/`list`/`int` in storage. | Automated: `genvm-lint` (header + determinism) plus data-model review; grep gate for banned raw containers in storage declarations. |
| III. Non-Deterministic Isolation | All `gl.nondet.web.get` and `gl.nondet.exec_prompt` calls live inside `gl.vm.run_nondet_unsafe`; storage is copied to memory before non-det use; no storage writes inside non-det closures. | Automated: `genvm-lint` semantic rules (GL-S03 and non-det patterns) plus review of every non-det block; direct test asserting no state mutation from closures. |
| IV. EVM Emergency Dispatch | Target vault modeled with `@gl.evm.contract_interface`; pause dispatched via `.emit().pause()` executed on finalization; vault marked PAUSED only after the dispatch path is taken. | Review gate on the dispatch site plus a direct test verifying the pause path is invoked exactly once and only on a malicious verdict. |
| V. Autonomous Protocols Track Alignment | Fully autonomous adjudication and self-triggered halt; human input limited to registration, configuration, and recovery. | Design review confirms the trigger path requires no human approval between verdict and pause. |

Initial evaluation: PASS. No violations. Complexity Tracking is intentionally empty.

Post-Phase 1 re-evaluation: PASS. The data model uses only sanctioned storage
primitives; the guardian isolates all non-determinism in a single wrapped closure
that returns a parsed boolean verdict (not raw LLM output, satisfying GL-S03); the
EVM interface is defined and dispatched on finalization; no new deviations
introduced. See `research.md` and `data-model.md` for details.

## Project Structure

### Documentation (this feature)

```text
specs/001-autonomous-circuit-breaker/
  plan.md              # This file (/speckit-plan command output)
  research.md          # Phase 0 output (/speckit-plan command)
  data-model.md        # Phase 1 output (/speckit-plan command)
  quickstart.md        # Phase 1 output (/speckit-plan command)
  contracts/           # Phase 1 output (/speckit-plan command)
    guardian-interface.md   # Public methods of stasis_guardian
    evm-vault-interface.md  # EVM pause/is_paused interface contract
  tasks.md             # Phase 2 output (/speckit-tasks command - NOT created here)
```

### Source Code (repository root)

```text
contracts/
  stasis_guardian.py   # Guardian Intelligent Contract: registry, adjudication,
                       #   consensus via run_nondet_unsafe, EVM circuit breaker
  mock_vault.py        # Direct-mode target stand-in exposing pause()/is_paused()

tests/
  direct/
    conftest.py        # Direct-mode fixtures/config (strict mocks on)
    test_stasis.py     # Registration, false-positive, consensus-exploit,
                       #   pause-execution, and recovery suites

apps/
  web/                 # Next.js 14 dashboard (App Router)
    app/               # Routes: vault list, vault detail, simulate control
    components/        # VaultTable, StatusBadge, SimulateExploitButton
    lib/               # GenLayer read client + address/basis-point helpers

scripts/
  ascii_scan.sh        # Pure-ASCII gate over the whole repository
```

**Structure Decision**: Web-application layout. The on-chain backend is the
`contracts/` directory (two Intelligent Contracts), verified by the `tests/direct/`
harness. The `apps/web/` Next.js 14 dashboard is a read-and-trigger client that never
holds authoritative state. The `scripts/ascii_scan.sh` gate enforces Principle I
across all of the above. File boundaries are strict: adjudication and state
transitions live only in `stasis_guardian.py`; the mock target's pause semantics live
only in `mock_vault.py`; no contract logic leaks into the dashboard.

## Complexity Tracking

> No constitution violations. This section is intentionally empty.
