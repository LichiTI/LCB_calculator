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
import { simulateScenario, type CoinMode, type SimulationData, type SimulationResult } from "./simulator";

export interface ScheduleCandidate {
  /** entryIds per turn (length = turns, each with 1 or 2 entries). */
  turns: string[][];
  total: number;
  /** Total damage normalized to a standard 6-skill wheel (total * 6 / totalActions). */
  wheelTotal: number;
  direct: number;
  dotHp: number;
  exact: boolean;
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
  opts: { slots: 1 | 2; coinMode?: CoinMode; turns?: number; maxCandidates?: number; topN?: number },
): OptimizeResult {
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

  const ranked: ScheduleCandidate[] = [];
  let best: ScheduleCandidate | null = null;
  let worst: ScheduleCandidate | null = null;
  let evaluated = 0;
  let truncated = false;

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
    if (!best || cand.total > best.total) best = cand;
    if (!worst || cand.total < worst.total) worst = cand;
    ranked.push(cand);
    if (ranked.length > topN * 4) {
      ranked.sort((a, b) => b.total - a.total);
      ranked.length = topN;
    }
  }
  ranked.sort((a, b) => b.total - a.total);
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
  return { slots, turns, evaluated, truncated, best, worst, top, bestResult };
}
