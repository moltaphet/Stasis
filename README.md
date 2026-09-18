# Stasis Protocol

**Autonomous, AI-Adjudicated Emergency Circuit Breaker for DeFi Vaults on GenLayer.**

Stasis eliminates the multisig and human response lag that turns a zero-day
exploit into a total pool drain. Instead of waiting for keyholders to coordinate,
Stasis uses decentralized multi-LLM consensus over multi-feed telemetry to
adjudicate an incident and trigger a verifiable on-chain emergency pause inside the
exploit window - before catastrophic drain finalizes.

- Runtime: GenLayer Intelligent Contract (`contracts/stasis_guardian.py`)
- Consensus: multi-validator equivalence over a non-deterministic block
- Settlement: native GEN escrow with strict pull-over-push accounting
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
   |  Watcher / Bot    |   submits incident (target, tx_hash, incident_id, desc)
   |  Anomaly Report   |   optional native GEN bond attached
   +---------+---------+
             |
             v
   +-------------------------------+
   | Deterministic Guards          |   registered? active? not already TRIPPED?
   | Replay check (processed_...)   |   reject duplicate (target|tx_hash|incident)
   +---------+---------------------+
             |
             v
   +===============================================================+
   |  NON-DETERMINISTIC BLOCK  (gl.vm.run_nondet_unsafe)            |
   |                                                               |
   |  Dual-Feed Telemetry Extraction (gl.nondet.web.get)           |
   |    primary_feed_url  ---+                                      |
   |    secondary_feed_url --+--> cross-reference                  |
   |                                                               |
   |  LLM Consensus Engine (injection-hardened prompt)             |
   |    untrusted text sealed in <untrusted_input> ... </...>      |
   |    validators agree on a DISCRETE TIER:                       |
   |      NORMAL | ELEVATED_RISK | CRITICAL_BREACH | MALICIOUS_REPORT|
   +===============================================================+
             |
             v
   +-------------------------------+
   | Deterministic Settlement      |
   |   tier -> state transition    |
   |   CRITICAL_BREACH:            |
   |     state = TRIPPED           |
   |     credit claimable_balances |   (pull-over-push, no external transfer here)
   |     emit ITargetVault.pause() |   (finalization-gated EVM hook)
   |   MALICIOUS_REPORT:           |
   |     slash reporter bond       |
   +---------+---------------------+
             |
             v
   +-------------------------------+       +---------------------------+
   | Circuit State: TRIPPED        |       | Reporter pulls bounty via |
   | (target vault paused)         |       | withdraw() (CEI + emit)   |
   +-------------------------------+       +---------------------------+
```

### State machine lifecycle

```
        CRITICAL_BREACH                     recover() after cooldown
  ARMED ---------------> TRIPPED --------------------------------> RESTORED
   ^  |                 (paused)                                     |
   |  | ELEVATED_RISK                                                |
   |  v                                                              |
  RATE_LIMITED <--- NORMAL clears ----+     (RESTORED re-arms for monitoring)
```

Stored state values (`u32`): `ARMED = 0`, `TRIPPED = 1`, `RESTORED = 2`,
`RATE_LIMITED = 3`. Monitoring is permitted in any state except `TRIPPED`, which is
idempotent (a second signal on a tripped vault is a no-op). `recover()` is gated by
an enforced on-chain cooldown and emits `unpause()` to the target vault on
finalization.

---

## 3. Integration Guide for External DeFi Protocols

Stasis governs the pause switch of a target vault. Two integration patterns are
supported; a vault may use either.

Circuit state mirror (Solidity):

```solidity
// Mirrors contracts/stasis_guardian.py state values.
enum CircuitState { ARMED, TRIPPED, RESTORED, RATE_LIMITED }

interface IStasisGuardian {
    // Returns the CircuitState for a registered target vault.
    function get_state(address target) external view returns (uint32);
}
```

### Pattern A: Push Model (autonomous pause via PAUSER_ROLE)

The vault grants Stasis authority to pause it. On a `CRITICAL_BREACH` verdict, the
guardian emits an external message that calls `pause()` on the target on
finalization. The vault only needs a standard pausable surface and a role grant.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract ProtectedVault is AccessControl, Pausable {
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    constructor(address stasisGuardian) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        // Grant the Stasis guardian (its chain-layer address) the pauser role.
        _grantRole(PAUSER_ROLE, stasisGuardian);
    }

    // Called by Stasis on CRITICAL_BREACH (finalization-gated external message).
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    // Called by Stasis recover() after the cooldown elapses.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function withdraw(uint256 amount) external whenNotPaused {
        // ... critical logic is inert while paused ...
    }
}
```

The guardian expects exactly this surface:

```python
@gl.evm.contract_interface
class ITargetVault:
    class View:
        def is_paused(self) -> bool: ...
    class Write:
        def pause(self) -> None: ...
        def unpause(self) -> None: ...
```

### Pattern B: Pull Model (guard modifier, zero delegated admin)

