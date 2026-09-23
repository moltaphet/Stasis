# Stasis Protocol

**Autonomous, AI-Adjudicated Emergency Circuit Breaker for DeFi Vaults on GenLayer.**

Stasis eliminates the multisig and human response lag that turns a zero-day
exploit into a total pool drain. Instead of waiting for keyholders to coordinate,
Stasis uses decentralized multi-LLM consensus over multi-feed telemetry to
adjudicate an incident and trigger a verifiable on-chain emergency pause inside the
exploit window - before catastrophic drain finalizes.

- Runtime: GenLayer Intelligent Contract (`contracts/stasis_guardian.py`)
- Consensus: multi-validator equivalence over a non-deterministic block
- Settlement: native GEN escrow, mandatory reporter bonds, a bonded dispute window,
  and strict pull-over-push accounting
- Frontend: Next.js operations terminal (`apps/web`)

---

## 1. The Problem and the Solution

### The DeFi lag problem

Modern exploits (oracle manipulation, flash-loan reentrancy, price divergence
attacks) drain a pool in seconds, often within a single block window. The standard
defense - a multisig of human keyholders - takes minutes to hours to detect,
convene, review, and sign. By the time a pause transaction lands, the vault is
already empty. The defense operates on human time; the attack operates on
algorithmic time.

### Traditional keepers vs. GenLayer

- **Centralized keeper bots** are a single point of failure. They can be censored,
  bribed, taken offline, or made to miss the block. Trusting one off-chain process
  to guard a vault reintroduces the custodial risk DeFi exists to remove.
- **Standard EVM contracts** cannot natively fetch or cross-examine live web
  telemetry. They cannot read two independent price feeds, compare them, and reason
  over unstructured anomaly data without a trusted off-chain oracle relay.

### The Stasis solution

GenLayer Intelligent Contracts can perform non-deterministic work - web fetches and
LLM inference - while still reaching blockchain consensus. Stasis exploits this:
multiple validators independently fetch dual-feed telemetry via `gl.nondet.web.get`,
cross-reference the feeds, and converge on a **discrete categorical verdict** under
equivalence consensus. No centralized keeper, no trusted relay, no continuous score
to game - only a coarse, reproducible state transition that every validator agrees
on.

---

## 2. System Architecture and Operational Flow

```
   +-------------------+
   |  Watcher / Bot    |   submit_signal(target, tx_hash)   payable: bond > 0
   +---------+---------+
             |
             v
   +--------------------------------+
   | Deterministic Guards (revert)  |   tx_hash = 0x + 64 hex?   registered? active?
   |                                |   not TRIPPED? no unsettled bounty?
   |                                |   bond >= max(1, min_bond)? (target, tx) unseen?
   +---------+----------------------+
             |
             v
   +===============================================================+
   |  NON-DETERMINISTIC BLOCK  (gl.vm.run_nondet)                  |
   |                                                               |
   |  Per-transaction evidence (gl.nondet.web.get)                 |
   |    primary_feed_url   with {tx_hash} substituted              |
   |    secondary_feed_url with {tx_hash} substituted              |
   |  Target binding: BOTH bodies must name the target address     |
   |    and the tx hash, else "unbound" (model never consulted)    |
   |                                                               |
   |  LLM analyst (injection-hardened, tag-isolated prompt)        |
   |    strict typed JSON verdict -> DISCRETE TIER                 |
   |      NORMAL | ELEVATED_RISK | CRITICAL_BREACH | MALICIOUS_REPORT|
   +===============================================================+
             |
             v
   +--------------------------------+
   | Fail-closed gate (revert)      |   ERR_UNBOUND_EVIDENCE / ERR_FEED_UNAVAILABLE /
   |                                |   ERR_FEED_REJECTED / ERR_ADJUDICATION_FAILED
   +---------+----------------------+
             |
             v
   +--------------------------------+
   | Deterministic Settlement       |
   |   CRITICAL_BREACH:             |
   |     state = TRIPPED            |
   |     bounty + bond LOCKED       |   challenge window = cooldown_seconds
   |     emit ITargetVault.pause()  |   (finalization-gated message)
   |   MALICIOUS_REPORT:            |
   |     bond slashed to reserve    |
   |   NORMAL / ELEVATED_RISK:      |
   |     bond refunded (claimable)  |
   +--------------------------------+
```

### State machines

