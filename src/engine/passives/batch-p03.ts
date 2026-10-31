/** Passive batch 03 — see data/il2cpp/dossiers/passives-03.md */
import { noDamagePassive, registerPassives, type PassiveCtx, type PassiveHandler } from "./framework";

/** BattleUtil.IsDefaultSkill / HasSkillAsDefaultSkill: base skills S1–S3. */
const isDefault = (c: PassiveCtx) => c.skill?.slot === "S1" || c.skill?.slot === "S2" || c.skill?.slot === "S3";
const isLastCoin = (c: PassiveCtx) => c.skill !== undefined && c.coinIndex === c.skill.coinCount - 1;
/** Per-turn limited counter: returns true (and consumes) if used < max this turn. */
function takeTurn(c: PassiveCtx, key: string, max: number): boolean {
  const k = `${key}:${c.turn}`;
  const used = c.state.get(k) ?? 0;
  if (used >= max) return false;
  c.state.set(k, used + 1);
  return true;
}

/** Coins of Ryōshū 10410 skills that give RedEyeFirst / PenanceFirst via GiveBuff* coin scripts (core.json skills 104100x). */
const RED_EYE_COINS: Record<number, number[]> = { 1041001: [1], 1041002: [1, 2], 1041003: [0], 1041004: [0] };
const PENANCE_COINS: Record<number, number[]> = { 1041001: [0], 1041002: [0], 1041003: [0, 1], 1041004: [1] };
const coinGives = (map: Record<number, number[]>, c: PassiveCtx) =>
  c.skill !== undefined && c.coinIndex !== undefined && (map[c.skill.id]?.includes(c.coinIndex) ?? false);

