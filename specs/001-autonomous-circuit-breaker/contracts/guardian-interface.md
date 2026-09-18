# Contract Interface: stasis_guardian

Public interface of the guardian Intelligent Contract (`contracts/stasis_guardian.py`).
This is a behavior contract, not implementation. Method decorators shown are the
GenLayer access modifiers (`@gl.public.write`, `@gl.public.view`). All persistent
effects follow the deterministic-write rule (constitution Principle III).

File header (exact, required by constitution Principle II):
`# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }`

## Write methods

### register_vault(target_address: Address, feed_url: str, threshold_bps: u256, active: bool) -> None
- Registers a new monitored vault; caller becomes the vault `admin`.
- Preconditions: `target_address` is non-zero and well-formed; vault not already
  registered.
- Postconditions: vault stored with `state = ARMED`, all fields persisted.
- Errors: reverts on malformed/zero address (FR-002) or duplicate registration.
- Maps to: FR-001, FR-002, FR-003, FR-005.

### configure_vault(target_address: Address, threshold_bps: u256, active: bool) -> None
- Updates threshold and active status of an existing vault.
- Preconditions: caller == vault `admin`; vault exists.
- Postconditions: updates persisted; `state` unchanged.
- Errors: reverts if caller is not admin or vault missing.
- Maps to: FR-004.

### adjudicate(target_address: Address) -> u32
- Runs one autonomous adjudication cycle for an active vault. Fetches telemetry and
  classifies it inside `gl.vm.run_nondet_unsafe`; validators must reach equivalence
  consensus on a boolean verdict. Writes the resulting IncidentRecord and, on a
  MALICIOUS consensus verdict with drop >= threshold, transitions to PAUSED and
  dispatches the EVM pause on finalization.
- Preconditions: vault exists and `active` is true; vault in ARMED state.
- Postconditions: returns the resulting Verdict value; appends an IncidentRecord;
  sets `latest`; on MALICIOUS, state becomes PAUSED and pause is dispatched exactly
  once (idempotent per incident_hash).
- No-op: inactive/unregistered vault performs no fetch and returns NONE (FR-011).
- Non-det boundary: only web.get/exec_prompt run in the closure; no storage writes
  inside it (FR-019, FR-020).
- Maps to: FR-006, FR-007, FR-008, FR-009, FR-010, FR-012, FR-013, FR-014, FR-015.

### simulate_incident(target_address: Address, mock_payload: str) -> u32
- Demo hook that drives the same adjudication and trigger path using an injected
  telemetry payload instead of a live fetch. Same consensus and state rules apply.
- Preconditions: vault exists and is active.
- Postconditions: identical to `adjudicate` for the given payload.
- Maps to: FR-018 (demo mock hook), supports SC-007.

### recover(target_address: Address) -> None
- Resets a PAUSED vault back to ARMED after off-chain mitigation.
- Preconditions: caller == vault `admin`; vault in PAUSED state.
- Postconditions: `state = ARMED`; `history` retained (FR-017).
- Errors: reverts for non-admin callers (FR-016) or non-paused vaults.
- Maps to: FR-016, FR-017.

## View methods

### get_vault(target_address: Address) -> Vault
- Returns the stored vault record (config, state, admin, latest incident).
- Maps to: FR-003, FR-005 (readability); supports SC-001, SC-005.

### get_state(target_address: Address) -> u32
- Returns current VaultState (0 ARMED, 1 PAUSED).

### get_incident_count(target_address: Address) -> u256
- Returns the length of the vault's incident history.

### get_incident(target_address: Address, index: u256) -> IncidentRecord
- Returns a specific historical IncidentRecord.

## Verdict return values

`adjudicate` and `simulate_incident` return a `u32` Verdict: 0 NONE, 1 BENIGN,
2 MALICIOUS, 3 INCONCLUSIVE. Only 2 authorizes a pause dispatch.

## Invariants enforced

- A pause is dispatched only after a MALICIOUS consensus verdict (FR-012, FR-015).
- No duplicate pause for an already-PAUSED vault on the same incident (FR-014).
- All state transitions occur outside non-deterministic blocks (FR-019).
- Storage is never mutated inside a non-deterministic closure (FR-020).
- Every string and identifier is pure ASCII (FR-021).
