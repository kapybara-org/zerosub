/**
 * Which account an agent should use, as pure functions shared by the server (routing, failover,
 * moves between turns) and the client (the order and the reasons shown in the account popover).
 *
 * Times are hours from now. A window is `{ used: 0..100, reset: hours | null }`; `null` means the
 * window hasn't started, so it can't expire. Usage only grows between readings, so a reading is the
 * best case; `estimate` adds what was probably used since.
 */

export const K = {
  /** % of the week one full 5-hour window burns (measured from pairs of readings: about 15). */
  F_RATIO: 0.15,
  /** % of the 5-hour window one busy agent burns per hour (one agent fills a fresh window in 4 h). */
  S_RATE: 25,
  /** A 5-hour window refilling within 20 minutes counts as fresh. */
  REFILL_H: 1 / 3,
  /** An account that walls within 30 minutes at its load waits for its 5-hour refill. */
  BREATH_H: 0.5,
  /** An older reading is re-read before it decides anything. */
  FRESH_H: 0.5,
  /** Fable-window % per weekly % on a Fable turn. */
  FABLE_PER_WEEK: 1,
  /** % of a window below which an account can't take a turn. */
  MIN_ROOM: 0.5,
  /** A moving agent wants an account that holds it this long (or its remaining work). */
  HOLD_H: 4,
  /** An account already busy takes a new agent only if it carries them all this long: no pile-up. */
  NEW_HOLD_H: 1,
  /** Fleet pace (% of one account-week per hour) until it is learned from readings. */
  PACE: 2,
  WEEK_H: 168,
  FIVE_H: 5,
} as const;

/** The most an account can burn per hour, in % of its week. */
export const DRAIN_MAX = (100 / K.FIVE_H) * K.F_RATIO;

export interface PlanWindow {
  used: number;
  reset: number | null;
}

export interface PlanLimit {
  /** `account`: nothing runs. `fable`: only Fable turns are refused. `model`: only the agent's own model. */
  scope: "account" | "fable" | "model";
  untilH: number;
  kind: "window" | "budget";
}

export type PlanStatus = "ready" | "signed_out" | "disabled";

export interface PlanAccount {
  id: string;
  name: string;
  status: PlanStatus;
  /** The 5-hour window. */
  s: PlanWindow | null;
  /** The weekly window. */
  w: PlanWindow | null;
  /** Fable's own weekly window, when the account has one. */
  f: PlanWindow | null;
  /** The asking model's own window (Claude's "Weekly · Opus"), when it isn't Fable. */
  m?: PlanWindow | null;
  /** The model's name for that window, for the reasons shown ("Opus"). */
  mName?: string | null;
  /** How old the reading is. */
  ageH: number;
  limits: PlanLimit[];
  /** Busy agents on it now. */
  load: number;
  /** % of the week per hour this account burns, learned from its readings (here and on other Macs). */
  extRate?: number;
  /** The share of that on Fable. */
  extFable?: number;
  /** No reading at all yet. */
  noReading?: boolean;
}

export type PlanModel = "fable" | "other";

export interface PlanRequest {
  model?: PlanModel;
  kind?: "new" | "move";
  remainingH?: number;
  keepFable?: boolean;
  exclude?: readonly string[];
  /** The order on screen, so ties keep it: no flicker. */
  prev?: readonly string[];
  paceH?: number;
  horizonH?: number;
  /** The accounts this agent may use. Others rank after them (`outside`), or drop out without overflow. */
  pool?: readonly string[] | null;
  /** An order the user dragged; usable accounts follow it. */
  manual?: readonly string[] | null;
  /** False: accounts outside the pool are left out. */
  overflow?: boolean;
}

interface Views {
  s: PlanWindow | null;
  w: PlanWindow | null;
  f: PlanWindow | null;
  m: PlanWindow | null;
}

export interface Estimate {
  age: number;
  stale: boolean;
  read: Views;
  exp: Views;
  worst: Views;
}

