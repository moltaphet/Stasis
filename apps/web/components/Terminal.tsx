"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  BadgeCheck,
  Coins,
  Cpu,
  Gauge,
  Lock,
  Radio,
  ShieldAlert,
  Siren,
  Zap,
} from "lucide-react";
import { GUARDIAN_ADDRESS, TARGET_VAULT_ADDRESS } from "@/lib/config";
import { runDrill, type FeeAccounting, type ReviewerSession } from "@/lib/genlayer";
import { SCENARIOS, SCENARIO_ORDER, type Scenario, type ScenarioId } from "@/lib/scenarios";
import { useWallet } from "@/components/WalletProvider";
import LiveChain from "./LiveChain";

// --- Deterministic timeline constants ----------------------------------------

const PRIMARY = 1850;
const ESCROW_GEN = 5.0;
const THRESHOLD = 15.0;

const WEI_PER_GEN = 1e18;

// Fee amounts arrive in wei; a whole GEN is 1e18 of them, so a bare integer would
// be unreadable. Small amounts keep more precision than large ones.
function formatGen(wei: number): string {
  const gen = wei / WEI_PER_GEN;
  if (gen === 0) return "0 GEN";
  if (gen < 0.000001) return `${gen.toExponential(2)} GEN`;
  return `${gen.toFixed(gen < 0.01 ? 8 : 6)} GEN`;
}

const T_ANOMALY = 1000;
const T_SWEEP = 2600;
const T_CONSENSUS = 4100;
const T_END = 5000;

type Mode = "armed" | "running" | "settled" | "restored";

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const pad2 = (n: number) => String(n).padStart(2, "0");
const pad3 = (n: number) => String(n).padStart(3, "0");
function fmtTs(ms: number) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

type Tone = "mint" | "amber" | "crimson" | "cyan" | "zinc" | "orange";
const TONE_HEX: Record<Tone, string> = {
  mint: "#00FFA3",
  amber: "#F59E0B",
  crimson: "#FF2E54",
  cyan: "#00E5FF",
  zinc: "#a1a1aa",
  orange: "#df673d",
};
const toneForTier = (t: number): Tone =>
  t >= 3 ? "orange" : t === 2 ? "crimson" : t === 1 ? "amber" : "mint";

const VERDICT_SHORT: Record<number, string> = {
  0: "NORMAL",
  1: "ELEVATED",
  2: "BREACH",
  3: "SPOOF",
};
const DISPATCH_SHORT: Record<ScenarioId, string> = {
  critical: "PAUSED",
  elevated: "THROTTLED",
  nominal: "DISMISSED",
  injection: "SLASHED",
};
const SETTLED_STATUS: Record<ScenarioId, string> = {
  critical: "CIRCUIT BREAKER TRIPPED - VAULT PAUSED",
  elevated: "ELEVATED RISK - RATE LIMIT ENGAGED",
  nominal: "NOMINAL - CLAIM DISMISSED",
  injection: "MALICIOUS REPORT - BOND SLASHED, STATE PRESERVED",
};

function stateTone(label: string): string {
  if (label === "TRIPPED") return "#FF2E54";
  if (label === "RATE-LIMITED") return "#F59E0B";
  if (label === "RESTORED") return "#00E5FF";
  return "#00FFA3";
}

// Per-scenario consensus log schedule.
function buildSchedule(sc: Scenario): { at: number; tone: Tone; text: string }[] {
  const vt = toneForTier(sc.tier);
  const lines: { at: number; tone: Tone; text: string }[] = [
    { at: 120, tone: "amber", text: "anomaly.detected :: dual-feed verification active" },
    { at: 1000, tone: "cyan", text: `feed.primary    $${fmtUsd(sc.primary)} :: chainlink` },
    {
      at: 2600,
      tone: vt,
      text: `feed.secondary  $${fmtUsd(sc.secondary)} :: divergence ${sc.divergence.toFixed(1)}%`,
    },
    { at: 3000, tone: "zinc", text: "quorum.request  :: multi-llm sentinels=9" },
    { at: 3500, tone: "mint", text: "QUORUM: 9/9 VALIDATED" },
    { at: 3800, tone: vt, text: `verdict=${sc.tierLabel} :: confidence 0.98` },
    { at: 4200, tone: vt, text: sc.actionLine },
    { at: 4600, tone: vt, text: sc.settleLine },
  ];
  if (sc.id === "injection") {
    lines.splice(5, 0, {
      at: 3300,
      tone: "orange",
      text: "injection.guard :: feed body sealed in <untrusted_input>",
    });
  }
  return lines;
}

