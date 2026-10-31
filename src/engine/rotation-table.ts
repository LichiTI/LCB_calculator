/**
 * Rotation table: turns a simulation's event log into the spreadsheet-style rows players
 * keep in Excel — one row per cast / state variant, with the coin expression, the level fraction,
 * per-coin segmented multipliers (e.g. when a skill applies extra vulnerability mid-skill on
 * Listen Turn 2 so early coins get +10% and the reroll coin gets +20%), and configurable weights.
 */
import type { SimEvent, SimulationResult } from "./simulator";

export interface RotationCoin {
  index: number;
  isRerolled: boolean;
  critical: boolean;
  power: number;
  scale: number;
  dynMult: number;
  staticMult: number;
  damage: number;
  extraRatio?: number;
}

export interface RotationRow {
  key: string;
  turn: number;
  entryId: string;
  skillId: number;
  /** label hint used by the UI, e.g. "S3" */
  slotHint: string;
  coins: RotationCoin[];
  coinExpr: string;
  rollSum: number;
  offenseLevel: number;
  defenseLevel: number;
  delta: number;
  fracText: string;
  staticMult: number;
  /** First coin's dynamic multiplier. */
  dynMult: number;
  /** Formatted multiplier summary, e.g. "×1.80" or "×1.30→1.40" when mid-skill buffs change it. */
  dynMultText: string;
  /** Segmented roll×multiplier expression, e.g. "78 × 1.40" or "(51×1.30 + 27×1.40)". */
  segmentedRollExpr: string;
  levelDiffTerm: number;
  sinResTerm: number;
  atkResTerm: number;
  critTerm: number;
  crit: boolean;
  direct: number;
  extra: number;
  dotHp: number;
  damage: number;
  /** Exact unfloored float damage (community spreadsheet convention). */
  floatDamage: number;
  dotApplied: Record<string, { potency: number; count: number }>;
  formula: string;
}

