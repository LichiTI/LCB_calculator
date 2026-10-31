/** Script/status batch 18 — see data/il2cpp/dossiers/scripts-18.md */
import { negativeBuffCount } from "../param-scripts";
import { triggerVibrationExplosion, type StatusContainer } from "../status";
import {
  noDamageAbility,
  noDamageScript,
  registerAbilities,
  registerScripts,
  type AbilityCtx,
  type PassiveCtx,
  type ScriptCtx,
  type ScriptData,
} from "./framework";

type BD = NonNullable<ScriptData["buffData"]>;

const owner = (c: PassiveCtx, bd: BD | undefined): StatusContainer => (bd?.buffOwner === "Self" ? c.actor : c.target);

/** CoinAbility_BasicBuff.GiveBuff with buffData (optional stack/turn override). */
function giveBD(c: PassiveCtx, bd: BD | undefined, stack = bd?.stack ?? 0, turn = bd?.turn ?? 0): void {
  if (!bd?.buffKeyword || (stack <= 0 && turn <= 0)) return;
  c.give(bd.target === "Self" ? "actor" : "target", bd.buffKeyword, stack, turn, bd.activeRound === 1 ? 1 : 0);
}

const skillKey = (c: PassiveCtx) => `${c.turn}:${c.skill?.id}`;
const isLastCoin = (c: PassiveCtx) => Boolean(c.skill) && c.coinIndex === c.skill!.coinCount - 1;

/** Per-turn activation limit (CoinAbility._limitedActivateCount / CheckAbilityActivateCount). */
function oncePerTurn(c: PassiveCtx, key: string, max = 1): boolean {
  const k = `${key}:${c.turn}`;
  const n = c.state.get(k) ?? 0;
  if (n >= max) return false;
  c.state.set(k, n + 1);
  return true;
}

/** Holders whose BurstPoison has been initialised (filled to MAX_STACK) since it was last gained. */
const BURST_POISON_INIT = new WeakMap<StatusContainer, true>();
const BURST_POISON_MAX = 5;

/**
 * BuffAbility_BurstReactive (BurstPoison, MAX_STACK 5):
 *   RightAfterGettingBuff (not initialising, new stack < MAX) → TryAddBuff_NonGiver(MAX − stack): first gain fills to 5;
 *   IsAllowToGetBuff(own keyword) = !HasActivatedBuff → no further stacks while present.
 */
function burstPoisonHooks(c: AbilityCtx): void {
  const holder = c.side === "actor" ? c.actor : c.target;
  if (!BURST_POISON_INIT.get(holder)) {
    BURST_POISON_INIT.set(holder, true);
    const p = holder.getPotency("BurstPoison");
    if (p > 0 && p < BURST_POISON_MAX) c.give(c.side, "BurstPoison", BURST_POISON_MAX - p, 0);
  }
  c.interceptStatus?.(
    { whileStatus: "BurstPoison" },
    (ch) => (ch.buffId === "BurstPoison" && ch.delta > 0 && !ch.source?.endsWith(":BurstPoison:BurstPoison") ? 0 : undefined),
    { side: c.side, key: "BurstPoison:noRegain" },
  );
  c.onStatusChange?.(
    "persistent",
    (ev) => {
      if (ev.buffId === "BurstPoison" && ev.after.potency <= 0) BURST_POISON_INIT.delete(holder);
    },
    { side: c.side, key: "BurstPoison:reset" },
  );
}

/**
 * BurstPoison (939) stack loss. BuffAbility_BurstPoison.CheckTrigger: when its stack drops to 0 while the owner has Burst,
 * the owner takes HP damage = Burst stack (TakeHpDamageAppliedAttributeResist_Buff, attr 3).
 */
