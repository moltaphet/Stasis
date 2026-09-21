/**
 * verify_frontend_connection.ts
 *
 * End-to-end connectivity check between the Stasis frontend config and the live
 * GenLayer deployment, using the SAME genlayer-js client + chain the browser uses.
 *
 *   1. Read current vault state + escrow balances (BigInt-safe).
 *   2. Create an ephemeral reviewer account and send a test incident (simulate_signal).
 *   3. Poll for the finalized receipt, extract the verdict tier, confirm state.
 *
 * Exit code 0 only if the full read -> write -> poll flow succeeds.
 *
 * Run (genlayer-js lives in apps/web/node_modules):
 *   NODE_PATH="$(pwd)/apps/web/node_modules" npx tsx scripts/verify_frontend_connection.ts
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, createAccount, isSuccessful } from "genlayer-js";
import * as chains from "genlayer-js/chains";

// --- config: read the exact same values the frontend uses --------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = readFileSync(resolve(ROOT, "apps/web/.env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {
    /* fall through to process.env */
  }
  return out;
}

const env = loadEnv();
const GUARDIAN = env.NEXT_PUBLIC_GUARDIAN_ADDRESS || process.env.NEXT_PUBLIC_GUARDIAN_ADDRESS || "";
const TARGET = env.NEXT_PUBLIC_MOCK_VAULT_ADDRESS || process.env.NEXT_PUBLIC_MOCK_VAULT_ADDRESS || "";
// Consensus v0.6 / Studio v0.123 lives on the studioDevnet preview (chain 61997).
// "studionet" is stable Studio only: the chain object carries the consensus
// contract addresses, so the name must match the deployment being addressed.
const CHAIN_NAME = env.NEXT_PUBLIC_GENLAYER_CHAIN || "studioDevnet";

const chainBag = chains as Record<string, any>;
const chain =
  chainBag[CHAIN_NAME] ||
  chainBag.studioDevnet ||
  chainBag.studionet ||
  Object.values(chainBag)[0];

// BigInt-safe stringify for logging RPC return values.
const j = (v: unknown) =>
  JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val));

function line(ok: boolean, label: string, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  ::  " + detail : ""}`);
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  try {
    return (await Promise.race([p, timeout])) as T;
  } finally {
    clearTimeout(t!);
  }
}