```
Vault:          CRITICAL_BREACH                  recover() after cooldown
          ARMED ---------------> TRIPPED ---------------------------> RESTORED
           ^  |                 (paused)   dispute overturned ------> RESTORED
           |  | ELEVATED_RISK
           |  v
          RATE_LIMITED <--- NORMAL clears

Bounty:   NONE -> PENDING --(window closes: claim_payout / recover)--> SETTLED
                     |
                     +--(admin dispute_trip, bond >= bounty+bond)--> DISPUTED
                                                                        |
                          resolve_dispute(): upheld  --> SETTLED  (reporter wins
                                                          bounty + bond + dispute bond)
                                             overturned -> OVERTURNED (bounty back to
                                                          reserve, reporter bond and
                                                          dispute bond to admin)
```

Stored values (`u32`): vault `ARMED = 0`, `TRIPPED = 1`, `RESTORED = 2`,
`RATE_LIMITED = 3`; payout `NONE = 0`, `PENDING = 1`, `DISPUTED = 2`,
`SETTLED = 3`, `OVERTURNED = 4`.

`RATE_LIMITED` is an on-chain flag that integrators can read; the guardian itself
only ever emits `pause()` / `unpause()` to the target.

---

## 3. Integration Guide for DeFi Vaults

The guardian governs the pause switch of a target vault. On a `CRITICAL_BREACH`
verdict it emits a finalization-gated `pause()` message to the target, and on
`recover()` (or an overturned dispute) it emits `unpause()`. The vault must accept
those calls **only** from the guardian:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract ProtectedVault is AccessControl, Pausable {
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    constructor(address stasisGuardian) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, stasisGuardian);
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    function withdraw(uint256 amount) external whenNotPaused {
        // ... critical logic is inert while paused ...
    }
}
```

`contracts/reference_vault.py` is the same contract as a GenLayer intelligent
contract: it binds the guardian at construction and rejects `pause()` / `unpause()`
from anyone else with `ERR_NOT_GUARDIAN`. It is the registered target on the
reference deployment.

### Feeds

Each vault is registered with two independent, public, keyless HTTPS endpoints.
A `{tx_hash}` placeholder is replaced by the reported (validated) transaction hash,
so validators fetch evidence about exactly that transaction. The reference
deployment uses two independent block explorers:

```
https://eth.blockscout.com/api/v2/transactions/{tx_hash}
https://api.blockchair.com/ethereum/dashboards/transaction/{tx_hash}
```

Registration rejects non-HTTPS URLs, URLs with embedded credentials or whitespace,
and identical primary/secondary feeds (`ERR_INVALID_FEED`). A report is only
adjudicated if **both** fetched bodies reference the target address and the tx hash;
anything else - telemetry about another vault or transaction, generic metadata -
reverts with `ERR_UNBOUND_EVIDENCE` before the model is consulted.

### Lifecycle calls

```
# Registry (owner = deployer; curated so no one can squat a target and pick its feeds)
register_vault(target, primary_feed_url, secondary_feed_url,
               threshold_bps,       # 1..10000
               bounty_amount,       # native GEN paid on a confirmed breach
               cooldown_seconds,    # pause window AND bounty challenge window
               active)
transfer_vault_admin(target, new_admin)   # hand the vault to its operator
transfer_ownership(new_owner)

# Escrow
deposit(target)                  # payable, value > 0
set_min_bond(target, min_bond)   # admin; raises the reporter bond floor

# Reports
submit_signal(target, tx_hash)   # payable, bond > 0 and >= min_bond

# Bounty lifecycle
claim_payout(target)             # after the window, releases bounty+bond to reporter
dispute_trip(target)             # admin, payable, inside the window, bond >= bounty+bond
resolve_dispute(target)          # anyone; fresh validator round over the same tx
recover(target)                  # admin, after cooldown; settles an undisputed bounty
withdraw()                       # pull claimable balance (CEI + emit_transfer)