function loseBurstPoison(c: PassiveCtx, side: "actor" | "target", n: number, why: string): void {
  const u = side === "actor" ? c.actor : c.target;
  const before = u.getPotency("BurstPoison");
  if (before <= 0 || n <= 0) return;
  c.lose(side, "BurstPoison", Math.min(n, before));
  if (u.getPotency("BurstPoison") > 0) return;
  BURST_POISON_INIT.delete(u);
  const burst = u.getPotency("Burst");
  // _ATTR_TYPE 3 = SHAMROCK (Gluttony); TakeHpDamageAppliedAttributeResist applies the sin resistance.
  if (side === "target" && burst > 0) c.extraDamage(burst, `${why}：咒杀【剧毒】耗尽，受到等同破裂强度(${burst})的暴食伤害`, { sin: "SHAMROCK" });
  else if (burst > 0) c.note(`${why}：自身咒杀【剧毒】耗尽，受到${burst}点伤害`);
}

/** AccelBullet used by the current skill (BattleActionModel.GetUsedBuffStack(AccelBullet)), from the per-action record. */
const accelUsed = (c: ScriptCtx) => c.action.consumedStack("AccelBullet");

/** c.action.shared key: SwordCutwithTear at skill start (for CoinAbility_DmgUpByBuff1091303 vs PassiveAbility_1091304 consuming it). */
const TEAR_AT_START = "1091307:tearAtStart";

const FAUVISM_CLAW_WOUND = ["BearClawWound", "BearClawWoundAlly", "EagleClawWound", "EagleClawWoundAlly"];

