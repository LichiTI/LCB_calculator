/** Script/status batch 09 — see data/il2cpp/dossiers/scripts-09.md */
import { blockSkillGains, blockSkillReactLoss, noDamageScript, registerScripts, skillGainBlocked, type PassiveCtx, type ScriptCtx } from "./framework";
import type { StatusContainer } from "../status";

// Already covered elsewhere (not re-registered here):
//   CoinScaleAdder2IfSelfHpRatioLessThan50 → batch-s01 /^CoinScaleAdder(\d+)IfSelfHpRatioLessThan(\d+)$/
//   GiveBuffOnSucceedAttackIfHasStack_{NailPersonality5,Vibration5,RetaliationBook1,Burst4} → batch-s03 family (checks buffData.buffOwner)

const side = (c: PassiveCtx, owner: string | undefined): StatusContainer => (owner === "Target" ? c.target : c.actor);
const speedDiff = (c: PassiveCtx) => c.battle.selfSpeed - c.battle.targetSpeed;

function giveFromData(c: ScriptCtx, stack?: number, turn?: number) {
  const bd = c.script.buffData;
  if (!bd?.buffKeyword) return;
  const s = stack ?? bd.stack ?? 0;
  const t = turn ?? bd.turn ?? 0;
  if (s <= 0 && t <= 0) return;
  c.give(bd.target === "Self" ? "actor" : "target", bd.buffKeyword, Math.max(0, s), Math.max(0, t), bd.activeRound === 1 ? 1 : 0);
}

interface CoinScriptLite {
  scriptName?: string;
  buffData?: { buffKeyword?: string; target?: string; stack?: number; turn?: number };
}
/** Does the given coin of the skill carry a GiveBuff* script giving `kw` to the target? */
function coinGivesToTarget(c: ScriptCtx, coinIndex: number | undefined, kw: string): boolean {
  const coins = (c.skillData as { coins?: { abilityScriptList?: CoinScriptLite[] }[] } | undefined)?.coins;
  if (coinIndex === undefined || !coins?.[coinIndex]) return false;
  return (coins[coinIndex]?.abilityScriptList ?? []).some(
    (s) => /^GiveBuff/.test(s.scriptName ?? "") && s.buffData?.buffKeyword === kw && s.buffData?.target === "Target",
  );
}

/** 10511base* condition (OnStartTurn_BeforeLog): target Burst stack ≥ bd.stack(15) and turn ≥ bd.turn(3). */
const cond10511 = (c: ScriptCtx) =>
  c.target.getPotency("Burst") >= (c.script.buffData?.stack ?? 15) && c.target.getCount("Burst") >= (c.script.buffData?.turn ?? 3);

/** BattleActionModel.BlockGivingBuff(Burst) query (set by 10511baseNoUseTurnNoGiveBuff at skill start). */
const burstGivingBlocked = (c: ScriptCtx): boolean => skillGainBlocked(c, "Burst");

/** CoinAbility_10511CoinBase: when Burst giving is blocked, crit dmg +(stack+turn that would be given) × value; otherwise give. */
function coin10511(amount: (c: ScriptCtx) => { stack: number; turn: number }) {
  return {
    coinMods(c: ScriptCtx) {
      if (!burstGivingBlocked(c) || !c.isCritical) return;
      const a = amount(c);
      const v = (a.stack + a.turn) * (c.script.buffData?.value ?? 0);
      if (v > 0) return { dmg: v };
    },
    onCoinHit(c: ScriptCtx) {
      // blocked gives are dropped by the skill-scope interceptor (blockSkillGains)
      const a = amount(c);
      giveFromData(c, a.stack, a.turn);
    },
  };
}

