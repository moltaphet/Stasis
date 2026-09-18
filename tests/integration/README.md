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
- deterministic adjudication guards (inactive / unregistered targets)
- the full `run_nondet_unsafe` block executing across all validators

LLM-dependent adjudication (gated behind `STASIS_INTEGRATION_LLM=1`):

- `simulate_signal` producing a real `CRITICAL_BREACH` verdict, tripping the
  breaker and crediting the pull-over-push bounty
- replay rejection after a real adjudication burns the incident key

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

### Hosted StudioNet (gasless, no Docker)

```bash
gltest tests/integration/ -v -s --network studionet
```

Note: if a local HTTP proxy is present, exclude loopback for localnet runs:
`NO_PROXY=127.0.0.1,localhost gltest ...`.

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