async function main(): Promise<number> {
  console.log("=== Stasis frontend <-> chain connectivity check ===");
  console.log(`chain=${chain?.name} (id ${chain?.id})`);
  console.log(`rpc=${chain?.rpcUrls?.default?.http?.[0] ?? "?"}`);
  console.log(`guardian=${GUARDIAN}`);
  console.log(`target=${TARGET}\n`);

  if (!GUARDIAN) {
    line(false, "config", "NEXT_PUBLIC_GUARDIAN_ADDRESS is empty");
    return 1;
  }

  let readsOk = false;
  let writeOk = false;
  let pollOk = false;

  // --- 1. Reads ------------------------------------------------------------
  try {
    const reader = createClient({ chain } as any);
    const read = (functionName: string, args: any[] = []) =>
      withTimeout(
        reader.readContract({ address: GUARDIAN, functionName, args }),
        20000,
        `read ${functionName}`,
      );

    const totalDeposited = await read("get_total_deposited");
    const lockedEscrow = await read("get_locked_escrow");
    const registered = TARGET ? await read("is_registered", [TARGET]) : false;
    const vaultState = registered ? await read("get_state", [TARGET]) : null;
    const vaultEscrow = registered ? await read("get_vault_escrow", [TARGET]) : null;

    console.log("  reads:", j({ totalDeposited, lockedEscrow, registered, vaultState, vaultEscrow }));
    readsOk = true;
    line(true, "1. read vault state + escrow");
  } catch (err: any) {
    line(false, "1. read vault state + escrow", err?.shortMessage || err?.message || String(err));
  }

  // --- 2/3. Ephemeral account + write + poll -------------------------------
  try {
    const account = createAccount();
    console.log(`\n  ephemeral reviewer account: ${account.address}`);
    const signer = createClient({ chain, account } as any);

    const call: any = {
      address: GUARDIAN,
      functionName: "simulate_signal",
      args: [
        TARGET || GUARDIAN,
        "0xverify-" + Date.now().toString(16),
        "verify-" + Date.now().toString(16),
        '{"tvl_drop_bps": 9200, "reason": "flash-loan reentrancy draining pool"}',
        '{"price_deviation_bps": 8800, "state": "abnormal drain confirmed"}',
        "connectivity verification incident",
      ],
    };

    // Fees come from the measured profile, exactly as the frontend does it: the
    // SDK reads the network's live prices and caps and the result is submitted
    // unchanged. A gasless network returns nothing and nothing is attached.
    try {
      const profile = JSON.parse(readFileSync(resolve(ROOT, "fee-profile.json"), "utf8"));
      const entry = profile?.methods?.simulate_signal;
      if (entry && typeof (signer as any).estimateTransactionFees === "function") {
        const est = await (signer as any).estimateTransactionFees({
          leaderTimeunitsAllocation: entry.leaderTimeunitsAllocation ?? "0",
          validatorTimeunitsAllocation: entry.validatorTimeunitsAllocation ?? "0",
          executionBudgetPerRound: entry.executionBudgetPerRound ?? "0",
          totalMessageFees: entry.totalMessageFees ?? "0",
          rotations: [entry.rotationsPerRound ?? "1"],
        });
        if (est?.distribution) call.fees = { distribution: est.distribution, feeValue: est.feeValue };
      }
    } catch {
      /* no measured profile, or gasless / no fee model */
    }

    const txId = await withTimeout(signer.writeContract(call), 45000, "writeContract");
    writeOk = true;
    line(true, "2. send test incident (simulate_signal)", `tx=${String(txId)}`);

    // --- 3. Race-free receipt polling ------------------------------------
    // waitUntil, not the deprecated status: the v0.6 spelling, and the only one
    // that waits past ACCEPTED to the point where fees are settled. The SDK
    // defaults to 10 retries at 3s, which a nondet round outlives, so the budget
    // is raised explicitly - the app does the same.
    const receipt: any = await withTimeout(
      signer.waitForTransactionReceipt({
        hash: txId as any,
        waitUntil: "finalized" as any,
        interval: 4000,
        retries: 75,
      }),
      330000,
      "waitForTransactionReceipt",
    );
    // A v0.6 receipt carries no flat status: it carries a layered lifecycle of
    // {state, outcome}. Pre-lifecycle receipts still carry the flat status.
    const lifecycle = receipt?.lifecycle;
    const state = String(lifecycle?.state ?? "").toUpperCase();
    const outcome = String(lifecycle?.outcome ?? "").toUpperCase();
    const STATUS_NAMES: Record<number, string> = { 5: "ACCEPTED", 6: "UNDETERMINED", 7: "FINALIZED" };
    const rawStatus = receipt?.statusName ?? receipt?.status;
    const statusName = state
      ? outcome && outcome !== "ACCEPTED"
        ? `${state}_${outcome}`
        : state
      : typeof rawStatus === "number"
        ? STATUS_NAMES[rawStatus] ?? `status(${rawStatus})`
        : String(rawStatus);

    const execResult = String(receipt?.txExecutionResultName ?? "");
    const execGood = execResult === "FINISHED_WITH_RETURN";

    // Acceptance alone does not prove the call ran: GenVM reports a failed run as
    // FINISHED_WITH_ERROR while the consensus status still reads accepted, so
    // success needs both halves of the pair. The SDK's isSuccessful encodes exactly
    // that pair and is the authority; the literal rule below is the fallback for a
    // receipt shape the helper cannot read, and it deliberately fails closed. This
    // mirrors succeeded() in apps/web/lib/genlayer.ts, so the script and the app
    // agree on what "done" means.
    let ok: boolean;
    try {
      ok = typeof isSuccessful === "function" && Boolean(isSuccessful(receipt));
    } catch {
      ok = /FINAL|ACCEPT/i.test(statusName) && execGood;
    }

    const leader = receipt?.consensus_data?.leader_receipt?.[0];
    const verdict =
      leader?.result?.raw ??
      leader?.result?.payload ??
      leader?.eq_outputs ??
      receipt?.returnValue ??
      "n/a";

    // The deposit, the consumed part and the refund are three different numbers:
    // the deposit is escrowed up front and the unused remainder comes back at
    // finalization.
    const feeBlock = receipt?.fees;
    const consumedBlock = feeBlock?.consumed ?? {};
    const timeUnits =
      Number(consumedBlock.leaderTimeunitsUsed ?? 0) + Number(consumedBlock.validatorTimeunitsUsed ?? 0);
    const consumedWei =
      Number(consumedBlock.executionConsumed ?? 0) +
      Number(consumedBlock.storageFeeUsed ?? 0) +
      Number(consumedBlock.messageFeesConsumed ?? 0) +
      timeUnits * Number(feeBlock?.locked?.genPerTimeUnit ?? 0);
    const depositWei = Number(feeBlock?.deposit ?? 0);

    pollOk = ok;
    line(
      pollOk,
      "3. poll finalized receipt",
      `status=${statusName} exec=${execResult || "n/a"} verdict=${j(verdict)}`,
    );
    if (depositWei > 0 || consumedWei > 0) {
      console.log(
        `      fees: deposited=${depositWei} consumed=${consumedWei} refunded=${Math.max(0, depositWei - consumedWei)} wei`,
      );
    }
  } catch (err: any) {
    line(false, "2/3. write + poll", err?.shortMessage || err?.message || String(err));
  }

  console.log("\n=== summary ===");
  line(readsOk, "reads");
  line(writeOk, "write");
  line(pollOk, "receipt");
  const allOk = readsOk && writeOk && pollOk;
  console.log(allOk ? "\nRESULT: OK" : "\nRESULT: INCOMPLETE (see FAIL lines above)");
  return allOk ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
