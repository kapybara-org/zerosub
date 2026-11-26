import { z } from "zod";

/** A ChatGPT account's Fast mode end date: a real YYYY-MM-DD, or empty to clear it. */
export const CodexFastUntilSchema = z.union([z.iso.date(), z.literal("")]);

/** Exclusive UTC deadline for an inclusive calendar date. */
export function codexFastExpiresAt(until: string | undefined): number {
  return until ? Date.parse(`${until}T00:00:00Z`) + 24 * 60 * 60_000 : Number.NaN;
}
