/**
 * Multi-mode schedule optimizer:
 *   - 6T Single-slot (1 deck, 6 actions): 60 distinct orders for 3/2/1.
 *   - 12T Single-slot (2 consecutive decks, 12 actions): 60 × 60 = 3,600 deck-valid orders
 *     (each 6-turn cycle draws one full 3/2/1 deck, syncing 4-turn buff cycles with 6-card decks).
 *   - 6T Double-slot (2 decks across 6 turns, 12 actions): 13,860 distinct orders for 6/4/2.
 *
 * Every candidate is simulated with the same verified engine (state carries across turns),
 * and reports both raw total damage and normalized 6-skill wheel damage.
 */
import type { Preset } from "../config/preset-types";
import { simulateExpected, simulateScenario, type CoinMode, type MonteCarloStats, type SimulationData, type SimulationResult } from "./simulator";

export interface ScheduleCandidate {
  /** entryIds per turn (length = turns, each with 1 or 2 entries). */
  turns: string[][];
  total: number;
  /** Total damage normalized to a standard 6-skill wheel (total * 6 / totalActions). */
  wheelTotal: number;
  direct: number;
  dotHp: number;
  exact: boolean;
  /** Expected-value stats (rankBy "expected" only): Monte Carlo with common random numbers. */
  ev?: Pick<MonteCarloStats, "samples" | "mean" | "std" | "p10" | "p50" | "p90">;
  /** ev.mean normalized to a 6-skill wheel. */
  evWheel?: number;
}

export interface OptimizeResult {
  slots: 1 | 2;
  turns: number;
  evaluated: number;
  truncated: boolean;
  best: ScheduleCandidate | null;
  worst: ScheduleCandidate | null;
  top: ScheduleCandidate[];
  bestResult: SimulationResult | null;
  /** Ranking key used (default "allHeads" = deterministic coinMode total). */
  rankBy?: "allHeads" | "expected";
  /** Wall time of the optimization in ms. */
  elapsedMs?: number;
}

export interface ExpectedRankOptions {
  /** Screening samples per candidate (default 16). */
  samples?: number;
  /** Re-evaluate the best `refineTop` screened candidates with `refineSamples` samples (defaults 15 / 150). */
  refineTop?: number;
  refineSamples?: number;
  /** Seed shared by every candidate (common random numbers; default 20261030). */
  seed?: number;
  /**
   * Candidate spaces above max(prefilter, 600) (12T single 3,600 / 6T double 13,860): only the `prefilter` best by the
   * deterministic total (default 120) are Monte Carlo-screened, to keep runtime reasonable.
   */
  prefilter?: number;
}

function* multisetPermutations(items: string[]): Generator<string[]> {
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it, (counts.get(it) ?? 0) + 1);
  const keys = [...counts.keys()];
  const cur: string[] = [];
  function* rec(): Generator<string[]> {
    if (cur.length === items.length) {
      yield [...cur];
      return;
    }
    for (const k of keys) {
      const c = counts.get(k)!;
      if (c === 0) continue;
      counts.set(k, c - 1);
      cur.push(k);
      yield* rec();
      cur.pop();
      counts.set(k, c);
    }
  }
  yield* rec();
}

function* candidateOrders(poolPerDeck: string[], turns: number, slots: 1 | 2): Generator<string[]> {
  const need = turns * slots;
  if (poolPerDeck.length === 0) return;

  // When single-slot and turns is a multiple of deck size (e.g. 12T = 2 consecutive 6-card decks),
  // enumerate valid deck-by-deck draws (60 × 60 = 3,600) so you never draw 2×S3 in the same 6T deck.
  if (slots === 1 && poolPerDeck.length > 0 && turns === poolPerDeck.length * 2) {
    const singleDeckOrders = [...multisetPermutations(poolPerDeck)];
    for (const d1 of singleDeckOrders) {
      for (const d2 of singleDeckOrders) {
        yield [...d1, ...d2];
      }
    }
    return;
  }

  const items: string[] = [];
  const bag: string[] = [];
  for (const id of poolPerDeck) {
    for (let s = 0; s < slots; s++) bag.push(id);
  }
  for (let i = 0; items.length < need && bag.length; i++) items.push(bag[i % bag.length]!);
  yield* multisetPermutations(items);
}