// --- Segmented state matrix --------------------------------------------------

const STAGES = [
  { key: "ARMED", label: "ARMED", sub: "NORMAL", tone: "mint", Icon: Radio },
  { key: "ELEVATED", label: "ELEVATED RISK", sub: "RATE-LIMIT", tone: "amber", Icon: ShieldAlert },
  { key: "CRITICAL", label: "CRITICAL BREACH", sub: "TRIP", tone: "crimson", Icon: Siren },
  { key: "RESTORED", label: "RESTORED", sub: "RE-ARMED", tone: "cyan", Icon: BadgeCheck },
] as const;

function StateMatrix({ active }: { active: number }) {
  return (
    <section
      aria-label="Circuit breaker state matrix"
      className="glass grid grid-cols-2 gap-2 rounded-2xl p-2 md:grid-cols-4"
    >
      {STAGES.map((s, i) => {
        const on = i === active;
        const hex = TONE_HEX[s.tone as Tone];
        return (
          <div key={s.key} aria-current={on ? "step" : undefined} className="relative overflow-hidden rounded-xl px-4 py-3">
            {on && (
              <motion.span
                layoutId="state-active"
                className="absolute inset-0 rounded-xl"
                style={{ background: `${hex}1a`, boxShadow: `0 0 0 1px ${hex}55, 0 0 30px -6px ${hex}` }}
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
              />
            )}
            <div className="relative flex items-center gap-2">
              <s.Icon className="h-4 w-4" style={{ color: on ? hex : "#52525b" }} strokeWidth={2.2} />
              <span className="text-sm font-semibold tracking-tight" style={{ color: on ? "#fff" : "#a1a1aa" }}>
                {s.label}
              </span>
              {on && (
                <motion.span
                  className="ml-auto h-1.5 w-1.5 rounded-full"
                  style={{ background: hex }}
                  animate={{ opacity: [1, 0.3, 1] }}
                  transition={{ duration: 1.4, repeat: Infinity }}
                />
              )}
            </div>
            <div className="label relative mt-2" style={{ color: on ? hex : "#52525b" }}>
              {`0${i + 1} - ${s.sub}`}
            </div>
          </div>
        );
      })}
    </section>
  );
}

// --- Main --------------------------------------------------------------------

