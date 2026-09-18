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

import { createClient, createAccount } from "genlayer-js";
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
const CHAIN_NAME = env.NEXT_PUBLIC_GENLAYER_CHAIN || "studionet";

const chainBag = chains as Record<string, any>;
const chain =
  chainBag[CHAIN_NAME] || chainBag.studionet || Object.values(chainBag)[0];

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

    // Optional protocol-fee estimation (fee-charging deployments only).
    try {
      if (typeof (signer as any).estimateTransactionFeesForWrite === "function") {
        const est = await (signer as any).estimateTransactionFeesForWrite(call);
        if (est?.distribution) call.fees = { distribution: est.distribution, feeValue: est.feeValue };
      }
    } catch {
      /* gasless / no fee model */
    }

    const txId = await withTimeout(signer.writeContract(call), 45000, "writeContract");
    writeOk = true;
    line(true, "2. send test incident (simulate_signal)", `tx=${String(txId)}`);

    // --- 3. Race-free receipt polling ------------------------------------
    const receipt: any = await withTimeout(
      signer.waitForTransactionReceipt({ hash: txId as any, status: "FINALIZED" as any }),
      120000,
      "waitForTransactionReceipt",
    );
    // GenLayer numeric status: 5 = ACCEPTED, 7 = FINALIZED (both are terminal-good).
    const STATUS_NAMES: Record<number, string> = { 5: "ACCEPTED", 6: "UNDETERMINED", 7: "FINALIZED" };
    const rawStatus = receipt?.statusName ?? receipt?.status;
    const statusName =
      typeof rawStatus === "number" ? STATUS_NAMES[rawStatus] ?? `status(${rawStatus})` : String(rawStatus);
    const leader = receipt?.consensus_data?.leader_receipt?.[0];
    const verdict =
      leader?.result?.raw ??
      leader?.result?.payload ??
      leader?.eq_outputs ??
      receipt?.returnValue ??
      "n/a";
    pollOk = rawStatus === 5 || rawStatus === 7 || /FINAL|ACCEPT/i.test(String(rawStatus));
    line(pollOk, "3. poll finalized receipt", `status=${statusName} verdict=${j(verdict)}`);
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
