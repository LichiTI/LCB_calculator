/** Script/status batch 06 — see data/il2cpp/dossiers/scripts-06.md */
import { noDamageAbility, noDamageScript, registerAbilities, registerScripts, type PassiveCtx, type ScriptCtx } from "./framework";

type Side = PassiveCtx["actor"];
type RawScript = { scriptName: string; buffData?: { buffKeyword?: string; target?: string; buffOwner?: string; stack?: number } };

const LE_NOIR = [10315, 10416, 10617];
/** BUFF_CATEGORY_KEYWORD.CHARGE members except ChargeLoad (core.json categoryKeywordList). */
const CHARGE_IDS = [
  "Charge", "ChargeNoirAlly", "ChargeNoir", "ChargeRouge", "ChargeRougeAlly", "ChargeKhaki", "ChargeKhakiAlly", "ChargeBodyArt",
  "BlackTearsAlly", "HumanBloodTheRings", "HumanBoneTheRings", "HumanFleshTheRings", "NoirShield", "PenanceFirst", "PenanceSecond",
  "PenanceThird", "PowerOfLoveAndJustice", "RedEyeFirst", "RedEyeSecond", "RedEyeThird", "ThePowerOfLoveAndHate",
];
const has = (s: Side, id: string) => s.getPotency(id) > 0 || s.getCount(id) > 0;
const isDefault = (c: PassiveCtx) => ["S1", "S2", "S3"].includes(c.skill?.slot ?? "");
const isLastCoin = (c: PassiveCtx) => c.skill != null && c.coinIndex === c.skill.coinCount - 1;
const ownerOf = (c: PassiveCtx, owner?: string) => (owner === "Target" ? c.target : c.actor);
const perTurnOnce = (c: PassiveCtx, key = "once") => {
  const k = `${key}:${c.turn}`;
  if (c.state.get(k)) return false;
  c.state.set(k, 1);
  return true;
};

/** IndexUtility.GetUnlockRank: highest active UnlockBuff_N (N = 3/2/1). */
function unlockRank(c: PassiveCtx): number {
  for (const n of [3, 2, 1]) if (["UnlockBuff_", "UnlockBuffAlly_", "UnlockBuff_Rien"].some((p) => has(c.actor, `${p}${n}`))) return n;
  return 0;
}

/**
 * Stack at OnBattleStart (before WhenUse). The engine evaluates handler skillMods after the skill's own on-use grants were
 * applied, so subtract what this skill's GiveBuffOnUse* scripts grant to self for that keyword.
 */
function bsStack(c: ScriptCtx, kw: string): number {
  const sd = c.skillData as { abilityScripts?: RawScript[] };
  let own = 0;
  for (const s of sd.abilityScripts ?? []) {
    const bd = s.buffData;
    if (/^GiveBuffOnUse/.test(s.scriptName) && bd?.buffKeyword === kw && (bd.target ?? "Self") === "Self") own += bd.stack ?? 0;
  }
  return Math.max(0, c.actor.getPotency(kw) - own);
}

/** (target buffData keyword potency + target NoirNail stack) — SkillAbility_*NailSum*1031501/1031502.GetSumStack. */
const nailSum = (c: ScriptCtx) => c.target.getPotency(c.script.buffData?.buffKeyword ?? "Vibration") + c.target.getPotency("NoirNailDonQuixote");

const damagedTurn = new WeakMap<Side, number>();

