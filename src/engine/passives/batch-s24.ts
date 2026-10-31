/** Script/status batch 24 — see data/il2cpp/dossiers/scripts-24.md */
import { replaceIfBuff } from "./skill-replace";
import {
  noDamageScript,
  registerAbilities,
  registerScripts,
  type AbilityCtx,
  type PassiveCtx,
  type ScriptData,
} from "./framework";

type BD = NonNullable<ScriptData["buffData"]>;

/** 10416 (黑派) receives Charge as ChargeNoirAlly (subIdList contains Charge). */
const kwFor = (c: PassiveCtx, kw: string) =>
  kw === "Charge" && (c.actor.get("ChargeNoirAlly") || c.identityId === 10416) ? "ChargeNoirAlly" : kw;
const sideOf = (c: PassiveCtx, who?: string) => (who === "Target" ? c.target : c.actor);
const giveBD = (c: PassiveCtx, bd: BD | undefined, stack = bd?.stack ?? 0, turn = bd?.turn ?? 0, active = bd?.activeRound) => {
  if (!bd?.buffKeyword || (stack <= 0 && turn <= 0)) return;
  // "Self" / "EveryAlly" (includes self) land on the actor; otherwise the target.
  const side = bd.target === "Self" || bd.target === "EveryAlly" ? "actor" : "target";
  c.give(side, side === "actor" ? kwFor(c, bd.buffKeyword) : bd.buffKeyword, stack, turn, active ? 1 : 0);
};
const nameInts = (n: string) => (n.match(/\d+/g) ?? []).map(Number);
const STIGMA = "StigmaWorkshopHandStep1"; // 1852

/**
 * Static skill-id sets derived from public/data/core.json (AbilityCtx carries no skill scripts):
 * CHARGE_SKILLS — skills whose skill/coin scripts give or use a CHARGE-category status (or script name mentions Charge,
 *   KeywordForUI excluded) ≈ BuffAbility_ChargedSting.CheckSkillCondition.
 * COMBUSTION_SKILLS — default (S1–S3/DEF) skills giving a COMBUSTION-category status (Combustion/DarkFlame) to a
 *   non-self target ≈ CheckSkillGivingBuffCategory(COMBUSTION) used by DawnLight abilities.
 */
