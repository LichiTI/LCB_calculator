/** Residual-gap sweep (batch s25): statuses / scripts left uncovered after batches 01–24 (see data/reports/damage-gaps.json). */
import type { StatusContainer } from "../status";
import { giveAdder, noDamageAbility, registerAbilities, registerScripts, type AbilityCtx, type PassiveCtx } from "./framework";

// UNIT_KEYWORD membership (core.json identities[].associations)
const W_CORP = new Set([10106, 10202, 10302, 10405, 10503, 10606, 10713, 11110]);
const RING_FINGER = new Set([10109, 10215, 10515, 10614, 10915, 11109]);
const RING_FINGER_FAUVISM = new Set([10515, 10915]);
/** BUFF_CATEGORY_KEYWORD.LACERATION members (core.json buffs[].categoryKeywordList). */
const LACERATION_CATEGORY = ["BoneNailSinclair", "DrunkBlood", "Laceration", "NailPersonality", "NiddleEGO", "NiddlePin", "NiddlePinAlly", "RedApricotBlossom"];

/** Sinner number of an identity id (1SSII → SS). */
const sinnerOf = (identityId: number): number => Math.floor(identityId / 100) % 100;
const isDefaultSkill = (c: PassiveCtx): boolean => c.skill?.slot === "S1" || c.skill?.slot === "S2" || c.skill?.slot === "S3";
const ownerOf = (c: AbilityCtx): StatusContainer => (c.side === "actor" ? c.actor : c.target);
const speedDiff = (c: PassiveCtx): number => c.battle.selfSpeed - c.battle.targetSpeed;

registerScripts(
  // CoinAbility_GiveAdditionalSlashDmgOnSuccessAttackAllTargetByRatio: trunc(finalDmg × value) Slash dmg to every alive target.
  {
    name: "GiveAdditionalSlashDmgOnSuccessAttackAllTargetByRatio",
    summary: "命中时对全体攻击目标造成本硬币最终伤害量×value的斩击伤害",
    approx: "副目标视为与主要目标相同（开启“统计副目标伤害”时计入副目标）",
    onCoinHit(c) {
      const d = Math.trunc((c.lastHitDamage ?? 0) * (c.script.value ?? 0));
      if (d > 0) c.extraDamage(d, "全体追加斩击伤害", { atkType: "SLASH", allTargets: true });
    },
  },
  // SkillAbility_UseBuffOnUse1011605_{need}_{final}_{coin}: own Charge count ≥ need → UseBuffTurn(Charge, need); final power +final, coin power +coin.
  {
    name: /^UseBuffOnUse1011605_(\d+)_(\d+)_(\d+)$/,
    summary: "使用时充能层数足够则消耗15层充能，最终威力+1、硬币威力+2",
    skillMods(c) {
      const [, need, fp, cs] = /_(\d+)_(\d+)_(\d+)$/.exec(c.script.scriptName)!.map(Number);
      if (c.actor.getCount("Charge") < need!) return;
      c.consume("actor", "Charge", need!);
      return { finalPower: fp!, coinScale: cs! };
    },
  },
);

/** BuffAbility_TibiaFasciaStepBase.CheckCondition: own ChargeBodyArt ≥ bd.stack, default attack (or counter) skill. */
function tibiaStep(c: AbilityCtx): boolean {
  if (c.side !== "actor" || !isDefaultSkill(c)) return false;
  const bd = c.ability.buffData;
  return !!bd?.buffKeyword && c.actor.getPotency(bd.buffKeyword) >= (bd.stack ?? 1);
}

/** Round end of a shield status: gain Charge count = stacks × _BUFF_TURN_PER_STACK (1), then remove the status. */
function shieldToCharge(c: AbilityCtx): void {
  const n = c.status.potency;
  if (n > 0) c.give(c.side, "Charge", 0, n);
  ownerOf(c).destroy(c.status.id);
}

