/** Script/status batch 17 — see data/il2cpp/dossiers/scripts-17.md */
import {
  blockSkillGains,
  blockSkillReactLoss,
  noDamageAbility,
  noDamageScript,
  registerAbilities,
  registerScripts,
  skillGainBlocked,
  type PassiveCtx,
  type ScriptCtx,
} from "./framework";

// Already covered elsewhere (not re-registered here):
//   TenthFaustSecondSkillAbility0And10And30 / 0And15And30 → batch-s04 /^TenthFaustSecondSkillAbility(\d+)And(\d+)And(\d+)$/
//   GiveBuffOnSucceedAttackIfHasStack_{NailPersonality1,TimeRentalTwoPersonality1} → batch-s03 family (checks buffData.buffOwner)
//   GiveBuffOnSucceedAttackIfHasTurn_Vibration6 → batch-s01 /^GiveBuffOnSucceedAttackIfHasTurn_.../

const SACK = "DevyatDimensionalSack";

function giveFromData(c: ScriptCtx, stack?: number, turn?: number) {
  const bd = c.script.buffData;
  if (!bd?.buffKeyword) return;
  const s = Math.max(0, stack ?? bd.stack ?? 0);
  const t = Math.max(0, turn ?? bd.turn ?? 0);
  if (s <= 0 && t <= 0) return;
  c.give(bd.target === "Self" ? "actor" : "target", bd.buffKeyword, s, t, bd.activeRound === 1 ? 1 : 0);
}

/** Per-turn limit helper (state is per skill+script). */
function takeTurn(c: PassiveCtx, key: string, max: number): boolean {
  const k = `${key}:${c.turn}`;
  const used = c.state.get(k) ?? 0;
  if (used >= max) return false;
  c.state.set(k, used + 1);
  return true;
}

/** 10910base-family condition (SkillAbility_10910base*.OnStartTurn_BeforeLog): target Burst stack ≥ 15 and turn ≥ 3. */
const burstCond = (c: PassiveCtx, stack = 15, turn = 3) => c.target.getPotency("Burst") >= stack && c.target.getCount("Burst") >= turn;

interface ScriptLite {
  scriptName?: string;
  buffData?: { stack?: number; turn?: number };
}
/** Finds a skill-level script of this skill by name pattern (scripts cannot share state). */
function skillScript(c: ScriptCtx, re: RegExp): ScriptLite | undefined {
  const scripts = (c.skillData as { abilityScripts?: ScriptLite[] } | undefined)?.abilityScripts ?? [];
  return scripts.find((s) => re.test(s.scriptName ?? ""));
}

/** UNIT_KEYWORD.N_CORP_FNATIC identities (core.json associations). */
const N_CORP_FANATIC = ["10204", "10304", "10504", "10704", "10904", "11005"];

/** Unresolved GiveBuffOnBattleStart109110x classes, per desc: use BloodDinner (≤ max, per `per`, max 2 units) → self +1 BloomingThorns per unit; none used → self Laceration +5. */
function bloodDinnerBattleStart(max: number, per: number, enhancement: number) {
  return (c: ScriptCtx) => {
    if (enhancement > 0) c.give("actor", "Enhancement", enhancement, 0, 0);
    const units = Math.min(2, Math.floor(Math.min(c.actor.getPotency("BloodDinner"), max) / per));
    if (units > 0) {
      c.lose("actor", "BloodDinner", units * per);
      c.give("actor", "BloomingThornsRodionFirst", units, 0, 0);
    } else {
      c.give("actor", "Laceration", 5, 0, 0);
    }
  };
}

