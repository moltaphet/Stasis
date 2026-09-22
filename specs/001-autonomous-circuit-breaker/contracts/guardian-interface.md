# Contract Interface: stasis_guardian

Public interface of `contracts/stasis_guardian.py`. Every rejection reverts with
`[CLASS] ERR_CODE: detail`, where CLASS is `[EXPECTED]`, `[EXTERNAL]` or
`[TRANSIENT]`. The README (section 3) lists every error code.

## Registry

| Method | Access | Effect |
|---|---|---|
| `register_vault(target, primary_feed_url, secondary_feed_url, threshold_bps, bounty_amount, cooldown_seconds, active)` | owner | Validates feeds (https, no credentials, distinct) and `1 <= threshold_bps <= 10000`; stores the vault `ARMED` with the caller as admin |
| `configure_vault(target, threshold_bps, bounty_amount, cooldown_seconds, active)` | admin | Updates parameters |
| `set_min_bond(target, min_bond)` | admin | Raises the reporter bond floor |
| `transfer_vault_admin(target, new_admin)` | admin | Blocked while a dispute is open |
| `transfer_ownership(new_owner)` | owner | |

## Escrow and reports

| Method | Access | Effect |
|---|---|---|
| `deposit(target)` payable | anyone | `value > 0`; credits vault escrow |
| `submit_signal(target, tx_hash) -> u32` payable | anyone | Requires `0x`+64-hex tx, active non-tripped vault, no unsettled bounty, `bond >= max(1, min_bond)`, unseen `(target, tx)`. Validators fetch both feeds for the tx; both bodies must reference target and tx. Settles by tier |
| `simulate_signal(target, tx_hash, primary_body, secondary_body) -> u32` | anyone | Drill: same adjudication over supplied bodies (which must also be bound); stores only the last drill tier; never settles |
| `withdraw() -> u256` | anyone | Pulls the caller's claimable balance (CEI, then `emit_transfer`) |

Settlement by tier:
- `CRITICAL_BREACH`: `TRIPPED`, `pause()` emitted, bounty (capped by escrow) and bond
  locked as a `PENDING` payout until `trip_ts + cooldown_seconds`.
- `MALICIOUS_REPORT`: bond slashed into the vault reserve.
- `ELEVATED_RISK`: `RATE_LIMITED`; bond refunded.
- `NORMAL`: `RATE_LIMITED` clears to `ARMED`; bond refunded.

## Bounty lifecycle

| Method | Access | Effect |
|---|---|---|
| `claim_payout(target) -> u256` | anyone | After the window, releases bounty + bond to the reporter; `ERR_PAYOUT_LOCKED` while pending or disputed |
| `dispute_trip(target)` payable | admin | Inside the window, `value >= bounty + bond`; payout becomes `DISPUTED` |
| `resolve_dispute(target) -> bool` | anyone | Fresh validator round over the recorded tx. Upheld: reporter receives bounty + bond + dispute bond. Overturned: bounty back to reserve, reporter bond + dispute bond to admin, vault `RESTORED` and `unpause()` emitted. After 7 days unresolved, the original verdict stands |
| `recover(target)` | admin | `TRIPPED` only, after cooldown, not while disputed; releases an undisputed bounty; `RESTORED` and `unpause()` emitted |

## Views

`get_owner`, `is_registered`, `get_state`, `get_tier`, `is_active`,
`get_threshold_bps`, `get_bounty_amount`, `get_min_bond`, `get_cooldown_seconds`,
`get_admin`, `get_primary_feed`, `get_secondary_feed`, `get_incident_count`,
`get_latest_reason`, `get_vault_escrow`, `get_payout`, `get_payout_status`,
`get_last_drill_tier`, `get_claimable`, `get_total_deposited`, `get_locked_escrow`,
`is_incident_processed(target, tx_hash)`.

## Invariants

- `total_deposited == sum(vault escrow) + locked_escrow` after every transition.
- No storage access inside the non-deterministic closures; every `gl.nondet.*` call
  is lexically inside the block passed to `gl.vm.run_nondet`.
- A revert changes nothing: no state, no replay key, no bond taken.
