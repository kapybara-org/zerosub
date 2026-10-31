import { join } from "node:path";
import { z } from "zod";
import { OmpSettingsSchema } from "../shared/model";
import { Mutex, readJson, writeJsonAtomic } from "./json-file";
import { dataDir } from "./paths";

const AccountKeySchema = z.object({ provider: z.string(), accountId: z.string(), orgId: z.string().nullable() });
/** How OMP's account policies select an account: its provider plus the ids OMP stores with the login. */
export type AccountKey = z.infer<typeof AccountKeySchema>;

const ControlsSchema = z.object({
  /** At most one per provider. */
  preferred: z.array(AccountKeySchema).default([]),
  reserves: z.array(AccountKeySchema.extend({ reservePct: z.number() })).default([]),
  settings: OmpSettingsSchema.default({}),
});
export type OmpControls = z.infer<typeof ControlsSchema>;

/** Above OMP's default account priority of 0. */
const PREFERRED_PRIORITY = 100;
/** The preferred account takes agents back once it has this much more than its reserve left. */
const RECLAIM_MARGIN_PCT = 15;

/**
 * Settings overlay for the OMP agents Paseo starts (`PI_CONFIG_FILES`). JSON is valid YAML, which is
 * what OMP reads. Never deleted once written: OMP refuses to start when an overlay file is missing.
 */
export function overlayPath(): string {
  return join(dataDir(), "omp-overlay.yml");
}

export function sameAccount(a: AccountKey, b: AccountKey): boolean {
  return a.provider === b.provider && a.accountId === b.accountId && a.orgId === b.orgId;
}

/**
 * The overlay for `controls`. Account policies are left out when the user's OMP config has its
 * own: an overlay list replaces it, and two policies matching one account make OMP refuse to start.
 */
export function buildOverlay(
  controls: OmpControls,
  defaultReservePct: number,
  withPolicies: boolean,
): Record<string, Record<string, unknown>> {
  const overlay: Record<string, Record<string, unknown>> = {};
  for (const [path, value] of Object.entries(controls.settings)) {
    const [section, key] = path.split(".");
    if (value !== undefined && section && key) (overlay[section] ??= {})[key] = value;
  }
  if (!withPolicies) return overlay;
  const policies = new Map<string, { provider: string; account: Record<string, string>; [field: string]: unknown }>();
  const policyFor = (ref: AccountKey) => {
    const id = `${ref.provider}|${ref.accountId}|${ref.orgId ?? ""}`;
    if (!policies.has(id)) {
      policies.set(id, {
        provider: ref.provider,
        account: { accountId: ref.accountId, ...(ref.orgId ? { orgId: ref.orgId } : {}) },
      });
    }
    return policies.get(id)!;
  };
  for (const ref of controls.reserves) policyFor(ref).reservePct = ref.reservePct;
  for (const ref of controls.preferred) {
    const policy = policyFor(ref);
    policy.priority = PREFERRED_PRIORITY;
    // OMP requires the reclaim threshold to sit above the account's reserve.
    const reserve = typeof policy.reservePct === "number" ? policy.reservePct : defaultReservePct;
    if (reserve < 100) policy.reclaimAbovePct = Math.min(100, reserve + RECLAIM_MARGIN_PCT);
  }
  if (policies.size > 0) overlay.auth = { accountPolicies: [...policies.values()] };
  return overlay;
}

/** ZeroSub's OMP choices, kept in `$PASEO_HOME/zerosub/omp-controls.json`. */
export class OmpControlsStore {
  private cached: OmpControls | null = null;
  private readonly mutex = new Mutex();

  async read(): Promise<OmpControls> {
    if (this.cached) return this.cached;
    const parsed = ControlsSchema.safeParse((await readJson(join(dataDir(), "omp-controls.json")).catch(() => undefined)) ?? {});
    this.cached = parsed.success ? parsed.data : ControlsSchema.parse({});
    return this.cached;
  }

  update(change: (draft: OmpControls) => void): Promise<OmpControls> {
    return this.mutex.run(async () => {
      const next = structuredClone(await this.read());
      change(next);
      await writeJsonAtomic(join(dataDir(), "omp-controls.json"), next);
      this.cached = next;
      return next;
    });
  }
}
