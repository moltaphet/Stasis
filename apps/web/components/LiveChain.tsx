"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, RefreshCw, Signal } from "lucide-react";
import { CHAIN_NAME, EXPLORER_URL, GUARDIAN_ADDRESS, STATE_LABELS, TARGET_VAULT_ADDRESS, TIER_LABELS } from "@/lib/config";
import { fetchReadout, type VaultReadout } from "@/lib/genlayer";

export interface Confirmed {
  txId: string;
  status: string;
  tier: number | null;
  tierLabel: string;
}

type Sync = "polling" | "live" | "unavailable";

// Studio Devnet is a preview the stable Studio explorer does not index, so the
// explorer is configured explicitly rather than read off the chain object.
const EXPLORER = EXPLORER_URL;

const PAYOUT_LABELS: Record<number, string> = {
  0: "NONE",
  1: "PENDING",
  2: "DISPUTED",
  3: "SETTLED",
  4: "OVERTURNED",
};

// Live on-chain readout of the guardian and the registered reference vault. Every
// value shown here was read from the chain; when the read path fails the rows
// read "-" and the badge says so. The off-chain scenario animation above never
// feeds these rows. A finalized drill receipt is overlaid with its verdict.
export default function LiveChain({ confirmed }: { confirmed: Confirmed | null }) {
  const [sync, setSync] = useState<Sync>("polling");
  const [data, setData] = useState<VaultReadout | null>(null);

  const load = useCallback(async () => {
    setSync("polling");
    try {
      setData(await fetchReadout(TARGET_VAULT_ADDRESS));
      setSync("live");
    } catch {
      setData(null);
      setSync("unavailable");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, confirmed?.txId]);

  const badge =
    sync === "polling"
      ? { dot: "#00E5FF", text: "Read Sync: Polling" }
      : sync === "live"
        ? { dot: "#00FFA3", text: "Read Sync: Live" }
        : { dot: "#F59E0B", text: "Read Sync: Unavailable" };

  const live = sync === "live" && data !== null;
  const registered = live && data.registered;
  const stateLabel = registered && data.state !== null ? STATE_LABELS[data.state] ?? "UNKNOWN" : "-";
  const tierLabel = registered && data.tier !== null ? TIER_LABELS[data.tier] ?? "UNKNOWN" : "-";
  const payoutLabel =
    registered && data.payoutStatus !== null ? PAYOUT_LABELS[data.payoutStatus] ?? "UNKNOWN" : "-";
  const escrowLabel = registered && data.vaultEscrow !== null ? `${formatWei(data.vaultEscrow)} GEN` : "-";
  const lockedLabel = live ? `${formatWei(data.lockedEscrow)} GEN` : "-";

  return (
    <section className="glass mt-5 overflow-hidden rounded-2xl">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-3">
        <Signal className="h-4 w-4 text-cyan" />
        <span className="text-sm font-semibold tracking-tight text-white">Live Chain Readout</span>
        <span className="label ml-1 text-zinc-500">genlayer-js</span>

        <span className="ml-2 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
          <span className={`h-1.5 w-1.5 rounded-full ${sync === "polling" ? "animate-pulse" : ""}`} style={{ background: badge.dot }} />
          <span className="label" style={{ color: badge.dot }}>{badge.text}</span>
        </span>

        <button
          onClick={() => void load()}
          disabled={sync === "polling"}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-zinc-300 hover:bg-white/10 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${sync === "polling" ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      <div className="p-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Metric label="Vault State" value={stateLabel} />
          <Metric label="Last Verdict" value={tierLabel} />
          <Metric label="Bounty Payout" value={payoutLabel} />
          <Metric label="Vault Escrow" value={escrowLabel} />
          <Metric label="Locked Escrow" value={lockedLabel} />
        </div>

        {confirmed && (
          <div className="tnum mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-mint/25 bg-mint/5 px-3 py-2 font-mono text-xs">
            <span className="text-mint">drill receipt {confirmed.status}</span>
            <a
              href={`${EXPLORER}/tx/${confirmed.txId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-cyan underline decoration-cyan/40 underline-offset-2 hover:decoration-cyan"
            >
              tx {confirmed.txId.slice(0, 12)}...{confirmed.txId.slice(-6)}
              <ExternalLink className="h-3 w-3" />
            </a>
            <span className="text-zinc-500">drill verdict {confirmed.tierLabel} (non-settling)</span>
          </div>
        )}

        <p className="label mt-3 text-zinc-600">
          {sync === "live"
            ? registered
              ? `guardian ${GUARDIAN_ADDRESS.slice(0, 10)}... - values fetched live from RPC`
              : `target vault is not registered on guardian ${GUARDIAN_ADDRESS.slice(0, 10)}...`
            : sync === "unavailable"
              ? `read path unavailable on ${CHAIN_NAME} - no values shown`
              : "reading..."}
        </p>
      </div>
    </section>
  );
}

function formatWei(wei: number): string {
  return (wei / 1e18).toFixed(4);
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="label text-zinc-500">{label}</div>
      <div className="tnum mt-2 font-mono text-lg font-bold" style={{ color: "#ffffff" }}>{value}</div>
    </div>
  );
}
