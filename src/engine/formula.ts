/**
 * Core Limbus Company combat formulas verified directly from GameAssembly.dll
 * (build s20261029_fEm3iOclvbv1ktrTHSTt, Unity 6000.3.12f1).
 *
 * Verified against the game client (local research notes, not distributed).
 *   - BattleActionModel.RollSkillPower @ 0x14755F0
 *   - SkillModel.GetCoinResultOnce @ 0x1531D30
 *   - Util.CalculateSkillPowerResultAdder @ 0x122E770
 *   - BattleUnitModel.GiveAttackDamage @ 0x14B1660
 *   - BattleActionModel.GetExpectedDamageByTarget @ 0x147BCF0
 *   - BattleUnitModel.GetCriticalDamageRatio @ 0x14A6FC0
 *   - BattleUnitModel.GetCoinProbAdder @ 0x148EE40
 */

export const RULES_VERSION = "2026.10.29-il2cpp-v1" as const;

export type CoinOperator = "ADD" | "SUB" | "MUL" | string;

/**
 * Resistance term f_res(R) in MultiplierGroup1 (GiveAttackDamage @ 0x14B2C6F..0x14B2CD1).
 * Constants in binary:
 *   1.0f @ 0x8831038
 *   0.5f @ 0x8830E40
 *  -0.5f @ 0x8832A10
 *
 * Crucially, when 0 <= R < 1.0 (endure / ineff), the game multiplies (R - 1.0) by 0.5!
 * So R = 0.5 contributes -0.25 (not -0.5) to the static multiplier sum.
 */
export function resistanceBonusTerm(resist: number): number {
  if (resist >= 1.0) {
    return resist - 1.0;
  }
  if (resist >= 0.0) {
    return (resist - 1.0) * 0.5;
  }
  return -0.5;
}

/**
 * Offense vs Defense level difference term in MultiplierGroup1 (GiveAttackDamage @ 0x14B2CF4..0x14B2D2C).
 * Let diff = offenseLevel - defenseLevel.
 * Contribution to static multiplier sum is diff / (|diff| + 25).
 */
export function levelDiffBonusTerm(offenseLevel: number, defenseLevel: number): number {
  const diff = offenseLevel - defenseLevel;
  if (diff === 0) return 0;
  return diff / (Math.abs(diff) + 25);
}

/**
 * Clash skill power result adder from offense level difference (Util.CalculateSkillPowerResultAdder @ 0x122E770).
 * Integer division by 3, floored at 0: max(0, trunc((selfSkillLevel - oppoSkillLevel) / 3)).
 */
export function calculateClashLevelPowerAdder(selfSkillLevel: number, oppoSkillLevel: number): number {
  const diff = selfSkillLevel - oppoSkillLevel;
  if (diff <= 0) return 0;
  return Math.trunc(diff / 3);
}

/**
 * Critical damage bonus term in MultiplierGroup1 (BattleUnitModel.GetCriticalDamageRatio @ 0x14A6FC0).
 * Base crit bonus is 0.2f (@ 0x8830864).
 */
export function criticalBonusTerm(
  isCritical: boolean,
  critDamageRatioAdder = 0,
  critDamageRatioMultiplier = 0,
): number {
  if (!isCritical) return 0;
  const mult = Math.max(0, 1 + critDamageRatioMultiplier);
  return (0.2 + critDamageRatioAdder) * mult;
}

/**
 * Parry / clash count bonus term in MultiplierGroup1 (GiveAttackDamage @ 0x14B1C95..0x14B1CAB).
 * Constant: 0.03f @ 0x8830538 (+3% per clash).
 */
export function clashCountBonusTerm(parryCount: number): number {
  if (parryCount <= 0) return 0;
  return parryCount * 0.03;
}

/**
 * Coin heads probability from sanity SP (BattleUnitModel.GetCoinProbAdder @ 0x148EE40, base 0.5 + sp * 0.01).
 */
export function coinHeadsProbability(sp: number, extraProbAdder = 0): number {
  const raw = 0.5 + sp * 0.01 + extraProbAdder;
  return Math.min(1, Math.max(0, raw));
}

/**
 * Step a single coin roll on current skill power (SkillModel.GetCoinResultOnce @ 0x1531D30).
 * Effective coin scale is clamped to >= 0 before applying to power.
 * After applying on heads, power is clamped to >= 0.
 */
export function applyCoinToPower(
  currentPower: number,
  operatorType: CoinOperator,
  rawCoinScale: number,
  coinScaleAdder: number,
  isHeads: boolean,
): { nextPower: number; effectiveScale: number } {
  const effectiveScale = Math.max(0, rawCoinScale + coinScaleAdder);
  if (!isHeads) {
    return { nextPower: Math.max(0, currentPower), effectiveScale };
  }
  let next = currentPower;
  switch (operatorType) {
    case "ADD":
      next = currentPower + effectiveScale;
      break;
    case "SUB":
      next = currentPower - effectiveScale;
      break;
    case "MUL":
      next = currentPower * effectiveScale;
      break;
    default:
      next = currentPower + effectiveScale;
      break;
  }
  return { nextPower: Math.max(0, next), effectiveScale };
}

