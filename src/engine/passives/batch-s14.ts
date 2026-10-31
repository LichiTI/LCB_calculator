/** Script/status batch 14 — see data/il2cpp/dossiers/scripts-14.md */
import { replaceIfBuff } from "./skill-replace";
import { noDamageAbility, noDamageScript, registerAbilities, registerScripts, type ExtraDamageOpts, type PassiveCtx, type ScriptCtx, type ScriptData } from "./framework";

type Side = PassiveCtx["actor"];
type BD = ScriptData["buffData"];
type RawScript = { scriptName: string; buffData?: BD };

const ownerOf = (c: PassiveCtx, owner?: string): Side => (owner === "Target" || owner === "AbnormalityTarget" ? c.target : c.actor);
const skillScripts = (c: ScriptCtx) => ((c.skillData as { abilityScripts?: RawScript[] }).abilityScripts ?? []);
const ar = (bd: BD) => ((bd?.activeRound ?? 0) ? 1 : 0) as 0 | 1;
/** GiveBuff with buffData target (Self → actor, otherwise target). */
function giveBd(c: PassiveCtx, bd: BD, stack: number, turn: number): void {
  if (!bd?.buffKeyword || (stack <= 0 && turn <= 0)) return;
  c.give(bd.target === "Self" ? "actor" : "target", bd.buffKeyword, Math.max(0, stack), Math.max(0, turn), ar(bd));
}
const perTurnOnce = (c: PassiveCtx, key = "once") => {
  const k = `${key}:${c.turn}`;
  if (c.state.get(k)) return false;
  c.state.set(k, 1);
  return true;
};

/** Charge count spent by the current action (BattleActionModel.UsedBuffTurn(Charge)), from the engine's per-action record. */
function chargeUsedThisSkill(c: ScriptCtx): number {
  return c.action.consumedTurn("Charge");
}

/** Extra HP damage = trunc(finalDmg × ratio), then GiveHpDamageApplied{Attribute,Atk}Resist via opts. */
function extraByRatio(c: ScriptCtx, ratio: number, desc: string, opts?: ExtraDamageOpts): void {
  const d = Math.trunc((c.lastHitDamage ?? 0) * ratio);
  if (d > 0) c.extraDamage(d, `${desc} ${Math.round(ratio * 100)}%`, opts);
}

const maxResonance = (c: PassiveCtx) => Math.max(0, ...Object.values(c.battle.resonance ?? {}));

