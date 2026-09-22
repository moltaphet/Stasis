# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }

# Reference target vault: the minimal pause surface a vault exposes to the Stasis
# Guardian (pause(), unpause(), is_paused()), with the authorization a production
# vault must enforce - only the guardian bound at construction may pause or
# unpause it. It is the registered demo target on the reference deployment.
# Constitution Principle II: pure ASCII, exact dependency header, sized storage
# primitives, no raw containers in storage.

import genlayer as gl

Address = gl.Address


class ReferenceVault(gl.contract.Contract):
    guardian: Address
    paused: bool

    def __init__(self, guardian: Address) -> None:
        guardian = guardian if isinstance(guardian, Address) else Address(guardian)
        if guardian == Address(bytes(20)):
            raise gl.vm.UserError("[EXPECTED] ERR_ZERO_ADDRESS: guardian must be non-zero")
        self.guardian = guardian
        self.paused = False

    def _require_guardian(self) -> None:
        if gl.message.sender_address != self.guardian:
            raise gl.vm.UserError("[EXPECTED] ERR_NOT_GUARDIAN: only the guardian may do this")

    @gl.public.write
    def pause(self) -> None:
        # Idempotent: calling pause when already paused leaves it paused.
        self._require_guardian()
        self.paused = True

    @gl.public.write
    def unpause(self) -> None:
        self._require_guardian()
        self.paused = False

    @gl.public.view
    def is_paused(self) -> bool:
        return self.paused

    @gl.public.view
    def get_guardian(self) -> Address:
        return self.guardian
