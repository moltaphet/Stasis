---

description: "Task list for Autonomous Circuit Breaker implementation"
---

# Tasks: Autonomous Circuit Breaker

**Input**: Design documents from `/specs/001-autonomous-circuit-breaker/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: INCLUDED. The feature explicitly requests a direct-mode test suite, so
per-story direct tests are generated.

**Organization**: Tasks are grouped by user story (US1-US4 from spec.md) to enable
independent implementation and testing. The requested technical phases map as
follows: requested Phase 1 (storage + registration + mock vault) = Foundational plus
US1; requested Phase 2 (telemetry + adjudication + dispatch) = US2 plus US3;
requested Phase 3 (direct tests) = the per-story test tasks; requested Phase 4
(frontend + simulation) = US4.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- Exact file paths are included in each task.

## Path Conventions

Web-application layout from plan.md: `contracts/` (Intelligent Contracts),
`tests/direct/` (direct-mode pytest), `apps/web/` (Next.js 14 dashboard),
`scripts/` (validation gates). All paths are relative to the repository root.

## Constitution guardrails (apply to every task)

- Pure ASCII and English only in every file produced (Principle I).
- Exact header on both contracts: `# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }` (Principle II).
- Persistent storage uses TreeMap, DynArray, Address, u256, u32 only; every storage
  struct is `@allow_storage @dataclass`; no raw dict/list/int in storage (Principle II).
- All `gl.nondet.web.*` and `gl.nondet.exec_prompt` calls live inside
  `gl.vm.run_nondet_unsafe`; no storage writes inside the closure (Principle III).
- EVM pause dispatched via `@gl.evm.contract_interface` with `.emit()` on finalization
  (Principle IV).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Repository layout and validation tooling.

- [X] T001 Create the project directory structure (`contracts/`, `tests/direct/`, `apps/web/`, `scripts/`) per plan.md
- [X] T002 [P] Implement the pure-ASCII gate at `scripts/ascii_scan.sh` (fails on any byte outside 0x00-0x7F across the repo)
- [X] T003 [P] Configure pytest with the GenLayer direct-mode plugin and add `pytest.ini` (or `pyproject.toml` test config) plus a dev-dependency manifest at repository root
- [X] T004 [P] Add a developer task runner (`Makefile` or `scripts/gates.sh`) exposing `ascii`, `lint` (genvm-lint), and `test` (pytest) targets

**Checkpoint**: Layout and the three gate commands exist and run (even if no code yet).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Contract skeletons, storage model, enums, EVM interface shape, and the
mock target vault that later stories depend on.

**CRITICAL**: No user story work can begin until this phase is complete.

- [X] T005 Create `contracts/stasis_guardian.py` with the exact `Depends` header, `from genlayer import *`, a `gl.Contract` subclass, and `__init__` setting `owner` in `contracts/stasis_guardian.py`
- [X] T006 Define VaultState (0 ARMED, 1 PAUSED) and Verdict (0 NONE, 1 BENIGN, 2 MALICIOUS, 3 INCONCLUSIVE) as `u32` constants in `contracts/stasis_guardian.py`
- [X] T007 [P] Define the `IncidentRecord` `@allow_storage @dataclass` struct (incident_hash bytes, verdict u32, observed_drop_bps u256, timestamp_unix u256, timestamp_iso str, reason_code str) in `contracts/stasis_guardian.py` per data-model.md
- [X] T008 Define the `Vault` `@allow_storage @dataclass` struct (target_address Address, feed_url str, threshold_bps u256, active bool, state u32, admin Address, latest IncidentRecord, history DynArray[IncidentRecord]) and declare `vaults: TreeMap[Address, Vault]` on the contract in `contracts/stasis_guardian.py` (depends on T007)
- [X] T009 Declare the `TargetVault` `@gl.evm.contract_interface` with `View.is_paused() -> bool` and `Write.pause() -> None` in `contracts/stasis_guardian.py` per contracts/evm-vault-interface.md
- [X] T010 [P] Create `contracts/mock_vault.py`: IC stand-in with the exact `Depends` header, a stored `bool` paused flag, idempotent `pause()` write, and `is_paused()` view
- [X] T011 Gate: run `scripts/ascii_scan.sh` and `genvm-lint contracts/stasis_guardian.py contracts/mock_vault.py`; both MUST pass before proceeding