const fmt2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/** Build one row per skill cast, in execution order. */
export function buildRotationRows(result: SimulationResult): RotationRow[] {
  const rows: RotationRow[] = [];
  let cur: RotationRow | null = null;
  let seq = 0;

  const newRow = (ev: SimEvent): RotationRow => {
    seq += 1;
    const row: RotationRow = {
      key: `${ev.turn}:${ev.entryId ?? "?"}:${ev.skillId ?? "?"}:${seq}`,
      turn: ev.turn,
      entryId: ev.entryId ?? "?",
      skillId: ev.skillId ?? 0,
      slotHint: (ev.entryId ?? "").toUpperCase(),
      coins: [],
      coinExpr: "",
      rollSum: 0,
      offenseLevel: 0,
      defenseLevel: 0,
      delta: 0,
      fracText: "",
      staticMult: 1,
      dynMult: 1,
      dynMultText: "×1.00",
      segmentedRollExpr: "",
      levelDiffTerm: 0,
      sinResTerm: 0,
      atkResTerm: 0,
      critTerm: 0,
      crit: false,
      direct: 0,
      extra: 0,
      dotHp: 0,
      damage: 0,
      floatDamage: 0,
      dotApplied: {},
      formula: "",
    };
    rows.push(row);
    return row;
  };

  for (const ev of result.events) {
    if (ev.kind === "useSkill") {
      cur = newRow(ev);
      continue;
    }
    if (ev.kind === "roundEnd") {
      cur = null;
      continue;
    }
    if (!cur) continue;
    if (ev.turn !== cur.turn) continue;

    if (ev.kind === "coin") {
      const b = ev.breakdown;
      const cDyn = b ? b.dynamicMultiplier : 1;
      const cStatic = b ? b.staticMultiplier : 1;
      const coin: RotationCoin = {
        index: ev.coinIndex ?? 0,
        isRerolled: ev.isRerolled === true,
        critical: ev.critical === true,
        power: ev.power ?? 0,
        scale: ev.coinScale ?? 0,
        dynMult: cDyn,
        staticMult: cStatic,
        damage: ev.damage ?? 0,
      };
      cur.coins.push(coin);
      cur.rollSum += coin.power;
      cur.direct += coin.damage;
      cur.floatDamage += b ? b.rawFloatDamage : coin.damage;
      if (coin.critical) cur.crit = true;
      cur.offenseLevel = ev.offenseLevel ?? cur.offenseLevel;
      cur.defenseLevel = ev.defenseLevel ?? cur.defenseLevel;
      if (b && cur.coins.length === 1) {
        cur.staticMult = b.staticMultiplier;
        cur.dynMult = b.dynamicMultiplier;
        cur.levelDiffTerm = b.levelDiffTerm;
        cur.sinResTerm = b.sinResTerm;
        cur.atkResTerm = b.atkResTerm;
        cur.critTerm = b.critTerm;
      }
      continue;
    }
    if (ev.kind === "extraDamage") {
      const dmg = ev.damage ?? 0;
      cur.extra += dmg;
      cur.floatDamage += ev.floatDamage ?? dmg;
      const lastCoin = cur.coins[cur.coins.length - 1];
      if (lastCoin && ev.extraRatio) {
        lastCoin.extraRatio = (lastCoin.extraRatio ?? 0) + ev.extraRatio;
      }
      continue;
    }
    if (ev.kind === "dot") {
      cur.dotHp += ev.damage ?? ev.dot?.hpDamage ?? 0;
      continue;
    }
    if (ev.kind === "status" && ev.status) {
      const dp = ev.status.after.potency - ev.status.before.potency;
      const dc = ev.status.after.count - ev.status.before.count;
      if (ev.status.target === "target" && (dp > 0 || dc > 0)) {
        const prev = cur.dotApplied[ev.status.statusId] ?? { potency: 0, count: 0 };
        cur.dotApplied[ev.status.statusId] = {
          potency: prev.potency + Math.max(0, dp),
          count: prev.count + Math.max(0, dc),
        };
      }
    }
  }

  for (const row of rows) {
    row.delta = row.offenseLevel - row.defenseLevel;
    const denom = Math.abs(row.delta) + 25;
    const numer = denom + row.delta;
    const extraStatic = row.sinResTerm + row.atkResTerm + row.critTerm;
    row.fracText =
      Math.abs(extraStatic) > 1e-4
        ? `(${numer}/${denom}${extraStatic > 0 ? `+${fmt2(extraStatic)}` : fmt2(extraStatic)})`
        : `(${numer}/${denom})`;
    row.coinExpr = row.coins
      .map((c) => `${c.power}${c.isRerolled ? "(重投)" : ""}`)
      .join("→");
    row.damage = row.direct + row.extra;
    row.floatDamage = Math.round(row.floatDamage * 100) / 100;

    // Group consecutive coins that share the same dynMult and extraRatio (so mid-skill buff changes & reroll ratio are explicit!)
    const segs: { powerSum: number; dyn: number; extraRatio: number }[] = [];
    for (const c of row.coins) {
      const er = c.extraRatio ?? 0;
      const last = segs[segs.length - 1];
      if (last && Math.abs(last.dyn - c.dynMult) < 1e-4 && Math.abs(last.extraRatio - er) < 1e-4) {
        last.powerSum += c.power;
      } else {
        segs.push({ powerSum: c.power, dyn: c.dynMult, extraRatio: er });
      }
    }
    const fmtSeg = (s: { powerSum: number; dyn: number; extraRatio: number }) =>
      s.extraRatio > 0
        ? `${s.powerSum}×${fmt2(s.dyn)}×${Number((1 + s.extraRatio).toFixed(2))}`
        : `${s.powerSum}×${fmt2(s.dyn)}`;
    if (segs.length <= 1) {
      const s0 = segs[0] ?? { powerSum: row.rollSum, dyn: row.dynMult, extraRatio: 0 };
      row.dynMult = s0.dyn;
      row.dynMultText = `×${fmt2(s0.dyn)}`;
      row.segmentedRollExpr = s0.extraRatio > 0 ? fmtSeg(s0) : `${row.rollSum} × ${fmt2(s0.dyn)}`;
    } else {
      row.dynMult = segs[0]!.dyn;
      const distinctDyns = segs.map((s) => `×${fmt2(s.dyn)}`).filter((v, i, a) => i === 0 || v !== a[i - 1]);
      row.dynMultText = distinctDyns.join("→");
      row.segmentedRollExpr = `(${segs.map(fmtSeg).join(" + ")})`;
    }
    const hasRatioInExpr = segs.some((s) => s.extraRatio > 0);
    row.formula = `${row.fracText} × ${row.segmentedRollExpr}${row.extra && !hasRatioInExpr ? ` +${row.extra}` : ""} = ${row.damage} (精确 ${row.floatDamage.toFixed(2)})`;
  }
  return rows;
}

