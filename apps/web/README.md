# Stasis Protocol - Dashboard

Next.js dashboard for the Stasis Guardian autonomous circuit breaker.

## Features (Pillar 6)

- **Simulate Exploit Attack**: inject synthetic dual-feed telemetry and watch the
  guardian adjudicate and trip the breaker live (`simulate_signal`). Includes a
  prompt-injection spoof preset that the hardened classifier rejects as
  `MALICIOUS_REPORT`.
- **Ephemeral Reviewer Account**: one-click throwaway account via genlayer-js
  `createAccount()` - zero wallet friction for judges.
- **Strict EIP-6963 wallet selection**: selects only `rdns === "io.metamask"`, so
  Phantom cannot hijack MetaMask Snaps and emit spurious RPC `-32601` errors. Snap
  calls are wrapped in try/catch.
- **Race-free readback**: writes wait for the finalized receipt, then the vault
  status is re-read from chain state.

## Setup

```bash
npm install
cp .env.local.example .env.local   # set NEXT_PUBLIC_GUARDIAN_ADDRESS + chain
npm run dev                        # http://localhost:3000
npm run build                      # production build
```

The UI renders and builds without a deployed contract; reads/writes activate once
`NEXT_PUBLIC_GUARDIAN_ADDRESS` is configured.
