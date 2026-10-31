/** Script/status batch 01 — see data/il2cpp/dossiers/scripts-01.md */
import { negativeBuffCount } from "../param-scripts";
import { triggerSinkingSurge, triggerVibrationExplosion, type StatusContainer } from "../status";
import { noDamageScript, registerAbilities, registerScripts, type ScriptCtx, type ScriptData } from "./framework";

type BD = NonNullable<ScriptData["buffData"]>;
interface SkillLike { id: number; coins: { abilityScriptList?: ScriptData[] }[] }

/** AbilityBase.GetSingleUnit(buffOwner): "Self" → actor, otherwise the main target. */
const owner = (c: ScriptCtx, bd: BD | undefined): StatusContainer => (bd?.buffOwner === "Self" ? c.actor : c.target);

/** *ViaBuffCheck.CheckCondition: owner stack >= bd.stack && turn >= bd.turn. */
function buffCheck(c: ScriptCtx, bd: BD | undefined): boolean {
  if (!bd?.buffKeyword) return false;
  const o = owner(c, bd);
  return o.getPotency(bd.buffKeyword) >= (bd.stack ?? 0) && o.getCount(bd.buffKeyword) >= (bd.turn ?? 0);
}

/** CoinAbility_BasicBuff.GiveBuff with buffData (optional stack/turn override). */
function giveBD(c: ScriptCtx, bd: BD | undefined, stack = bd?.stack ?? 0, turn = bd?.turn ?? 0): void {
  if (!bd?.buffKeyword || (stack <= 0 && turn <= 0)) return;
  c.give(bd.target === "Self" ? "actor" : "target", bd.buffKeyword, stack, turn, bd.activeRound === 1 ? 1 : 0);
}

/** Vibration explosion on the target (BattleUnitModel.VibrationExplosion); only VibrationIgnition deals HP damage. */
function vibrationExplosion(c: ScriptCtx, tag: string): boolean {
  const rec = triggerVibrationExplosion(c.target, c.turn, tag);
  if (!rec) return false;
  if (rec.hpDamage > 0) c.extraDamage(rec.hpDamage, `${tag}（震颤-灼热）`);
  else c.note(`${tag}：混乱阈值前移 ${rec.staggerShift}`);
  return true;
}

/** Sum of target SinkingWhite amounts (stack 生蝶 + turn 亡蝶); single-dimension storage counts once. */
function whiteTotal(t: StatusContainer): number {
  const p = t.getPotency("SinkingWhite");
  const n = t.getCount("SinkingWhite");
  return p === n ? p : p + n;
}

const RANDOM_SINS = ["Combustion", "Laceration", "Vibration", "Burst", "Sinking"];
/** Random sin debuff: deterministic rotation instead of Util random (no RNG in script ctx). */
function randomSin(c: ScriptCtx): string {
  const i = c.state.get("rot") ?? 0;
  c.state.set("rot", i + 1);
  return RANDOM_SINS[i % RANDOM_SINS.length]!;
}

// Shared per-use flags between skill-scope and coin-scope scripts of the same skill live in c.action (shared / consumed*).
/**
 * @deprecated Last BulletLament amount consumed by ConsumeAllBulletLamentWithoutNecessary (kept for compatibility);
 * prefer bulletLamentConsumed(c) / c.action.shared.get(BULLET_LAMENT_KEY).
 */
export const BULLET_LAMENT_CONSUMED = { amount: 0, turn: 0, skillId: 0 };
export const BULLET_LAMENT_KEY = "ConsumeAllBulletLament:amount";
/** BulletLament consumed by the latest ConsumeAllBulletLamentWithoutNecessary coin of the current skill use. */
export const bulletLamentConsumed = (c: ScriptCtx): number => (c.action.shared.get(BULLET_LAMENT_KEY) as number | undefined) ?? 0;