export default function Terminal() {
  const [scenarioId, setScenarioId] = useState<ScenarioId>("critical");
  const [mode, setMode] = useState<Mode>("armed");
  const [elapsed, setElapsed] = useState(0);
  const [baseTime, setBaseTime] = useState(0);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);
  const restoreRef = useRef<number | null>(null);

  const { session } = useWallet();
  const [tx, setTx] = useState<{
    state: "idle" | "submitting" | "done" | "error";
    txId?: string;
    status?: string;
    executionResult?: string;
    tier?: number | null;
    tierLabel?: string;
    fees?: FeeAccounting;
    error?: string;
  }>({ state: "idle" });

  const sc = SCENARIOS[scenarioId];

  const cancel = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  const tick = useCallback((now: number) => {
    const e = now - startRef.current;
    if (e >= T_END) {
      setElapsed(T_END);
      setMode("settled");
      rafRef.current = null;
      return;
    }
    setElapsed(e);
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const broadcast = useCallback(async (s: ReviewerSession, scenario: Scenario) => {
    setTx({ state: "submitting" });
    try {
      const res = await runDrill(s, TARGET_VAULT_ADDRESS, {
        payloadA: scenario.payloadA,
        payloadB: scenario.payloadB,
      });
      setTx({
        state: res.ok ? "done" : "error",
        txId: res.txId,
        status: res.status,
        executionResult: res.executionResult,
        tier: res.tier,
        tierLabel: res.tierLabel,
        fees: res.fees,
      });
    } catch (err: any) {
      setTx({ state: "error", error: err?.shortMessage || err?.message || String(err) });
    }
  }, []);

  const simulate = useCallback(() => {
    cancel();
    if (restoreRef.current) window.clearTimeout(restoreRef.current);
    setBaseTime(Date.now());
    setMode("running");
    setElapsed(0);
    startRef.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);
    if (session) void broadcast(session, sc);
  }, [cancel, tick, session, broadcast, sc]);

  const reset = useCallback(() => {
    cancel();
    if (restoreRef.current) window.clearTimeout(restoreRef.current);
    setMode("armed");
    setElapsed(0);
    setTx({ state: "idle" });
  }, [cancel]);

  const restore = useCallback(() => {
    cancel();
    setMode("restored");
    setElapsed(0);
    restoreRef.current = window.setTimeout(() => setMode("armed"), 1600);
  }, [cancel]);

  const selectScenario = useCallback(
    (id: ScenarioId) => {
      reset();
      setScenarioId(id);
    },
    [reset],
  );

  useEffect(() => () => cancel(), [cancel]);
  useEffect(() => {
    if (!session) setTx({ state: "idle" });
  }, [session]);

  const e = mode === "settled" ? T_END : elapsed;
  const idle = mode === "armed" || mode === "restored";
  const settled = mode === "settled" || (mode === "running" && e >= T_CONSENSUS);

  const sweepFrac = clamp((e - T_ANOMALY) / (T_SWEEP - T_ANOMALY), 0, 1);
  const secondaryLive = idle ? PRIMARY : PRIMARY - (PRIMARY - sc.secondary) * sweepFrac;
  const divergenceLive = idle ? 0 : sc.divergence * sweepFrac;

  const allocFrac = !sc.bountyAllocated
    ? 0
    : mode === "settled"
      ? 1
      : idle
        ? 0
        : clamp((e - T_CONSENSUS) / (T_END - T_CONSENSUS), 0, 1);
  const lockedBounty = ESCROW_GEN * allocFrac;
  const available = ESCROW_GEN - lockedBounty;

  const vaultStateLabel = mode === "restored"
    ? "RESTORED"
    : settled
      ? sc.finalState === "RATE_LIMITED"
        ? "RATE-LIMITED"
        : sc.finalState
      : "ARMED";

  const activeStage = mode === "restored"
    ? 3
    : mode === "armed"
      ? 0
      : !settled
        ? 1
        : sc.finalState === "TRIPPED"
          ? 2
          : sc.finalState === "RATE_LIMITED"
            ? 1
            : 0;

  const alertAccent = settled ? sc.accent : undefined;

  const schedule = useMemo(() => buildSchedule(sc), [sc]);
  const logLines = useMemo(() => {
    const running = mode === "running";
    const done = mode === "settled";
    if (!running && !done) return [] as { ts: string; text: string; tone: Tone; typing: boolean }[];
    const out: { ts: string; text: string; tone: Tone; typing: boolean }[] = [];
    for (const item of schedule) {
      if (e < item.at && !done) continue;
      const since = done ? 9999 : e - item.at;
      const shown = done ? item.text.length : Math.floor((since / 240) * item.text.length);
      out.push({
        ts: fmtTs(baseTime + item.at),
        text: item.text.slice(0, Math.max(1, Math.min(item.text.length, shown))),
        tone: item.tone,
        typing: shown < item.text.length,
      });
    }
    return out;
  }, [mode, e, baseTime, schedule]);

  const statusText = mode === "armed"
    ? "ARMED - MONITORING DUAL FEEDS"
    : mode === "restored"
      ? "RESTORED - RE-ARMED FOR MONITORING"
      : !settled
        ? "ANALYZING - MULTI-LLM CONSENSUS IN PROGRESS"
        : SETTLED_STATUS[sc.id];
  const statusColor = mode === "armed" ? "#00FFA3" : mode === "restored" ? "#00E5FF" : !settled ? "#F59E0B" : sc.accent;

  const feedBColor = settled ? sc.accent : divergenceLive > 0.05 ? "#F59E0B" : "#e5e9f0";
  const showRestore = mode === "settled" && sc.finalState === "TRIPPED";

  return (
    <div id="dashboard" className="mx-auto max-w-[1400px] scroll-mt-20 px-4 py-6 sm:px-6">
      {/* Hero: state matrix + subtitle */}
      <div className="grid-texture rounded-2xl border border-white/10 p-4 sm:p-5">
        <StateMatrix active={activeStage} />
        <p className="mx-auto mt-4 max-w-3xl text-center text-sm text-zinc-400 sm:text-base">
          AI-adjudicated emergency pause, executed on-chain inside the exploit window - before catastrophic drain finalizes.
        </p>
      </div>

      {/* War room split grid */}
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        {/* Left: telemetry + simulator */}
        <section className="glass rounded-2xl">
          <PanelHead icon={<Activity className="h-4 w-4 text-cyan" />}>Oracle Telemetry &amp; Breach Simulator</PanelHead>
          <div className="space-y-4 p-4 sm:p-5">
            {/* Scenario selector */}
            <div>
              <div className="label mb-2 text-zinc-500">Scenario Preset</div>
              <div role="radiogroup" aria-label="Breach scenario" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {SCENARIO_ORDER.map((id) => {
                  const s = SCENARIOS[id];
                  const on = id === scenarioId;
                  return (
                    <button
                      key={id}
                      role="radio"
                      aria-checked={on}
                      onClick={() => selectScenario(id)}
                      className="rounded-lg border px-2 py-2 text-xs font-semibold transition-colors"
                      style={{
                        borderColor: on ? s.accent : "rgba(255,255,255,0.1)",
                        background: on ? `${s.accent}18` : "rgba(255,255,255,0.02)",
                        color: on ? s.accent : "#a1a1aa",
                      }}
                    >
                      {s.tab}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Target preview (updates per tab) */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
              <span className="label text-zinc-500">Target</span>
              <span className="tnum font-mono text-xs" style={{ color: sc.accent }}>
                {sc.tierLabel} -&gt; {sc.finalState}
              </span>
              <span className="tnum font-mono text-xs text-zinc-400">
                secondary ${fmtUsd(sc.secondary)}
              </span>
              <span className="tnum font-mono text-xs text-zinc-400">divergence {sc.divergence.toFixed(1)}%</span>
            </div>

            {/* Status line */}
            <div aria-live="polite" className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: statusColor }} />
              <span className="label" style={{ color: statusColor }}>{statusText}</span>
            </div>

            {/* Feed readouts */}
            <FeedRow tag="Primary Feed" note="chainlink" value={fmtUsd(PRIMARY)} color="#00E5FF" />
            <FeedRow tag={sc.feedBLabel} note={sc.reason} value={fmtUsd(secondaryLive)} color={feedBColor} live={mode === "running" && !settled} />

            {/* Divergence gauge */}
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <div className="flex items-end justify-between">
                <span className="label flex items-center gap-1.5 text-zinc-400">
                  <Gauge className="h-3.5 w-3.5" /> Feed Divergence
                </span>
                <span className="tnum font-mono text-2xl font-bold leading-none" style={{ color: feedBColor }}>
                  {divergenceLive.toFixed(1)}%
                </span>
              </div>
              <div className="relative mt-3 h-2.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${clamp((divergenceLive / (THRESHOLD * 2)) * 100, 0, 100)}%`,
                    background: divergenceLive >= THRESHOLD
                      ? "linear-gradient(90deg,#F59E0B,#FF2E54)"
                      : "linear-gradient(90deg,#00E5FF,#00FFA3)",
                  }}
                />
                <span className="absolute top-0 h-full w-px bg-white/50" style={{ left: "50%" }} />
              </div>
              <div className="mt-1.5 flex justify-between">
                <span className="label text-zinc-500">0.0%</span>
                <span className="label" style={{ color: divergenceLive >= THRESHOLD ? "#FF2E54" : "#71717a" }}>
                  trip {THRESHOLD.toFixed(1)}%
                </span>
                <span className="label text-zinc-500">30.0%+</span>
              </div>
            </div>

            {/* Controls */}
            <div className="flex flex-wrap gap-3 pt-1">
              <motion.button
                onClick={simulate}
                disabled={mode === "running"}
                whileTap={{ scale: 0.97 }}
                className="flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold tracking-tight text-white disabled:opacity-60"
                style={{ background: `linear-gradient(120deg, ${sc.accent}, ${sc.accent}bb)`, boxShadow: `0 0 0 1px ${sc.accent}59` }}
              >
                <Zap className="h-4 w-4" />
                EXECUTE SCENARIO
              </motion.button>
              {showRestore ? (
                <motion.button onClick={restore} whileTap={{ scale: 0.97 }} className="rounded-xl border border-cyan/40 bg-cyan/10 px-5 py-3 text-sm font-semibold text-cyan hover:bg-cyan/15">
                  RESTORE &amp; RE-ARM
                </motion.button>
              ) : (
                <motion.button onClick={reset} whileTap={{ scale: 0.97 }} className="rounded-xl border border-white/15 bg-white/5 px-5 py-3 text-sm font-semibold text-zinc-200 hover:border-cyan/40 hover:text-white">
                  RESET SYSTEM
                </motion.button>
              )}
            </div>

            {/* On-chain tx status */}
            <div className="pt-1">
              {tx.state === "idle" && (
                <p className="label text-zinc-600">
                  {session ? "Reviewer active - execute also broadcasts a non-settling on-chain drill (simulate_signal)" : "Off-chain preview - activate Reviewer Mode to broadcast an on-chain drill"}
                </p>
              )}
              {tx.state === "submitting" && (
                <p className="label flex items-center gap-2 text-cyan">
                  <span className="h-2 w-2 animate-ping rounded-full bg-cyan" /> Broadcasting drill (simulate_signal)...
                </p>
              )}
              {tx.state === "done" && (
                <div className="space-y-1">
                  <p className="label tnum font-mono text-mint">
                    tx {tx.txId?.slice(0, 10)}... {tx.status} :: {tx.executionResult} :: drill verdict {tx.tierLabel}
                  </p>
                  {tx.fees?.known && (
                    // Consensus v0.6 escrows one deposit per transaction and refunds
                    // the unused part at finalization, so these are three different
                    // numbers and are shown as such rather than as one "cost".
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                      <span className="label tnum font-mono text-zinc-500">
                        deposited <span className="text-zinc-300">{formatGen(tx.fees.deposit)}</span>
                      </span>
                      <span className="label tnum font-mono text-zinc-500">
                        consumed <span className="text-amber-400">{formatGen(tx.fees.consumed)}</span>
                      </span>
                      <span className="label tnum font-mono text-zinc-500">
                        refunded <span className="text-mint">{formatGen(tx.fees.refunded)}</span>
                      </span>
                    </div>
                  )}
                </div>
              )}
              {tx.state === "error" && (
                <div className="space-y-1">
                  <p className="label tnum font-mono text-crimson">
                    tx not completed: {(tx.error || tx.status || "error").slice(0, 60)}
                    {tx.executionResult ? ` :: ${tx.executionResult}` : ""}
                  </p>
                  {tx.fees?.known && (
                    <p className="label tnum font-mono text-zinc-500">
                      deposited <span className="text-zinc-300">{formatGen(tx.fees.deposit)}</span>{" "}
                      | consumed <span className="text-amber-400">{formatGen(tx.fees.consumed)}</span> | refunded{" "}
                      <span className="text-mint">{formatGen(tx.fees.refunded)}</span>
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Right: consensus terminal */}
        <section className="glass overflow-hidden rounded-2xl">
          <PanelHead icon={<Cpu className="h-4 w-4 text-mint" />}>Incident &amp; Multi-LLM Consensus Log</PanelHead>
          <div className="crt bg-black/40">
            <div className="thin-scroll relative z-10 min-h-[280px] overflow-y-auto p-4 font-mono text-[12.5px] leading-relaxed sm:text-[13px]">
              {logLines.length === 0 ? (
                <span className="text-zinc-600">
                  <span className="text-mint">stasis@guardian</span>:~$ awaiting anomaly signal
                  <span className="blink" />
                </span>
              ) : (
                <AnimatePresence initial={false}>
                  {logLines.map((l, i) => (
                    <motion.div key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="whitespace-pre-wrap break-words">
                      <span className="text-zinc-600">[{l.ts}]</span>{" "}
                      <span style={{ color: TONE_HEX[l.tone] }}>{l.text}</span>
                      {l.typing && <span className="blink" />}
                    </motion.div>
                  ))}
                </AnimatePresence>
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-px border-t border-white/10 bg-white/5">
            <MiniStat label="Quorum" value={settled ? "9/9" : "--"} color={settled ? "#00FFA3" : undefined} />
            <MiniStat label="Verdict" value={settled ? VERDICT_SHORT[sc.tier] : "--"} color={alertAccent} />
            <MiniStat label="Dispatch" value={settled ? DISPATCH_SHORT[sc.id] : "--"} color={alertAccent} />
          </div>
        </section>
      </div>

      {/* Bottom ribbon: solvency + guardian */}
      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <EscrowCard icon={<Coins className="h-4 w-4 text-mint" />} label="Total Escrow" value={<NumSplit value={ESCROW_GEN} suffix="GEN" />} sub={`available ${available.toFixed(2)} GEN`} />
        <EscrowCard
          icon={<Lock className="h-4 w-4 text-crimson" />}
          label="Locked Bounty"
          value={<NumSplit value={lockedBounty} suffix="GEN" color={lockedBounty > 0 ? "#FF2E54" : undefined} />}
          sub={settled && sc.bondSlashed ? "reporter bond slashed" : `${(allocFrac * 100).toFixed(0)}% of escrow allocated`}
        />
        <GuardianCard />
      </div>

      {/* Live on-chain readout - values read from the chain only */}
      <LiveChain
        confirmed={
          tx.state === "done" && tx.txId
            ? { txId: tx.txId, status: tx.status ?? "FINALIZED", tier: tx.tier ?? null, tierLabel: tx.tierLabel ?? "UNREADABLE" }
            : null
        }
      />

      {/* Protocol specification */}
      <ProtocolSpecs />
    </div>
  );
}

// --- Sub-components ----------------------------------------------------------

function PanelHead({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
      {icon}
      <span className="text-sm font-semibold tracking-tight text-white">{children}</span>
    </div>
  );
}

function FeedRow({ tag, note, value, color, live = false }: { tag: string; note: string; value: string; color: string; live?: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
      <div className="flex items-center gap-2.5">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: color, boxShadow: `0 0 10px ${color}` }} />
        <div>
          <div className="text-sm font-medium text-white">{tag}</div>
          <div className="label text-zinc-500">{note}</div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {live && (
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full" style={{ background: color }} />
            <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: color }} />
          </span>
        )}
        <span className="tnum font-mono text-lg font-semibold" style={{ color }}>${value}</span>
      </div>
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-black/20 px-3 py-3">
      <div className="label text-zinc-500">{label}</div>
      <div className="tnum mt-1 font-mono text-sm font-bold" style={{ color: color ?? "#e5e9f0" }}>{value}</div>
    </div>
  );
}

function NumSplit({ value, decimals = 2, suffix = "", color }: { value: number; decimals?: number; suffix?: string; color?: string }) {
  const fixed = value.toFixed(decimals);
  const [int, dec] = fixed.split(".");
  return (
    <span className="tnum font-mono leading-none" style={color ? { color } : undefined}>
      <span className="text-2xl font-bold sm:text-3xl">{Number(int).toLocaleString("en-US")}</span>
      {dec && <span className="text-base font-medium text-white/40">.{dec}</span>}
      {suffix && <span className="ml-1 text-xs font-medium text-white/40">{suffix}</span>}
    </span>
  );
}

function EscrowCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub: string }) {
  return (
    <div className="glass rounded-2xl p-4 sm:p-5">
      <div className="label flex items-center gap-1.5 text-zinc-400">{icon} {label}</div>
      <div className="mt-3 text-white">{value}</div>
      <div className="label tnum mt-2 text-zinc-500">{sub}</div>
    </div>
  );
}

