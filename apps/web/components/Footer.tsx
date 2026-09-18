"use client";

import { useState } from "react";
import {
  BookOpen,
  Check,
  Copy,
  Fingerprint,
  GitBranch,
  Hash,
  MessageCircle,
  Send,
  ShieldCheck,
} from "lucide-react";
import { GUARDIAN_ADDRESS } from "@/lib/config";

const COLUMNS = [
  {
    title: "Protocol",
    links: ["Architecture", "Smart Contracts", "Sentinel Nodes", "Bug Bounty"],
  },
  {
    title: "Developers",
    links: ["SDK & NPM Package", "GenLayer Docs", "Audits", "GitHub Repository"],
  },
  {
    title: "Governance & Economy",
    links: ["GEN Tokenomics", "Incident Council", "Grants"],
  },
];

const SOCIALS = [
  { label: "Discord", Icon: MessageCircle },
  { label: "X", Icon: Hash },
  { label: "Telegram", Icon: Send },
  { label: "Mirror", Icon: BookOpen },
  { label: "GitHub", Icon: GitBranch },
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
          <div className="flex items-center gap-2 rounded-full border border-mint/25 bg-mint/5 px-3 py-1.5">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-mint/70" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-mint" />
            </span>
            <span className="label text-mint">All Systems Operational</span>
          </div>
        </div>

        {/* Columns */}
        <div className="grid grid-cols-2 gap-8 py-8 md:grid-cols-4">
          {COLUMNS.map((col) => (
            <div key={col.title}>
              <div className="label text-zinc-500">{col.title}</div>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l}>
                    <a href="#" className="text-sm text-zinc-400 transition-colors hover:text-white">
                      {l}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div>
            <div className="label text-zinc-500">Community & Socials</div>
            <div className="mt-4 flex flex-wrap gap-2">
              {SOCIALS.map((s) => (
                <a
                  key={s.label}
                  href="#"
                  title={s.label}
                  aria-label={s.label}
                  className="grid h-9 w-9 place-items-center rounded-lg border border-white/10 bg-white/5 text-zinc-400 transition-all hover:border-mint/40 hover:text-mint"
                >
                  <s.Icon className="h-4 w-4" />
                </a>
              ))}
            </div>
          </div>
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
            <span className="flex items-center gap-1.5 rounded-lg border border-cyan/25 bg-cyan/5 px-3 py-1.5 text-cyan">
              <Fingerprint className="h-3.5 w-3.5" />
              <span className="label">ZK-Verified</span>
            </span>
          </div>
          <div className="text-xs text-zinc-500">
            <span className="text-zinc-600">
              Not financial advice. Testnet preview - deterministic simulation only.
            </span>
            <span className="mx-2 text-zinc-700">|</span>
            (c) 2026 STASIS PROTOCOL
          </div>
        </div>
      </div>
    </footer>
  );
}
