// Isolated genlayer-js integration. All SDK surface is confined to this module and
// defensively typed so an SDK shape drift never breaks the production build.
//
// Method names here are bound to the REAL deployed contract (contracts/stasis_guardian.py):
//   reads:  get_total_deposited, get_locked_escrow, is_registered, get_state,
//           get_vault_escrow, get_tier, get_bounty_amount, get_payout_status,
//           get_last_drill_tier
//   writes: simulate_signal (non-settling drill)
// (There is no get_vault_state / get_telemetry / submit_incident - those names do
// not exist on the contract.)

import { createClient, createAccount, isSuccessful } from "genlayer-js";
import * as chains from "genlayer-js/chains";
import { CHAIN_NAME, GUARDIAN_ADDRESS } from "./config";
import { estimateFeesFromProfile } from "./fees";

type AnyClient = any;

// The chain object is resolved by name and never synthesized: consensus contract
// addresses are part of a chain's identity, so the preview RPC must be reached
// through the preview chain definition (studioDevnet) rather than by editing the
// stable one. The fallback order only keeps the app bootable if a name is typoed.
function resolveChain(): any {
  const bag = chains as Record<string, any>;
  return (
    bag[CHAIN_NAME] ||
    bag.studioDevnet ||
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
  payoutStatus: number | null;
}

// genlayer-js logs failed gen_call reads to console.error before rejecting. A
// failed read is surfaced to the caller as an explicit "unavailable" state, so the
// duplicate SDK log line is silenced for the duration of our own guarded read.
// Every other error passes through.
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
// surface an explicit "unavailable" state; nothing is ever substituted.
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
    let payoutStatus: number | null = null;

    if (target) {
      registered = Boolean(await readRaw(client, "is_registered", [target]));
      if (registered) {
        state = toNum(await readRaw(client, "get_state", [target]));
        vaultEscrow = toNum(await readRaw(client, "get_vault_escrow", [target]));
        bounty = toNum(await readRaw(client, "get_bounty_amount", [target]));
        tier = toNum(await readRaw(client, "get_tier", [target]));
        payoutStatus = toNum(await readRaw(client, "get_payout_status", [target]));
      }
    }

    return { totalDeposited, lockedEscrow, registered, state, vaultEscrow, bounty, tier, payoutStatus };
  });
}

const STATUS_NAMES: Record<number, string> = {
  5: "ACCEPTED",
  6: "UNDETERMINED",
  7: "FINALIZED",
};

// A v0.6 receipt carries no flat status field: it carries a layered lifecycle of
// {state, outcome}, where the outcome ("accepted" / something else) is what
// decides whether consensus actually accepted the transaction. Pre-lifecycle
// receipts still carry the flat status, so both shapes are read.
function statusFromReceipt(receipt: any): string {
  const lifecycle = receipt?.lifecycle;
  if (lifecycle && typeof lifecycle === "object") {
    const state = String(lifecycle.state ?? "").toUpperCase();
    const outcome = String(lifecycle.outcome ?? "").toUpperCase();
    if (!state) return "UNKNOWN";
    if (state === "DECIDED" || state === "FINALIZED") {
      return outcome && outcome !== "ACCEPTED" ? `${state}_${outcome}` : state;
    }
    return state;
  }
  const raw = receipt?.statusName ?? receipt?.status;
  if (typeof raw === "number") return STATUS_NAMES[raw] ?? `status(${raw})`;
  if (raw == null) return "UNKNOWN";
  return String(raw);
}

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

// Fee accounting as three separate numbers. Consensus v0.6 escrows one deposit per
// transaction and refunds the unused part at finalization, so the amount paid up
// front, the amount actually consumed, and the amount returned are all distinct
// and must not be collapsed into a single "cost".
export interface FeeAccounting {
  deposit: number; // wei escrowed at submission
  consumed: number; // wei actually spent on consensus + execution
  refunded: number; // wei returned at finalization
  known: boolean; // false when the receipt carries no fee_accounting block
}

export interface WriteResult {
  txId: string;
  status: string;
  executionResult: string; // FINISHED_WITH_RETURN on a genuinely successful run
  ok: boolean;
  tier: number | null; // null when the chain did not return a readable verdict
  tierLabel: string;
  fees: FeeAccounting;
}

// The execution-result half of the success pair. A receipt that reached a
// terminal-good status may still have failed to run: GenVM reports that as
// FINISHED_WITH_ERROR (or a bare ERROR) while the consensus status stays ACCEPTED.
function executionResultName(receipt: any): string {
  const raw =
    receipt?.txExecutionResultName ??
    receipt?.execution_result ??
    receipt?.consensus_data?.leader_receipt?.[0]?.execution_result;
  return typeof raw === "string" ? raw : "";
}

// Success requires BOTH a terminal-good status and FINISHED_WITH_RETURN. The
// SDK's isSuccessful encodes exactly that pair, so it is the authority; the
// literal rule below is the fallback for a receipt shape the helper cannot read,
// and it deliberately fails closed.
function succeeded(receipt: any, status: string): boolean {
  try {
    if (typeof isSuccessful === "function") return isSuccessful(receipt);
  } catch {
    /* fall through to the rule isSuccessful encodes */
  }
  return /FINAL|ACCEPT/i.test(status) && executionResultName(receipt) === "FINISHED_WITH_RETURN";
}

