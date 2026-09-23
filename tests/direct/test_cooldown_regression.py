"""Regression tests: a trip's challenge window is fixed when the trip is recorded.

Steward review: recovery used trip_ts + the *live* cooldown setting, so a vault
admin could shorten the cooldown after a trip and recover early, releasing the
bounty and lifting the pause before the challenge window the reporter and any
disputer relied on had closed. The guardian now (a) freezes the cooldown while a
trip or bounty is in flight and (b) gates recover, claim_payout and dispute_trip
on the payout_unlock_ts stamped at trip time.

Also pins the target-vault wire format: the guardian's pause/unpause reach the
reference vault as GenVM internal messages addressed by method name, emitted on
finalization - not as ABI-encoded EVM calls a GenVM vault never receives.
"""

import pytest

from conftest import (
    PAYOUT_DISPUTED,
    PAYOUT_PENDING,
    PAYOUT_SETTLED,
    REFERENCE_VAULT,
    STATE_RESTORED,
    STATE_TRIPPED,
    TIER_CRITICAL_BREACH,
    TX,
    critical_payload,
    deposit,
    dispute,
    mock_analyst,
    mock_feeds,
    raw,
    register,
    same,
    solvent,
    submit,
)

T0 = "2026-01-01T00:00:00Z"
T0_UNIX = 1767225600
COOLDOWN = 3600
BOUNTY = 700
BOND = 150


def _trip(guardian, direct_vm, target, reporter, bond=BOND):
    mock_feeds(direct_vm, target, TX)
    mock_analyst(direct_vm, critical_payload(drop_bps=9000))
    with direct_vm.prank(reporter):
        assert submit(guardian, direct_vm, target, bond=bond) == TIER_CRITICAL_BREACH
    direct_vm.clear_mocks()


def _tripped(guardian, direct_vm, target, reporter):
    register(guardian, target, threshold_bps=500, bounty_amount=BOUNTY, cooldown_seconds=COOLDOWN)
    deposit(guardian, direct_vm, target, 1000)
    direct_vm.warp(T0)
    _trip(guardian, direct_vm, target, reporter)
    assert guardian.get_state(target) == STATE_TRIPPED
    assert guardian.get_payout(target)["unlock_ts"] == T0_UNIX + COOLDOWN


# --- Cooldown cannot move while a trip or payout is pending -------------------


@pytest.mark.parametrize("new_cooldown", [0, 1, COOLDOWN - 1, COOLDOWN * 2])
def test_cooldown_change_reverts_while_payout_pending(
    guardian, direct_vm, direct_charlie, direct_bob, new_cooldown
):
    _tripped(guardian, direct_vm, direct_charlie, direct_bob)

    with pytest.raises(Exception, match="ERR_PENDING_ACTION_LOCKS_COOLDOWN"):
        guardian.configure_vault(direct_charlie, 500, BOUNTY, new_cooldown, True)

    assert guardian.get_cooldown_seconds(direct_charlie) == COOLDOWN
    assert guardian.get_payout(direct_charlie)["unlock_ts"] == T0_UNIX + COOLDOWN
    assert guardian.get_payout_status(direct_charlie) == PAYOUT_PENDING


def test_cooldown_change_reverts_while_disputed(guardian, direct_vm, direct_charlie, direct_bob):
    _tripped(guardian, direct_vm, direct_charlie, direct_bob)
    dispute(guardian, direct_vm, direct_charlie, BOUNTY + BOND)
    assert guardian.get_payout_status(direct_charlie) == PAYOUT_DISPUTED

    with pytest.raises(Exception, match="ERR_PENDING_ACTION_LOCKS_COOLDOWN"):
        guardian.configure_vault(direct_charlie, 500, BOUNTY, 0, True)
    assert guardian.get_cooldown_seconds(direct_charlie) == COOLDOWN


def test_cooldown_change_reverts_while_tripped_after_claim(
    guardian, direct_vm, direct_charlie, direct_bob
):
    # The bounty is settled by claim_payout, but the vault is still paused: the
    # cooldown still governs recovery and stays frozen until recover().
    _tripped(guardian, direct_vm, direct_charlie, direct_bob)
    direct_vm.warp("2026-01-01T01:00:00Z")
    assert guardian.claim_payout(direct_charlie) == BOUNTY + BOND
    assert guardian.get_payout_status(direct_charlie) == PAYOUT_SETTLED
    assert guardian.get_state(direct_charlie) == STATE_TRIPPED

    with pytest.raises(Exception, match="ERR_PENDING_ACTION_LOCKS_COOLDOWN"):
        guardian.configure_vault(direct_charlie, 500, BOUNTY, 0, True)


def test_other_parameters_stay_adjustable_during_trip(
    guardian, direct_vm, direct_charlie, direct_bob
):
    # Only the cooldown is frozen; re-submitting the same cooldown with new
    # threshold/bounty/active values is allowed and leaves the window intact.
    _tripped(guardian, direct_vm, direct_charlie, direct_bob)
    guardian.configure_vault(direct_charlie, 1200, 50, COOLDOWN, False)

    assert guardian.get_threshold_bps(direct_charlie) == 1200
    assert guardian.get_bounty_amount(direct_charlie) == 50
    assert guardian.is_active(direct_charlie) is False
    payout = guardian.get_payout(direct_charlie)
    assert payout["unlock_ts"] == T0_UNIX + COOLDOWN
    assert payout["bounty"] == BOUNTY  # the in-flight bounty is already stamped