**Checkpoint**: Storage model, enums, EVM interface, and mock target compile and lint clean.

---

## Phase 3: User Story 1 - Register and Configure a Monitored Vault (Priority: P1) [MVP core]

**Goal**: An administrator can register an EVM vault with monitoring parameters and
read it back; configuration updates persist; invalid addresses are rejected.

**Independent Test**: Register a vault with valid params, read it back and confirm all
fields plus `state == ARMED`; update threshold/active and confirm persistence; attempt
a zero-address registration and confirm revert.

### Tests for User Story 1

- [X] T012 [P] [US1] Write direct tests for registration and config in `tests/direct/test_stasis.py`: successful register + `get_vault` readback (state ARMED), zero/malformed address revert, admin-only `configure_vault` update, non-admin config revert
- [X] T013 [P] [US1] Add shared direct-mode fixtures/config in `tests/direct/conftest.py` (set `direct_vm.strict_mocks = True`, common addresses, deploy helpers)

### Implementation for User Story 1

- [X] T014 [US1] Implement `register_vault(target_address, feed_url, threshold_bps, active)` in `contracts/stasis_guardian.py` (validate non-zero address, reject duplicates, set admin = sender, state = ARMED)
- [X] T015 [US1] Implement `configure_vault(target_address, threshold_bps, active)` in `contracts/stasis_guardian.py` (admin-only, persist updates, leave state unchanged)
- [X] T016 [US1] Implement view methods `get_vault`, `get_state`, `get_incident_count`, `get_incident` in `contracts/stasis_guardian.py` per contracts/guardian-interface.md
- [X] T017 [US1] Gate: run `scripts/ascii_scan.sh`, `genvm-lint`, and `pytest tests/direct/ -v` (US1 tests green)

**Checkpoint**: US1 fully functional and independently testable.

---

## Phase 4: User Story 2 - Autonomous Threat Adjudication by Validator Consensus (Priority: P1) [MVP core]

**Goal**: For an active vault, fetch telemetry and classify it inside
`run_nondet_unsafe`; reach equivalence consensus on a boolean verdict; record the
incident. No storage writes inside the closure.

**Independent Test**: With mocked web + LLM, a clear drain payload yields a MALICIOUS
consensus verdict and a recorded incident; a benign payload yields BENIGN and no
action; a dissenting validator yields INCONCLUSIVE; an inactive vault performs no
fetch and returns NONE.

### Tests for User Story 2

- [X] T018 [P] [US2] Extend `tests/direct/test_stasis.py` with adjudication tests using `direct_vm.mock_web` and `direct_vm.mock_llm`: benign no-action, malicious verdict + incident recorded, `direct_vm.run_validator` dissent -> INCONCLUSIVE, inactive/unregistered no-op

### Implementation for User Story 2

- [X] T019 [US2] Implement the non-det closure in `contracts/stasis_guardian.py`: `leader_fn` calls `gl.nondet.web.get(feed_url)` then `gl.nondet.exec_prompt(prompt)` and returns a parsed `(is_malicious: bool, observed_drop_bps: int, reason_code: str)`; `validator_fn` re-derives and agrees only on matching boolean verdict; copy any needed storage via `gl.storage.copy_to_memory` before the closure
- [X] T020 [US2] Implement `adjudicate(target_address)` orchestration in `contracts/stasis_guardian.py`: guard active/ARMED, run `gl.vm.run_nondet_unsafe(leader_fn, validator_fn)`, map result to Verdict, no-op for inactive/unregistered (return NONE)
- [X] T021 [US2] Implement deterministic incident recording in `contracts/stasis_guardian.py` (post-closure): content-derived `incident_hash`, timestamp via `datetime.now(timezone.utc)` (u256 unix + ISO str), integer `threshold_bps` comparison (no float), append `IncidentRecord` and set `latest`
- [X] T022 [US2] Gate: run `scripts/ascii_scan.sh`, `genvm-lint` (confirm GL-S03 not triggered), and `pytest tests/direct/ -v` (US2 tests green)

