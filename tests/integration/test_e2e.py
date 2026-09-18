"""End-to-end integration tests for the Stasis Guardian against a live GenLayer
network with full leader + validator consensus.

The deterministic pipeline (registration, configuration, native escrow accounting,
withdrawal guard, deterministic adjudication guards, and the non-deterministic
consensus block itself) is exercised on every run. Tests that require a real LLM
verdict (an actual CRITICAL_BREACH trip, bounty payout, replay burn) are gated on
STASIS_INTEGRATION_LLM=1 so the suite stays green on a keyless GLSim.
"""

from gltest.assertions import tx_execution_succeeded

from conftest import (
    PRIMARY_FEED,
    SECONDARY_FEED,
    STATE_ARMED,
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


def test_nondet_consensus_block_executes(gc):
    # Drives the full run_nondet_unsafe path across all validators. With no LLM
    # provider the leader catches the failed exec_prompt and degrades to the
    # llm_error bucket, on which every validator agrees -> consensus holds, the tx
    # succeeds, and the breaker does NOT trip on degraded telemetry.
    target = synthetic_target(8)
    assert tx_execution_succeeded(_register(gc, target, threshold=500))
    receipt = gc.write(
        "simulate_signal",
        args=[target, "0xsim", "sim-1", "primary drain body", "secondary drain body", "demo"],
        value=0,
    )
    assert tx_execution_succeeded(receipt)
    # Degraded LLM telemetry never trips the circuit breaker.
    assert gc.read("get_state", [target]) == STATE_ARMED
    assert gc.read("get_incident_count", [target]) == 0


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
