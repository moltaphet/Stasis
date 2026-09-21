// Transaction fee estimation for GenLayer Consensus v0.6.
//
// A fee-charging deployment rejects any write that does not carry a
// FeesDistribution and its quoted fee value: the envelope fails with
// FeesDistributionMissing or FeeValueMustBeNonZero before the contract is ever
// run, which surfaces as a contract error but is really a submission error.
//
// The distribution is not invented here. tests/integration measures real
// transactions against a live network and gltest writes the result to
// fee-profile.json at the repo root; this module turns that measurement into the
// SDK's estimate options and lets the SDK read the network's *current* prices and
// caps at estimate time. The returned distribution and feeValue are submitted
// unchanged - the profile only has to describe how much work the transaction
// does, never what it costs, because unused budget is refunded at finalization.
//
// Gaslessness is a property of the returned estimate, not of the network's name,
// so a network that charges nothing simply returns nothing to attach.

import profile from "../../../fee-profile.json";

interface FeeProfileEntry {
  leaderTimeunitsAllocation?: string;
  validatorTimeunitsAllocation?: string;
  executionBudgetPerRound?: string;
  totalMessageFees?: string;
  rotationsPerRound?: string;
}

interface FeeProfile {
  version: number;
  network: string;
  chainId?: number;
  deploy?: FeeProfileEntry;
  methods?: Record<string, FeeProfileEntry>;
}

const PROFILE = profile as FeeProfile;

// simulate_signal is submitted with no appeal round, so the rotation list has
// exactly one entry: the profile's per-round count.
const APPEAL_ROUNDS = 0;

export interface SubmittedFees {
  distribution: unknown;
  feeValue: unknown;
}

/**
 * Estimate fees for `methodName` from the measured profile.
 *
 * Returns null when the SDK offers no estimate - there is then nothing to attach,
 * which is the correct submission for a gasless deployment.
 *
 * Throws when the profile carries no measurement for the method. That is not a
 * cosmetic gap: a fee-charging network rejects a fee-less write before the contract
 * runs, so submitting anyway would report a contract error for what is really an
 * incomplete profile.
 */
export async function estimateFeesFromProfile(
  client: any,
  methodName: string,
): Promise<SubmittedFees | null> {
  const entry = PROFILE.methods?.[methodName];
  if (!entry) {
    // A method the profile never measured cannot be estimated. That is not a
    // cosmetic gap: on a fee-charging network the write is rejected before the
    // contract runs, so it surfaces as a contract error and hides the real cause.
    // Say so plainly and name the fix. Re-running `make profile` regenerates the
    // whole file, so a method disappears whenever its backing test did not reach
    // a finalized receipt that run.
    throw new Error(
      `fee-profile.json (${PROFILE.network}) has no measurement for ${methodName}. ` +
        `Run \`make profile\` against ${PROFILE.network} to measure it.`,
    );
  }
  if (typeof client?.estimateTransactionFees !== "function") return null;

  const rotationsPerRound = entry.rotationsPerRound ?? "1";
  const options = {
    leaderTimeunitsAllocation: entry.leaderTimeunitsAllocation ?? "0",
    validatorTimeunitsAllocation: entry.validatorTimeunitsAllocation ?? "0",
    executionBudgetPerRound: entry.executionBudgetPerRound ?? "0",
    totalMessageFees: entry.totalMessageFees ?? "0",
    rotations: Array.from({ length: APPEAL_ROUNDS + 1 }, () => rotationsPerRound),
  };

  try {
    const est = await client.estimateTransactionFees(options);
    if (!est?.distribution) return null;
    // Submit what the SDK returned, unchanged: it has already applied the
    // network's live prices and caps to the allocations above.
    return { distribution: est.distribution, feeValue: est.feeValue };
  } catch (err) {
    console.warn("[stasis] fee estimate unavailable:", err);
    return null;
  }
}

/** The network the committed profile was measured against, for display. */
export const PROFILE_NETWORK = PROFILE.network;
