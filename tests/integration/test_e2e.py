"""End-to-end integration tests for the Stasis Guardian against a live GenLayer
network with full leader + validator consensus.

The deterministic pipeline (curated registration, configuration, admin handover,
native escrow accounting, the mandatory bond and bond floor, evidence format
checks, the payout/dispute guards, the recovery guard, live feed fetching with
target binding, and the non-deterministic consensus block itself) is exercised on
every run. Tests that require a real LLM verdict (an actual verdict from a drill,
a live CRITICAL_BREACH trip) are gated on STASIS_INTEGRATION_LLM=1.
"""

from gltest.assertions import tx_execution_succeeded

from conftest import (
    MAINNET_TX,
    MAINNET_TX_TO,
    PAYOUT_NONE,
    PRIMARY_FEED,
    SECONDARY_FEED,
    STATE_ARMED,
    TIER_CRITICAL_BREACH,
    bound_body,
    requires_llm,
    synthetic_target,
    tx,
)

BOND = 10


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
    assert gc.read("get_payout_status", [target]) == PAYOUT_NONE


def test_duplicate_registration_fails(gc):
    target = synthetic_target(2)
    assert tx_execution_succeeded(_register(gc, target))
    assert gc.write_expect_fail(
        "register_vault",
        args=[target, PRIMARY_FEED, SECONDARY_FEED, 500, 0, 0, True],
    )


def test_invalid_feed_registration_fails(gc):
    target = synthetic_target(11)
    assert gc.write_expect_fail(
        "register_vault",
        args=[target, "http://insecure.example/{tx_hash}", SECONDARY_FEED, 500, 0, 0, True],
    )
    assert gc.read("is_registered", [target]) is False


def test_configure_and_admin_handover(gc):
    target = synthetic_target(3)
    assert tx_execution_succeeded(_register(gc, target, threshold=500))
    assert tx_execution_succeeded(
        gc.write("configure_vault", args=[target, 1200, 500, 900, False])
    )
    assert gc.read("get_threshold_bps", [target]) == 1200
    assert gc.read("get_bounty_amount", [target]) == 500
    assert gc.read("get_cooldown_seconds", [target]) == 900
    assert gc.read("is_active", [target]) is False

    # Handover to the same account and ownership re-assertion both exercise the
    # governance writes without locking the suite's account out of the module.
    admin = gc.read("get_admin", [target])
    assert tx_execution_succeeded(gc.write("transfer_vault_admin", args=[target, admin]))
    owner = gc.read("get_owner")
    assert tx_execution_succeeded(gc.write("transfer_ownership", args=[owner]))


def test_deposit_escrow_accounting(gc):
    target = synthetic_target(4)
    assert tx_execution_succeeded(_register(gc, target))

    before_total = gc.read("get_total_deposited")
    before_locked = gc.read("get_locked_escrow")
    assert tx_execution_succeeded(gc.write("deposit", args=[target], value=1000))

    assert gc.read("get_vault_escrow", [target]) == 1000
    assert gc.read("get_total_deposited") == before_total + 1000
    assert gc.read("get_locked_escrow") == before_locked


def test_deposit_zero_reverts(gc):
    target = synthetic_target(5)
    assert tx_execution_succeeded(_register(gc, target))
    assert gc.write_expect_fail("deposit", args=[target], value=0)


def test_withdraw_nothing_reverts(gc):
    assert gc.write_expect_fail("withdraw")


def test_report_preconditions_fail_closed(gc):
    # Every guard below reverts before any web/LLM work and records nothing.
    target = synthetic_target(6)
    assert tx_execution_succeeded(_register(gc, target))

    assert gc.write_expect_fail("submit_signal", args=[target, tx(1)], value=0)  # zero bond
    assert gc.write_expect_fail("submit_signal", args=[target, "0xtx"], value=BOND)  # malformed
    assert gc.write_expect_fail("submit_signal", args=[synthetic_target(7), tx(1)], value=BOND)

    inactive = synthetic_target(12)
    assert tx_execution_succeeded(_register(gc, inactive, active=False))
    assert gc.write_expect_fail("submit_signal", args=[inactive, tx(1)], value=BOND)

    assert gc.read("get_incident_count", [target]) == 0
    assert gc.read("get_incident_count", [inactive]) == 0


