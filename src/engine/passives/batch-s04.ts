/** Script/status batch 04 — see data/il2cpp/dossiers/scripts-04.md */
import { replaceIfBuff } from "./skill-replace";
import { triggerVibrationExplosion } from "../status";
import { noDamageAbility, noDamageScript, registerAbilities, registerScripts, type PassiveCtx, type ScriptCtx, type ScriptData } from "./framework";

type Bd = NonNullable<ScriptData["buffData"]>;

/** buffOwner → container side ("Self" = actor; "Target"/"AbnormalityTarget"/"" = target). */
const ownerSide = (owner?: string): "actor" | "target" => (owner === "Self" ? "actor" : "target");
const giveSide = (target?: string): "actor" | "target" => (target === "Self" ? "actor" : "target");
const pot = (c: PassiveCtx, side: "actor" | "target", id: string) => (side === "actor" ? c.actor : c.target).getPotency(id);
const speedDiff = (c: PassiveCtx) => c.battle.selfSpeed - c.battle.targetSpeed;
const skillScripts = (c: ScriptCtx) => ((c.skillData as { abilityScripts?: ScriptData[] }).abilityScripts ?? []);

/** Apply a buffData entry as GiveBuff_BySkill would (stack = potency, turn = count). */
function giveBd(c: PassiveCtx, bd: Bd, stack = bd.stack ?? 0, turn = bd.turn ?? 0) {
  if (!bd.buffKeyword || (stack <= 0 && turn <= 0)) return;
  c.give(giveSide(bd.target), bd.buffKeyword, Math.max(0, stack), Math.max(0, turn), bd.activeRound === 1 ? 1 : 0);
}

/**
 * SkillAbility_GiveBuffOnSucceedAttackIfHasStack_<Kw><N>: on hit, if the buffOwner unit's <Kw> stack ≥ N → GiveBuff(buffData).
 * CoinAbility_GiveBuffOnSACIfHasStack_<Kw><N>: same, but only on a critical hit (CheckCondition && isCritical).
 */
function ifHasStack(name: string, critOnly: boolean) {
  const m = /_([A-Za-z]+?)(\d+)$/.exec(name)!;
  const kw = m[1] ?? "";
  const n = Number(m[2]);
  return {
    name,
    summary: `命中${critOnly ? "(暴击)" : ""}时若条件单位的[${kw}]≥${n}，施加数据中的状态`,
    onCoinHit(c: ScriptCtx) {
      const bd = c.script.buffData;
      if (!bd || (critOnly && !c.isCritical)) return;
      if (pot(c, ownerSide(bd.buffOwner), kw) >= n) giveBd(c, bd);
    },
  };
}

