/** Passive batch 05 — see data/il2cpp/dossiers/passives-05.md */
import { noDamagePassive, registerPassives, type PassiveCtx } from "./framework";
import { usedPerThreshold } from "./used-tracker";

// UNIT_KEYWORD membership (public/data/core.json identities[].associations / unitKeywords)
const N_CORP_FNATIC = [10204, 10304, 10504, 10704, 10904, 11005];
const BLACK_CLOUD = [10403, 10602, 10712, 10811, 10902, 11208];

/** Number of units of an association on our side, self included (only declared allies count). */
function assocCount(c: PassiveCtx, ids: number[]): number {
  return 1 + ids.filter((id) => id !== c.identityId && c.allyPresent(String(id))).length;
}

function isBasicSkill(c: PassiveCtx): boolean {
  const s = c.skill?.slot;
  return s === "S1" || s === "S2" || s === "S3";
}

/**
 * "every 10 Charge count used this battle → +1 Charge potency" (CheckAbility: GetUsedBuffTurn(Charge)/10 − already given).
 * Exact spend from the per-action record (usedPerThreshold); checked at every hook of a skill use.
 */
function chargeTrack(c: PassiveCtx): void {
  const due = usedPerThreshold(c, "chg", ["Charge"]);
  if (due <= 0) return;
  c.give("actor", "Charge", due, 0, 0);
  c.note(`累计消耗充能 ${c.state.get("chg:used")} 层 → 充能强度 +${due}`);
}

const chargeHooks = {
  skillMods: (c: PassiveCtx) => void chargeTrack(c),
  coinMods: (c: PassiveCtx) => void chargeTrack(c),
  onCoinHit: (c: PassiveCtx) => chargeTrack(c),
  onSkillEnd: (c: PassiveCtx) => chargeTrack(c),
};

/**
 * GetGiveBuffStackAdder emulation: snapshot potencies before a coin (coinMods) and, after the hit's own coin effects
 * (onCoinHit), add `adder` potency to every listed status whose potency rose.
 */
function snapshot(c: PassiveCtx, side: "actor" | "target", keys: string[]): void {
  const box = side === "actor" ? c.actor : c.target;
  for (const k of keys) c.state.set(`snap:${side}:${k}`, box.getPotency(k));
}
function risen(c: PassiveCtx, side: "actor" | "target", keys: string[]): string[] {
  const box = side === "actor" ? c.actor : c.target;
  return keys.filter((k) => box.getPotency(k) > (c.state.get(`snap:${side}:${k}`) ?? Infinity));
}
const NEG_SIN = ["Combustion", "Laceration", "Vibration", "Burst", "Sinking"];