registerScripts(
  // CoinAbility_1010103_1.OnSucceedAttack: target MP < _MP_COND(0) → buffData (Vulnerable 1, next round)
  {
    name: "1010103_1",
    summary: "命中时若目标理智值<0，下回合施加1层易损（目标理智取场景值）",
    onCoinHit(c: ScriptCtx) {
      if (c.targetSp === undefined || c.targetSp >= 0) return;
      const bd = c.script.buffData;
      c.give("target", bd?.buffKeyword ?? "Vulnerable", bd?.stack ?? 0, bd?.turn ?? 1, bd?.activeRound === 0 ? 0 : 1);
    },
  },

  // CoinAbility_1010202_1/_2.GetAnotherCoinGiveBuffStackAdder: +1 stack to statuses given by the skill's last coin (once per hitting coin)
  ...["1010202_1", "1010202_2"].map((name) => ({
    name,
    summary: "命中时使本技能最后一枚硬币施加的状态强度/层数额外+1",
    approx: "提前在本硬币命中时直接追加最后一枚硬币状态的+1（无拼点时最后一枚硬币必定命中）",
    onCoinHit(c: ScriptCtx) {
      const sk = c.skillData as SkillLike;
      const last = sk.coins[sk.coins.length - 1];
      for (const s of last?.abilityScriptList ?? []) {
        const bd = s.buffData;
        if (!bd?.buffKeyword || (bd.target || "Target") === "Self" || (bd.stack ?? 0) <= 0) continue;
        c.give("target", bd.buffKeyword, 1, 0, bd.activeRound === 1 ? 1 : 0);
      }
    },
  })),

  // SkillAbility_1010402.OnCompleteCommand: self Vibration turn >= 6 → UseBuffTurn 6; OverwriteTargetNum(3)
  {
    name: "1010402",
    summary: "自身震颤≥6层时消耗6层震颤（攻击目标数改为3）",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword || !buffCheck(c, bd)) return;
      c.actor.consumeCount(bd.buffKeyword, bd.turn ?? 0);
      c.setAttackWeight?.(3);
      c.note(`消耗自身 ${bd.turn} 层${bd.buffKeyword}`);
    },
  },

  // CoinAbility_GiveAdditionalDmgOnSuccessAttackViaBuffCheck → AdditionalDmgByBuff.GiveAbsoluteHpDamage(realDmg × value, cap limit)
  {
    name: "GiveAdditionalDmgOnSuccessAttackViaBuffCheck",
    summary: "命中时满足状态条件则追加本硬币伤害×value 的固定伤害",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!buffCheck(c, bd) || !c.lastHitDamage) return;
      let dmg = Math.floor(c.lastHitDamage * (bd?.value ?? 0));
      if ((bd?.limit ?? 0) > 0) dmg = Math.min(dmg, bd!.limit!);
      if (dmg > 0) c.extraDamage(dmg, `本硬币伤害 ${c.lastHitDamage}×${bd?.value} 追加伤害`);
    },
  },

  // CoinAbility_SinkingSurgeOnSucceedAttackViaBuffCheck: condition (target Sinking stack >= 6) → AbilityBase.SinkingSurge
  {
    name: "SinkingSurgeOnSucceedAttackViaBuffCheck",
    summary: "命中时目标沉沦强度达到条件则使目标沉沦泛滥（强度×层数）",
    approx: "按目标无理智值（造成体力伤害）且忧郁抗性×1 结算",
    onCoinHit(c) {
      if (!buffCheck(c, c.script.buffData)) return;
      const rec = triggerSinkingSurge(c.target, c.turn, false, 1, "沉沦泛滥");
      if (rec && rec.hpDamage > 0) c.extraDamage(rec.hpDamage, `沉沦泛滥 ${rec.potencyAtTrigger}×${rec.countBefore}`);
    },
  },

  // SkillAbility_1010503 (CoinScaleAdderOnStartTurnViaBuffCheckAndUse): self Vibration turn >= 10 → use 10 turn, coin power +value(2)
  {
    name: "1010503",
    summary: "自身震颤≥10层时消耗10层，本技能硬币威力+2，并启用硬币的震颤引爆",
    skillMods(c) {
      const bd = c.script.buffData;
      const ok = buffCheck(c, bd);
      c.action.shared.set("1010503:vibUsed", ok);
      if (!ok || !bd?.buffKeyword) return;
      if ((bd.turn ?? 0) > 0) c.actor.consumeCount(bd.buffKeyword, bd.turn!);
      c.note(`消耗自身 ${bd.turn} 层${bd.buffKeyword}，硬币威力+${bd.value}`);
      return { coinScale: Math.round(bd.value ?? 0) };
    },
  },
  // CoinAbility_1010503_coin.CheckCondition: SkillAbility_1010503.ActivatedAbility → VibrationExplosion
  {
    name: "1010503_coin",
    summary: "若使用时消耗了震颤层数，命中时使目标震颤引爆",
    onCoinHit(c) {
      if (c.action.shared.get("1010503:vibUsed") === true) vibrationExplosion(c, "1010503 震颤引爆");
    },
  },

  // CoinAbility_VibrationExplosionOnSucceedAttackViaBuffCheckThenLoseTargetVibrationTurn<N>: check → explosion, target loses N Vibration turn
  {
    name: /^VibrationExplosionOnSucceedAttackViaBuffCheckThenLoseTargetVibrationTurn(\d+)$/,
    summary: "命中时满足状态条件则使目标震颤引爆，并使目标震颤层数减少N",
    onCoinHit(c) {
      if (!buffCheck(c, c.script.buffData)) return;
      vibrationExplosion(c, "震颤引爆");
      const n = Number(/(\d+)$/.exec(c.script.scriptName)![1]);
      if (c.target.get("Vibration")) c.target.consumeCount("Vibration", n);
    },
  },

  // SkillAbility_1010603_2.OnStartTurn_BeforeLog: Charge turn < 15 && >= 10 → UseBuffTurn 10, coin power +1
  {
    name: "1010603_2",
    summary: "充能层数在10~14层时消耗10层充能，硬币威力+1",
    skillMods(c) {
      const n = c.actor.getCount("Charge");
      if (n >= 15 || n < 10) return;
      c.actor.consumeCount("Charge", 10);
      return { coinScale: 1 };
    },
  },
  // SkillAbility_1010603_3: Charge turn >= 15 → UseBuffTurn 15, coin power +2
  {
    name: "1010603_3",
    summary: "充能≥15层时消耗15层充能，硬币威力+2",
    skillMods(c) {
      if (c.actor.getCount("Charge") < 15) return;
      c.actor.consumeCount("Charge", 15);
      return { coinScale: 2 };
    },
  },
  // SkillAbility_1010603_4.BeforeAttack: used charge (sum of SkillAbility_1010603) >= value(15) → GiveBuff(buffData: Burst turn 3)
  {
    name: "1010603_4",
    summary: "若消耗了15层充能，攻击前对目标施加3层破裂",
    skillMods(c) {
      if (c.action.consumedTurn("Charge") >= (c.script.buffData?.value ?? 15)) giveBD(c, c.script.buffData);
    },
  },
  // CoinAbility_1010603_3_1: stack = min(bd.stack × floor(used / 5), value 9) → Burst potency
  {
    name: "1010603_3_1",
    summary: "每消耗5层充能使目标增加3级破裂强度（最多9级）",
    onCoinHit(c) {
      const bd = c.script.buffData;
      const stack = Math.min((bd?.stack ?? 0) * Math.floor(c.action.consumedTurn("Charge") / 5), Math.round(bd?.value ?? 0));
      if (stack > 0) giveBD(c, bd, stack, 0);
    },
  },
  // CoinAbility_1010603_3_2.OnStartCoin: used >= value(15) → enable GiveBuffOnSucceedAttack (DimensionRift 2)
  {
    name: "1010603_3_2",
    summary: "若消耗了15层充能，命中时施加2层次元裂痕",
    onCoinHit(c) {
      if (c.action.consumedTurn("Charge") >= (c.script.buffData?.value ?? 15)) giveBD(c, c.script.buffData);
    },
  },

  noDamageScript("GiveBuffOnKillTarget", "击杀目标时给予状态（击杀不模拟）"),

  // CoinAbility_GiveBuffOnSucceedAttackIfHasTurn_<Keyword><N>: owner(bd.buffOwner) <Keyword> turn >= N → GiveBuff(buffData)
  {
    name: /^GiveBuffOnSucceedAttackIfHasTurn_([A-Za-z]+?)(\d+)$/,
    summary: "命中时若指定单位的某状态层数≥N，则给予buffData状态",
    onCoinHit(c) {
      const m = /^GiveBuffOnSucceedAttackIfHasTurn_([A-Za-z]+?)(\d+)$/.exec(c.script.scriptName)!;
      if (owner(c, c.script.buffData).getCount(m[1]!) >= Number(m[2])) giveBD(c, c.script.buffData);
    },
  },

  noDamageScript("WCorpRipSpace", "仅标记类（SkillAbility_WCorpRipSpace 无逻辑）"),
  noDamageScript("AddShieldOnDiscardedByHpRatioViaBuffCheckDeivdeByStack", "技能被丢弃时获得护盾"),

  // SkillAbility_CoinScaleAdderIfSelfHpRatioLessThan: hp ratio < N × 0.01 → coin power +X
  {
    name: /^CoinScaleAdder(\d+)IfSelfHpRatioLessThan(\d+)$/,
    summary: "自身体力比例低于N%时硬币威力+X",
    skillMods(c) {
      const m = /^CoinScaleAdder(\d+)IfSelfHpRatioLessThan(\d+)$/.exec(c.script.scriptName)!;
      return c.selfHpRatio() < Number(m[2]) * 0.01 ? { coinScale: Number(m[1]) } : undefined;
    },
  },

  // CoinAbility_GiveBuffOnSucceedAttackByDuplicateStack_<Keyword>: stack = owner <Keyword> stack (cap limit), if owner has it
  {
    name: /^GiveBuffOnSucceedAttackByDuplicateStack_([A-Za-z]+)$/,
    summary: "命中时给予与指定状态强度相同的buffData状态强度",
    onCoinHit(c) {
      const kw = /_([A-Za-z]+)$/.exec(c.script.scriptName)![1]!;
      const bd = c.script.buffData;
      let stack = owner(c, bd).getPotency(kw);
      if ((bd?.limit ?? 0) > 0) stack = Math.min(stack, bd!.limit!);
      if (stack > 0) giveBD(c, bd, stack, bd?.turn ?? 0);
    },
  },

  noDamageScript("HealFirstBreakSectionOnSuccessAttackViaBuffCheckDevideByStack", "命中时使自身混乱阈值后移"),

  // CoinAbility_GiveBuffOnSAAdd{Stack,Turn}ByValueIfNegativeBuffCntNotLessThanLimit.CheckStackAndTurn: target neg count >= limit → amount + value
  {
    name: "GiveBuffOnSAAddStackByValueIfNegativeBuffCntNotLessThanLimit",
    summary: "命中时施加状态强度；目标负面状态种类≥limit时额外+value",
    approx: "负面状态种类数在同硬币其他效果结算后统计",
    onCoinHit(c) {
      const bd = c.script.buffData;
      const add = negativeBuffCount(c.target) >= (bd?.limit ?? 0) ? Math.round(bd?.value ?? 0) : 0;
      giveBD(c, bd, (bd?.stack ?? 0) + add, bd?.turn ?? 0);
    },
  },
  {
    name: "GiveBuffOnSAAddTurnByValueIfNegativeBuffCntNotLessThanLimit",
    summary: "命中时施加状态层数；目标负面状态种类≥limit时额外+value",
    approx: "负面状态种类数在同硬币其他效果结算后统计",
    onCoinHit(c) {
      const bd = c.script.buffData;
      const add = negativeBuffCount(c.target) >= (bd?.limit ?? 0) ? Math.round(bd?.value ?? 0) : 0;
      giveBD(c, bd, bd?.stack ?? 0, (bd?.turn ?? 0) + add);
    },
  },

  // CoinAbility_GiveRandomDebuffSin{Stack,Turn}WithoutKeyword[Head]<N>: random of 5 sin debuffs, N stack / turn
  {
    name: /^GiveRandomDebuffSin(Stack|Turn)WithoutKeyword(Head)?(\d+)$/,
    summary: "命中时随机对目标施加烧伤/流血/震颤/破裂/沉沦之一（N强度或N层）",
    approx: "随机选择改为按顺序轮换（确定性）",
    onCoinHit(c) {
      const m = /^GiveRandomDebuffSin(Stack|Turn)WithoutKeyword(Head)?(\d+)$/.exec(c.script.scriptName)!;
      if (m[2] && !c.isHeads) return;
      const n = Number(m[3]);
      const kw = randomSin(c);
      if (m[1] === "Stack") c.give("target", kw, n, 0);
      else c.give("target", kw, 0, n);
    },
  },

  // CoinAbility_RingFingerYisangSecondSkillCoinAbility<base>And<per>And<max> (RerollOnSAUpto): prob = (base + per × negCount) × 0.01, up to max per skill
  {
    name: /^RingFingerYisangSecondSkillCoinAbility(\d+)And(\d+)And(\d+)$/,
    summary: "命中后按(基础+每种负面状态)概率重复使用本硬币（每技能最多N次）",
    approx: "仅当概率≥100%时计入重复使用；概率<100%未建模（无随机数）",
    rerolls(c) {
      const m = /(\d+)And(\d+)And(\d+)$/.exec(c.script.scriptName)!;
      const p = (Number(m[1]) + Number(m[2]) * negativeBuffCount(c.target)) * 0.01;
      return p >= 1 ? Number(m[3]) : 0;
    },
  },
  noDamageScript("RingFingerYisangThirdSkillCoinAbility2And2", "目标混乱或被击杀时对其他敌人施加随机状态"),

  // SkillAbility_AddBulletLamentByResonance.OnStartBehaviour: amount = perfect>0 ? min(perfect × mul, plimit) : min(max attr resonance, basic);
  // reserved on PassiveAbility_1011002 and added at its OnEndBehaviour; reloadcondition N: perfect >= N → reload instead (desc)
  {
    name: /^AddBulletLamentByResonancePlus_basiclimit(\d+)_perfectmul(\d+)_perfectlimit(\d+)(?:_reloadcondition(\d+))?$/,
    summary: "技能结束时按最大共鸣数获得弹药（完全共鸣×2，完全共鸣≥4则装填）",
    approx: "生蝶/亡蝶按理智随机分配未建模（按总量计）；需人格被动1011002",
    onSkillEnd(c) {
      const m = /basiclimit(\d+)_perfectmul(\d+)_perfectlimit(\d+)(?:_reloadcondition(\d+))?$/.exec(c.script.scriptName)!;
      const perfect = c.battle.perfectResonance ?? 0;
      const reload = m[4] ? Number(m[4]) : Infinity;
      if (perfect >= reload) {
        const cur = c.actor.getPotency("BulletLament");
        if (cur < 20) c.give("actor", "BulletLament", 20 - cur, 0);
        c.note("完全共鸣满足条件：装填弹药至20");
        return;
      }
      const maxAttr = Math.max(0, ...Object.values(c.battle.resonance ?? {}));
      const amount = perfect > 0 ? Math.min(perfect * Number(m[2]), Number(m[3])) : Math.min(maxAttr, Number(m[1]));
      if (amount > 0) c.give("actor", "BulletLament", amount, 0);
    },
  },

  noDamageScript("CheckAdditionalBuffOnEquipEgo", "装备指定E.G.O时视作施加震颤的技能（仅关键词分类）"),

  // SkillAbility_CoinScaleAdderSelfViaTargetSinkingAndWhite: total = target Sinking stack + SinkingWhite stack + turn; total >= div → min(total/div, limit)
  {
    name: /^CoinScaleAdderSelfViaTargetSinkingAndWhite_div(\d+)_limit(\d+)$/,
    summary: "目标沉沦强度与生蝶/亡蝶之和每有N点硬币威力+1（有上限）",
    coinMods(c) {
      const m = /_div(\d+)_limit(\d+)$/.exec(c.script.scriptName)!;
      const div = Number(m[1]);
      const total = c.target.getPotency("Sinking") + whiteTotal(c.target);
      if (total < div) return;
      return { coinScale: Math.min(Math.floor(total / div), Number(m[2])) };
    },
  },

  // CoinAbility_ConsumeAllBulletLamentWithoutNecessary.OnStartCoin: consume all BulletLament (stack + turn) at coin start
  {
    name: /^ConsumeAllBulletLamentWithoutNecessary/,
    summary: "硬币开始时消耗自身全部弹药（消耗量供同技能后续效果使用）",
    approx: "消耗量记录在 BULLET_LAMENT_CONSUMED，供“每消耗1点弹药伤害+4%”等脚本读取",
    coinMods(c) {
      if (c.isRerolled) return;
      const amount = c.actor.getPotency("BulletLament");
      BULLET_LAMENT_CONSUMED.amount = amount;
      BULLET_LAMENT_CONSUMED.turn = c.turn;
      BULLET_LAMENT_CONSUMED.skillId = c.skill?.id ?? 0;
      c.action.shared.set(BULLET_LAMENT_KEY, amount);
      if (amount > 0) {
        c.lose("actor", "BulletLament", amount);
        c.note(`消耗全部弹药 ${amount} 点`);
      }
    },
  },
);

registerAbilities();
