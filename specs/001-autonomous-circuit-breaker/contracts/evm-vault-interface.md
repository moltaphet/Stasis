# Contract Interface: Target Vault

Defines the outbound interface the guardian uses to halt and restore a target vault,
and the reference implementation registered on the reference deployment.

## Interface (declared in contracts/stasis_guardian.py)

```
@gl.evm.contract_interface
class ITargetVault:
    class View:
        pass
    class Write:
        def pause(self) -> None: ...
        def unpause(self) -> None: ...
```

The guardian never reads the target, so the View class declares nothing. (A View
method would also trip a genvm-lint `validate` defect; keeping it empty lets both
contracts pass `lint` and `validate`.)

Dispatch semantics:
- `ITargetVault(target).emit().pause()` is sent in the same deterministic
  transaction that sets the vault to `TRIPPED` on a `CRITICAL_BREACH` verdict.
- `ITargetVault(target).emit().unpause()` is sent by `recover()` after the cooldown,
  and by `resolve_dispute()` when a dispute overturns the trip.
- Both are external messages that execute on transaction finalization only.

## Required authorization on the vault

A target vault MUST accept `pause()` / `unpause()` only from the guardian address.
Registration is curated by the guardian's registry owner, and the vault's own
authorization check is the second half of that binding.

## Reference implementation: contracts/reference_vault.py

A GenLayer intelligent contract with the same surface:

- constructor `(guardian: Address)` - rejects the zero address (`ERR_ZERO_ADDRESS`)
- `pause()` / `unpause()` - guardian only, else `ERR_NOT_GUARDIAN`; idempotent
- `is_paused() -> bool`, `get_guardian() -> Address`

Verified by `tests/direct/test_stasis.py::test_reference_vault_only_guardian_may_pause`.
