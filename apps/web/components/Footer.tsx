"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, ShieldCheck } from "lucide-react";
import { CHAIN_NAME, EXPLORER_URL, GUARDIAN_ADDRESS, REPO_URL, TARGET_VAULT_ADDRESS } from "@/lib/config";

// Every link resolves to something real: the deployed contracts on the explorer,
// the contract sources, and the GenLayer documentation.
const COLUMNS: { title: string; links: { label: string; href: string }[] }[] = [
  {
    title: "Deployment",
    links: [
      { label: "Guardian on explorer", href: `${EXPLORER_URL}/address/${GUARDIAN_ADDRESS}` },
      { label: "Target vault on explorer", href: `${EXPLORER_URL}/address/${TARGET_VAULT_ADDRESS}` },
    ],
  },
  {
    title: "Source",
    links: [
      { label: "Repository", href: REPO_URL },
      { label: "Guardian contract", href: `${REPO_URL}/blob/main/contracts/stasis_guardian.py` },
      { label: "Reference vault", href: `${REPO_URL}/blob/main/contracts/reference_vault.py` },
    ],
  },
  {
    title: "GenLayer",
    links: [
      { label: "Documentation", href: "https://docs.genlayer.com" },
      { label: "Studio Devnet explorer", href: EXPLORER_URL },
    ],
  },
];

export default function Footer() {
  const [copied, setCopied] = useState(false);
  const addr = GUARDIAN_ADDRESS || "0x0000000000000000000000000000000000000000";

  async function copy() {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(addr);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (insecure context / permissions) */
    }
  }

  return (
    <footer className="mt-8 border-t border-white/10 bg-obsidian-900/60 backdrop-blur-md">
      <div className="mx-auto max-w-[1400px] px-4 py-12 sm:px-6">
        {/* Top row */}
        <div className="flex flex-col gap-6 border-b border-white/10 pb-8 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-lg border border-mint/30 bg-mint/10 shadow-glow-mint">
              <ShieldCheck className="h-5 w-5 text-mint" strokeWidth={2.2} />
            </span>
            <div>
              <div className="text-base font-semibold tracking-tight text-white">
                STASIS PROTOCOL
              </div>
              <div className="text-xs text-zinc-400">
                Deterministic Pause Protocol for Autonomous Finance
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5">
            <span className="label text-zinc-300">Network: {CHAIN_NAME}</span>
          </div>
        </div>

        {/* Columns */}
        <div className="grid grid-cols-2 gap-8 py-8 md:grid-cols-3">
          {COLUMNS.map((col) => (
            <div key={col.title}>
              <div className="label text-zinc-500">{col.title}</div>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <a
                      href={l.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-sm text-zinc-400 transition-colors hover:text-white"
                    >
                      {l.label}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Bottom row */}
        <div className="flex flex-col gap-4 border-t border-white/10 pt-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={copy}
              className="tnum flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 font-mono text-xs text-zinc-300 transition-colors hover:border-mint/40 hover:text-white"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-mint" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{`${addr.slice(0, 10)}...${addr.slice(-6)}`}</span>
            </button>
          </div>
          <div className="text-xs text-zinc-500">
            <span className="text-zinc-600">
              Not financial advice. Studio Devnet preview deployment; scenario animations are off-chain previews and on-chain drills never settle.
            </span>
            <span className="mx-2 text-zinc-700">|</span>
            (c) 2026 STASIS PROTOCOL
          </div>
        </div>
      </div>
    </footer>
  );
}
