/**
 * Script batch s26 — scripts of the replacement skills reachable through ScriptHandler.beforeUse / c.replaceSkill
 * (SpecialSkill*, *_special_skill, SkillChangeSpecialTo*, ChangeToSpecialSkillOnBeforeTurn*, …):
 * 1011405, 1021105, 1021205, 1041005, 1041205, 1051205, 1051305, 1061105/1061106, 1071405, 1071606, 1091105, 1091505,
 * 1121306, 1121505, 1121605. Values from ISIL (data/il2cpp/isil) + core buffData; described-only parts are noted.
 */
import type { StatusContainer } from "../status";
import { attackWeightDiff } from "../attack-weight";
import { noDamageScript, registerScripts, type ScriptCtx, type ScriptData } from "./framework";

type BD = NonNullable<ScriptData["buffData"]>;

/** AbilityBase.GetSingleUnit: buffOwner/target "Target*" → main target, otherwise the actor. */
const unitOf = (c: ScriptCtx, who?: string): StatusContainer => (who && /^Target/.test(who) ? c.target : c.actor);
const sideOf = (who?: string): "actor" | "target" => (who && /^Target/.test(who) ? "target" : "actor");
/** min(v, limit) when limit > 0. */
const cap = (v: number, limit?: number): number => ((limit ?? 0) > 0 ? Math.min(v, limit!) : v);
/** Once per round per script (c.state is isolated per skill:script). */
function oncePerTurn(c: ScriptCtx): boolean {
  if (c.state.get("turn") === c.turn) return false;
  c.state.set("turn", c.turn);
  return true;
}
/** BattleActionModel.GetUsedBuffStack/Turn (this skill use) divided by bd.stack / bd.turn (ISIL ShiftRight-31 = int division). */
function usedDiv(c: ScriptCtx, bd: BD): number {
  const kw = bd.buffKeyword!;
  let n = 0;
  if ((bd.stack ?? 0) > 0) n += Math.trunc(c.action.consumedStack(kw) / bd.stack!);
  if ((bd.turn ?? 0) > 0) n += Math.trunc(c.action.consumedTurn(kw) / bd.turn!);
  return n;
}

