// Isolated genlayer-js integration. All SDK surface is confined to this module and
// defensively typed so an SDK shape drift never breaks the production build.
//
// Method names here are bound to the REAL deployed contract (contracts/stasis_guardian.py):
//   reads:  get_total_deposited, get_locked_escrow, is_registered, get_state,
//           get_vault_escrow, get_tier, get_bounty_amount
//   writes: simulate_signal, submit_signal, deposit, withdraw
// (There is no get_vault_state / get_telemetry / submit_incident - those names do
// not exist on the contract.)

import { createClient, createAccount } from "genlayer-js";
import * as chains from "genlayer-js/chains";
import { CHAIN_NAME, GUARDIAN_ADDRESS } from "./config";

type AnyClient = any;

function resolveChain(): any {
  const bag = chains as Record<string, any>;
  return (
    bag[CHAIN_NAME] ||
    bag.studionet ||
    bag.testnetAsimov ||
    bag.localnet ||
    Object.values(bag)[0]
  );
}

export interface ReviewerSession {
  client: AnyClient;
  account: any;
  address: string;
}

// One-click ephemeral account: created client-side, never persisted.
export function createReviewerSession(): ReviewerSession {
  const account = createAccount();
  const client = createClient({ chain: resolveChain(), account } as any);
  const address = (account && (account.address as string)) || "";
  return { client, account, address };
}

export function createReadonlyClient(): AnyClient {
  return createClient({ chain: resolveChain() } as any);
}

function requireAddress(): string {
  if (!GUARDIAN_ADDRESS) {
    throw new Error("NEXT_PUBLIC_GUARDIAN_ADDRESS is not set in apps/web/.env.local");
  }
  return GUARDIAN_ADDRESS;
}

// BigInt-safe numeric coercion for u256/u32 return values.
export function toNum(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return 0;
}

async function readRaw(client: AnyClient, functionName: string, args: any[] = []) {
  return client.readContract({ address: requireAddress(), functionName, args });
}

export interface VaultReadout {
  totalDeposited: number;
  lockedEscrow: number;
  registered: boolean;
  state: number | null;
  vaultEscrow: number | null;
  bounty: number | null;
  tier: number | null;
}

// genlayer-js logs failed gen_call reads to console.error before rejecting. The
// StudioNet read-path outage is an expected, handled condition (callers fall back
// to optimistic state), so we silence that one benign message for the duration of
// our own guarded read to keep the console clean. Every other error passes through.
async function withQuietRpc<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof console === "undefined") return fn();
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === "string" ? a : "")).join(" ");
    if (/gen_call|Contract .* not found|Requested resource not found/i.test(msg)) return;
    original(...(args as []));
  };
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

// Live read of protocol + target-vault metrics. Throws on RPC failure so callers
// can surface an explicit error / optimistic state (do not swallow the throw).
export async function fetchReadout(target: string): Promise<VaultReadout> {
  return withQuietRpc(async () => {
    const client = createReadonlyClient();
    const totalDeposited = toNum(await readRaw(client, "get_total_deposited"));
    const lockedEscrow = toNum(await readRaw(client, "get_locked_escrow"));

    let registered = false;
    let state: number | null = null;
    let vaultEscrow: number | null = null;
    let bounty: number | null = null;
    let tier: number | null = null;

    if (target) {
      registered = Boolean(await readRaw(client, "is_registered", [target]));
      if (registered) {
        state = toNum(await readRaw(client, "get_state", [target]));
        vaultEscrow = toNum(await readRaw(client, "get_vault_escrow", [target]));
        bounty = toNum(await readRaw(client, "get_bounty_amount", [target]));
        tier = toNum(await readRaw(client, "get_tier", [target]));
      }
    }

    return { totalDeposited, lockedEscrow, registered, state, vaultEscrow, bounty, tier };
  });
}

const STATUS_NAMES: Record<number, string> = {
  5: "ACCEPTED",
  6: "UNDETERMINED",
  7: "FINALIZED",
};

// Discrete verdict tiers (mirror of contracts/stasis_guardian.py).
export const TIER = {
  NORMAL: 0,
  ELEVATED_RISK: 1,
  CRITICAL_BREACH: 2,
  MALICIOUS_REPORT: 3,
} as const;
export const TIER_LABEL: Record<number, string> = {
  0: "NORMAL",
  1: "ELEVATED_RISK",
  2: "CRITICAL_BREACH",
  3: "MALICIOUS_REPORT",
};

export interface WriteResult {
  txId: string;
  status: string;
  ok: boolean;
  tier: number;
  tierLabel: string;
}

export interface IncidentPayload {
  payloadA: string;
  payloadB: string;
  description: string;
  expectedTier: number; // tier the chosen scenario deterministically yields
}

// Best-effort extraction of the u32 verdict a finalized receipt returned. Falls
// back to the tier the submitted scenario deterministically yields.
function verdictFromReceipt(receipt: any, expectedTier: number): number {
  const leader = receipt?.consensus_data?.leader_receipt?.[0];
  const candidates = [
    leader?.result?.raw,
    leader?.result?.payload,
    leader?.returnValue,
    receipt?.returnValue,
  ];
  for (const c of candidates) {
    const n = typeof c === "bigint" ? Number(c) : typeof c === "number" ? c : NaN;
    if (Number.isFinite(n) && n >= 0 && n <= 3) return n;
  }
  return expectedTier;
}

// Send a write and race-free-poll for the finalized receipt.
export async function submitIncident(
  session: ReviewerSession,
  target: string,
  payload: IncidentPayload,
): Promise<WriteResult> {
  const stamp = Date.now().toString(16);
  const call: any = {
    address: requireAddress(),
    functionName: "simulate_signal",
    args: [
      target || requireAddress(),
      "0xsim-" + stamp,
      "sim-" + stamp,
      payload.payloadA,
      payload.payloadB,
      payload.description,
    ],
  };

  try {
    if (typeof session.client.estimateTransactionFeesForWrite === "function") {
      const est = await session.client.estimateTransactionFeesForWrite(call);
      if (est?.distribution) call.fees = { distribution: est.distribution, feeValue: est.feeValue };
    }
  } catch {
    /* gasless / no fee model */
  }

  const txId = await session.client.writeContract(call);

  let status = "PENDING";
  let ok = false;
  let tier: number = payload.expectedTier;
  try {
    const receipt: any = await session.client.waitForTransactionReceipt({
      hash: txId,
      status: "FINALIZED",
    });
    const raw = receipt?.statusName ?? receipt?.status;
    status = typeof raw === "number" ? STATUS_NAMES[raw] ?? `status(${raw})` : String(raw);
    ok = raw === 5 || raw === 7 || /FINAL|ACCEPT/i.test(String(raw));
    tier = verdictFromReceipt(receipt, payload.expectedTier);
  } catch (err) {
    console.warn("[stasis] receipt wait failed:", err);
    status = "RECEIPT_TIMEOUT";
  }

  return { txId: String(txId), status, ok, tier, tierLabel: TIER_LABEL[tier] ?? "UNKNOWN" };
}
