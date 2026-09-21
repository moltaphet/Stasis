# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }

# Mock target vault: a direct-mode stand-in for an EVM DeFi vault.
# It exposes the same surface the guardian expects on a real target
# (pause() and is_paused()), so cross-contract behavior can be exercised
# without a live EVM chain. Constitution Principle II: pure ASCII, exact
# dependency header, sized storage primitives, no raw containers in storage.

import genlayer as gl
from genlayer import *


class MockVault(gl.contract.Contract):
    # Persistent storage: a single boolean halt flag.
    paused: bool

    def __init__(self) -> None:
        self.paused = False

    @gl.public.write
    def pause(self) -> None:
        # Idempotent: calling pause when already paused leaves it paused.
        self.paused = True

    @gl.public.write
    def unpause(self) -> None:
        # Provided for recovery scenarios and test setup.
        self.paused = False

    @gl.public.view
    def is_paused(self) -> bool:
        return self.paused