const idSet = (s: string) => new Set(s.trim().split(/\s+/).map(Number));
const CHARGE_SKILLS = idSet(
  "1010601 1010602 1010604 1011601 1011602 1011603 1011604 1011605 1020201 1020202 1020203 1021001 1021002 " +
  "1021003 1021004 1021501 1021502 1021503 1021505 1021506 1021507 1021509 1030201 1030202 1031201 1031202 " +
  "1031203 1031204 1031205 1031206 1031207 1031501 1031502 1031503 1031504 1031505 1031506 1040501 1040502 " +
  "1040503 1040504 1041001 1041002 1041003 1041004 1041005 1041601 1041602 1041603 1041604 1041605 1041606 " +
  "1050301 1050302 1050303 1050304 1050503 1050601 1050602 1050603 1060601 1060602 1060603 1061201 1061202 " +
  "1061203 1061204 1061401 1061402 1061403 1061405 1061406 1061407 1061408 1061701 1061702 1061703 1061704 " +
  "1061705 1061706 1070301 1070304 1070901 1070902 1070903 1070904 1071301 1071302 1071303 1071304 1071701 " +
  "1071702 1071703 1071704 1071705 1080201 1080202 1080204 1081601 1081602 1081603 1081604 1081605 1090501 " +
  "1090503 1090504 1091301 1091302 1091303 1091304 1091305 1091306 1091307 1091308 1091401 1091402 1091403 " +
  "1091404 1091701 1091702 1091703 1091704 1091705 1091706 1101601 1101602 1101603 1101604 1101605 1101606 " +
  "1101607 1101608 1101609 1101610 1101611 1101613 1111001 1111002 1111003 1111004 1120501 1120502 1121501 " +
  "1121502 1121503 1121504 1121505 2020411 2020421 2021111 2021121 2030311 2030321 2030611 2030621 2030911 " +
  "2030921 2040611 2040621 2050611 2050621 2051011 2051021 2060311 2061011 2061021 2070211 2070221 2070311 " +
  "2070321 2070911 2070921 2080511 2110711 2110721 2120411 2120421 2121011 2121021",
);
const COMBUSTION_SKILLS = idSet(
  "1011201 1011202 1011203 1011204 1011505 1021101 1021102 1021103 1021104 1021105 1021601 1021602 1021603 " +
  "1021604 1021605 1021606 1021607 1031101 1031102 1031103 1040701 1040702 1040703 1041501 1041502 1041503 " +
  "1041506 1041507 1041508 1050201 1050202 1050203 1051201 1051202 1051203 1051205 1051401 1051402 1051403 " +
  "1051404 1060401 1060402 1060403 1061406 1061601 1061602 1061603 1071401 1071402 1071403 1071404 1071405 " +
  "1071501 1071502 1071503 1071504 1071505 1071506 1071507 1071601 1071602 1071603 1071604 1071606 1080601 " +
  "1080602 1080603 1080604 1080802 1080803 1081401 1081402 1081403 1081405 1090801 1090802 1090803 1090804 " +
  "1091601 1091602 1091603 1091604 1091605 1091606 1091607 1100501 1100502 1100503 1100901 1100902 1100903 " +
  "1100904 1100905 1101301 1101302 1101303 1101401 1101402 1101403 1101404 1110701 1110702 1110703 1111501 " +
  "1111502 1111503 1111505 1111506 1111507 1111508 1111509 1111510 1111511 1120201 1120202 1120203 1121101 " +
  "1121102 1121103 1121104 1121401 1121402 1121403 1121601 1121602 1121603 1121604 1121605 1121606 1121607",
);
/** Base skills that give ChargedSting (BuffAbility_ChargedSting.CheckExceptCondition). */
const CHARGED_STING_GIVERS = new Set([1121503]);
/** UNIT_KEYWORD.DAWN identities (core.json identities[].associations). */
const DAWN_IDS = new Set([10216, 11009, 11216]);
const isDefaultOrDef = (c: PassiveCtx) => ["S1", "S2", "S3", "DEF"].includes(c.skill?.slot ?? "");
const useTag = (c: PassiveCtx) => c.turn * 1e8 + (c.skill?.id ?? 0);

