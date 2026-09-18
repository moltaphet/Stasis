> **SUPERSEDED - pre-hardening MVP.** This document describes the initial MVP
> design (states ARMED/PAUSED, INCONCLUSIVE verdict, single feed, no native escrow).
> The shipped contract has evolved past it: lifecycle states are
> ARMED/TRIPPED/RESTORED/RATE_LIMITED and verdicts are the discrete tiers
> NORMAL / ELEVATED_RISK / CRITICAL_BREACH / MALICIOUS_REPORT, with dual feeds and
> native GEN escrow. Current ground truth: ../../README.md and ./hardening-plan.md.

# Phase 1 Data Model: Autonomous Circuit Breaker

All persistent state uses GenVM storage primitives only. No raw Python `dict`,
`list`, or `int` appears in storage. Every storage struct is declared with
`@allow_storage @dataclass`. This model realizes the entities in the specification
(Monitored Vault, Incident Record, Verdict) with concrete GenVM types.

## Enumerations (stored as `u32`)

### VaultState
| Value | Name | Meaning |
|-------|------|---------|
| 0 | ARMED | Registered and monitorable; no active halt |
| 1 | PAUSED | Circuit breaker fired; target vault pause dispatched |

Transitions: ARMED -> PAUSED (on confirmed MALICIOUS verdict and pause dispatch);
PAUSED -> ARMED (on authorized recovery). No other transitions are permitted.

### Verdict
| Value | Name | Meaning |
|-------|------|---------|
| 0 | NONE | No adjudication has produced a verdict yet |
| 1 | BENIGN | Consensus judged the incident legitimate (arbitrage/volatility) |
| 2 | MALICIOUS | Consensus judged an active exploit; authorizes trigger |
| 3 | INCONCLUSIVE | Validators could not reach equivalence consensus |

Only Verdict value 2 (MALICIOUS) authorizes a trigger (spec FR-010, FR-015).

## Storage struct: IncidentRecord

`@allow_storage @dataclass`

| Field | Type | Notes |
|-------|------|-------|
| incident_hash | bytes | Content-derived hash of the telemetry payload; dedupe key (R5) |
| verdict | u32 | One of the Verdict enum values |
| observed_drop_bps | u256 | Reported TVL drop in basis points at adjudication time |
| timestamp_unix | u256 | Transaction datetime as Unix seconds (deterministic) |
| timestamp_iso | str | Transaction datetime as ISO 8601 string (audit trail) |
| reason_code | str | Short, normalized classification reason (bounded vocabulary) |

Validation rules:
- `verdict` MUST be a defined Verdict value.
- `incident_hash` MUST be non-empty for any recorded adjudication.
- `observed_drop_bps` is an integer basis-point value; no floats (R6).

## Storage struct: Vault

`@allow_storage @dataclass`

| Field | Type | Notes |
|-------|------|-------|
| target_address | Address | The monitored EVM vault contract address; registry key |
| feed_url | str | Telemetry feed location fetched during adjudication |
| threshold_bps | u256 | TVL drop threshold in basis points that gates escalation |
| active | bool | Whether adjudication is permitted for this vault |
| state | u32 | Current VaultState (ARMED or PAUSED) |
| admin | Address | Authorized administrator / governance actor for this vault |
| latest | IncidentRecord | Most recent adjudicated incident (zero-initialized until first) |
| history | DynArray[IncidentRecord] | Full incident history; preserved across recovery (spec FR-017) |

Validation rules:
- `target_address` MUST be non-zero and well-formed at registration (spec FR-002).
- `threshold_bps` is an integer basis-point value.
- Only `admin` may reconfigure the vault or reset it from PAUSED (spec FR-016).
- `history` is append-only; recovery MUST NOT clear it.

## Contract-level storage: Contract (gl.Contract)

| Field | Type | Notes |
|-------|------|-------|
| vaults | TreeMap[Address, Vault] | Registry of monitored vaults keyed by target address |
| owner | Address | Deployer; may be used for protocol-level administration |

Rationale for `TreeMap`: the documentation mandates `TreeMap[K, V]` instead of
`dict[K, V]` for persistent mappings; `Address` is the natural, unique vault key.

## Relationships

- One `Contract` holds many `Vault` records (via `vaults` TreeMap).
- One `Vault` holds many `IncidentRecord` entries (via `history` DynArray) and one
  `latest` snapshot.
- Each `IncidentRecord` carries exactly one `Verdict`.
- Each `Vault` references exactly one `admin` Address.

## State transition table

| From | Trigger | Guard | To | Side effects |
|------|---------|-------|----|--------------|
| ARMED | adjudicate() | vault active; consensus MALICIOUS; drop >= threshold_bps | PAUSED | append IncidentRecord; set latest; emit().pause() on finalization |
| ARMED | adjudicate() | consensus BENIGN or INCONCLUSIVE, or drop < threshold_bps | ARMED | append IncidentRecord; set latest; no dispatch |
| ARMED | adjudicate() | vault inactive/unregistered | (no change) | no fetch, no verdict (spec FR-011) |
| PAUSED | adjudicate()/trigger for same incident_hash | already paused | PAUSED | no duplicate dispatch (spec FR-014) |
| PAUSED | recover() | caller == admin | ARMED | history retained; state reset |
| PAUSED | recover() | caller != admin | PAUSED | rejected (spec FR-016) |

## Non-determinism boundary (design invariant)

- Inputs into the non-det closure: `feed_url` (str), threshold context, and any
  vault fields first passed through `gl.storage.copy_to_memory`.
- Closure output: a structured, deterministic result `(is_malicious: bool,
  observed_drop_bps: int, reason_code: str)` derived from the fetched telemetry and
  the LLM classification. Never raw web/LLM text (avoids GL-S03).
- All writes to `vaults`, `Vault.state`, `Vault.latest`, and `Vault.history`, and all
  `emit().pause()` dispatch, occur in deterministic code after the closure returns
  (constitution Principle III; spec FR-019, FR-020).
