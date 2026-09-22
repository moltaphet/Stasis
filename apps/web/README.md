# Stasis Protocol - Dashboard

Next.js dashboard for the Stasis Guardian autonomous circuit breaker.

## Features

- **Scenario drills**: each scenario plays an off-chain preview of what a live report
  with that evidence does and, in Reviewer Mode, broadcasts a real non-settling drill
  (`simulate_signal`). The drill binds both feed bodies to the reference vault and a
  fresh tx hash, is adjudicated by validator consensus, and returns a verdict without
  touching vault state or escrow. Includes a prompt-injection spoof preset.
- **Ephemeral Reviewer Account**: one-click throwaway account via genlayer-js
  `createAccount()` - zero wallet friction for judges.
- **Strict EIP-6963 wallet selection**: selects only `rdns === "io.metamask"`, so
  Phantom cannot hijack MetaMask Snaps and emit spurious RPC `-32601` errors. Snap
  calls are wrapped in try/catch.
- **Chain-only readout**: the Live Chain Readout shows only values read from the
  guardian; when the read path fails it says so and shows no values.

## Setup

```bash
npm install
cp .env.local.example .env.local   # guardian + target vault addresses, chain
npm run dev                        # http://localhost:3000
npm run build                      # production build
```

The UI renders and builds without a deployed contract; reads and drills activate
once `NEXT_PUBLIC_GUARDIAN_ADDRESS` and `NEXT_PUBLIC_TARGET_VAULT_ADDRESS` are set
(values for the reference deployment are in `deployments/studio-dev.json`).
