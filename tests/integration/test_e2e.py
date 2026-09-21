"""End-to-end integration tests for the Stasis Guardian against a live GenLayer
network with full leader + validator consensus.

The deterministic pipeline (registration, configuration, native escrow accounting,
withdrawal guard, the anti-griefing bond floor, the recovery guard, deterministic
adjudication guards, and the non-deterministic consensus block itself) is exercised
on every run. Tests that require a real LLM verdict (an actual CRITICAL_BREACH trip,
the recover() that follows it, bounty payout, replay burn) are gated on
STASIS_INTEGRATION_LLM=1 so the suite stays green on a keyless GLSim.
"""

from gltest.assertions import tx_execution_succeeded

from conftest import (
    PRIMARY_FEED,
    SECONDARY_FEED,
    STATE_ARMED,
    STATE_RESTORED,
    STATE_TRIPPED,
    TIER_CRITICAL_BREACH,
    requires_llm,
    synthetic_target,
)


def _register(gc, target, threshold=500, bounty=0, cooldown=0, active=True):
    return gc.write(
        "register_vault",
        args=[target, PRIMARY_FEED, SECONDARY_FEED, threshold, bounty, cooldown, active],
    )


# --- Deterministic consensus pipeline (no LLM required) -----------------------


def test_deploy_register_and_readback(gc):
    target = synthetic_target(1)
    assert tx_execution_succeeded(_register(gc, target, threshold=750, bounty=100, cooldown=3600))

    assert gc.read("is_registered", [target]) is True
    assert gc.read("get_state", [target]) == STATE_ARMED
    assert gc.read("is_active", [target]) is True
    assert gc.read("get_threshold_bps", [target]) == 750
    assert gc.read("get_bounty_amount", [target]) == 100
    assert gc.read("get_cooldown_seconds", [target]) == 3600
    assert gc.read("get_primary_feed", [target]) == PRIMARY_FEED
    assert gc.read("get_secondary_feed", [target]) == SECONDARY_FEED
    assert gc.read("get_incident_count", [target]) == 0


def test_duplicate_registration_fails(gc):
    target = synthetic_target(2)
    assert tx_execution_succeeded(_register(gc, target))
    # A second registration of the same target must be rejected by consensus.
    assert gc.write_expect_fail(
        "register_vault",
        args=[target, PRIMARY_FEED, SECONDARY_FEED, 500, 0, 0, True],
    )


def test_configure_persists(gc):
    target = synthetic_target(3)
    assert tx_execution_succeeded(_register(gc, target, threshold=500))
    assert tx_execution_succeeded(
        gc.write("configure_vault", args=[target, 1200, 500, 900, False])
    )
    assert gc.read("get_threshold_bps", [target]) == 1200
    assert gc.read("get_bounty_amount", [target]) == 500
    assert gc.read("get_cooldown_seconds", [target]) == 900
    assert gc.read("is_active", [target]) is False


def test_deposit_escrow_accounting(gc):
    target = synthetic_target(4)
    assert tx_execution_succeeded(_register(gc, target))

    before_total = gc.read("get_total_deposited")
    assert tx_execution_succeeded(gc.write("deposit", args=[target], value=1000))

    assert gc.read("get_vault_escrow", [target]) == 1000
    assert gc.read("get_total_deposited") == before_total + 1000
    # Nothing is owed to reporters yet, so locked escrow stays zero.
    assert gc.read("get_locked_escrow") == 0


def test_deposit_zero_reverts(gc):
    target = synthetic_target(5)
    assert tx_execution_succeeded(_register(gc, target))
    assert gc.write_expect_fail("deposit", args=[target], value=0)


def test_withdraw_nothing_reverts(gc):
    # No claimable balance for the caller -> consensus rejects the withdrawal.
    assert gc.write_expect_fail("withdraw")


def test_signal_on_inactive_vault_is_noop(gc):
    # An inactive vault short-circuits in the deterministic guard before any
    # web/LLM work: the write still goes through full consensus and records nothing.
    target = synthetic_target(6)
    assert tx_execution_succeeded(_register(gc, target, active=False))
    receipt = gc.write("submit_signal", args=[target, "0xtx", "inc-1", "spurious"], value=0)
    assert tx_execution_succeeded(receipt)
    assert gc.read("get_incident_count", [target]) == 0
    assert gc.read("get_state", [target]) == STATE_ARMED


def test_signal_on_unregistered_vault_is_noop(gc):
    target = synthetic_target(7)
    receipt = gc.write("submit_signal", args=[target, "0xtx", "inc-1", "spurious"], value=0)
    # Unregistered target: refund path + NORMAL, no revert.
    assert tx_execution_succeeded(receipt)


def test_set_min_bond_floor_enforced(gc):
    # The anti-griefing bond floor is a deterministic gate that has to hold before
    # the feeds are read: if it only applied inside the adjudication path, a
    # spammer could still cost the network a dual-feed fetch per fabricated report.
    target = synthetic_target(9)
    assert tx_execution_succeeded(_register(gc, target, active=False))
    assert tx_execution_succeeded(gc.write("set_min_bond", args=[target, 500]))
    assert gc.read("get_min_bond", [target]) == 500

    # Under-bonded: rejected by the guard, before any web/LLM work.
    assert gc.write_expect_fail(
        "submit_signal", args=[target, "0xbond", "bond-1", "under-bonded"], value=499
    )
    # At the floor: the gate lets it through. The vault is inactive, so the cycle
    # short-circuits to the no-op refund rather than reaching the network.
    assert tx_execution_succeeded(
        gc.write("submit_signal", args=[target, "0xbond", "bond-1", "at-floor"], value=500)
    )


