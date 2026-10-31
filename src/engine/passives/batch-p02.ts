/** Passive batch 02 — see data/il2cpp/dossiers/passives-02.md */
import { giveAdder, noDamagePassive, registerPassives, type PassiveCtx } from "./framework";
import { usedPerThreshold } from "./used-tracker";

// ------------------------------------------------------------------ helpers

const slotOf = (c: PassiveCtx) => c.skill?.slot ?? "";
/** UnitDataModel.HasSkillAsDefaultSkill → S1/S2/S3. */
const isDefault = (c: PassiveCtx) => ["S1", "S2", "S3"].includes(slotOf(c));
/** BattleUnitModel.HasSkillAsDefaultSkillIncludeDefenseSkill → S1/S2/S3/DEF. */
const isDefaultInclDef = (c: PassiveCtx) => ["S1", "S2", "S3", "DEF"].includes(slotOf(c));
const isLastCoin = (c: PassiveCtx) => c.skill != null && c.coinIndex === c.skill.coinCount - 1;

type Amount = "potency" | "count";
const read = (c: PassiveCtx, side: "actor" | "target", kw: string, kind: Amount) =>
  kind === "potency" ? c[side].getPotency(kw) : c[side].getCount(kw);

/** Reset a snapshot without counting the change (turn start: round-end decay is not consumption). */
function snap(c: PassiveCtx, side: "actor" | "target", kw: string, kind: Amount): void {
  c.state.set(`snap:${side}:${kw}:${kind}`, read(c, side, kw, kind));
}
/** Change since the last snapshot (positive = increase), then re-snapshot. */
function delta(c: PassiveCtx, side: "actor" | "target", kw: string, kind: Amount): number {
  const key = `snap:${side}:${kw}:${kind}`;
  const cur = read(c, side, kw, kind);
  const last = c.state.get(key);
  c.state.set(key, cur);
  return last === undefined ? 0 : cur - last;
}

/**
 * "每累计消耗10层X时，X强度+1" (BeforeUseBuff / GetUsedBuffTurn / _TURN_DEVIDE=10 pattern).
 * Exact consumption from the per-action record (usedPerThreshold). Returns potency to grant.
 */
function consumeCounter(c: PassiveCtx, kw: string, per = 10): number {
  return usedPerThreshold(c, `cc:${kw}`, [kw], per);
}

const BLESS = "BlessingOfIndexPrescriptAlly";
const PRESCRIPT = "IndexPrescriptTargetToEnemy";

/** PassiveAbility_1021401/1031401.CalcDmgMul: blessing 9 → +20% on default skills (incl. DEF); else marked skill → min(2%×stack,16%). */
function indexDmg(c: PassiveCtx): number {
  if (!isDefaultInclDef(c)) return 0;
  const b = c.actor.getPotency(BLESS);
  if (b >= 9) return 0.2;
  // IndexPrescriptTargetMarkToEnemy (system ability) is put on up to 2 default ATTACK skills by the main passive; assume the used one is marked.
  if (slotOf(c) === "DEF") return 0;
  return Math.min(b * 0.02, 0.16);
}

/** IndexFingerMissionSubPassive (1021403/1031403) simplified: mission = default attack skill hits a target with IndexPrescriptTargetToEnemy. */
function missionSub(id: number, karmaBlocked: (c: PassiveCtx) => boolean, summary: string) {
  return {
    id,
    summary,
    approx: "指令任务类型(MISSION_TYPE)简化为“基础攻击技能命中带指令目标的敌人即成功(强化)”；理智恢复不计；战斗开始无法指定目标的豁免未建模",
    onCoinHit(c: PassiveCtx) {
      if (isDefault(c) && c.target.get(PRESCRIPT)) c.state.set(`ok:${c.turn}`, 1);
    },
    onRoundEnd(c: PassiveCtx) {
      if (c.state.get(`ok:${c.turn}`)) {
        // OnMissionSucceedOnRE: reinforced (main target had prescript) → 3 Blessing, capped to 9 (CheckAddBlessingStackLimit)
        const add = Math.min(3, 9 - c.actor.getPotency(BLESS));
        if (add > 0) c.give("actor", BLESS, add, 0);
      } else if (!karmaBlocked(c)) {
        // OnMissionFailOnRE: 5 KarmaOfIndexAlly
        c.give("actor", "KarmaOfIndexAlly", 5, 0);
      }
    },
  };
}

