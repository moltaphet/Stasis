"""Shared fixtures and helpers for Stasis Protocol direct-mode tests.

The genlayer-test (gltest) pytest plugin supplies the direct_vm, direct_deploy,
and address fixtures. These helpers layer Stasis-specific setup on top and cover
the hardened contract: dual feeds, discrete tiers, native escrow, replay
protection, and the ARMED/TRIPPED/RESTORED/RATE_LIMITED lifecycle.
"""

import json

import pytest

GUARDIAN = "contracts/stasis_guardian.py"
MOCK_VAULT = "contracts/mock_vault.py"

# Discrete anomaly tiers (u32 mirror of contracts/stasis_guardian.py).
TIER_NORMAL = 0
TIER_ELEVATED_RISK = 1
TIER_CRITICAL_BREACH = 2
TIER_MALICIOUS_REPORT = 3

# Vault lifecycle states.
STATE_ARMED = 0
STATE_TRIPPED = 1
STATE_RESTORED = 2
STATE_RATE_LIMITED = 3

PRIMARY_FEED = "https://feed-a.example.com/vault/telemetry"
SECONDARY_FEED = "https://feed-b.example.com/vault/telemetry"


# --- LLM verdict payloads -----------------------------------------------------


def critical_payload(drop_bps: int = 9000) -> str:
    return json.dumps(
        {"is_malicious": True, "is_false_report": False,
         "observed_drop_bps": drop_bps, "reason_code": "drain"}
    )


def benign_payload(drop_bps: int = 40) -> str:
    return json.dumps(
        {"is_malicious": False, "is_false_report": False,
         "observed_drop_bps": drop_bps, "reason_code": "arbitrage"}
    )


def elevated_payload(drop_bps: int = 300) -> str:
    # Malicious but below threshold -> ELEVATED_RISK.
    return json.dumps(
        {"is_malicious": True, "is_false_report": False,
         "observed_drop_bps": drop_bps, "reason_code": "exploit"}
    )


def false_report_payload() -> str:
    # Spoofed report: feeds do not corroborate -> MALICIOUS_REPORT.
    return json.dumps(
        {"is_malicious": False, "is_false_report": True,
         "observed_drop_bps": 0, "reason_code": "spoof"}
    )


# --- Mock registration --------------------------------------------------------


def mock_feeds(direct_vm, status: int = 200, body: str = '{"status": "incident"}') -> None:
    """Mock both independent telemetry feeds (single regex covers a/b)."""
    direct_vm.mock_web(r".*example\.com.*", {"status": status, "body": body})


def mock_analyst(direct_vm, response_json: str) -> None:
    """Mock the LLM analyst for any adjudication prompt."""
    direct_vm.mock_llm(r".*DeFi security analyst.*", response_json)


def mock_bad_analyst(direct_vm) -> None:
    """Mock a malformed (non-JSON) LLM response to exercise [LLM_ERROR] fallback."""
    direct_vm.mock_llm(r".*DeFi security analyst.*", "not json at all")


# --- Action helpers -----------------------------------------------------------


def register(
    guardian,
    target,
    threshold_bps=500,
    bounty_amount=0,
    cooldown_seconds=0,
    active=True,
    primary=PRIMARY_FEED,
    secondary=SECONDARY_FEED,
):
    guardian.register_vault(
        target, primary, secondary, threshold_bps, bounty_amount, cooldown_seconds, active
    )


def deposit(guardian, direct_vm, target, amount):
    prev = direct_vm.value
    direct_vm.value = amount
    try:
        guardian.deposit(target)
    finally:
        direct_vm.value = prev


def submit(guardian, target, tx_hash="0xtx", incident_id="inc-1", description="drain observed"):
    return guardian.submit_signal(target, tx_hash, incident_id, description)


def submit_bonded(guardian, direct_vm, target, bond, tx_hash="0xtx", incident_id="inc-1"):
    prev = direct_vm.value
    direct_vm.value = bond
    try:
        return guardian.submit_signal(target, tx_hash, incident_id, "bonded report")
    finally:
        direct_vm.value = prev


@pytest.fixture
def guardian(direct_vm, direct_deploy, direct_alice):
    """Deploy the guardian with Alice as owner and strict mocks enabled."""
    direct_vm.strict_mocks = True
    direct_vm.sender = direct_alice
    return direct_deploy(GUARDIAN)
