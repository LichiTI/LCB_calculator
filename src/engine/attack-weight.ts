/*
 * Attack weight (攻击容量 / SkillModel target num) for the opt-in multi-target model.
 * Base = skill attrs.targetNum; static estimate of the common buffData-driven TagetNumAdder* / TargetNumAdder* skill scripts
 * (evaluated against the actor's statuses when the skill starts). Script handlers add runtime changes through
 * PassiveCtx.addAttackWeight / setAttackWeight (e.g. OverwriteTargetNum, WideAreaRampage).
 */
import type { ScriptData } from "./passives/framework";

interface StatusReader {
  getPotency(id: string): number;
  getCount(id: string): number;
}
interface SkillLike {
  attrs?: { targetNum?: number };
  abilityScripts?: ScriptData[];
}

/** buffData divisor count: floor(potency / stack) + floor(count / turn). */
function divCount(potency: number, count: number, bd: NonNullable<ScriptData["buffData"]>): number {
  let n = 0;
  if ((bd.stack ?? 0) > 0) n += Math.floor(potency / bd.stack!);
  if ((bd.turn ?? 0) > 0) n += Math.floor(count / bd.turn!);
  return n;
}

/**
 * Static attack weight: targetNum + Σ estimated adders. Families:
 * - …Per…(k)WithLimit(n) / …(k)…WithLimit(n): floor(have / per) × k, ≤ n (have = stack, or turn when bd.turn > 0);
 * - …DivideByBuffStack: floor(stack / bd.stack) + value, ≤ limit, only when > 0;
 * - …DivideByBuff / …ViaBuffCheck / others with buffData: divCount × (bd.value ?? 1), ≤ bd.limit;
 * Others (resonance / name-parameter forms without buffData) are listed in `unknown` (not estimated).
 */
export function staticAttackWeight(skill: SkillLike | null | undefined, self: StatusReader): { weight: number; unknown: string[] } {
  let w = Math.max(1, Number(skill?.attrs?.targetNum ?? 1) || 1);
  const unknown: string[] = [];
  for (const s of skill?.abilityScripts ?? []) {
    const n = s.scriptName;
    if (!/^Ta(?:r)?getNumAdder/.test(n)) continue;
    const bd = s.buffData;
    if (bd?.buffKeyword && bd.buffOwner !== "Target") {
      const pot = self.getPotency(bd.buffKeyword);
      const cnt = self.getCount(bd.buffKeyword);
      const per = /(\d+)?WithLimit(\d+)$/.exec(n);
      if (/DivideByBuffStack\d*$/.test(n)) {
        // SkillAbility_TargetNumAdderOnStartTurnDivideByBuffStack10716: + min(stack / bd.stack + value, limit) when > 0
        let v = Math.floor(pot / Math.max(1, bd.stack ?? 1)) + Math.round(bd.value ?? 0);
        if ((bd.limit ?? 0) > 0) v = Math.min(v, bd.limit!);
        if (v > 0) w += v;
      } else if (per) {
        const k = Number(per[1] ?? 1) || 1;
        const lim = Number(per[2]);
        const have = (bd.turn ?? 0) > 0 ? cnt : pot;
        const step = Math.max(1, (bd.turn ?? 0) > 0 ? bd.turn! : bd.stack ?? 1);
        w += Math.min(Math.floor(have / step) * k, lim);
      } else {
        const v = divCount(pot, cnt, bd) * (bd.value ?? 1);
        w += (bd.limit ?? 0) > 0 ? Math.min(v, bd.limit!) : v;
      }
    } else unknown.push(n);
  }
  return { weight: Math.max(1, w), unknown };
}

/**
 * (attack weight − alive targets hit) for the *LessThenTargetNum* family (CalcAttackDamageMultiplier: weight −
 * GetAliveTargetUnitModelList.Count). Uses the simulator's PassiveCtx.attackWeight when available.
 */
export function attackWeightDiff(c: {
  attackWeight?(): number;
  battle: { targetCount: number };
  skillData: unknown;
  actor: StatusReader;
}): { weight: number; alive: number; diff: number } {
  const weight = c.attackWeight?.() ?? staticAttackWeight(c.skillData as SkillLike, c.actor).weight;
  const alive = Math.max(1, Math.min(weight, c.battle.targetCount));
  return { weight, alive, diff: weight - alive };
}
