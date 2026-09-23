# Contract Interface: Target Vault

Defines the outbound interface the guardian uses to halt and restore a target vault,
and the reference implementation registered on the reference deployment.

## Interface (declared in contracts/stasis_guardian.py)

```
@gl.contract.interface
class ITargetVault:
    class View:
        def is_paused(self) -> bool: ...
    class Write:
        def pause(self) -> None: ...
        def unpause(self) -> None: ...
```

Targets are GenVM intelligent contracts, so the interface is a GenVM contract
interface: calls are internal messages addressed by method name (calldata
`{"": "pause"}`), not ABI-encoded EVM calls. An earlier revision declared it with
`@gl.evm.contract_interface`, which emits a keccak-selector EVM call that the GenVM
reference vault never receives.

Dispatch semantics:
- `ITargetVault(target).emit(on="finalized").pause()` is sent in the same
  deterministic transaction that sets the vault to `TRIPPED` on a `CRITICAL_BREACH`
  verdict.
- `ITargetVault(target).emit(on="finalized").unpause()` is sent by `recover()` once the
  stamped unlock time has passed, and by `resolve_dispute()` when a dispute overturns
  the trip.
- Both are internal messages that execute only after the guardian's transaction
  finalizes, as their own transactions with the guardian as sender.

## Required authorization on the vault

A target vault MUST accept `pause()` / `unpause()` only from the guardian address.
Registration is curated by the guardian's registry owner, and the vault's own
authorization check is the second half of that binding.

## Reference implementation: contracts/reference_vault.py

A GenLayer intelligent contract with the same surface:

- constructor `(guardian: Address)` - rejects the zero address (`ERR_ZERO_ADDRESS`)
- `pause()` / `unpause()` - guardian only, else `ERR_NOT_GUARDIAN`; idempotent
- `is_paused() -> bool`, `get_guardian() -> Address`

Verified by `tests/direct/test_stasis.py::test_reference_vault_only_guardian_may_pause`,
`tests/direct/test_cooldown_regression.py` (message shape emitted by the guardian) and,
end to end on a live network, `tests/integration/test_vault_guardian_integration.py`.