**Checkpoint**: US1 and US2 both independently functional; verdicts produced without any state mutation inside non-det blocks.

---

## Phase 5: User Story 3 - EVM Emergency Circuit Breaker (Priority: P1) [MVP core]

**Goal**: On a confirmed MALICIOUS verdict, dispatch `emit().pause()` to the target on
finalization and flip state to PAUSED with the incident logged; never double-fire.

**Independent Test**: A MALICIOUS verdict pauses the deployed mock vault
(`is_paused()` true), sets vault state PAUSED with a populated incident record; a
second trigger for the same incident does not re-dispatch; a BENIGN/INCONCLUSIVE
verdict leaves the vault ARMED and the mock vault unpaused.

### Tests for User Story 3

- [X] T023 [P] [US3] Extend `tests/direct/test_stasis.py` with circuit-breaker tests: malicious verdict pauses the deployed `mock_vault` and sets PAUSED + incident record; duplicate-incident idempotency (single pause effect); benign/inconclusive no trigger

### Implementation for User Story 3

- [X] T024 [US3] Implement the malicious branch in `adjudicate()` in `contracts/stasis_guardian.py`: `TargetVault(target_address).emit().pause()` on finalization and deterministic transition to PAUSED with the incident record attached (Principle IV)
- [X] T025 [US3] Implement duplicate suppression in `contracts/stasis_guardian.py`: refuse re-dispatch when already PAUSED or the same `incident_hash` was handled; refuse trigger for non-MALICIOUS verdicts (leave ARMED)
- [X] T026 [US3] Gate: run `scripts/ascii_scan.sh`, `genvm-lint`, and `pytest tests/direct/ -v` (US3 tests green)

**Checkpoint**: MVP complete. The core contract runs end to end: register -> adjudicate -> consensus -> pause, fully verified in direct mode.

---

## Phase 6: User Story 4 - Governance Recovery and Judge Simulation (Priority: P2)

**Goal**: Authorized recovery resets a PAUSED vault to ARMED (history retained); a demo
simulation hook and a Next.js dashboard let judges trigger and observe the breaker.

**Independent Test**: From PAUSED, admin `recover` returns state to ARMED with history
intact; non-admin recover reverts; `simulate_incident` drives the full ARMED to PAUSED
transition without a live feed; the dashboard shows vault state and a working Simulate
Exploit control.

### Tests for User Story 4

- [ ] T027 [P] [US4] Extend `tests/direct/test_stasis.py` with recovery + simulation tests: admin `recover` resets to ARMED and retains `history`, non-admin `recover` reverts (via `direct_vm.prank`), `simulate_incident` reproduces the full malicious transition

### Implementation for User Story 4 (contract)

- [ ] T028 [US4] Implement `recover(target_address)` in `contracts/stasis_guardian.py` (admin-only, PAUSED -> ARMED, retain `history`)
- [ ] T029 [US4] Implement `simulate_incident(target_address, mock_payload)` in `contracts/stasis_guardian.py` reusing the adjudication and trigger path with an injected payload

### Implementation for User Story 4 (dashboard)

- [ ] T030 [P] [US4] Scaffold the Next.js 14 App Router project under `apps/web/` (tsconfig, `next lint`, `npm run typecheck` = `tsc --noEmit`)
- [ ] T031 [P] [US4] Implement the GenLayer read client and address/basis-point helpers in `apps/web/lib/`
- [ ] T032 [US4] Implement the vault list and detail views with a `StatusBadge` (ARMED/PAUSED) in `apps/web/app/` and `apps/web/components/` (depends on T031)
- [ ] T033 [US4] Implement the `SimulateExploitButton` control wired to `simulate_incident` in `apps/web/components/` (depends on T029, T032)
- [ ] T034 [US4] Gate: run `scripts/ascii_scan.sh`, `pytest tests/direct/ -v`, and in `apps/web/` run `npm run typecheck` and `npm run lint`

**Checkpoint**: All user stories independently functional; judges can observe a live circuit-breaker activation.

---