def test_recover_rejected_on_armed_vault(gc):
    # recover() is the message-emitting end of the lifecycle - it lifts the pause on
    # the target vault - and it is gated on the vault actually being tripped. On an
    # armed vault the guard must reject it, so no unpause is ever emitted for a
    # vault that was never paused.
    target = synthetic_target(10)
    assert tx_execution_succeeded(_register(gc, target))
    assert gc.write_expect_fail("recover", args=[target])
    assert gc.read("get_state", [target]) == STATE_ARMED


def test_nondet_consensus_block_executes(gc):
    # Drives the full run_nondet path across all validators - the only place
    # non-determinism runs. Which branch executes depends on whether the network
    # has an LLM provider reachable, so the assertions below pin the invariant
    # each branch must uphold rather than assuming one of them: without a provider
    # exec_prompt raises and the leader degrades to the llm_error bucket, and with
    # one the prompt runs for real.
    target = synthetic_target(8)
    assert tx_execution_succeeded(_register(gc, target, threshold=500))
    receipt = gc.write(
        "simulate_signal",
        args=[target, "0xsim", "sim-1", "primary drain body", "secondary drain body", "demo"],
        value=0,
    )
    # The claim under test: consensus held on the non-deterministic result.
    assert tx_execution_succeeded(receipt)

    if gc.read("get_incident_count", [target]) == 0:
        # Degraded telemetry: no adjudication happened, so the incident is not
        # burned and stays retryable once the feeds heal.
        assert gc.read("is_incident_processed", [target, "0xsim", "sim-1"]) is False
        assert gc.read("get_state", [target]) == STATE_ARMED
    else:
        # A provider was reachable: a real adjudication was recorded and the
        # incident key burned against replay.
        assert gc.read("get_incident_count", [target]) == 1
        assert gc.read("is_incident_processed", [target, "0xsim", "sim-1"]) is True
        # Tier and lifecycle must agree, whatever verdict the model returned:
        # only a confirmed CRITICAL_BREACH trips the breaker.
        tier = gc.read("get_tier", [target])
        state = gc.read("get_state", [target])
        if tier == TIER_CRITICAL_BREACH:
            assert state == STATE_TRIPPED
        else:
            assert state != STATE_TRIPPED


# --- LLM-dependent adjudication (requires a configured provider) ---------------


@requires_llm
def test_simulate_critical_breach_trips_and_pays(gc):
    target = synthetic_target(20)
    assert tx_execution_succeeded(_register(gc, target, threshold=500, bounty=700, cooldown=3600))
    assert tx_execution_succeeded(gc.write("deposit", args=[target], value=1000))
    admin = gc.read("get_admin", [target])

    payload_a = '{"tvl_drop_bps": 9200, "reason": "flash-loan reentrancy draining the pool"}'
    payload_b = '{"price_deviation_bps": 8800, "state": "abnormal drain confirmed"}'
    receipt = gc.write(
        "simulate_signal",
        args=[target, "0xexploit", "breach-1", payload_a, payload_b, "zero-day drain"],
        value=0,
    )
    assert tx_execution_succeeded(receipt)

    assert gc.read("get_state", [target]) == STATE_TRIPPED
    assert gc.read("get_tier", [target]) == TIER_CRITICAL_BREACH
    # Pull-over-push: reporter (deployer) has a claimable bounty; escrow debited.
    assert gc.read("get_claimable", [admin]) == 700
    assert gc.read("get_vault_escrow", [target]) == 300


@requires_llm
def test_full_lifecycle_trip_then_recover(gc):
    # Walks the whole breaker lifecycle end to end, including the recover() branch
    # that lifts the pause. Cooldown is zero so recovery is permitted as soon as the
    # trip lands - the cooldown gate itself is covered deterministically in the
    # direct suite, and waiting it out here would mean an hour of wall clock.
    target = synthetic_target(22)
    assert tx_execution_succeeded(_register(gc, target, threshold=500, bounty=0, cooldown=0))

    payload_a = '{"tvl_drop_bps": 9300, "reason": "oracle manipulation draining the pool"}'
    payload_b = '{"price_deviation_bps": 9100, "state": "abnormal drain confirmed"}'
    assert tx_execution_succeeded(
        gc.write(
            "simulate_signal",
            args=[target, "0xcycle", "cycle-1", payload_a, payload_b, "lifecycle"],
            value=0,
        )
    )
    assert gc.read("get_state", [target]) == STATE_TRIPPED

    # The vault admin recovers: the breaker is restored and the target unpaused.
    assert tx_execution_succeeded(gc.write("recover", args=[target]))
    assert gc.read("get_state", [target]) == STATE_RESTORED


@requires_llm
def test_replay_rejected_after_adjudication(gc):
    target = synthetic_target(21)
    assert tx_execution_succeeded(_register(gc, target, threshold=8000))
    payload_a = '{"tvl_drop_bps": 20, "reason": "routine arbitrage"}'
    payload_b = '{"price_deviation_bps": 15, "state": "nominal"}'
    first = gc.write(
        "simulate_signal",
        args=[target, "0xabc", "rep-1", payload_a, payload_b, "benign"],
        value=0,
    )
    assert tx_execution_succeeded(first)
    assert gc.read("is_incident_processed", [target, "0xabc", "rep-1"]) is True

    # Replaying the identical incident is rejected deterministically.
    assert gc.write_expect_fail(
        "simulate_signal",
        args=[target, "0xabc", "rep-1", payload_a, payload_b, "benign"],
    )