registerScripts(
  {
    // CoinAbility_GiveBuffOSAIfUsedChargeTurnNotLessThanValueByThisSkill.CheckCondition: action.UsedBuffTurn(Charge) ≥ round(bd.value)
    name: "GiveBuffOSAIfUsedChargeTurnNotLessThanValueByThisSkill",
    summary: "命中时若本技能消耗的充能层数≥value，则施加指定状态",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (chargeUsedThisSkill(c) >= Math.round(bd?.value ?? 1)) giveBd(c, bd, bd?.stack ?? 0, bd?.turn ?? 0);
    },
  },
  {
    // CoinAbility_GiveBuffOnSucceedAttackByDuplicateStackMultipliedByValue_Charge: stack = owner Charge potency × value, cap limit
    name: "GiveBuffOnSucceedAttackByDuplicateStackMultipliedByValue_Charge",
    summary: "命中时自身每2级充能强度施加1层指定状态（最多 limit 层）",
    approx: "Util.Round 取整方式按描述“每2级1层”取下整",
    onCoinHit(c) {
      const bd = c.script.buffData;
      let n = Math.floor(ownerOf(c, bd?.buffOwner).getPotency("Charge") * (bd?.value ?? 1));
      if ((bd?.limit ?? 0) > 0) n = Math.min(n, bd!.limit!);
      giveBd(c, bd, n, bd?.turn ?? 0);
    },
  },
  {
    // CoinAbility_GiveBuffOnSucceedAttackByDuplicateTurnByStackMultipliedByValue_Charge: turn = owner Charge potency × value, cap limit
    name: "GiveBuffOnSucceedAttackByDuplicateTurnByStackMultipliedByValue_Charge",
    summary: "命中时获得(自身充能强度×3)层充能（最多9层）",
    onCoinHit(c) {
      const bd = c.script.buffData;
      let n = Math.trunc(ownerOf(c, bd?.buffOwner).getPotency("Charge") * (bd?.value ?? 1));
      if ((bd?.limit ?? 0) > 0) n = Math.min(n, bd!.limit!);
      giveBd(c, bd, bd?.stack ?? 0, n);
    },
  },
  {
    // SkillAbility_NinthHeathcliffSecondSkillAbility<min>And<maxExcl>And<hp‰>: Charge count in [5,10) → lose HP, Charge up to 10.
    // The generic CoinScaleAdderOnStartTurnViaBuffCheckAndUse (use 10 → coin +2) runs before this hook, so re-apply it after the top-up.
    name: "NinthHeathcliffSecondSkillAbility5And10And20",
    summary: "使用时充能层数在5~9：消耗体力补至10层充能（随后消耗10层充能使硬币威力+2）",
    approx: "自身体力消耗(2%×差值)未建模",
    skillMods(c) {
      const m = /(\d+)And(\d+)And(\d+)$/.exec(c.script.scriptName)!;
      const lo = Number(m[1]);
      const hi = Number(m[2]);
      const cnt = c.actor.getCount("Charge");
      if (cnt < lo || cnt >= hi) return;
      c.give("actor", "Charge", 0, hi - cnt);
      const use = skillScripts(c).find((s) => s.scriptName === "CoinScaleAdderOnStartTurnViaBuffCheckAndUse" && s.buffData?.buffKeyword === "Charge");
      const need = use?.buffData?.turn ?? 0;
      if (!use || c.actor.getCount("Charge") < need) return;
      c.consume("actor", "Charge", need);
      return { coinScale: use.buffData?.value ?? 0 };
    },
  },
  noDamageScript("1071003", "击杀目标时向其他敌人扩散沉沦（击杀不模拟）"),
  // GiveBuffOnSucceedAttackIfHasStack_WanderingFootsteps1: covered by the generic pattern in batch-s03 (AbnormalityTarget → target).
  {
    // SkillAbility_1071103_special_skill.OnBeforeTurn: self Bullet_LogicAtelier(792) stack > 0 → ChangeSkill(1071105).
    name: "1071103_special_skill",
    summary: "使用前若带有逻辑工作室弹药，改为使用“逻辑工作室制 高速粉碎弹”(1071105)",
    beforeUse(c) {
      replaceIfBuff(c, 1071105, { keyword: "Bullet_LogicAtelier", owner: "Self", stack: 1, turn: 0, reason: "带有逻辑工作室弹药" });
    },
  },
  {
    // SkillAbility_ChangeBuffAndAttackDmgUp1071103.OnStartTurn_BeforeLog: n = LogicAtelierAM stack → UseBuffAllStack,
    // Breath potency + n × jsonValue; dmg = n × bd.value
    name: "ChangeBuffAndAttackDmgUp1071103",
    summary: "使用时消耗所有逻辑工作室弹匣，每层使呼吸法强度+2、本技能伤害+12.5%(特殊弹25%)",
    skillMods(c) {
      const n = c.actor.getPotency("LogicAtelierAM");
      if (n <= 0) return;
      c.lose("actor", "LogicAtelierAM", n);
      c.give("actor", c.script.buffData?.buffKeyword ?? "Breath", Math.trunc(n * (c.script.value ?? 0)), 0);
      return { dmg: n * (c.script.buffData?.value ?? 0) };
    },
  },
  {
    // CoinAbility_CriticalDmgUpByResist1071103_<‰>: crit → target PENETRATE resist × 0.5
    name: "CriticalDmgUpByResist1071103_500",
    summary: "暴击时伤害+(目标突刺抗性×50)%",
    // GetAttackDmgMultiplier: isCritical → target.GetAtkResistValue(PENETRATE) × (N × _DEFAULT_RATIO 0.001).
    coinMods(c) {
      if (!c.isCritical) return;
      const per = Number(/_(\d+)$/.exec(c.script.scriptName)?.[1] ?? 500) * 0.001;
      const r = c.targetResist?.({ atkType: "PENETRATE" }) ?? 1;
      return { dmg: r * per };
    },
  },
  {
    // CoinAbility_UseBullet[necessary:Bullet_LogicAtelier:1] (1071105 coin 1): spend the Atelier Logic round (initBuffs 1).
    name: "UseBullet[necessary:Bullet_LogicAtelier:1]",
    summary: "硬币使用时消耗1发逻辑工作室弹药；不足时硬币不发动",
    beforeCoin(c) {
      if (!c.isRerolled && c.actor.getPotency("Bullet_LogicAtelier") <= 0) c.cancelCoin("逻辑工作室弹药不足");
    },
    coinMods(c) {
      if (!c.isRerolled && c.actor.getPotency("Bullet_LogicAtelier") > 0) c.lose("actor", "Bullet_LogicAtelier", 1);
    },
  },
  {
    // CoinAbility_UseBullet[necessary:Bullet:1:...]: spend 1 Bullet when the coin is used
    name: "UseBullet[necessary:Bullet:1::FullStopHeathForThreeSkill]",
    summary: "硬币使用时消耗1发弹药；弹药不足时硬币不发动",
    approx: "重投时不再消耗/检查弹药",
    beforeCoin(c) {
      if (!c.isRerolled && c.actor.getPotency("Bullet") <= 0) c.cancelCoin("弹药不足（UseBullet[necessary:Bullet:1]）");
    },
    coinMods(c) {
      if (c.isRerolled) return;
      if (c.actor.getPotency("Bullet") > 0) c.lose("actor", "Bullet", 1);
    },
  },
  {
    // CoinAbility_LastCoinDmgUpOnSucceedAttackByRatio: arms the action's last coin (+10%) — that coin does not carry this script
    name: "LastCoinDmgUpOnSucceedAttackByRatio10",
    summary: "命中时使本技能最后一枚硬币伤害+10%",
    approx: "硬币脚本无法修改其他硬币的伤害（最后一枚硬币不携带该脚本），未建模",
  },
  {
    // CoinAbility_CoinScaleAdderBeforeRollCoinAndUseBuffTurnMax.OnStartCoin: used = min(Charge turn, bd.turn) → UseBuffTurn, coin + used × value
    name: "CoinScaleAdderBeforeRollCoinAndUseBuffTurnMax",
    summary: "硬币投掷前消耗最多10层充能，每层使本硬币威力+1",
    coinMods(c) {
      const bd = c.script.buffData;
      const key = `CoinScaleAdderBeforeRoll:${c.coinIndex}`;
      let used = c.action.shared.get(key) as number | undefined;
      if (used === undefined) {
        used = Math.min(ownerOf(c, bd?.buffOwner).getCount(bd?.buffKeyword ?? "Charge"), bd?.turn ?? 10);
        if (used > 0) c.consume("actor", bd?.buffKeyword ?? "Charge", used);
        c.action.shared.set(key, used);
      }
      return { coinScale: used * (bd?.value ?? c.script.value ?? 1) };
    },
  },
  {
    // SkillAbility_GiveBuffOnBattleStartByDuplicateStackWithZero_Charge: min(Charge potency, limit) + value → ChargeForceField (1/turn)
    name: "GiveBuffOnBattleStartByDuplicateStackWithZero_Charge",
    summary: "战斗开始时获得(2+充能强度)层充能力场（最多6层，每回合1次）",
    approx: "充能力场为防御效果",
    skillMods(c) {
      if (!perTurnOnce(c)) return;
      const bd = c.script.buffData;
      const n = Math.min(c.actor.getPotency("Charge"), bd?.limit ?? 4) + (bd?.value ?? 0);
      giveBd(c, bd, n, bd?.turn ?? 0);
    },
  },
  {
    // CoinAbility_1071403GiveAdditionalShamrockDmgToAllTargetsOnSucceedAttack: finalDmg × min(selfBurn + mainTargetBurn, limit)% to all targets
    name: "1071403GiveAdditionalShamrockDmgToAllTargetsOnSucceedAttack",
    summary: "命中时对全体目标额外造成最终伤害×(自身+主要目标烧伤强度)%的暴食伤害（最多20%）",
    approx: "副目标视为与主要目标相同（开启“统计副目标伤害”时计入副目标）",
    onCoinHit(c) {
      const sum = c.actor.getPotency("Combustion") + c.target.getPotency("Combustion");
      extraByRatio(c, Math.min(sum, c.script.buffData?.limit ?? 20) * 0.01, "暴食追加伤害", { sin: "SHAMROCK", allTargets: true });
    },
  },
  {
    // CoinAbility_GiveAdditionalCrimsonDmgOnSATargetByRatioByBuffStack: finalDmg × min(selfBurn × value, limit%)
    name: "GiveAdditionalCrimsonDmgOnSATargetByRatioByBuffStack",
    summary: "命中时额外造成最终伤害×(自身烧伤强度×2)%的暴怒伤害（最多20%）",
    onCoinHit(c) {
      const bd = c.script.buffData;
      const st = ownerOf(c, bd?.buffOwner).getPotency(bd?.buffKeyword ?? "Combustion");
      extraByRatio(c, Math.min(st * (bd?.value ?? 0), (bd?.limit ?? 0) * 0.01), "暴怒追加伤害", { sin: "CRIMSON" });
    },
  },
  noDamageScript("GiveBuffDamageOnSucceedAttackHeadCheckCurrentHp", "正面命中时自身受到烧伤伤害"),
  {
    // SkillAbility_SpecialSkill1071405 (_SPECIAL_SKILL_ID 1071405).OnBeforeTurn: self ChickenFightlust stack ≥ 20 → ChangeSkill.
    name: "SpecialSkill1071405",
    summary: "使用前血斗本能≥20层时改为使用“血天下鸡舞乱刀”(1071405)",
    beforeUse(c) {
      replaceIfBuff(c, 1071405, { reason: "血斗本能≥20" });
    },
  },
  {
    // SkillAbility_CoinScaleAdderCheckSumOfTwoBuffStack_<A>_<B>.CalculateCoinScaleAdder: owner A + B stack ≥ bd.stack → round(value) (live)
    name: /^CoinScaleAdderCheckSumOfTwoBuffStack_([A-Za-z]+)_([A-Za-z]+)$/,
    summary: "目标两种状态强度之和不低于指定值时硬币威力+value",
    coinMods(c) {
      const m = /_([A-Za-z]+)_([A-Za-z]+)$/.exec(c.script.scriptName)!;
      const bd = c.script.buffData;
      const o = ownerOf(c, bd?.buffOwner);
      if (o.getPotency(m[1]!) + o.getPotency(m[2]!) >= (bd?.stack ?? 0)) return { coinScale: Math.round(c.script.value ?? 0) };
    },
  },
  {
    // CoinAbility_GiveAdditionalHitDamageByVioletResonance1071505_<max%>: finalDmg × min(Envy resonance × jsonValue, max%), HIT resist
    name: "GiveAdditionalHitDamageByVioletResonance1071505_30",
    summary: "命中时额外造成最终伤害×(嫉妒共鸣数×5)%的打击伤害（最多30%）",
    onCoinHit(c) {
      extraByRatio(c, Math.min((c.battle.resonance?.VIOLET ?? 0) * (c.script.value ?? 0), 0.3), "打击追加伤害", { atkType: "HIT" });
    },
  },
  noDamageScript("GiveBuffOnBattleStartToBothSideAllies", "战斗开始时给予仪表盘两侧友方攻击等级提升"),
  noDamageScript("GiveBuffOnKillEnemy", "击杀敌人时获得状态（击杀不模拟）"),
  noDamageScript("HealFirstBreakSectionOSAWithoutBreak_5", "命中时混乱阈值后移"),
  {
    // SkillAbility_SkillLevelAdderOnBattleStartDivideByResonance_<limit>: min(floor(max sin resonance / value), limit) offense levels
    name: /^SkillLevelAdderOnBattleStartDivideByResonance_(\d+)$/,
    summary: "战斗开始时按最大共鸣数/value 增加攻击等级（有上限）",
    skillMods(c) {
      const lim = Number(/_(\d+)$/.exec(c.script.scriptName)![1]);
      const v = Math.min(Math.floor(maxResonance(c) / Math.max(1, c.script.value ?? 1)), lim);
      if (v > 0) return { offense: v };
    },
  },
  {
    // SkillAbility_SkillPowerResultAdderDivideByResonance_<SIN>_<div>_<max>: min(floor(resonance[SIN] / div) × value, max)
    name: /^SkillPowerResultAdderDivideByResonance_([A-Z]+)_(\d+)_(\d+)$/,
    summary: "每有div点指定罪孽共鸣数使最终威力+value（有上限）",
    approx: "参数含义按描述推断（类未在 ISIL 中细看）",
    skillMods(c) {
      const m = /_([A-Z]+)_(\d+)_(\d+)$/.exec(c.script.scriptName)!;
      const v = Math.min(Math.floor((c.battle.resonance?.[m[1]!] ?? 0) / Number(m[2])) * (c.script.value ?? 1), Number(m[3]));
      if (v > 0) return { finalPower: v };
    },
  },
  noDamageScript("ChangeAllCoinToSuperCoinOnStartTurn10716_DuelEdgeAlly_EvolvingManual", "硬币转化为不可摧毁硬币（仅拼点）"),
  {
    // SkillAbility_ChangeToSpecialSkillOnBeforeTurn1071606.OnBeforeTurn: target DuelEdgeAlly stack ≥ 5 → ChangeSkill(1071606).
    name: "ChangeToSpecialSkillOnBeforeTurn1071606",
    summary: "使用前若目标决斗之刃为5层，改为使用“解鹿”(1071606)",
    beforeUse(c) {
      replaceIfBuff(c, 1071606, { reason: "目标[DuelEdgeAlly]≥5" });
    },
  },
  {
    // SkillAbility_GiveAdditionalBuffOnStartTurn10716: target DuelEdgeAlly > 0 → system ability 506 (extra Vibration/Combustion given)
    name: "GiveAdditionalBuffOnStartTurn10716_DuelEdgeAlly",
    summary: "按目标决斗之刃层数使本技能增加的震颤/烧伤强度与层数额外+1",
    approx: "修改技能施加状态数量的能力缺失，未建模",
  },
);

