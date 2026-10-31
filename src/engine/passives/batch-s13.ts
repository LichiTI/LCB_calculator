/** Script/status batch 13 — see data/il2cpp/dossiers/scripts-13.md */
import { triggerLacerationOnAttackCoinToss, triggerVibrationExplosion, type StatusContainer } from "../status";
import { noDamageAbility, noDamageScript, registerAbilities, registerScripts, type ScriptCtx, type ScriptData } from "./framework";

// Already handled elsewhere (not re-registered here):
//  - GiveBuffOnSucceedAttackIfHasStack_TiedRopeHonglu1 → batch-s03 RegExp GiveBuffOnSucceedAttackIfHasStack_<kw><n>
//  - ScratchesHurtID / GiveBuffOnRoundStart → batch-s04; DianxueHongLu / DianxueMark → batch-s06

type BD = NonNullable<ScriptData["buffData"]>;

const bdOf = (c: ScriptCtx): BD => c.script.buffData ?? {};
/** AbilityBase.GetSingleUnit(buffOwner): "Self" → actor, otherwise main target. */
const owner = (c: ScriptCtx, bd: BD | undefined): StatusContainer => (bd?.buffOwner === "Self" ? c.actor : c.target);
const has = (s: StatusContainer, kw: string): boolean => {
  const st = s.get(kw);
  return !!st && (st.potency > 0 || st.count > 0);
};
/** BasicBuff.GiveBuff with buffData. */
function giveBD(c: ScriptCtx, bd: BD | undefined, stack = bd?.stack ?? 0, turn = bd?.turn ?? 0): void {
  if (!bd?.buffKeyword || (stack <= 0 && turn <= 0)) return;
  c.give(bd.target === "Self" ? "actor" : "target", bd.buffKeyword, stack, turn, bd.activeRound === 1 ? 1 : 0);
}
const hpRatio = (c: ScriptCtx): number => 1 - c.battle.lostHpPct / 100;
const isLastCoin = (c: ScriptCtx): boolean => c.skill != null && (c.coinIndex ?? -1) === c.skill.coinCount - 1;