registerScripts(
  {
    // SkillAbility_GiveBuffOnUseWithBloodDinner(GainBuffStackIfFailed): use ≤50 BloodDinner in steps of 5 → 1 BloodArmor per 5;
    // FailToUseBloodDinner → self Laceration +5 potency (name suffix)
    name: "GiveBuffOnUseWithBloodDinnerGainBuffStackIfFailed_Laceration5[5:50:5]",
    summary: "使用时消耗最多50层血宴（每5层获得1层血铠）；未消耗时自身流血强度+5",
    approx: "[5:50:5] 按“步长5、上限50”解析；血铠为防御效果",
    skillMods(c) {
      const use = Math.min(50, Math.floor(c.actor.getPotency("BloodDinner") / 5) * 5);
      if (use > 0) {
        c.lose("actor", "BloodDinner", use);
        c.give("actor", c.script.buffData?.buffKeyword ?? "BloodArmorPersonalityFirst", (use / 5) * (c.script.buffData?.stack ?? 1), 0);
      } else c.give("actor", "Laceration", 5, 0);
    },
  },
  {
    // CoinAbility_CriticalDmgUpByBreathCombustionStack.CalculateDmgMultiplier: (self Breath + target Combustion) × 1%, ≤ jsonValue; crit only
    name: "CriticalDmgUpByBreathCombustionStack",
    summary: "暴击时伤害+(自身呼吸法强度+目标烧伤强度)%（上限=value）",
    coinMods(c) {
      if (!c.isCritical) return;
      return { dmg: Math.min((c.actor.getPotency("Breath") + c.target.getPotency("Combustion")) * 0.01, c.script.value ?? 0) };
    },
  },
  {
    // CoinAbility_GiveBuffOnSucceedAttackDevideByStackWithLimitEastDonqui.GetNewStack: min(floor(Burn/6)×stack, 5) + target DianxueDonQuixote stack
    name: "GiveBuffOnSucceedAttackDevideByStackWithLimitEastDonqui5_Combustion6",
    summary: "命中时目标每6级烧伤强度施加1层防御等级降低（最多5层，每回合1次），并额外施加点穴层数的防御等级降低",
    onCoinHit(c) {
      if (!perTurnOnce(c)) return;
      const bd = c.script.buffData;
      const n = Math.min(Math.floor(c.target.getPotency("Combustion") / 6) * (bd?.stack ?? 1), 5) + c.target.getPotency("DianxueDonQuixote");
      if (n > 0) c.give("target", bd?.buffKeyword ?? "DefenseDown", n, bd?.turn ?? 0, (bd?.activeRound ?? 0) as 0 | 1);
    },
  },
  {
    // SkillAbility_GiveBuffOnSucceedAttackIfHasStack: target DianxueDonQuixote ≥1 → give buffData (3 DefenseDown)
    name: "GiveBuffOnSucceedAttackIfHasStack_DianxueDonQuixote1",
    summary: "命中时若目标带有点穴，则施加3层防御等级降低",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (c.target.getPotency("DianxueDonQuixote") >= 1 && bd?.buffKeyword) c.give("target", bd.buffKeyword, bd.stack ?? 0, bd.turn ?? 0, (bd.activeRound ?? 0) as 0 | 1);
    },
  },
  {
    // ...DivideByStackWithMinCondition.CalculateDmgMul (OnStartTurn snapshot): stack ≥ max(div, 2) → min(stack/div × value, limit%)
    name: "AttackDmgUpByRatioOnUseViaBuffCheckDivideByStackWithMinCondition2",
    summary: "使用时爱憎强度≥2，则伤害+(强度×25%)（最多125%）",
    approx: "按引擎结算顺序读取（本技能其他使用时效果消耗/获得爱憎后），与游戏脚本顺序可能不同",
    skillMods(c) {
      const bd = c.script.buffData;
      const st = ownerOf(c, bd?.buffOwner).getPotency(bd?.buffKeyword ?? "ThePowerOfLoveAndHate");
      const div = Math.max(1, bd?.stack ?? 1);
      if (st < Math.max(div, 2)) return;
      return { dmg: Math.min(Math.floor(st / div) * (bd?.value ?? 0), (bd?.limit ?? 0) / 100) };
    },
  },
  {
    // CoinAbility_GiveBuffOnSucceedAttackIfMainTarget: single target is always the main target
    name: "GiveBuffOnSucceedAttackIfMainTarget",
    summary: "命中时对主要目标施加状态（如下回合恶徒印记）",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (bd?.buffKeyword) c.give("target", bd.buffKeyword, bd.stack ?? 0, bd.turn ?? 0, (bd.activeRound ?? 0) as 0 | 1);
    },
  },
  {
    // SkillAbility_SkillPowerAdderOnUseViaBuffCheck.CheckCondition: owner stack ≥ bd.stack && turn ≥ bd.turn → base power + round(value)
    name: "SkillPowerAdderOnUseViaBuffCheck",
    summary: "使用时若指定状态强度/层数达到条件，则基础威力+value",
    approx: "按引擎结算顺序读取（本技能其他使用时效果已结算），与游戏脚本顺序可能不同",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const o = ownerOf(c, bd.buffOwner);
      if (o.getPotency(bd.buffKeyword) >= (bd.stack ?? 0) && o.getCount(bd.buffKeyword) >= (bd.turn ?? 0) && has(o, bd.buffKeyword))
        return { basePower: Math.round(bd.value ?? 0) };
    },
  },
  {
    // SkillAbility_AttackDmgUpOnBSViaBuffCheck.OnBattleStart: min(stack × value, limit × 0.01)
    name: "AttackDmgUpOnBSViaBuffCheck",
    summary: "战斗开始时每层生角使本技能伤害+10%（最多30%）",
    approx: "战斗开始时的层数按“使用时层数−本技能使用时获得量”近似",
    skillMods(c) {
      const bd = c.script.buffData;
      const st = bsStack(c, bd?.buffKeyword ?? "GrownHorns");
      if (st > 0) return { dmg: Math.min(st * (bd?.value ?? 0), (bd?.limit ?? 0) * 0.01) };
    },
  },
  {
    // SkillAbility_ChangeLastCoinToSuperCoinAndDmgUpOnBSViaBuffCheck_<min>_<per%>_<max%>: last coin dmg + min(stack×5,15)%
    name: "ChangeLastCoinToSuperCoinAndDmgUpOnBSViaBuffCheck_1_5_15",
    summary: "战斗开始带有生角时最后一枚硬币变为不可摧毁硬币，每层生角使其伤害+5%（最多15%）",
    approx: "不可摧毁硬币仅影响拼点；层数按战斗开始时近似",
    coinMods(c) {
      if (!isLastCoin(c)) return;
      const st = bsStack(c, c.script.buffData?.buffKeyword ?? "GrownHorns");
      if (st >= 1) return { dmg: Math.min(st * 5, 15) / 100 };
    },
  },
  noDamageScript("ChangeSuperCoinOnBSViaBuffCheck", "所有硬币转化为不可摧毁硬币（仅拼点）"),
  {
    // SkillAbility_CoinPowerAdder1031303_<div>_<per>_<max>.GetCoinScaleAdder: floor((Burst+Sinking)/6)×1, ≤2 (live)
    name: "CoinPowerAdder1031303_6_1_2",
    summary: "目标破裂与沉沦强度之和每6级使硬币威力+1（最多+2）",
    coinMods(c) {
      return { coinScale: Math.min(Math.floor((c.target.getPotency("Burst") + c.target.getPotency("Sinking")) / 6), 2) };
    },
  },
  {
    // CoinAbility_DmgMultiplierIfHasPanicChangeViaStackWithLimit: BuffDetail.GetChangePanicTypeBuff count × 10%, ≤30%
    name: "DmgMultiplierIfHasPanicChangeViaStackWithLimit_10_30",
    summary: "目标每带有1种改变恐慌类型的状态，本硬币伤害+10%（最多30%）",
    approx: "无法识别“改变恐慌类型”的状态（游戏内接口判定），未建模",
  },
  {
    // CoinAbility_GiveAdditionalSlashDmgOnSAIfHasBuffReinforce_25_50: finalDmg × (target has CrushMarks ? 50% : 25%) × slash resist
    name: "GiveAdditionalSlashDmgOnSAIfHasBuffReinforce_25_50",
    summary: "命中时额外造成本硬币最终伤害25%的斩击伤害（目标带有粉碎印记时50%）",
    onCoinHit(c) {
      const ratio = has(c.target, c.script.buffData?.buffKeyword ?? "CrushMarks") ? 0.5 : 0.25;
      const dmg = Math.trunc((c.lastHitDamage ?? 0) * ratio);
      if (dmg > 0) c.extraDamage(dmg, `追加斩击伤害 ${ratio * 100}%`, { atkType: "SLASH" });
    },
  },
  {
    // CoinAbility_GiveAdditionalSlashDmgOnSAViaBuffCheck: finalDmg × min(selfStack × value, limit%) × slash resist
    name: "GiveAdditionalSlashDmgOnSAViaBuffCheck",
    summary: "命中时每层生角额外造成本硬币最终伤害10%的斩击伤害（最多30%）",
    onCoinHit(c) {
      const bd = c.script.buffData;
      const st = ownerOf(c, bd?.buffOwner).getPotency(bd?.buffKeyword ?? "GrownHorns");
      const ratio = Math.min(st * (bd?.value ?? 0), (bd?.limit ?? 0) / 100);
      const dmg = Math.trunc((c.lastHitDamage ?? 0) * ratio);
      if (dmg > 0) c.extraDamage(dmg, `生角追加斩击伤害 ${Math.round(ratio * 100)}%`, { atkType: "SLASH" });
    },
  },
  {
    name: "GiveBuffOnSAIfHasPanicChangeBuff",
    summary: "命中时若目标带有改变恐慌类型的状态，则施加3层沉沦（每回合1次）",
    approx: "无法识别“改变恐慌类型”的状态，未建模",
  },
  {
    // SkillAbility_AttackDmgUpByIndexUnlockRankWithLimit.CalcDmgMul: rank × value, ≤ 120%
    name: "AttackDmgUpByIndexUnlockRankWithLimit120",
    summary: "解锁阶段每1阶段使本硬币伤害+40%（最多120%）",
    coinMods(c) {
      const d = Math.min(unlockRank(c) * (c.script.value ?? 0), 1.2);
      if (d > 0) return { dmg: d };
    },
  },
  {
    // SkillAbility_CoinScaleAdderIndexMark: HasSystemAbility(IndexPrescriptTargetMark) → coin power + round(value)
    name: "CoinScaleAdderIndexMark",
    summary: "本技能被指令标记时硬币威力+1",
    approx: "假设所用基础攻击技能已被指令标记（与指令被动处理一致）",
    coinMods(c) {
      return { coinScale: Math.round(c.script.value ?? 0) };
    },
  },
  {
    // SkillAbility_SkillPowerResultAdderViaSelfBreathAndBuffDivide: floor((self Breath + target Sinking)/stack) × value, ≤ limit
    name: "SkillPowerResultAdderViaSelfBreathAndBuffDivide",
    summary: "自身呼吸法强度与目标沉沦强度之和每4级使最终威力+1（最多+4）",
    coinMods(c) {
      const bd = c.script.buffData;
      const sum = c.actor.getPotency("Breath") + ownerOf(c, bd?.buffOwner).getPotency(bd?.buffKeyword ?? "Sinking");
      return { finalPower: Math.min(Math.floor(sum / Math.max(1, bd?.stack ?? 4)) * (bd?.value ?? 1), bd?.limit ?? 4) };
    },
  },
  {
    // ...SuperCoinOnBSAndDmgUpPerIndexUnlockRankIfRankNotLessThan: rank ≥ value → super coins, dmg min(rank × 0.2, 60%)
    name: "SuperCoinOnBSAndDmgUpPerIndexUnlockRankIfRankNotLessThan",
    summary: "解锁阶段≥2时硬币变为不可摧毁硬币，每阶段伤害+20%（最多60%）",
    skillMods(c) {
      const r = unlockRank(c);
      const bd = c.script.buffData;
      if (r >= (c.script.value ?? 0) && r > 0) return { dmg: Math.min(r * (bd?.value ?? 0), (bd?.limit ?? 0) / 100) };
    },
  },
  {
    // SkillAbility_CoinScaleAdderOnStartTurnViaNailSumDivide1031502_<max>: floor((Vibration + NoirNail)/stack) × value, ≤ max
    name: "CoinScaleAdderOnStartTurnViaNailSumDivide1031502_2",
    summary: "使用时目标震颤强度与漆黑之钉层数之和每6点使硬币威力+1（最多+2）",
    skillMods(c) {
      const bd = c.script.buffData;
      return { coinScale: Math.min(Math.floor(nailSum(c) / Math.max(1, bd?.stack ?? 6)) * (bd?.value ?? 1), 2) };
    },
  },
  {
    // SkillAbility_GiveChargeTurnOnUseToSelfAndLeastChargeLeNoirAlly1031501_4: self Charge +4 count (1/turn) + least-charge Le Noir ally
    name: "GiveChargeTurnOnUseToSelfAndLeastChargeLeNoirAlly1031501_4",
    summary: "使用时自身获得4层充能（每回合1次）",
    approx: "给予黑派友方的充能不影响自身",
    skillMods(c) {
      if (perTurnOnce(c)) c.give("actor", "Charge", 0, 4);
    },
  },
  {
    // CoinAbility_GiveNoirNailUseCharge1031502 (over12_add1_use4_2): ChargeNoirAlly count ≥12 → +1 nail and spend 4 charge
    name: "GiveNoirNailUseCharge1031502_over12_add1_use4_2",
    summary: "命中时施加1层漆黑之钉；黑派充能≥12层时消耗4层充能并额外施加1层",
    approx: "名称参数含义按 ISIL 推断（_2 未确定，未使用）",
    onCoinHit(c) {
      const bd = c.script.buffData;
      let n = bd?.stack ?? 1;
      if (c.actor.getCount("ChargeNoirAlly") >= 12) {
        c.actor.consumeCount("ChargeNoirAlly", 4);
        c.note("消耗4层黑派充能，额外施加1层漆黑之钉");
        n += 1;
      }
      c.give("target", bd?.buffKeyword ?? "NoirNailDonQuixote", n, 0);
    },
  },
  {
    name: "LastCoinResultAdderOnBAViaMaxResonanceToLimit1031502_1_4",
    summary: "每1点最大共鸣数使最后一枚硬币最终威力+1（最多+4；共鸣取场景 battle.resonance）",
    coinMods(c) {
      if (c.coinIndex !== (c.skill?.coinCount ?? 0) - 1) return;
      const m = /_(\d+)_(\d+)$/.exec(c.script.scriptName)!;
      const maxRes = Math.max(0, ...Object.values(c.battle.resonance ?? {}));
      const v = Math.min(Math.floor(maxRes / Math.max(1, Number(m[1]))), Number(m[2]));
      if (v > 0) return { finalPower: v };
    },
  },
  {
    // SkillAbility_ResonanceLevelUpToFastestLeNoirOBS1031503.OnBattleStart: self + fastest Le Noir ally: AttackUp 2, DefenseUp 2 (1/turn)
    name: "ResonanceLevelUpToFastestLeNoirOBS1031503_2_2",
    summary: "战斗开始时自身获得2层攻击等级提升与2层防御等级提升（每回合1次）",
    approx: "怠惰完全共鸣相关部分与给予友方的效果未建模",
    skillMods(c) {
      if (!perTurnOnce(c)) return;
      c.give("actor", "AttackUp", 2, 0);
      c.give("actor", "DefenseUp", 2, 0);
    },
  },
  {
    // SkillAbility_SkillPowerResultAdderViaNailSumDivide1031501_<max> (OnUse snapshot): floor((Vibration + NoirNail)/4) × value, ≤3
    name: "SkillPowerResultAdderViaNailSumDivide1031501_3",
    summary: "使用时目标震颤强度与漆黑之钉层数之和每4点使最终威力+1（最多+3）",
    skillMods(c) {
      const bd = c.script.buffData;
      return { finalPower: Math.min(Math.floor(nailSum(c) / Math.max(1, bd?.stack ?? 4)) * (bd?.value ?? 1), 3) };
    },
  },
  {
    // CoinAbility_1040102_2: RoundAllDmgInfo.GetDamageSum(target) > 0 → +30%
    name: "1040102_2",
    summary: "目标本回合已受到伤害时本硬币伤害+30%",
    approx: "仅追踪本技能此前硬币/本脚本记录的命中；其他技能本回合造成的伤害未计入",
    coinMods(c) {
      if ((c.coinIndex ?? 0) > 0 || damagedTurn.get(c.target) === c.turn) return { dmg: 0.3 };
    },
    onCoinHit(c) {
      damagedTurn.set(c.target, c.turn);
    },
  },
);

