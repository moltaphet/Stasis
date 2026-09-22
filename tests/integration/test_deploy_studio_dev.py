"""Deploy the Stasis protocol to a live network and register the reference target.

Opt-in: this is a deployment step, not a test, so it stays out of the normal
suite unless explicitly requested. It is a pytest module because gltest only
populates its network registry from the CLI at startup, so a standalone script
cannot resolve a network name.

    STASIS_DEPLOY=1 STASIS_DEPLOYER_KEY_FILE=~/.genlayer/<owner>.key \
        gltest tests/integration/test_deploy_studio_dev.py -v -s --network studio_devnet

The deployer becomes the guardian's registry owner and the reference vault's
admin, so it must be a key that is kept: gltest's own default account is a fresh
random key per run, which would leave the deployment with an owner nobody holds.
STASIS_DEPLOYER_KEY_FILE names a file containing the hex private key; it is read
here and never written to the repository.

Prints the deployed addresses, which then go into apps/web/.env.local and
apps/web/.env.production. Re-run it after any contract change: the guardian
address is only as good as the code deployed at it.
"""

import json
import os

import pytest

from gltest import get_contract_factory
from gltest.clients import get_gl_client
from genlayer_py import create_account

from conftest import (
    PRIMARY_FEED,
    SECONDARY_FEED,
    WAIT_INTERVAL_MS,
    WAIT_RETRIES,
    live_fees,
)

DEPLOY = os.environ.get("STASIS_DEPLOY") == "1"
pytestmark = pytest.mark.skipif(
    not DEPLOY,
    reason="deployment step; set STASIS_DEPLOY=1 to deploy and register",
)

# Registration parameters for the reference target. The feeds are the two public
# block explorers from conftest; the cooldown doubles as the bounty challenge
# window, so it is non-zero to leave room for a dispute.
THRESHOLD_BPS = 500
BOUNTY_AMOUNT = 0
COOLDOWN_SECONDS = 3600


def _deployer():
    path = os.environ.get("STASIS_DEPLOYER_KEY_FILE", "")
    if not path:
        pytest.fail("set STASIS_DEPLOYER_KEY_FILE to a file holding the owner's private key")
    with open(os.path.expanduser(path)) as fh:
        return create_account(fh.read().strip())


def test_deploy_and_register():
    client = get_gl_client()
    account = _deployer()

    # Wait for finalization, not gltest's ACCEPTED default: the deploy's fee
    # observation is recorded from this receipt, and a pre-settlement receipt
    # reports executionConsumed as 0, which would enter the profile as a free
    # deploy. Finalization is also the point at which the address is durable.
    guardian = get_contract_factory(contract_file_path="stasis_guardian.py").deploy(
        args=[],
        account=account,
        fees=live_fees(),
        wait_until="finalized",
        wait_interval=WAIT_INTERVAL_MS,
        wait_retries=WAIT_RETRIES,
    )
    # The reference vault only accepts pause/unpause from the guardian it is
    # bound to at construction.
    vault = get_contract_factory(contract_file_path="reference_vault.py").deploy(
        args=[guardian.address],
        account=account,
        fees=live_fees(),
        wait_until="finalized",
        wait_interval=WAIT_INTERVAL_MS,
        wait_retries=WAIT_RETRIES,
    )

    # Registration is a write on the guardian, and the guardian is Address-keyed:
    # it is also the first proof that the deployed bytecode carries the calldata
    # normalization the writes depend on.
    tx = client.write_contract(
        address=guardian.address,
        function_name="register_vault",
        account=account,
        args=[
            vault.address,
            PRIMARY_FEED,
            SECONDARY_FEED,
            THRESHOLD_BPS,
            BOUNTY_AMOUNT,
            COOLDOWN_SECONDS,
            True,
        ],
        value=0,
        fees=live_fees(),
    )
    receipt = client.wait_for_transaction_receipt(
        transaction_hash=tx,
        wait_until="finalized",
        interval=WAIT_INTERVAL_MS,
        retries=WAIT_RETRIES,
    )

    registered = client.read_contract(
        address=guardian.address,
        function_name="is_registered",
        args=[vault.address],
    )
    state = client.read_contract(
        address=guardian.address,
        function_name="get_state",
        args=[vault.address],
    )
    exec_result = dict(receipt).get("txExecutionResultName")

    print("\n=== studio-dev deployment ===")
    print(f"deployer         : {account.address}")
    print(f"guardian         : {guardian.address}")
    print(f"reference_vault  : {vault.address}")
    print(f"register result  : {exec_result}")
    print(f"is_registered    : {registered}")
    print(f"get_state        : {state}")
    print("=== end ===\n")

    # A tracked record of what is actually deployed where. The guardian address is
    # only meaningful alongside the code deployed at it, so the record is written
    # by the deploy step rather than maintained by hand.
    os.makedirs("deployments", exist_ok=True)
    with open("deployments/studio-dev.json", "w") as fh:
        json.dump(
            {
                "network": "studio_devnet",
                "chainId": 61997,
                "rpc": "https://studio-dev.genlayer.com/api",
                "explorer": "https://explorer-studio-dev.genlayer.com",
                "consensus": "v0.6 (Studio v0.123 RC) preview",
                "deployer": account.address,
                "registryOwner": account.address,
                "guardian": guardian.address,
                "targetVault": vault.address,
                "targetVaultRegistered": bool(registered),
                "primaryFeed": PRIMARY_FEED,
                "secondaryFeed": SECONDARY_FEED,
            },
            fh,
            indent=2,
        )
        fh.write("\n")

    assert exec_result == "FINISHED_WITH_RETURN", "registration did not execute cleanly"
    assert registered is True, "registration was accepted but the vault is not registered"