The vault delegates no admin authority. Instead, each critical function reads the
Stasis circuit state and refuses to execute while `TRIPPED`. This keeps the vault
fully self-sovereign - Stasis can never move funds, only signal.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IStasisGuardian, CircuitState} from "./IStasisGuardian.sol";

contract SelfGuardedVault {
    address public constant STASIS_ADDRESS = 0x9DDe7a98385EE602E4EFcB80b28D925e8Cafa3aD;

    modifier onlyWhenStasisActive() {
        require(
            IStasisGuardian(STASIS_ADDRESS).get_state(address(this))
                != uint32(CircuitState.TRIPPED),
            "STASIS: circuit tripped"
        );
        _;
    }

    function withdraw(uint256 amount) external onlyWhenStasisActive {
        // ... executes only while the circuit is not TRIPPED ...
    }

    function swap(uint256 amountIn) external onlyWhenStasisActive {
        // ... same guard on any drain-capable path ...
    }
}
```

### Registration and escrow lifecycle

All calls target the deployed `StasisGuardian` contract.

```
# 1. Register the vault (admin = caller).
register_vault(
    target_address,        # Address of the vault to protect
    primary_feed_url,       # First independent telemetry endpoint
    secondary_feed_url,     # Second independent telemetry endpoint
    threshold_bps,          # TVL-drop trip threshold in basis points (e.g. 1500 = 15%)
    bounty_amount,          # Native GEN paid to a reporter on CRITICAL_BREACH
    cooldown_seconds,       # Enforced pause window before recovery is allowed
    active                  # Monitoring on/off
)

# 2. Fund the bounty escrow (payable; value = native GEN).
deposit(target_address)     # value credits vault escrow + total_deposited

# 3. (Operational) Submit an incident (payable; optional reporter bond).
submit_signal(target_address, tx_hash, incident_id, description)

# 4. After cooldown, restore the vault (admin only).
recover(target_address)     # TRIPPED -> RESTORED, emits unpause()

# 5. Reporters pull earned bounties independently.
withdraw()                  # transfers claimable_balances[caller] via CEI
```

---

## 4. Security Pillars and Invariants

### Anti-prompt-injection

User-supplied incident descriptions and raw feed bodies are untrusted. They are
sanitized and encapsulated inside explicit XML boundary tags
(`<untrusted_input> ... </untrusted_input>`); embedded copies of the tags are
stripped case-insensitively, and control characters and non-ASCII bytes are
neutralized before the text reaches the prompt (each feed body is also length
capped) so a feed cannot break out of its sandbox or smuggle hidden directives. The
system prompt instructs validators to treat everything inside the tags strictly as
data, to ignore any instruction found there, and to decide only on verified
numerical divergence from the raw telemetry endpoints. Any instruction-like content
inside the tags is itself treated as evidence of a spoofed report.

### Multi-feed redundancy

Two independent endpoints are fetched and cross-referenced in the same
non-deterministic block. If the primary and secondary feeds do not corroborate - a
catastrophic drain on one but nominal state on the other - validators converge on
`MALICIOUS_REPORT`, the claim is dismissed, and any attached reporter bond is
slashed into the vault reserve. A single noisy or spoofed feed cannot trip a healthy
vault.

### Consensus stability

Verdicts are coarse-bucketed to discrete tiers, never a continuous score, so
subtle RPC variance between validators cannot break consensus. Feed faults are
classified: `[TRANSIENT]` (429 / 5xx / timeout) degrades to a retryable no-op and
never trips; `[EXTERNAL]` (4xx) is deterministic; malformed LLM output falls back
benignly instead of panicking. Validators agree on the tier bucket, never on raw
model text.

### Pull-over-push accounting

Consensus execution never triggers an external native transfer. A `CRITICAL_BREACH`
only credits `claimable_balances[reporter]`. Beneficiaries pull funds through a
standalone `withdraw()` that follows checks-effects-interactions: it zeroes the
claim and decrements accounting before the external `emit_transfer`. Solvency is
tracked with separated fields and the invariant is asserted in tests:

```
total_deposited == sum(vault escrow balances) + locked_escrow
```

`locked_escrow` is incremented in lockstep with every credit to
`claimable_balances` and decremented on `withdraw()`, so by construction
`locked_escrow == sum(claimable_balances)`. The invariant above therefore already
accounts for all reporter claims; adding `sum(claimable_balances)` as a separate
term would double-count.

An optional per-vault reporter-bond floor (`min_bond`, set by the admin via
`set_min_bond()`) can require every `submit_signal()` to attach at least a minimum
native GEN bond. A `MALICIOUS_REPORT` verdict slashes the posted bond into the vault
reserve; `NORMAL` / `ELEVATED_RISK` outcomes refund it. `incident_id` and `tx_hash`
are ASCII strings (they are folded into the replay digest as strings).

### Replay defense

Every incident is keyed by a deterministic 256-bit content digest of
`(target_address, tx_hash, incident_id)` recorded in a `processed_incidents`
`TreeMap[u256, bool]`. A previously adjudicated incident is rejected before any
non-deterministic work runs, so stale attacks cannot be replayed to grief a vault or
double-claim a bounty.

### Non-deterministic isolation

No contract storage is read or written inside the `leader_fn` / `validator_fn`
closures. All values the closures need are copied into plain memory first; all state
transitions happen deterministically after consensus resolves.

---

## 5. Local Development, Testing and Verification

### Prerequisites

```bash
pip install -r requirements-dev.txt   # genlayer-test, genvm-linter, pytest
```

### Direct-mode tests (fast, in-memory, no Docker)

```bash
pytest tests/direct/ -v
```

34 tests run in well under a second against the in-memory GenVM. They cover the
full lifecycle (deposit -> signal -> trip -> withdraw bounty -> recover), replay
rejection, multi-feed discrepancy, transient/LLM fault tolerance, reporter bond
refund/slash, and the solvency invariant.

### Linter

```bash
genvm-lint check contracts/stasis_guardian.py
genvm-lint check contracts/mock_vault.py
```

### Integration tests (full consensus, requires a live GenLayer environment)

```bash
gltest tests/integration/ -v -s --network localnet   # against a local `genlayer up`
```

See `tests/integration/README.md` for environment notes. The deterministic pipeline
runs without an LLM; adjudication tests that require a real verdict are gated behind
`STASIS_INTEGRATION_LLM=1`.

### Frontend dashboard

```bash
cd apps/web
npm install
cp .env.local.example .env.local   # set NEXT_PUBLIC_GUARDIAN_ADDRESS + chain
npm run dev                        # http://localhost:3000
npm run build                      # production build, 0 errors
```

### End-to-end connectivity check

```bash
NODE_PATH="$(pwd)/apps/web/node_modules" npx tsx scripts/verify_frontend_connection.ts
```

Reads the exact frontend config and runs read -> write -> receipt-poll against the
configured chain, using the same `genlayer-js` client the browser uses.

---

## 6. Deployment and Addresses

| Field                 | Value                                          |
| --------------------- | ---------------------------------------------- |
| Network               | GenLayer StudioNet (gasless)                   |
| Chain ID              | `61999`                                        |
| RPC endpoint          | `https://studio.genlayer.com/api`              |
| Stasis Guardian       | `0x9DDe7a98385EE602E4EFcB80b28D925e8Cafa3aD`   |
| Mock target vault     | `0xeD069bb5B08d63cAF210c40764d1dD6E7717FC4d`   |

