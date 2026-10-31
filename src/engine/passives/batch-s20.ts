/** Script/status batch 20 — see data/il2cpp/dossiers/scripts-20.md */
import { triggerVibrationExplosion, type StatusContainer } from "../status";
import { attackWeightDiff } from "../attack-weight";
import { noDamageScript, registerAbilities, registerScripts, type ScriptCtx, type ScriptData } from "./framework";

// Covered elsewhere (not re-registered here):
//  - GiveBuffOnSucceedAttackIfHasStack_FireBulletPropellant1 / _VibrationIgnition10 → batch-s03 RegExp family (checks buffData.buffOwner unit)
//  - SkillPowerAdderOnUseViaBuffCheckDevideByStackWithLimit5 → batch-s15 RegExp family
//  - status FireBulletPropellant: CheckNormalExtendedInitBulletBase → batch-s07; status HungrySinclair has no ability list

type BD = NonNullable<ScriptData["buffData"]>;
const owner = (c: ScriptCtx, bd: BD | undefined): StatusContainer => (bd?.buffOwner === "Self" ? c.actor : c.target);

function giveBD(c: ScriptCtx, bd: BD | undefined, stack = bd?.stack ?? 0, turn = bd?.turn ?? 0): void {
  if (!bd?.buffKeyword || (stack <= 0 && turn <= 0)) return;
  c.give(bd.target === "Self" ? "actor" : "target", bd.buffKeyword, stack, turn, bd.activeRound === 1 ? 1 : 0);
}

/** CoinAbility_VibrationExplosion.Explosion (only if target Vibration stack > 0) + LoseBuffTurn(Vibration, n). */
function vibrationExplosion(c: ScriptCtx, label: string, lose = 1): void {
  if (c.target.getPotency("Vibration") > 0) {
    const rec = triggerVibrationExplosion(c.target, c.turn, label);
    if (rec?.hpDamage) c.extraDamage(rec.hpDamage, `${label}（震颤-灼热）`);
  }
  if (lose > 0 && c.target.get("Vibration")) c.consume("target", "Vibration", lose);
}

/** Flag valid only for the current use of a skill (stored in the per-action scratch c.action.shared). */
let useFlagSeq = 0;
function useFlag() {
  const k = `s20:useFlag:${useFlagSeq++}`;
  return { set: (c: ScriptCtx) => void c.action.shared.set(k, true), has: (c: ScriptCtx) => c.action.shared.get(k) === true, clear: (c: ScriptCtx) => void c.action.shared.delete(k) };
}

// ---- Thumb Soldato Sinclair (11013): FireBulletPropellant (keyword 1048)
const FBP = "FireBulletPropellant";
const hasThreeBullets = (c: ScriptCtx) => c.actor.getPotency(FBP) >= 3;
/** SystemAbility 352 added by CheckHasThreeBullet this round, destroyed by ThumbSoldatoSinclair. */
const SYS352 = useFlag();
/** Bullets reserved by UseBullet on the current coin (c.action.shared); spent once the coin's effects resolved (next coin start / skill end). */
const PENDING_FBP = "s20:pendingFbp";
const pendingFbp = (c: ScriptCtx) => (c.action.shared.get(PENDING_FBP) as number | undefined) ?? 0;
function flushFbp(c: ScriptCtx): void {
  const n = pendingFbp(c);
  if (n <= 0) return;
  c.action.shared.delete(PENDING_FBP);
  c.lose("actor", FBP, Math.min(n, c.actor.getPotency(FBP)));
}

/** Additional HP damage = trunc(finalDmg × ratio), then GiveHpDamageAppliedAttributeResist / AtkResist (by `resist` label). */
const RESIST_OPTS: Record<string, import("./framework").ExtraDamageOpts> = { 暴怒: { sin: "CRIMSON" }, 暴食: { sin: "SHAMROCK" }, 斩击: { atkType: "SLASH" } };
function additionalDmg(name: string | RegExp, summary: string, ratio: (c: ScriptCtx) => number, cond: (c: ScriptCtx) => boolean, resist: string, allTargets = false) {
  return {
    name,
    summary,
    ...(allTargets ? { approx: "副目标视为与主要目标相同（开启“统计副目标伤害”时计入副目标）" } : {}),
    onCoinHit(c: ScriptCtx) {
      if (!cond(c)) return;
      const dmg = Math.trunc((c.lastHitDamage ?? 0) * ratio(c));
      if (dmg > 0) c.extraDamage(dmg, `${summary}`, allTargets ? { ...RESIST_OPTS[resist], allTargets } : RESIST_OPTS[resist]);
    },
  };
}

const SKILL_1110503 = useFlag();