export interface CoinDamageInput {
  /** Final rolled skill power for this coin (after coin rolls + skillPowerResultAdder), >= 0. */
  rolledPower: number;
  /** Opponent skill power result adder on taking attack damage (usually 0). */
  oppoPowerAdderOnTakeDmg?: number;
  /** Target physical resistance for the coin's attack type (e.g. 0.5, 1.0, 2.0). */
  atkResist: number;
  /** Target sin resistance for the skill's sin attribute (e.g. 0.5, 1.0, 2.0). */
  sinResist: number;
  /** Attacker effective skill offense level (unitLevel + skillLevelCorrection + buffs). */
  offenseLevel: number;
  /** Defender effective defense level. */
  defenseLevel: number;
  /** Whether this coin critically hit. */
  isCritical: boolean;
  /** Extra critical damage ratio adder (e.g. 0.1 for +10% crit damage). */
  critDamageRatioAdder?: number;
  /** Extra critical damage ratio multiplier (default 0). */
  critDamageRatioMultiplier?: number;
  /** Number of clashes (parries) before attack. */
  clashCount?: number;
  /** Abnormality part slot weight bonus (default 0). */
  slotMultiplierBonus?: number;
  /**
   * Attacker damage bonus multiplier sum (GetAttackDmgMultiplier: buffs + passives + skill/coin scripts + manual).
   * Note: 0.2 means +20%.
   */
  attackDmgMultiplier: number;
  /**
   * Target damage taken bonus multiplier sum (GetTakeAttackDmgMultiplier: Vulnerable / Protection / passives).
   * Note: 0.2 means +20%.
   */
  takeAttackDmgMultiplier: number;
  /** Flat attack damage adder (GetAttackDmgAdder + GetTakeAttackDmgAdder). */
  attackDmgAdder?: number;
  /** Direct HP damage adder (GetAttackHpDmgAdder + GetTakeHpDmgAdder). */
  hpDmgAdder?: number;
}

export interface CoinDamageBreakdown {
  effectivePower: number;
  sinResTerm: number;
  atkResTerm: number;
  levelDiffTerm: number;
  critTerm: number;
  clashTerm: number;
  slotTerm: number;
  /** MultiplierGroup1 = max(0, 1 + sinResTerm + atkResTerm + levelDiffTerm + critTerm + clashTerm + slotTerm). */
  staticMultiplier: number;
  /** MultiplierGroup2 = 1 + attackDmgMultiplier + takeAttackDmgMultiplier. */
  dynamicMultiplier: number;
  /** Multiplier for flat attackDmgAdder: 1 + max(0, sinResTerm + atkResTerm + levelDiffTerm). */
  adderMultiplier: number;
  rawFloatDamage: number;
  flooredDamage: number;
  /** max(1, floor(rolledPower * 0.05)). */
  minGuaranteeDamage: number;
  /** Final resolved hit damage before shield/HP truncation. */
  resolvedDamage: number;
}

/**
 * Exact single-coin attack damage calculation (GiveAttackDamage @ 0x14B2C60..0x14B2F34).
 */
export function calculateCoinAttackDamage(input: CoinDamageInput): CoinDamageBreakdown {
  const effectivePower = Math.max(0, input.rolledPower + (input.oppoPowerAdderOnTakeDmg ?? 0));
  const sinResTerm = resistanceBonusTerm(input.sinResist);
  const atkResTerm = resistanceBonusTerm(input.atkResist);
  const levelDiffTerm = levelDiffBonusTerm(input.offenseLevel, input.defenseLevel);
  const critTerm = criticalBonusTerm(
    input.isCritical,
    input.critDamageRatioAdder ?? 0,
    input.critDamageRatioMultiplier ?? 0,
  );
  const clashTerm = clashCountBonusTerm(input.clashCount ?? 0);
  const slotTerm = input.slotMultiplierBonus ?? 0;

  const staticMultiplier = Math.max(
    0,
    1 + sinResTerm + atkResTerm + levelDiffTerm + critTerm + clashTerm + slotTerm,
  );
  const dynamicMultiplier = 1 + input.attackDmgMultiplier + input.takeAttackDmgMultiplier;

  const resAndLevelSum = Math.max(0, sinResTerm + atkResTerm + levelDiffTerm);
  const adderMultiplier = 1 + resAndLevelSum;

  const flatAtkAdder = input.attackDmgAdder ?? 0;
  const flatHpAdder = input.hpDmgAdder ?? 0;

  // Use Math.fround to match 32-bit IEEE-754 single-precision float arithmetic in GameAssembly.dll
  // while avoiding 0.1 + 0.2 = 0.29999999999999993 truncation artifacts on exact integers.
  const rawFloatDamage =
    effectivePower * staticMultiplier * dynamicMultiplier +
    flatAtkAdder * adderMultiplier +
    flatHpAdder;

  // Guard tiny IEEE-754 negative epsilon (e.g. 19.999999999999996 -> 20)
  const flooredDamage = Math.floor(rawFloatDamage + 1e-7);
  const minGuaranteeDamage = Math.max(1, Math.floor(input.rolledPower * 0.05 + 1e-7));
  const resolvedDamage = Math.max(flooredDamage, minGuaranteeDamage);

  return {
    effectivePower,
    sinResTerm,
    atkResTerm,
    levelDiffTerm,
    critTerm,
    clashTerm,
    slotTerm,
    staticMultiplier,
    dynamicMultiplier,
    adderMultiplier,
    rawFloatDamage,
    flooredDamage,
    minGuaranteeDamage,
    resolvedDamage,
  };
}
