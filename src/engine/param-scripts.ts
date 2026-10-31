/**
 * Name-parameterised skill/coin scripts whose numbers are encoded in the script name
 * (e.g. CoinScaleAdder2IfFasterThanMainTargetMinDiff3 → +2 coin power if selfSpeed − targetSpeed ≥ 3).
 *
 * Semantics come from the IL2CPP classes (SkillAbility_CoinScaleAdderIfFasterThanMainTargetMinDiff.GetCoinScaleAdder:
 * (selfSpeed − mainTargetSpeed) ≥ _MIN_DIFFERENCE, numbers parsed from the script name by Regex in Init), and the
 * per-class _DEFAULT_RATIO constants (0.01 or 0.001) recorded in data/il2cpp/logic-index.json.
 */
import type { AbilityScript } from "../config/game-data";
import type { StatusContainer } from "./status";

/** Battle situation the user can set (scenario.battle). */
export interface BattleCtx {
  selfSpeed: number;
  targetSpeed: number;
  /** Number of enemy targets on the field (1 = single target). */
  targetCount: number;
  /** Opt-in: also count damage dealt to sub-targets (totals.subTarget). Default false. */
  countSubTargets?: boolean;
  /** Opt-in: add declared allies' joint/supportive attack damage (totals.ally) to the total. Default false. */
  countAllyDamage?: boolean;
  /** Actor's lost HP percentage (0–100). */
  lostHpPct: number;
  /** Allied identities / sinners declared present (ids or sinner keys). */
  allies: string[];
  /** Sin resonance counts by attribute (CRIMSON, SCARLET, AMBER, SHAMROCK, AZURE, INDIGO, VIOLET); missing = 0. */
  resonance: Record<string, number>;
  /** Highest perfect-resonance length (0 = none). */
  perfectResonance: number;
}

export interface ParamEffect {
  coinScale: number;
  basePower: number;
  finalPower: number;
  dmg: number;
  /** Explanation for the event log. */
  note?: string;
}

const ZERO: ParamEffect = { coinScale: 0, basePower: 0, finalPower: 0, dmg: 0 };

const POWER_KIND: Record<string, keyof Pick<ParamEffect, "coinScale" | "basePower" | "finalPower"> | null> = {
  CoinScaleAdder: "coinScale",
  SkillPowerAdder: "basePower",
  SkillPowerResultAdder: "finalPower",
  ParryingPowerResultAdder: null, // clash-only
  ParryingResultPowerAdder: null,
};
const PFX = "(CoinScaleAdder|SkillPowerResultAdder|SkillPowerAdder|ParryingPowerResultAdder|ParryingResultPowerAdder)";
const TIMING = "(?:OnUse|OnStartTurn)?";

const RE_MIN_DIFF = new RegExp(`^${PFX}${TIMING}(\\d*)${TIMING}IfFasterThan(?:MainTarget|MT)M(?:in)?Diff(\\d+)$`);
const RE_PER_DIFF = new RegExp(`^${PFX}${TIMING}(\\d*)${TIMING}IfFasterThanMT(?:PerSpeedDiff|SpeedPerDiff)(\\d+)(?:WithMax|Max)(\\d+)$`);
const RE_VIA_DIFF = new RegExp(`^${PFX}${TIMING}(\\d*)${TIMING}IfFasterViaSpeedDiffMax(\\d+)$`);
const RE_SPEED_GE = new RegExp(`^${PFX}${TIMING}(\\d*)${TIMING}If(?:Self)?SpeedNotLessThan(\\d+)$`);
const RE_SPEED_SUM = new RegExp(`^${PFX}${TIMING}(\\d*)${TIMING}IfBothSpeedSumNotLessThan(\\d+)$`);
const RE_NEG_GE = new RegExp(`^${PFX}(\\d*)OnUseNegativeBuffCount(\\d+)$`);
const RE_NEG_DIV = new RegExp(`^${PFX}(\\d*)OnUseDevideMTNegativeBuffCount(\\d+)WithLimit(\\d+)$`);

function power(kind: string, amount: number, note: string): ParamEffect {
  const k = POWER_KIND[kind];
  if (!k) return { ...ZERO, note: `${note}（仅拼点生效）` };
  return { ...ZERO, [k]: amount, note };
}

/** Count of active Negative-type statuses on a unit (BuffDetail negative buff count). */
export function negativeBuffCount(c: StatusContainer): number {
  return c.countByBuffType("Negative");
}

/**
 * Evaluate a name-parameterised script. Returns null when the name is not one of these families.
 * Scope "coin" only yields damage multipliers; "skill" yields power and damage.
 */
export function evalParamScript(
  script: AbilityScript,
  b: BattleCtx,
  actor: StatusContainer,
  target: StatusContainer,
): ParamEffect | null {
  const n = script.scriptName;
  // Whether a name belongs to one of these families depends only on the name (and buffKeyword presence): memoise misses.
  const missKey = script.buffData?.buffKeyword ? `${n}|k` : n;
  if (NOT_PARAM.has(missKey)) return null;
  const r = evalParamScriptImpl(script, b, actor, target);
  if (r === null) NOT_PARAM.add(missKey);
  return r;
}

const NOT_PARAM = new Set<string>();