registerAbilities(
  noDamageAbility("DianxueMark", "点穴替换/解除判定（威力加成由施加者被动处理）"),
  noDamageAbility("ArcanaQueenOfHate_-25", "回合结束理智值变为-25"),
  {
    name: "LoseBuffStackOnRoundEndIfMpMoreThan_0",
    summary: "理智值≥0时回合结束层数-1",
    approx: "理智值不可读，未建模",
  },
  {
    // BuffAbility_AtkDamageMultiplierByOtherBuffStackIfDefaultSkill: default skill → min(other buff stack × value, limit%)
    name: "AtkDamageMultiplierByOtherBuffStackIfDefaultSkill",
    summary: "基础攻击技能每1级指定状态强度伤害+value（上限 limit%）",
    coinMods(c) {
      if (c.side !== "actor" || !isDefault(c)) return;
      const bd = c.ability.buffData;
      if (!bd?.buffKeyword) return;
      const st = ownerOf(c, bd.buffOwner).getPotency(bd.buffKeyword);
      const d = Math.min(st * (bd.value ?? 0), (bd.limit ?? 0) / 100);
      if (d > 0) return { dmg: d };
    },
  },
  noDamageAbility("NoirShieldUpDonQuixote", "回合开始获得护盾"),
  // BuffAbility_ChangeToSuperCoinIfDefaultAttackSkillViaBuffCheck: own bd keyword stack ≥ bd.stack and default (S1–S3) skill →
  //   every coin → SuperCoin (clash-only).
  {
    name: "ChangeToSuperCoinIfDefaultAttackSkillViaBuffCheck",
    summary: "硬币变为不可摧毁硬币（仅拼点）",
    onSkillStart(c) {
      const bd = c.ability.buffData;
      if (c.side !== "actor" || !isDefault(c) || !bd?.buffKeyword) return;
      if (c.actor.getPotency(bd.buffKeyword) >= (bd.stack ?? 0)) c.coins?.makeSuper("all");
    },
  },
  noDamageAbility("IgnoreBreakExceptForcedCaseViaBuffCheck", "不会陷入混乱"),
  noDamageAbility("NoirHaloEffectDonQuixote", "特效"),
  noDamageAbility("OathFieldAuraToAlly", "友方使用技能时获得护盾"),
  {
    // OathFieldAuraToLeNoirAlly (system ability 565): Le Noir allies offense + min(floor(ChargeNoirAlly potency / 3), 2)
    name: "OathFieldAuraToLeNoirAlly",
    summary: "黑派友方攻击等级+(黑派充能强度/3)（最多+2）",
    approx: "防御等级加成不影响输出；系统能力数值按描述",
    coinMods(c) {
      if (c.side !== "actor" || !LE_NOIR.includes(c.identityId)) return;
      const o = Math.min(Math.floor(c.actor.getPotency("ChargeNoirAlly") / 3), 2);
      if (o > 0) return { offense: o };
    },
  },
  {
    // OathFieldAuraToEnemy → SystemAbility_OathFieldAuraEnemy (566).GetTakeAttackDmgMultiplier: attacker skill uses Charge
    //   (SkillModel.IsUseBuffTurn / BattleActionModel.IsUseBuffStack, CHARGE category except ChargeLoad) →
    //   _DMG_RATIO 10 × 0.01, × _LE_NOIR_MULTIPLY 2 when the attacker is LE_NOIR. Holder is the field owner (Don, actor side).
    name: "OathFieldAuraToEnemy",
    summary: "敌方受到消耗充能技能的伤害+10%（黑派人格+20%）",
    approx: "“技能消耗充能”按本次行动已消耗的充能类状态或技能脚本名（UseCharge/UsingBuff/UseBuff…Charge）判断；速度-1与震颤引爆混乱阈值加成不影响伤害",
    coinMods(c) {
      if (c.side !== "actor" || !c.skill) return;
      const spent = CHARGE_IDS.some((id) => (c.action?.consumedTurn(id) ?? 0) > 0 || (c.action?.consumedStack(id) ?? 0) > 0);
      const declares = (c.skillScripts ?? []).some((n) => /UseCharge|UseAllCharge|UsingBuff|UseBuff\w*Charge|Charge\w*Use/i.test(n));
      if (!spent && !declares) return;
      return { dmg: 0.1 * (LE_NOIR.includes(c.identityId) ? 2 : 1) };
    },
  },
  noDamageAbility("OathFieldMapEffect", "场景特效"),
  {
    // BuffAbility_VibrationFocusing.OnVibrationExplosion: giver's highest CHARGE-category stack (except ChargeLoad) →
    //   ratio = min((value 60 + Round(bd.value 8) × charge) × 0.01, bd.limit 120 × 0.01);
    //   SLOTH dmg trunc(Vibration stack × ratio), then LoseBuffTurn 1.
    name: "VibrationFocusing",
    summary: "受到震颤引爆时受到震颤强度×(60+攻击者充能强度×8)%（最多120%）的怠惰伤害并减少1层",
    onVibrationExplosion(c, ev) {
      if (c.side !== ev.side) return;
      const giver = c.side === "target" ? c.actor : c.target;
      const charge = Math.max(0, ...CHARGE_IDS.map((id) => giver.getPotency(id)));
      const bd = c.ability.buffData;
      const base = c.ability.value ?? 60;
      let ratio = (base + Math.round(bd?.value ?? 8) * charge) * 0.01;
      if ((bd?.limit ?? 0) > 0) ratio = Math.min(ratio, bd!.limit! * 0.01);
      const dmg = Math.trunc(c.status.potency * ratio);
      if (dmg > 0 && c.side === "target") c.extraDamage(dmg, `震颤-聚焦引爆：${c.status.potency}×${Math.round(ratio * 100)}%`, { sin: "AMBER" });
      c.consume(c.side, c.status.id, 1);
    },
  },
);