registerScripts(
  {
    // SkillAbility_GiveBuffOnUseIfTurnLess_<kw><N>.OnStartTurn_BeforeLog: 自身 kw 层数 < N → GiveBuff(buffData)
    name: "GiveBuffOnUseIfTurnLess_Charge10",
    summary: "使用时若自身充能层数低于10层，则获得buffData充能",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd) return;
      if (c.actor.getCount(kwFor(c, "Charge")) >= 10) return;
      giveBD(c, bd);
    },
  },
  {
    // CoinAbility_GiveChargedStingOnSA11215.OnSucceedAttack: p = 自身 Charge 强度；
    //   p ≥ IntegerValue(bd.value=5) 且本回合未触发 → 本回合与下回合各施加 IntegerValue 层 [ChargedSting](1635)；
    //   否则 → 下回合施加 min(p, limit) 层。
    name: "GiveChargedStingOnSA11215",
    summary: "命中时按自身充能强度下回合施加[ChargedSting]；充能≥5级时改为本回合与下回合各施加5层(每回合1次)",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!bd) return;
      const p = c.actor.getPotency(kwFor(c, bd.buffKeyword ?? "Charge"));
      if (p <= 0) return;
      const iv = Math.round(bd.value ?? 5);
      const key = `GiveChargedStingOnSA11215:${c.turn}`;
      if (p >= iv && !c.state.get(key)) {
        c.state.set(key, 1);
        c.give("target", "ChargedSting", iv, 0, 0);
        c.give("target", "ChargedSting", iv, 0, 1);
        return;
      }
      const n = (bd.limit ?? 0) > 0 ? Math.min(p, bd.limit!) : p;
      c.give("target", "ChargedSting", n, 0, 1);
    },
  },
  {
    // SkillAbility_SkillPowerAdder1121502: 自身 Charge 层数 ≥ bd.turn(10) → UseBuffTurn(Round(value)=5)，
    //   基础威力 + Round(bd.value)。
    name: "SkillPowerAdder1121502",
    summary: "使用时若充能层数≥10，消耗5层充能并使基础威力+1",
    skillMods(c) {
      const bd = c.script.buffData;
      const id = kwFor(c, bd?.buffKeyword ?? "Charge");
      if (c.actor.getCount(id) < (bd?.turn ?? 10)) return;
      c.consume("actor", id, Math.round(c.script.value ?? 5));
      return { basePower: Math.round(bd?.value ?? 1) };
    },
  },
  {
    // SkillAbility_SpecialSkill1121503.OnBeforeTurn: Charge 强度 ≥ bd.stack(3) → ChangeSkill(1121505)
    name: "SpecialSkill1121503",
    summary: "充能强度≥3级时改为使用“最高输出-超高压电流放电”(1121505)",
    beforeUse(c) {
      replaceIfBuff(c, 1121505, { reason: "充能强度≥3" });
    },
  },
  {
    // SkillAbility_11216ActiveCombationOnLastCoinIfStigmaHand_condition<C>_usedTurn<U>:
    //   OnStartTurn: 自身 StigmaWorkshopHandStep1(1852) ≥ C → 激活；最后一枚硬币命中 → ForceToActivate 目标烧伤，层数-U。
    name: /^11216ActiveCombationOnLastCoinIfStigmaHand_condition(\d+)_usedTurn(\d+)$/,
    summary: "烙印工坊之手≥20层时，最后一枚硬币命中触发目标烧伤并使其层数-1",
    skillMods(c) {
      const [, cond = 20] = nameInts(c.script.scriptName);
      c.state.set(`11216ActiveCombation:${c.turn}:${c.skill?.id}`, c.actor.getPotency(STIGMA) >= cond ? 1 : 0);
    },
    onCoinHit(c) {
      if (!c.state.get(`11216ActiveCombation:${c.turn}:${c.skill?.id}`)) return;
      if (c.coinIndex !== (c.skill?.coinCount ?? 0) - 1) return;
      const [, , used = 1] = nameInts(c.script.scriptName);
      const p = c.target.getPotency("Combustion");
      if (p <= 0 || c.target.getCount("Combustion") <= 0) return;
      c.extraDamage(p, "最后一枚硬币强制触发烧伤");
      c.consume("target", "Combustion", used);
    },
  },
  {
    // SkillAbility_11216AddCoinAndExplosionIfStigmaHand.OnStartTurn_BeforeLog: Stigma(1852) ≥ C → CopyCoinModelAndAddToListByIndex(coin-1);
    //   OnAddCoinByAbility: AddSuperCoinScriptToCoin + CoinAbility_VibrationExplosionOnSucceedAttackAndLoseTargetVibrationTurn<loseTurn>.
    name: /^11216AddCoinAndExplosionIfStigmaHand_condition(\d+)_coin(\d+)_loseTurn(\d+)$/,
    summary: "烙印工坊之手≥20层时额外使用第3枚硬币1次(超级硬币)，命中时震颤引爆并使震颤层数-1",
    onSkillStart(c) {
      const [, cond = 0, coin = 0, lose = 0] = nameInts(c.script.scriptName);
      if (c.actor.getPotency(STIGMA) < cond) return;
      c.coins?.add({ copyOf: coin - 1, super: true, scripts: [{ scriptName: `VibrationExplosionOnSucceedAttackAndLoseTargetVibrationTurn${lose}` }] });
    },
  },
  {
    // SkillAbility_11216AddCoinIfStigmaHand.OnStartTurn_BeforeLog: Stigma(1852) ≥ C → CopyCoinModelAndAddToListByIndex(coin-1); added coin → SuperCoin.
    name: /^11216AddCoinIfStigmaHand_condition(\d+)_coin(\d+)$/,
    summary: "烙印工坊之手≥20层时额外使用第2枚硬币1次(超级硬币)",
    onSkillStart(c) {
      const [, cond = 0, coin = 0] = nameInts(c.script.scriptName);
      if (c.actor.getPotency(STIGMA) >= cond) c.coins?.add({ copyOf: coin - 1, super: true });
    },
  },
  {
    // SkillAbility_11216DmgMultiplierByBothTotalCombustion_limit<L>.CalculateDmgMultiplier:
    //   (自身烧伤强度 + 目标烧伤强度) × 0.01，limit>0 时上限 L×0.01。实时计算（每枚硬币）。
    name: /^11216DmgMultiplierByBothTotalCombustion_limit(\d+)$/,
    summary: "伤害+(自身与目标烧伤强度之和)%(最多+30%)",
    coinMods(c) {
      const [, limit = 0] = nameInts(c.script.scriptName);
      const sum = c.actor.getPotency("Combustion") + c.target.getPotency("Combustion");
      if (sum <= 0) return;
      const dmg = sum * 0.01;
      return { dmg: limit > 0 ? Math.min(dmg, limit * 0.01) : dmg };
    },
  },
  noDamageScript("11216GiveProtectionOnBattleStart_stack2", "战斗开始时随机使2名其他友方获得守护"),
  {
    // SkillAbility_GiveBuffConditionalOnEndAttack: 攻击结束施加 buffData；conditionalData 满足时以 resultBuffData 替代
    //   (SetAlternativeResult)。EveryAlly 包含自身。
    name: "GiveBuffConditionalOnEndAttack",
    summary: "攻击结束时下回合全体友方(含自身)获得晨光；满足条件时改为resultBuffData",
    approx: "仅对自身施加（其他友方不在模拟内）",
    onSkillEnd(c) {
      const cd = c.script.conditionalData as
        | { category?: string; type?: string; conditionBuffData?: BD; resultBuffData?: BD }
        | undefined;
      let bd = c.script.buffData;
      const cond = cd?.conditionBuffData;
      if (cd && cond?.buffKeyword) {
        const o = sideOf(c, cond.buffOwner ?? "Self");
        const id = o === c.actor ? kwFor(c, cond.buffKeyword) : cond.buffKeyword;
        const byTurn = /Turn/i.test(cd.category ?? "");
        const v = byTurn ? o.getCount(id) : o.getPotency(id);
        const th = (byTurn ? cond.turn : cond.stack) ?? 0;
        const t = cd.type ?? "";
        const ok =
          t === "Less" ? v < th : t === "LessOrEqual" ? v <= th : t === "Greater" ? v > th : t === "Equal" ? v === th : v >= th;
        if (ok && cd.resultBuffData) bd = cd.resultBuffData;
      }
      giveBD(c, bd);
    },
  },
  {
    // SkillAbility_SkillChangeSpecialTo<id>.OnBeforeTurn: 自身 kw 层数 ≥ bd.stack 且带有 kw → ChangeSkill(id)
    name: "SkillChangeSpecialTo1121605",
    summary: "烙印工坊之手为30层时改为使用“黎明将至”(1121605)",
    beforeUse(c) {
      replaceIfBuff(c, 1121605, { reason: "烙印工坊之手≥30" });
    },
  },
  {
    // SkillAbility_SkillPowerResultAdderByCombustionVibrationStackDiv(OnStartTurn).CalculateAdder:
    //   (目标烧伤强度 + 震颤强度) / bd.stack × IntegerValue，limit>0 时上限 limit；OnStartTurn 快照。
    name: "SkillPowerResultAdderByCombustionVibrationStackDivOnStartTurn",
    summary: "目标烧伤与震颤强度之和每满stack级，最终威力+value(上限limit)",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.stack) return;
      const o = sideOf(c, bd.buffOwner);
      const sum = o.getPotency("Combustion") + o.getPotency("Vibration");
      let v = Math.trunc(sum / bd.stack) * Math.round(bd.value ?? 1);
      if ((bd.limit ?? 0) > 0) v = Math.min(v, bd.limit!);
      if (v > 0) return { finalPower: v };
    },
  },
);

