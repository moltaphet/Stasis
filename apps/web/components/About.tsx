"use client";

import { motion } from "framer-motion";
import { Cpu, Radio, ShieldCheck } from "lucide-react";

const STEPS = [
  {
    Icon: Radio,
    tone: "#00E5FF",
    step: "01 - Ingest",
    title: "Dual-Feed Ground Truth",
    body: "Validators fetch live primary and secondary telemetry from independent endpoints and cross-reference them. No claim is trusted on a single source.",
  },
  {
    Icon: Cpu,
    tone: "#F59E0B",
    step: "02 - Adjudicate",
    title: "Multi-LLM Consensus",
    body: "Untrusted incident text is sealed in strict XML delimiters. Validators judge only verified numerical divergence and converge on a discrete verdict tier via equivalence consensus.",
  },
  {
    Icon: ShieldCheck,
    tone: "#00FFA3",
    step: "03 - Execute",
    title: "Verifiable Pause",
    body: "On CRITICAL_BREACH the guardian trips the breaker and emits an on-chain pause to the target vault - before catastrophic exploit drain finalizes.",
  },
];

export default function About() {
  return (
    <section id="about" className="mx-auto max-w-[1400px] scroll-mt-20 px-4 py-16 sm:px-6">
      <div className="max-w-3xl">
        <span className="label inline-flex items-center gap-2 rounded-full border border-mint/25 bg-mint/5 px-3 py-1 text-mint">
          About the Protocol
        </span>
        <h2 className="mt-4 text-2xl font-bold leading-tight tracking-tight text-white sm:text-3xl md:text-4xl">
          The First Autonomous, AI-Adjudicated Circuit Breaker for DeFi Vaults on
          GenLayer.
        </h2>
        <p className="mt-4 text-sm leading-relaxed text-zinc-400 sm:text-base">
          Stasis replaces slow human multisig triage with decentralized,
          multi-LLM consensus. It ingests dual-feed telemetry, isolates untrusted
          inputs against prompt injection, and executes verifiable protocol pauses
          before catastrophic exploit drain occurs.
        </p>
      </div>

      <div className="mt-10 grid gap-3 md:grid-cols-3">
        {STEPS.map((s, i) => (
          <motion.article
            key={s.title}
            initial={{ opacity: 0, y: 14 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.4, delay: i * 0.07 }}
            className="glass rounded-xl p-5"
          >
            <div className="flex items-center gap-3">
              <span
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border"
                style={{ borderColor: `${s.tone}55`, background: `${s.tone}12` }}
              >
                <s.Icon className="h-4 w-4" style={{ color: s.tone }} strokeWidth={2} />
              </span>
              <span className="label" style={{ color: s.tone }}>
                {s.step}
              </span>
            </div>
            <h3 className="mt-4 text-lg font-semibold tracking-tight text-white">
              {s.title}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">{s.body}</p>
          </motion.article>
        ))}
      </div>
    </section>
  );
}