# Drill (non-settling)
simulate_signal(target, tx_hash, primary_body, secondary_body)
```

Every rejection reverts with a classified, stable code, e.g.
`[EXPECTED] ERR_PAYOUT_LOCKED: bounty is under dispute`. Codes: `ERR_NOT_OWNER`,
`ERR_NOT_ADMIN`, `ERR_ZERO_ADDRESS`, `ERR_VAULT_EXISTS`, `ERR_VAULT_NOT_REGISTERED`,
`ERR_INVALID_FEED`, `ERR_INVALID_PARAM`, `ERR_ZERO_VALUE`, `ERR_ZERO_BOND`,
`ERR_BOND_BELOW_MIN`, `ERR_VAULT_INACTIVE`, `ERR_VAULT_TRIPPED`,
`ERR_MALFORMED_EVIDENCE`, `ERR_UNBOUND_EVIDENCE`, `ERR_DUPLICATE_INCIDENT`,
`ERR_FEED_UNAVAILABLE`, `ERR_FEED_REJECTED`, `ERR_ADJUDICATION_FAILED`,
`ERR_NOTHING_TO_WITHDRAW`, `ERR_NO_PAYOUT`, `ERR_PAYOUT_LOCKED`,
`ERR_DISPUTE_WINDOW_CLOSED`, `ERR_DISPUTE_BOND_TOO_LOW`, `ERR_NOT_DISPUTED`,
`ERR_NOT_TRIPPED`, `ERR_COOLDOWN_ACTIVE`, `ERR_PENDING_ACTION_LOCKS_COOLDOWN`,
`ERR_NO_DRILL`.

---

## 4. Security Model and Invariants

### Fail closed

Nothing is inferred or defaulted. Malformed evidence, unbound evidence, a feed that
answers anything but 2xx, and a model answer that is not a strictly typed verdict
(`is_malicious` / `is_false_report` must be JSON booleans, `observed_drop_bps` a
non-negative number) all revert. A revert returns the attached bond untouched, does
not burn the replay key, and changes no state, so the report can be retried once the
feeds heal.

### Target binding

The report is `(target, tx_hash)`. `tx_hash` must be `0x` plus 64 hex digits and is
lower-cased before use, so it is safe to substitute into a feed URL. Each feed body
must contain both the target address and the tx hash; a validator whose own fetch is
unbound disagrees with a leader that claims otherwise. The prompt names the vault and
the transaction and instructs the analyst to ignore activity attributable to any
other address or transaction.

### Anti-prompt-injection

Feed bodies are untrusted. They are sanitized (non-ASCII dropped, control characters
neutralized, isolation tags stripped case-insensitively, length capped) and sealed
inside `<untrusted_input> ... </untrusted_input>`. The prompt tells validators to
treat that content strictly as data and to treat any embedded instruction as evidence
of a spoofed report. Reporters supply no free text at all.

### Multi-feed corroboration and consensus stability

Two independent endpoints are cross-referenced in the same non-deterministic block. A
catastrophic drain on one feed with nominal state on the other resolves to
`MALICIOUS_REPORT`, and the reporter's bond is slashed. Verdicts are coarse discrete
tiers; drop magnitudes are quantized to 100 bps bands before the threshold
comparison, so sub-band model jitter cannot split validators. Validators agree on the
bucket, never on raw model text.

### Economic security

- **No free reports.** Every `submit_signal` carries a non-zero bond
  (`ERR_ZERO_BOND`), and the admin can raise the floor with `set_min_bond`.
- **No re-rolls.** Replay is keyed on `digest(target | tx_hash)`, so a reporter cannot
  re-submit the same transaction under a new label to draw a different verdict.
- **No instant payouts.** A confirmed breach locks bounty and bond for the challenge
  window. They cannot be claimed or withdrawn while pending or disputed
  (`ERR_PAYOUT_LOCKED`), and a new report cannot overwrite an unsettled bounty.
- **Fixed challenge window.** The unlock time is stamped at trip time, and
  `recover`, `claim_payout` and `dispute_trip` all gate on that stamp. The admin
  cannot change the cooldown while a trip or bounty is in flight
  (`ERR_PENDING_ACTION_LOCKS_COOLDOWN`), so the window cannot be shortened after
  the fact.
- **Bonded disputes.** Only the vault admin can dispute, only inside the window, and
  only by posting at least the reporter's full stake (`ERR_DISPUTE_BOND_TOO_LOW`).
  The loser forfeits their bond to the winner. If validators cannot resolve a dispute
  within seven days, the original verdict stands, so escrow is never locked forever.
- **Self-dealing is net zero.** An admin who reports their own vault and then
  disputes the report recovers only their own two bonds; the bounty returns to the
  reserve.
- **Drills cannot settle.** `simulate_signal` is not payable and never touches vault
  state, escrow, bonds, payouts, replay keys or the target. It stores only the last
  drill verdict (`get_last_drill_tier`).
- **Curated registry.** Only the registry owner can register a target, so no one can
  claim a vault before its operator and point it at feeds they control.

### Pull-over-push accounting and solvency

Consensus execution never triggers an external native transfer. Beneficiaries pull
funds through `withdraw()`, which zeroes the claim and decrements accounting before
`emit_transfer`. The invariant

```
total_deposited == sum(vault escrow balances) + locked_escrow
```

holds after every transition, where `locked_escrow` covers claimable balances,
pending and disputed bounties, reporter bonds and dispute bonds. The direct suite
asserts it across trips, slashes, refunds, claims, and both dispute outcomes.

### Non-deterministic isolation

No contract storage is read or written inside the `leader_fn` / `validator_fn`
closures. All values they need are copied into plain memory first, every
`gl.nondet.*` call sits lexically inside the block passed to `gl.vm.run_nondet`, and
all state transitions happen deterministically after consensus resolves. The only
time source is the transaction timestamp.

---

## 5. Local Development, Testing and Verification

### Prerequisites

```bash
pip install -r requirements-dev.txt   # genlayer-py, genlayer-test, genvm-linter, pytest
```

The GenLayer components are one release-candidate set and move together, so
`requirements-dev.txt` pins each exactly rather than ranging over it.

### Direct-mode tests (fast, in-memory, no Docker)

```bash
pytest tests/direct/ -v
```

99 tests against the in-memory GenVM, with web and LLM calls replaced by test
doubles. They cover registration and feed validation, evidence format and target
binding, strict verdict parsing, every fail-closed revert, bond refund and slash,
the challenge window, both dispute outcomes and the deadline fallback, the drill's
non-settlement, replay and re-roll rejection, validator agreement, the reference
vault's guardian-only pause, and the solvency invariant.

### Linter

```bash
genvm-lint lint contracts/stasis_guardian.py && genvm-lint validate contracts/stasis_guardian.py
genvm-lint lint contracts/reference_vault.py && genvm-lint validate contracts/reference_vault.py
```

Both contracts pass `lint` and `validate` with no warnings.

### Integration tests (full consensus, requires a live GenLayer environment)

```bash
gltest tests/integration/ -v -s --network localnet        # against a local `genlayer up`
gltest tests/integration/ -v -s --network studio_devnet   # the v0.6 preview, fee-charging
```

See `tests/integration/README.md`. The deterministic pipeline, including a live
fetch of both public explorers that must reject evidence about another address,
runs without an LLM; tests that need a real verdict are gated behind
`STASIS_INTEGRATION_LLM=1`.

Use `studio_devnet`, not `studionet`, to validate a v0.6 build. The chain object
carries the consensus contract addresses, so the network name selects the consensus
being tested against - and `studionet` is stable Studio, not the preview.

### Fee profile (required after any contract, GenVM, Studio or fee-policy change)

```bash
make profile      # re-measures from real finalized transactions -> fee-profile.json
```

Consensus v0.6 charges per transaction, so every write must carry a
`FeesDistribution` and its quoted fee value. The frontend does not compute that
distribution: it reads the measured work profile from `fee-profile.json` and lets the
SDK apply the network's live prices and caps at estimate time
(`apps/web/lib/fees.ts`). The profile therefore only has to describe how much *work*
a method does, and unused budget is refunded at finalization.

A stale profile under-allocates and the network rejects the write before the contract
ever runs - `FeesDistributionMissing` / `FeeValueMustBeNonZero`, which reads like a
contract error but is a submission error. Re-run `make profile` whenever any of the
four inputs above changes.

Profiling must read a **finalized** receipt. A decided receipt reports
`executionConsumed` as 0, because the protocol only settles the deposit and computes
the refund at finalization, so profiling off one measures every method as free.

### Frontend dashboard

```bash
cd apps/web
npm install
cp .env.local.example .env.local   # guardian + target vault addresses, chain
npm run dev                        # http://localhost:3000
npm run build                      # production build, 0 errors
```

### End-to-end connectivity check

```bash
NODE_PATH="$(pwd)/apps/web/node_modules" npx tsx scripts/verify_frontend_connection.ts
```

Reads the exact frontend config and runs read -> drill -> receipt-poll against the
configured chain, using the same `genlayer-js` client the browser uses. It asserts
success the way the app does - a terminal-good *status* **and** a
`FINISHED_WITH_RETURN` *execution result* - and prints the fee deposit, the consumed
part and the refund as three separate numbers.

---

## 6. Deployment and Addresses

Consensus **v0.6** (Studio **v0.123** RC) on the **Studio Devnet preview**. The
authoritative record is `deployments/studio-dev.json`, written by the deploy step:

```bash
STASIS_DEPLOY=1 STASIS_DEPLOYER_KEY_FILE=<path to owner key> NO_PROXY="*" \
  gltest tests/integration/test_deploy_studio_dev.py -v -s --network studio_devnet
