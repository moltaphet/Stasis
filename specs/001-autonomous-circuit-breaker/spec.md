> **SUPERSEDED - pre-hardening MVP.** This document describes the initial MVP
> design (states ARMED/PAUSED, INCONCLUSIVE verdict, single feed, no native escrow).
> The shipped contract has evolved past it: lifecycle states are
> ARMED/TRIPPED/RESTORED/RATE_LIMITED and verdicts are the discrete tiers
> NORMAL / ELEVATED_RISK / CRITICAL_BREACH / MALICIOUS_REPORT, with dual feeds and
> native GEN escrow. Current ground truth: ../../README.md and ./hardening-plan.md.

# Feature Specification: Autonomous Circuit Breaker

**Feature Branch**: `001-autonomous-circuit-breaker`

**Created**: 2026-09-03

**Status**: Draft

**Input**: User description: "Draft the baseline functional and technical specification for Stasis Protocol: an autonomous emergency circuit breaker deployed on GenLayer that monitors target EVM DeFi vaults, adjudicates threat telemetry via multi-validator AI consensus (Equivalence Principle), and executes an emergency pause on EVM target contracts during an exploit. Target track: Autonomous Protocols (GenLayer Hackathon - The Tank)."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Register and Configure a Monitored Vault (Priority: P1)

A protocol administrator onboards their DeFi vault to Stasis Protocol so it can be
watched for exploits. The administrator supplies the target EVM vault contract
address, a telemetry feed location that reports security incidents, a Total Value
Locked (TVL) drop threshold expressed in basis points, and an active status flag.
Once registered, the vault appears in the monitored set with a starting state of
ARMED.

**Why this priority**: Without a registered and configured vault there is nothing
to monitor, adjudicate, or protect. This is the foundational slice and the minimum
viable product on its own: it proves that a vault can be onboarded, stored using
deterministic on-chain state, and read back for inspection.

**Independent Test**: Register a vault with a valid target address, feed location,
and threshold; then read the vault record back and confirm every configured field
is persisted and the state is ARMED. This is fully testable without any threat
adjudication or EVM dispatch.

**Acceptance Scenarios**:

1. **Given** an administrator with a valid EVM target address and monitoring
   parameters, **When** they register the vault, **Then** the vault is stored with
   state ARMED and all configured fields (target address, feed location, threshold
   in basis points, active status) are retrievable.
2. **Given** a registered vault, **When** the administrator updates the threshold
   or toggles active status, **Then** the updated configuration is persisted and
   readable, and the vault state is unchanged.
3. **Given** a request to register a vault with a malformed or zero target address,
   **When** the administrator submits it, **Then** registration is rejected and no
   vault record is created.

---

### User Story 2 - Autonomous Threat Adjudication by Validator Consensus (Priority: P1)

For an active, ARMED vault, the protocol autonomously fetches live security
telemetry for the vault, and validators independently assess whether the reported
incident is an active malicious attack or drain versus legitimate arbitrage or
ordinary market volatility. The protocol advances toward a triggered decision only
when validators reach equivalence consensus that a genuine exploit is underway.
A single validator's opinion is never sufficient.

**Why this priority**: This is the core autonomous decision engine and the primary
differentiator of the protocol. It converts noisy external telemetry into a single,
consensus-backed verdict. It is co-critical with vault registration because the
adjudication result is what authorizes any protective action.

**Independent Test**: Feed a telemetry payload describing a clear drain event to an
active vault and confirm the protocol reaches a MALICIOUS consensus verdict and
records the incident. Feed a telemetry payload describing normal volatility and
confirm the verdict is BENIGN and no protective action is authorized. Both cases
are testable by inspecting the recorded verdict and resulting state.

**Acceptance Scenarios**:

1. **Given** an active vault and telemetry describing an active exploit that exceeds
   the configured TVL drop threshold, **When** adjudication runs, **Then** validators
   reach a MALICIOUS consensus verdict and the protocol records the incident hash,
   verdict, and timestamp, and marks the vault for triggering.
2. **Given** an active vault and telemetry describing legitimate arbitrage or
   volatility within the configured threshold, **When** adjudication runs, **Then**
   the consensus verdict is BENIGN and no protective action is authorized.
3. **Given** validators that cannot reach equivalence consensus on a telemetry
   payload, **When** adjudication runs, **Then** the protocol does not advance to a
   triggered decision and the vault remains ARMED, with the inconclusive outcome
   recorded.
4. **Given** an inactive vault, **When** adjudication is attempted, **Then** no
   telemetry is fetched and no verdict is produced.

---

### User Story 3 - EVM Emergency Circuit Breaker (Priority: P1)

When a MALICIOUS verdict is confirmed by consensus for a vault, the protocol
executes an emergency circuit breaker: it dispatches a pause instruction to the
target EVM vault contract to halt exploitable operations. The vault state flips to
PAUSED, and the incident hash, validator verdict, and timestamp are logged with the
paused vault.