/** Breath/Sinking adder "+1 when given by default skill" approximated by per-hit increase detection. */
function skillGainAdder(c: PassiveCtx, side: "actor" | "target", kw: string): void {
  if (delta(c, side, kw, "potency") > 0) {
    c.give(side, kw, 1, 0);
    snap(c, side, kw, "potency");
  }
}

/**
 * RingFingerHongLuFaustNormalPassiveBase.BeforeUseBuff: every 10 used → +1 potency (already done by StatusContainer.consumeCount for
 * UsedTurnReportSinBuff); potency ≥2 → special keyword (FasciaPersonality for 1021504).
 */
function bodyArtUsed(c: PassiveCtx): void {
  if (c.actor.getPotency("ChargeBodyArt") >= 2 && !c.actor.get("FasciaPersonality")) c.give("actor", "FasciaPersonality", 1, 0);
}

// ------------------------------------------------------------------ handlers

registerPassives(
  // PassiveAbility_1021011 (base 1021001): CalculateDmgMultiplier — Charge potency ≥2 → min(3%×p,15%); target HP<50% → extra min(5%×p,25%).
  // BeforeUseBuff(Charge): every 10 Charge count used → +1 Charge potency.
  {
    id: 1021011,
    summary: "充能强度≥2时伤害+(强度×3%)(最多15%)；目标体力<50%时另+(强度×5%)(最多25%)；累计消耗10层充能时充能强度+1",
    approx: "击杀给予充能未建模（无击杀）",
    onTurnStart(c) {
      snap(c, "actor", "Charge", "count");
    },
    coinMods(c) {
      const p = c.actor.getPotency("Charge");
      if (p < 2) return;
      // CalculateDmgMultiplier: target HP ratio < _HP_RATIO_CONDITION (0.5 in 1021011) → + min(p × 0.05, 0.25)
      const extra = c.targetHpRatio() < 0.5 ? Math.min(p * 0.05, 0.25) : 0;
      return { dmg: Math.min(p * 0.03, 0.15) + extra };
    },
    onCoinHit(c) {
      const n = consumeCounter(c, "Charge");
      if (n > 0) c.give("actor", "Charge", n, 0);
    },
    onSkillEnd(c) {
      const n = consumeCounter(c, "Charge");
      if (n > 0) c.give("actor", "Charge", n, 0);
    },
  },
  noDamagePassive(1021101, "自身不会因烧伤伤害混乱/降至1以下"),
  // PassiveAbility_1021111: OnBattleStart (lost HP ≥80%, Combustion<30 → raise to 30, once); OnRoundEnd: floor(Combustion/6) AttackUp (max 5) next turn.
  {
    id: 1021111,
    summary: "战斗开始已损失体力≥80%时自身烧伤强度补至30；回合结束每6级烧伤强度下回合获得1层攻击等级提升(最多5)",
    approx: "阵亡时给敌方烧伤/E.G.O资源/队友攻击提升未建模",
    onBattleStart(c) {
      if (c.battle.lostHpPct < 80) return;
      const p = c.actor.getPotency("Combustion");
      if (p < 30) c.give("actor", "Combustion", 30 - p, 0);
    },
    onRoundEnd(c) {
      const n = Math.min(Math.floor(c.actor.getPotency("Combustion") / 6), 5);
      if (n > 0) c.give("actor", "AttackUp", n, 0, 1);
    },
  },
  // PassiveAbility_1021201: GetAttackDmgMultiplier — speed diff ≥1 → min(2%×diff,10%). OnBurstReactiveActivatedAnyUnit → EnhanceZilu (+1, +2 if self, ≤5/turn).
  {
    id: 1021201,
    summary: "速度高于目标时每差1点伤害+2%(最多10%)；目标咒杀(BurstZilu)触发时获得2层EnhanceZilu(每回合最多5次)",
    approx: "咒杀触发按目标BurstZilu层数减少近似；友方触发、援护(SupportProtect)获得5层未建模",
    coinMods(c) {
      const diff = c.battle.selfSpeed - c.battle.targetSpeed;
      if (diff < 1) return;
      return { dmg: Math.min(diff * 0.02, 0.1) };
    },
    onTurnStart(c) {
      snap(c, "target", "BurstZilu", "potency");
    },
    onCoinHit(c) {
      if (delta(c, "target", "BurstZilu", "potency") >= 0) return;
      const key = `cnt:${c.turn}`;
      const used = c.state.get(key) ?? 0;
      if (used >= 5) return;
      c.state.set(key, used + 1);
      c.give("actor", "EnhanceZilu", 2, 0); // _STACK 1 + self-activated (_STACK_ALT 2)
    },
  },
  noDamagePassive(1021202, "隐藏：记录累计失去体力"),
  // PassiveAbility_1021203: when a unit's BurstZilu reaches 0 → give it BurstVulnerableZilu.
  {
    id: 1021203,
    summary: "目标BurstZilu降至0时施加BurstVulnerableZilu",
    approx: "以命中后目标BurstZilu层数由>0变为0近似咒杀触发时机",
    onTurnStart(c) {
      snap(c, "target", "BurstZilu", "potency");
    },
    onCoinHit(c) {
      const before = c.state.get("snap:target:BurstZilu:potency") ?? 0;
      delta(c, "target", "BurstZilu", "potency");
      if (before > 0 && c.target.getPotency("BurstZilu") <= 0) c.give("target", "BurstVulnerableZilu", 1, 0);
    },
  },
  // PassiveAbility_1021302: converts leftmost default skill into “闪弓”(1021305) and adds tier-based power/dmg (S1 +1/+11%, S2 +1/+1/+22%, S3 +4/+4/+44%).
  {
    id: 1021302,
    summary: "狙击-弓：瞄准模式下将基础技能转化为“闪弓”并按原技能等级强化",
    approx: "每回合首个基础技能视为“最左侧”技能；EGO装备/IsMaxStack/HasTier3Skill 判定未建模；等级加成按描述(基础/硬币/伤害)",
    // BeforeCompleteCommand: HasActivatedBuff(SnipingArrowMode) && !_upgradeAction && default skill → ChangeSkill(_SPECIAL_SKILL_ID 1021305).
    beforeUse(c) {
      const slot = c.skill?.slot;
      if (!c.actor.get("SnipingArrowMode") || (slot !== "S1" && slot !== "S2" && slot !== "S3")) return;
      if (c.state.get("upTurn") === c.turn) return;
      if (c.replaceSkill(1021305, `瞄准模式：${slot}转化为闪弓`)) {
        c.state.set("upTurn", c.turn);
        c.state.set("tier", Number(slot.slice(1)));
      }
    },
    skillMods(c) {
      if (c.skill?.id !== 1021305 || c.state.get("upTurn") !== c.turn) return;
      const t = c.state.get("tier") ?? 0;
      if (t === 1) return { basePower: 1, dmg: 0.11 };
      if (t === 2) return { basePower: 1, coinScale: 1, dmg: 0.22 };
      if (t === 3) return { basePower: 4, coinScale: 4, dmg: 0.44 };
    },
  },
  // PassiveAbility_1021311 (base 1021301): ArrowShiFau=4 & default skill gives Breath → +1 Breath (≤3, reset when ArrowShiFau=3);
  // OnStartTurn_BeforeLog: skill 1021305 with AimForTheGoal ≥2 → SlashDamageUp 2 next turn.
  {
    id: 1021311,
    summary: "ArrowShiFau为4层时基础攻击技能增加呼吸法强度额外+1(最多3次)；使用“闪弓”时瞄准≥2层则下回合获得2层斩击伤害提升",
    approx: "呼吸法增加按命中后强度上升检测近似",
    onTurnStart(c) {
      snap(c, "actor", "Breath", "potency");
      if (c.actor.getPotency("ArrowShiFau") === 3) c.state.set("cnt", 0);
    },
    skillMods(c) {
      if (c.skill?.id === 1021305 && c.actor.getPotency("AimForTheGoal") >= 2) c.state.set(`slash:${c.turn}`, 1);
    },
    onCoinHit(c) {
      if (c.actor.getPotency("ArrowShiFau") === 3) c.state.set("cnt", 0);
      const d = delta(c, "actor", "Breath", "potency");
      if (d <= 0 || !isDefault(c) || c.actor.getPotency("ArrowShiFau") < 4) return;
      const cnt = c.state.get("cnt") ?? 0;
      if (cnt >= 3) return;
      c.state.set("cnt", cnt + 1);
      c.give("actor", "Breath", 1, 0);
      snap(c, "actor", "Breath", "potency");
    },
    onSkillEnd(c) {
      if (c.state.get(`slash:${c.turn}`) && c.skill?.id === 1021305) {
        c.state.delete(`slash:${c.turn}`);
        c.give("actor", "SlashDamageUp", 2, 0, 1);
      }
    },
  },
  // PassiveAbility_1021401: CalcDmgMul (see indexDmg); OnSucceedAttack: default skill hits prescript target → +1 Breath self, +1 Sinking target
  // (per turn: 1 + floor(blessing/3), max 3); blessing 9 → default skills' Breath/Sinking +1.
  {
    id: 1021401,
    summary: "按祝福层数提高被标记技能伤害(每层2%，最多16%；9层时基础技能+20%)；命中指令目标时自身呼吸法+1、目标沉沦+1",
    approx: "假设所用基础攻击技能均被标记；9层时基础技能呼吸法/沉沦+1按命中后强度上升检测近似",
    onTurnStart(c) {
      snap(c, "actor", "Breath", "potency");
      snap(c, "target", "Sinking", "potency");
    },
    coinMods(c) {
      const d = indexDmg(c);
      return d ? { dmg: d } : undefined;
    },
    onCoinHit(c) {
      const b = c.actor.getPotency(BLESS);
      if (b >= 9 && isDefaultInclDef(c)) {
        skillGainAdder(c, "actor", "Breath");
        skillGainAdder(c, "target", "Sinking");
      }
      if (isDefaultInclDef(c) && c.target.get(PRESCRIPT)) {
        const key = `sa:${c.turn}`;
        const used = c.state.get(key) ?? 0;
        const max = Math.min(1 + Math.floor(b / 3), 3);
        if (used < max) {
          c.state.set(key, used + 1);
          c.give("actor", "Breath", 1, 0);
          c.give("target", "Sinking", 1, 0);
        }
      }
      snap(c, "actor", "Breath", "potency");
      snap(c, "target", "Sinking", "potency");
    },
    onSkillEnd(c) {
      snap(c, "actor", "Breath", "potency");
      snap(c, "target", "Sinking", "potency");
    },
  },
  // PassiveAbility_1021402 (IndexFingerMissionMainPassive): round start → prescript on 1 random enemy (single target here), marks default skills.
  {
    id: 1021402,
    summary: "回合开始对目标施加IndexPrescriptTargetToEnemy（受食指单位伤害+10%）",
    approx: "IndexPrescriptFaust_N(无数值效果)与技能标记仅在1021401中按“已标记”假设；混乱/恐慌等失效条件未建模",
    onTurnStart(c) {
      if (!c.target.get(PRESCRIPT)) c.give("target", PRESCRIPT, 1, 0);
    },
  },
  missionSub(1021403, (c) => c.actor.getPotency(BLESS) >= 9, "执行指令则回合结束获得3层祝福(上限9)，否则获得5层业(祝福9层时不施加)"),
  // PassiveAbility_1021503.OnRoundEnd: has FasciaPersonality → destroy IronMaidenPersonality, give SilverOpportunity (once).
  {
    id: 1021503,
    summary: "回合结束时若带有FasciaPersonality则解除IronMaidenPersonality并获得SilverOpportunity(每场1次)",
    approx: "首次登场获得IronMaidenPersonality(不在本类代码中)与解除混乱未建模",
    onRoundEnd(c) {
      if (c.state.get("done") || !c.actor.get("FasciaPersonality")) return;
      c.state.set("done", 1);
      const im = c.actor.getPotency("IronMaidenPersonality");
      if (im > 0) c.lose("actor", "IronMaidenPersonality", im);
      c.give("actor", "SilverOpportunity", 1, 0);
    },
  },
  // PassiveAbility_1021504 (RingFingerHongLuFaustNormalPassiveBase): Charge is overwritten to ChargeBodyArt; first appearance 2×ring-finger allies
  // (max 10); OnEndTurn after damaging → 5 count; every 10 used → +1 potency, potency ≥2 → FasciaPersonality.
  {
    id: 1021504,
    summary: "登场获得ChargeBodyArt(环指单位数×2)；技能造成伤害后获得5层；累计消耗10层时强度+1，强度≥2时获得FasciaPersonality",
    approx: "环指友方数量仅计自身(2层)；击杀额外3层未建模；消耗10层强度+1由引擎(UsedTurnReportSinBuff)处理",
    onBattleStart(c) {
      c.give("actor", "ChargeBodyArt", 0, 2);
    },
    onCoinHit(c) {
      if ((c.lastHitDamage ?? 0) > 0) c.state.set(`hit:${c.turn}`, 1);
      bodyArtUsed(c);
    },
    onSkillEnd(c) {
      bodyArtUsed(c);
      if (c.state.get(`hit:${c.turn}`)) {
        c.state.delete(`hit:${c.turn}`);
        c.give("actor", "ChargeBodyArt", 0, 5);
      }
    },
  },
  // PassiveAbility_1021511 (base RingFingerHongLuFaustBattlePassiveBase): MelodyBodyArt's speed/clash/dmg doubled; SP heal on negative-buff attacks.
  {
    id: 1021511,
    summary: "MelodyBodyArt提供的伤害加成翻倍（基础攻击技能额外+10%）",
    approx: "翻倍逻辑在状态侧，按MelodyBodyArt描述(基础攻击技能伤害+10%)额外加10%；理智恢复及理智满时下回合斩击伤害提升未建模(未跟踪理智值)",
    coinMods(c) {
      if (isDefault(c) && c.actor.get("MelodyBodyArt")) return { dmg: 0.1 };
    },
  },
  // PassiveAbility_1030101: OnWinDuel marks the action; GetAttackDmgMultiplier +_DMG_MULTIPLIER (0.1) for that action.
  {
    id: 1030101,
    summary: "拼点胜利时该技能伤害+10%",
    approx: "仅在可选敌方行动模型（拼点胜利）下触发",
    coinMods(c) {
      if (c.duelResult?.() === "win") return { dmg: 0.1 };
    },
  },
  // PassiveAbility_1030201.OnBattleStart: Charge count = floor(Gloom resonance / 3).
  {
    id: 1030201,
    summary: "战斗开始获得(忧郁共鸣数/3)层充能",
    // 共鸣数取场景 battle.resonance.AZURE（未声明按 0）
    onTurnStart(c) {
      const n = Math.floor((c.battle.resonance?.AZURE ?? 0) / 3);
      if (n > 0) c.give("actor", "Charge", 0, n);
    },
  },
  noDamagePassive(1030301, "按暴怒共鸣获得迅捷（仅速度）"),
  // PassiveAbility_1030401: GetGiveBuffTurnAdder Vibration +1 count vs NailPersonality target; GetGiveBuffStackAdder NailPersonality +1 if self AssemblePersonality.
  {
    id: 1030401,
    summary: "对带有尖钉的目标施加的震颤层数+1；自身带有狂信时施加的尖钉+1",
    approx: "仅对本次施加已包含的维度加值；目标自身状态能力施加的不计",
    // Adders applied centrally at every give to the target (interceptor), re-registered each turn.
    onTurnStart(c) {
      const notTargetOwn = (ch: { source?: string }) => !ch.source?.startsWith("target:");
      giveAdder(c, "turn", {
        key: "1030401:vib",
        side: "target",
        buffId: "Vibration",
        kinds: ["turn"],
        amount: 1,
        when: (ch) => notTargetOwn(ch) && ch.owner.get("NailPersonality") !== undefined,
      });
      giveAdder(c, "turn", {
        key: "1030401:nail",
        side: "target",
        buffId: "NailPersonality",
        kinds: ["stack"],
        amount: 1,
        when: (ch) => notTargetOwn(ch) && c.actor.get("AssemblePersonality") !== undefined,
      });
    },
  },
  // PassiveAbility_1030501: all allies faster than all enemies → min(6%×(self − slowest enemy speed), 30%).
  {
    id: 1030501,
    summary: "速度高于目标时每差1点伤害+6%(最多30%)",
    approx: "“全体友方速度均高于全体敌方”仅按自身与目标判断",
    coinMods(c) {
      const diff = c.battle.selfSpeed - c.battle.targetSpeed;
      if (diff <= 0) return;
      return { dmg: Math.min(diff * 0.06, 0.3) };
    },
  },
  // PassiveAbility_1030611.GetCoinScaleAdder: main target has RetaliationBook → coin power +1.
  {
    id: 1030611,
    summary: "主要目标带有报复对象时硬币威力+1",
    approx: "报复对象由敌方对友方造成伤害决定、嫉妒伤害强化由受击触发，均未建模（仅当目标已带报复对象时生效）",
    coinMods(c) {
      if (c.target.get("RetaliationBook")) return { coinScale: 1 };
    },
  },
  noDamagePassive(1030711, "拼点威力+1与受击回复体力"),
  noDamagePassive(1030811, "为友方单位增加呼吸法"),
  {
    id: 1031001,
    summary: "血宴：根据全体单位受到的流血伤害获得BloodDinner",
    approx: "BloodDinner获取逻辑由系统处理(本类无数值)，按流血伤害获取未建模；不死判定无关输出",
  },
  // PassiveAbility_1031002: skill enhancement by La Manchaland allies; BloodArmor from allies' Laceration damage.
  {
    id: 1031002,
    summary: "桑丘变体硬血式：满足条件时强化行动槽技能",
    approx: "技能强化(替换)未建模；友方受流血伤害/消耗血宴获得BloodArmorPersonalityFirst未建模",
  },
  noDamagePassive(1031003, "需拉·曼却领友方阵亡才生效"),
  // PassiveAbility_1031004.OnRoundEnd: floor(lost HP% / 15) AttackDmgUp next turn (max 3).
  {
    id: 1031004,
    summary: "回合结束时每失去15%体力，下回合获得1层伤害提升(最多3层)",
    approx: "击杀获得BloodDinner与友方流血不死未建模",
    onRoundEnd(c) {
      const n = Math.min(Math.floor(c.battle.lostHpPct / 15), 3);
      if (n > 0) c.give("actor", "AttackDmgUp", n, 0, 1);
    },
  },
  // PassiveAbility_1031102 (PassiveAbility_Dianxue, buff DianxueDonQuixote): GetSkillPowerAdder +1 when target stack ∈ {2,3} (per buff desc).
  {
    id: 1031102,
    summary: "目标点穴-堂吉诃德为2/3层时基础威力+1",
    approx: "拼点威力部分不计；层数表{2,3}取自状态描述",
    skillMods(c) {
      const s = c.target.getPotency("DianxueDonQuixote");
      if (s === 2 || s === 3) return { basePower: 1 };
    },
  },
  // PassiveAbility_1031111 (base 1031101): crit → dmg +min(target Combustion%, 15% + 5%×Dianxue); default skill hit → Dianxue next turn (1/turn).
  {
    id: 1031111,
    summary: "暴击时伤害+(目标烧伤强度)%(上限15%，目标每层点穴+5%)；基础攻击技能命中时下回合施加点穴-堂吉诃德",
    approx: "回合结束按呼吸法获得迅捷(速度)不计",
    coinMods(c) {
      if (!c.isCritical) return;
      const cap = 0.15 + 0.05 * c.target.getPotency("DianxueDonQuixote");
      const v = Math.min(c.target.getPotency("Combustion") * 0.01, cap);
      return v > 0 ? { dmg: v } : undefined;
    },
    onCoinHit(c) {
      if (!isDefault(c) || c.state.get(`dx:${c.turn}`)) return;
      c.state.set(`dx:${c.turn}`, 1);
      c.give("target", "DianxueDonQuixote", 1, 0, 1);
    },
  },
  // PassiveAbility_1031202: stage start HystericGauge / ThePowerOfLoveAndHate; round start SP≥0 → MagicalGirlAppear (else NoVillain);
  // OnUseBuff(ThePowerOfLoveAndHate): every 10 used → +1 potency (handled by StatusContainer.consumeCount for UsedTurnReportSinBuff).
  {
    id: 1031202,
    summary: "初始获得歇斯底里/爱与憎；理智≥0时获得魔法少女登场",
    approx: "未跟踪理智值，默认理智≥0(MagicalGirlAppear)；理智下限-40不计；消耗10层强度+1由引擎处理",
    onBattleStart(c) {
      if (!c.actor.get("HystericGauge")) c.give("actor", "HystericGauge", 1, 0);
      if (!c.actor.get("ThePowerOfLoveAndHate")) c.give("actor", "ThePowerOfLoveAndHate", 1, 0);
    },
    onTurnStart(c) {
      if (c.actor.get("NoVillain")) c.lose("actor", "NoVillain", c.actor.getPotency("NoVillain"));
      if (!c.actor.get("MagicalGirlAppear")) c.give("actor", "MagicalGirlAppear", 1, 0);
    },
  },
  // PassiveAbility_1031211 (base 1031201): non-defense skill → min(2%×ThePowerOfLoveAndHate potency, 10%); battle start ArcanaQueenOfHate 1.
  {
    id: 1031211,
    summary: "每级爱与憎强度伤害+2%(最多10%)；战斗开始获得1层憎恶皇后",
    onBattleStart(c) {
      c.give("actor", "ArcanaQueenOfHate", 1, 0);
    },
    coinMods(c) {
      // CheckCondition: SkillModel.IsDefenseNotCounter → excluded
      if (slotOf(c) === "DEF" && c.skill?.defType !== "COUNTER") return;
      const p = c.actor.getPotency("ThePowerOfLoveAndHate");
      return p > 0 ? { dmg: Math.min(p * 0.02, 0.1) } : undefined;
    },
  },
  // PassiveAbility_1031311 (base 1031301.CalculateAtkDmgMultiplier): target SP<0 → min(trunc(−SP/3),15)%; floor((Burst+Sinking)/2)% (max 15%, ×2 vs no-SP);
  // GrownHorns & last coin of default skill (incl. DEF) → +15% (+30% when target slot has a defense skill).
  {
    id: 1031311,
    summary: "目标破裂+沉沦强度每2级伤害+1%(最多15%)；带有GrownHorns时基础技能最后一枚硬币伤害+15%",
    approx: "目标理智值<0的加成未建模(无目标理智)；默认目标有理智值(无理智目标时破裂/沉沦部分及上限翻倍未建模)；攻击守备行动槽时+30%与拼点威力+3未建模",
    coinMods(c) {
      let dmg = Math.min(Math.floor((c.target.getPotency("Burst") + c.target.getPotency("Sinking")) / 2) * 0.01, 0.15);
      if (c.actor.get("GrownHorns") && isLastCoin(c) && isDefaultInclDef(c)) dmg += 0.15;
      return dmg > 0 ? { dmg } : undefined;
    },
  },
  // PassiveAbility_1031401: same dmg formula as 1021401; SP heal on prescript target (no damage).
  {
    id: 1031401,
    summary: "按祝福层数提高被标记技能伤害(每层2%，最多16%；9层时基础技能+20%)",
    approx: "假设所用基础攻击技能均被标记；命中指令目标恢复理智不计",
    coinMods(c) {
      const d = indexDmg(c);
      return d ? { dmg: d } : undefined;
    },
  },
  // PassiveAbility_1031402: prescript to enemy at round start; UnlockRank ≥3 → Blandishment_Shin.
  {
    id: 1031402,
    summary: "回合开始对目标施加IndexPrescriptTargetToEnemy；带有UnlockBuffAlly_3时获得Blandishment_Shin",
    approx: "IndexPrescriptDon_N与技能标记仅在1031401中按“已标记”假设；混乱/恐慌等失效条件未建模",
    onTurnStart(c) {
      if (!c.target.get(PRESCRIPT)) c.give("target", PRESCRIPT, 1, 0);
      if (c.actor.get("UnlockBuffAlly_3") && !c.actor.get("Blandishment_Shin")) c.give("actor", "Blandishment_Shin", 1, 0);
    },
  },
  missionSub(1031403, (c) => Boolean(c.actor.get("UnlockBuffAlly_3")), "执行指令则回合结束获得3层祝福(上限9)，否则获得5层业(带有UnlockBuffAlly_3时不施加)"),
);
