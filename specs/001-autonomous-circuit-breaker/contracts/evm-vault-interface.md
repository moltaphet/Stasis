# Contract Interface: EVM Target Vault

Defines the outbound EVM interface the guardian uses to halt a target vault, and the
direct-mode stand-in that verifies the invocation. Satisfies constitution Principle
IV (EVM Emergency Dispatch).

## Production EVM interface (in stasis_guardian.py)

Declared with `@gl.evm.contract_interface`. The guardian holds only the interface
shape; the concrete vault lives on the EVM side.

```
@gl.evm.contract_interface
class TargetVault:
    class View:
        def is_paused(self) -> bool: ...
    class Write:
        def pause(self) -> None: ...
```

Dispatch semantics:
- Halt is dispatched with `TargetVault(target_address).emit().pause()`.
- This is an external message; it executes on transaction finalization only. It MUST
  NOT be emitted on acceptance.
- The guardian sets the vault to PAUSED in the same deterministic transaction that
  emits the pause message.

Maps to: FR-012, FR-013; constitution Principle IV.

## Direct-mode stand-in: mock_vault.py

A GenLayer Intelligent Contract used only to verify cross-contract invocation in
direct-mode tests. It presents the same method names as the EVM interface.

File header (exact, required by constitution Principle II):
`# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }`

Storage: a single `bool` paused flag (inside the contract).

### Write methods
- `pause() -> None`: sets the internal paused flag to true. Idempotent: calling pause
  when already paused leaves it true and dispatches no further effect.

### View methods
- `is_paused() -> bool`: returns the current paused flag.

Behavior contract:
- Starts unpaused (`is_paused() == false`).
- After the guardian triggers on a MALICIOUS verdict, `is_paused() == true`.
- A second trigger for the same incident does not change or re-fire the flag
  (verifies FR-014 idempotency in direct mode).

## Verification mapping

| Requirement | How verified |
|-------------|--------------|
| FR-012 dispatch on malicious | Direct test: after MALICIOUS consensus, stand-in `is_paused()` is true |
| FR-013 finalization + record | Review of emit-on-finalized dispatch; test asserts incident record present when PAUSED |
| FR-014 no duplicate pause | Direct test: repeat trigger for same incident_hash leaves a single pause effect |
| FR-015 no trigger when benign | Direct test: BENIGN/INCONCLUSIVE verdict leaves stand-in unpaused and vault ARMED |
