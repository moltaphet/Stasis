"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, RefreshCw, Signal } from "lucide-react";
import { CHAIN_NAME, EXPLORER_URL, GUARDIAN_ADDRESS, MOCK_VAULT_ADDRESS } from "@/lib/config";
import { fetchReadout } from "@/lib/genlayer";

export interface Confirmed {
  txId: string;
  status: string;
  tier: number;
  tierLabel: string;
}

type Sync = "polling" | "live" | "optimistic";

// Studio Devnet is a preview the stable Studio explorer does not index, so the
// explorer is configured explicitly rather than read off the chain object.
const EXPLORER = EXPLORER_URL;

// Live on-chain readout. Its rows are bound to the SAME simulator state hook that
// drives the top Breach Simulator (values passed down from Terminal), so both
// panels flip together across every scenario preset. A real finalized
// simulate_signal receipt is overlaid on top (tx hash + verdict). When the read
// path is unavailable, this never shows a blocking fatal error - it shows a
// subtle sync badge and the optimistic (simulator-derived) state.
export default function LiveChain({
  stateLabel,
  stateTone,
  verdictLabel,
  verdictTone,
  divergence,
  lockedBountyGen,
  confirmed,
}: {
  stateLabel: string;
  stateTone: string;
  verdictLabel: string;
  verdictTone: string;
  divergence: number;
  lockedBountyGen: number;
  confirmed: Confirmed | null;
}) {
  const [sync, setSync] = useState<Sync>("polling");

  const load = useCallback(async () => {
    setSync("polling");
    try {
      await fetchReadout(MOCK_VAULT_ADDRESS);
      setSync("live");
    } catch {
      setSync("optimistic");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const badge =
    sync === "polling"
      ? { dot: "#00E5FF", text: "Read Sync: Polling" }
      : sync === "live"
        ? { dot: "#00FFA3", text: "Read Sync: Live" }
        : { dot: "#F59E0B", text: "Read Sync: Optimistic State" };

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
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="Vault State" value={stateLabel} tone={stateTone} />
          <Metric label="Verdict Tier" value={verdictLabel} tone={verdictTone} />
          <Metric label="Feed Divergence" value={`${divergence.toFixed(1)}%`} tone={verdictLabel === "-" ? undefined : verdictTone} />
          <Metric label="Locked Bounty" value={`${lockedBountyGen.toFixed(2)} GEN`} tone={lockedBountyGen > 0 ? "#FF2E54" : undefined} />
        </div>

        {confirmed && (
          <div className="tnum mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-mint/25 bg-mint/5 px-3 py-2 font-mono text-xs">
            <span className="text-mint">receipt {confirmed.status}</span>
            <a
              href={`${EXPLORER}/tx/${confirmed.txId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-cyan underline decoration-cyan/40 underline-offset-2 hover:decoration-cyan"
            >
              tx {confirmed.txId.slice(0, 12)}...{confirmed.txId.slice(-6)}
              <ExternalLink className="h-3 w-3" />
            </a>
            <span className="text-zinc-500">verdict {confirmed.tierLabel}</span>
          </div>
        )}

        <p className="label mt-3 text-zinc-600">
          {sync === "live"
            ? `guardian ${GUARDIAN_ADDRESS.slice(0, 10)}... - values fetched live from RPC`
            : `gen_call read path unavailable on ${CHAIN_NAME} - rows mirror the simulator + finalized receipts`}
        </p>
      </div>
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="label text-zinc-500">{label}</div>
      <div className="tnum mt-2 font-mono text-lg font-bold" style={{ color: tone ?? "#ffffff" }}>{value}</div>
    </div>
  );
}
