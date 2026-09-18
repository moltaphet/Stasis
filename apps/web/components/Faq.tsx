"use client";

import * as Accordion from "@radix-ui/react-accordion";
import { ChevronDown, HelpCircle } from "lucide-react";

const ITEMS = [
  {
    q: "Why does this require GenLayer instead of standard EVM contracts?",
    a: "Traditional EVM cannot natively fetch live multi-source web telemetry or run nondeterministic consensus on unstructured anomaly data. GenLayer's Intelligent Contracts allow validators to cross-reference multiple oracle feeds and reach equivalence consensus without centralized off-chain keepers.",
  },
  {
    q: "How does Stasis prevent false trips and griefing attacks?",
    a: "Every report requires multi-feed validation. If primary and secondary feeds disagree or reports are spoofed, validators converge on MALICIOUS_REPORT, dismissing the claim and slashing the reporter's bond.",
  },
  {
    q: "How is Prompt Injection handled?",
    a: "User incident descriptions are treated as untrusted strings and encapsulated inside strict XML delimiters in the validation prompt. Prompts instruct validators to evaluate only verified numerical divergence from raw telemetry endpoints.",
  },
  {
    q: "How does the recovery/unpause cycle work?",
    a: "Once TRIPPED, the vault enters an enforced on-chain cooldown. Recovery requires either an automated cooldown expiry check or admin-authorized state restoration.",
  },
  {
    q: "How are bounties settled safely?",
    a: "Native GEN bounty escrow uses a Pull-over-Push accounting model (claimable_balances), ensuring consensus executions never trigger external token transfers.",
  },
];

export default function Faq() {
  return (
    <section id="faq" className="mx-auto max-w-[900px] scroll-mt-20 px-4 py-16 sm:px-6">
      <div className="text-center">
        <span className="label inline-flex items-center gap-2 rounded-full border border-cyan/25 bg-cyan/5 px-3 py-1 text-cyan">
          <HelpCircle className="h-3.5 w-3.5" /> Strategic FAQ
        </span>
        <h2 className="mt-4 text-3xl font-bold tracking-tight text-white sm:text-4xl">
          Protocol &amp; Economics
        </h2>
      </div>

      <Accordion.Root type="single" collapsible className="mt-8 space-y-3">
        {ITEMS.map((item, i) => (
          <Accordion.Item
            key={i}
            value={`item-${i}`}
            className="glass overflow-hidden rounded-xl transition-colors data-[state=open]:border-white/20"
          >
            <Accordion.Header>
              <Accordion.Trigger className="group flex w-full items-center justify-between gap-4 px-5 py-4 text-left">
                <span className="flex items-start gap-3">
                  <span className="tnum mt-0.5 font-mono text-xs text-mint/70">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="text-sm font-semibold text-white sm:text-base">
                    {item.q}
                  </span>
                </span>
                <ChevronDown className="h-4 w-4 shrink-0 text-zinc-400 transition-transform duration-200 group-data-[state=open]:rotate-180 group-data-[state=open]:text-mint" />
              </Accordion.Trigger>
            </Accordion.Header>
            <Accordion.Content className="acc-content overflow-hidden">
              <p className="px-5 pb-5 pl-[3.25rem] text-sm leading-relaxed text-zinc-400">
                {item.a}
              </p>
            </Accordion.Content>
          </Accordion.Item>
        ))}
      </Accordion.Root>
    </section>
  );
}