def test_cooldown_unlocks_after_recovery(guardian, direct_vm, direct_charlie, direct_bob):
    _tripped(guardian, direct_vm, direct_charlie, direct_bob)
    direct_vm.warp("2026-01-01T01:00:00Z")
    guardian.recover(direct_charlie)
    assert guardian.get_state(direct_charlie) == STATE_RESTORED

    guardian.configure_vault(direct_charlie, 500, BOUNTY, 60, True)
    assert guardian.get_cooldown_seconds(direct_charlie) == 60


# --- Early release reverts closed ---------------------------------------------


def test_early_recover_and_claim_revert_until_original_unlock(
    guardian, direct_vm, direct_charlie, direct_bob
):
    _tripped(guardian, direct_vm, direct_charlie, direct_bob)

    # Attempt to shorten the window first; it must not take effect.
    with pytest.raises(Exception, match="ERR_PENDING_ACTION_LOCKS_COOLDOWN"):
        guardian.configure_vault(direct_charlie, 500, BOUNTY, 0, True)

    # One second before the stamped unlock: every release path reverts closed.
    direct_vm.warp("2026-01-01T00:59:59Z")
    with pytest.raises(Exception, match="ERR_COOLDOWN_ACTIVE"):
        guardian.recover(direct_charlie)
    with direct_vm.prank(direct_bob):
        with pytest.raises(Exception, match="ERR_PAYOUT_LOCKED"):
            guardian.claim_payout(direct_charlie)
        with pytest.raises(Exception, match="ERR_NOTHING_TO_WITHDRAW"):
            guardian.withdraw()

    # Nothing moved.
    assert guardian.get_state(direct_charlie) == STATE_TRIPPED
    assert guardian.get_payout_status(direct_charlie) == PAYOUT_PENDING
    assert guardian.get_claimable(direct_bob) == 0
    assert guardian.get_locked_escrow() == BOUNTY + BOND
    assert guardian.get_payout(direct_charlie)["unlock_ts"] == T0_UNIX + COOLDOWN
    assert solvent(guardian, direct_charlie)

    # At the stamped unlock, recovery succeeds and releases the bounty.
    direct_vm.warp("2026-01-01T01:00:00Z")
    guardian.recover(direct_charlie)
    assert guardian.get_state(direct_charlie) == STATE_RESTORED
    assert guardian.get_payout_status(direct_charlie) == PAYOUT_SETTLED
    assert guardian.get_claimable(direct_bob) == BOUNTY + BOND
    assert solvent(guardian, direct_charlie)


def test_recover_gates_on_stamp_after_upheld_dispute(
    guardian, direct_vm, direct_charlie, direct_bob
):
    # A dispute that times out upholds the trip; recovery still honors the
    # original stamp rather than any value derived from current settings.
    _tripped(guardian, direct_vm, direct_charlie, direct_bob)
    dispute(guardian, direct_vm, direct_charlie, BOUNTY + BOND)
    direct_vm.warp("2026-01-09T00:00:00Z")  # past the 7-day resolution deadline
    assert guardian.resolve_dispute(direct_charlie) is True
    assert guardian.get_payout(direct_charlie)["unlock_ts"] == T0_UNIX + COOLDOWN
    guardian.recover(direct_charlie)
    assert guardian.get_state(direct_charlie) == STATE_RESTORED


# --- Target vault wire format -------------------------------------------------


def _capture_messages(direct_vm):
    sent = []

    def hook(_vm, request):
        if isinstance(request, dict):
            for op in ("EmitInternalMessage", "PostMessage", "CallContract"):
                if op in request:
                    sent.append((op, request[op]))
        return None  # keep direct mode's no-op semantics

    direct_vm._gl_call_hook = hook
    return sent


def _method(message) -> str:
    # GenVM calldata for a no-argument method call is {"": "<method name>"}: the
    # method is named, not selected by a keccak prefix, and nothing else is sent.
    calldata = message["calldata"]
    assert isinstance(calldata, dict) and list(calldata) == [""], calldata
    return calldata[""]


def test_trip_and_recover_emit_genvm_messages_to_the_vault(
    guardian, direct_vm, direct_charlie, direct_bob
):
    sent = _capture_messages(direct_vm)
    _tripped(guardian, direct_vm, direct_charlie, direct_bob)

    assert [op for op, _ in sent] == ["EmitInternalMessage"], sent
    msg = sent[0][1]
    assert same(msg["address"], direct_charlie)
    assert _method(msg) == "pause"
    assert msg["on"] == "finalized"
    assert msg["value"] == 0

    sent.clear()
    direct_vm.warp("2026-01-01T01:00:00Z")
    guardian.recover(direct_charlie)
    assert [op for op, _ in sent] == ["EmitInternalMessage"], sent
    assert same(sent[0][1]["address"], direct_charlie)
    assert _method(sent[0][1]) == "unpause"
    assert sent[0][1]["on"] == "finalized"


def test_reference_vault_accepts_guardian_message_shape(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    # The reference vault exposes exactly the method names the guardian emits,
    # takes no arguments, and authorizes on the sender (the guardian contract).
    direct_vm.sender = direct_alice
    vault = direct_deploy(REFERENCE_VAULT, direct_bob)  # bob plays the guardian
    assert vault.is_paused() is False
    with direct_vm.prank(direct_bob):
        getattr(vault, "pause")()
    assert vault.is_paused() is True
    with direct_vm.prank(direct_bob):
        getattr(vault, "unpause")()
    assert vault.is_paused() is False
    assert raw(vault.get_guardian()) == raw(direct_bob)