registerScripts(
  // SkillAbility_CoinScaleAdder11212_<div>_<per>_<max>: (self Breath stack + target Burst stack) / div × per, ≤ max.
  {
    name: /^CoinScaleAdder11212_(\d+)_(\d+)_(\d+)$/,
    summary: "自身呼吸法强度与目标破裂强度之和每有N级，硬币威力+1（有上限）",
    skillMods(c) {
      const m = /_(\d+)_(\d+)_(\d+)$/.exec(c.script.scriptName)!;
      const sum = c.actor.getPotency("Breath") + c.target.getPotency("Burst");
      const v = Math.min(Math.floor(sum / Math.max(1, Number(m[1]))) * Number(m[2]), Number(m[3]));
      return v > 0 ? { coinScale: v } : undefined;
    },
  },
  // CoinAbility_GiveBuffOnSACIfHasStack_<Kw><N>: critical hit && buffOwner <Kw> stack ≥ N → GiveBuff(buffData).
  {
    name: /^GiveBuffOnSACIfHasStack_SnakeStance(\d+)$/,
    summary: "暴击命中时若自身带有巳臂，则按buffData施加破裂",
    onCoinHit(c) {
      const n = Number(/(\d+)$/.exec(c.script.scriptName)![1]);
      const bd = c.script.buffData;
      if (c.isCritical && owner(c, bd).getPotency("SnakeStance") >= n) giveBD(c, bd);
    },
  },
  // CoinAbility_UseBurstPoisonOnSAC (base UseBurstPoisonOnSA): critical hit && target has BurstPoison → UseBuffStack(bd.stack).
  {
    name: "UseBurstPoisonOnSAC",
    summary: "暴击命中时使目标咒杀【剧毒】减少buffData层；降至0时目标受到等同破裂强度的伤害",
    onCoinHit(c) {
      if (!c.isCritical) return;
      loseBurstPoison(c, "target", c.script.buffData?.stack ?? 1, "暴击消耗咒杀【剧毒】");
    },
  },
  // SkillAbility_AttackDmgUpByRatioOSTByUseBuffIfHasStack_<Kw><N>: OnStartTurn owner <Kw> stack ≥ N → UseBuffStack(bd.stack) → dmg +bd.value.
  {
    name: /^AttackDmgUpByRatioOSTByUseBuffIfHasStack_([A-Za-z]+?)(\d+)$/,
    summary: "使用时指定状态达到N层则消耗buffData层数，本技能伤害+value",
    skillMods(c) {
      const m = /_([A-Za-z]+?)(\d+)$/.exec(c.script.scriptName)!;
      const bd = c.script.buffData;
      const kw = bd?.buffKeyword ?? m[1]!;
      if (owner(c, bd).getPotency(kw) < Number(m[2])) return;
      if ((bd?.stack ?? 0) > 0) c.lose(bd?.buffOwner === "Self" ? "actor" : "target", kw, bd!.stack!);
      if ((bd?.turn ?? 0) > 0) c.consume(bd?.buffOwner === "Self" ? "actor" : "target", kw, bd!.turn!);
      return (bd?.value ?? 0) > 0 ? { dmg: bd!.value! } : undefined;
    },
  },
  // CoinAbility_DmgUpByBuff1091303: self SwordCutwithTear stack ≥ 1, or PassiveAbility_1091304.CheckCoin (tear consumed on this coin) → +value.
  {
    name: "DmgUpByBuff1091303",
    summary: "自身带有含泪斩剑或本硬币消耗了含泪斩剑时，本硬币伤害+20%",
    approx: "“本硬币消耗了含泪斩剑”按技能开始时含泪斩剑≥3且为最后一枚硬币（被动1091304）推断",
    coinMods(c) {
      const bd = c.script.buffData;
      const kw = bd?.buffKeyword ?? "SwordCutwithTear";
      let ok = c.actor.getPotency(kw) >= Math.max(1, bd?.stack ?? 1);
      if (!ok && c.identityId === 10913 && isLastCoin(c)) {
        const tear = c.action.shared.get(TEAR_AT_START) as number | undefined;
        ok = (tear ?? 0) >= 3;
      }
      if (ok) return { dmg: bd?.value ?? 0.2 };
    },
  },
  // CoinAbility_GiveBuffOnSAAddStackByBuffStackDivide_<Kw><N>: stack = bd.stack + min(floor(self <Kw> / N) × value, limit).
  {
    name: /^GiveBuffOnSAAddStackByBuffStackDivide_([A-Za-z]+?)(\d+)$/,
    summary: "命中时获得buffData状态；自身每带有N层指定状态额外+value（有上限）",
    onCoinHit(c) {
      const m = /_([A-Za-z]+?)(\d+)$/.exec(c.script.scriptName)!;
      const bd = c.script.buffData;
      const st = owner(c, bd).getPotency(m[1]!);
      let add = Math.floor(st / Math.max(1, Number(m[2]))) * Math.round(bd?.value ?? 1);
      if ((bd?.limit ?? 0) > 0) add = Math.min(add, bd!.limit!);
      giveBD(c, bd, (bd?.stack ?? 0) + Math.max(0, add));
    },
  },
  // CoinAbility_GiveBuffOnSucceedAttackByDuplicateStackDevideByValue.GetStack: Round(owner <Kw> stack / bd.value) + jsonValue, ≤ limit.
  {
    name: "GiveBuffOnSucceedAttackByDuplicateStackDevideByValue_ProtectiveSword",
    summary: "命中时使目标增加相当于自身守护之剑层数的沉沦强度（最多5级）",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!bd) return;
      let n = Math.round(owner(c, bd).getPotency("ProtectiveSword") / Math.max(1, bd.value ?? 1)) + (c.script.value ?? 0);
      if ((bd.limit ?? 0) > 0) n = Math.min(n, bd.limit!);
      if (n > 0) giveBD(c, bd, n, 0);
    },
  },
  noDamageScript("SkillOnEndAttack1091303", "目标阵亡时返还一半消耗的黑泪"),
  // SkillAbility_SkillOnUse1091307_<div>_<adder>: owner stack ≥ bd.stack → use min(stack, limit) → dmg + used × value, base power + floor(used/div) × adder.
  {
    name: /^SkillOnUse1091307_(\d+)_(\d+)$/,
    summary: "使用时黑泪≥10层则消耗最多20层：伤害+(消耗层数×value)，每5层基础威力+1",
    skillMods(c) {
      c.action.shared.set(TEAR_AT_START, c.actor.getPotency("SwordCutwithTear"));
      const m = /_(\d+)_(\d+)$/.exec(c.script.scriptName)!;
      const bd = c.script.buffData;
      const kw = bd?.buffKeyword ?? "BlackTearsAlly";
      const st = c.actor.getPotency(kw);
      if (st < (bd?.stack ?? 10)) return;
      const used = (bd?.limit ?? 0) > 0 ? Math.min(st, bd!.limit!) : st;
      c.lose("actor", kw, used);
      return {
        dmg: used * (bd?.value ?? 0),
        basePower: Math.floor(used / Math.max(1, Number(m[1]))) * Number(m[2]),
      };
    },
  },
  noDamageScript("1091403FirstCoinNormalCondition", "按伤害量10%使目标混乱阈值前移"),
  noDamageScript("1091403FirstCoinReinforceCondition", "充能强度≥3时按伤害量20%使目标混乱阈值前移"),
  // CoinAbility_GiveBuffOnSAAndUseChargeTurn1091402_<N>_<use>: once/turn, Charge turn ≥ N → UseBuffTurn(Charge, use) → GiveBuff(buffData).
  {
    name: /^GiveBuffOnSAAndUseChargeTurn1091402_(\d+)_(\d+)$/,
    summary: "命中时充能≥8层：消耗4层充能，下回合对目标施加1层受击伤害提高（每回合1次）",
    onCoinHit(c) {
      const m = /_(\d+)_(\d+)$/.exec(c.script.scriptName)!;
      if (c.actor.getCount("Charge") < Number(m[1]) || !oncePerTurn(c, c.script.scriptName)) return;
      c.consume("actor", "Charge", Number(m[2]));
      giveBD(c, c.script.buffData);
    },
  },
  // CoinAbility_GiveBuffOnSAIfBuffTurnLack1091402_<N>_<gain>: once/turn, Charge turn < N → GiveBuff(buffData) + Charge turn +gain.
  {
    name: /^GiveBuffOnSAIfBuffTurnLack1091402_(\d+)_(\d+)$/,
    summary: "命中时充能低于8层：自身沉沦强度+5并获得4层充能（每回合1次）",
    onCoinHit(c) {
      const m = /_(\d+)_(\d+)$/.exec(c.script.scriptName)!;
      if (c.actor.getCount("Charge") >= Number(m[1]) || !oncePerTurn(c, c.script.scriptName)) return;
      giveBD(c, c.script.buffData);
      c.give("actor", "Charge", 0, Number(m[2]));
    },
  },
  // SkillAbility_ToWideAreaRampageOnUseIfLessChargeTurn1091403_<min>_<max>_<gain>: min ≤ Charge turn < max → GiveBuff(buffData),
  // Charge turn +gain, skill becomes WideAreaRampage (target num +value).
  {
    name: /^ToWideAreaRampageOnUseIfLessChargeTurn1091403_(\d+)_(\d+)_(\d+)$/,
    summary: "使用时充能5~9层：自身沉沦强度+5、获得5层充能，本技能变为横扫攻击",
    approx: "横扫按攻击容量+value处理（副目标伤害需开启“统计副目标伤害”）",
    skillMods(c) {
      const m = /_(\d+)_(\d+)_(\d+)$/.exec(c.script.scriptName)!;
      const n = c.actor.getCount("Charge");
      if (n < Number(m[1]) || n >= Number(m[2])) return;
      giveBD(c, c.script.buffData);
      c.give("actor", "Charge", 0, Number(m[3]));
      c.addAttackWeight?.(Math.round(c.script.value ?? 1));
    },
  },
  // SkillAbility_UseAllChargeTurnOnUse1091403: Charge turn ≥ bd.turn → over = turn − bd.turn; UseBuffAllTurn; coin power +value;
  // dmg = min(over × bd.value, bd.limit × 0.01).
  {
    name: "UseAllChargeTurnOnUse1091403",
    summary: "使用时充能≥10层：消耗全部充能，硬币威力+2，超出10层的每层伤害+12%（最多+60%）",
    skillMods(c) {
      const bd = c.script.buffData;
      const need = bd?.turn ?? 10;
      const n = c.actor.getCount("Charge");
      if (n < need) return;
      const over = n - need;
      c.consume("actor", "Charge", n);
      const dmg = Math.min(over * (bd?.value ?? 0.12), (bd?.limit ?? 60) * 0.01);
      return { coinScale: Math.round(c.script.value ?? 2), dmg };
    },
  },
  // SkillAbility_ChangeSkillOnBTIfTargetNegativeBuffCntNotLessThan<N>.OnBeforeTurn: Round(jsonValue) > 0 && main target negative buff
  // count ≥ N → ChangeSkill(value).
  {
    name: /^ChangeSkillOnBTIfTargetNegativeBuffCntNotLessThan(\d+)$/,
    summary: "目标负面状态种类达到N种时改为使用另一技能（value）",
    beforeUse(c) {
      const n = Number(/(\d+)$/.exec(c.script.scriptName)![1]);
      const to = Math.round(c.script.value ?? 0);
      if (to > 0 && negativeBuffCount(c.target) >= n) c.replaceSkill?.(to, `目标负面状态≥${n}种`);
    },
  },
  // SkillAbility_DmgMulByFauvismClawWound_<N>: kinds of FAUVISM_CLAW_WOUND statuses on target ≥ N → +jsonValue.
  {
    name: /^DmgMulByFauvismClawWound_(\d+)$/,
    summary: "目标带有的被撕裂的色彩不少于N种时伤害+value",
    approx: "FAUVISM_CLAW_WOUND 类别按熊爪/鹰爪伤（含友方版）推断",
    coinMods(c) {
      const n = Number(/(\d+)$/.exec(c.script.scriptName)![1]);
      const kinds = FAUVISM_CLAW_WOUND.filter((k) => c.target.getPotency(k) > 0 || c.target.getCount(k) > 0).length;
      if (n > 0 && kinds >= n) return { dmg: c.script.value ?? 0.2 };
    },
  },
  // CoinAbility_GiveBuffOnSAIfTargetNegativeBuffCntNotLessThan<N>: target negative buff count ≥ N → GiveBuff(buffData).
  {
    name: /^GiveBuffOnSAIfTargetNegativeBuffCntNotLessThan(\d+)$/,
    summary: "命中时若目标负面状态不少于N种，则施加buffData状态",
    onCoinHit(c) {
      const n = Number(/(\d+)$/.exec(c.script.scriptName)![1]);
      if (negativeBuffCount(c.target) >= n) giveBD(c, c.script.buffData);
    },
  },
  {
    // SkillAbility_RingFingerFavuismTestEffectOnSetTarget.OnSetTarget: toggles action system ability BAS_RingFingerFavuismTest by target
    // negative buff count (portrait/UI effect). The swap 1091503→1091505 itself is ChangeSkillOnBTIfTargetNegativeBuffCntNotLessThan6.
    name: "RingFingerFavuismTestEffectOnSetTarget",
    summary: "按目标负面状态数显示技能强化特效（实际替换由 ChangeSkillOnBTIfTargetNegativeBuffCntNotLessThan6 处理）",
    approx: "系统能力 BAS_RingFingerFavuismTest 若被其他代码读取则未建模",
  },
  noDamageScript("LoseFutureEye1091603", "攻击前使自身预知眼减少最多10层"),
  {
    // CoinAbility_LoseFutureEyeOnWinDuel10916 (no dump; desc + data): on clash win use own FutureEyeOnRodion up to the remaining
    // coin count (bd.limit 10) → attack damage + bd.value (0.05) per layer used.
    name: "LoseFutureEyeOnWinDuel10916",
    summary: "拼点胜利时按剩余硬币数消耗预知眼，每层伤害+5%",
    approx: "仅在可选敌方行动模型（拼点胜利，假设硬币无损）下触发；类无 dump，按描述与数据",
    onWinDuel(c) {
      const bd = c.script.buffData ?? {};
      const kw = bd.buffKeyword ?? "FutureEyeOnRodion";
      const coins = (c.skillData as { coins?: unknown[] } | null)?.coins?.length ?? 1;
      const n = Math.min(c.actor.getPotency(kw), coins, bd.limit ?? 10);
      if (n <= 0 || !c.action) return;
      c.lose("actor", kw, n);
      c.action.shared.set("futureEyeWin10916", n * (bd.value ?? 0.05));
    },
    coinMods(c) {
      const v = c.action?.shared.get("futureEyeWin10916") as number | undefined;
      return v ? { dmg: v } : undefined;
    },
  },
  // CoinAbility_UseBullet (optional): consume 1 AccelBullet when the coin is used; the coin works without bullets.
  {
    name: "UseBullet[optional:AccelBullet:1]",
    summary: "掷出硬币时消耗1发加速弹（可选）",
    coinMods(c) {
      if (c.actor.getPotency("AccelBullet") <= 0) return;
      c.lose("actor", "AccelBullet", 1);
    },
  },
  // CoinAbility_VibrationExplosion1091603: times = 1 + min(used AccelBullet, value); each: target Vibration → explosion, lose 1 Vibration turn.
  {
    name: "VibrationExplosion1091603",
    summary: "命中时使目标震颤引爆并减少1层震颤；本技能每消耗1发加速弹额外触发1次（最多2次）",
    onCoinHit(c) {
      const times = 1 + Math.min(accelUsed(c), Math.round(c.script.value ?? 2));
      for (let i = 0; i < times; i++) {
        if (c.target.getPotency("Vibration") <= 0) break;
        const rec = triggerVibrationExplosion(c.target, c.turn, "震颤引爆(1091603)");
        if (rec && rec.hpDamage > 0) c.extraDamage(rec.hpDamage, "震颤引爆(1091603)（震颤-灼热）");
        else if (rec) c.note(`震颤引爆(1091603)：混乱阈值前移 ${rec.staggerShift}`);
        c.consume("target", "Vibration", 1);
      }
    },
  },
  noDamageScript("BuffToAlly1091701", "目标为友方时给予充能与攻击等级提升"),
  noDamageScript("BuffToChargeAlly1091701", "目标为友方充能人格时给予强化"),
  noDamageScript("BuffToTwoAllyAndSelf10917", "战斗开始时给自身与友方护盾与剪裁护盾"),
);