**Why this priority**: This is the protective payload of the entire system. The
monitoring and adjudication only deliver value if a confirmed exploit results in an
actual, timely halt of the target vault. It depends on Stories 1 and 2 but completes
the end-to-end protection promise.

**Independent Test**: Given a vault with a confirmed MALICIOUS verdict, run the
trigger step and confirm that a pause instruction is dispatched to the target EVM
contract exactly once, the vault state becomes PAUSED, and the incident record is
attached. Confirm that a vault without a confirmed verdict cannot be paused.

**Acceptance Scenarios**:

1. **Given** a vault with a confirmed MALICIOUS consensus verdict, **When** the
   trigger executes, **Then** a pause instruction is dispatched to the target EVM
   vault contract and the vault state becomes PAUSED.
2. **Given** a vault that has just been paused, **When** the state is inspected,
   **Then** the incident hash, validator verdict, and timestamp are recorded on the
   vault.
3. **Given** a vault already in PAUSED state, **When** a further trigger is attempted
   for the same incident, **Then** no duplicate pause instruction is dispatched.
4. **Given** a vault with only a BENIGN or inconclusive verdict, **When** a trigger
   is attempted, **Then** the trigger is refused and the vault remains ARMED.

---

### User Story 4 - Governance Recovery and Judge Simulation (Priority: P2)

After a threat is mitigated off-chain, an authorized administrator or governance
actor resolves the incident and resets the vault from PAUSED back to ARMED so normal
operation can resume. Separately, for demonstration to hackathon judges, the system
exposes mock hooks that let an operator inject a simulated incident feed and observe
the circuit breaker activate end to end in real time.

**Why this priority**: Recovery is required for the protocol to be usable beyond a
single incident, and the simulation hooks are essential for demonstrating the full
lifecycle to judges. These are important but come after the core protect-the-vault
path is proven, hence P2.

**Independent Test**: From a PAUSED vault, perform an authorized reset and confirm
the state returns to ARMED and the vault is monitorable again. Separately, inject a
mock malicious incident and confirm the full ARMED to PAUSED transition is observable
without a live external feed.

**Acceptance Scenarios**:

1. **Given** a PAUSED vault and an authorized resolver, **When** the resolver resets
   the vault, **Then** the state returns to ARMED and the prior incident record is
   retained in history.
2. **Given** a PAUSED vault and an unauthorized actor, **When** a reset is attempted,
   **Then** the reset is refused and the vault remains PAUSED.
3. **Given** an operator using the demo mock hook, **When** a mock malicious incident
   is injected for an active vault, **Then** the protocol adjudicates and, on a
   MALICIOUS consensus verdict, transitions the vault to PAUSED, observable in real
   time.

---

### Edge Cases

- What happens when the telemetry feed is unreachable, returns an empty body, or
  returns malformed data? The adjudication run MUST NOT crash the protocol, MUST NOT
  trigger a pause, and MUST leave the vault in its prior state with the failed fetch
  recorded.
- How does the system handle a telemetry payload that reports a TVL drop below the
  configured basis-point threshold? It MUST be treated as within tolerance and MUST
  NOT be escalated to a MALICIOUS verdict on the drop magnitude alone.
- What happens when validators split and cannot reach equivalence consensus? The
  outcome MUST be recorded as inconclusive and MUST NOT authorize any protective
  action.
- What happens if the EVM pause dispatch cannot be finalized? The vault MUST NOT be
  marked PAUSED until the dispatch is confirmed on transaction finalization, so state
  never claims protection that did not occur.
- What happens when a duplicate incident (same incident hash) is presented after a
  vault is already PAUSED? The system MUST treat it as already handled and MUST NOT
  dispatch a duplicate pause.
- What happens when adjudication is attempted on an inactive or unregistered vault?
  It MUST be a no-op that produces no verdict and no external fetch.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow an administrator to register a monitored vault by
  supplying a target EVM contract address, a telemetry feed location, a TVL drop
  threshold in basis points, and an active status flag.
- **FR-002**: System MUST reject registration when the target address is malformed
  or zero, and MUST NOT create a vault record in that case.
- **FR-003**: System MUST persist all vault configuration and state using
  deterministic on-chain storage, so every field is retrievable after the
  transaction that set it.
- **FR-004**: System MUST allow an administrator to update a vault's threshold and
  active status, and MUST persist those updates.
- **FR-005**: System MUST represent each vault with an explicit lifecycle state, at
  minimum ARMED and PAUSED, and MUST make the current state readable.
- **FR-006**: System MUST, for an active vault, fetch live security telemetry for
  that vault from its configured feed location during an adjudication run.
- **FR-007**: System MUST perform threat assessment such that validators
  independently evaluate whether an incident is an active malicious attack or drain
  versus legitimate arbitrage or volatility.
- **FR-008**: System MUST require equivalence consensus across validators before
  producing a MALICIOUS verdict; a single validator's assessment MUST NOT be
  sufficient to authorize protective action.