registerScripts(
  // SkillAbility_RingFingerBodyOnUseBuffTier3Shared: Charge count ≥ bd.turn(10) → use min(count, limit 20);
  // final power +Round(jsonValue); dmg +used × bd.value(1%); ChargeBodyArt ≥3/≥5 → targets +1/+2, coins → SuperCoin.
  {
    name: "RingFingerBodyOnUseBuffTier3Shared",
    summary: "充能不低于10层时消耗至多20层：最终威力+2，每消耗1层伤害+1%",
    approx: "体术充能强度≥3/≥5时攻击容量+1/+2（按注释所述阈值）",
    skillMods(c) {
      const bd = bdOf(c);
      const kw = bd.buffKeyword ?? "Charge";
      const cnt = c.actor.getCount(kw);
      if (cnt < (bd.turn ?? 0) || cnt <= 0) return;
      const use = (bd.limit ?? 0) > 0 ? Math.min(cnt, bd.limit!) : cnt;
      c.consume("actor", kw, use);
      const art = c.actor.getPotency("ChargeBodyArt");
      if (art >= 3) c.addAttackWeight?.(art >= 5 ? 2 : 1);
      // IsOverWriteToSuperCoin() = true → OverwriteToSuperCoin: every coin → SuperCoin (clash-only).
      c.coins?.makeSuper("all");
      return { finalPower: Math.round(c.script.value ?? 0), dmg: use * (bd.value ?? 0) };
    },
  },
  // CoinAbility_ActiveBuffOnSucceedAttackRerollCoin10615: on the reused coin → BuffDetail.ForceToActivateSinBuffEffect(Laceration).
  {
    name: "ActiveBuffOnSucceedAttackRerollCoin10615",
    summary: "重复使用的硬币命中时：触发目标的流血（层数-1）",
    onCoinHit(c) {
      if (!c.isRerolled) return;
      const rec = triggerLacerationOnAttackCoinToss(c.target, c.turn, "强制触发流血");
      if (rec && rec.hpDamage > 0) c.extraDamage(rec.hpDamage, "强制触发流血（层数-1）");
    },
  },
  // CoinAbility_GiveBuffOnSucceedAttackRerollCoin10615: on the reused coin → GiveBuff_BySkillCoin(buffData) (Agility 2 next turn).
  {
    name: "GiveBuffOnSucceedAttackRerollCoin10615",
    summary: "重复使用的硬币命中时：下回合自身获得2层[Agility]",
    onCoinHit(c) {
      if (c.isRerolled) giveBD(c, bdOf(c));
    },
  },
  // (self Breath + target Laceration) / bd.stack(6) × bd.value(1), max bd.limit(2) coin power.
  {
    name: "CoinScaleAdderOnStartTurnDivideBySumOfSelfAndTargetBuffStack10615_Breath_Laceration",
    summary: "自身呼吸法强度与目标流血强度之和每6级，硬币威力+1（最多+2）",
    skillMods(c) {
      const bd = bdOf(c);
      const sum = c.actor.getPotency("Breath") + c.target.getPotency("Laceration");
      const div = bd.stack ?? 6;
      const v = Math.min(Math.floor(sum / div) * (bd.value ?? 1), bd.limit ?? 2);
      return v > 0 ? { coinScale: v } : undefined;
    },
  },
  // CoinAbility_GiveBuffOnSucceedAttackIfNotHas: target lacks keyword(TiedRopeHonglu) → give buffData.
  {
    name: "GiveBuffOnSucceedAttackIfNotHas_TiedRopeHonglu",
    summary: "命中时若目标未带有[TiedRopeHonglu]，则对其施加",
    onCoinHit(c) {
      const bd = bdOf(c);
      if (!has(c.target, "TiedRopeHonglu")) giveBD(c, bd);
    },
  },
  // SkillAbility_GiveBuffOnSucceedAttackLastCoinViaOnUseBuffCheck10615: at use target has TiedRopeHonglu → last coin hit gives buffData.
  {
    name: "GiveBuffOnSucceedAttackLastCoinViaOnUseBuffCheck10615_TiedRopeHonglu",
    summary: "使用时目标带有[TiedRopeHonglu]：最后一枚硬币命中时施加效果（流血层数/下回合守护）",
    skillMods(c) {
      c.action.shared.set("tied10615", has(c.target, "TiedRopeHonglu"));
    },
    onCoinHit(c) {
      if (!isLastCoin(c)) return;
      if (c.action.shared.get("tied10615") !== true) return;
      giveBD(c, bdOf(c));
    },
  },
  // SkillAbility_CoinScaleAdderDivideBySpeedDiff1061602: speed diff ≥ 2 → min(diff/2 × 1, 2).
  {
    name: "CoinScaleAdderDivideBySpeedDiff1061602",
    summary: "速度高于目标时每差2点硬币威力+1（最多+2）",
    skillMods(c) {
      const diff = c.battle.selfSpeed - c.battle.targetSpeed;
      if (diff < 2) return;
      return { coinScale: Math.min(Math.floor(diff / 2), 2) };
    },
  },
  // SkillAbility_CoinScaleAdderOSTViaBuffCheckDivideByStackWithLimitAndSelfBreathStack<limit>:
  // (target Combustion + self Breath) / bd.stack × IntegerValue, max <limit>.
  {
    name: "CoinScaleAdderOSTViaBuffCheckDivideByStackWithLimitAndSelfBreathStack1",
    summary: "目标烧伤强度与自身呼吸法强度之和每6级硬币威力+1（最多+1）",
    skillMods(c) {
      const bd = bdOf(c);
      const kw = bd.buffKeyword ?? "Combustion";
      const sum = owner(c, bd).getPotency(kw) + c.actor.getPotency("Breath");
      const div = bd.stack ?? 6;
      if (sum < div) return;
      return { coinScale: Math.min(Math.floor(sum / div) * (bd.value ?? 1), 1) };
    },
  },
  // CoinAbility_GiveAdditionalAttributeDmgOnSucceedAttackByDuplicateStackRatioIfRerollCoin_<sin>:
  // reused coin → Trunc(finalDmg × min(target stack × bd.value, bd.limit × 0.01)) attribute HP damage.
  {
    name: "GiveAdditionalAttributeDmgOnSucceedAttackByDuplicateStackRatioIfRerollCoin_CRIMSON",
    summary: "重复使用的硬币命中时：追加本硬币伤害×(目标烧伤强度×2)%的暴怒伤害（最多40%）",
    onCoinHit(c) {
      if (!c.isRerolled) return;
      const bd = bdOf(c);
      const ratio = Math.min(c.target.getPotency(bd.buffKeyword ?? "Combustion") * (bd.value ?? 0.02), (bd.limit ?? 40) * 0.01);
      const dmg = Math.trunc((c.lastHitDamage ?? 0) * ratio);
      if (dmg > 0) c.extraDamage(dmg, "暴怒追加伤害", { sin: "CRIMSON" });
    },
  },
  // CoinAbility_GiveBuffOnSucceedAttackByDuplicateStackIfRerollCoin_<kw>: reused coin → give buff with stack = target <kw> stack (1/turn).
  {
    name: "GiveBuffOnSucceedAttackByDuplicateStackIfRerollCoin_DianxueHongLu",
    summary: "重复使用的硬币命中时：施加层数等同目标[DianxueHongLu]层数的[DefenseDown]（每回合1次）",
    onCoinHit(c) {
      if (!c.isRerolled) return;
      const key = `dupDianxue:${c.turn}`;
      if (c.state.get(key)) return;
      const n = c.target.getPotency("DianxueHongLu");
      if (n <= 0) return;
      c.state.set(key, 1);
      giveBD(c, bdOf(c), n, 0);
    },
  },
  // SkillAbility_SkillPowerResultAdderOnSTViaSumOfBreathAndBuffDivide: (self Breath + target bd kw) / bd.stack × value, max bd.limit.
  {
    name: "SkillPowerResultAdderOnSTViaSumOfBreathAndBuffDivide",
    summary: "自身呼吸法强度与目标烧伤强度之和每6级最终威力+1（最多+1）",
    skillMods(c) {
      const bd = bdOf(c);
      const sum = c.actor.getPotency("Breath") + owner(c, bd).getPotency(bd.buffKeyword ?? "Combustion");
      const v = Math.min(Math.floor(sum / (bd.stack ?? 6)) * (bd.value ?? 1), bd.limit ?? 1);
      return v > 0 ? { finalPower: v } : undefined;
    },
  },
  // CoinAbility_1070103_1: heads hit → AffectNextCoin, next coin power +2.
  {
    name: "1070103_1",
    summary: "正面命中时本技能下一枚硬币威力+2",
    onCoinHit(c) {
      if (c.isHeads) c.nextCoin.addPower(2);
    },
  },
  // CoinAbility_1070203_1: OnStartCoin lose 5 HP; this coin dmg +50%.
  {
    name: "1070203_1",
    summary: "攻击前失去5点体力，本硬币伤害+50%",
    approx: "自身失去体力未计入",
    coinMods: () => ({ dmg: 0.5 }),
  },
  {
    name: "SkillPowerResultAdder2IfSelfHpRatioLessThan50",
    summary: "自身体力低于50%时最终威力+2",
    skillMods: (c) => (hpRatio(c) < 0.5 ? { finalPower: 2 } : undefined),
  },
  // [necessary:Bullet:1]: consume 1 Bullet when the coin is used.
  {
    name: "Empty[necessary:Bullet:1]",
    summary: "掷出硬币时消耗1发弹药；弹药不足时硬币不发动",
    beforeCoin(c) {
      if (c.actor.getPotency("Bullet") <= 0) c.cancelCoin("弹药不足（[necessary:Bullet:1]）");
    },
    coinMods(c) {
      if (c.actor.getPotency("Bullet") <= 0) return void c.note(`硬币${(c.coinIndex ?? 0) + 1}缺少弹药：实际不会发动`);
      c.lose("actor", "Bullet", 1);
    },
  },
  {
    name: "GiveBuffOnSucceedAttack[necessary:Bullet:1]",
    summary: "掷出硬币时消耗1发弹药；命中时施加效果；弹药不足时硬币不发动",
    beforeCoin(c) {
      if (c.actor.getPotency("Bullet") <= 0) c.cancelCoin("弹药不足（[necessary:Bullet:1]）");
    },
    coinMods(c) {
      if (c.actor.getPotency("Bullet") <= 0) return void c.note(`硬币${(c.coinIndex ?? 0) + 1}缺少弹药：实际不会发动`);
      c.lose("actor", "Bullet", 1);
    },
    onCoinHit(c) {
      giveBD(c, bdOf(c));
    },
  },
  // CoinAbility_GiveAdditionalDmgOnSuccessAttackTargetHead<N>: heads hit → extra N% of coin damage.
  {
    name: "GiveAdditionalDmgOnSuccessAttackTargetHead10",
    summary: "正面命中时追加本硬币伤害10%的伤害",
    onCoinHit(c) {
      if (!c.isHeads) return;
      const dmg = Math.trunc((c.lastHitDamage ?? 0) * 0.1);
      if (dmg > 0) c.extraDamage(dmg, "追加伤害10%");
    },
  },
  // CoinAbility_1070502_4: OnStartCoin Sinking ≥ 5 → UseBuffStack(Sinking, 5), coin dmg +20%.
  {
    name: "1070502_4",
    summary: "消耗5级沉沦强度，本硬币伤害+20%",
    approx: "按消耗目标的沉沦处理（ISIL未明确所属单位）",
    coinMods(c) {
      if (c.target.getPotency("Sinking") < 5) return;
      c.lose("target", "Sinking", 5);
      return { dmg: 0.2 };
    },
  },
  {
    name: "SkillPowerResultAdderOnUse2IfSelfMpLessThanMinus25",
    summary: "理智值低于-25时最终威力+2",
    skillMods: (c) => (c.actorSp < -25 ? { finalPower: 2 } : undefined),
  },
  {
    name: "SkillPowerResultAdderOnUse3IfSelfMpLessThanMinus15",
    summary: "理智值低于-15时最终威力+3",
    skillMods: (c) => (c.actorSp < -15 ? { finalPower: 3 } : undefined),
  },
  {
    name: "VibrationExplosionOnSucceedAttackTail",
    summary: "反面命中时使目标震颤引爆",
    onCoinHit(c) {
      if (c.isHeads) return;
      const rec = triggerVibrationExplosion(c.target, c.turn, "震颤引爆");
      if (!rec) return;
      if (rec.hpDamage > 0) c.extraDamage(rec.hpDamage, "震颤引爆");
      else c.note(`震颤引爆：混乱阈值前移 ${rec.staggerShift}`);
    },
  },
  noDamageScript("1070603_4", "击杀时对破裂层数最低的敌人施加2层破裂"),
  // CoinAbility_1070702_2: critical hit → give Laceration turn = min(Round(potency/3), 10).
  {
    name: "1070702_2",
    summary: "暴击命中时施加目标流血强度1/3的流血层数（最多10层）",
    onCoinHit(c) {
      if (!c.isCritical) return;
      const n = Math.min(Math.round(c.target.getPotency("Laceration") / 3), 10);
      if (n > 0) c.give("target", "Laceration", 0, n);
    },
  },
  {
    name: "CoinScaleAdder1IfARNotLessThan_VIOLET4",
    summary: "嫉妒共鸣数不低于4时硬币威力+1",
    skillMods: (c) => ((c.battle.resonance.VIOLET ?? 0) >= 4 ? { coinScale: 1 } : undefined),
  },
  {
    name: "CoinScaleAdder1IfPRSumNotLessThan_VIOLET6",
    summary: "嫉妒完全共鸣数之和不低于6时硬币威力+1",
    approx: "完全共鸣按最高完全共鸣长度判断（未区分罪孽属性与多段之和）",
    skillMods: (c) => (c.battle.perfectResonance >= 6 ? { coinScale: 1 } : undefined),
  },
  {
    name: "GiveBuffOnSucceedAttackIfSelfHpRatioLessThan50",
    summary: "体力低于50%时命中额外施加1级流血强度",
    onCoinHit(c) {
      if (hpRatio(c) < 0.5) giveBD(c, bdOf(c));
    },
  },
  {
    name: "GiveBuffOnSucceedAttackIfSelfHpRatioLessThan75",
    summary: "体力低于75%时命中额外施加1级流血强度",
    onCoinHit(c) {
      if (hpRatio(c) < 0.75) giveBD(c, bdOf(c));
    },
  },
  // SkillAbility_GiveBuffOnUsePerBuffStack_<kw><div>_Limit<n>: owner <kw> stack / div × bd.stack, max n → GiveBuff.
  {
    name: "GiveBuffOnUsePerBuffStack_Laceration3_Limit10",
    summary: "使用时目标流血强度每3级，自身获得1级呼吸法强度（最多10）",
    skillMods(c) {
      const bd = bdOf(c);
      const n = Math.min(Math.floor(owner(c, bd).getPotency("Laceration") / 3) * (bd.stack ?? 1), 10);
      if (n > 0) giveBD(c, bd, n, 0);
    },
  },
  // CoinAbility_SwitchVibrationOnSucceedAttackViaVibrationSumOfStackAndTurn: Vibration stack + turn ≥ value → convert.
  {
    name: "SwitchVibrationOnSucceedAttackViaVibrationSumOfStackAndTurn",
    summary: "命中时目标震颤强度与层数之和不低于20：震颤转换为[VibrationCollapse]",
    onCoinHit(c) {
      const bd = bdOf(c);
      const to = bd.buffKeyword ?? "VibrationCollapse";
      const th = Math.round(c.script.value ?? bd.value ?? 20);
      if (c.target.getPotency("Vibration") + c.target.getCount("Vibration") < th) return;
      if (c.target.convert("Vibration", to)) c.note(`震颤转换为${to}`);
    },
  },
);

registerAbilities(noDamageAbility("GoldenOpportunity", "回合开始时若子辈浮士德在场获得2层守护"));