## Phase 7: Polish and Cross-Cutting Concerns

**Purpose**: Final validation and documentation across all stories.

- [ ] T035 [P] Execute the full quickstart.md scenarios A through F and record results
- [ ] T036 [P] Write a pure-ASCII `README.md` with setup, gate commands, and demo steps
- [ ] T037 Final repository gate: `scripts/ascii_scan.sh` over the whole repo, `genvm-lint` on both contracts, and `pytest tests/direct/ -v` all green

---

## Dependencies and Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies; start immediately.
- **Foundational (Phase 2)**: Depends on Setup; BLOCKS all user stories.
- **User Stories (Phase 3-6)**: All depend on Foundational completion.
  - MVP critical path is strictly ordered: US1 -> US2 -> US3 (each builds the core
    contract toward the end-to-end register/adjudicate/pause flow).
  - US4 depends on US1-US3 (recovery and simulation operate on the completed flow).
- **Polish (Phase 7)**: Depends on all desired stories being complete.

### User Story Dependencies

- **US1 (P1)**: After Foundational. No dependency on other stories.
- **US2 (P1)**: After US1 (adjudication writes to the Vault registry from US1).
- **US3 (P1)**: After US2 (trigger consumes the consensus verdict) and Foundational
  T009/T010 (EVM interface + mock vault).
- **US4 (P2)**: After US3 (recovery and simulation operate on the PAUSED flow).

### Within Each User Story

- Tests are written first and must fail before implementation.
- Storage/model tasks before service logic; service logic before dispatch/UI.
- Each story ends with its validation gate (ASCII + genvm-lint + pytest).

### Parallel Opportunities

- Setup: T002, T003, T004 in parallel.
- Foundational: T007 and T010 in parallel (different concerns/files); T008 waits on T007.
- US1: T012 and T013 (tests/fixtures) in parallel before implementation.
- US4 dashboard: T030 and T031 in parallel; T032 waits on T031; T033 waits on T029 + T032.
- Polish: T035 and T036 in parallel; T037 last.

Note: US1, US2, US3 all live primarily in `contracts/stasis_guardian.py`, so their
implementation tasks are sequential (same file), not parallel, despite sharing the P1
priority. The MVP critical path is therefore a single ordered thread.

---

## Parallel Example: User Story 1

```bash
# Launch US1 test authoring in parallel (different files):
Task: "Write registration/config direct tests in tests/direct/test_stasis.py"
Task: "Add shared fixtures in tests/direct/conftest.py"
```

---

## Implementation Strategy

### MVP First (core contract end to end)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational (storage, enums, EVM interface, mock vault).
3. Complete Phase 3 (US1) -> Phase 4 (US2) -> Phase 5 (US3) in order.
4. STOP and VALIDATE: the three P1 stories together are the MVP. Run all direct
   tests plus the ASCII and genvm-lint gates; confirm register -> adjudicate ->
   consensus -> pause works against the mock vault.
5. Demo the core breaker.

### Incremental Delivery

1. Setup + Foundational -> foundation ready.
2. US1 -> US2 -> US3 -> MVP core contract validated (demo the breaker).
3. US4 -> recovery + judge simulation + dashboard (demo the full lifecycle).
4. Polish -> full quickstart and repository-wide gates.

### Validation gates (enforced after each contract phase)

- Pure ASCII: `scripts/ascii_scan.sh` (Principle I) at T011, T017, T022, T026, T034, T037.
- GenVM lint: `genvm-lint` on both contracts at T011, T017, T022, T026, T037.
- Tests: `pytest tests/direct/ -v` at T017, T022, T026, T034, T037.
- Dashboard: `npm run typecheck` and `npm run lint` at T034.

---

## Notes

- [P] tasks = different files, no dependencies.
- [Story] label maps each task to its user story for traceability.
- The MVP critical path (US1 -> US2 -> US3) shares `contracts/stasis_guardian.py`, so
  keep those tasks sequential to avoid same-file conflicts.
- Verify tests fail before implementing.
- Commit after each task or logical group.
- Every produced file must pass the pure-ASCII gate; no emoji, arrows, em-dashes, or
  smart quotes anywhere.