```

The deployer becomes the registry owner and the reference vault's admin, so the
deploy step refuses to run without a key file that is kept.

| Field                   | Value                                          |
| ----------------------- | ---------------------------------------------- |
| Network                 | GenLayer Studio Devnet (preview, fee-charging) |
| Chain ID                | `61997`                                        |
| RPC endpoint            | `https://studio-dev.genlayer.com/api`          |
| Explorer                | `https://explorer-studio-dev.genlayer.com`     |
| Stasis Guardian         | `0x12c7ecA1531aC35F3fA1c2153E90Dae8E8e1D959`   |
| Reference target vault  | `0x73a1d62F1eE6C47d84bB0C577d21846582534918`   |
| Registry owner          | `0x0f4F188E5815562b14AF3Af87f6EbA2f9B68E981`   |

Studio Devnet charges fees: writes must carry a fee distribution (see the fee profile
above). It is a preview network and may be reset; durable testing belongs on
Bradbury once the compatible v0.6 stack is promoted there.

### Ephemeral Reviewer Mode

The dashboard exposes a one-click **Reviewer Mode** that generates an ephemeral
in-browser account with `genlayer-js` `createAccount()`. No wallet install, seed
phrase, or funding is required.

1. Open the dashboard (`apps/web`).
2. Click **1-Click Reviewer Mode** in the Guardian Access panel.
3. Pick a scenario and click **Execute Scenario**. The panel plays an off-chain
   preview of what a live report with that evidence does, and - with Reviewer Mode
   active - broadcasts a real drill (`simulate_signal`) to Studio Devnet with both
   feed bodies bound to the reference vault and a fresh tx hash.
