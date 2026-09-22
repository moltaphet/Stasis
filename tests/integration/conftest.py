"""Fixtures for Stasis Protocol integration tests (full consensus, real network).

Runs against a live GenLayer network - GLSim on localnet by default:

    glsim --port 4000 --validators 5 --no-browser
    NO_PROXY=127.0.0.1,localhost gltest tests/integration/ -v -s --network localnet

Unlike direct mode, every write goes through real leader + validator consensus.

GLSim serves a stub contract-schema endpoint, so instead of gltest's schema-bound
Contract wrapper we drive the deployed contract through the genlayer_py client by
function name (exactly how the CLI does). Web and LLM calls are real (not mocked),
so adjudication tests that need a working LLM verdict are skipped unless
STASIS_INTEGRATION_LLM=1.
"""

import os
from typing import Any

import pytest

from gltest import get_contract_factory
from gltest.clients import get_gl_client
from gltest.accounts import get_default_account
from gltest.fees import maybe_record_fee_observation

# Enum mirrors (u32 values from contracts/stasis_guardian.py).
TIER_NORMAL = 0
TIER_ELEVATED_RISK = 1
TIER_CRITICAL_BREACH = 2
TIER_MALICIOUS_REPORT = 3

STATE_ARMED = 0
STATE_TRIPPED = 1
STATE_RESTORED = 2
STATE_RATE_LIMITED = 3

# Two independent, public, keyless block explorers. The guardian substitutes the
# reported transaction hash for {tx_hash}, so validators fetch evidence about
# exactly that transaction.
PRIMARY_FEED = "https://eth.blockscout.com/api/v2/transactions/{tx_hash}"
SECONDARY_FEED = "https://api.blockchair.com/ethereum/dashboards/transaction/{tx_hash}"

PAYOUT_NONE = 0
PAYOUT_PENDING = 1
PAYOUT_DISPUTED = 2
PAYOUT_SETTLED = 3
PAYOUT_OVERTURNED = 4

# A real Ethereum mainnet transaction and its recipient, used to exercise the live
# feeds end to end.
MAINNET_TX = "0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060"
MAINNET_TX_TO = "0x5df9b87991262f6ba471f09758cde1c0fc1de734"


def tx(n: int) -> str:
    """A well-formed transaction hash: 0x + 64 hex digits."""
    return "0x" + format(n, "064x")


def bound_body(target: str, tx_hash: str, note: str) -> str:
    """A drill feed body that references the target and the reported tx."""
    return '{"to": "' + target + '", "hash": "' + tx_hash + '", "note": "' + note + '"}'

LLM_AVAILABLE = os.environ.get("STASIS_INTEGRATION_LLM") == "1"
requires_llm = pytest.mark.skipif(
    not LLM_AVAILABLE,
    reason="set STASIS_INTEGRATION_LLM=1 with an LLM provider configured to run adjudication tests",
)


# --- Consensus v0.6 fee submission -------------------------------------------
# A fee-charging network rejects any deploy or write that does not carry a
# FeesDistribution and its quoted fee value: the envelope fails with
# FeesDistributionMissing or FeeValueMustBeNonZero before the contract is ever
# run, which reads as a contract error but is a submission error.
#
# The preset below is a floor, not a price. The SDK re-reads the network's current
# prices and caps at signing time and returns the distribution and feeValue to
# submit unchanged; unused budget is refunded at finalization, so allocating
# generously here costs only a temporary escrow. Gaslessness is detected from the
# estimate result, never from the network's name.
FEE_ESTIMATE_OPTIONS: Any = {
    "leaderTimeunitsAllocation": 100,
    "validatorTimeunitsAllocation": 200,
    "totalMessageFees": 0,
    "rotations": [1],
}

_fee_estimate_cache: dict = {}


