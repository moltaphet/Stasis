# Specifications

`001-autonomous-circuit-breaker/` holds the design record for the protocol: the
original specification, plan, research notes, task list and the hardening plan that
followed. The spec, plan, research, task and quickstart documents are kept as a
record of how the design evolved. Some of the names they use (an `adjudicate()`
entry point, a `PAUSED` state, an earlier runner hash) predate the current contract.

The current, enforced interface is:

- `contracts/stasis_guardian.py` and `contracts/reference_vault.py`
- `001-autonomous-circuit-breaker/contracts/guardian-interface.md`
- `001-autonomous-circuit-breaker/contracts/evm-vault-interface.md`
- the top-level `README.md`, sections 2 to 4