registerScripts(
  // CoinAbility_1020202_2.OnSucceedAttack: Charge count ≥ 3 → UseBuffTurn(Charge, 3), give Binding 4 next turn.
  {
    name: "1020202_2",
    summary: "命中时若充能≥3层：消耗3层充能，下回合对目标施加4层束缚",
    onCoinHit(c) {
      if (c.actor.getCount("Charge") < 3) return;
      c.actor.consumeCount("Charge", 3);
      c.note("消耗3层充能");
      c.give("target", "Binding", 4, 0, 1);
    },
  },
  // CoinAbility_1020203_3.OnSucceedAttack: Charge count ≥ 5 → consume 5, next turn Reduction 2 + Paralysis 3 on target.
  {
    name: "1020203_3",
    summary: "命中时若充能≥5层：消耗5层充能，下回合对目标施加2层虚弱与3层麻痹",
    onCoinHit(c) {
      if (c.actor.getCount("Charge") < 5) return;
      c.actor.consumeCount("Charge", 5);
      c.note("消耗5层充能");
      c.give("target", "Reduction", 2, 0, 1);
      c.give("target", "Paralysis", 3, 0, 1);
    },
  },
  // SkillAbility_CoinScaleAdderIfNotDamagedPrevTurn: round 1 → 0; RoundDamageInfo.GetDamageSum(prev turn) > 0 → 0; else +N (name digits).
  {
    name: "CoinScaleAdderIfNotDamagedPrevTurn3",
    summary: "上回合未受到伤害时硬币威力+3（第1回合不生效）",
    approx: "模拟中目标不攻击，自身从未受伤",
    skillMods(c) {
      if (c.turn > 1) return { coinScale: 3 };
    },
  },
  noDamageScript("HealMpOnKillTargetEveryAlly10", "击杀时全体友方回复理智并获得伤害强化"),
  noDamageScript("1020503_4", "给体力最低的友方单位迅捷与防御等级提升"),
  noDamageScript("GiveBuffOnBreakOrKillTarget", "目标混乱或击杀时下回合获得增益"),
  ifHasStack("GiveBuffOnSucceedAttackIfHasStack_Burst6", false),
  ifHasStack("GiveBuffOnSucceedAttackIfHasStack_EchoOfMansion1", false),
  ifHasStack("GiveBuffOnSucceedAttackIfHasStack_Combustion10", false),
  ifHasStack("GiveBuffOnSucceedAttackIfHasStack_Combustion15", false),
  ifHasStack("GiveBuffOnSACIfHasStack_RedApricotBlossom10", true),
  // CoinAbility_VEOnSAGiveCrimsonDmgByBgUpRatioWithLimit: Vibration explosion on hit; OnGiveBsGaugeUp(onExplosion) →
  // Wrath damage = gauge shift × 30% (name: Ratio30 × _DEFAULT_RATIO 0.01), capped at 20 (WithLimit20).
  {
    name: "VEOnSAGiveCrimsonDmgByBgUpRatio30WithLimit20",
    summary: "命中时震颤引爆，并造成混乱阈值前移量30%的暴怒伤害(最多20)",
    approx: "阈值前移量按 震颤强度%×目标最大体力（向下取整）换算，未设置目标最大体力时按上限20点计算；本引爆不计入持续伤害统计",
    onCoinHit(c) {
      const rec = triggerVibrationExplosion(c.target, c.turn, `技能 ${c.skill?.id} 震颤引爆`);
      if (!rec) return;
      if (rec.hpDamage > 0) c.extraDamage(rec.hpDamage, "震颤-灼热引爆伤害");
      const maxHp = c.targetMaxHp();
      const amt = maxHp == null ? 20 : Math.min(Math.floor(Math.floor((rec.staggerShift * maxHp) / 100) * 0.3), 20);
      if (amt > 0) c.extraDamage(amt, `震颤引爆附加暴怒伤害（阈值前移×30%，上限20）`, { sin: "CRIMSON" });
    },
  },
  // SkillAbility_AttackDmgUpByRatioViaBuffCheckDevideByStack.GetDmgMultiplier: owner stack ≥ bd.stack && turn ≥ bd.turn →
  // floor(stack / bd.stack) × value (no limit).
  {
    name: "AttackDmgUpByRatioViaBuffCheckDevideByStack",
    summary: "条件单位每带有N层指定状态，伤害+value",
    coinMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const cont = ownerSide(bd.buffOwner) === "actor" ? c.actor : c.target;
      const st = cont.getPotency(bd.buffKeyword);
      const div = Math.max(1, bd.stack ?? 1);
      if (st < (bd.stack ?? 0) || cont.getCount(bd.buffKeyword) < (bd.turn ?? 0)) return;
      const v = Math.floor(st / div) * (bd.value ?? 0);
      if (v > 0) return { dmg: v };
    },
  },
  {
    name: "BlockLoseBuffByReactIfCritical_RedApricotBlossom",
    summary: "暴击时不消耗目标的[RedApricotBlossom]",
    approx: "引擎未模拟红梅被反应消耗，故无需阻止；若红梅消耗被建模需同步处理",
  },
  // CoinAbility_1021003.GetMultiplier (base DmgUpByBuff): owner Charge stack ≥ bd.stack → min(stack × value, limit × 0.01).
  {
    name: "1021003",
    summary: "充能强度≥3 时每级充能使本硬币伤害+8%(最多40%)",
    coinMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const st = pot(c, ownerSide(bd.buffOwner), bd.buffKeyword);
      if (st < (bd.stack ?? 0)) return;
      const v = Math.min(st * (bd.value ?? 0), (bd.limit ?? 0) * 0.01);
      if (v > 0) return { dmg: v };
    },
  },
  // CoinAbility_GiveBuffOnSucceedAttackByDuplicateTurnByStackAddedByValue: give count = owner stack + value, capped by limit.
  {
    name: "GiveBuffOnSucceedAttackByDuplicateTurnByStackAddedByValue_Charge",
    summary: "命中时获得(自身充能强度+value)层充能(不超过limit)",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      let n = pot(c, ownerSide(bd.buffOwner), bd.buffKeyword) + (bd.value ?? 0);
      if ((bd.limit ?? 0) > 0) n = Math.min(n, bd.limit!);
      if (n > 0) c.give(giveSide(bd.target), bd.buffKeyword, 0, n, bd.activeRound === 1 ? 1 : 0);
    },
  },
  // CoinAbility_GiveBuffOnSucceedAttackSetStackAsValueIfHasStack_Charge2: stack = value if owner Charge ≥ 2, else bd.stack.
  {
    name: "GiveBuffOnSucceedAttackSetStackAsValueIfHasStack_Charge2",
    summary: "命中时施加数据中的状态；若自身充能强度≥2，层数改为value",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const ok = pot(c, ownerSide(bd.buffOwner), "Charge") >= 2;
      giveBd(c, bd, ok ? (bd.value ?? bd.stack ?? 0) : (bd.stack ?? 0));
    },
  },
  // SkillAbility_TenthFaustSecondSkillAbility<min>And<maxExcl>And<hp‰>: OnStartTurn_BeforeLog: Charge count in [min, max) →
  // lose (max − count) × hp‰ of max HP and gain Charge up to max. The engine evaluates CoinScaleAdderOnStartTurnViaBuffCheckAndUse
  // before this hook, so its "consume 10 → coin power +value" is re-applied here when the top-up enabled it.
  {
    name: /^TenthFaustSecondSkillAbility(\d+)And(\d+)And(\d+)$/,
    summary: "使用时充能层数在5~9：消耗体力补至10层充能（随后消耗10层充能使硬币威力+2）",
    approx: "自身体力消耗未建模",
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
      c.actor.consumeCount("Charge", need);
      c.note(`充能补至${hi}层后消耗${need}层`);
      return { coinScale: use.buffData?.value ?? 0 };
    },
  },
  // CoinAbility_TenthFaustSecondSkillSecondCoinFirstAbility<res>And<base‰>And<max‰>: OnStartCoin: resonance ≥ res → UseBuffAllTurn(Charge);
  // CalculateDmgMul = used × (Charge stack × 0.01 + base‰/1000), capped at max‰/1000.
  {
    name: /^TenthFaustSecondSkillSecondCoinFirstAbility(\d+)And(\d+)And(\d+)$/,
    summary: "共鸣≥3 时消耗全部充能层数，每层使本硬币伤害+(充能强度+4)%(最多180%)",
    approx: "共鸣数未建模，假设满足共鸣条件",
    coinMods(c) {
      const m = /(\d+)And(\d+)And(\d+)$/.exec(c.script.scriptName)!;
      const key = `used:${c.turn}`;
      let used = c.state.get(key);
      if (used === undefined) {
        used = c.actor.getCount("Charge");
        if (used > 0) c.actor.consumeCount("Charge", used);
        c.state.set(key, used);
        if (used > 0) c.note(`消耗全部${used}层充能`);
      }
      const v = Math.min(used * (c.actor.getPotency("Charge") * 0.01 + Number(m[2]) / 1000), Number(m[3]) / 1000);
      if (v > 0) return { dmg: v };
    },
    onSkillEnd(c) {
      c.state.delete(`used:${c.turn}`);
    },
  },
  {
    // SkillAbility_1021103_special_skill.OnBeforeTurn: self Combustion stack ≥ bd.stack(30) → ChangeSkill(1021105).
    name: "1021103_special_skill",
    summary: "使用前若自身烧伤强度≥30，改为使用“红艳煞 最大感应【劣化侵蚀】”(1021105)",
    beforeUse(c) {
      replaceIfBuff(c, 1021105, { reason: "自身烧伤强度≥30" });
    },
  },
  // SkillAbility_CoinScaleAdder1021103_<lost‰>_<per>_<max>: floor(lostHpRatio / 0.3) × 1, max 2.
  {
    name: "CoinScaleAdder1021103_300_1_2",
    summary: "自身每失去30%体力，硬币威力+1(最多+2)",
    skillMods(c) {
      const v = Math.min(Math.floor(c.battle.lostHpPct / 30) * 1, 2);
      if (v > 0) return { coinScale: v };
    },
  },
  // SkillAbility_CoinScaleAdderOnStartTurnViaBothBuffSumCheckDevideByStackWithLimit<N>: floor((self + target stack) / bd.stack) × value, ≤ N.
  {
    name: /^CoinScaleAdderOnStartTurnViaBothBuffSumCheckDevideByStackWithLimit(\d+)$/,
    summary: "自身与目标的指定状态强度之和每有N级，硬币威力+value(有上限)",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const lim = Number(/(\d+)$/.exec(c.script.scriptName)![1]);
      const sum = c.actor.getPotency(bd.buffKeyword) + c.target.getPotency(bd.buffKeyword);
      const v = Math.min(Math.floor(sum / Math.max(1, bd.stack ?? 1)) * (bd.value ?? 0), lim);
      if (v > 0) return { coinScale: v };
    },
  },
  {
    name: /^SkillPowerAdderOnUseViaBothBuffSumCheckDevideByStackWithLimit(\d+)$/,
    summary: "自身与目标的指定状态强度之和每有N级，基础威力+value(有上限)",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const lim = Number(/(\d+)$/.exec(c.script.scriptName)![1]);
      const sum = c.actor.getPotency(bd.buffKeyword) + c.target.getPotency(bd.buffKeyword);
      const v = Math.min(Math.floor(sum / Math.max(1, bd.stack ?? 1)) * (bd.value ?? 0), lim);
      if (v > 0) return { basePower: v };
    },
  },
  // SkillAbility_AttackDmgUp1021202.CalculateDmgMul: speed diff > 0 → diff × own EnhanceZilu stack × value, ≤ limit × 0.01.
  {
    name: "AttackDmgUp1021202",
    summary: "速度高于目标时伤害+(速度差×自身[EnhanceZilu]层数)%(最多50%)",
    coinMods(c) {
      const bd = c.script.buffData;
      const d = speedDiff(c);
      if (!bd?.buffKeyword || d <= 0) return;
      const v = Math.min(d * pot(c, ownerSide(bd.buffOwner), bd.buffKeyword) * (bd.value ?? 0.01), (bd.limit ?? 0) * 0.01);
      if (v > 0) return { dmg: v };
    },
  },
  // CoinAbility_DmgUp1021202.CalculateDmgMul: target has any of [BurstAgility, BurstZilu] → +value.
  {
    name: "DmgUp1021202",
    summary: "目标带有[BurstAgility]或[BurstZilu]时本硬币伤害+value(50%)",
    coinMods(c) {
      if (c.target.getPotency("BurstAgility") > 0 || c.target.getPotency("BurstZilu") > 0) return { dmg: c.script.value ?? 0.5 };
    },
  },
  // SkillAbility_DmgUp1021203.CalculateDmgMul: speed diff > 0 → diff × target Burst stack × 0.01, ≤ 50%.
  {
    name: "DmgUp1021203",
    summary: "速度高于目标时伤害+(速度差×目标破裂强度)%(最多50%)",
    coinMods(c) {
      const bd = c.script.buffData;
      const d = speedDiff(c);
      if (!bd?.buffKeyword || d <= 0) return;
      const v = Math.min(d * pot(c, ownerSide(bd.buffOwner), bd.buffKeyword) * (bd.value ?? 0.01), (bd.limit ?? 0) * 0.01);
      if (v > 0) return { dmg: v };
    },
  },
  {
    // SkillAbility_SpecialSkill1021203.OnBeforeTurn: self EnhanceZilu stack ≥ 10 (turn ≥ 0) → ChangeSkill(1021205).
    name: "SpecialSkill1021203",
    summary: "使用前若[EnhanceZilu]≥10层，改为使用“黑兽 - 卯 奥义-云解显现”(1021205)",
    beforeUse(c) {
      replaceIfBuff(c, 1021205, { reason: "[EnhanceZilu]≥10" });
    },
  },
  // SkillAbility_AttackDmgUpByUsedArrow10213: ArrowShiFau secondary stack (arrows used) × value, ≤ limit × 0.01.
  {
    name: "AttackDmgUpByUsedArrow10213",
    summary: "每消耗1层[ArrowShiFau]，伤害+11%(最多44%)",
    approx: "引擎不追踪箭矢的累计消耗数（次级层数），以 4−当前箭矢层数 近似",
    skillMods(c) {
      const bd = c.script.buffData;
      const used = Math.max(0, 4 - c.actor.getPotency("ArrowShiFau"));
      const v = Math.min(used * (bd?.value ?? 0.11), (bd?.limit ?? 44) * 0.01);
      if (v > 0) return { dmg: v };
    },
  },
  // SkillAbility_CoinScaleAdder10213.CalculateCoinScaleAdder: (own Breath + main target bd.buffKeyword stack) / bd.stack × value, ≤ limit.
  {
    name: "CoinScaleAdder10213",
    summary: "自身呼吸法强度与目标流血强度之和每有4级，硬币威力+1(有上限)",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const sum = c.actor.getPotency("Breath") + c.target.getPotency(bd.buffKeyword);
      let v = Math.floor(sum / Math.max(1, bd.stack ?? 1)) * (bd.value ?? 1);
      if ((bd.limit ?? 0) > 0) v = Math.min(v, bd.limit!);
      if (v > 0) return { coinScale: v };
    },
  },
);