export function optimizeSchedule(
  data: SimulationData,
  preset: Preset,
  opts: {
    slots: 1 | 2;
    coinMode?: CoinMode;
    turns?: number;
    maxCandidates?: number;
    topN?: number;
    /** "expected": rank by Monte Carlo mean (CRN, screen + refine); default "allHeads" ranks by the deterministic total. */
    rankBy?: "allHeads" | "expected";
    expected?: ExpectedRankOptions;
  },
): OptimizeResult {
  const t0 = Date.now();
  const rankBy = opts.rankBy ?? "allHeads";
  const evOpt = opts.expected ?? {};
  const evSeed = evOpt.seed ?? 20261030;
  const evSamples = Math.max(1, Math.trunc(evOpt.samples ?? 16));
  const refineTop = Math.max(0, Math.trunc(evOpt.refineTop ?? 15));
  const refineSamples = Math.max(evSamples, Math.trunc(evOpt.refineSamples ?? 150));
  const prefilter = Math.max(refineTop, Math.trunc(evOpt.prefilter ?? 120));
  /** Up to this many candidates every one is Monte Carlo-screened; beyond it the deterministic prefilter applies. */
  const prefilterFrom = Math.max(prefilter, 600);
  const key = (c: ScheduleCandidate) => (rankBy === "expected" ? c.ev?.mean ?? c.total : c.total);
  const turns = opts.turns ?? 6;
  const slots = opts.slots;
  const maxCandidates = opts.maxCandidates ?? 20000;
  const topN = opts.topN ?? 10;
  const poolPerDeck: string[] = [];
  for (const e of preset.skillGroups.base) {
    const n = Math.max(0, e.usesPerCycle);
    for (let i = 0; i < n; i++) poolPerDeck.push(e.entryId);
  }
  const totalActions = Math.max(1, turns * slots);
  const wheelScale = 6 / totalActions;

  let best: ScheduleCandidate | null = null;
  let worst: ScheduleCandidate | null = null;
  let evaluated = 0;
  let truncated = false;
  const pool: ScheduleCandidate[] = [];
  const schedulePreset = (c: ScheduleCandidate): Preset => ({
    ...preset,
    simulation: {
      ...preset.simulation, mode: "orderedCycle", turnCount: turns,
      actionSchedule: c.turns.flatMap((ids, t) => ids.map((entryId, k) => ({ turn: t + 1, order: k + 1, entryId }))),
    },
  });

  for (const order of candidateOrders(poolPerDeck, turns, slots)) {
    if (evaluated >= maxCandidates) {
      truncated = true;
      break;
    }
    const schedule = order.map((entryId, idx) => ({ turn: Math.floor(idx / slots) + 1, order: (idx % slots) + 1, entryId }));
    const candidatePreset: Preset = {
      ...preset,
      simulation: { ...preset.simulation, mode: "orderedCycle", turnCount: turns, actionSchedule: schedule },
    };
    const r = simulateScenario(data, candidatePreset, { coinMode: opts.coinMode ?? "allHeads" });
    evaluated++;
    const cand: ScheduleCandidate = {
      turns: Array.from({ length: turns }, (_, t) => order.slice(t * slots, t * slots + slots)),
      total: r.totals.total,
      wheelTotal: Math.round(r.totals.total * wheelScale * 10) / 10,
      direct: r.totals.direct,
      dotHp: r.totals.dotHp,
      exact: r.exact,
    };
    if (rankBy === "expected" && evaluated <= prefilterFrom) setEv(cand, simulateExpected(data, candidatePreset, { samples: evSamples, seed: evSeed }), wheelScale);
    pool.push(cand);
    if (rankBy !== "expected") {
      if (!best || cand.total > best.total) best = cand;
      if (!worst || cand.total < worst.total) worst = cand;
    }
  }
  let ranked: ScheduleCandidate[] = pool;
  if (rankBy === "expected") {
    // Large spaces: keep the `prefilter` best by the deterministic total, then Monte Carlo-screen only those.
    if (pool.length > prefilterFrom) {
      ranked = [...pool].sort((a, b) => b.total - a.total).slice(0, prefilter);
      for (const c of ranked) if (!c.ev) setEv(c, simulateExpected(data, schedulePreset(c), { samples: evSamples, seed: evSeed }), wheelScale);
    }
    ranked.sort((a, b) => key(b) - key(a));
    worst = ranked[ranked.length - 1] ?? null;
    if (refineTop > 0 && refineSamples > evSamples) {
      // Refine: re-estimate the screened leaders with more samples (same seed → common random numbers), then re-rank.
      ranked = ranked.slice(0, refineTop);
      for (const c of ranked) setEv(c, simulateExpected(data, schedulePreset(c), { samples: refineSamples, seed: evSeed }), wheelScale);
      ranked.sort((a, b) => key(b) - key(a));
    }
    best = ranked[0] ?? null;
  } else {
    ranked.sort((a, b) => b.total - a.total);
  }
  const top = ranked.slice(0, topN);
  let bestResult: SimulationResult | null = null;
  if (best) {
    const schedule = best.turns.flatMap((ids, t) => ids.map((entryId, k) => ({ turn: t + 1, order: k + 1, entryId })));
    bestResult = simulateScenario(
      data,
      { ...preset, simulation: { ...preset.simulation, mode: "orderedCycle", turnCount: turns, actionSchedule: schedule } },
      { coinMode: opts.coinMode ?? "allHeads" },
    );
  }
  return { slots, turns, evaluated, truncated, best, worst, top, bestResult, rankBy, elapsedMs: Date.now() - t0 };
}

function setEv(c: ScheduleCandidate, s: MonteCarloStats, wheelScale: number): void {
  c.ev = { samples: s.samples, mean: s.mean, std: s.std, p10: s.p10, p50: s.p50, p90: s.p90 };
  c.evWheel = Math.round(s.mean * wheelScale * 10) / 10;
}
