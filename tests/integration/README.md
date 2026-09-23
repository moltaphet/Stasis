# Stasis Protocol - Integration Tests

Full leader + validator consensus tests for the Stasis Guardian, run against a
real GenLayer environment (not the in-memory direct-mode VM).

## What they cover

Deterministic consensus pipeline (runs on every invocation, no LLM required):

- deploy + curated registration + read-back of vault configuration
- duplicate-registration and invalid-feed rejection
- reconfiguration, admin handover and ownership re-assertion
- native GEN escrow accounting via payable `deposit()`; `deposit(0)` and empty
  `withdraw()` reverts
- report preconditions failing closed: zero bond, malformed tx hash, unregistered
  and inactive targets, and a bond below the `set_min_bond` floor
- payout guards without a trip: `recover`, `claim_payout`, `dispute_trip` and
  `resolve_dispute` all revert
- a drill with unbound bodies reverting before consensus
- **live feeds**: validators fetch both public explorers (Blockscout, Blockchair)
  for a real mainnet transaction that does not touch the target, and the report
  must revert as unbound with the bond untouched
- the full `run_nondet` block executing across all validators through a drill, which
  must never settle whatever the verdict

LLM-dependent adjudication (gated behind `STASIS_INTEGRATION_LLM=1`):

- a drill returning a real `CRITICAL_BREACH` verdict while vault state and escrow
  stay untouched
- a live, bound report on the real recipient of that mainnet transaction being
  adjudicated (not tripped), burning the replay key, and rejecting a replay

Guardian -> reference vault (`test_vault_guardian_integration.py`):

- deploys the reference vault bound to the guardian, registers it, and checks that
  a pause from any other account reverts (deterministic)
- with `STASIS_INTEGRATION_LLM=1`: a bonded live report reaching `CRITICAL_BREACH`
  trips the guardian, the emitted `pause()` reaches the vault and `is_paused` flips
  from `False` to `True`, and neither `recover` nor a cooldown change is accepted
  inside the stamped challenge window. No public explorer shows an exploit of a
  freshly deployed vault, so its two feeds are independent echo services (Postman
  Echo, httpbin) that reflect the target, tx hash and incident telemetry from the
  URL; validators still fetch them live and run the real LLM adjudication.

The rest of the trip -> challenge window -> dispute -> recover lifecycle is covered exhaustively in
the direct suite (`tests/direct/`), including both dispute outcomes, the deadline
fallback and the solvency invariant after every step.

## How to run

The tests drive the deployed contract through the `genlayer_py` client by
function name (schema-free), so they work on any real GenVM network.

### Local Studio (recommended - real GenVM, working reads)

```bash
genlayer up                      # requires a running Docker engine
gltest tests/integration/ -v -s --network localnet
```

With an LLM provider configured on the local validators, also run the
adjudication tests:

```bash
STASIS_INTEGRATION_LLM=1 gltest tests/integration/ -v -s --network localnet
```

### Studio Devnet preview (Consensus v0.6 / Studio v0.123, fee-charging)

```bash
gltest tests/integration/ -v -s --network studio_devnet
```

This is the network a v0.6 build must be validated against. Use `studio_devnet`,
not `studionet`: the chain object carries the consensus contract addresses, so the
network name selects the consensus being tested against, and `studionet` is stable
Studio. Studio Devnet charges fees, so every deploy and write submits a fee
distribution (see `live_fees()` in `conftest.py`); stable StudioNet is gasless.

### Hosted StudioNet (stable, gasless, no Docker)

```bash
gltest tests/integration/ -v -s --network studionet
```

Note: if a local HTTP proxy is present, exclude loopback for localnet runs:
`NO_PROXY=127.0.0.1,localhost gltest ...`.

## Fee profiling

```bash
gltest tests/integration/ --network studio_devnet --fee-profile fee-profile.json
```

Writes `fee-profile.json` at the repo root from observed finalized transactions
(`--fee-profile-headroom`, default 1.25, scales the observed maxima). The frontend
submits an estimate derived from this file, so re-run it whenever contract code,
GenVM, Studio, or the fee policy changes - a stale profile under-allocates and the
network rejects the write before the contract runs.

Two things about this are specific to Studio Devnet:

- gltest records per-method observations only from its schema-bound `Contract`
  wrapper, and that wrapper cannot be built against Studio Devnet because the
  network serves no contract schema. This suite drives the deployed contract by
  function name instead and feeds the same finalized receipt to the same public
  helper (`maybe_record_fee_observation`), so the generated profile is equivalent
  to the one the wrapper would have produced.
- Profiling must read a **finalized** receipt. A decided receipt reports
  `executionConsumed` as 0 - the protocol only settles the deposit and computes the
  refund at finalization - so profiling off one measures every method as free.
  gltest's own `deploy()` defaults its wait to `ACCEPTED` and records the deploy
  observation from that receipt, so both this suite's fixture and the deploy step
  pass `wait_until="finalized"` explicitly; without that the profile's `deploy`
  entry reads as free.

## Deploying to Studio Devnet

```bash
STASIS_DEPLOY=1 STASIS_DEPLOYER_KEY_FILE=<path to owner key> NO_PROXY="*" \
    gltest tests/integration/test_deploy_studio_dev.py -v -s --network studio_devnet
```

Deploys guardian + reference vault (bound to the guardian), registers the vault, writes
`deployments/studio-dev.json`, and prints the addresses for `apps/web/.env.local`.
The deployer becomes the registry owner and the reference vault's admin, so the
step refuses to run without a key file that is kept (gltest's default account is a
fresh random key per run). It is a pytest module because gltest only populates its network registry from the
CLI at startup, so a standalone script cannot resolve a network name.

## Environment notes

- **Studio Devnet** (`studio_devnet`, chain 61997) is the Consensus v0.6 preview this
  suite is validated against. It charges fees and may be reset.
- **GLSim** (`glsim`) uses a lightweight non-GenVM runner that rejects the guardian's
  storage model (`class is not marked for usage within storage`); use Local Studio
  or Studio Devnet instead.
- **Local Studio** (`genlayer up`) needs a running Docker engine.
- The live-feed test depends on `eth.blockscout.com` and `api.blockchair.com` being
  reachable from the validators. Either being rate-limited makes validators degrade
  to a retryable revert, which the test still reads as a (correct) rejection.