export interface VariantRow extends RotationRow {
  /** Human-readable description of what makes this cast different, e.g. "T3 · 增伤×1.40" vs "T4 · 增伤×1.30→×1.40". */
  contextLabel: string;
  turns: number[];
  count: number;
}

/**
 * Group casts of the same skill that share the same multipliers into one variant row
 * (Excel style: "三技能 · 强化T1" / "三技能 · 强化T2"), keeping the turn list visible.
 */
export function groupRotationVariants(rows: RotationRow[], slotOf?: (skillId: number) => string | undefined): VariantRow[] {
  const bySkill = new Map<string, RotationRow[]>();
  for (const r of rows) {
    if (r.coins.length === 0) continue;
    const slot = slotOf?.(r.skillId) ?? r.slotHint;
    // Group upgraded counter-S3 (e.g. 1061706 -> S3) with the base S3 skill so identical S3 states merge cleanly
    const groupKey = slot === "S3" ? `slot:S3` : `id:${r.skillId}`;
    const list = bySkill.get(groupKey) ?? [];
    list.push(r);
    bySkill.set(groupKey, list);
  }
  const out: VariantRow[] = [];
  for (const [, list] of bySkill) {
    const buckets = new Map<string, RotationRow[]>();
    for (const r of list) {
      const sig = [
        r.crit ? "c" : "-",
        fmt2(r.staticMult),
        r.dynMultText,
        r.rollSum,
        r.extra,
        r.offenseLevel,
        r.defenseLevel,
      ].join("|");
      const arr = buckets.get(sig) ?? [];
      arr.push(r);
      buckets.set(sig, arr);
    }
    const multi = buckets.size > 1 || list.length > 1;
    for (const [, group] of buckets) {
      const head = group[0]!;
      const turns = group.map((g) => g.turn);
      const tags: string[] = [];
      if (head.crit) tags.push("全暴击");
      if (head.dynMultText !== "×1.00") tags.push(`增伤${head.dynMultText}`);
      if (head.dotHp > 0) tags.push(`DOT ${head.dotHp}`);
      const slot = slotOf?.(head.skillId) ?? head.slotHint;
      const idTag = multi && slot !== "S3" ? `#${head.skillId}` : "";
      const label = `${slot}${idTag}${multi ? ` · T${turns.join(",")}` : ""}${tags.length ? ` · ${tags.join(" · ")}` : ""}`;
      out.push({ ...head, slotHint: slot, contextLabel: label, turns, count: group.length });
    }
  }
  out.sort((a, b) => Math.min(...a.turns) - Math.min(...b.turns));
  return out;
}

export interface RotationTableOptions {
  /** Weight per row, keyed by row key. Defaults to occurrence count (or count * 6 / totalActions when normalizeToSixSkills is true). */
  weights?: Record<string, number>;
  /** When true, normalizes default weights to a 6-skill standard wheel (e.g. 12 actions -> divide counts by 2 -> 1.5, 0.5). */
  normalizeToSixSkills?: boolean;
}

