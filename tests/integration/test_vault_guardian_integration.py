"""Guardian -> reference vault integration: a CRITICAL verdict pauses the vault.

Deploys the submitted reference vault (contracts/reference_vault.py) bound to a
freshly deployed guardian, registers it, and drives a bonded live report through
full leader + validator consensus. On a CRITICAL_BREACH the guardian emits a
GenVM internal pause() message on finalization; the vault accepts it only
because the sender is the guardian it was constructed with. The test then reads
the vault itself and requires is_paused to flip from False to True.

Evidence feeds: no public explorer shows an exploit of a freshly deployed vault on
demand, so the two feeds are independent public echo services (Postman Echo and
httpbin) whose response bodies reflect the request URL. The URL carries the
target address, the reported tx hash and the incident telemetry, so both bodies
are bound to the target and the transaction exactly as the guardian requires,
while validators still fetch them over the network and run the real LLM
adjudication. The trip path needs a real verdict, so it is gated on
STASIS_INTEGRATION_LLM=1 like the other adjudication tests.

    STASIS_INTEGRATION_LLM=1 gltest tests/integration/test_vault_guardian_integration.py \\
        -v -s --network studio_devnet
"""

import time

import pytest

from gltest import get_contract_factory
from gltest.assertions import tx_execution_succeeded

from conftest import (
    PAYOUT_PENDING,
    STATE_ARMED,
    STATE_TRIPPED,
    TIER_CRITICAL_BREACH,
    WAIT_INTERVAL_MS,
    WAIT_RETRIES,
    live_fees,
    requires_llm,
    tx,
)

BOND = 10
THRESHOLD_BPS = 500
COOLDOWN_SECONDS = 3600

# Incident telemetry reflected by both echo feeds. The two services are run by
# different operators, so the guardian's independence check is meaningful.
_TELEMETRY = (
    "event=flash_loan_reentrancy_drain"
    "&tvl_before_usd=1850000&tvl_after_usd=121000&tvl_drop_bps=9346"
    "&status=active_exploit"
)

# The pause is an internal message emitted on the guardian transaction's
# finalization, so it lands in a later transaction. Poll the vault for it.
PAUSE_POLL_SECONDS = 6
PAUSE_POLL_ATTEMPTS = 60  # ~6 minutes


def _feeds(vault_hex: str):
    v = vault_hex.lower()
    primary = "https://postman-echo.com/get?tx={tx_hash}&vault=" + v + "&" + _TELEMETRY
    secondary = "https://httpbin.org/anything/{tx_hash}?vault=" + v + "&" + _TELEMETRY
    return primary, secondary


def _deploy_reference_vault(guardian_address):
    return get_contract_factory(contract_file_path="reference_vault.py").deploy(
        args=[guardian_address],
        fees=live_fees(),
        wait_until="finalized",
        wait_interval=WAIT_INTERVAL_MS,
        wait_retries=WAIT_RETRIES,
    )


def _vault_read(gc, vault_address, fn):
    return gc.client.read_contract(address=vault_address, function_name=fn, args=[])


def _hex(addr) -> str:
    # Address-typed returns decode as "addr#<hex>" through the schema-free client.
    text = str(addr).lower()
    return "0x" + text.split("#", 1)[1] if text.startswith("addr#") else text


def _leader_diagnostics(receipt) -> str:
    # The leader's revert text and agreed nondet payload, for a readable failure.
    try:
        leader = receipt["consensus_data"]["leader_receipt"][0]
        gv = leader.get("genvm_result", {})
        return "stderr=%r error_code=%r eq_outputs=%r votes=%r" % (
            gv.get("stderr"), gv.get("error_code"), leader.get("eq_outputs"),
            receipt["consensus_data"].get("votes"),
        )
    except Exception as exc:  # pragma: no cover - diagnostics only
        return "no leader receipt (%s)" % exc


@pytest.fixture(scope="module")
def reference_vault(gc):
    vault = _deploy_reference_vault(gc.address)
    primary, secondary = _feeds(str(vault.address))
    assert tx_execution_succeeded(
        gc.write(
            "register_vault",
            args=[vault.address, primary, secondary, THRESHOLD_BPS, 0, COOLDOWN_SECONDS, True],
        )
    )
    return vault


def test_reference_vault_is_bound_to_guardian(gc, reference_vault):
    # Deterministic wiring: the vault trusts exactly this guardian, starts
    # unpaused, is registered and armed, and rejects a pause from anyone else.
    guardian_of_vault = _vault_read(gc, reference_vault.address, "get_guardian")
    assert _hex(guardian_of_vault) == str(gc.address).lower()
    assert _vault_read(gc, reference_vault.address, "is_paused") is False
    assert gc.read("is_registered", [reference_vault.address]) is True
    assert gc.read("get_state", [reference_vault.address]) == STATE_ARMED

    tx_hash = gc.client.write_contract(
        address=reference_vault.address,
        function_name="pause",
        account=gc.account,
        args=[],
        value=0,
        fees=live_fees(),
    )
    receipt = gc.client.wait_for_transaction_receipt(
        transaction_hash=tx_hash,
        wait_until="finalized",
        interval=WAIT_INTERVAL_MS,
        retries=WAIT_RETRIES,
    )
    assert not tx_execution_succeeded(receipt), "a non-guardian pause must revert"
    assert _vault_read(gc, reference_vault.address, "is_paused") is False


@requires_llm
def test_critical_verdict_pauses_reference_vault(gc, reference_vault):
    vault = reference_vault.address
    assert _vault_read(gc, vault, "is_paused") is False

    h = tx(0x57A515)
    receipt = gc.write("submit_signal", args=[vault, h], value=BOND)
    assert tx_execution_succeeded(receipt), _leader_diagnostics(receipt)

    # The guardian side of the trip is final once the report finalizes.
    assert gc.read("get_tier", [vault]) == TIER_CRITICAL_BREACH
    assert gc.read("get_state", [vault]) == STATE_TRIPPED
    assert gc.read("get_payout_status", [vault]) == PAYOUT_PENDING
    assert gc.read("is_incident_processed", [vault, h]) is True

    # The vault side: the emitted pause() must reach and be accepted by the vault.
    paused = False
    for _ in range(PAUSE_POLL_ATTEMPTS):
        paused = _vault_read(gc, vault, "is_paused")
        if paused is True:
            break
        time.sleep(PAUSE_POLL_SECONDS)
    assert paused is True, "guardian tripped but the reference vault was never paused"

    # The trip's challenge window is stamped and recovery cannot run early.
    assert gc.write_expect_fail("recover", args=[vault])
    assert gc.write_expect_fail("configure_vault", args=[vault, THRESHOLD_BPS, 0, 0, True])
    assert gc.read("get_cooldown_seconds", [vault]) == COOLDOWN_SECONDS
