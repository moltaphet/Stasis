> **SUPERSEDED - pre-hardening MVP.** This document describes the initial MVP
> design (states ARMED/PAUSED, INCONCLUSIVE verdict, single feed, no native escrow).
> The shipped contract has evolved past it: lifecycle states are
> ARMED/TRIPPED/RESTORED/RATE_LIMITED and verdicts are the discrete tiers
> NORMAL / ELEVATED_RISK / CRITICAL_BREACH / MALICIOUS_REPORT, with dual feeds and
> native GEN escrow. Current ground truth: ../../README.md and ./hardening-plan.md.

# Quickstart: Autonomous Circuit Breaker

This guide validates the feature end to end. It is a run and verification guide;
implementation code lives in `contracts/`, `tests/`, and `apps/web/`, and task
sequencing lives in `tasks.md`. See [data-model.md](./data-model.md) and
[contracts/](./contracts/) for the entity and interface details referenced below.

## Prerequisites

- Python 3.12 with the GenLayer SDK and the direct-mode pytest plugin installed.
- The GenVM linter (`genvm-lint`) available on PATH.
- Node.js with the dashboard dependencies installed under `apps/web/`.
- Repository checked out at the feature branch `001-autonomous-circuit-breaker`.

## Validation gates (run in order)

### Gate 1: Pure ASCII scan (constitution Principle I)

```bash
bash scripts/ascii_scan.sh
```

Expected: exits 0 and reports no non-ASCII bytes anywhere in the repository. Any byte
outside 0x00-0x7F fails the gate. Verifies FR-021 and SC-008.

### Gate 2: GenVM lint (constitution Principles II and III)

```bash
genvm-lint contracts/stasis_guardian.py contracts/mock_vault.py
```

Expected: passes. Confirms the exact `Depends` header, no forbidden imports
(`os`, `random`, `time`), and no non-deterministic patterns; confirms GL-S03 is not
triggered because the non-det closure returns a parsed boolean, not raw output.

### Gate 3: Direct-mode tests (functional verification)

```bash
pytest tests/direct/ -v
```

Expected: all tests pass. The suite (in `tests/direct/test_stasis.py`) covers the
scenarios below with `direct_vm.strict_mocks = True`.

### Gate 4: Dashboard typecheck and lint

```bash
cd apps/web && npm run typecheck && npm run lint
```

Expected: `tsc --noEmit` and `next lint` both pass with no errors.

## Scenario walkthrough (maps to spec user stories)

### Scenario A: Register and read back a vault (User Story 1, SC-001)

1. Deploy the guardian with `direct_deploy("contracts/stasis_guardian.py")`.
2. Call `register_vault(target, feed_url, threshold_bps, active=true)`.
3. Call `get_vault(target)` and assert every field persisted and `state == ARMED`.
4. Attempt `register_vault` with a zero address and assert it reverts (FR-002).

### Scenario B: Benign telemetry produces no action (User Story 2, SC-003)

1. Register and activate a vault.
2. `direct_vm.mock_web(feed_pattern, benign_payload)` and
   `direct_vm.mock_llm(prompt_pattern, benign_classification)`.
3. Call `adjudicate(target)`; assert the returned verdict is BENIGN, the vault stays
   ARMED, and the mock vault `is_paused()` remains false.

### Scenario C: Consensus exploit triggers the breaker (User Stories 2 and 3, SC-002, SC-004, SC-005)

1. Register and activate a vault whose target points at the deployed `mock_vault`.
2. Mock a drain payload and a malicious classification such that drop >= threshold.
3. Call `adjudicate(target)`; assert:
   - returned verdict is MALICIOUS;
   - vault `state == PAUSED`;
   - the mock vault `is_paused()` is true;
   - `latest` incident record has a non-empty `incident_hash`, the MALICIOUS verdict,
     and a timestamp.
4. Re-run the trigger for the same incident and assert no duplicate pause (FR-014).

### Scenario D: Dissenting validator yields no trigger (User Story 2, edge case)

1. Set up a malicious leader classification, then swap mocks and use
   `direct_vm.run_validator()` to simulate a disagreeing validator.
2. Assert the outcome is undetermined/INCONCLUSIVE, the vault stays ARMED, and the
   mock vault stays unpaused (FR-008).

### Scenario E: Recovery resets a paused vault (User Story 4, SC-006)

1. From a PAUSED vault, call `recover(target)` as the vault admin.
2. Assert `state == ARMED`, the vault is monitorable again, and `history` is retained.
3. Attempt `recover(target)` from a non-admin sender (use `direct_vm.prank`) and
   assert it reverts (FR-016).

### Scenario F: Judge simulation hook (User Story 4, SC-007)

1. Call `simulate_incident(target, mock_malicious_payload)` on an active vault.
2. Assert the full ARMED to PAUSED transition occurs exactly as in Scenario C,
   without configuring a live feed.
3. Load the dashboard, confirm the vault row shows PAUSED, and confirm the
   Simulate Exploit control drives the same transition visibly.

## Definition of validated

- Gates 1 through 4 all pass.
- Scenarios A through F all pass.
- No non-ASCII bytes in any produced file (SC-008).
- No pause is ever dispatched without a recorded MALICIOUS consensus verdict (SC-004).
