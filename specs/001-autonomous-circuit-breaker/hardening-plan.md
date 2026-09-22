# Stasis Protocol - Pre-Submission Hardening Plan

Baseline: 16 direct tests pass (0.32s), `genvm-lint` clean, 14 methods.
After hardening (Pillars 1-5 DONE): 34 direct tests pass (0.76s), lint clean,
pure ASCII, 24 methods. Pillar 6 (frontend) outstanding - apps/web is empty.

## Circuit-Breaker State Machine (target)

```
                 CRITICAL_BREACH (is_malicious & drop>=threshold)
   +---------+ ------------------------------------------------> +---------+
   |  ARMED  |                                                   | TRIPPED |
   | (active)| <---- NORMAL clears ----+                         | (paused)|
   +---------+                         |                         +----+----+
        |  ELEVATED_RISK               |                              | recover()
        |  (is_malicious & drop<thr)   |                              | (now >= trip_ts + cooldown)
        v                              |                              v
   +--------------+ ------- NORMAL ----+                         +----------+
   | RATE_LIMITED |                                              | RESTORED | --(re-armed for monitoring)
   +--------------+                                              +----------+
```

Discrete tiers (Pillar 1): NORMAL(0), ELEVATED_RISK(1), CRITICAL_BREACH(2), MALICIOUS_REPORT(3).
Monitoring is allowed in any state except TRIPPED (idempotent no-op while tripped).

## Work items

### Pillar 1 - Ground truth & anti-injection
- [ ] Dual-feed fetch: `primary_feed_url` + `secondary_feed_url`, both passed to the LLM as untrusted data.
- [ ] Keep injection-hardened prompt + tag sanitization (already good).
- [ ] LLM schema emits `is_malicious`, `is_false_report`, `observed_drop_bps`, `reason_code`; contract maps to discrete tier deterministically.

### Pillar 2 - State machine & replay
- [ ] States: ARMED, TRIPPED, RESTORED, RATE_LIMITED (u32).
- [ ] `processed_incidents: TreeMap[u256, bool]` keyed by digest(target|tx_hash|incident_id). Reject duplicates ([EXPECTED]).
- [ ] Per-vault `cooldown_seconds` + `trip_ts`; `recover()` gated by cooldown, emits `unpause()`.
- [ ] Zero self.* in nondet closures (preserve).

### Pillar 3 - Native settlement (pull-over-push)
- [ ] `@gl.public.write.payable deposit(target)` -> vault.escrow_balance, total_deposited.
- [ ] `submit_signal(...)` payable, optional reporter bond via gl.message.value.
- [ ] On CRITICAL_BREACH: credit `claimable_balances[reporter]` (never push).
- [ ] On MALICIOUS_REPORT: slash bond into vault escrow.
- [ ] `withdraw()` - CEI, `emit_transfer` to caller (ghost contract).
- [ ] Solvency invariant: total_deposited == sum(escrow) + locked_escrow.

### Pillar 4 - Consensus hardening
- [ ] Feed 429/5xx/timeout -> `feed_status="transient"` (no trip; retryable), validators agree on status bucket.
- [ ] Malformed LLM -> `feed_status="llm_error"` benign fallback (no panic).
- [ ] Validator agrees on discrete buckets (tier gate + threshold-exceed + false-report), never raw text.

### Pillar 5 - Direct tests (tests/direct/)
- [ ] Full lifecycle: deposit -> signal -> trip -> withdraw bounty -> recover.
- [ ] Replay rejection, multi-feed discrepancy, transient (429/500), injection payload.
- [ ] Solvency invariants after each mutation.

### Pillar 6 - Frontend E2E  (DONE)
- [x] Next.js 14 dashboard in apps/web; builds clean (npm run build = 0 errors).
- [x] "Simulate Exploit Attack" flow (critical/elevated/spoof/benign presets) -> simulate_signal.
- [x] Strict EIP-6963 provider selection (rdns === io.metamask), Snap calls in try/catch.
- [x] One-click ephemeral Reviewer Account via genlayer-js createAccount().
- [x] Race-free readback: writes wait for finalized receipt, then re-read vault state.

## Verification gates
- `genvm-lint check` clean on both contracts.
- `pytest tests/direct/ -v` 100% pass.
- ASCII scan clean.
- `npm run build` 0 errors (frontend).