registerAbilities(
  // ---------------------------------------------------------------- SinkingWhite (蝶)
  // BuffAbility_SinkingWhiteBase.OnRoundEnd: dead (turn) → 0; gain Sinking potency = live (stack); live → dead.
  {
    name: "SinkingWhiteBase",
    summary: "回合结束：亡蝶归零，增加等同生蝶的沉沦强度，生蝶转为亡蝶；技能施加蝶时的加成量转为沉沦",
    approx: "加成转换仅在持有蝶期间生效（首次获得时未注册）",
    // CanIgnoreGiveAdder(SinkingWhite) + RightAfterTakeBuffBySkill: (afterAdder − base) stack/turn of SinkingWhite given by a skill
    // are given as Sinking instead. Runs after all adders (order 10).
    coinMods(c) {
      const holder = ownerOf(c);
      const id = c.status.id;
      c.interceptStatus?.(
        { whileStatus: id },
        (ch) => {
          const base = ch.baseDelta ?? ch.delta;
          if (ch.buffId !== id || ch.delta <= base || (ch.source !== undefined && !/^\d+:/.test(ch.source))) return undefined;
          const extra = ch.delta - base;
          holder.apply("Sinking", ch.kind === "stack" ? extra : 0, ch.kind === "turn" ? extra : 0, ch.activeRound, "SinkingWhiteBase");
          return base;
        },
        { side: c.side, key: `sinkingWhite:${id}`, order: 10 },
      );
    },
    onRoundEnd(c) {
      const o = ownerOf(c);
      const live = o.getPotency(c.status.id);
      const dead = o.getCount(c.status.id);
      if (live > 0) c.give(c.side, "Sinking", live, 0);
      if (live > 0) c.lose(c.side, c.status.id, live);
      if (dead > 0) c.consume(c.side, c.status.id, dead);
      if (live > 0) c.give(c.side, c.status.id, 0, live);
    },
  },
  // BuffAbility_SinkingWhiteAllInOne.OnTakeAttackDamage: owner SP < 0 → Azure (attribute) HP damage from its Sinking:
  // min(limit, trunc(Sinking / bd.stack × value)) (Divide/Multiply/Divide + min(limit) in ISIL). Attacker SP heal not modelled.
  {
    name: "SinkingWhiteAllInOne",
    summary: "受攻击时若自身理智<0，受到由沉沦强度换算的忧郁伤害；使攻击者恢复理智",
    approx: "仅在情境给出目标理智时生效（理智视为恒定）；伤害式按 min(上限, 沉沦强度/stack×value) 解读；攻击者恢复理智不影响输出",
    onCoinHit(c) {
      if (c.side !== "target" || c.targetSp === undefined || c.targetSp >= 0) return;
      const bd = c.ability.buffData;
      const kw = bd?.buffKeyword ?? "Sinking";
      const raw = Math.trunc((c.target.getPotency(kw) / Math.max(1, bd?.stack ?? 5)) * (c.ability.value ?? 4));
      const dmg = Math.min(bd?.limit ?? 30, raw);
      if (dmg > 0) c.extraDamage(dmg, "蝶：理智<0忧郁伤害", { sin: "AZURE" });
    },
  },
  // ---------------------------------------------------------------- ConcussionYisang
  // BuffAbility_TakeSinBuffDamageMultiplier(Burst, 0.2): Burst damage taken ×1.2 (floor) → extra floor(potency × 0.2) per trigger.
  {
    name: "TakeSinBuffDamageMultiplier",
    summary: "受到的指定状态(破裂)伤害×(1+value)",
    approx: "按命中前破裂层数>0判定本次命中触发了破裂",
    coinMods(c) {
      if (c.side !== "target") return;
      const kw = c.ability.buffData?.buffKeyword ?? "Burst";
      c.state.set(`pre:${c.turn}:${c.skill?.id}:${c.coinIndex}`, c.target.getCount(kw) > 0 ? c.target.getPotency(kw) : 0);
    },
    onCoinHit(c) {
      if (c.side !== "target") return;
      const p = c.state.get(`pre:${c.turn}:${c.skill?.id}:${c.coinIndex}`) ?? 0;
      const extra = Math.floor(p * (c.ability.value ?? 0));
      if (extra > 0) c.extraDamage(extra, "脑震荡：破裂伤害加成");
    },
  },
  noDamageAbility("TakeVEDmgMultiplier", "震颤引爆的混乱阈值前移量×1.2"),
  noDamageAbility("ConcussionYisangEffect", "特效"),
  // ---------------------------------------------------------------- Tibia / Fascia (ChargeBodyArt steps)
  {
    name: "TibiaFasciaSkillPowerAdder",
    summary: "活体材料强度达到阶段时，基础攻击技能基础威力+value",
    coinMods(c) {
      if (tibiaStep(c)) return { basePower: Math.round(c.ability.value ?? 1) };
    },
  },
  {
    name: "TibiaFasciaAtkMultiplierIfHasLacerationCategory",
    summary: "活体材料强度≥2且目标带有流血类状态时，基础攻击技能伤害+10%",
    coinMods(c) {
      if (!tibiaStep(c) || !LACERATION_CATEGORY.some((k) => c.target.getPotency(k) > 0 || c.target.getCount(k) > 0)) return;
      return { dmg: c.ability.value ?? 0.1 };
    },
  },
  {
    name: "TibiaFasciaLacerationAdder",
    summary: "活体材料强度≥3时，基础攻击技能施加的流血强度与层数额外+1",
    approx: "仅对本次施加已包含的维度(强度/层数>0)加值",
    // BuffAbility_TibiaFasciaLacerationAdder.GetGiveBuffStackAdder/TurnAdder: CheckCondition && buf == Laceration → +value.
    coinMods(c) {
      if (!tibiaStep(c)) return;
      giveAdder(c, "skill", { key: `tibiaLac:${c.status.id}`, buffId: "Laceration", amount: Math.round(c.ability.value ?? 1), ownSkillOnly: true });
    },
  },
  // ---------------------------------------------------------------- misc damage multipliers
  // BuffAbility_SilverOpportunity.CalcAttackDmgMultiplier: default skill vs slower target → +value.
  {
    name: "SilverOpportunity",
    summary: "基础攻击技能对速度低于自身的目标伤害+10%",
    coinMods(c) {
      if (c.side === "actor" && isDefaultSkill(c) && speedDiff(c) > 0) return { dmg: c.ability.value ?? 0.1 };
    },
  },
  // BuffAbility_TakeAtkDamageMultiplierCharacterId_{id}: attacks from that sinner deal +value.
  {
    name: /^TakeAtkDamageMultiplierCharacterId_(\d+)$/,
    summary: "受到指定罪人(角色ID)的攻击伤害+value",
    coinMods(c) {
      if (c.side !== "target") return;
      const id = Number(/_(\d+)$/.exec(c.ability.ability)![1]);
      if (sinnerOf(c.identityId) === id) return { dmg: c.ability.value ?? 0 };
    },
  },
  noDamageAbility("VillainMark", "仅施加给每回合首个目标"),
  // BuffAbility_ContemptRyoshuAbility: dmg to/from unit 10412 × (1 + value).
  {
    name: "ContemptRyoshuAbility",
    summary: "对良秀(#10412)造成的伤害与受到良秀的伤害-50%",
    approx: "回合结束转为视线、阵亡转移未建模",
    coinMods(c) {
      if (c.side === "target" && c.identityId === 10412) return { dmg: c.ability.value ?? -0.5 };
    },
  },
  // BuffAbility_VibrationBleeding: handled inside status.ts triggerVibrationExplosion (Lust dmg + Laceration count −1).
  noDamageAbility("VibrationBleeding", "震颤-大出血引爆伤害由 triggerVibrationExplosion 结算"),
  // BuffAbility_DefAdderByStackCeilToInt(−0.25): defense level += ceil(stack × value); modelled as attacker offense level.
  {
    name: "DefAdderByStackCeilToInt",
    summary: "每4级强度防御等级-1",
    approx: "以攻击方攻击等级等量提升表示目标防御等级降低",
    coinMods(c) {
      if (c.side !== "target") return;
      const def = Math.ceil(c.status.potency * (c.ability.value ?? 0));
      if (def < 0) return { offense: -def };
    },
  },
  // BuffAbility_FestivalFeverRodion_{lac}_{bd}: target has Laceration → stack × lac × value; BloodDinner skills → stack × bd × value.
  {
    name: /^FestivalFeverRodion_(\d+)_(\d+)$/,
    summary: "对带有流血的目标伤害+(层数×1.5)%；消耗或获得血宴的技能改为+(层数×3)%",
    approx: "“消耗或获得血宴”按本技能脚本名含 BloodDinner/Dinner 判定",
    coinMods(c) {
      if (c.side !== "actor" || c.target.getPotency("Laceration") <= 0) return;
      const [, lac, bdin] = /_(\d+)_(\d+)$/.exec(c.ability.ability)!.map(Number);
      // BuffAbility_FestivalFeverRodion.CalculateAttackDmgMul: IsUseBuff(BloodDinner) || SkillModel.IsAddBloodDinner → 30, else 15.
      const dinner = (c.skillScripts ?? []).some((n) => /Dinner/.test(n));
      return { dmg: c.status.potency * (dinner ? bdin! : lac!) * (c.ability.value ?? 0.001) };
    },
  },
  // BuffAbility_IntenseColorsRodionTakeDmgMul: from RING_FINGER attackers +stack × value (×2 RING_FINGER_FAUVISM).
  {
    name: "IntenseColorsRodionTakeDmgMul",
    summary: "受到环指单位的伤害+(层数×2.5)%(野兽派×2)",
    coinMods(c) {
      if (c.side !== "target" || !RING_FINGER.has(c.identityId)) return;
      const mul = RING_FINGER_FAUVISM.has(c.identityId) ? 2 : 1;
      return { dmg: c.status.potency * (c.ability.value ?? 0.025) * mul };
    },
  },
  // BuffAbility_IntenseColorsRodionOnBS: battle start, `stack` times randomly: +1 Laceration/Sinking potency or +1 count.
  {
    name: "IntenseColorsRodionOnBS",
    summary: "战斗开始时按层数次随机增加流血/沉沦强度或层数",
    approx: "随机改为轮流",
    onBattleStart(c) {
      const opts: [string, number, number][] = [["Laceration", 1, 0], ["Sinking", 1, 0], ["Laceration", 0, 1], ["Sinking", 0, 1]];
      for (let i = 0; i < c.status.potency; i++) {
        const r = c.state.get("rot") ?? 0;
        c.state.set("rot", r + 1);
        const [kw, p, n] = opts[r % 4]!;
        c.give(c.side, kw, p, n);
      }
    },
  },
  noDamageAbility("IntenseColorsRodionOnBE", "战斗结束时解除并使被撕裂的色彩减半"),
  // BuffAbility_ChargeLoad: attack that used Charge count → stack × value (W_CORP × bd.value), cap bd.limit × value (× bd.value).
  {
    name: "ChargeLoad",
    summary: "消耗充能层数的攻击技能伤害+(层数×2.5)%(最多15%；W公司×2)",
    coinMods(c) {
      // BattleActionModel.IsAttack && UsedBuffTurn(Charge) > 0
      if (c.side !== "actor" || c.skill?.slot === "DEF" || !((c.action?.consumedTurn("Charge") ?? 0) > 0)) return;
      const bd = c.ability.buffData;
      const mul = W_CORP.has(c.identityId) ? bd?.value ?? 2 : 1;
      const v = c.ability.value ?? 0.025;
      return { dmg: Math.min(c.status.potency, bd?.limit ?? 6) * v * mul };
    },
  },
  // BuffAbility_AtkDamageMultiplierIfFasterMinDiffPerSpeedDiffWithMax_{min}_{per}_{max%}: diff ≥ min → diff × value, cap max%.
  {
    name: /^AtkDamageMultiplierIfFasterMinDiffPerSpeedDiffWithMax_(\d+)_(\d+)_(\d+)$/,
    summary: "速度高于目标时伤害+(速度差×value)(有上限)",
    coinMods(c) {
      if (c.side !== "actor") return;
      const [, mn, , mx] = /_(\d+)_(\d+)_(\d+)$/.exec(c.ability.ability)!.map(Number);
      const d = speedDiff(c);
      if (d < mn!) return;
      return { dmg: Math.min(mx! * 0.01, d * (c.ability.value ?? 0)) };
    },
  },
  {
    name: "OutisNoHatBuffAdder",
    summary: "带迅捷时基础技能对自身施加的震颤层数+1",
    // BuffAbility_OutisNoHatBuffAdder.GetGiveBuffTurnAdder: owner has Agility, default skill (incl. defense), target == owner,
    // buf == bd.buffKeyword (Vibration), currentTurn > 0 → +bd.turn.
    coinMods(c) {
      if (c.side !== "actor" || !(isDefaultSkill(c) || c.skill?.slot === "DEF")) return;
      const bd = c.ability.buffData;
      giveAdder(c, "skill", {
        key: "outisNoHat",
        buffId: bd?.buffKeyword ?? "Vibration",
        kinds: ["turn"],
        side: "actor",
        amount: bd?.turn ?? 1,
        ownSkillOnly: true,
        when: () => c.actor.get("Agility") !== undefined,
      });
    },
  },
  // ---------------------------------------------------------------- Devyat sacks
  // BuffAbility_DevyatDimensionalSack(+Sinclair).OnRoundStart_After_Event: ≥20 → ParryingResultUp 1 + Slash(Hit)DamageUp 1.
  {
    name: /^DevyatDimensionalSack(Sinclair)?$/,
    summary: "派送箱≥20层：获得1层拼点威力提升与1层斩击(辛克莱为打击)伤害强化",
    approx: "伤害强化直接按+10%计入同类型攻击；≥30层的自伤与速度加成不影响输出",
    coinMods(c) {
      if (c.side !== "actor" || c.status.potency < 20) return;
      const atk = c.status.id === "DevyatDimensionalSackSinclair" ? "HIT" : "SLASH";
      if (c.skill?.atkType === atk) return { dmg: 0.1 };
    },
  },
  // ---------------------------------------------------------------- shields → Charge
  {
    name: "ChargeForceField",
    summary: "获得护盾；回合结束获得等量充能层数并解除",
    approx: "护盾值不影响输出，未建模",
    onRoundEnd: shieldToCharge,
  },
  {
    name: "HighVoltageExoshell",
    summary: "获得护盾；回合结束获得等量充能层数并解除",
    approx: "护盾值不影响输出，未建模",
    onRoundEnd: shieldToCharge,
  },
  // ---------------------------------------------------------------- no-damage lifecycle abilities
  {
    // BuffAbility_NoirNailSlothDamageDonQuixote.OnVibrationExplosion: skill-sourced Tremor Burst on the holder (once per action)
    //   → TakeHpDamageAppliedAttributeResist_SinBuff(trunc(stack × value), AMBER(_ATTRIBUTE 2)), capped by buffData.limit (10).
    name: "NoirNailSlothDamageDonQuixote",
    summary: "受到技能效果的震颤引爆时，每层造成1点怠惰伤害(最多10，每技能1次)",
    onVibrationExplosion(c, ev) {
      if (c.side !== ev.side || !c.skill) return;
      const key = `NoirNailSloth:${c.side}`;
      if (c.action?.shared.get(key)) return;
      const stack = c.status.potency;
      if (stack <= 0) return;
      let dmg = Math.trunc(stack * (c.ability.value ?? 1));
      const limit = c.ability.buffData?.limit ?? 0;
      if (limit > 0) dmg = Math.min(dmg, limit);
      if (dmg <= 0) return;
      c.action?.shared.set(key, 1);
      c.extraDamage(dmg, `漆黑之钉${stack}层：震颤引爆怠惰伤害 ${dmg}`, { sin: "AMBER" });
    },
  },
  noDamageAbility("DestroyOnRoundStartIfUnitAbsent", "施加者不在场时回合开始解除"),
  noDamageAbility("NoirNailVibrationEffectDonQuixote", "特效"),
  noDamageAbility("RecoverSelfMpOnRoundStart", "回合开始恢复理智"),
  // BuffAbility_ChangeToSuperCoinIfDefaultAttackSkill: holder uses a default (S1–S3) skill → every coin → SuperCoin (clash-only).
  {
    name: "ChangeToSuperCoinIfDefaultAttackSkill",
    summary: "基础攻击技能硬币转化为不可摧毁硬币（仅影响拼点）",
    onSkillStart(c) {
      if (c.side === "actor" && isDefaultSkill(c)) c.coins?.makeSuper("all");
    },
  },
  noDamageAbility("10416BuffChangerImmediately", "层数为0时转化为黑派华达呢大衣"),
  noDamageAbility("KnowledgeTraining", "丢弃技能时获得护盾/拼点威力提升"),
  noDamageAbility("DestroyOtherBuffIfHasSameBuffTiedRopeHonglu", "被其他单位施加时替换"),
  noDamageAbility("DestroyEachOtherBuffTiedRopeHonglu", "施加者对不同目标施加时解除"),
  noDamageAbility("LoseBuffStackOnRoundEndIfNotAttackedToTiedWithRopeID", "本回合未受施加者攻击时回合结束层数-1"),
);