export interface Fit {
  ok: boolean;
  /** 0 usable, 1 nearly out of its 5-hour, 2 can't serve this model, 3 full or limited, 4 signed out or off. */
  tier: 0 | 1 | 2 | 3 | 4;
  why?: string;
  /** Hours until it can take this agent again. */
  back: number;
  room: number;
  deadline: number;
  binding: "week" | "fable" | "model";
  /** Weekly room that no Fable turn can use, because Fable's own window is fuller. */
  opusOnly: number;
  fableUse: number;
  wRoom: number;
  fRoom: number;
  sRoom: number;
  runway: number;
  sReset: number | null;
  load: number;
}

export interface Ranked extends Fit {
  id: string;
  name: string;
  a: PlanAccount;
  e: Estimate;
  risky: boolean;
  key: number[];
  why: string;
  prev: number;
  outside: boolean;
  tight: boolean;
  badges: string[];
}

/** "45m", "2h 10m", "3d 4h". */
export function fmtIn(h: number | null | undefined): string {
  if (h == null || !Number.isFinite(h)) return "";
  const m = Math.max(1, Math.round(h * 60));
  if (m < 60) return `${m}m`;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  if (hh < 24) return mm && hh < 10 ? `${hh}h ${mm}m` : `${hh}h`;
  const d = Math.floor(hh / 24);
  const rh = hh % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

/** A window as of now: once its reset has passed it is empty and starts again on the next turn. */
export function settle(win: PlanWindow | null | undefined): PlanWindow | null {
  if (!win) return null;
  if (win.reset == null) return { used: win.used ?? 0, reset: null };
  if (win.reset > 0) return { used: win.used, reset: win.reset };
  return { used: 0, reset: null };
}

function grown(win: PlanWindow | null, by: number): PlanWindow | null {
  return win && { ...win, used: Math.min(100, win.used + by) };
}

/**
 * Three views of a reading: as read (the best case, since usage only grows), expected (plus what the
 * account burns at its learned pace since) and worst (flat out since the reading).
 */
export function estimate(a: PlanAccount): Estimate {
  const age = Math.max(0, a.ageH ?? 0);
  const s = settle(a.s);
  const w = settle(a.w);
  const f = settle(a.f);
  const m = settle(a.m ?? null);
  const ext = a.extRate ?? 0;
  const extF = a.extFable ?? 0;
  return {
    age,
    stale: age > K.FRESH_H,
    read: { s, w, f, m },
    exp: {
      s: grown(s, (ext / K.F_RATIO) * age),
      w: grown(w, ext * age),
      f: grown(f, ext * extF * K.FABLE_PER_WEEK * age),
      m: grown(m, ext * age),
    },
    worst: {
      s: s && { ...s, used: age >= 4 ? 100 : Math.min(100, s.used + K.S_RATE * age) },
      w: grown(w, DRAIN_MAX * age),
      f: grown(f, DRAIN_MAX * K.FABLE_PER_WEEK * age),
      m: grown(m, DRAIN_MAX * age),
    },
  };
}

/**
 * Hours of continuous work before a wall, for agents burning `rate` % of the 5-hour window per hour.
 * The 5-hour window refills at its reset; the weekly room (in % of the week) doesn't.
 */
export function runwayH(s: PlanWindow | null, room: number, rate: number): number {
  if (rate <= 0) return Number.POSITIVE_INFINITY;
  const running = s && s.reset != null && s.reset > K.REFILL_H;
  let t = 0;
  let used = running ? s.used : 0;
  let end: number | null = running ? s.reset : null;
  let left = room;
  const perH = rate * K.F_RATIO;
  for (let i = 0; i < 60 && t < K.WEEK_H; i += 1) {
    if (end == null) end = t + K.FIVE_H;
    const toWall = (100 - used) / rate;
    const toEnd = end - t;
    const span = Math.min(toWall, toEnd);
    if (span * perH >= left) return t + left / perH;
    left -= span * perH;
    t += span;
    if (toWall < toEnd - 1e-9) return t;
    used = 0;
    end = null;
  }
  return t;
}

function blocked(tier: Fit["tier"], why: string, back?: number | null): Fit {
  return {
    ok: false,
    tier,
    why,
    back: back ?? Number.POSITIVE_INFINITY,
    room: 0,
    deadline: Number.POSITIVE_INFINITY,
    binding: "week",
    opusOnly: 0,
    fableUse: 0,
    wRoom: 0,
    fRoom: 0,
    sRoom: 0,
    runway: 0,
    sReset: null,
    load: 0,
  };
}

/** What an account offers one more agent of `model`, from one view of its windows. */
export function fit(a: PlanAccount, wins: Views, model: PlanModel = "other", extraLoad = 1): Fit {
  const fable = model === "fable";
  const { s, w, f, m } = wins;
  const limits = (a.limits ?? []).filter((limit) => limit.untilH > 0);
  if (a.status === "signed_out") return blocked(4, "signed out");
  if (a.status === "disabled") return blocked(4, "turned off");
  const whole = limits.find((limit) => limit.scope === "account");
  if (whole) return blocked(3, `Hit its limit · back in ${fmtIn(whole.untilH)}`, whole.untilH);
  const wRoom = w ? 100 - w.used : 100;
  if (wRoom <= K.MIN_ROOM) return blocked(3, `week used up · back in ${fmtIn(w?.reset)}`, w?.reset);
  const fableLimit = limits.find((limit) => limit.scope === "fable");
  const fRoom = f ? 100 - f.used : 100;
  const fableBlocked = !!fableLimit || (!!f && fRoom <= K.MIN_ROOM);
  const fableUse = fableBlocked ? 0 : Math.min(wRoom, fRoom / K.FABLE_PER_WEEK);
  if (fable && fableBlocked) {
    if (fableLimit && fableLimit.kind === "budget") return blocked(2, "Fable needs usage credits here", fableLimit.untilH);
    const back = fableLimit ? fableLimit.untilH : f?.reset ?? null;
    return blocked(2, `Fable full · back in ${fmtIn(back)}`, back);
  }
  const modelLimit = limits.find((limit) => limit.scope === "model");
  const mRoom = m ? 100 - m.used : 100;
  const mName = a.mName ?? "This model";
  if (!fable && (modelLimit || (m && mRoom <= K.MIN_ROOM))) {
    const back = modelLimit ? modelLimit.untilH : m?.reset ?? null;
    return blocked(2, `${mName} full · back in ${fmtIn(back)}`, back);
  }
  const wDeadline = w && w.reset != null ? w.reset : K.WEEK_H; // not started: its week starts with the turn
  let room = wRoom;
  let deadline = wDeadline;
  let binding: Fit["binding"] = "week";
  if (fable && fableUse < wRoom) {
    room = fableUse;
    deadline = f && f.reset != null ? f.reset : K.WEEK_H;
    binding = "fable";
  } else if (!fable && m && mRoom < wRoom) {
    room = mRoom;
    deadline = m.reset != null ? m.reset : K.WEEK_H;
    binding = "model";
  }
  const opusOnly = Math.max(0, wRoom - fableUse);
  const rate = K.S_RATE * ((a.load ?? 0) + extraLoad);
  const runway = runwayH(s, room, rate);
  const sRoom = !s || s.reset == null || s.reset <= K.REFILL_H ? 100 : 100 - s.used;
  const base: Fit = {
    ok: true,
    tier: 0,
    back: 0,
    room,
    deadline,
    binding,
    opusOnly,
    fableUse,
    wRoom,
    fRoom,
    sRoom,
    runway,
    sReset: s ? s.reset : null,
    load: a.load ?? 0,
  };
  if (runway < K.BREATH_H) {
    return { ...base, tier: 1, why: `5h nearly out · refills in ${fmtIn(s?.reset)}`, back: s && s.reset != null ? s.reset : K.FIVE_H };
  }
  return base;
}

/**
 * Room at risk: sort the rooms by reset. Room k is at risk when the fleet, at its pace, must start
 * burning it and every room that resets before it within `horizonH` hours to burn them all in time
 * (the earliest-deadline-first test, on cumulated room). Those rooms go first, soonest reset first;
 * the rest is used side by side, most room first, so several accounts stay open for the busy hours.
 */
export function atRisk(rooms: ReadonlyArray<{ id: string; room: number; deadline: number }>, paceH: number | undefined, horizonH: number): Set<string> {
  const pace = Math.max(0.1, paceH ?? K.PACE);
  const sorted = rooms.filter((x) => x.room > K.MIN_ROOM && Number.isFinite(x.deadline)).sort((x, y) => x.deadline - y.deadline);
  let total = 0;
  const slack = sorted.map((x) => x.deadline - (total += x.room) / pace);
  const ids = new Set<string>();
  let tightest = Number.POSITIVE_INFINITY;
  for (let k = sorted.length - 1; k >= 0; k -= 1) {
    tightest = Math.min(tightest, slack[k]!);
    if (tightest <= horizonH) ids.add(sorted[k]!.id);
  }
  return ids;
}

function keyOf(v: Fit, req: PlanRequest, risky: boolean): number[] {
  if (v.tier > 1) return [v.back];
  if (v.tier === 1) return [v.back, -v.room];
  const keep = req.model !== "fable" && req.keepFable ? (v.opusOnly >= 1 ? 0 : 1) : 0;
  const order = risky ? [0, v.deadline] : [1, keep, -v.room];
  if (req.kind === "move") {
    const want = Math.min(req.remainingH ?? K.HOLD_H, K.HOLD_H);
    // An account that holds the agent for the rest of its work (or 4 h) comes first, in the plan's
    // order; failing that, the one that holds it longest, so it moves once rather than twice.
    return v.runway >= want ? [0, ...order, -v.runway] : [1, -v.runway];
  }
  // An account already carrying agents takes one more only if it carries them all for a while.
  return [K.NEW_HOLD_H > 0 && v.load > 0 && v.runway < K.NEW_HOLD_H ? 1 : 0, ...order, -v.runway];
}

function reasonOf(v: Fit, req: PlanRequest, risky: boolean, mName?: string | null): string {
  if (v.tier > 0) return v.why ?? "";
  const room = Math.round(v.room);
  const lasts = Number.isFinite(v.runway) && v.runway < 48 ? ` · full in ≈ ${fmtIn(v.runway)}` : "";
  const what =
    req.model === "fable" && v.binding === "fable" ? "of Fable " : v.binding === "model" && mName ? `of ${mName} ` : "";
  if (risky) return `Use first · ${room}% ${what}left, resets in ${fmtIn(v.deadline)}${lasts}`;
  if (req.model !== "fable" && req.keepFable && v.opusOnly >= 1) {
    // Fable's own window is fuller than the week here: this much of the week no Fable turn can use.
    return `Saves Fable's room · Fable can't use ${Math.round(v.opusOnly)}% of what's left here · resets in ${fmtIn(v.deadline)}${lasts}`;
  }
  return `${room}% ${what}left · resets in ${fmtIn(v.deadline)}${lasts}`;
}

function compare(x: { tier: number; key: number[]; prev: number }, y: { tier: number; key: number[]; prev: number }): number {
  if (x.tier !== y.tier) return x.tier - y.tier;
  for (let i = 0; i < Math.max(x.key.length, y.key.length); i += 1) {
    const d = (x.key[i] ?? 0) - (y.key[i] ?? 0);
    if (d) return d;
  }
  return x.prev - y.prev;
}

/** The fleet's at-risk rooms, from each usable account's week (whatever the model asking). */
function riskyOf(accounts: readonly PlanAccount[], req: PlanRequest): Set<string> {
  const rooms: Array<{ id: string; room: number; deadline: number }> = [];
  for (const a of accounts) {
    const e = estimate(a);
    const v = fit(a, e.exp, "other");
    if (!v.ok) continue;
    const w = e.exp.w;
    rooms.push({ id: a.id, room: v.wRoom, deadline: w && w.reset != null ? w.reset : Number.POSITIVE_INFINITY });
  }
  return atRisk(rooms, req.paceH, req.horizonH ?? 24);
}

function badgesOf(row: Ranked, req: PlanRequest): string[] {
  const b: string[] = [];
  if (row.e.stale) b.push(`read ${fmtIn(row.e.age)} ago`);
  const f = row.e.exp.f;
  if (req.model !== "fable" && f && 100 - f.used <= K.MIN_ROOM) b.push("Fable full");
  if ((row.a.load ?? 0) > 0) b.push(`${row.a.load} busy`);
  return b;
}

/** The order for one request, best first. */
export function rank(accounts: readonly PlanAccount[], req: PlanRequest = {}): Ranked[] {
  const r: PlanRequest = { model: "other", kind: "new", ...req };
  const prev = r.prev ?? [];
  const risky = riskyOf(accounts, r);
  const exclude = new Set(r.exclude ?? []);
  const pool = r.pool ? new Set(r.pool) : null;
  const manual = r.manual ?? null;
  const rows: Ranked[] = accounts
    .filter((a) => !exclude.has(a.id))
    .map((a, i) => {
      const e = estimate(a);
      const v = fit(a, e.exp, r.model);
      const p = prev.indexOf(a.id);
      const rk = risky.has(a.id);
      return {
        ...v,
        id: a.id,
        name: a.name,
        a,
        e,
        risky: rk,
        key: keyOf(v, r, rk),
        why: reasonOf(v, r, rk, a.mName),
        prev: p < 0 ? 100 + i : p,
        outside: pool ? !pool.has(a.id) : false,
        tight: false,
        badges: [],
      };
    });
  // A dragged order is an explicit choice: usable accounts follow it, full ones are skipped, never forced.
  if (manual) {
    for (const row of rows) {
      if (row.tier !== 0) continue;
      const m = manual.indexOf(row.id);
      row.key = [m < 0 ? 999 : m];
      row.risky = false;
      row.why = reasonOf(row, r, false, row.a.mName);
    }
  }
  const kept = pool && r.overflow === false ? rows.filter((row) => !row.outside) : rows;
  kept.sort((x, y) => Number(x.outside) - Number(y.outside) || compare(x, y));
  // When every usable account's room is at risk, "Use first" on each row says nothing: the order stays
  // (soonest reset first) and the screen says it once.
  const usable = kept.filter((row) => row.ok && !row.outside);
  const tight = usable.length > 1 && usable.every((row) => row.risky);
  for (const row of kept) {
    row.tight = tight;
    if (tight && row.ok) row.why = reasonOf(row, r, false, row.a.mName);
    row.badges = badgesOf(row, r);
  }
  return kept;
}

/**
 * Which readings could change the pick, so they are re-read first. Usage only grows, so an account
 * below the pick can't overtake it on a re-read; only the pick and its fallback (if stale) and
 * accounts with no reading at all can change the answer.
 */
export function toRefresh(accounts: readonly PlanAccount[], req: PlanRequest = {}): string[] {
  const r: PlanRequest = { model: "other", kind: "new", ...req };
  const rows = rank(accounts, r);
  const ids: string[] = [];
  rows.slice(0, 2).forEach((row, i) => {
    if (!row.e.stale || !row.ok) return;
    const worst = fit(row.a, row.e.worst, r.model);
    const next = rows[i + 1];
    const tmp = { tier: worst.tier, key: keyOf(worst, r, row.risky), prev: -1 };
    if (!worst.ok || (next && compare(tmp, { tier: next.tier, key: next.key, prev: 0 }) > 0)) ids.push(row.id);
  });
  for (const row of rows) if (row.a.noReading && !ids.includes(row.id)) ids.push(row.id);
  return ids;
}

// ---------------------------------------------------------------- the week ahead

export interface ForecastOptions {
  hours?: number;
  fableShare?: number;
  /** % of one account-week per hour, fleet-wide: flat, or one value per hour of the day. */
  pace?: number | readonly number[];
  startHour?: number;
  horizonH?: number;
  keepFable?: boolean;
  /** What the policy believes the pace is; the demand may differ. */
  policyPace?: number;
}

export interface Forecast {
  blocked: { fable: number; other: number };
  served: { fable: number; other: number };
  lost: number;
  blockedTotal: number;
}

/**
 * The week ahead, as a fluid: hour by hour, demand is spread over the accounts by a policy, each
 * account burning at most DRAIN_MAX. Returns what is lost at each reset and what demand finds no room.
 */
export function forecast(accounts: readonly PlanAccount[], opts: ForecastOptions = {}): Forecast {
  const H = opts.hours ?? K.WEEK_H;
  const share = opts.fableShare ?? 0;
  const pace = opts.pace ?? K.PACE;
  const paceAt = (t: number) => (typeof pace === "number" ? pace : pace[((opts.startHour ?? 0) + t) % pace.length] ?? K.PACE);
  const horizon = opts.horizonH ?? 24;
  const keepFable = !!opts.keepFable;
  let avg = 0;
  for (let h = 0; h < 24; h += 1) avg += paceAt(h);
  avg /= 24;
  const policyPace = opts.policyPace ?? avg;
  const st = accounts.map((a) => {
    const e = estimate(a);
    const w = e.exp.w ?? { used: 0, reset: null };
    const f = e.exp.f;
    const live = (a.limits ?? []).filter((limit) => limit.untilH > 0);
    const until = (scope: PlanLimit["scope"]) => live.filter((l) => l.scope === scope).reduce((m, l) => Math.max(m, l.untilH), 0);
    return {
      id: a.id,
      out: a.status !== "ready",
      acctUntil: until("account"),
      fableUntil: until("fable"),
      w: w.used,
      wEnd: w.reset,
      f: f ? f.used : null,
      fEnd: f ? f.reset : null,
      ext: a.extRate ?? 0,
      extF: a.extFable ?? 0,
      lost: 0,
      cap: 0,
    };
  });
  type Sim = (typeof st)[number];
  const blockedTotals = { fable: 0, other: 0 };
  const served = { fable: 0, other: 0 };
  const take = (a: Sim, x: number, fableShare: number, t: number) => {
    if (x <= 0) return;
    a.w += x;
    if (a.wEnd == null) a.wEnd = t + K.WEEK_H;
    if (a.f != null) {
      a.f = Math.min(100, a.f + x * fableShare * K.FABLE_PER_WEEK);
      if (a.fEnd == null) a.fEnd = t + K.WEEK_H;
    }
  };
  for (let t = 0; t < H; t += 1) {
    for (const a of st) {
      if (a.wEnd != null && a.wEnd <= t) {
        if (a.w < 100) a.lost += 100 - a.w;
        a.w = 0;
        a.wEnd = null;
      }
      if (a.f != null && a.fEnd != null && a.fEnd <= t) {
        a.f = 0;
        a.fEnd = null;
      }
      a.cap = a.out || a.acctUntil > t ? 0 : DRAIN_MAX;
      if (a.cap > 0 && a.ext > 0) take(a, Math.min(a.ext, a.cap, 100 - a.w), a.extF, t);
    }
    const D = paceAt(t);
    let dF = D * share;
    let dO = D - dF;
    const fRoomOf = (a: Sim) => (a.f == null ? 100 : 100 - a.f) / K.FABLE_PER_WEEK;
    const fableOk = (a: Sim) => a.cap > 0 && a.fableUntil <= t && 100 - a.w > 1e-9 && fRoomOf(a) > 1e-9;
    const dl = (a: Sim) => (a.wEnd == null ? t + K.WEEK_H : a.wEnd);
    const roomOf = (a: Sim) => 100 - a.w;
    const risky = atRisk(
      st.filter((a) => a.cap > 0).map((a) => ({ id: a.id, room: roomOf(a), deadline: a.wEnd == null ? Number.POSITIVE_INFINITY : a.wEnd - t })),
      policyPace,
      horizon,
    );
    const fableSpare = (a: Sim) => (a.fableUntil > t || fRoomOf(a) <= 1e-9 ? 0 : 1);
    const sorter = (fable: boolean) => (x: Sim, y: Sim) => {
      const sx = risky.has(x.id) ? 0 : 1;
      const sy = risky.has(y.id) ? 0 : 1;
      if (sx !== sy) return sx - sy;
      if (sx === 0) return dl(x) - dl(y);
      return (!fable && keepFable ? fableSpare(x) - fableSpare(y) : 0) || roomOf(y) - roomOf(x);
    };
    // Fable first: it can go to fewer places. A slice at a time, so side-by-side use really spreads.
    const SLICES = 4;
    for (let k = 0; k < SLICES; k += 1) {
      let wantF = (D * share) / SLICES;
      let wantO = (D * (1 - share)) / SLICES;
      for (const a of st.filter(fableOk).sort(sorter(true))) {
        if (wantF <= 1e-9) break;
        const x = Math.min(wantF, a.cap, 100 - a.w, fRoomOf(a));
        take(a, x, 1, t);
        a.cap -= x;
        wantF -= x;
        dF -= x;
        served.fable += x;
      }
      for (const a of st.filter((b) => b.cap > 1e-9 && 100 - b.w > 1e-9).sort(sorter(false))) {
        if (wantO <= 1e-9) break;
        const x = Math.min(wantO, a.cap, 100 - a.w);
        take(a, x, 0, t);
        a.cap -= x;
        wantO -= x;
        dO -= x;
        served.other += x;
      }
    }
    blockedTotals.fable += Math.max(0, dF);
    blockedTotals.other += Math.max(0, dO);
  }
  const lost = st.reduce((sum, a) => sum + a.lost, 0);
  return { blocked: blockedTotals, served, lost, blockedTotal: blockedTotals.fable + blockedTotals.other };
}

/** -Infinity: side by side only. */
export const HORIZONS = [Number.NEGATIVE_INFINITY, 0, 12, 24, 48, 96] as const;
export const PACE_CASES = [0.6, 1, 1.4] as const;

export interface Plan {
  horizonH: number;
  keepFable: boolean;
  paceH: number;
  regime: "scarce" | "surplus";
  /** Hours the fleet's weekly room lasts at the learned pace. */
  fleetRunwayH: number;
}

/**
 * Model-predictive planning, re-run every hour on fresh readings: each "use first" horizon (with and
 * without keeping Fable's room for Fable) is played on the coming week at the learned pace, 40 %
 * calmer and 40 % busier. Kept: the one that blocks the least in the usual and busier weeks; then
 * the one that loses the least at resets. "safe" breaks ties with the shortest horizon (it keeps the
 * most accounts open); "thrifty" with the longest (soonest reset first, least waste).
 */
export function plan(accounts: readonly PlanAccount[], opts: ForecastOptions & { prefer?: "safe" | "thrifty" } = {}): Plan {
  const base = opts.pace ?? K.PACE;
  const avg = typeof base === "number" ? base : base.reduce((sum, x) => sum + x, 0) / Math.max(1, base.length);
  const scale = (k: number) => (typeof base === "number" ? base * k : base.map((x) => x * k));
  const runs = HORIZONS.flatMap((horizonH) => [false, true].map((keepFable) => ({ horizonH, keepFable }))).map((strategy) => {
    const cases = PACE_CASES.map((k) => forecast(accounts, { ...opts, ...strategy, pace: scale(k), policyPace: avg }));
    return { ...strategy, cases };
  });
  const busy = (x: (typeof runs)[number]) => x.cases[1]!.blockedTotal + x.cases[2]!.blockedTotal;
  const waste = (x: (typeof runs)[number]) => x.cases[0]!.lost + x.cases[1]!.lost;
  const minB = Math.min(...runs.map(busy));
  const calm = runs.filter((x) => busy(x) <= minB + 0.5);
  const minL = Math.min(...calm.map(waste));
  const ties = opts.prefer === "thrifty" ? [...calm].reverse() : calm;
  const best = ties.find((x) => waste(x) <= minL + 0.5) ?? runs[0]!;
  let room = 0;
  for (const a of accounts) {
    if (a.status !== "ready") continue;
    const w = estimate(a).exp.w;
    room += w ? 100 - w.used : 100;
  }
  return {
    horizonH: best.horizonH,
    keepFable: best.keepFable,
    paceH: avg,
    regime: best.cases[1]!.blockedTotal > 0.5 ? "scarce" : "surplus",
    fleetRunwayH: room / Math.max(0.1, avg),
  };
}

// ---------------------------------------------------------------- moves between turns

export type MoveReason = "model" | "wall" | "wall-soon" | "unchecked" | "order";

export interface MoveAgent {
  /** The account its session runs on. */
  account: string;
  model: PlanModel;
  remainingH?: number;
}

export interface Move {
  reason: MoveReason;
  target: string | null;
  why?: string;
  outside?: boolean;
}

/**
 * Should a running agent move before its next turn? For a wall it would hit, a model its account
 * can't serve, an account the user unchecked for it, or an order the user dragged; and only to an
 * account that does better. Callers leave Codex threads out: they can't move.
 */
export function shouldMove(agent: MoveAgent, accounts: readonly PlanAccount[], opts: PlanRequest & { turnH?: number } = {}): Move | null {
  const here = accounts.find((a) => a.id === agent.account);
  if (!here) return null;
  const e = estimate(here);
  const v = fit({ ...here, load: Math.max(0, (here.load ?? 1) - 1) }, e.exp, agent.model);
  const soon = opts.turnH ?? 1 / 6;
  let reason: MoveReason | null = null;
  if (!v.ok && v.tier === 2) reason = "model";
  else if (!v.ok) reason = "wall";
  else if (v.runway < soon) reason = "wall-soon";
  else if (opts.pool && !opts.pool.includes(agent.account)) reason = "unchecked";
  if (!reason && opts.manual) {
    const first = rank(accounts, { ...opts, model: agent.model, kind: "move", remainingH: agent.remainingH }).find(
      (r) => !r.outside && r.ok && r.tier === 0,
    );
    if (first && first.id !== agent.account) return { reason: "order", target: first.id, why: first.why, outside: false };
  }
  if (!reason) return null;
  const rows = rank(accounts, { ...opts, model: agent.model, kind: "move", remainingH: agent.remainingH, exclude: [agent.account] });
  // Inside the agent's accounts first; outside them only for a real wall, and only if overflow is allowed.
  const inside = rows.filter((r) => !r.outside);
  const outsideOk = (reason === "wall" || reason === "model") && opts.overflow !== false;
  const target =
    inside.find((r) => r.ok && r.tier === 0) ??
    (reason === "wall-soon" ? undefined : inside.find((r) => r.ok) ?? (outsideOk ? rows.find((r) => r.ok) : undefined));
  if (!target) return { reason, target: null };
  if (reason === "wall-soon" && target.runway <= v.runway) return null;
  return { reason, target: target.id, why: target.why, outside: target.outside };
}