registerAbilities(
  {
    // BuffAbility_GiveBuffOnREPerStack.OnRoundEnd: n = floor(stack / value) → GiveBuff(bd.stack × n, bd.turn × n), capped by limit
    name: "GiveBuffOnREPerStack",
    summary: "回合结束时每带有value层本效果，给予指定状态（有上限）",
    onRoundEnd(c) {
      const bd = c.ability.buffData;
      const per = c.ability.value ?? 0;
      if (!bd?.buffKeyword || per <= 0) return;
      const n = Math.floor(c.status.potency / per);
      if (n <= 0) return;
      let stack = (bd.stack ?? 0) * n;
      if ((bd.limit ?? 0) > 0) stack = Math.min(stack, bd.limit!);
      const turn = (bd.turn ?? 0) * n;
      const side = bd.target === "Self" || !bd.target ? c.side : c.side === "actor" ? "target" : "actor";
      if (stack > 0 || turn > 0) c.give(side, bd.buffKeyword, stack, turn, ar(bd));
    },
  },
  noDamageAbility("MinSpeedAdderPerBuffStack", "每N层最小速度+1"),
  {
    // BuffAbility_AtkDamageMultiplierViaBuffCheckDevideByStack: owner stack ≥ bd.stack → floor(stack / bd.stack) × value (cap limit% if > 0)
    name: "AtkDamageMultiplierViaBuffCheckDevideByStack",
    summary: "每带有N层指定状态使造成的伤害+value",
    coinMods(c) {
      if (c.side !== "actor") return;
      const bd = c.ability.buffData;
      if (!bd?.buffKeyword) return;
      const st = ownerOf(c, bd.buffOwner).getPotency(bd.buffKeyword);
      const div = Math.max(1, bd.stack ?? 1);
      if (st < div) return;
      let d = Math.floor(st / div) * (c.ability.value ?? 0);
      if ((bd.limit ?? 0) > 0) d = Math.min(d, bd.limit! * 0.01);
      if (d > 0) return { dmg: d };
    },
  },
  noDamageAbility("ChickenStance_3", "使敌人混乱/击杀时恢复理智并获得增益"),
);