4. The drill is polled to a **finalized** receipt. Its verdict is read from the
   receipt (or from `get_last_drill_tier`) and shown with the transaction hash and an
   explorer link. The drill does not settle, so the Live Chain Readout - which shows
   only values read from the chain - keeps showing the vault's real state.

Strict EIP-6963 provider selection (`rdns === "io.metamask"`) is used for optional
browser-wallet connection so a Phantom-injected provider cannot hijack MetaMask Snap
calls.

### Consensus v0.6 constraints

Three v0.6 behaviours are load-bearing here and are easy to regress:

- **Runner header blank line.** Line 1 of a contract must be exactly
  `# { "Depends": "py-genlayer:<hash>" }` and line 2 must be blank. Dropping the
  blank line fails deployment with `invalid_contract runner malformed`.
- **Address parameters arrive as `str`.** An `Address`-annotated parameter is only
  decoded into an `Address` when the caller tags the calldata as an address. An
  untagged call - the Studio write UI, a schema-free client, a raw RPC call - arrives
  as a plain `str`, and the storage descriptors require the real wrapper
  (`AddrDesc.set` calls `.as_bytes`). An un-normalized `str` therefore raises
  `AttributeError` on write and *silently misses* on lookup, since a `str` key never
  equals an `Address` key. Every public method that takes an address normalizes it on
  entry via `_as_address`.
- **Fees settle at finalization.** Wait for `finalized` (`wait_until=` in Python,
  `waitUntil:` in genlayer-js), not `decided`/`ACCEPTED`. A decided receipt reports
  `executionConsumed` as 0. The genlayer-js default polling budget is 10 retries at
  3s, which a nondet round outlives, so `apps/web/lib/genlayer.ts` sets an explicit
  budget. gltest's own `deploy()` defaults to waiting for `ACCEPTED`, and records the
  deploy's fee observation from that receipt, so the integration fixture and the
  deploy step both pass `wait_until="finalized"` explicitly - otherwise the profile's
  `deploy` entry reads as free.

---

## Repository Layout

```
contracts/
  stasis_guardian.py     # The Stasis Guardian intelligent contract
  reference_vault.py     # Guardian-only pausable target vault
tests/
  direct/                # In-memory direct-mode tests (no Docker)
  integration/           # Full-consensus tests + the deploy step
apps/web/                # Next.js operations terminal / dashboard
  lib/fees.ts            # Measured-profile -> SDK fee estimate
  lib/genlayer.ts        # Isolated genlayer-js integration (reads, drills, receipts)
scripts/
  verify_frontend_connection.ts   # read -> drill -> poll connectivity check
  ascii_scan.sh                    # pure-ASCII gate
deployments/
  studio-dev.json        # What is deployed where (written by the deploy step)
fee-profile.json         # Measured per-method fee profile (written by `make profile`)
specs/                   # Specification, data model, and hardening plan
```

## Standards

Pure ASCII English across contracts, tests, UI, and configuration. GenVM storage
uses only sized primitives and sanctioned containers (`TreeMap`, `DynArray`,
`Address`, `u256`, `u32`), and every storage struct is `@allow_storage @dataclass`.