registerAbilities(
  // BuffAbility_BurstPoison.OnActivateBurst: Burst triggered by a critical attack → Ability: lose 1 stack and random
  // AttackLevelDown / DefenseLevelDown (≤ limit/turn) to self.
  {
    name: "BurstPoison",
    summary: "获得时补满至5层且存在期间不再获得；因暴击触发破裂时咒杀【剧毒】减少1层；耗尽时受到等同破裂强度的伤害",
    approx: "随机施加的攻击/防御等级降低未计入；补满在获得后的下一次硬币结算时进行",
    coinMods(c) {
      burstPoisonHooks(c);
    },
    onCoinHit(c) {
      burstPoisonHooks(c);
      if (c.side !== "target" || !c.isCritical || c.target.getPotency("Burst") <= 0) return;
      loseBurstPoison(c, "target", 1, "暴击触发破裂");
      c.note("咒杀【剧毒】：随机对目标施加攻击/防御等级降低（未计入）");
    },
  },
  // BuffAbility_GiveBuffOnUseDefaultAttackSkillIfHasStack_<Kw><N>: default attack skill used && buffOwner <Kw> stack ≥ N → GiveBuff(buffData).
  {
    name: /^GiveBuffOnUseDefaultAttackSkillIfHasStack_([A-Za-z]+?)(\d+)$/,
    summary: "使用基础攻击技能时若目标带有指定状态，则获得buffData状态",
    approx: "在第1枚硬币结算前发放（实际为技能使用时）",
    coinMods(c) {
      if (c.side !== "actor" || c.coinIndex !== 0 || !["S1", "S2", "S3"].includes(c.skill?.slot ?? "")) return;
      const key = `used:${skillKey(c)}`;
      if (c.state.get(key)) return;
      c.state.set(key, 1);
      const m = /_([A-Za-z]+?)(\d+)$/.exec(c.ability.ability)!;
      const bd = c.ability.buffData;
      const o = bd?.buffOwner === "Self" ? c.actor : c.target;
      if (o.getPotency(m[1]!) >= Number(m[2])) giveBD(c, bd);
    },
  },
  {
    name: "BoldBrushstrokesRodion_20",
    summary: "每层使受到的流血/沉沦伤害+10%（最多+20%）（未建模）",
    approx: "引擎缺少“状态(流血/沉沦)伤害倍率”能力：未计入",
  },
  noDamageAbility("TakeMpDmgSelfByValueCheckBuffOnRoundEnd", "回合结束时本状态≥5层则失去5点理智"),
  noDamageAbility("EagleClawWoundAllyEffect", "仅特效显示"),
  noDamageAbility("FutureEyeOnRodionLimitPerTurn", "预知眼每回合最多减少10层"),
);