export interface RotationTableResult {
  variants: VariantRow[];
  rows: RotationRow[];
  /** Total scheduled actions that landed coins. */
  actionCount: number;
  /** Scale factor applied when normalizing to a 6-skill wheel (6 / actionCount). */
  sixSkillScale: number;
  /** Weighted direct damage (coin hits + attributed extra damage, game floored). */
  totalDirect: number;
  /** Weighted unfloored float direct damage (community spreadsheet style). */
  totalFloatDirect: number;
  totalDot: number;
  /** totalDirect + DOT HP damage resolved by the simulation. */
  total: number;
  summaryLine: string;
  floatSummaryLine: string;
  dotApplied: Record<string, { potency: number; count: number }>;
  textBlock: string;
}

export function buildRotationTable(
  result: SimulationResult,
  slotOf?: (skillId: number) => string | undefined,
  options: RotationTableOptions = {},
): RotationTableResult {
  const rows = buildRotationRows(result);
  const activeRows = rows.filter((r) => r.coins.length > 0);
  const actionCount = activeRows.length;
  const sixSkillScale = options.normalizeToSixSkills && actionCount > 0 ? 6 / actionCount : 1;
  const variants = groupRotationVariants(rows, slotOf);
  const round2 = (n: number) => Math.round(n * 100) / 100;

  const weightOf = (v: VariantRow) => {
    const w = options.weights?.[v.key];
    if (typeof w === "number" && Number.isFinite(w)) return w;
    return round2(v.count * sixSkillScale);
  };

  const dotApplied: Record<string, { potency: number; count: number }> = {};
  let weightedDirect = 0;
  let weightedFloatDirect = 0;
  const terms: string[] = [];
  const floatTerms: string[] = [];
  for (const v of variants) {
    const w = weightOf(v);
    weightedDirect += v.damage * w;
    weightedFloatDirect += v.floatDamage * w;
    terms.push(`${v.damage}${w === 1 ? "" : `×${w}`}`);
    floatTerms.push(`${v.floatDamage.toFixed(2)}${w === 1 ? "" : `*${w}`}`);
    for (const [id, amt] of Object.entries(v.dotApplied)) {
      const prev = dotApplied[id] ?? { potency: 0, count: 0 };
      dotApplied[id] = { potency: round2(prev.potency + amt.potency * w), count: round2(prev.count + amt.count * w) };
    }
  }

  const totalDot = round2(result.totals.dotHp * sixSkillScale);
  const summaryLine = `${terms.join(" + ")} = ${round2(weightedDirect)}`;
  const floatSummaryLine = `${floatTerms.join(" + ")} = ${round2(weightedFloatDirect)}`;

  const textLines: string[] = [];
  textLines.push(
    `【轮伤精算】${result.coinMode === "allHeads" ? "满正（全正面）" : result.coinMode === "allTails" ? "全反面" : "期望"}${options.normalizeToSixSkills && actionCount !== 6 ? `（已由 ${actionCount} 动折算为 6 技能标准轮）` : ""}`,
  );
  for (const v of variants) {
    const w = weightOf(v);
    textLines.push(
      `${v.slotHint}(#${v.skillId})${w === 1 ? "" : `×${w}`}：${v.coinExpr} → ${v.rollSum} 点  ${v.formula}${v.turns.length > 0 ? `  (T${v.turns.join(",")})` : ""}`,
    );
  }
  textLines.push(`游戏取整直伤：${summaryLine}`);
  textLines.push(`社区小数直伤：${floatSummaryLine}`);
  if (totalDot > 0) textLines.push(`DOT 结算：${totalDot}`);
  textLines.push(`轮伤合计：${round2(weightedDirect + totalDot)}（小数 ${round2(weightedFloatDirect + totalDot)}）`);
  const dots = Object.entries(dotApplied).filter(([, v]) => v.potency > 0 || v.count > 0);
  if (dots.length) textLines.push(`一轮施加状态：${dots.map(([id, v]) => `${id} ${v.potency}-${v.count}`).join(" / ")}`);

  return {
    variants,
    rows,
    actionCount,
    sixSkillScale,
    totalDirect: round2(weightedDirect),
    totalFloatDirect: round2(weightedFloatDirect),
    totalDot,
    total: round2(weightedDirect + totalDot),
    summaryLine,
    floatSummaryLine,
    dotApplied,
    textBlock: textLines.join("\n"),
  };
}