def live_fees() -> Any:
    """Live-policy transaction fees, or {} on a gasless network.

    Cached for the session: the estimate is derived from network policy, not from
    the transaction, so it does not need re-asking per write.
    """
    if "value" not in _fee_estimate_cache:
        try:
            _fee_estimate_cache["value"] = (
                get_gl_client().estimate_transaction_fees(FEE_ESTIMATE_OPTIONS) or {}
            )
        except Exception:
            # A gasless network answers nothing useful here; submitting no fees is
            # the correct thing to do there.
            _fee_estimate_cache["value"] = {}
    return _fee_estimate_cache["value"]


def synthetic_target(index: int) -> str:
    """A distinct, non-zero 20-byte address to use as a target vault per test."""
    return "0x" + f"{index + 1:040x}"


# Receipt polling budget. genlayer-py defaults to 10 retries at 3s and gltest
# raises it to 50 - thirty and one hundred fifty seconds respectively - neither of
# which a non-deterministic round reliably finishes inside when the network is
# loaded. The wait then raises GenLayerError while the transaction is still
# ACCEPTED or DECIDED, which reads as a contract failure but is a poll that gave
# up. A transaction that genuinely fails still returns as soon as it reaches a
# terminal state, so this is a ceiling, not a delay.
WAIT_INTERVAL_MS = 4000
WAIT_RETRIES = 90  # ~6 minutes


class GuardianClient:
    """Thin schema-free wrapper over a deployed guardian, driven by function name."""

    def __init__(self, address, client, account):
        self.address = address
        self.client = client
        self.account = account

    def read(self, fn, args=None):
        return self.client.read_contract(
            address=self.address, function_name=fn, args=args or []
        )

    def write(self, fn, args=None, value=0):
        tx_hash = self.client.write_contract(
            address=self.address,
            function_name=fn,
            account=self.account,
            args=args or [],
            value=value,
            fees=live_fees(),
        )
        # genlayer-py 0.19 replaced the `status=` argument with `wait_until`.
        # Wait for finalization, not the stored decision: a decided receipt reports
        # executionConsumed as 0, because the protocol only settles the deposit and
        # computes the refund when the transaction finalizes. Profiling off a
        # decided receipt therefore measures every method as free.
        receipt = self.client.wait_for_transaction_receipt(
            transaction_hash=tx_hash,
            wait_until="finalized",
            interval=WAIT_INTERVAL_MS,
            retries=WAIT_RETRIES,
        )
        # gltest records per-method fee observations only from its schema-bound
        # Contract wrapper, and that wrapper cannot be built against Studio Devnet:
        # the network serves no contract schema, so the factory's lookup fails and
        # this suite drives the deployed contract by function name instead. Feeding
        # the same receipt to the same public helper keeps the generated profile
        # equivalent to the one the wrapper would have produced.
        maybe_record_fee_observation(kind="method", method_name=fn, receipt=receipt)
        return receipt

    def write_expect_fail(self, fn, args=None, value=0) -> bool:
        """True if the transaction reverts - either by raising or a failed receipt."""
        from gltest.assertions import tx_execution_failed

        try:
            receipt = self.write(fn, args=args, value=value)
        except Exception:
            return True
        return tx_execution_failed(receipt)


@pytest.fixture(scope="module")
def gc():
    """Deploy the guardian once per module and wrap it for schema-free calls."""
    factory = get_contract_factory(contract_file_path="stasis_guardian.py")
    contract = factory.deploy(
        args=[],
        fees=live_fees(),
        # gltest defaults the deploy wait to ACCEPTED and records the deploy's fee
        # observation from that receipt. A receipt taken before finalization reports
        # executionConsumed as 0, so the profile's deploy entry measured every
        # deploy as free. Wait for finalization - the point at which the protocol
        # settles the deposit - so the observation is taken from a settled receipt.
        wait_until="finalized",
        wait_interval=WAIT_INTERVAL_MS,
        wait_retries=WAIT_RETRIES,
    )
    return GuardianClient(contract.address, get_gl_client(), get_default_account())