def test_set_min_bond_floor_enforced(gc):
    target = synthetic_target(9)
    assert tx_execution_succeeded(_register(gc, target, active=False))
    assert tx_execution_succeeded(gc.write("set_min_bond", args=[target, 500]))
    assert gc.read("get_min_bond", [target]) == 500
    assert gc.write_expect_fail("submit_signal", args=[target, tx(2)], value=499)


def test_payout_guards_without_trip(gc):
    target = synthetic_target(10)
    assert tx_execution_succeeded(_register(gc, target))
    assert gc.write_expect_fail("recover", args=[target])
    assert gc.write_expect_fail("claim_payout", args=[target])
    assert gc.write_expect_fail("dispute_trip", args=[target], value=1000)
    assert gc.write_expect_fail("resolve_dispute", args=[target])
    assert gc.read("get_state", [target]) == STATE_ARMED


def test_drill_rejects_unbound_bodies(gc):
    target = synthetic_target(13)
    assert tx_execution_succeeded(_register(gc, target))
    assert gc.write_expect_fail(
        "simulate_signal", args=[target, tx(3), "primary drain body", "secondary drain body"]
    )


def test_live_feeds_reject_evidence_about_another_address(gc):
    # Validators fetch both public explorers for a real mainnet transaction. The
    # transaction exists, but it does not touch this target, so every validator
    # must classify the evidence as unbound and the report must revert with the
    # bond untouched.
    target = synthetic_target(14)
    assert tx_execution_succeeded(_register(gc, target))
    before_total = gc.read("get_total_deposited")
    assert gc.write_expect_fail("submit_signal", args=[target, MAINNET_TX], value=BOND)
    assert gc.read("get_incident_count", [target]) == 0
    assert gc.read("is_incident_processed", [target, MAINNET_TX]) is False
    assert gc.read("get_total_deposited") == before_total


def test_nondet_consensus_block_executes(gc):
    # Drives the full run_nondet path across all validators through a drill. With
    # no provider reachable the round reverts ERR_ADJUDICATION_FAILED; with one it
    # returns a verdict. Either way the drill must not settle anything.
    target = synthetic_target(8)
    assert tx_execution_succeeded(_register(gc, target, threshold=500))
    body = bound_body(target, tx(4), "drain")
    try:
        gc.write("simulate_signal", args=[target, tx(4), body, body])
    except Exception:
        pass
    assert gc.read("get_state", [target]) == STATE_ARMED
    assert gc.read("get_incident_count", [target]) == 0
    assert gc.read("get_payout_status", [target]) == PAYOUT_NONE
    assert gc.read("is_incident_processed", [target, tx(4)]) is False


# --- LLM-dependent adjudication (requires a configured provider) ---------------


@requires_llm
def test_drill_returns_critical_verdict_without_settling(gc):
    target = synthetic_target(20)
    assert tx_execution_succeeded(_register(gc, target, threshold=500, bounty=700))
    assert tx_execution_succeeded(gc.write("deposit", args=[target], value=1000))

    h = tx(20)
    a = bound_body(target, h, "tvl_drop_bps 9200, flash-loan reentrancy draining the pool")
    b = bound_body(target, h, "price_deviation_bps 8800, abnormal drain confirmed")
    assert tx_execution_succeeded(gc.write("simulate_signal", args=[target, h, a, b]))

    assert gc.read("get_last_drill_tier", [target]) == TIER_CRITICAL_BREACH
    assert gc.read("get_state", [target]) == STATE_ARMED
    assert gc.read("get_vault_escrow", [target]) == 1000
    assert gc.read("get_payout_status", [target]) == PAYOUT_NONE


@requires_llm
def test_live_bound_report_is_adjudicated(gc):
    # The target is the real recipient of the mainnet transaction, so the live
    # evidence is bound and the model is consulted. An ordinary 2015 transfer is not
    # an exploit, so the vault must not trip and the key is burned.
    assert tx_execution_succeeded(_register(gc, MAINNET_TX_TO, threshold=500))
    assert tx_execution_succeeded(gc.write("submit_signal", args=[MAINNET_TX_TO, MAINNET_TX], value=BOND))
    assert gc.read("get_incident_count", [MAINNET_TX_TO]) == 1
    assert gc.read("is_incident_processed", [MAINNET_TX_TO, MAINNET_TX]) is True
    assert gc.read("get_tier", [MAINNET_TX_TO]) != TIER_CRITICAL_BREACH
    assert gc.write_expect_fail("submit_signal", args=[MAINNET_TX_TO, MAINNET_TX], value=BOND)