registerAbilities(
  {
    // BuffAbility_ChargedSting.GetTakeAttackDmgMultiplier: attacking skill gives/uses CHARGE-category status →
    //   stack × 0.04 (max 0.2); envy (attribute 6 = VIOLET) skill → stack × 0.08 (max 0.4).
    // OnTakeAttackDamage/OnEndEnemyAttack/OnRoundEnd: hit by such a skill (except a base skill that gives ChargedSting)
    //   → lose 1 stack after that attack or at round end.
    name: "ChargedSting",
    summary: "受到获得/消耗充能的技能伤害+4%/层(最多20%)，嫉妒技能+8%/层(最多40%)；被命中后攻击结束或回合结束时-1层",
    approx: "技能是否涉及充能按静态技能表判断；“攻击后”减层推迟到下一次技能/回合结束结算",
    coinMods(c: AbilityCtx) {
      if (c.side !== "target") return;
      const pending = c.state.get("pending");
      if (pending && pending !== useTag(c)) {
        c.state.delete("pending");
        c.lose("target", "ChargedSting", 1);
      }
      const p = c.target.getPotency("ChargedSting");
      if (p <= 0 || !CHARGE_SKILLS.has(c.skill?.id ?? 0)) return;
      const envy = c.skill?.sin === "VIOLET";
      return { dmg: envy ? Math.min(p * 0.08, 0.4) : Math.min(p * 0.04, 0.2) };
    },
    onCoinHit(c: AbilityCtx) {
      if (c.side !== "target" || !CHARGE_SKILLS.has(c.skill?.id ?? 0)) return;
      if (isDefaultOrDef(c) && CHARGED_STING_GIVERS.has(c.skill?.id ?? 0)) return;
      c.state.set("pending", useTag(c));
    },
    onRoundEnd(c: AbilityCtx) {
      if (c.side !== "target" || !c.state.get("pending")) return;
      c.state.delete("pending");
      if (c.status.potency > 0) c.lose("target", "ChargedSting", 1);
    },
  },
  {
    // BuffAbility_DawnLightAttackDamageMultiplier_attribute<A>_combustion<B> (base DefaultSkillAtkDamageMultiplier):
    //   default skill (incl. defense) giving a COMBUSTION-category status → +B%；skill attribute = ability attribute
    //   (CRIMSON) → +A%。
    name: /^DawnLightAttackDamageMultiplier_attribute(\d+)_combustion(\d+)$/,
    summary: "施加烧伤的基础技能伤害+10%（暴怒技能+15%）",
    approx: "技能是否施加烧伤按静态技能表判断",
    coinMods(c: AbilityCtx) {
      if (c.side !== "actor" || c.status.potency <= 0 && c.status.count <= 0) return;
      if (!isDefaultOrDef(c) || !COMBUSTION_SKILLS.has(c.skill?.id ?? 0)) return;
      const [attr = 15, base = 10] = nameInts(c.ability.ability);
      const attribute = (c.ability as { attribute?: string }).attribute ?? "CRIMSON";
      return { dmg: (c.skill?.sin === attribute ? attr : base) * 0.01 };
    },
  },
  {
    // BuffAbility_DawnLightSkillPowerParryingAdder: same skill condition → clash power +value；
    //   DAWN association → base power +value instead.
    name: "DawnLightSkillPowerParryingAdder",
    summary: "施加烧伤的基础技能拼点威力+1（黎明事务所人格改为基础威力+1）",
    approx: "技能是否施加烧伤按静态技能表判断；拼点威力不影响单方面攻击",
    coinMods(c: AbilityCtx) {
      if (c.side !== "actor" || !DAWN_IDS.has(c.identityId)) return;
      if (!isDefaultOrDef(c) || !COMBUSTION_SKILLS.has(c.skill?.id ?? 0)) return;
      return { basePower: c.ability.value ?? 1 };
    },
  },
  {
    // BuffAbility_PhotoElectricity.OnTakeAttackDamage (once per skill): attacker gains Charge count =
    //   stack (buffData.turn -1 → × own stack)；attacker Charge count ≤ limit(5) → + IntegerValue(3) more.
    name: "PhotoElectricity",
    summary: "受到攻击时使攻击者获得等同层数的充能（攻击者充能≤5层时额外+3层，每技能1次）",
    onCoinHit(c: AbilityCtx) {
      if (c.side !== "target") return;
      const tag = useTag(c);
      if (c.state.get("used") === tag) return;
      const n = Math.max(c.status.potency, 0);
      if (n <= 0) return;
      c.state.set("used", tag);
      const bd = c.ability.buffData;
      const id = kwFor(c, bd?.buffKeyword ?? "Charge");
      const extra = c.actor.getCount(id) <= (bd?.limit ?? 5) ? Math.round(bd?.value ?? 3) : 0;
      c.give("actor", id, 0, n + extra, 0);
    },
  },
);