const handlers: PassiveHandler[] = [
  // PassiveAbility_1031404: OnRoundEnd unlock rank from BlessingOfIndexPrescriptAlly → EGO transformation, SP set to 25, KarmaOfIndexAlly.
  {
    id: 1031404,
    summary: "按祝福层数解锁绽放E.G.O::代行状态（理智值变动/混乱解除）",
    approx: "E.G.O形态转换、理智值与[Blandishment]状态未建模",
  },
  // PassiveAbility_1031502 (+ChargeTurnToStack): OnStageStart gives LE_NOIR allies Charge; Charge→ChargeNoirAlly conversion
  //   (CheckOverwriteGettingBuff, SPECIAL_KEYWORD 2070); "每累计消耗10层 +1强度" is handled by the engine for
  //   UsedTurnReportSinBuff (ChargeNoirAlly). The self 10 Count at stage start comes from identity initBuffs; nail charge costs
  //   are spent by GiveNoirNailUseCharge1031502 (batch-s06).
  {
    id: 1031502,
    summary: "获得的[Charge]转化为[ChargeNoirAlly]；首次登场给予其他黑派队友充能",
    approx: "给其他黑派队友的充能不影响本单位输出（队友未模拟）",
    onBattleStart(c) {
      c.interceptStatus?.(
        "persistent",
        (ch) => {
          if (ch.buffId !== "Charge" || ch.delta <= 0) return undefined;
          const r = ch.kind === "turn" ? { buffId: "ChargeNoirAlly", turn: ch.delta } : { buffId: "ChargeNoirAlly", stack: ch.delta };
          return { replaceWith: { ...r, activeRound: ch.activeRound } };
        },
        { side: "actor", key: "1031502:chargeToNoir" },
      );
    },
  },
  noDamagePassive(1031503, "获得/转换护盾强化[NoirShieldUpDonQuixote]"),
  // PassiveAbility_1031504.BeforeAttack: default skill → last coin gets CoinAbility_PowerUpByNailHalf1031504
  //   (SkillPowerResultAdder = min(5, ChargeNoirAlly stack + target NoirNail stack / 2)). OathField power is parrying-only.
  {
    id: 1031504,
    summary: "基础技能最后一枚硬币最终威力+([ChargeNoirAlly]强度+目标[NoirNailDonQuixote]/2)(最多+5)",
    approx: "「审判！」：声明黑派(LE_NOIR)队友（人格ID）时假设其每回合攻击一次，每名队友插入一次 1031505（插入顺序为本回合首个技能后）；[OathFieldDonQuixote]拼点威力仅拼点",
    // PassiveAbility_1031504.OnStartRunBattle: per LE_NOIR ally (not assistance) whose action attacks → CutInActionPrevOtherAction(1031505).
    onTurnStart(c) {
      for (const a of c.allyIdentities?.() ?? []) {
        if (a.associations.includes("LE_NOIR")) c.queueAction?.(1031505, { label: "审判！", key: `1031504:${a.id}` });
      }
    },
    // PassiveAbility_1031504.OnVibrationExplosionOtherUnit: exploded unit has NoirNailDonQuixote(2112) and per-turn counter < limit
    //   → GiveBuff_Self(Charge, n) and to the LE_NOIR ally with the least Charge (teammate-support.ts: 2 Charge, max 2/turn).
    onVibrationExplosion(c, ev) {
      if (ev.side !== "target" || c.target.getPotency("NoirNailDonQuixote") <= 0) return;
      const key = `burst:${c.turn}`;
      const n = c.state.get(key) ?? 0;
      if (n >= 2) return;
      c.state.set(key, n + 1);
      c.give("actor", "ChargeNoirAlly", 0, 2);
    },
    coinMods(c) {
      if (!isDefault(c) || !isLastCoin(c)) return;
      const v = Math.min(5, c.actor.getPotency("ChargeNoirAlly") + Math.floor(c.target.getPotency("NoirNailDonQuixote") / 2));
      if (v > 0) return { finalPower: v };
    },
  },
  // PassiveAbility_1031511.GetDamageMultiplier: default atk skill vs main target → min(0.30, ChargeNoirAlly stack × 6 × 0.01).
  {
    id: 1031511,
    summary: "基础攻击技能对主要目标伤害+([ChargeNoirAlly]强度×6)%(最多+30%)",
    approx: "战斗结束时[OathFieldDonQuixote]给予敏捷未建模",
    skillMods(c) {
      if (!isDefault(c)) return;
      const v = Math.min(0.3, c.actor.getPotency("ChargeNoirAlly") * 0.06);
      if (v > 0) return { dmg: v };
    },
  },
  // PassiveAbility_1040101.GetAttackDmgMultiplier: +0.25 (also takes +25%).
  { id: 1040101, summary: "造成伤害+25%（受到伤害+25%）", skillMods: () => ({ dmg: 0.25 }) },
  // PassiveAbility_1040201.GetAttackDmgMultiplier: IsSkillAtkType(SLASH) → +0.1.
  {
    id: 1040201,
    summary: "斩击伤害+10%",
    skillMods: (c) => (c.skill?.atkType === "SLASH" ? { dmg: 0.1 } : undefined),
  },
  // PassiveAbility_1040301.GetAttackDmgMultiplier: target HasActivatedBuff(Laceration) → +0.1.
  {
    id: 1040301,
    summary: "对带有流血的目标伤害+10%",
    coinMods: (c) => (c.target.getPotency("Laceration") > 0 || c.target.getCount("Laceration") > 0 ? { dmg: 0.1 } : undefined),
  },
  noDamagePassive(1040401, "击杀后为友方回复体力"),
  // PassiveAbility_1040611/1040601.OnRoundEnd: Breath ≥ 7 → SP +8; if SP is max → Breath +1 stack next turn.
  {
    id: 1040611,
    summary: "回合结束时呼吸法≥7恢复8理智值；理智值满时下回合呼吸法强度+1",
    approx: "理智值未建模：理智值满时获得的呼吸法强度未建模",
  },
  // PassiveAbility_1040811/1040801: OnSucceedAttack vs MarkOfButler → Breath +1 count & Agility +1 next turn (3/turn);
  //   crit → destroy mark; GetAttackDmgMultiplier (crit vs marked) min(0.6, 0.1 × (selfSpeed − targetSpeed)).
  {
    id: 1040811,
    summary: "暴击命中带[MarkOfButler]的目标时每速度差+10%伤害(最多60%)并解除标记；命中标记目标获得呼吸法次数与下回合敏捷(每回合3次)",
    coinMods(c) {
      if (!c.isCritical || c.target.getPotency("MarkOfButler") <= 0) return;
      const diff = c.battle.selfSpeed - c.battle.targetSpeed;
      if (diff > 0) return { dmg: Math.min(0.6, 0.1 * diff) };
    },
    onCoinHit(c) {
      const mark = c.target.getPotency("MarkOfButler");
      if (mark <= 0) return;
      if (takeTurn(c, "butler", 3)) {
        c.give("actor", "Breath", 0, 1, 0);
        c.give("actor", "Agility", 1, 0, 1);
      }
      if (c.isCritical) c.lose("target", "MarkOfButler", mark);
    },
  },
  noDamagePassive(1040901, "友方使敌方混乱时追加1技能攻击（追击未模拟）"),
  // PassiveAbility_1041011/1041001.CalculateDmgMultiplier: per coin that gives RedEyeFirst: +0.005×RedEye (+again if speed diff ≥ 3);
  //   coin that gives PenanceFirst: +0.005×Penance (+again if selfMp − targetMp ≥ 1). OnSucceedAttack: RedEye coin vs Laceration → +1 RedEye (3/turn);
  //   Penance coin with SP ≥ 20 → +1 Penance (3/turn).
  {
    id: 1041011,
    summary: "给予[RedEyeFirst]/[PenanceFirst]的硬币伤害+(对应层数/2)%（速度差≥3时RedEye再翻倍）；流血目标命中获得RedEye(每回合3)",
    approx: "理智值未建模：Penance的理智值差额外加成与理智≥20获得Penance未建模；3技能/5技能第3硬币特殊脚本是否算“给予”未确认（未计）",
    coinMods(c) {
      let v = 0;
      if (coinGives(RED_EYE_COINS, c)) {
        const s = c.actor.getPotency("RedEyeFirst");
        v += 0.005 * s;
        if (c.battle.selfSpeed - c.battle.targetSpeed >= 3) v += 0.005 * s;
      }
      if (coinGives(PENANCE_COINS, c)) v += 0.005 * c.actor.getPotency("PenanceFirst");
      if (v > 0) return { dmg: v };
    },
    onCoinHit(c) {
      if (coinGives(RED_EYE_COINS, c) && c.target.getPotency("Laceration") > 0 && takeTurn(c, "redeye", 3)) {
        c.give("actor", "RedEyeFirst", 1, 0, 0);
      }
    },
  },
  // PassiveAbility_1041111.CalculateMultiplier: self LegStrength → +0.05; target BurstAgility → +0.05.
  {
    id: 1041111,
    summary: "自身带[LegStrength]伤害+5%；目标带[BurstAgility]伤害+5%",
    skillMods(c) {
      let v = 0;
      if (c.actor.getPotency("LegStrength") > 0) v += 0.05;
      if (c.target.getPotency("BurstAgility") > 0) v += 0.05;
      if (v > 0) return { dmg: v };
    },
  },
  {
    // PassiveAbility_1041203.OnCompleteCommand/OrderCutInAction: ally 10113 uses 1011303 → Ryoshu cuts in (before it) her tier-1 skill
    //   (1041206 when ContemptPersonality is active) with a temporary skill ability.
    id: 1041203,
    summary: "N公司李箱“调整目标射击”前联动良秀出手",
    approx: "声明队友 10113 时假设其每回合使用一次 1011303；插入攻击的临时能力（描述：伤害-50%）未计入",
    onTurnStart(c) {
      if (!(c.allyIdentities?.() ?? []).some((a) => a.id === 10113)) return;
      const id = c.actor.getPotency("ContemptPersonality") > 0 ? 1041206 : 1041201;
      c.queueAction?.(id, { label: "联动出手", key: "1041203" });
    },
  },
  // PassiveAbility_1041211/1041201.OnSucceedAttack: once per enemy per turn, give GazeRyoshu (desc: 2, +1 with GazePersonality).
  {
    id: 1041211,
    summary: "命中时对目标施加2层[GazeRyoshu]（带[GazePersonality]时3层，每回合每名敌人1次）",
    approx: "消耗凝视获得[GazePersonality]、受击反伤未建模；施加层数按描述(2/3)取值",
    onCoinHit(c) {
      if (!takeTurn(c, "gaze", 1)) return;
      c.give("target", "GazeRyoshu", c.actor.getPotency("GazePersonality") > 0 ? 3 : 2, 0, 0);
    },
  },
  noDamagePassive(1041301, "队友濒死时反击；“喂，退下”追击暴击伤害+30%（临时能力，未计入）"),
  // PassiveAbility_1041302.ActiveSupportiveAttack: an ally's attack lands → cut in own tier-1 skill (with a temporary ability),
  //   _SUPPORTIVE_ATK_CNT_MAX 1 per round.
  {
    id: 1041302,
    summary: "队友命中后追加“喂，退下”攻击（每回合1次）",
    approx: "声明在场队友时假设其每回合命中，插入 1041301；临时能力（暴击伤害+30%）未计入",
    onTurnStart(c) {
      if (c.battle.allies.length) c.queueAction?.(1041301, { label: "喂，退下", key: "1041302" });
    },
  },
  // PassiveAbility_1041402.OnEndAttack: BulletGodok 0 → cut-in 1041405 (无尽的故事) then ReloadAndUseMp: UseMpDefault(10) +
  // TryAddBuff BulletGodok up to max (6).
  {
    id: 1041402,
    summary: "携带6发[BulletGodok]；攻击后弹药为0时完全装填至6发；条件满足时追加“砰。砰。”/“无尽的故事”攻击",
    approx: "“砰。砰。”(敌方理智<-40/混乱)未模拟；弹尽时追加“无尽的故事”(1041405)并装填，消耗10理智未计入",
    onSkillEnd(c) {
      if (c.actor.getPotency("BulletGodok") > 0) return;
      c.queueAction?.(1041405, { label: "无尽的故事", key: "1041402:empty" });
      c.give("actor", "BulletGodok", 6, 0);
      c.note("孤独弹药耗尽：完全装填至6发");
    },
  },
  // PassiveAbility_1041411/1041401: RightAfterAnyUnitGetAnyBuff(AlriuneEGOThey) → gain same AlriuneEGOWe; Sinking damage → +1;
  //   VibrationExplosion → +2. GetAttackDmgMultiplier vs staggered target: +They × 0.01.
  {
    id: 1041411,
    summary: "对敌施加[AlriuneEGOThey]时获得等量[AlriuneEGOWe]；沉沦伤害时+1层",
    approx: "对混乱目标伤害加成（不混乱）、30层使用“恍惚的终局”、震颤爆发获得层数、体力回复未建模；沉沦伤害按命中时目标带沉沦近似",
    coinMods(c) {
      c.state.set("sinkBefore", c.target.getCount("Sinking"));
      c.state.set("theyBefore", c.target.getPotency("AlriuneEGOThey"));
    },
    onCoinHit(c) {
      const dThey = c.target.getPotency("AlriuneEGOThey") - (c.state.get("theyBefore") ?? 0);
      let g = dThey > 0 ? dThey : 0;
      if ((c.state.get("sinkBefore") ?? 0) > 0) g += 1;
      if (g > 0) c.give("actor", "AlriuneEGOWe", g, 0, 0);
    },
  },
  // PassiveAbility_1041501.CalcDmgMul: default skill crit → min(0.10, (Breath stack − 20) × 0.01); OnSucceedAttack crit → PhantomIncisionID 1.
  {
    id: 1041501,
    summary: "基础攻击技能暴击伤害+(呼吸法强度−20)%(最多+10%)；暴击命中施加1层[PhantomIncisionID]",
    coinMods(c) {
      if (!c.isCritical || !isDefault(c)) return;
      const over = c.actor.getPotency("Breath") - 20;
      if (over > 0) return { dmg: Math.min(0.1, over * 0.01) };
    },
    onCoinHit(c) {
      if (c.isCritical && isDefault(c)) c.give("target", "PhantomIncisionID", 1, 0, 0);
    },
  },
  {
    id: 1041502,
    summary: "蜘蛛巢队友阵亡时获得[SojiRyoshuEchoPast]与额外效果；伤害转移；不死",
    approx: "依赖蜘蛛巢队友阵亡的全部效果未建模",
  },
  {
    id: 1041503,
    summary: "[PhantomIncisionTotalID]≥50时使用“空间斩-缘/残”",
    approx: "特殊技能使用/技能替换未模拟",
  },
  // PassiveAbility_1041504: round start GiveBuff_Giver(SojiRyoshuEchoFuture) to random enemy; default atk vs EchoFuture target →
  //   SkillPowerResultAdder +1, SuperCoin, gain 1 SojiRyoshuEchoPast (1/turn).
  {
    id: 1041504,
    summary: "回合开始对敌施加[SojiRyoshuEchoFuture]；对其使用基础攻击技能最终威力+1并获得1层[SojiRyoshuEchoPast](每回合1次)",
    approx: "“必然杀”插入攻击、超级硬币转换、阵亡队友增加目标数未建模",
    onTurnStart(c) {
      c.give("target", "SojiRyoshuEchoFuture", 1, 0, 0);
    },
    skillMods(c) {
      if (!isDefault(c) || c.target.getPotency("SojiRyoshuEchoFuture") <= 0) return;
      if (takeTurn(c, "past", 1)) c.gain("SojiRyoshuEchoPast", 1);
      return { finalPower: 1 };
    },
  },
  noDamagePassive(1041601, "震颤爆发混乱阈值前移加成；带护盾受击给予震颤"),
  // PassiveAbility_1041604: CalculateCoinScale (default skill): target Vibration ≥ 6 → +1; Charge(NoirAlly) stack ≥ 3 → +1.
  //   CalculateDmgMultiplier: stack × 2% (max 10%); skills 1041603 / 1041605 ×4% (max 20%).
  {
    id: 1041604,
    summary: "基础攻击技能：目标震颤≥6硬币威力+1；[ChargeNoirAlly]强度≥3硬币威力+1；伤害+强度×2%(最多10%，1041603/1041605为×4%最多20%)",
    approx: "回合结束转换护盾、基础技能额外充能层数、累计消耗10层+1强度未建模",
    skillMods(c) {
      if (!isDefault(c) || !c.skill) return;
      const charge = c.actor.getPotency("ChargeNoirAlly");
      let coinScale = 0;
      if (c.target.getPotency("Vibration") >= 6) coinScale += 1;
      if (charge >= 3) coinScale += 1;
      const special = c.skill.id === 1041603 || c.skill.id === 1041605;
      const dmg = special ? Math.min(0.2, charge * 0.04) : Math.min(0.1, charge * 0.02);
      return { coinScale, dmg };
    },
  },
  noDamagePassive(1050101, "战斗开始体力<50%获得守护"),
  // PassiveAbility_1050401: OnBattleStart, HP ratio < 0.5 → AssemblePersonality 1, Enhancement 1, Protection 3 (+ cleanse 1 negative).
  {
    id: 1050401,
    summary: "战斗开始时若体力低于50%，获得1层狂信、1层强壮(最终威力+1)与3层守护",
    approx: "解除负面状态未建模",
    onBattleStart(c) {
      if (c.battle.lostHpPct <= 50) return;
      c.give("actor", "AssemblePersonality", 1, 0, 0);
      c.give("actor", "Enhancement", 1, 0, 0);
      c.give("actor", "Protection", 3, 0, 0);
    },
  },
  noDamagePassive(1050611, "按充能提高最大速度与挑衅值"),
  // PassiveAbility_1050701.GetSkillPowerResultAdder: target HasActivatedBuff(RetaliationBook) → +1.
  {
    id: 1050711,
    summary: "主要目标带[RetaliationBook]时最终威力+1",
    approx: "报复对象需目标本回合对友方造成伤害（目标不攻击时不会获得）；中指队友理智回复未建模",
    skillMods: (c) => (c.target.getPotency("RetaliationBook") > 0 ? { finalPower: 1 } : undefined),
  },
  {
    id: 1050802,
    summary: "剑契组队友阵亡≥3/5时额外获得呼吸法",
    approx: "依赖队友阵亡，未建模",
  },
  // PassiveAbility_1050803 (HiddenAdditionalKeywordOnEquipEgo).OnSucceedAttack: default skill (incl. defense) + required EGO equipped →
  //   GiveBuff_Giver(Laceration, stack 2), once per skill.
  {
    id: 1050803,
    summary: "（隐藏）装备特定E.G.O时，基础技能命中对目标施加2层流血强度(每技能1次)",
    approx: "假定已装备所需E.G.O",
    onCoinHit(c) {
      if (!isDefault(c) || c.state.get("lacThisSkill")) return;
      c.state.set("lacThisSkill", 1);
      c.give("target", "Laceration", 2, 0, 0);
    },
    onSkillEnd(c) {
      c.state.delete("lacThisSkill");
    },
  },
  noDamagePassive(1050811, "不死与给予剑契组队友呼吸法"),
  noDamagePassive(1051001, "队友丢弃技能时获得自习层数/伤害强化（丢弃未模拟）"),
];

registerPassives(...handlers);