registerPassives(
  // PassiveAbility_1070411: GetCoinScaleAdder = 1 when ≥4 N_CORP_FNATIC alive (CheckAdditionalAbilityCondition @OnBattleStart);
  // OnRoundStart_After_Event: after an ally died → lose 10 SP, HitResultUp 1.
  {
    id: 1070411,
    summary: "包括自身在内N公司狂信徒不低于4名时硬币威力+1",
    approx: "友方阵亡后获得打击威力提升（阵亡不在模拟中发生）未建模",
    coinMods(c) {
      if (assocCount(c, N_CORP_FNATIC) >= 4) return { coinScale: 1 };
    },
  },
  // PassiveAbility_1070501: battle start consumes Sinking/loses SP; Protection before hit; HitDamageUp next turn when hit (max 3/turn).
  {
    id: 1070501,
    summary: "开战消耗沉沦并失去理智；受击前获得守护",
    approx: "受到攻击时下回合获得打击伤害强化（每回合最多3层）未建模：模拟中目标不攻击",
  },
  // PassiveAbility_1070611 / 1070601.GetGiveBuffStackAdder: Burst +1 (+1 more with ≥4 SEVEN) when target resist level for the skill is fatal.
  {
    id: 1070611,
    summary: "以“致命”抗性技能攻击时，技能施加的破裂强度额外+1（Seven协会≥4名再+1）",
    approx: "仅对技能期间目标破裂强度的增加生效（拦截状态变化模拟 GetGiveBuffStackAdder）；Seven人数仅计自身与已声明的队友",
    // _TARGET_RESIST_VALUE_LIST = {WEAK(致命)} on the skill's sin OR atk type; buf == Burst; action.IsAttack.
    skillMods(c) {
      const s = c.skill;
      const lv = [
        s?.sin && s.sin !== "NEUTRAL" ? c.targetResistLevel?.({ sin: s.sin as import("../../config/game-data").SinAttribute }) : undefined,
        s?.atkType ? c.targetResistLevel?.({ atkType: s.atkType as import("../../config/game-data").AtkType }) : undefined,
      ];
      if (!lv.includes("WEAK")) return;
      const add = 1 + (assocCount(c, [10102, 10206, 10402, 10706, 11104]) >= 4 ? 1 : 0);
      c.interceptStatus?.(
        "skill",
        (ch) => (ch.buffId === "Burst" && ch.kind === "stack" && ch.delta > 0 ? ch.delta + add : undefined),
        { side: "target", key: "1070611:burstAdder" },
      );
    },
  },
  // PassiveAbility_1070701.CaculateDmgMultiplier: trunc(lost HP% ) × 0.01 (cap getter value not recoverable from ISIL; desc has none).
  {
    id: 1070711,
    summary: "自身每失去1%体力，造成的伤害+1%",
    approx: "上限常量未能从ISIL读出（描述无上限，按无上限处理）；友方受击时获得攻击/防御等级提升未建模（模拟中目标不攻击）",
    skillMods(c) {
      const lost = Math.floor(c.battle.lostHpPct);
      if (lost > 0) return { dmg: lost * 0.01 };
    },
  },
  // PassiveAbility_1070801.GetAttackDmgMultiplier: trunc(target Vibration potency / 6) × 0.1, max 0.3.
  {
    id: 1070811,
    summary: "目标每有6级震颤强度，造成伤害+10%（最多+30%）",
    approx: "通过技能使目标转为特殊震颤（崩溃）时触发震颤爆发未建模",
    coinMods(c) {
      const n = Math.floor(c.target.getPotency("Vibration") / 6);
      if (n > 0) return { dmg: Math.min(n * 0.1, 0.3) };
    },
  },
  // PassiveAbility_1070901/1070911: every 10 Charge count used → +1 Charge potency; round end Agility / ParryingResultUp (speed/clash only).
  {
    id: 1070911,
    summary: "本场战斗累计消耗10层充能时，充能强度+1",
    // 不影响输出：回合结束的迅捷/拼点威力提升
    ...chargeHooks,
  },
  // PassiveAbility_1071001.GetAttackDmgMultiplier: target Sinking potency × 0.01, max 0.15.
  {
    id: 1071012,
    summary: "目标每有1级沉沦强度，造成伤害+1%（最多+15%）",
    approx: "友方受致死伤害时的狂猎相关效果未建模",
    coinMods(c) {
      const p = c.target.getPotency("Sinking");
      if (p > 0) return { dmg: Math.min(p * 0.01, 0.15) };
    },
  },
  // PassiveAbility_1071101.OnRoundStart_After_Event: first round after stage start → PenetrateResultUp 3.
  // OnRoundEnd: all Bullet types 0 → Retreat_FullStop (_RETREAT_CNT_MAX 1); on re-entry (OnETB): LogicAtelierAM 10 (cap 4),
  // PenetrateResultUp 3, FullReload (Bullet back to initBuffs 10; not Bullet_LogicAtelier).
  {
    id: 1071103,
    summary: "关卡开始的首回合获得3层突刺威力提升；回合结束时弹药全为0则待命并重返（完全装填、逻辑工作室弹匣至最大、3层突刺威力提升）",
    approx: "待命按“无替补、下回合立即重返”处理（实战中会被替补换下至少1回合）；重返时保留其他状态",
    onTurnStart(c) {
      if (c.state.get("given")) return;
      c.state.set("given", 1);
      c.give("actor", "PenetrateResultUp", 3, 0, 0);
    },
    onRoundEnd(c) {
      if (c.state.get("retreated") || c.actor.getPotency("Bullet") > 0 || c.actor.getPotency("Bullet_LogicAtelier") > 0) return;
      c.state.set("retreated", 1);
      c.give("actor", "Bullet", 10, 0, 1);
      c.give("actor", "LogicAtelierAM", 4, 0, 1);
      c.give("actor", "PenetrateResultUp", 3, 0, 1);
      c.note("弹药耗尽：待命后重返，完全装填10发");
    },
  },
  // PassiveAbility_1071102/1071111: Breath → Agility; only when NOT attacking does it grant Breath/PenetrateResultUp. Simulated unit always attacks.
  noDamagePassive(1071111, "按呼吸法强度获得迅捷；仅在本回合未使用攻击技能时增加呼吸法（模拟中每回合都攻击）"),
  // PassiveAbility_1071202: on Black Cloud ally death → SlashResultUp / EngageToBattle.
  {
    id: 1071202,
    summary: "黑云会友方阵亡时获得斩击威力提升/临战",
    approx: "未建模：友方阵亡不在模拟中发生",
  },
  // PassiveAbility_1071201: OnBattleStart BlackCloudBlade 1 if ≥2 BLACK_CLOUD; OnStartBehaviour marks targets that used defense or were at max HP → +10% dmg.
  {
    id: 1071211,
    summary: "黑云会≥2名时每回合获得黑云刀；对攻击前满血（或本回合使用守备技能）的目标伤害+10%",
    approx: "目标满血按“本场战斗尚未对目标造成攻击伤害”近似；反击/后巷规矩追加攻击未建模",
    onTurnStart(c) {
      if (assocCount(c, BLACK_CLOUD) >= 2 && c.actor.getPotency("BlackCloudBlade") < 1) c.give("actor", "BlackCloudBlade", 1, 0, 0);
    },
    skillMods(c) {
      c.state.set("fullHpAtStart", c.state.get("dealt") ? 0 : 1);
    },
    coinMods(c) {
      if (c.state.get("fullHpAtStart")) return { dmg: 0.1 };
    },
    onCoinHit(c) {
      if ((c.lastHitDamage ?? 0) > 0) c.state.set("dealt", 1);
    },
  },
  // PassiveAbility_1071301: Charge spend tracker; OnRoundStart DefenseUp = min(Charge potency, 6) (defensive).
  {
    id: 1071301,
    summary: "本场战斗累计消耗10层充能时，充能强度+1；回合开始按充能强度获得防御等级提升",
    ...chargeHooks,
  },
  // PassiveAbility_1071311: shields; skill-caused Charge overflow → +3%/overflowed count (max 15%) for that skill.
  {
    id: 1071311,
    summary: "护盾；技能使充能溢出时每溢出1层伤害+3%（最多15%）",
    approx: "溢出部分未建模：引擎无状态获得溢出钩子",
  },
  // PassiveAbility_1071401: OnBattleStart (each turn) trunc(lost/20%) (max 3) AttackUp+DefenseUp;
  // OnSucceedAttack with default skill → ChickenFightlust 1 (+1 if HP<50%), max 10 per round.
  {
    id: 1071401,
    summary: "战斗开始每失去20%体力获得攻击/防御等级提升（最多3）；基础技能命中获得斗鸡战意（体力<50%额外+1，每回合最多10）",
    approx: "拼点开始(+3)、击杀(+5)、受到烧伤伤害(+1)的斗鸡战意未建模",
    onTurnStart(c) {
      const n = Math.min(3, Math.trunc(c.battle.lostHpPct / 20));
      if (n > 0) {
        c.give("actor", "AttackUp", n, 0, 0);
        c.give("actor", "DefenseUp", n, 0, 0);
      }
    },
    onCoinHit(c) {
      if (!isBasicSkill(c)) return;
      const key = `lust:${c.turn}`;
      const used = c.state.get(key) ?? 0;
      const add = Math.min(c.battle.lostHpPct > 50 ? 2 : 1, 10 - used);
      if (add <= 0) return;
      c.state.set(key, used + add);
      c.give("actor", "ChickenFightlust", add, 0, 0);
    },
  },
  noDamagePassive(1071403, "不死与下回合回复体力"),
  // PassiveAbility_1071501: MiddleFingerTattooID per envy resonance; counter-kick when Middle Finger allies are attacked.
  {
    id: 1071501,
    summary: "战斗开始按嫉妒共鸣数获得中指纹身；中指友方受击后反击",
    approx: "未建模：共鸣数未知；反击需目标攻击",
  },
  noDamagePassive(1071503, "中指守备友方受单方面攻击伤害降低/免疫混乱"),
  // PassiveAbility_1071512/1071502: VendettaMark when hit, skill conversion at ≥15 tattoo, return-to-field attack.
  {
    id: 1071512,
    summary: "受击时施加仇怨印记并获得复仇账簿；纹身≥15层时基础技能转化为“全员，处刑！！”",
    approx: "未建模：技能转化、受击触发、重返战场追加攻击",
  },
  // PassiveAbility_1071601: stack = own EvolvingManual + main target DuelEdgeAlly (snapshot OnStartTurn_BeforeLog), default skills only.
  {
    id: 1071601,
    summary: "按进化手册+目标决斗之刃层数：基础技能伤害+3%/层（最多15%），≥2基础威力+1，≥3命中施加下回合断筋，≥4最终威力+1，≥5伤害再+15%",
    approx: "拼点威力+1与受到伤害降低不影响单方面输出",
    skillMods(c) {
      const n = isBasicSkill(c) ? c.actor.getPotency("EvolvingManual") + c.target.getPotency("DuelEdgeAlly") : 0;
      c.state.set("stk", n);
      if (n <= 0) return;
      return {
        dmg: Math.min(n * 0.03, 0.15) + (n >= 5 ? 0.15 : 0),
        basePower: n >= 2 ? 1 : 0,
        finalPower: n >= 4 ? 1 : 0,
      };
    },
    onCoinHit(c) {
      if (isBasicSkill(c) && (c.state.get("stk") ?? 0) >= 3) c.give("target", "SeveredTendonAlly", 1, 0, 1);
    },
  },
  // PassiveAbility_1071602.OnEndTurn: default skill not killing main target → DuelEdgeAlly 1 (+1 if it clashed).
  {
    id: 1071602,
    summary: "基础技能结束后未击杀主要目标时，对其施加1层决斗之刃",
    approx: "拼点时改为2层、击杀获得进化手册、拼点回复理智未建模（无拼点/击杀）",
    onSkillEnd(c) {
      if (isBasicSkill(c)) c.give("target", "DuelEdgeAlly", 1, 0, 0);
    },
  },
  // PassiveAbility_1071603: with Rodion 10916 (FutureEyeOnRodion) → extra one-side attack with skill 1071601 once per turn.
  {
    id: 1071603,
    summary: "拇指父辈罗佳(#10916)在场且带有未来之眼时，基础技能命中后追加“巴勒莫之剑”单方面攻击",
    approx: "未建模：引擎不支持被动触发的追加技能攻击",
  },
  noDamagePassive(1071604, "自身阵亡时强化蜘蛛巢良秀"),
  // PassiveAbility_1071701.OnRoundEnd: GiveBuff_Self(2130 = _MAIN_BUFF_KEY NeedlekinAlly, 1).
  {
    id: 1071701,
    summary: "回合结束时获得1层针刺眷属（攻击等级+1/层）",
    onRoundEnd(c) {
      c.give("actor", "NeedlekinAlly", 1, 0, 0);
    },
  },
  // PassiveAbility_1071702: Charge-use → Charge potency (ratio fields not recoverable), synergy with 11016 Sinclair.
  {
    id: 1071702,
    summary: "消耗充能时转化为充能强度；与辛克莱(#11016)联动升级",
    approx: "未建模：转化比例字段无法从ISIL确定；联动增益未建模",
  },
  // PassiveAbility_1071713: after attack with NeedlekinAlly at max → CutInActionBySkillId(1071705); base gains Charge when losing HP.
  {
    id: 1071713,
    summary: "攻击技能结束时若[NeedlekinAlly]达到上限，追加使用追击技能(1071705)；受伤获得充能",
    approx: "追击按自身追加行动在本技能后执行（每回合≤1次，防循环）；受伤触发不在模拟中发生",
    onSkillEnd(c) {
      if (c.skill?.id === 1071705) return;
      const s = c.actor.get("NeedlekinAlly");
      if (!s || s.potency < s.maxPotency) return;
      c.queueAction?.(1071705, { label: "针刺眷属追击", key: "1071713" });
    },
  },
  // PassiveAbility_1080211: Enhancement = Gloom resonance / 3 at battle start.
  {
    id: 1080211,
    summary: "战斗开始按忧郁共鸣数/3获得强壮（共鸣取场景 battle.resonance）",
    onTurnStart(c) {
      const n = Math.floor((c.battle.resonance?.AZURE ?? 0) / 3);
      if (n > 0) c.give("actor", "Enhancement", n, 0);
    },
  },
  // PassiveAbility_1080301.GetGiveBuffStackAdder: Breath (43) +1 while HP < 50%.
  {
    id: 1080301,
    summary: "体力低于50%时，自身通过技能增加的呼吸法强度额外+1",
    approx: "按硬币命中前后自身呼吸法强度上升检测（每枚硬币最多+1；技能开始时的施加未检测）",
    coinMods(c) {
      snapshot(c, "actor", ["Breath"]);
    },
    onCoinHit(c) {
      if (c.battle.lostHpPct > 50 && risen(c, "actor", ["Breath"]).length) c.give("actor", "Breath", 1, 0, 0);
    },
  },
  // PassiveAbility_1080401: after winning a clash, each hit gives Vibration 1.
  {
    id: 1080401,
    summary: "拼点胜利后每次命中使目标增加1级震颤强度",
    approx: "未建模：模拟无拼点",
  },
  noDamagePassive(1080511, "未造成体力伤害时下回合获得护盾"),
  // PassiveAbility_1080601.GetAttackDmgMultiplier: HIT skill, trunc(target Combustion count / 3) × 0.1, max 0.3.
  {
    id: 1080601,
    summary: "目标每有3层烧伤，打击伤害+10%（最多+30%）",
    coinMods(c) {
      if (c.skill?.atkType !== "HIT") return;
      const n = Math.floor(c.target.getCount("Combustion") / 3);
      if (n > 0) return { dmg: Math.min(n * 0.1, 0.3) };
    },
  },
  // PassiveAbility_1080701.OnSucceedAttack: target has Vibration → Sinking count 1 (stack 0, turn 1, activeRound 0).
  {
    id: 1080701,
    summary: "命中带有震颤的目标时施加1层沉沦",
    onCoinHit(c) {
      if (c.target.get("Vibration")) c.give("target", "Sinking", 0, 1, 0);
    },
  },
  // PassiveAbility_1080802: +10% vs ON_THE_LAKE targets.
  {
    id: 1080802,
    summary: "对<大湖生物>目标伤害+10%",
    coinMods(c) {
      if (c.targetHasUnitKeyword?.("ON_THE_LAKE")) return { dmg: 0.1 };
    },
  },
  // PassiveAbility_1080811: on target death after attack → Breath/OverHeatedGasHarpoon, ally SP/Breath.
  {
    id: 1080811,
    summary: "攻击后目标阵亡时获得呼吸法与过热鱼叉，并强化友方",
    approx: "未建模：击杀不在模拟中发生",
  },
  // PassiveAbility_1080901: crit + target slower → negative statuses given by skill +1 (3 per turn).
  {
    id: 1080901,
    summary: "暴击命中速度低于自身的目标时，技能施加的负面状态额外+1级（每回合最多3次）",
    approx: "按硬币命中前后目标五种罪孽状态强度上升检测，其他负面状态未覆盖；技能开始时的施加未检测",
    coinMods(c) {
      snapshot(c, "target", NEG_SIN);
    },
    onCoinHit(c) {
      if (!c.isCritical || !(c.battle.targetSpeed < c.battle.selfSpeed)) return;
      const key = `cnt:${c.turn}`;
      for (const k of risen(c, "target", NEG_SIN)) {
        const used = c.state.get(key) ?? 0;
        if (used >= 3) break;
        c.state.set(key, used + 1);
        c.give("target", k, 1, 0, 0);
      }
    },
  },
);