- **FR-009**: System MUST record, for each adjudication that reaches a verdict, the
  incident hash, the validator verdict, and a timestamp.
- **FR-010**: System MUST classify an adjudication outcome as MALICIOUS, BENIGN, or
  inconclusive, and MUST only authorize a trigger on a MALICIOUS consensus verdict.
- **FR-011**: System MUST NOT fetch telemetry or produce a verdict for an inactive or
  unregistered vault.
- **FR-012**: System MUST, upon a confirmed MALICIOUS verdict, dispatch an emergency
  pause instruction to the target EVM vault contract.
- **FR-013**: System MUST transition the vault to PAUSED only when the pause dispatch
  is confirmed on transaction finalization, and MUST record the incident hash,
  verdict, and timestamp on the paused vault.
- **FR-014**: System MUST NOT dispatch a duplicate pause instruction for a vault that
  is already PAUSED for the same incident.
- **FR-015**: System MUST refuse a trigger for any vault whose verdict is BENIGN or
  inconclusive, leaving the vault in ARMED.
- **FR-016**: System MUST allow an authorized administrator or governance actor to
  reset a PAUSED vault back to ARMED, and MUST refuse resets from unauthorized
  actors.
- **FR-017**: System MUST retain the history of past incidents for a vault across a
  reset, so a reset does not erase the audit trail.
- **FR-018**: System MUST provide a mock incident-injection hook for demonstration
  that drives the same adjudication and trigger path as live telemetry, without
  requiring a live external feed.
- **FR-019**: System MUST keep all deterministic state machine transitions (ARMED to
  PAUSED to ARMED) outside of any non-deterministic execution, so state changes are
  reproducible across validators.
- **FR-020**: System MUST never mutate persistent vault state from within a
  non-deterministic operation; only the deterministic layer may write state after a
  consensus outcome is available.
- **FR-021**: All contracts, tests, scripts, and documentation for this feature MUST
  be strictly pure ASCII and pure English, in compliance with the project
  constitution.

### Key Entities *(include if feature involves data)*

- **Monitored Vault**: A registered target under protection. Attributes: target EVM
  contract address, telemetry feed location, TVL drop threshold in basis points,
  active status, current lifecycle state (ARMED or PAUSED), and reference to its
  incident history and latest incident record.
- **Incident Record**: A single adjudicated event. Attributes: incident hash,
  validator verdict (MALICIOUS, BENIGN, or inconclusive), timestamp, and the
  telemetry summary that produced it.
- **Verdict**: The consensus classification of an adjudication run, one of MALICIOUS,
  BENIGN, or inconclusive, that gates whether a trigger is authorized.
- **Administrator / Governance Actor**: The authorized party permitted to register
  and configure vaults and to reset a PAUSED vault to ARMED.
- **Telemetry Feed**: The external source of security incident data for a vault,
  identified by the configured feed location and consulted during adjudication.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An administrator can register and fully configure a monitored vault in
  a single transaction, and every configured field is retrievable immediately
  afterward.
- **SC-002**: For a clear exploit scenario that exceeds the configured threshold, the
  protocol reaches a MALICIOUS consensus verdict and the target vault reaches the
  PAUSED state end to end, with no manual intervention beyond initiating adjudication.
- **SC-003**: For a legitimate volatility or arbitrage scenario within threshold, the
  protocol reaches a BENIGN verdict and takes no protective action in 100 percent of
  such cases in the test suite.
- **SC-004**: No protective pause is ever dispatched without a recorded MALICIOUS
  consensus verdict; zero false triggers occur across the acceptance test suite.
- **SC-005**: When a vault is PAUSED, the incident hash, validator verdict, and
  timestamp are always present and consistent with the adjudication that caused it.
- **SC-006**: An authorized resolver can reset a PAUSED vault to ARMED, and the vault
  is immediately monitorable again while its incident history is preserved.
- **SC-007**: A hackathon judge can inject a mock malicious incident and observe the
  full ARMED to PAUSED transition in real time without configuring a live feed.
- **SC-008**: Every source, test, script, and document produced for this feature
  contains zero non-ASCII characters.

## Assumptions

- The target EVM vault contract exposes a pausing capability that an external caller
  with the appropriate authority can invoke to halt exploitable operations.
- Stasis Protocol holds or is granted the authority required to dispatch the pause
  instruction to registered target vaults.
- The telemetry feed for a vault is reachable over standard web retrieval and returns
  incident data that validators can assess; feed reliability is outside the
  protocol's control and is handled defensively.
- Equivalence consensus semantics are provided by the underlying GenLayer platform;
  this feature relies on that mechanism rather than defining its own voting protocol.
- A single administrator identity per vault is sufficient for the baseline; richer
  multi-signer governance is out of scope for this version.
- The demo mock hooks are intended for demonstration and testing and are not a
  production ingestion path for real incidents.
- Real-time observability for judges is delivered through the demo layer; the
  on-chain protocol exposes readable state that the demo surfaces.
