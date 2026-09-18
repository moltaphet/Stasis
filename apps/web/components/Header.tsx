"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Copy, LogOut, ShieldCheck, Wallet } from "lucide-react";
import { useWallet } from "@/components/WalletProvider";

const NAV = [
  { label: "Dashboard", href: "#dashboard" },
  { label: "About", href: "#about" },
  { label: "FAQ", href: "#faq" },
];

const NETWORKS = ["GenLayer StudioNet", "GenLayer Testnet", "Localnet"];

function short(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function Avatar({ seed }: { seed: string }) {
  const hue = useMemo(() => {
    let h = 0;
    for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 360;
    return h;
  }, [seed]);
  return (
    <span
      className="h-5 w-5 rounded-full ring-1 ring-white/20"
      style={{
        background: `conic-gradient(from 90deg, hsl(${hue} 90% 55%), hsl(${(hue + 120) % 360} 90% 55%), hsl(${(hue + 240) % 360} 90% 55%), hsl(${hue} 90% 55%))`,
      }}
    />
  );
}

export default function Header() {
  const { type, address, isConnected, metamaskAvailable, connectMetaMask, disconnect } = useWallet();
  const [net, setNet] = useState(NETWORKS[0]);
  const [netOpen, setNetOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState("");

  const netRef = useRef<HTMLDivElement>(null);
  const walletRef = useRef<HTMLDivElement>(null);

  // Close either dropdown on an outside click.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (netRef.current && !netRef.current.contains(t)) setNetOpen(false);
      if (walletRef.current && !walletRef.current.contains(t)) setWalletOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  async function connect() {
    setNote("");
    if (!metamaskAvailable) {
      setNote("io.metamask not found");
      return;
    }
    const a = await connectMetaMask();
    if (!a) setNote("declined");
  }

  async function copyAddress() {
    if (!address || typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked (insecure context / permissions) */
    }
  }

  function onDisconnect() {
    disconnect();
    setWalletOpen(false);
  }

  const typeLabel = type === "metamask" ? "MetaMask (EIP-6963)" : type === "reviewer" ? "Ephemeral Reviewer" : "";

  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-obsidian-900/70 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1400px] items-center gap-4 px-4 py-3 sm:px-6">
        {/* Brand */}
        <a href="#dashboard" className="flex items-center gap-2.5">
          <span className="relative grid h-9 w-9 place-items-center rounded-lg border border-mint/30 bg-mint/10 shadow-glow-mint">
            <ShieldCheck className="h-5 w-5 text-mint" strokeWidth={2.2} />
          </span>
          <span className="hidden sm:block">
            <span className="block text-sm font-semibold tracking-tight text-white">
              STASIS PROTOCOL
            </span>
            <span className="label mt-0.5 block text-mint/80">
              Autonomous Security Terminal
            </span>
          </span>
        </a>

        {/* Live badge */}
        <span className="ml-1 hidden items-center gap-2 rounded-full border border-mint/25 bg-mint/5 px-2.5 py-1 md:inline-flex">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-mint/70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-mint" />
          </span>
          <span className="label text-mint">Testnet Online</span>
        </span>

        {/* Center nav */}
        <nav className="mx-auto hidden items-center gap-6 lg:flex">
          {NAV.map((n) => (
            <a
              key={n.label}
              href={n.href}
              className="text-sm font-medium text-zinc-400 transition-colors hover:text-white"
            >
              {n.label}
            </a>
          ))}
        </nav>

        {/* Right cluster */}
        <div className="ml-auto flex items-center gap-2">
          {/* Network selector */}
          <div className="relative hidden sm:block" ref={netRef}>
            <button
              onClick={() => setNetOpen((v) => !v)}
              className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-white/10"
            >
              <span className="h-2 w-2 rounded-full bg-cyan" />
              <span className="hidden md:inline">{net}</span>
              <span className="md:hidden">Network</span>
              <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
            </button>
            {netOpen && (
              <div className="absolute right-0 z-50 mt-1 w-48 overflow-hidden rounded-lg border border-white/10 bg-panel/95 backdrop-blur-md">
                {NETWORKS.map((n) => (
                  <button
                    key={n}
                    onClick={() => {
                      setNet(n);
                      setNetOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-white/5 ${
                      n === net ? "text-mint" : "text-zinc-300"
                    }`}
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-current" />
                    {n}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Wallet pill + disconnect dropdown */}
          {isConnected ? (
            <div className="relative" ref={walletRef}>
              <button
                onClick={() => setWalletOpen((v) => !v)}
                className="group flex items-center gap-2 rounded-lg border border-mint/40 bg-mint/10 px-3 py-1.5 text-sm font-semibold text-mint shadow-glow-mint transition-all hover:bg-mint/15 active:scale-[0.98]"
              >
                <Avatar seed={address || typeLabel} />
                <span className="tnum font-mono">{address ? short(address) : "connected"}</span>
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${walletOpen ? "rotate-180" : ""}`} />
              </button>

              {walletOpen && (
                <div className="absolute right-0 z-50 mt-1.5 w-64 overflow-hidden rounded-lg border border-white/10 bg-panel/95 backdrop-blur-md">
                  {/* Connection type */}
                  <div className="border-b border-white/10 px-3 py-2.5">
                    <div className="label text-zinc-500">Connection</div>
                    <div className="mt-1 flex items-center gap-2">
                      <span className={`h-1.5 w-1.5 rounded-full ${type === "reviewer" ? "bg-cyan" : "bg-mint"}`} />
                      <span className="text-xs font-medium text-white">{typeLabel}</span>
                    </div>
                  </div>

                  {/* Address + copy */}
                  <button
                    onClick={copyAddress}
                    className="flex w-full items-center justify-between gap-2 border-b border-white/10 px-3 py-2.5 text-left hover:bg-white/5"
                  >
                    <span className="tnum truncate font-mono text-xs text-zinc-300">
                      {address ? `${address.slice(0, 10)}...${address.slice(-8)}` : "-"}
                    </span>
                    {copied ? (
                      <span className="flex items-center gap-1 text-xs text-mint">
                        <Check className="h-3.5 w-3.5" /> copied
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-xs text-zinc-400">
                        <Copy className="h-3.5 w-3.5" /> copy
                      </span>
                    )}
                  </button>

                  {/* Disconnect */}
                  <button
                    onClick={onDisconnect}
                    className="flex w-full items-center gap-2 px-3 py-2.5 font-mono text-xs font-semibold uppercase tracking-wider text-zinc-300 transition-colors hover:bg-[#df673d]/10 hover:text-[#df673d]"
                    style={{ letterSpacing: "0.12em" }}
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    Disconnect
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={connect}
              title={note}
              className="group flex items-center gap-2 rounded-lg border border-mint/40 bg-mint/10 px-3 py-1.5 text-sm font-semibold text-mint shadow-glow-mint transition-all hover:bg-mint/15 active:scale-[0.98]"
            >
              <Wallet className="h-4 w-4" />
              <span>Connect Wallet</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