registerScripts(
  // CoinAbility_GiveBuffOnSuccessAttackUsingBuffTurn (BuffByConditionBuffTurn): self Charge turn ≥ 3 → UseBuffTurn(3) and give buffData.
  {
    name: "GiveBuffOnSuccessAttackUsingBuffTurn_Charge3",
    summary: "命中时若自身充能不低于3层，则消耗3层充能并施加指定状态",
    onCoinHit(c) {
      if (c.actor.getCount("Charge") < 3) return;
      c.consume("actor", "Charge", 3);
      giveFromData(c);
    },
  },
  noDamageScript("HealFirstBreakSectionOnSuccessAttackByDamageRatio6", "命中后自身混乱阈值后移"),
  noDamageScript("1050503_4", "震颤爆发并按消耗充能提高混乱阈值前移量"),
  // SkillAbility_BuffStackAndTurnAdderWithBuffInfoIfSelfSpeedNotLessThan<N>.GetBuffStackAdder/GetBuffTurnAdder:
  //   speed ≥ N → buffs of bd.buffKeyword given by this skill get +bd.stack / +bd.turn.
  {
    name: "BuffStackAndTurnAdderWithBuffInfoIfSelfSpeedNotLessThan7",
    summary: "速度不低于7时，本技能施加的指定状态强度/层数额外增加",
    approx: "按“该硬币带有对目标施加该状态的GiveBuff*脚本”在命中后补加，条件型施加(如需消耗充能)可能多算",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword || c.battle.selfSpeed < 7) return;
      if (!coinGivesToTarget(c, c.coinIndex, bd.buffKeyword)) return;
      if ((bd.stack ?? 0) > 0 || (bd.turn ?? 0) > 0) c.give("target", bd.buffKeyword, bd.stack ?? 0, bd.turn ?? 0, 0);
    },
  },
  noDamageScript("1050702_4", "使两侧友方获得嫉妒威力提升/伤害强化"),
  // SkillAbility_1050703_3: resonance count of VIOLET (_CONDITION_TYPE 6) ≥ 4 → +1 coin power.
  {
    name: "1050703_3",
    summary: "嫉妒共鸣数不低于4时硬币威力+1",
    skillMods: (c) => ((c.battle.resonance?.VIOLET ?? 0) >= 4 ? { coinScale: 1 } : undefined),
  },
  // SkillAbility_1050703_4: ResonanceManager.GetMaxPerfectResonance(VIOLET) ≥ 6 → +1 coin power.
  {
    name: "1050703_4",
    summary: "嫉妒完全共鸣数不低于6时硬币威力+1",
    approx: "完全共鸣仅有全局最大值：按最大完全共鸣≥6且嫉妒共鸣≥6判定为嫉妒完全共鸣",
    skillMods: (c) =>
      (c.battle.perfectResonance ?? 0) >= 6 && (c.battle.resonance?.VIOLET ?? 0) >= 6 ? { coinScale: 1 } : undefined,
  },
  noDamageScript("10508012", "战斗开始给予剑契组队友[BladeResultUpTier1]"),
  noDamageScript("10508022", "战斗开始给予剑契组队友[BladeResultUpTier2]"),
  // SkillAbility_CheckAdditionalBuff20509: only GetGivingStackBuff/GetGivingTurnBuff (keyword listing) when a specific E.G.O is equipped.
  noDamageScript("CheckAdditionalBuff20509", "装备特定E.G.O时登记本技能施加流血（仅关键词判定）"),
  noDamageScript("DistoryIgnoreNaturalBreak", "技能结束移除混乱免疫"),
  noDamageScript("GetIgnoreNaturalBreakOnUse", "直到技能结束不会因伤害陷入混乱"),
  noDamageScript("UseNewCounterFirst_1050805", "拼点失败后使用“骨断”反击"),
  // SkillAbility_atkmulMeurAnd: Init parses ints [a, b] from name → per 1% lost HP +a×1e-4, max b%.
  {
    name: /^atkmulMeur(\d+)And(\d+)$/,
    summary: "自身每失去1%体力，伤害+(a×0.01)%(最多+b%)",
    skillMods(c) {
      const m = /^atkmulMeur(\d+)And(\d+)$/.exec(c.script.scriptName);
      if (!m) return;
      const v = Math.min(Number(m[2]) * 0.01, c.battle.lostHpPct * Number(m[1]) * 1e-4);
      if (v > 0) return { dmg: v };
    },
  },
  // SkillAbility_1051003_1.BeforeAttack: UseBuffAllStack(KnowledgeTraining) → give bd.buffKeyword (KnowledgeExplored) consumed × value.
  {
    name: "1051003_1",
    summary: "攻击前消耗全部[KnowledgeTraining]并获得相应层数的[KnowledgeExplored]",
    coinMods(c) {
      if (c.coinIndex !== 0 || c.isRerolled) return;
      const n = c.actor.getPotency("KnowledgeTraining");
      if (n <= 0) return;
      c.lose("actor", "KnowledgeTraining", n);
      c.give("actor", c.script.buffData?.buffKeyword ?? "KnowledgeExplored", n * (c.script.buffData?.value ?? 1), 0, 0);
    },
  },
  // SkillAbility_1051003_2.OnEndBehaviour: KnowledgeExplored ≥ limit (4) → reset to bd.stack (1; bd.value 3 if killed).
  {
    name: "1051003_2",
    summary: "技能结束时若[KnowledgeExplored]不低于4层则重置为1层",
    approx: "击杀时重置为3层未建模",
    onSkillEnd(c) {
      const bd = c.script.buffData;
      const kw = bd?.buffKeyword ?? "KnowledgeExplored";
      const cur = c.actor.getPotency(kw);
      if (cur >= (bd?.limit ?? 4)) c.lose("actor", kw, cur - (bd?.stack ?? 1));
    },
  },
  // SkillAbility_DieciMeursaultSecondSkillAbility: StartBattle → self and 2 allies gain KnowledgeTraining = own KnowledgeExplored; discard 2 skills.
  {
    name: "DieciMeursaultSecondSkillAbility_KnowledgeExplored",
    summary: "战斗开始时自身获得相当于[KnowledgeExplored]层数的[KnowledgeTraining]",
    approx: "给予队友的部分与丢弃技能未模拟",
    skillMods(c) {
      const n = c.actor.getPotency("KnowledgeExplored");
      if (n > 0) c.give("actor", c.script.buffData?.buffKeyword ?? "KnowledgeTraining", n, 0, 0);
    },
  },
  // CoinAbility_DieciMeursaultThirdSkillThirdCoinAbility: on hit, random split of KnowledgeExplored points into Sinking potency/count.
  {
    name: "DieciMeursaultThirdSkillThirdCoinAbility",
    summary: "命中时随机对目标施加沉沦，强度与层数共计[KnowledgeExplored]层数",
    approx: "随机分配按强度⌈n/2⌉、层数⌊n/2⌋取期望",
    onCoinHit(c) {
      const n = c.actor.getPotency("KnowledgeExplored");
      if (n > 0) c.give("target", c.script.buffData?.buffKeyword ?? "Sinking", Math.ceil(n / 2), Math.floor(n / 2), 0);
    },
  },
  // CoinAbility_GiveBuffOnSucceedAttackByDuplicateStackMultipliedByValue_<Kw>: give bd potency = own <Kw> stack × value.
  {
    name: "GiveBuffOnSucceedAttackByDuplicateStackMultipliedByValue_KnowledgeExplored",
    summary: "命中时使目标增加([KnowledgeExplored]层数×value)级沉沦强度",
    onCoinHit(c) {
      const n = side(c, c.script.buffData?.buffOwner).getPotency("KnowledgeExplored") * (c.script.buffData?.value ?? 1);
      if (n > 0) giveFromData(c, n, 0);
    },
  },
  noDamageScript("10511CoinTypo", "仅文本显示"),
  // SkillAbility_10511baseNoUseTurn.OnStartTurn_BeforeLog: target Burst stack ≥ 15 and turn ≥ 3 → BlockLoseBuffByReactWithAction(Burst).
  {
    name: "10511baseNoUseTurn",
    summary: "目标破裂强度≥15且层数≥3时，命中不消耗目标破裂层数",
    skillMods(c) {
      if (cond10511(c)) blockSkillReactLoss(c, "Burst");
    },
  },
  // SkillAbility_10511baseNoUseTurnNoGiveBuff: same condition, plus BlockGivingBuff(Burst) for this skill.
  {
    name: "10511baseNoUseTurnNoGiveBuff",
    summary: "目标破裂强度≥15且层数≥3时，命中不消耗破裂层数且本技能不再增加破裂",
    skillMods(c) {
      if (!cond10511(c)) return;
      blockSkillReactLoss(c, "Burst");
      blockSkillGains(c, "Burst");
    },
  },
  // CoinAbility_AttackDmgUpByRatioPerConcentratedAttackTurnWithMax: +ratio% per ConcentratedAttackMeursault on target, max.
  {
    name: /^AttackDmgUpByRatio(\d+)PerConcentratedAttackTurnWithMax(\d+)$/,
    summary: "目标每带有1层[ConcentratedAttackMeursault]，本硬币伤害+ratio%(上限max%)",
    approx: "行动槽上的层数按目标单位持有层数近似",
    coinMods(c) {
      const m = /^AttackDmgUpByRatio(\d+)PerConcentratedAttackTurnWithMax(\d+)$/.exec(c.script.scriptName);
      if (!m) return;
      const v = Math.min(Number(m[2]) * 0.01, c.target.getPotency("ConcentratedAttackMeursault") * Number(m[1]) * 0.01);
      if (v > 0) return { dmg: v };
    },
  },
  // CoinAbility_GiveBuffOSAIfSelfSpeedNotLessThanLimit10511: speed ≥ bd.limit → give Burst (turn 2); blocked → crit dmg +amount×value.
  {
    name: "GiveBuffOSAIfSelfSpeedNotLessThanLimit10511",
    summary: "速度不低于7时命中对目标施加2层破裂；破裂施加被阻止时改为暴击伤害+每点5%",
    ...coin10511((c) =>
      c.battle.selfSpeed >= (c.script.buffData?.limit ?? 7)
        ? { stack: c.script.buffData?.stack ?? 0, turn: c.script.buffData?.turn ?? 0 }
        : { stack: 0, turn: 0 },
    ),
  },
  // CoinAbility_GiveBuffOnSucceedAttack10511: give Burst potency 4; blocked → crit dmg +amount×value.
  {
    name: "GiveBuffOnSucceedAttack10511",
    summary: "命中时使目标增加4级破裂强度；破裂施加被阻止时改为暴击伤害+每点5%",
    ...coin10511((c) => ({ stack: c.script.buffData?.stack ?? 0, turn: c.script.buffData?.turn ?? 0 })),
  },
  // CoinAbility_GiveBuffOnSucceedAttackSetStackBySpeedDiffIfFasterThanTarget: faster → stack = min(value, speed diff).
  {
    name: "GiveBuffOnSucceedAttackSetStackBySpeedDiffIfFasterThanTarget",
    summary: "速度高于目标时，命中使目标增加相当于速度差的破裂强度(最多3级)",
    onCoinHit(c) {
      const d = speedDiff(c);
      if (d <= 0) return;
      giveFromData(c, Math.min(c.script.buffData?.value ?? 3, d), 0);
    },
  },
  {
    // CoinAbility_LastCoinDmgUpOnSucceedAttackAfterWinDuelByRatio<N>: last coin, clash won → coin damage + N%.
    name: "LastCoinDmgUpOnSucceedAttackAfterWinDuelByRatio10",
    summary: "拼点胜利后最后一枚硬币伤害+10%",
    approx: "仅在可选敌方行动模型（拼点胜利）下触发",
    coinMods(c) {
      const n = (c.skillData as { coins?: unknown[] } | null)?.coins?.length ?? 0;
      if (c.duelResult?.() === "win" && c.coinIndex === n - 1) return { dmg: 0.1 };
    },
  },
  noDamageScript("ReuseSkillOnKillOrDestroyTargetOnceToRandomTarget", "击杀/破坏部位后对随机目标重复使用（不触发）"),
);