registerScripts(
  // ---------------------------------------------------------------- generic consume-all / consume-on-end
  // SkillAbility_UseBuffAllStackOnUse.OnStartTurn_BeforeLog: GetSingleUnit(bd.target).UseBuffAllStack(kw) + OnUseBuffBySkill.
  {
    name: "UseBuffAllStackOnUse",
    summary: "使用时消耗指定状态的全部强度（计入本技能消耗量）",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const u = unitOf(c, bd.target);
      const p = u.getPotency(bd.buffKeyword);
      if (p > 0) c.lose(sideOf(bd.target), bd.buffKeyword, p);
    },
  },
  // SkillAbility_UseBuffAllStackOnEndSkill.OnEndBehaviour: GetSingleUnit(bd.target).UseBuffAllStack(kw).
  {
    name: "UseBuffAllStackOnEndSkill",
    summary: "技能结束时消耗指定状态的全部强度",
    onSkillEnd(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const p = unitOf(c, bd.target).getPotency(bd.buffKeyword);
      if (p > 0) c.lose(sideOf(bd.target), bd.buffKeyword, p);
    },
  },
  // SkillAbility_UseBuffOnEndSkill.OnEndBehaviour: bd.stack > 0 → UseBuffStack(stack); bd.turn > 0 → UseBuffTurn(turn).
  {
    name: "UseBuffOnEndSkill",
    summary: "技能结束时消耗指定状态的强度/层数",
    onSkillEnd(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const side = sideOf(bd.target);
      const u = unitOf(c, bd.target);
      if ((bd.stack ?? 0) > 0) c.lose(side, bd.buffKeyword, Math.min(bd.stack!, u.getPotency(bd.buffKeyword)));
      if ((bd.turn ?? 0) > 0) c.consume(side, bd.buffKeyword, Math.min(bd.turn!, u.getCount(bd.buffKeyword)));
    },
  },
  // SkillAbility_UseBuffAllStackOnEndAttackToEveryAttackedTargets.OnEndAttack: every attacked target UseBuffAllStack(kw).
  {
    name: "UseBuffAllStackOnEndAttackToEveryAttackedTargets",
    summary: "攻击结束时消耗受到攻击的全体目标的指定状态",
    approx: "单体模拟仅主要目标",
    onSkillEnd(c) {
      const kw = c.script.buffData?.buffKeyword;
      if (!kw) return;
      const p = c.target.getPotency(kw);
      if (p > 0) c.lose("target", kw, p);
      else if (c.target.getCount(kw) > 0) c.consume("target", kw, c.target.getCount(kw));
    },
  },

  // ---------------------------------------------------------------- consumed-amount scaling (BattleActionModel.GetUsedBuffStack/Turn)
  // SkillAbility_CoinScaleAdderViaUsedBuffCheckDevideByStack.GetScaleAdder: Round(value) × (used/stack + used/turn), ≤ limit.
  {
    name: "CoinScaleAdderViaUsedBuffCheckDevideByStack",
    summary: "本技能每消耗N层指定状态，硬币威力+value（有上限）",
    coinMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const v = cap(Math.round(bd.value ?? 1) * usedDiv(c, bd), bd.limit);
      if (v > 0) return { coinScale: v };
    },
  },
  // SkillAbility_SkillPowerAdderViaUsedBuffCheckDevideByStack.GetPowerAdder: same formula → base power.
  {
    name: "SkillPowerAdderViaUsedBuffCheckDevideByStack",
    summary: "本技能每消耗N层指定状态，基础威力+value（有上限）",
    coinMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const v = cap(Math.round(bd.value ?? 1) * usedDiv(c, bd), bd.limit);
      if (v > 0) return { basePower: v };
    },
  },

  // ---------------------------------------------------------------- 1011405 黑风马蹄月斩
  noDamageScript("1011405BattlefieldHorse", "下回合使除自身外的全体友方获得1层战场之马(GiveBuffOnUse EveryAllyExceptSelf)"),

  // ---------------------------------------------------------------- 1021105 红艳煞 最大感应【劣化侵蚀】
  noDamageScript("Immortal1021103", "使用期间体力不低于1，使用后自身阵亡"),
  // SkillAbility_AttackDmgUpByRatio1021103 (1021103 / 1021105): self Combustion stack / bd.stack(5) × value(0.125), ≤ limit‰ (500 → 50%).
  // Exact name so it is not captured by batch-s12's /^AttackDmgUpByRatio(\d+)$/ (which read it as +1021103%).
  {
    name: "AttackDmgUpByRatio1021103",
    summary: "自身每带有5级烧伤强度，本技能伤害+12.5%(最多+50%)",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const n = Math.trunc(unitOf(c, bd.buffOwner).getPotency(bd.buffKeyword) / Math.max(1, bd.stack ?? 1));
      const v = cap(n * (bd.value ?? 0), (bd.limit ?? 0) * 0.001);
      if (v > 0) return { dmg: v };
    },
  },
  // SkillAbility_CoinScaleAdder1021103_<lost‰>_<per>_<max> (s04 registers the exact _300_1_2 variant).
  {
    name: /^CoinScaleAdder1021103_(\d+)_(\d+)_(\d+)$/,
    summary: "自身每失去N%体力，硬币威力+X(有上限)",
    skillMods(c) {
      const m = /_(\d+)_(\d+)_(\d+)$/.exec(c.script.scriptName)!;
      const v = Math.min(Math.floor((c.battle.lostHpPct * 10) / Number(m[1])) * Number(m[2]), Number(m[3]));
      if (v > 0) return { coinScale: v };
    },
  },
  // CoinAbility_AttackDmgUp1021103_<lost‰>_<dmg‰>_<max‰>: (1 − hpRatio) / lost × dmg, ≤ max (×0.001).
  {
    name: /^AttackDmgUp1021103_(\d+)_(\d+)_(\d+)$/,
    summary: "自身每失去N%体力，本硬币伤害+X%(有上限)",
    coinMods(c) {
      const m = /_(\d+)_(\d+)_(\d+)$/.exec(c.script.scriptName)!;
      const lost = 1 - c.selfHpRatio();
      const v = Math.min(Math.floor(lost / (Number(m[1]) * 0.001)) * Number(m[2]) * 0.001, Number(m[3]) * 0.001);
      if (v > 0) return { dmg: v };
    },
  },

  // ---------------------------------------------------------------- 1021305 闪弓 (PassiveAbility_1021302 transformation)
  // SkillAbility_DmgUp1021305: AimForTheGoal × bd.value(0.48) ≤ limit‰… (+144%) to damage and to crit damage; at bd.stack(4) both become
  // crit damage +jsonValue(4.44). Per description; crit only counts when the coin crits.
  {
    name: "DmgUp1021305",
    summary: "每层瞄准伤害+48%、暴击伤害+48%(各最多144%)；瞄准为4层时改为暴击伤害+444%",
    approx: "按描述实现（ISIL 未逐行核对）",
    coinMods(c) {
      const bd = c.script.buffData;
      const aim = c.actor.getPotency(bd?.buffKeyword ?? "AimForTheGoal");
      if (aim <= 0) return;
      if (aim >= (bd?.stack ?? 4)) return c.isCritical ? { dmg: c.script.value ?? 4.44 } : undefined;
      const v = Math.min(aim * (bd?.value ?? 0.48), (bd?.limit ?? 144) * 0.01);
      return { dmg: v + (c.isCritical ? v : 0) };
    },
  },
  // SkillAbility_GiveBuffOnUsePerBuffStack_<kw><n>: on use, per <kw> stack give bd (Breath potency +5).
  {
    name: /^GiveBuffOnUsePerBuffStack_([A-Za-z]+?)(\d+)$/,
    summary: "使用时自身每带有1层指定状态，获得bd状态",
    skillMods(c) {
      const m = /_([A-Za-z]+?)(\d+)$/.exec(c.script.scriptName)!;
      const bd = c.script.buffData;
      const n = Math.trunc(c.actor.getPotency(m[1]!) / Math.max(1, Number(m[2])));
      if (n > 0 && bd?.buffKeyword) c.give(sideOf(bd.target), bd.buffKeyword, n * (bd.stack ?? 0), n * (bd.turn ?? 0));
    },
  },
  // SkillAbility_LoseBuffOnEndAttackPerBuffStackPlusValue_<kw><n>: end attack: lose bd kw by (<kw>/n × stack + value) (Breath −(Aim−1)×5).
  {
    name: /^LoseBuffOnEndAttackPerBuffStackPlusValue_([A-Za-z]+?)(\d+)$/,
    summary: "攻击结束时按指定状态层数减少bd状态强度",
    onSkillEnd(c) {
      const m = /_([A-Za-z]+?)(\d+)$/.exec(c.script.scriptName)!;
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const n = Math.trunc(c.actor.getPotency(m[1]!) / Math.max(1, Number(m[2]))) * (bd.stack ?? 0) + Math.round(bd.value ?? 0);
      const u = unitOf(c, bd.target);
      if (n > 0) c.lose(sideOf(bd.target), bd.buffKeyword, Math.min(n, u.getPotency(bd.buffKeyword)));
    },
  },
  // SkillAbility_DestroyBuffOnEndAttack: end attack: remove bd kw from GetSingleUnit(bd.target).
  {
    name: "DestroyBuffOnEndAttack",
    summary: "攻击结束时解除指定状态",
    onSkillEnd(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const u = unitOf(c, bd.target);
      const side = sideOf(bd.target);
      if (u.getPotency(bd.buffKeyword) > 0) c.lose(side, bd.buffKeyword, u.getPotency(bd.buffKeyword));
      if (u.getCount(bd.buffKeyword) > 0) c.consume(side, bd.buffKeyword, u.getCount(bd.buffKeyword));
    },
  },
  // CoinAbility_ShootArrow1021305: on hit give ArrowInTheEyeFau; when applied, own ArrowShiFau −1.
  {
    name: "ShootArrow1021305",
    summary: "命中时对目标施加1层矢穿之眼，并使自身箭矢层数−1",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      c.give("target", bd.buffKeyword, bd.stack ?? 1, bd.turn ?? 0);
      if (c.actor.getPotency("ArrowShiFau") > 0) c.lose("actor", "ArrowShiFau", 1);
    },
  },
  noDamageScript("OneShotOneKill1021305", "击杀时下回合获得死亡一击（单体无击杀）"),
  { name: "1021305UpgradeAttribute", summary: "闪弓属性升级（未查明）", approx: "未翻译：按无伤害影响计算" },

  // ---------------------------------------------------------------- 1041005 动真格地碎颅
  noDamageScript("GiveMpDmgOnEndSkillSelf15", "技能结束时自身失去15点理智值"),
  // CoinAbility_1041005_1 (ConditionalStack, RedEyeFirst): Laceration potency + clamp(usedRedEye + value(−15), 0, limit).
  {
    name: "1041005_1",
    summary: "命中时使目标增加(消耗的赤瞳层数−15)级流血强度(最多5级)",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const n = cap(c.action.consumedStack("RedEyeFirst") + Math.round(bd.value ?? 0), bd.limit);
      if (n > 0) c.give(sideOf(bd.target), bd.buffKeyword, n, 0);
    },
  },
  // CoinAbility_TenthRyoshuFifthSkillThirdCoinDamageUpAbility<per‰>And<max‰>: (usedRedEye + usedPenance) × per, ≤ max.
  {
    name: /^TenthRyoshuFifthSkillThirdCoinDamageUpAbility(\d+)And(\d+)$/,
    summary: "每消耗1层赤瞳或忏悔，本硬币伤害+4%(最多+160%)",
    coinMods(c) {
      const m = /(\d+)And(\d+)$/.exec(c.script.scriptName)!;
      const used = c.action.consumedStack("RedEyeFirst") + c.action.consumedStack("PenanceFirst");
      const v = Math.min(used * Number(m[1]) * 0.001, Number(m[2]) * 0.001);
      if (v > 0) return { dmg: v };
    },
  },
  noDamageScript("TenthRyoshuFifthSkillThirdCoinFirstAbility", "命中时按消耗的忏悔层数为自身与友方恢复体力"),
  noDamageScript("TenthRyoshuFifthSkillThirdCoinSecondAbility", "命中时按消耗的忏悔层数为自身与友方恢复理智"),
  // CoinAbility_1041005_3_1/_3_2 (GiveBuffOnSucceedAttack gated by SystemAbility_1041005_3_x FindOrAddAbilityThisRound): once per round.
  ...["1041005_3_1", "1041005_3_2"].map((name) => ({
    name,
    summary: "命中时下回合对目标施加束缚/减伤（每回合1次）",
    onCoinHit(c: ScriptCtx) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword || !oncePerTurn(c)) return;
      c.give("target", bd.buffKeyword, bd.stack ?? 0, bd.turn ?? 0, (bd.activeRound ?? 0) > 0 ? 1 : 0);
    },
  })),

  // ---------------------------------------------------------------- 1041205 轻蔑下所倾落的敬畏之视线
  noDamageScript("SubTargetSet1041205", "优先以带视线/轻蔑的敌人为次要目标，次要目标伤害−50%"),
  // SkillAbility_AttackDmgUp1041205: OnStartTurn targetList.Count ≤ 1 → flag; GetAttackDmgMultiplier → jsonValue (2 = +200%).
  {
    name: "AttackDmgUp1041205",
    summary: "仅指定1名目标时，本技能伤害+200%",
    skillMods(c) {
      return { dmg: c.script.value ?? 2 };
    },
  },
  // SkillAbility_AttackDmgUpByRatioViaBuffCheckDivideByStackWithLimitAllTargets.OnStartTurn: Σ targets stack/bd.stack × value ≤ limit%.
  {
    name: "AttackDmgUpByRatioViaBuffCheckDivideByStackWithLimitAllTargets",
    summary: "全体攻击目标的指定状态层数之和每有N层，本技能伤害+value(有上限)",
    approx: "各攻击目标视为与主要目标相同：层数之和 = 主要目标层数 × 命中目标数",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const sum = c.target.getPotency(bd.buffKeyword) * (c.hitTargetCount?.() ?? 1);
      const n = Math.trunc(sum / Math.max(1, bd.stack ?? 1));
      const v = cap(n * (bd.value ?? 0), (bd.limit ?? 0) * 0.01);
      if (v > 0) return { dmg: v };
    },
  },

  // ---------------------------------------------------------------- 1051205 / 1121605: revert when the condition is gone
  // SkillAbility_SpecialSkill1051205.OnBeforeTurn: !CheckCondition (self BulletPropellantSpecialAlly < bd.stack) → ChangeSkill(1051203).
  {
    name: "SpecialSkill1051205",
    summary: "回合开始前若不再带有猛虎标弹，则改回使用1051203",
    beforeUse(c) {
      const bd = c.script.buffData;
      if (bd?.buffKeyword && unitOf(c, bd.buffOwner).getPotency(bd.buffKeyword) < (bd.stack ?? 1)) c.replaceSkill?.(1051203, "不再带有猛虎标弹");
    },
  },
  // SkillAbility_1121605SkillUndo.OnBeforeTurn: self StigmaWorkshopHand(1852) stack < 30 → ChangeSkill(1121603).
  {
    name: "1121605SkillUndo",
    summary: "回合开始前若烙印工坊之手<30层，则改回使用1121603",
    beforeUse(c) {
      const kw = "StigmaWorkshopHandStep1";
      if (c.actor.getPotency(kw) < 30) c.replaceSkill?.(1121603, "烙印工坊之手<30");
    },
  },

  // ---------------------------------------------------------------- 1051305 开幕
  noDamageScript("ReleaseBloodArmorByMaxResonanceAndAdditionalOnUse_limit4", "使用时使(最大共鸣数)名其他友方获得血铠"),
  noDamageScript("AddDinnerOnEndSkillViaKillCount", "按击杀数获得血宴（单体无击杀）"),
  noDamageScript("BloodArmorGainViaBrokenTargetCountIfFourthCoinUsable", "按混乱/部位破坏/击杀目标数获得血铠（单体无混乱/击杀）"),

  // ---------------------------------------------------------------- 1061105 / 1061106 联合技能
  noDamageScript("SkillPowerResultUpOnLoseDuel", "拼点失败时最终威力+5（无拼点）"),
  // CoinAbility_DmgUpByResist10611_<‰>.GetAttackDmgMultiplier: target.GetAtkResistValue(PENETRATE) × N × 0.001.
  {
    name: /^DmgUpByResist10611_(\d+)$/,
    summary: "本硬币伤害+(目标突刺抗性×50)%",
    coinMods(c) {
      const per = Number(/_(\d+)$/.exec(c.script.scriptName)![1]) * 0.001;
      return { dmg: (c.targetResist?.({ atkType: "PENETRATE" }) ?? 1) * per };
    },
  },

  // ---------------------------------------------------------------- 1071405 血天下鸡舞乱刀
  // SkillAbility_1071405RecoveryHpOnEndSkillConsumeBuffOverStack.OnEndBehaviour: over = Combustion − bd.stack(20) > 0 →
  // heal min(over, limit) × value% and UseBuffStack(min(over, limit)).
  {
    name: "1071405RecoveryHpOnEndSkillConsumeBuffOverStack",
    summary: "技能结束时消耗超出20级的烧伤强度(最多25级)并恢复体力",
    onSkillEnd(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const over = cap(c.actor.getPotency(bd.buffKeyword) - (bd.stack ?? 0), bd.limit);
      if (over > 0) c.lose("actor", bd.buffKeyword, over);
    },
  },
  // CoinAbility_1071405OnSucceedAttackToAllTarget (AdditionalDmg, ATTRIBUTE 0 = CRIMSON): trunc(finalDmg × value) to every target
  // via GiveHpDamageAppliedAttributeResist; on the last coin heals by the total.
  {
    name: "1071405OnSucceedAttackToAllTarget",
    summary: "命中时对全体目标额外造成本硬币最终伤害20%的暴怒伤害",
    approx: "副目标视为与主要目标相同（开启“统计副目标伤害”时计入副目标）",
    onCoinHit(c) {
      const d = Math.trunc((c.lastHitDamage ?? 0) * (c.script.value ?? 0.2));
      if (d > 0) c.extraDamage(d, "全体追加暴怒伤害", { sin: "CRIMSON", allTargets: true });
    },
  },

  // ---------------------------------------------------------------- 1071606 解鹿
  // SkillAbility_TargetNumAdderOnStartTurnDivideByBuffStack10716: target num + min(EvolvingManual/stack + value, limit) (if > 0).
  {
    name: "TargetNumAdderOnStartTurnDivideByBuffStack10716",
    summary: "攻击容量+(进化手册层数−1)(最多+2)（单体下用于下方伤害加成）",
  },
  // SkillAbility_AttackDmgMultiplierOnUseByLessThenTargetNumWithSingleBonus_<n>_<single%>:
  // (targetNum − aliveTargets) × jsonValue + (aliveTargets == 1 ? single × 0.01 : 0).
  {
    name: /^AttackDmgMultiplierOnUseByLessThenTargetNumWithSingleBonus_(\d+)_(\d+)$/,
    summary: "攻击容量每高于攻击目标数1点伤害+25%；仅攻击1名目标时伤害+25%",
    skillMods(c) {
      const single = Number(/_(\d+)$/.exec(c.script.scriptName)![1]) * 0.01;
      if (c.attackWeight) {
        const { diff, alive } = attackWeightDiff(c);
        const v = Math.max(0, diff) * (c.script.value ?? 0) + (alive === 1 ? single : 0);
        return v > 0 ? { dmg: v } : undefined;
      }
      const sd = c.skillData as { attrs?: { targetNum?: number }; abilityScripts?: ScriptData[] };
      let targetNum = sd.attrs?.targetNum ?? 1;
      const adder = sd.abilityScripts?.find((s) => s.scriptName === "TargetNumAdderOnStartTurnDivideByBuffStack10716")?.buffData;
      if (adder?.buffKeyword) {
        const n = cap(Math.trunc(c.actor.getPotency(adder.buffKeyword) / Math.max(1, adder.stack ?? 1)) + Math.round(adder.value ?? 0), adder.limit);
        if (n > 0) targetNum += n;
      }
      const v = Math.max(0, targetNum - 1) * (c.script.value ?? 0) + single;
      if (v > 0) return { dmg: v };
    },
  },
  // SkillAbility_GiveBuffAndUseBuffAllStackOnEndAttack10716_<kw>: buffOwner(Target) has <kw> → UseBuffAllStack(kw); then GiveBuff
  // bd (EvolvingManual) to self: stack, or IntegerValue (2) when the target died.
  {
    name: /^GiveBuffAndUseBuffAllStackOnEndAttack10716_([A-Za-z]+)$/,
    summary: "攻击结束时消耗主要目标的全部决斗之刃，自身获得1层进化手册",
    onSkillEnd(c) {
      const kw = /_([A-Za-z]+)$/.exec(c.script.scriptName)![1]!;
      const bd = c.script.buffData;
      const p = c.target.getPotency(kw);
      if (p > 0) c.lose("target", kw, p);
      if (bd?.buffKeyword) c.give("actor", bd.buffKeyword, bd.stack ?? 1, 0);
    },
  },
  // CoinAbility_CoinScaleAdderOnStartCoinDivideByBuff.CalcCoinScaleAdder: GetSingleUnit(bd.target) stack / bd.stack × value ≤ limit.
  {
    name: "CoinScaleAdderOnStartCoinDivideByBuff",
    summary: "硬币开始时自身每带有N层指定状态，本硬币威力+value(有上限)",
    coinMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const v = cap(Math.trunc(unitOf(c, bd.target).getPotency(bd.buffKeyword) / Math.max(1, bd.stack ?? 1)) * Math.round(bd.value ?? 1), bd.limit);
      if (v > 0) return { coinScale: v };
    },
  },

  // ---------------------------------------------------------------- 1091505
  noDamageScript("WideAreaRampageDealAllAtLastCoin", "横扫：最后一枚硬币命中全体攻击目标（单体无影响）"),
  noDamageScript("ForTrigger", "最后硬币全体命中的标记脚本"),

  // ---------------------------------------------------------------- 1121306 夜锥
  // SkillAbility_AttackDmgUpViaMyAgilityYourBinding_limit<N>: (self Agility + target Binding stack) × jsonValue, ≤ N × 0.01.
  {
    name: /^AttackDmgUpViaMyAgilityYourBinding_limit(\d+)$/,
    summary: "自身迅捷层数与目标束缚层数之和每有1层，本技能伤害+15%(最多+60%)",
    coinMods(c) {
      const lim = Number(/(\d+)$/.exec(c.script.scriptName)![1]) * 0.01;
      const n = c.actor.getPotency("Agility") + c.target.getPotency("Binding");
      const v = Math.min(n * (c.script.value ?? 0), lim);
      if (v > 0) return { dmg: v };
    },
  },
  // SkillAbility_AttackDmgMultiplierIfTargetShieldFor11213: target CharacterState.TotalShield > 0 → jsonValue.
  {
    name: "AttackDmgMultiplierIfTargetShieldFor11213",
    summary: "目标带有护盾时本技能伤害+30%",
    approx: "护盾未建模：按目标无护盾计算",
  },
  // SkillAbility_AttackDmgUpForAGradeFourHpRatioNotGreaterThan<N>: hp ≤ N% → jsonValue (+100%), else (1 − hpRatio) (1% → +1%).
  {
    name: /^AttackDmgUpForAGradeFourHpRatioNotGreaterThan(\d+)$/,
    summary: "敌方每失去1%体力本技能伤害+1%；体力≤20%时改为+100%",
    approx: "按主要目标体力比例计算（本体/部位不区分）",
    coinMods(c) {
      const th = Number(/(\d+)$/.exec(c.script.scriptName)![1]) * 0.01;
      const hp = c.targetHpRatio();
      const v = hp <= th ? (c.script.value ?? 1) : 1 - hp;
      if (v > 0) return { dmg: v };
    },
  },

  // ---------------------------------------------------------------- 1121505 最高输出-超高压电流放电
  // SkillAbility_1121505 (: SkillAbility_1121503 : CoinScaleAdderOnStartTurnViaBuffCheckAndUse), name "1121505_<base>_<atk%>":
  // Charge turn ≥ bd.turn(10) → UseBuffTurn(10), coin +value(2), base +<base>, dmg +<atk%>×0.01; then remaining Charge
  // over = min(turn, limit) → UseBuffTurn(over), dmg += over × jsonValue(0.015).
  {
    name: /^1121505_(\d+)_(\d+)$/,
    summary: "充能≥10层时消耗10层：基础威力+1、硬币威力+2；仍有充能则再消耗至多10层，每层伤害+1.5%",
    skillMods(c) {
      const bd = c.script.buffData;
      const m = /_(\d+)_(\d+)$/.exec(c.script.scriptName)!;
      const kw = bd?.buffKeyword ?? "Charge";
      const need = bd?.turn ?? 10;
      if (c.actor.getCount(kw) < need) return;
      c.consume("actor", kw, need);
      const over = cap(c.actor.getCount(kw), bd?.limit);
      if (over > 0) c.consume("actor", kw, over);
      return { basePower: Number(m[1]), coinScale: Math.round(bd?.value ?? 2), dmg: Number(m[2]) * 0.01 + over * (c.script.value ?? 0) };
    },
  },

  // ---------------------------------------------------------------- 1121605 黎明将至
  noDamageScript("11216GiveProtectionOnStartTurn_stack2_activeRound1", "下回合使2名其他友方获得守护"),
  // SkillAbility_CoinScaleAdderOnStartTurnViaBuffCheckDevideByStack.GetScaleAdder: GetSingleUnit(buffOwner) stack / bd.stack
  // × Round(value), ≤ limit.
  {
    name: "CoinScaleAdderOnStartTurnViaBuffCheckDevideByStack",
    summary: "使用时指定单位每带有N级指定状态强度，硬币威力+value(有上限)",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const n = Math.trunc(unitOf(c, bd.buffOwner).getPotency(bd.buffKeyword) / Math.max(1, bd.stack ?? 1));
      const v = cap(n * Math.round(bd.value ?? 1), bd.limit);
      if (v > 0) return { coinScale: v };
    },
  },
  // SkillAbility_11216HpRecoverUsingCombustion_max<M>_start<S>.OnEndAttack: UseBuffStack(Combustion, min(stack, M)); heal (S + used)%.
  {
    name: /^11216HpRecoverUsingCombustion_max(\d+)_start(\d+)$/,
    summary: "攻击结束时消耗自身至多15级烧伤强度并恢复体力",
    onSkillEnd(c) {
      const max = Number(/_max(\d+)/.exec(c.script.scriptName)![1]);
      const n = Math.min(c.actor.getPotency("Combustion"), max);
      if (n > 0) c.lose("actor", "Combustion", n);
    },
  },
  // CoinAbility_ForceToActivateBuffOSA.OnSucceedAttack: target has kw → BuffDetail.ForceToActivateSinBuffEffect, count −bd.turn.
  {
    name: "ForceToActivateBuffOSA",
    summary: "命中时触发目标的指定状态(烧伤/流血等)并使其层数减少",
    approx: "强制触发按当前强度计一次固定伤害",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const p = c.target.getPotency(bd.buffKeyword);
      if (p <= 0 || c.target.getCount(bd.buffKeyword) <= 0) return;
      c.extraDamage(p, `强制触发${bd.buffKeyword}`);
      c.consume("target", bd.buffKeyword, Math.max(1, bd.turn ?? 1));
    },
  },
);