function GuardianCard() {
  const { type, session, connectReviewer, disconnect } = useWallet();
  const [err, setErr] = useState("");
  const deployed = Boolean(GUARDIAN_ADDRESS);

  function spawn() {
    try {
      connectReviewer();
      setErr("");
    } catch (e2) {
      console.error("[stasis] reviewer session failed:", e2);
      setErr("unavailable");
    }
  }
  const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

  return (
    <div className="glass rounded-2xl p-4 sm:p-5">
      <div className="label flex items-center gap-1.5 text-zinc-400">
        <BadgeCheck className="h-4 w-4 text-cyan" /> Guardian Access
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${deployed ? "bg-mint" : "bg-crimson"}`} />
        <span className="tnum font-mono text-sm text-white">
          {deployed ? `${GUARDIAN_ADDRESS.slice(0, 8)}...${GUARDIAN_ADDRESS.slice(-4)}` : "unset"}
        </span>
      </div>
      {type === "reviewer" && session ? (
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="tnum font-mono text-xs text-mint">reviewer {session.address ? short(session.address) : "ready"}</span>
          <button onClick={disconnect} className="font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-400 transition-colors hover:text-[#df673d]">
            disconnect
          </button>
        </div>
      ) : (
        <button onClick={spawn} className="mt-3 w-full rounded-lg border border-cyan/40 bg-cyan/10 px-3 py-2 text-xs font-semibold text-cyan transition-colors hover:bg-cyan/15">
          1-Click Reviewer Mode
        </button>
      )}
      <div className="label mt-2 text-zinc-600">{err || "non-custodial - multi-sig replaced by quorum"}</div>
    </div>
  );
}

const SPECS: { k: string; v: string; tone?: string }[] = [
  { k: "Runtime", v: "GenLayer Intelligent Contract" },
  { k: "States", v: "ARMED / TRIPPED / RESTORED / RATE-LIMITED" },
  { k: "Verdict Tiers", v: "NORMAL / ELEVATED_RISK / CRITICAL_BREACH / MALICIOUS_REPORT" },
  { k: "Trip Threshold", v: "15.0% TVL divergence", tone: "#F59E0B" },
  { k: "Ground Truth", v: "dual independent feeds (gl.nondet.web.get)" },
  { k: "Consensus", v: "multi-LLM equivalence (gl.vm.run_nondet)" },
  { k: "Injection Guard", v: "untrusted input sealed in <untrusted_input> tags" },
  { k: "Evidence Binding", v: "both feeds must name target + tx_hash" },
  { k: "Replay Protection", v: "fnv1a-256(vault|tx) TreeMap" },
  { k: "Settlement", v: "bonded challenge window -> pull-over-push", tone: "#00FFA3" },
  { k: "Recovery", v: "enforced cooldown -> admin recover()" },
];

function ProtocolSpecs() {
  return (
    <section id="specs" className="mt-5 scroll-mt-20">
      <div className="glass overflow-hidden rounded-2xl">
        <PanelHead icon={<Gauge className="h-4 w-4 text-cyan" />}>Protocol Specification</PanelHead>
        <dl className="grid grid-cols-1 gap-px bg-white/10 sm:grid-cols-2">
          {SPECS.map((s) => (
            <div key={s.k} className="flex items-baseline justify-between gap-4 bg-panel px-4 py-2.5">
              <dt className="label shrink-0 text-zinc-500">{s.k}</dt>
              <dd className="tnum text-right font-mono text-xs" style={{ color: s.tone ?? "#d4d4d8" }}>{s.v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