registerScripts(
  // SkillAbility_SkillPowerAdderOnOwnMpIsNegative<N>: own SP < 0 → +N skill power.
  {
    name: /^SkillPowerAdderOnOwnMpIsNegative(\d+)$/,
    summary: "自身理智值低于0时技能基础威力+N",
    skillMods(c) {
      const n = Number(/(\d+)$/.exec(c.script.scriptName)?.[1] ?? 0);
      if (c.actorSp < 0 && n > 0) return { basePower: n };
    },
  },
  // SkillAbility_CriticalChanceUpByRatioViaBuff.GetCriticalChanceMultiplier: owner(bd.buffOwner) stack ≥ bd.stack && turn ≥ bd.turn
  // → bd.value (summed into SkillModel.GetCriticalChanceMultiplier; value 1 = crit chance ×2).
  {
    name: "CriticalChanceUpByRatioViaBuff",
    summary: "目标流血强度≥6时自身暴击率翻倍",
    critChance(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const o = bd.buffOwner === "Self" ? c.actor : c.target;
      if (o.getPotency(bd.buffKeyword) < (bd.stack ?? 0) || o.getCount(bd.buffKeyword) < (bd.turn ?? 0)) return;
      return { mul: bd.value ?? 1 };
    },
  },
  {
    name: "CoinScaleAdder2IfNextSkillIsAtkType_HIT",
    summary: "仪表盘下一个技能为打击技能时硬币威力+2",
    approx: "类未解析；仪表盘技能顺序未模拟，未建模",
  },
  // SkillAbility_CoinScaleAdderIfMainTargetNotDamagedThisTurn<N>: main target took no attack damage this turn → +N coin power.
  {
    name: /^CoinScaleAdderIfMainTargetNotDamagedThisTurn(\d+)$/,
    summary: "目标本回合未受到攻击伤害时硬币威力+N",
    approx: "仅按“本技能为本回合第一次使用”判定，其他技能先命中目标的情况未计入",
    // timing audit: GetCoinScaleAdder reads RoundDamageInfo.GetDamageSum(main target) on every coin → once the first coin
    // has hit, later coins (and rerolls) no longer qualify → only the first, non-rerolled coin of the turn's first use.
    coinMods(c) {
      if ((c.coinIndex ?? 0) !== 0 || c.isRerolled) return;
      const n = Number(/(\d+)$/.exec(c.script.scriptName)?.[1] ?? 0);
      if (takeTurn(c, "firstUse", 1) && n > 0) return { coinScale: n };
    },
  },
  // SkillAbility_1090403_gaksung_4th.GetAttackDmgMultiplier: alive allies (incl. self) with N_CORP_FNATIC × 0.05.
  {
    name: "1090403_gaksung_4th",
    summary: "队伍中每有1名存活的N公司狂信徒，伤害+5%",
    approx: "仅统计场景中声明的队友（含自身）；描述中狂信+15%由其他脚本处理",
    skillMods(c) {
      let n = N_CORP_FANATIC.includes(String(c.identityId)) ? 1 : 0;
      for (const id of N_CORP_FANATIC) if (id !== String(c.identityId) && c.allyPresent(id)) n++;
      if (n > 0) return { dmg: n * 0.05 };
    },
  },
  // CoinAbility_1090502_2(_gaksung): gives buffData; CheckReRoll: Charge turn ≥ value(3), heads, rerolls < 2;
  //   each reroll stack +2 (gaksung); on 2nd reroll → Vibration explosion and target loses 1 Vibration turn.
  {
    name: "1090502_2_gaksung",
    summary: "命中使目标震颤强度+2；充能≥3且正面时重复使用本硬币(最多2次，每次额外+2)，第2次重复时震颤引爆并减少1层震颤",
    approx: "震颤引爆本身不造成伤害，未建模混乱阈值",
    rerolls(c) {
      return c.actor.getCount("Charge") >= (c.script.buffData?.value ?? 3) && c.isHeads !== false ? 2 : 0;
    },
    onCoinHit(c) {
      const n = c.state.get("reuse") ?? 0;
      giveFromData(c, (c.script.buffData?.stack ?? 0) + (c.isRerolled ? 2 : 0), 0);
      if (c.isRerolled) {
        c.state.set("reuse", n + 1);
        if (n + 1 === 2) c.consume("target", "Vibration", 1);
      }
    },
    onSkillEnd(c) {
      c.state.delete("reuse");
    },
  },
  noDamageScript("GiveAdditionalDmgOnSuccessAttackTargetIfBreak25", "目标陷入混乱时追加伤害（不模拟混乱）"),
  {
    name: "CoinScaleAdder2IfSelfShieldNotLessThan15",
    summary: "自身护盾不低于15时硬币威力+2",
    approx: "引擎未建模护盾，按护盾0计算",
  },
  {
    name: "GiveBuffOnUseIfSelfShieldNotLessThan15",
    summary: "自身护盾不低于15时获得呼吸法层数",
    approx: "引擎未建模护盾，按护盾0计算",
  },
  // SkillAbility_1090703.GetScaleAdder: base (floor(stack / bd.stack) × bd.value) − 1, if > 0.
  {
    name: "1090703",
    summary: "[KnowledgeExplored]不低于2层时硬币威力+(层数−1)",
    skillMods(c) {
      const bd = c.script.buffData;
      const n = c.actor.getPotency(bd?.buffKeyword ?? "KnowledgeExplored");
      const v = Math.floor(n / (bd?.stack || 1)) * (bd?.value ?? 1) - 1;
      if (v > 0) return { coinScale: v };
    },
  },
  noDamageScript("HealFirstBreakSectionOnSuccessAttack10", "命中后自身混乱阈值后移"),
  // CoinAbility_LiuRodionSecondSkillThirdCoinAbility: target Combustion turn ≥ N → 2 enemies with lowest Combustion gain bd.stack potency.
  {
    name: /^LiuRodionSecondSkillThirdCoinAbility_Combustion(\d+)$/,
    summary: "目标烧伤层数不低于N时，使烧伤最低的2名敌人增加3级烧伤强度",
    approx: "单目标模拟：按主要目标本身获得计",
    onCoinHit(c) {
      const n = Number(/(\d+)$/.exec(c.script.scriptName)?.[1] ?? 0);
      if (c.target.getCount("Combustion") >= n) c.give("target", "Combustion", c.script.buffData?.stack ?? 3, 0, 0);
    },
  },
  noDamageScript("GiveBuffOnSuccessAttackIfSkillUsedBuffTurnThisAction_Vibration1", "使用技能时消耗震颤则下回合施加束缚"),
  // SkillAbility_10910base: condition → BlockLoseBuffByReactWithAction(Burst) + BlockGivingBuff(Burst stack) for this skill.
  {
    name: "10910base",
    summary: "目标破裂强度≥15且层数≥3时，命中不消耗破裂层数且命中效果不增加破裂强度",
    skillMods(c) {
      if (!burstCond(c, c.script.buffData?.stack, c.script.buffData?.turn)) return;
      blockSkillReactLoss(c, "Burst");
      blockSkillGains(c, "Burst", { kinds: ["stack"] });
    },
  },
  {
    name: "10910baseBlockOnlyLose",
    summary: "目标破裂强度≥15且层数≥3时，命中不消耗破裂层数",
    skillMods(c) {
      if (burstCond(c, c.script.buffData?.stack, c.script.buffData?.turn)) blockSkillReactLoss(c, "Burst");
    },
  },
  // CoinAbility_GiveBuffOnSucceedAttackHeadSetStackAsValueIfHasStack_<Kw><N>: heads hit → give buffData; own <Kw> ≥ N → stack = value.
  {
    name: /^GiveBuffOnSucceedAttackHeadSetStackAsValueIfHasStack_([A-Za-z]+?)(\d+)$/,
    summary: "正面命中时施加指定状态；自身指定状态不低于N层时层数改为value(每回合1次)",
    onCoinHit(c) {
      if (c.isHeads === false) return;
      const m = /_([A-Za-z]+?)(\d+)$/.exec(c.script.scriptName);
      if (!m || !takeTurn(c, "head", 1)) return;
      const boosted = c.actor.getPotency(m[1] ?? "") >= Number(m[2]);
      giveFromData(c, boosted ? c.script.buffData?.value : undefined);
    },
  },
  // CoinAbility_GiveBuffOnSucceedAttackSetStackAsValueIfNotHasStack_<Kw><N>: give buffData; own <Kw> < N → stack = value.
  {
    name: /^GiveBuffOnSucceedAttackSetStackAsValueIfNotHasStack_([A-Za-z]+?)(\d+)$/,
    summary: "命中时施加指定状态；自身指定状态低于N层时层数改为value",
    onCoinHit(c) {
      const m = /_([A-Za-z]+?)(\d+)$/.exec(c.script.scriptName);
      if (!m) return;
      const below = c.actor.getPotency(m[1] ?? "") < Number(m[2]);
      giveFromData(c, below ? c.script.buffData?.value : undefined);
    },
  },
  // SkillAbility_TenthRodionCoinAdderSkillAbility<a>And<b>And<per>And<max>.CalculateCoinAdder:
  //   floor(Sack / a) × per + floor(target Burst stack / b) × per, capped at max.
  {
    name: /^TenthRodionCoinAdderSkillAbility(\d+)And(\d+)And(\d+)And(\d+)$/,
    summary: "自身每a层[DevyatDimensionalSack]或目标每b级破裂强度，硬币威力+per(上限max)",
    // timing audit: GetCoinScaleAdder → CalculateCoinAdder on every query → per coin
    coinMods(c) {
      const m = /(\d+)And(\d+)And(\d+)And(\d+)$/.exec(c.script.scriptName);
      if (!m) return;
      const [a, b, per, max] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
      const v = Math.min(max, Math.floor(c.actor.getPotency(SACK) / a) * per + Math.floor(c.target.getPotency("Burst") / b) * per);
      if (v > 0) return { coinScale: v };
    },
  },
  // CoinAbility_TenthRodionSecondSkillThirdCoinAbility<a>And<b>: BeforeGiveAttackDamage computes floor(Sack/a)+floor(Burst/b) (≤ limit);
  //   OnSucceedAttack gives that many DefenseDown (once per turn).
  {
    name: /^TenthRodionSecondSkillThirdCoinAbility(\d+)And(\d+)$/,
    summary: "命中时自身每a层[DevyatDimensionalSack]或目标每b级破裂强度，施加1层防御等级降低(最多6层，每回合1次)",
    coinMods(c) {
      const m = /(\d+)And(\d+)$/.exec(c.script.scriptName);
      if (!m) return;
      const n = Math.floor(c.actor.getPotency(SACK) / Number(m[1])) + Math.floor(c.target.getPotency("Burst") / Number(m[2]));
      c.state.set("amount", Math.min(c.script.buffData?.limit ?? 6, n));
    },
    onCoinHit(c) {
      const n = c.state.get("amount") ?? 0;
      if (n > 0 && takeTurn(c, "defdown", 1)) giveFromData(c, n, 0);
    },
  },
  // SkillAbility_TenthRodionThirdSkillAbility<base>And<div>And<max>: condition → BlockOnlyGive(Burst turn) and the reroll coin
  //   (CoinAbility_TenthRodionThirdSkillRerollCoinAbility) may reroll GetRerollCntMax = base + min(floor(Sack/div), max) times.
  {
    name: /^TenthRodionThirdSkillAbility(\d+)And(\d+)And(\d+)$/,
    summary: "目标破裂强度≥15且层数≥3时，本技能不施加破裂层数，改为重复使用最后一枚硬币",
    skillMods(c) {
      const bd = c.script.buffData;
      // BlockOnlyGive: this skill's Burst turn (count) gains are dropped
      if (burstCond(c, bd?.stack, bd?.turn)) blockSkillGains(c, "Burst", { kinds: ["turn"] });
    },
  },
  {
    name: "TenthRodionThirdSkillRerollCoinAbility",
    summary: "满足条件时重复使用本硬币",
    rerolls(c) {
      const s = skillScript(c, /^TenthRodionThirdSkillAbility\d+And\d+And\d+$/);
      const m = /(\d+)And(\d+)And(\d+)$/.exec(s?.scriptName ?? "");
      if (!s || !m || !burstCond(c, s.buffData?.stack, s.buffData?.turn)) return 0;
      return Number(m[1]) + Math.min(Math.floor(c.actor.getPotency(SACK) / Number(m[2])), Number(m[3]));
    },
  },
  // CoinAbility_TenthRodionThirdSkillSecondCoinAbility<div>: give Burst turn bd.turn + min(limit, floor(Sack/div) × value), once per turn;
  //   blocked when the skill's TenthRodionThirdSkillAbility condition holds (BlockOnlyGive).
  {
    name: /^TenthRodionThirdSkillSecondCoinAbility(\d+)$/,
    summary: "命中时对目标施加3层破裂，自身每10层[DevyatDimensionalSack]额外+1层(最多+2，每回合1次)",
    onCoinHit(c) {
      if (skillGainBlocked(c, "Burst", "turn")) return;
      const bd = c.script.buffData;
      const div = Number(/(\d+)$/.exec(c.script.scriptName)?.[1] ?? 10);
      const extra = Math.min(bd?.limit ?? 2, Math.floor(c.actor.getPotency(SACK) / div) * (bd?.value ?? 1));
      if (takeTurn(c, "burst", 1)) giveFromData(c, 0, (bd?.turn ?? 0) + extra);
    },
  },
  {
    // SkillAbility_1091103_special_skill.OnBeforeTurn: self BloomingThornsRodionFirst stack ≥ 25 → ChangeSkill(1091105).
    name: "1091103_special_skill",
    summary: "[BloomingThornsRodionFirst]不低于25层时改为使用“堂吉诃德派硬血奥义 落幕”(1091105)",
    beforeUse(c) {
      if (c.actor.getPotency("BloomingThornsRodionFirst") >= (c.script.buffData?.stack ?? 25)) c.replaceSkill?.(1091105, "绽放荆棘≥25");
    },
  },
  {
    name: "GiveBuffOnBattleStart1091101_BloomingThornsRodionFirst1_Laceration5[10:20:10]",
    summary: "战斗开始消耗至多20层血宴，每10层使自身获得1层绽放荆棘；未消耗则自身流血强度+5",
    approx: "类未解析，按描述实现；给予队友的部分未模拟",
    skillMods: (c) => bloodDinnerBattleStart(20, 10, 0)(c),
  },
  {
    name: "GiveBuffOnBattleStart1091102_BloomingThornsRodionFirst1_Enhancement1_BloomingThornsRodionFirst2_Laceration5[10:30:10]",
    summary: "战斗开始获得1层强壮；消耗至多30层血宴，每10层使自身获得1层绽放荆棘；未消耗则自身流血强度+5",
    approx: "类未解析，按描述实现；给予队友的部分未模拟；强壮在技能使用时给予，是否计入本技能取决于引擎结算顺序",
    skillMods: (c) => bloodDinnerBattleStart(30, 10, 1)(c),
  },
  // SkillAbility_GiveBuffOnUseByAccumulatedBloodDinner1091103: give FestivalFever stack + floor(Accumulation / value), max limit.
  {
    name: "GiveBuffOnUseByAccumulatedBloodDinner1091103",
    summary: "使用时自身获得[FestivalFeverRodion]，每50层累计血宴额外+1(最多10层)",
    approx: "给予(最大共鸣数)名队友的部分未模拟",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const n = Math.min(bd.limit ?? 10, (bd.stack ?? 0) + Math.floor(c.actor.getPotency("BloodDinner_Accumulation") / (bd.value || 50)));
      if (n > 0) c.give("actor", bd.buffKeyword, n, 0, bd.activeRound === 1 ? 1 : 0);
    },
  },
);

registerAbilities(
  // DefSkillPowerResultAdderAsStack (status Disarming) is already registered in batch-s08.
  {
    name: "BloomingThornsRodionBase",
    summary: "绽放荆棘阶段转换；基础技能硬币效果增加的流血/破裂强度额外+(阶段−1)",
    approx: "阶段转换与流血/破裂强度加成未建模",
  },
  noDamageAbility("BloomingThornsRodionGiveBuff", "受到攻击时使攻击者流血强度+1"),
  {
    name: "BloomingThornsRodionDefenseUp_2_1",
    summary: "每2层使防御等级+1(最多5级)",
    approx: "目标持有时的防御等级提升未建模",
  },
);