// Receipt polling budget. The SDK defaults to 10 retries at 3s - thirty seconds -
// which a nondet round does not finish in: the transaction is still ACCEPTED when
// the poll gives up, and the caller reads a timeout instead of a result. A
// genuinely failed transaction still returns as soon as it reaches a terminal
// state, so this is a ceiling, not a wait.
const RECEIPT_POLL_INTERVAL_MS = 4000;
const RECEIPT_POLL_RETRIES = 75; // ~5 minutes

// A finalized receipt settles the fee deposit and reports what was actually used.
// The deposit, the consumed part and the refund are three different numbers and
// must not be collapsed into one "cost": the deposit is escrowed up front, only
// the consumed part is spent, and the remainder comes back at finalization.
function feeAccounting(receipt: any): FeeAccounting {
  const fees = receipt?.fees ?? receipt?.data?.fees;
  if (fees == null) return { deposit: 0, consumed: 0, refunded: 0, known: false };

  const deposit = toNum(fees.deposit);
  const consumedBlock = fees.consumed ?? {};
  const locked = fees.locked ?? {};

  // Consensus work is billed in time units at the price locked in at submission;
  // execution, storage and messages are billed directly in wei.
  const timeUnits = toNum(consumedBlock.leaderTimeunitsUsed) + toNum(consumedBlock.validatorTimeunitsUsed);
  const consumed =
    toNum(consumedBlock.executionConsumed) +
    toNum(consumedBlock.storageFeeUsed) +
    toNum(consumedBlock.messageFeesConsumed) +
    timeUnits * toNum(locked.genPerTimeUnit);

  if (deposit === 0 && consumed === 0) {
    return { deposit: 0, consumed: 0, refunded: 0, known: false };
  }
  return {
    deposit,
    consumed,
    refunded: Math.max(0, deposit - consumed),
    known: true,
  };
}

export interface DrillPayload {
  payloadA: string; // primary feed body (JSON object text)
  payloadB: string; // secondary feed body (JSON object text)
}

// A fresh, well-formed transaction hash (0x + 64 hex digits) for each drill.
export function randomTxHash(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// The guardian only accepts evidence that names the target vault and the
// reported transaction, so each scenario body is bound to both before sending.
export function bindEvidence(body: string, target: string, txHash: string): string {
  let fields: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fields = parsed;
    else fields = { data: parsed };
  } catch {
    fields = { data: body };
  }
  return JSON.stringify({ vault: target, tx_hash: txHash, ...fields });
}

// The u32 verdict a finalized receipt returned, or null when the receipt shape
// carries none. Never substitutes an expected value.
function verdictFromReceipt(receipt: any): number | null {
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
  return null;
}

// Broadcast a non-settling drill: validators adjudicate the supplied bodies and
// return a verdict, but the guardian never trips, pays, or burns a replay key.
export async function runDrill(
  session: ReviewerSession,
  target: string,
  payload: DrillPayload,
): Promise<WriteResult> {
  if (!target) throw new Error("NEXT_PUBLIC_TARGET_VAULT_ADDRESS is not set");
  const txHash = randomTxHash();
  const call: any = {
    address: requireAddress(),
    functionName: "simulate_signal",
    args: [
      target,
      txHash,
      bindEvidence(payload.payloadA, target, txHash),
      bindEvidence(payload.payloadB, target, txHash),
    ],
  };

  // Fees are estimated from the measured profile, and the estimate the SDK hands
  // back is submitted unchanged. Nothing is computed here: the SDK reads the
  // network's live prices and caps at estimate time.
  const feeAttachment = await estimateFeesFromProfile(session.client, "simulate_signal");
  if (feeAttachment) call.fees = feeAttachment;

  const txId = await session.client.writeContract(call);

  let status = "PENDING";
  let executionResult = "";
  let ok = false;
  let tier: number | null = null;
  let fees: FeeAccounting = { deposit: 0, consumed: 0, refunded: 0, known: false };
  try {
    // Wait for finalization, not acceptance. In v0.6 the deprecated `status`
    // argument is ignored and the call returns at ACCEPTED, before the protocol
    // settles the fee deposit - a receipt taken there reports executionConsumed
    // as 0, so the fee breakdown would read as free. `waitUntil` is the v0.6
    // spelling, and "finalized" is the point at which the refund exists.
    const receipt: any = await session.client.waitForTransactionReceipt({
      hash: txId,
      waitUntil: "finalized",
      interval: RECEIPT_POLL_INTERVAL_MS,
      retries: RECEIPT_POLL_RETRIES,
    });
    status = statusFromReceipt(receipt);
    executionResult = executionResultName(receipt);
    ok = succeeded(receipt, status);
    fees = feeAccounting(receipt);
    if (ok) {
      tier = verdictFromReceipt(receipt);
      if (tier === null) {
        // The contract stores the last drill verdict; read it back as the source
        // of truth when the receipt shape does not carry the return value.
        try {
          tier = toNum(
            await withQuietRpc(() => readRaw(createReadonlyClient(), "get_last_drill_tier", [target])),
          );
        } catch {
          tier = null;
        }
      }
    }
  } catch (err) {
    console.warn("[stasis] receipt wait failed:", err);
    status = "RECEIPT_TIMEOUT";
  }

  return {
    txId: String(txId),
    status,
    executionResult,
    ok,
    tier,
    tierLabel: tier === null ? "UNREADABLE" : TIER_LABEL[tier] ?? "UNKNOWN",
    fees,
  };
}