StudioNet is gasless: an account with a 0 GEN balance can deploy and transact.

Note on read availability: at time of writing, StudioNet's `gen_call` read path
intermittently returns "Contract not found" for finalized contracts (a hosted-node
issue reproduced across the CLI, gltest, and genlayer-js). Writes finalize normally.
The dashboard handles this by degrading to receipt-derived optimistic state with a
`StudioNet Read Sync` status badge rather than a fatal error, and by driving live
state from finalized `simulate_signal` receipts.

### Ephemeral Reviewer Mode (zero-friction evaluation)

The dashboard exposes a one-click **Reviewer Mode** that generates an ephemeral
in-browser account with `genlayer-js` `createAccount()`. Because StudioNet is
gasless, this account can immediately exercise the contract with no wallet install,
seed phrase, or funding.

1. Open the dashboard (`apps/web`).
2. Click **1-Click Reviewer Mode** in the Guardian Access panel.
3. Click **Simulate Exploit Attack**. With Reviewer Mode active this broadcasts a
   real `simulate_signal` transaction to StudioNet in addition to the deterministic
   preview.
4. The transaction is polled to a finalized receipt (status 7). The circuit state
   flips to `TRIPPED`, the verdict tier (`CRITICAL_BREACH`) is surfaced, and the Live
   Chain Readout shows the real finalized transaction hash with an explorer link.
5. Click **Reset System** to restore both panels to `ARMED` / `0.0%` / `0.00 GEN`.

Strict EIP-6963 provider selection (`rdns === "io.metamask"`) is used for optional
browser-wallet connection so a Phantom-injected provider cannot hijack MetaMask Snap
calls.

---

## Repository Layout

```
contracts/
  stasis_guardian.py     # The Stasis Guardian intelligent contract
  mock_vault.py          # Direct-mode stand-in for an EVM target vault
tests/
  direct/                # In-memory direct-mode tests (no Docker)
  integration/           # Full-consensus tests against a live environment
apps/web/                # Next.js operations terminal / dashboard
scripts/
  verify_frontend_connection.ts   # read -> write -> poll connectivity check
  ascii_scan.sh                    # pure-ASCII gate
specs/                   # Specification, data model, and hardening plan
```

## Standards

Pure ASCII English across contracts, tests, UI, and configuration. GenVM storage
uses only sized primitives and sanctioned containers (`TreeMap`, `DynArray`,
`Address`, `u256`, `u32`), and every storage struct is `@allow_storage @dataclass`.
