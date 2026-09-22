"""Shared fixtures and helpers for Stasis Protocol direct-mode tests.

The genlayer-test (gltest) pytest plugin supplies the direct_vm, direct_deploy,
and address fixtures. These helpers layer Stasis-specific setup on top and cover
the hardened contract: curated registration, target-bound dual-feed evidence,
discrete tiers, mandatory reporter bonds, the bounty challenge window and dispute
lifecycle, replay protection, and the ARMED/TRIPPED/RESTORED/RATE_LIMITED
lifecycle.

Web and LLM calls are test doubles (direct_vm.mock_web / mock_llm): direct mode
runs the contract in-process with no network.
"""

import json

import pytest

GUARDIAN = "contracts/stasis_guardian.py"
REFERENCE_VAULT = "contracts/reference_vault.py"

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

# Bounty payout lifecycle.
PAYOUT_NONE = 0
PAYOUT_PENDING = 1
PAYOUT_DISPUTED = 2
PAYOUT_SETTLED = 3
PAYOUT_OVERTURNED = 4

# Per-transaction feed templates; the guardian substitutes the reported tx hash.
PRIMARY_FEED = "https://feed-a.example.com/tx/{tx_hash}"
SECONDARY_FEED = "https://feed-b.example.com/tx/{tx_hash}"

DEFAULT_BOND = 10


def tx(n: int = 1) -> str:
    """A well-formed transaction hash: 0x + 64 hex digits."""
    return "0x" + format(n, "064x")


TX = tx(1)


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


# --- Evidence and test doubles ------------------------------------------------


def raw(addr) -> bytes:
    """20 address bytes from a gltest fixture (bytes or an Address wrapper)."""
    return addr.as_bytes if hasattr(addr, "as_bytes") else bytes(addr)


def addr_hex(addr) -> str:
    return "0x" + raw(addr).hex()


def same(a, b) -> bool:
    return raw(a) == raw(b)


def bound_body(target, tx_hash: str = TX, extra: str = "incident") -> str:
    """A feed body that references the target vault and the reported tx."""
    return json.dumps({"to": addr_hex(target), "hash": tx_hash, "note": extra})


def mock_feeds(direct_vm, target=None, tx_hash: str = TX, status: int = 200, body=None) -> None:
    """Mock both independent telemetry feeds (single regex covers a/b)."""
    if body is None:
        body = bound_body(target, tx_hash) if target is not None else ""
    direct_vm.mock_web(r".*example\.com.*", {"status": status, "body": body})


def mock_analyst(direct_vm, response_json: str) -> None:
    """Mock the LLM analyst for any adjudication prompt.

    v0.3 note: the direct-mode mock auto-parses the response once (wasi_mock) and
    the runtime's exec_prompt(response_format="json") parses again, so a JSON
    verdict payload must be DOUBLE-serialized to survive both stages and reach the
    contract as a dict. response_json is already json.dumps(...) of the verdict; we
    wrap it once more here so callers keep passing single-serialized payloads.
    """
    direct_vm.mock_llm(r".*DeFi security analyst.*", json.dumps(response_json))


def mock_bad_analyst(direct_vm) -> None:
    """Mock a malformed (non-JSON) LLM response."""
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


def with_value(direct_vm, amount, fn):
    prev = direct_vm.value
    direct_vm.value = amount
    try:
        return fn()
    finally:
        direct_vm.value = prev


def deposit(guardian, direct_vm, target, amount):
    return with_value(direct_vm, amount, lambda: guardian.deposit(target))


def submit(guardian, direct_vm, target, tx_hash=TX, bond=DEFAULT_BOND):
    return with_value(direct_vm, bond, lambda: guardian.submit_signal(target, tx_hash))


def dispute(guardian, direct_vm, target, bond):
    return with_value(direct_vm, bond, lambda: guardian.dispute_trip(target))


def solvent(guardian, *targets) -> bool:
    """Solvency invariant: total == sum(available vault escrow) + locked escrow."""
    escrow = sum(guardian.get_vault_escrow(t) for t in targets)
    return guardian.get_total_deposited() == escrow + guardian.get_locked_escrow()


@pytest.fixture
def guardian(direct_vm, direct_deploy, direct_alice):
    """Deploy the guardian with Alice as registry owner and strict mocks enabled."""
    direct_vm.strict_mocks = True
    direct_vm.sender = direct_alice
    direct_vm.value = 0
    return direct_deploy(GUARDIAN)