registerScripts(
  // SkillAbility_AttackDmgMultiplierDevideCombustionAndVibration.AdderCalculation (OnStartTurn_AfterLog):
  // sum = target Combustion + Vibration stack; sum >= bd.stack → min(floor(sum / stack) × value, limit × 0.01)
  {
    name: "AttackDmgMultiplierDevideCombustionAndVibration",
    summary: "使用时目标烧伤与震颤强度之和每有N级，本技能伤害+value（有上限）",
    skillMods(c) {
      const bd = c.script.buffData;
      const st = Math.max(1, bd?.stack ?? 1);
      const sum = c.target.getPotency("Combustion") + c.target.getPotency("Vibration");
      if (sum < st) return;
      const d = Math.min(Math.floor(sum / st) * (bd?.value ?? 0), (bd?.limit ?? 0) * 0.01);
      return d > 0 ? { dmg: d } : undefined;
    },
  },

  // SkillAbility_AttackDmgMultiplierIfHasThreeBullet: self FireBulletPropellant stack >= 3 at use → dmg +jsonValue
  {
    name: "AttackDmgMultiplierIfHasThreeBullet",
    summary: "使用时灼热推进弹≥3则本技能伤害+value",
    skillMods(c) {
      return hasThreeBullets(c) ? { dmg: c.script.value ?? 0 } : undefined;
    },
  },
  // SkillAbility_ChangeAsSuperCoinInCaseHasThreeBullet.OnStartTurn_AfterLog: FBP(1048) ≥ 3 → every coin → SuperCoin (clash-only).
  {
    name: "ChangeAsSuperCoinInCaseHasThreeBullet",
    summary: "灼热推进弹≥3时硬币变为[SuperCoin]（不可被破坏，仅影响拼点）",
    onSkillStart(c) {
      if (hasThreeBullets(c)) c.coins?.makeSuper("all");
    },
  },
  // SkillAbility_CheckHasThreeBullet: FBP >= 3 at use → SystemAbility 352 this round (read by ThumbSoldatoSinclair)
  {
    name: "CheckHasThreeBullet",
    summary: "使用时灼热推进弹≥3则记录“本技能消耗3发”标记",
    skillMods(c) {
      if (hasThreeBullets(c)) SYS352.set(c);
      else SYS352.clear(c);
    },
  },
  // SkillAbility_SkillPowerAdderIfHasThreeBullet: FBP >= 3 at use → base power +jsonValue
  {
    name: "SkillPowerAdderIfHasThreeBullet",
    summary: "使用时灼热推进弹≥3则基础威力+value",
    skillMods(c) {
      return hasThreeBullets(c) ? { basePower: Math.round(c.script.value ?? 0) } : undefined;
    },
  },
  // SkillAbility_SkillPowerAdderIfTargetHasNotLessThenTenSpecialVibration: target Vibration-family stack >= 10 and
  // not plain Vibration (HasActivatedBuff(Vibration, exact)) → base power +jsonValue
  {
    name: "SkillPowerAdderIfTargetHasNotLessThenTenSpecialVibration",
    summary: "使用时目标特殊震颤强度≥10则基础威力+value",
    skillMods(c) {
      const v = c.target.get("Vibration");
      if (!v || v.id === "Vibration" || v.potency < 10) return;
      return { basePower: Math.round(c.script.value ?? 0) };
    },
  },
  // CoinAbility_ThumbSoldatoSinclair<N>: has SystemAbility 352 → (FBP buff check) explosion + target loses N Vibration turn; destroy 352
  {
    name: /^ThumbSoldatoSinclair(\d+)$/,
    summary: "若本技能使用时有3发灼热推进弹：命中时使目标震颤引爆并减少1层震颤",
    onCoinHit(c) {
      if (!SYS352.has(c)) return;
      const bd = c.script.buffData;
      if (bd?.buffKeyword && owner(c, bd).getPotency(bd.buffKeyword) < (bd.stack ?? 0)) return;
      vibrationExplosion(c, "推力集中 震颤引爆", Number(/(\d+)$/.exec(c.script.scriptName)![1]));
      SYS352.clear(c);
    },
  },
  // CoinAbility_UseBullet (optional): consume 1 FireBulletPropellant for this coin (coin-model consumption, after the coin's effects)
  {
    name: "UseBullet[optional:FireBulletPropellant:1]",
    summary: "本硬币消耗1发灼热推进弹（可选）",
    approx: "消耗在本硬币效果结算后进行（DmgUpByBuff/IfHasStack 按消耗前数量判定）",
    coinMods(c) {
      flushFbp(c);
    },
    onCoinHit(c) {
      if (c.isRerolled) return;
      const pend = pendingFbp(c);
      if (c.actor.getPotency(FBP) - pend >= 1) c.action.shared.set(PENDING_FBP, pend + 1);
    },
    onSkillEnd(c) {
      flushFbp(c);
    },
  },

  // SkillAbility_AttackDmgUpByRatioByLostHpRatioSelfAndTargetWithMax_<max>_<div>: (selfLost + targetLost) / (div×0.001) → RoundToInt
  // × jsonValue, cap max×0.001
  {
    name: /^AttackDmgUpByRatioByLostHpRatioSelfAndTargetWithMax_(\d+)_(\d+)$/,
    summary: "自身与目标已失去体力比例之和每有2%，本技能伤害+1%（最多50%）",
    coinMods(c) {
      const m = /_(\d+)_(\d+)$/.exec(c.script.scriptName)!;
      const max = Number(m[1]) * 0.001;
      const div = Number(m[2]) * 0.001;
      const lost = (1 - c.selfHpRatio()) + c.targetLostHpRatio();
      const d = Math.min(Math.round(lost / div) * (c.script.value ?? 0), max);
      return d > 0 ? { dmg: d } : undefined;
    },
  },
  additionalDmg("GiveAdditionalCrimsonDmgOnSAHTargetByRatio", "正面命中额外造成最终伤害×value的暴怒伤害", (c) => c.script.value ?? 0, (c) => Boolean(c.isHeads), "暴怒"),
  additionalDmg("GiveAdditionalShamrockDmgOnSAHTargetByRatio", "正面命中额外造成最终伤害×value的暴食伤害", (c) => c.script.value ?? 0, (c) => Boolean(c.isHeads), "暴食"),
  additionalDmg("GiveAdditionalShamrockDmgOnSAHToAllTargetByRatio", "正面命中对全体目标额外造成最终伤害×value的暴食伤害", (c) => c.script.value ?? 0, (c) => Boolean(c.isHeads), "暴食", true),

  // SkillAbility_AtkDmgUp1101503: (attack weight − alive targets) × jsonValue; weight = targetNum + TagetNumAdder* (BeforeAttack)
  {
    name: "AtkDmgUp1101503",
    summary: "攻击容量每高于目标数1点，本技能伤害+50%",
    approx: "攻击容量 = targetNum + TagetNumAdder* 估算（小指令层数按强度计）+ 脚本运行时增减；存活目标数取场景“目标数量”",
    coinMods(c) {
      const { diff } = attackWeightDiff(c);
      return diff > 0 ? { dmg: diff * (c.script.value ?? 0) } : undefined;
    },
  },
  // CoinAbility_GiveAdditionalSlashDmgOnSACHRatio<N>: critical && heads → trunc(finalDmg × N%) slash (AtkResist)
  additionalDmg(/^GiveAdditionalSlashDmgOnSACHRatio(\d+)$/, "暴击且正面命中时额外造成最终伤害N%的斩击伤害", (c) => Number(/(\d+)$/.exec(c.script.scriptName)![1]) * 0.01, (c) => Boolean(c.isCritical && c.isHeads), "斩击"),
  // CoinAbility_GiveBuffOnSACH: critical && heads → give buffData (limited activate count per turn)
  {
    name: "GiveBuffOnSACH",
    summary: "暴击且正面命中时给予buffData状态（每回合1次）",
    onCoinHit(c) {
      if (!c.isCritical || !c.isHeads || c.state.get(`t${c.turn}`)) return;
      c.state.set(`t${c.turn}`, 1);
      giveBD(c, c.script.buffData);
    },
  },

  // SkillAbility_1101601GiveBuffOnStartTurn: give buffData (Charge turn 5) to self; +IntegerValue(5) if the target is an ally
  {
    name: "1101601GiveBuffOnStartTurn",
    summary: "使用时自身获得5层充能（目标为友方时额外+5，单目标敌人下不触发）",
    approx: "描述写作[ChargeRougeAlly]，代码按 buffData（Charge）给予",
    skillMods(c) {
      giveBD(c, c.script.buffData);
    },
  },
  noDamageScript("1101601OnEndCoinUpgrade_20_2_10", "目标为友方时恢复其体力/理智或给予充能（敌方目标不触发）"),
  noDamageScript("1101602GiveParryingResultUpAndChargeOnEndCoinIfAllyUnit_1_10_2_1", "目标为友方时给予拼点威力/充能/攻击提升（敌方目标不触发）"),
  noDamageScript("1101602SkillCancel", "目标为友方时第1枚硬币后结束技能（敌方目标不触发）"),
  noDamageScript("1101603GiveBuffOnBattleStart_25_1", "战斗开始消耗其他友方体力并使其获得攻击提升/强化"),
  // SkillAbility_1101603UseChargeOnStartTurnIfHasBuff_<max>: self has BuffetSinclair → SuperCoin; Charge turn (+DinnerField) >= bd.turn →
  // use up to <max> Charge turn; coin power +Round(jsonValue), attack weight +Round(bd.value)
  {
    name: /^1101603UseChargeOnStartTurnIfHasBuff_(\d+)$/,
    summary: "处于[BuffetSinclair]时：充能≥10层则消耗10层，硬币威力+1、攻击容量+2",
    approx: "友方“晚宴场地”层数不可得（按0计）；描述写作[ChargeRougeAlly]，代码为 Charge",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!c.actor.get("BuffetSinclair") || !bd?.buffKeyword) return;
      const have = owner(c, bd).getCount(bd.buffKeyword);
      if (have < (bd.turn ?? 0)) return;
      c.consume(bd.buffOwner === "Self" ? "actor" : "target", bd.buffKeyword, Math.min(have, Number(/_(\d+)$/.exec(c.script.scriptName)![1])));
      c.addAttackWeight?.(Math.round(bd.value ?? 0));
      return { coinScale: Math.round(c.script.value ?? 0) };
    },
  },

  // SkillAbility_AttackDmgUpByRatioIfHpRatioNotLessThan<M>..<N>: OnStartTurn_BeforeLog target HP ratio >= N% → dmg +M%
  {
    name: /^AttackDmgUpByRatio(\d+)IfHpRatioNotLessThan(\d+)$/,
    summary: "使用时目标体力不低于N%则本技能伤害+M%",
    skillMods(c) {
      const m = /(\d+)IfHpRatioNotLessThan(\d+)$/.exec(c.script.scriptName)!;
      return c.targetHpRatio() >= Number(m[2]) * 0.01 ? { dmg: Number(m[1]) * 0.01 } : undefined;
    },
  },
  { name: /^DamageFirstBreakSectionOnSuccessCriticalAttackByDamageRatio(\d+)$/, summary: "暴击命中时按伤害量使目标混乱阈值前移（不影响本次伤害）" },
  // SkillAbility_SkillPowerResultAdderIfHpRatioLessThan: target HP ratio < N% → final power +M
  {
    name: /^SkillPowerResultAdder(\d+)IfHpRatioLessThan(\d+)$/,
    summary: "目标体力低于N%时最终威力+M",
    // timing audit: GetSkillPowerResultAdder re-reads HP each query (OnStartTurn_BeforeLog is empty) → per coin
    coinMods(c) {
      const m = /(\d+)IfHpRatioLessThan(\d+)$/.exec(c.script.scriptName)!;
      return c.targetHpRatio() < Number(m[2]) * 0.01 ? { finalPower: Number(m[1]) } : undefined;
    },
  },
  additionalDmg(/^GiveAdditionalSlashDmgOnSuccessAttackTargetByRatio(\d+)$/, "命中时额外造成本硬币伤害N%的斩击伤害", (c) => Number(/(\d+)$/.exec(c.script.scriptName)![1]) * 0.01, () => true, "斩击"),

  // SkillAbility_1110503 (CoinScaleAdderOnStartTurnViaBuffCheckAndUse): self Vibration turn >= 10 → use 10, coin power +value
  {
    name: "1110503",
    summary: "使用时消耗10层震颤，硬币威力+2",
    skillMods(c) {
      SKILL_1110503.clear(c);
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const o = owner(c, bd);
      if (o.getPotency(bd.buffKeyword) < (bd.stack ?? 0) || o.getCount(bd.buffKeyword) < (bd.turn ?? 0)) return;
      if ((bd.turn ?? 0) > 0) c.consume(bd.buffOwner === "Self" ? "actor" : "target", bd.buffKeyword, bd.turn!);
      SKILL_1110503.set(c);
      return { coinScale: Math.round(bd.value ?? 0) };
    },
  },
  // CoinAbility_1110503_1: SkillAbility_1110503 activated this use → GiveBuffOnSucceedAttack(buffData)
  {
    name: "1110503_1",
    summary: "若使用时消耗了震颤，命中时对目标施加3层震颤",
    onCoinHit(c) {
      if (SKILL_1110503.has(c)) giveBD(c, c.script.buffData);
    },
  },
  { name: /^HealFirstBreakSectionOnSuccessAttackViaBuffCheckDevideByTurnWithLimit(\d+)$/, summary: "命中时按自身震颤层数使混乱阈值后移（不影响本次伤害）" },
);

registerAbilities();