function evalParamScriptImpl(
  script: AbilityScript,
  b: BattleCtx,
  actor: StatusContainer,
  target: StatusContainer,
): ParamEffect | null {
  const n = script.scriptName;
  const D = b.selfSpeed - b.targetSpeed;
  const amt = (s: string | undefined) => (s ? Number(s) : Math.round(script.value ?? 1)) || 1;
  let m: RegExpExecArray | null;

  if ((m = RE_MIN_DIFF.exec(n))) return power(m[1]!, D >= Number(m[3]) ? amt(m[2]) : 0, `速度差 ${D} ≥ ${m[3]}`);
  if ((m = RE_PER_DIFF.exec(n))) {
    const v = D > 0 ? Math.min(Number(m[4]), amt(m[2]) * Math.trunc(D / Number(m[3]))) : 0;
    return power(m[1]!, v, `速度差 ${D} 每 ${m[3]} +${amt(m[2])}（上限 ${m[4]}）`);
  }
  if ((m = RE_VIA_DIFF.exec(n))) return power(m[1]!, D > 0 ? Math.min(Number(m[3]), amt(m[2]) * D) : 0, `速度差 ${D}（上限 ${m[3]}）`);
  if ((m = RE_SPEED_GE.exec(n))) return power(m[1]!, b.selfSpeed >= Number(m[3]) ? amt(m[2]) : 0, `自身速度 ${b.selfSpeed} ≥ ${m[3]}`);
  if ((m = RE_SPEED_SUM.exec(n))) return power(m[1]!, b.selfSpeed + b.targetSpeed >= Number(m[3]) ? amt(m[2]) : 0, `双方速度和 ≥ ${m[3]}`);
  const N = negativeBuffCount(target);
  if ((m = RE_NEG_GE.exec(n))) return power(m[1]!, N >= Number(m[3]) ? amt(m[2]) : 0, `目标负面状态 ${N} ≥ ${m[3]}`);
  if ((m = RE_NEG_DIV.exec(n))) return power(m[1]!, Math.min(Number(m[4]), amt(m[2]) * Math.trunc(N / Number(m[3]))), `目标负面状态 ${N}÷${m[3]}（上限 ${m[4]}）`);

  // ---- damage multipliers (ratios from class _DEFAULT_RATIO)
  if ((m = /^AttackDmgUpByRatio(\d+)IfSelfSpeedNotLessThan(\d+)$/.exec(n))) {
    return { ...ZERO, dmg: b.selfSpeed >= Number(m[2]) ? Number(m[1]) * 0.01 : 0, note: `自身速度 ≥ ${m[2]}` };
  }
  if ((m = /^AttackDmgUpByRatio(\d+)IfFasterThanMTPerSpeedDiff(\d+)WithMax(\d+)$/.exec(n))) {
    const v = D > 0 ? Math.min(Number(m[3]), Number(m[1]) * Math.trunc(D / Number(m[2]))) : 0;
    return { ...ZERO, dmg: v * 0.001, note: `速度差 ${D}` };
  }
  if ((m = /^AttackDmgUpIfFasterThanEachTargetByRatio(\d+)$/.exec(n))) {
    return { ...ZERO, dmg: D > 0 ? Number(m[1]) * 0.01 : 0, note: `比目标快（速度差 ${D}）` };
  }
  if ((m = /^AttackDmgUp(\d+)PerNegativeBuffCountWithLimit(\d+)$/.exec(n)) || (m = /^AttackDmgUpByRatio(\d+)ViaNegativeBuffCntWithLimit(\d+)$/.exec(n))) {
    return { ...ZERO, dmg: Math.min(Number(m[2]), Number(m[1]) * N) * 0.001, note: `目标负面状态 ${N} 种` };
  }
  if ((m = /^AttackDmgUpByNegativeBuffCount_limit(\d+)$/.exec(n))) {
    return { ...ZERO, dmg: Math.min(Number(m[1]) * 0.01, (script.value ?? 0.01) * N), note: `目标负面状态 ${N} 种` };
  }
  // SkillAbility_AttackDmgUpNegativeBuffCountDivideWithLimit_<ratio>_<max>_<div>: Init ints → +0x70 ratio×0.01, +0x74 max×0.01,
  // +0x78 divisor; GetAttackDmgMultiplier = min(trunc(GetNegativeBuffCount(target) / div) × ratio, max), queried per hit.
  if ((m = /^AttackDmgUpNegativeBuffCountDivideWithLimit_(\d+)_(\d+)_(\d+)$/.exec(n))) {
    const k = Math.trunc(N / Math.max(1, Number(m[3])));
    return { ...ZERO, dmg: Math.min(k * Number(m[1]) * 0.01, Number(m[2]) * 0.01), note: `目标负面状态 ${N} 种 ÷${m[3]}` };
  }
  if ((m = /^DmgUpByBuffStackWithLimit(?:IfAlly)?(\d+)$/.exec(n)) && script.buffData?.buffKeyword) {
    const bd = script.buffData;
    const c = bd.buffOwner === "Target" ? target : actor;
    const v = Math.trunc(c.getPotency(bd.buffKeyword!) / Math.max(1, bd.stack ?? 1)) * (bd.value ?? 0);
    return { ...ZERO, dmg: Math.min(Number(m[1]) * 0.01, v), note: `${bd.buffKeyword} 层数加伤` };
  }
  if (/^AttackDmgUpOnlyWinDuel/.test(n)) return { ...ZERO, note: "仅拼点胜利触发" };
  // Target-count and super-coin scripts do not change damage on the main target in a single-target, unopposed fight.
  if (/^(?:\w*Ta(?:r)?getNum(?:Adder|Overwrite)\w*|\d+TargetNumAdder\w*|OverwriteToSuperCoin\w*)$/.test(n)) {
    return { ...ZERO, note: "只影响目标数 / 拼点" };
  }
  return null;
}
