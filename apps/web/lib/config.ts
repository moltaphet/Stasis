// Static configuration and enum mirrors for the Stasis Guardian contract.
// Values mirror contracts/stasis_guardian.py exactly (pure ASCII).

export const GUARDIAN_ADDRESS =
  process.env.NEXT_PUBLIC_GUARDIAN_ADDRESS || "";

// The registered reference target vault (contracts/reference_vault.py) that the
// dashboard reads and runs drills against.
export const TARGET_VAULT_ADDRESS =
  process.env.NEXT_PUBLIC_TARGET_VAULT_ADDRESS || "";

// Chain selection is resolved by name at runtime against genlayer-js/chains so a
// missing export never breaks the build. Defaults to studioDevnet, the Consensus
// v0.6 / Studio v0.123 release-candidate preview (chain 61997). Use "studionet"
// only for stable Studio: chain identity and consensus contract addresses must
// move together, so never point the stable chain object at the preview RPC.
export const CHAIN_NAME = process.env.NEXT_PUBLIC_GENLAYER_CHAIN || "studioDevnet";

// Studio Devnet is a preview deployment the stable Studio explorer does not
// index, so its blockExplorers is undefined on the chain definition and the
// explorer is configured explicitly here instead.
export const REPO_URL =
  process.env.NEXT_PUBLIC_REPO_URL || "https://github.com/moltaphet/Stasis";

export const EXPLORER_URL =
  process.env.NEXT_PUBLIC_EXPLORER_URL || "https://explorer-studio-dev.genlayer.com";

export const TIER = {
  NORMAL: 0,
  ELEVATED_RISK: 1,
  CRITICAL_BREACH: 2,
  MALICIOUS_REPORT: 3,
} as const;

export const TIER_LABELS: Record<number, string> = {
  0: "NORMAL",
  1: "ELEVATED_RISK",
  2: "CRITICAL_BREACH",
  3: "MALICIOUS_REPORT",
};

export const STATE = {
  ARMED: 0,
  TRIPPED: 1,
  RESTORED: 2,
  RATE_LIMITED: 3,
} as const;

export const STATE_LABELS: Record<number, string> = {
  0: "ARMED",
  1: "TRIPPED",
  2: "RESTORED",
  3: "RATE_LIMITED",
};

export const STATE_COLORS: Record<number, string> = {
  0: "text-armed border-armed",
  1: "text-tripped border-tripped",
  2: "text-restored border-restored",
  3: "text-elevated border-elevated",
};