registerAbilities(
  // BuffAbility_TakeCriticalChanceAdder.GetTakeCriticalChanceAdder (e.g. RedApricotBlossom, value 0.1): attacks against the holder
  // get +value crit chance (BuffDetail.GetTakeCriticalChanceAdder, added to the attacker's unit chance before the multiplier).
  {
    name: "TakeCriticalChanceAdder",
    summary: "对带有本效果的单位攻击时暴击率+value",
    critChance(c) {
      if (c.side !== "target") return;
      return { unit: c.ability.value ?? 0 };
    },
  },
  // GiveBuffOnRoundStart: merged into the single implementation in batch-s05.ts (round-end next-round give from here + turn-1 fallback).
  // BuffAbility_LoseStackOnRoundEndByRatio.OnRoundEnd: lose Round(stack × value). Desc says "减半(向下取整)" → keep floor(stack × (1 − value)).
  {
    name: "LoseStackOnRoundEndByRatio",
    summary: "回合结束时本状态层数按比例减少",
    onRoundEnd(c) {
      const p = c.status.potency;
      const lose = p - Math.floor(p * (1 - (c.ability.value ?? 0)));
      if (lose > 0) c.lose(c.side, c.status.id, lose);
    },
  },
  // BuffAbility_BurstAgility (BurstReactive): when Burst triggers from an attack by a unit with speed ≥ 10: −1 stack and
  // +1 Burst count (buffData); at 0 → Gluttony damage = Burst stack (TakeHpDamageAppliedAttributeResist_Buff) and remove.
  {
    name: "BurstAgility",
    summary: "被速度≥10的单位攻击触发破裂时：本效果-1层并施加1层破裂；归零时受到等于破裂强度的暴食伤害",
    onCoinHit(c) {
      if (c.side !== "target" || c.battle.selfSpeed < 10 || c.target.getPotency("Burst") <= 0) return;
      c.lose("target", c.status.id, 1);
      c.give("target", "Burst", 0, c.ability.buffData?.turn ?? 1);
      if (c.target.getPotency(c.status.id) <= 0) c.extraDamage(c.target.getPotency("Burst"), "咒杀【迅捷】归零：破裂强度的暴食伤害", { sin: "SHAMROCK" });
    },
  },
  noDamageAbility("LegStrength", "获得时的视觉效果"),
  noDamageAbility("ArrowShiFau", "箭矢次级层数记录（语音/计数）"),
  noDamageAbility("ArrowShiFauOnRS", "回合开始时按敌方[ArrowInTheEyeFau]回收箭矢"),
);
