# Stasis Protocol - Integration Tests

Full leader + validator consensus tests for the Stasis Guardian, run against a
real GenLayer environment (not the in-memory direct-mode VM).

## What they cover

Deterministic consensus pipeline (runs on every invocation, no LLM required):

- deploy + register + read-back of vault configuration
- duplicate-registration rejection (consensus revert)
- vault reconfiguration persistence
- native GEN escrow accounting via payable `deposit()`
- `deposit(0)` and empty `withdraw()` reverts
- the anti-griefing bond floor (`set_min_bond`) rejecting an under-bonded report
  before the feeds are read, and admitting one at the floor
- the `recover()` guard rejecting an armed vault, so no unpause is emitted for a
  vault that was never paused
- deterministic adjudication guards (inactive / unregistered targets)
- the full `run_nondet` block executing across all validators

LLM-dependent adjudication (gated behind `STASIS_INTEGRATION_LLM=1`):

- `simulate_signal` producing a real `CRITICAL_BREACH` verdict, tripping the
  breaker and crediting the pull-over-push bounty
- the full lifecycle past the trip: `recover()` restoring the breaker and emitting
  the unpause to the target vault
- replay rejection after a real adjudication burns the incident key

Every write entry point the contract exposes is exercised by one of the two
groups, so none of them goes unmeasured in the fee profile. The `recover()` and
`set_min_bond` *happy* paths both need a real trip, which needs a verdict from a
provider, so a keyless run only reaches their guard branches - but that costs
nothing here: measured across all eight entry points, `executionBudgetPerRound`
spans 98.286T to 98.740T wei, a 0.46% spread, because the budget is dominated by a
fixed per-transaction execution floor rather than by the branch taken. The profile
is also written with a 1.25 headroom multiplier on top. Re-run under
`STASIS_INTEGRATION_LLM=1` when a provider is available to measure the real
branches, but no write is at risk of under-funding in the meantime.

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
STASIS_DEPLOY=1 gltest tests/integration/test_deploy_studio_dev.py -v -s \
    --network studio_devnet
```

Deploys guardian + mock vault, registers the vault, writes
`deployments/studio-dev.json`, and prints the addresses for `apps/web/.env.local`.
It is a pytest module because gltest only populates its network registry from the
CLI at startup, so a standalone script cannot resolve a network name.

## Environment notes (observed 2026-09-05)

The guardian deploys and accepts writes on real GenVM (verified via the
`genlayer` CLI: both contracts finalized on StudioNet with 5/5 validators AGREE).
Three integration back-ends were exercised in the build sandbox; each had an
environment-level blocker unrelated to the contract or these tests:

- **GLSim** (`glsim`) - its lightweight, non-GenVM Python runner rejects the
  guardian's storage model (`class is not marked for usage within storage`),
  though the identical contract deploys on real GenVM. GLSim is unsuitable for
  this contract; use Local Studio or StudioNet.
- **Hosted StudioNet** - deploys and writes succeed, but `gen_call` reads were
  returning `Contract ... not found` for finalized contracts (a hosted read-path
  outage), which fails the read-back assertions.
- **Local Studio** - requires a running Docker engine; the sandbox's Docker
  Desktop engine socket did not come up.

Run against a healthy Local Studio (or a StudioNet with a working read path) to
see the suite green. The deterministic subset needs no LLM; the adjudication
subset needs a validator LLM provider and `STASIS_INTEGRATION_LLM=1`.
