/** Script/status batch 03 — see data/il2cpp/dossiers/scripts-03.md */
import { replaceIfBuff } from "./skill-replace";
import {
  noDamageAbility,
  noDamageScript,
  registerAbilities,
  registerScripts,
  type AbilityCtx,
  type PassiveCtx,
  type ScriptCtx,
} from "./framework";
import type { StatusContainer } from "../status";

const side = (c: PassiveCtx, owner: string | undefined): StatusContainer => (owner === "Target" ? c.target : c.actor);
/** GetSingleUnit(buffOwner): any "*Target" owner (Target, AbnormalityTarget, MainTarget…) resolves to the target. */
const ownerSide = (c: PassiveCtx, owner: string | undefined): StatusContainer => (owner && /Target$/.test(owner) ? c.target : c.actor);
/** Stack ≥ n; presence counts as 1 stack (TypoOnly markers may carry no potency). */
const stackAtLeast = (s: StatusContainer, kw: string, n: number) => s.getPotency(kw) >= n || (n <= 1 && has(s, kw));
const speedDiff = (c: PassiveCtx) => c.battle.selfSpeed - c.battle.targetSpeed;
const has = (s: StatusContainer, id: string) => s.get(id) !== undefined;

/** IndexUtility.GetUnlockRank: buff ids 1340/1339/1338/1337 → 4/3/2/1 (UnlockBuff_3/_2/_1/_Base; Ally variants treated alike). */
function unlockRank(s: StatusContainer): number {
  if (has(s, "UnlockBuff_3") || has(s, "UnlockBuffAlly_3")) return 4;
  if (has(s, "UnlockBuff_2") || has(s, "UnlockBuffAlly_2")) return 3;
  if (has(s, "UnlockBuff_1") || has(s, "UnlockBuffAlly_1")) return 2;
  if (has(s, "UnlockBuff_Base")) return 1;
  return 0;
}
/** The "IndexPrescriptTargetMarkToEnemy" system ability lives on the action; approximated by the target carrying the Index mark. */
const indexMarked = (c: PassiveCtx) => has(c.target, "IndexPrescriptTargetToEnemy") || has(c.target, "IndexPrescriptTargetMarkToEnemy");
const INDEX_MARK_APPROX = "技能是否被[IndexPrescriptTargetMarkToEnemy]标记按目标带有指令对象近似";

/** BUFF_CATEGORY_KEYWORD.BURSTREACTIVE members (core.json buffs). */
const BURST_REACTIVE = ["BurstAgility", "BurstPoison", "BurstStop", "BurstSuppress", "BurstWave", "BurstWeakness", "BurstZilu"];
const hasBurstReactive = (s: StatusContainer) => BURST_REACTIVE.some((id) => has(s, id));

/** Identities with association INDEX_FINGER (core.json identities). */
const INDEX_FINGER_IDS = new Set([10115, 10214, 10314]);

/** CoinAbility_GiveBuffOnSucceedAttack-style give using the script's buffData. */
function giveFromData(c: ScriptCtx, stackOverride?: number) {
  const bd = c.script.buffData;
  if (!bd?.buffKeyword) return;
  c.give(bd.target === "Self" ? "actor" : "target", bd.buffKeyword, stackOverride ?? bd.stack ?? 0, bd.turn ?? 0, bd.activeRound === 1 ? 1 : 0);
}

/** Once-per-skill latch for coin effects (reset in onSkillEnd). */
function oncePerSkill(c: ScriptCtx, key: string): boolean {
  if (c.state.get(key)) return false;
  c.state.set(key, 1);
  return true;
}

registerScripts(
  // CoinAbility_OverwriteResist1011303.OnStartCoin: only when the main target is an ally → overwrite PENETRATE resist.
  noDamageScript("OverwriteResist1011303", "主要目标为友方时改写突刺抗性"),
  // SkillAbility_SkillPowerAdderOnUseViaBuffCheckDevideByTurnWithLimit<N>.GetPowerAdder:
  //   CheckCondition(stack ≥ bd.stack, turn ≥ bd.turn) → min(N, floor(turn / bd.turn) × bd.value) base power.
  {
    name: /^SkillPowerAdderOnUseViaBuffCheckDevideByTurnWithLimit(\d+)$/,
    summary: "按[buffKeyword]层数每满turn层基础威力+value(上限见脚本名)",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const limit = Number(/(\d+)$/.exec(c.script.scriptName)?.[1] ?? 0);
      const s = side(c, bd.buffOwner);
      const cnt = s.getCount(bd.buffKeyword);
      const per = bd.turn && bd.turn > 0 ? bd.turn : 1;
      if (cnt < per || s.getPotency(bd.buffKeyword) < (bd.stack ?? 0)) return;
      const v = Math.min(limit, Math.floor(cnt / per) * (bd.value ?? 1));
      if (v > 0) return { basePower: v };
    },
  },
  // SkillAbility_UseBuff1011303.OnEndBehaviour: if BoseProjektil was at bd.stack (7) at use → consume all (+SP heal value).
  {
    name: "UseBuff1011303",
    summary: "技能开始时[BoseProjektil]为7层则技能结束时消耗全部",
    approx: "理智值回复未建模",
    skillMods(c) {
      const bd = c.script.buffData;
      c.state.set("bose7", c.actor.getPotency(bd?.buffKeyword ?? "BoseProjektil") >= (bd?.stack ?? 7) ? 1 : 0);
    },
    onSkillEnd(c) {
      const kw = c.script.buffData?.buffKeyword ?? "BoseProjektil";
      if (c.state.get("bose7")) c.lose("actor", kw, c.actor.getPotency(kw));
      c.state.delete("bose7");
    },
  },
  // SkillAbility_AttackDmgUp1011402: CheckCondition = speedDiff ≥ value && buff stack ≥ bd.stack;
  //   dmg = floor(stack / bd.stack) × bd.value, capped at bd.limit %.
  {
    name: "AttackDmgUp1011402",
    summary: "速度高于目标至少value点时，伤害+([BreakthroughHorse]层数×20)%(上限limit%)",
    // timing audit: GetAttackDmgMultiplier → CheckCondition/GetDmgMultiplier on every hit (no OnStartTurn latch) → per coin
    coinMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword || speedDiff(c) < (c.script.value ?? 0)) return;
      const st = side(c, bd.buffOwner).getPotency(bd.buffKeyword);
      const div = bd.stack && bd.stack > 0 ? bd.stack : 1;
      if (st < div) return;
      let v = Math.floor(st / div) * (bd.value ?? 0);
      if (bd.limit && bd.limit > 0) v = Math.min(v, bd.limit * 0.01);
      if (v > 0) return { dmg: v };
    },
  },
  // SkillAbility_AttackDmgUpPerShieldIfShieldNotLessThanValue.GetDmgMultiplier: TotalShield ≥ value → min(shield × bd.value, bd.limit%).
  {
    name: "AttackDmgUpPerShieldIfShieldNotLessThanValue",
    summary: "按自身护盾量提高伤害(护盾×2%，最多50%)",
    approx: "引擎未建模护盾，按护盾0计算",
  },
  // SkillAbility_CoinScaleAdderOnSTViaBurstAndBuffCheck.CheckDivide: (owner's bd.buffKeyword stack + Burst stack) / bd.stack ≥ 1 → +bd.value coin power.
  {
    name: "CoinScaleAdderOnSTViaBurstAndBuffCheck",
    summary: "目标[Burst]与指定状态强度之和不低于stack时硬币威力+value",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const s = side(c, bd.buffOwner);
      const sum = s.getPotency(bd.buffKeyword) + s.getPotency("Burst");
      if (sum >= (bd.stack ?? 1)) return { coinScale: bd.value ?? 1 };
    },
  },
  // SkillAbility_CoinScaleAdderOnSTViaBurstAndBuffDivide.CalculateCoinScaleAdder: value × floor(sum / stack), capped by limit.
  {
    name: "CoinScaleAdderOnSTViaBurstAndBuffDivide",
    summary: "目标[Burst]与指定状态强度之和每满stack级硬币威力+value(上限limit)",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword || !bd.stack) return;
      const s = side(c, bd.buffOwner);
      let v = Math.floor((s.getPotency(bd.buffKeyword) + s.getPotency("Burst")) / bd.stack) * (bd.value ?? 1);
      if (bd.limit && bd.limit > 0) v = Math.min(v, bd.limit);
      if (v > 0) return { coinScale: v };
    },
  },
  // CoinAbility_GiveBuffOnSAIfTargetHasBurstReactive: on hit, target has a BURSTREACTIVE-category buff → give buffData.
  {
    name: "GiveBuffOnSAIfTargetHasBurstReactive",
    summary: "命中时若目标带有咒杀类(BURSTREACTIVE)状态则施加指定状态",
    onCoinHit(c) {
      if (hasBurstReactive(c.target)) giveFromData(c);
    },
  },
  {
    name: "GiveBuffOnSAIfTargetNotHasBurstReactive",
    summary: "命中时若目标未带有咒杀类(BURSTREACTIVE)状态则施加指定状态",
    onCoinHit(c) {
      if (!hasBurstReactive(c.target)) giveFromData(c);
    },
  },
  // SkillAbility_GiveBuffOnSucceedAttackIfHasStack_<Kw><N>: self <Kw> stack ≥ N → give buffData on hit.
  {
    name: /^GiveBuffOnSucceedAttackIfHasStack_([A-Za-z]+?)(\d+)$/,
    summary: "命中时若buffOwner(自身/目标)的指定状态不低于N层则施加指定状态",
    onCoinHit(c) {
      const m = /^GiveBuffOnSucceedAttackIfHasStack_([A-Za-z]+?)(\d+)$/.exec(c.script.scriptName);
      // SkillAbility_GiveBuffOnSucceedAttackIfHasStack.OnSucceedAttack: GetSingleUnit(buffData.buffOwner).GetActivatedBuffStack(<Kw>) ≥ N.
      if (m && stackAtLeast(ownerSide(c, c.script.buffData?.buffOwner), m[1] ?? "", Number(m[2]))) giveFromData(c);
    },
  },
  // CoinAbility_GiveBuffOnSucceedAttackSetStackAsValueIfHasStack_<Kw><N>: give buffData; stack becomes bd.value if self <Kw> ≥ N.
  {
    name: /^GiveBuffOnSucceedAttackSetStackAsValueIfHasStack_([A-Za-z]+?)(\d+)$/,
    summary: "命中时施加指定状态；自身指定状态不低于N层时层数改为value",
    onCoinHit(c) {
      const m = /^GiveBuffOnSucceedAttackSetStackAsValueIfHasStack_([A-Za-z]+?)(\d+)$/.exec(c.script.scriptName);
      const boosted = m !== null && stackAtLeast(ownerSide(c, c.script.buffData?.buffOwner), m[1] ?? "", Number(m[2]));
      giveFromData(c, boosted ? c.script.buffData?.value : undefined);
    },
  },
  {
    // SkillAbility_SpecialSkill1011403.OnBeforeTurn: self BreakthroughHorse ≥ 5 → ChangeSkill(1011405), then UseBuffAllStack(BreakthroughHorse).
    name: "SpecialSkill1011403",
    summary: "[BreakthroughHorse]为5层时消耗全部并改为使用“黑风马蹄月斩”(1011405)",
    approx: "条件在技能执行时检查（游戏为回合开始前 OnBeforeTurn）",
    beforeUse(c) {
      if (replaceIfBuff(c, 1011405, { reason: "[BreakthroughHorse]≥5" })) c.lose("actor", "BreakthroughHorse", c.actor.getPotency("BreakthroughHorse"));
    },
  },
  // SkillAbility_AttackDmgUpByIndexUnlockRankWithLimit<N>.CalcDmgMul: min(rank × value, N%).
  {
    name: /^AttackDmgUpByIndexUnlockRankWithLimit(\d+)$/,
    summary: "[UnlockBuff_Base]每有1阶段伤害+value(上限见脚本名)",
    approx: "解锁阶段按UnlockBuff_Base/1/2/3(含Ally版本)=1/2/3/4推断",
    coinMods(c) {
      const limit = Number(/(\d+)$/.exec(c.script.scriptName)?.[1] ?? 0) * 0.01;
      const v = Math.min(limit, unlockRank(c.actor) * (c.script.value ?? 0));
      if (v > 0) return { dmg: v };
    },
  },
  // SkillAbility_AttackDmgUpIndexMark: action.HasSystemAbility(mark) → +value dmg.
  {
    name: "AttackDmgUpIndexMark",
    summary: "本技能被指令标记时伤害+value",
    approx: INDEX_MARK_APPROX,
    skillMods: (c) => (indexMarked(c) ? { dmg: c.script.value ?? 0 } : undefined),
  },
  // Class not resolved; per desc: (self Breath potency + target Sinking potency) per <div> → +1 coin power, max <limit>.
  {
    name: /^CoinScaleAdderViaMyBreathYourSinking_div(\d+)_limit(\d+)$/,
    summary: "自身呼吸法强度与目标沉沦强度之和每满div级硬币威力+1(上限limit)",
    approx: "类未解析，按描述实现",
    // timing audit: SkillAbility_CoinScaleAdderViaMyBreathYourSinking.GetCoinScaleAdder → CalculateResultAdder each query → per coin
    coinMods(c) {
      const m = /_div(\d+)_limit(\d+)$/.exec(c.script.scriptName);
      if (!m) return;
      const v = Math.min(Number(m[2]), Math.floor((c.actor.getPotency("Breath") + c.target.getPotency("Sinking")) / Number(m[1])));
      if (v > 0) return { coinScale: v };
    },
  },
  // SkillAbility_DmgMul10115IfAtkType: weapon case (ScriptsFor1347.GetWeaponCase) == atk type in name → +value.
  //   Weapon is provided with (75 − Karma/2)% chance (WeaponFor10115_base75_karmaDiv2) → expected value used.
  {
    name: /^DmgMul10115IfAtkType_(SLASH|PENETRATE|HIT)$/,
    summary: "使用对应武器的硬币伤害+value（按提供武器概率取期望）",
    approx: "武器为随机提供：按(75−[KarmaOfIndexAlly]/2)%概率取期望值",
    coinMods(c) {
      const p = Math.max(0, Math.min(1, (75 - Math.floor(c.actor.getPotency("KarmaOfIndexAlly") / 2)) / 100));
      const v = (c.script.value ?? 0) * p;
      if (v > 0) return { dmg: v };
    },
  },
  // SkillAbility_GiveBuffOnUseAddStackByIndexUnlockRank: on use give buffData with stack += rank × value.
  {
    name: "GiveBuffOnUseAddStackByIndexUnlockRank",
    summary: "使用时获得指定状态，强度额外+解锁阶段×value",
    approx: "解锁阶段按UnlockBuff_Base/1/2/3(含Ally版本)=1/2/3/4推断",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const stack = (bd.stack ?? 0) + unlockRank(c.actor) * (bd.value ?? 0);
      c.give(bd.target === "Target" ? "target" : "actor", bd.buffKeyword, stack, bd.turn ?? 0, bd.activeRound === 1 ? 1 : 0);
    },
  },
  // SkillAbility_SkillPowerResultAdderIndexMark: marked → +round(value) final power.
  {
    name: "SkillPowerResultAdderIndexMark",
    summary: "本技能被指令标记时最终威力+value",
    approx: INDEX_MARK_APPROX,
    skillMods: (c) => (indexMarked(c) ? { finalPower: Math.round(c.script.value ?? 0) } : undefined),
  },
  {
    name: "WeaponFor10115_base75_karmaDiv2",
    summary: "以(75−[KarmaOfIndexAlly]/2)%概率提供武器",
    approx: "类未解析；武器伤害加成由DmgMul10115IfAtkType_*按期望计算，武器改变攻击类型(抗性)未建模",
  },
  // SkillAbility_CoinScaleAdderViaBuffCheck1011603_<min>_<max>_<div>: Charge count in [min, max) → +floor(count/div) coin power (≤ value), consume all Charge count.
  {
    name: /^CoinScaleAdderViaBuffCheck1011603_(\d+)_(\d+)_(\d+)$/,
    summary: "充能层数在区间内时消耗全部，每div层硬币威力+1(上限value)",
    skillMods(c) {
      const m = /_(\d+)_(\d+)_(\d+)$/.exec(c.script.scriptName);
      if (!m) return;
      const cnt = c.actor.getCount("Charge");
      if (cnt < Number(m[1]) || cnt >= Number(m[2])) return;
      c.consume("actor", "Charge", cnt);
      const v = Math.min(c.script.value ?? 0, Math.floor(cnt / Number(m[3])));
      if (v > 0) return { coinScale: v };
    },
  },
  // CoinAbility_GiveAdditionalSlashDmgByChargeStack.GetRatio: min(Charge stack × value, value × 5); OnSucceedAttack deals trunc(finalDmg × ratio) slash.
  {
    name: "GiveAdditionalSlashDmgByChargeStack",
    summary: "命中后追加本硬币最终伤害×(充能强度×value)的斩击伤害(上限value×5)",
    onCoinHit(c) {
      const v = c.script.value ?? 0;
      const ratio = Math.min(c.actor.getPotency("Charge") * v, v * 5);
      const dmg = Math.trunc((c.lastHitDamage ?? 0) * ratio);
      if (dmg > 0) c.extraDamage(dmg, `充能追加斩击伤害 ${dmg}`, { atkType: "SLASH" });
    },
  },
  // CoinAbility_GiveBuffOnSucceedAttack1011601: give buffData (Charge 6 count) on hit, once per skill (limit 1).
  //   Coin-scope onSkillEnd is not run by the simulator, so the latch is reset on the coin's non-rerolled pass.
  {
    name: "GiveBuffOnSucceedAttack1011601",
    summary: "命中时获得6层充能(每技能1次)",
    coinMods(c) {
      if (!c.isRerolled) c.state.delete("charge1011601");
    },
    onCoinHit(c) {
      if (oncePerSkill(c, "charge1011601")) giveFromData(c);
    },
  },
  // SkillAbility_SkillPowerResultAdder1011601_<div>_<per>: (Charge count + target Burst stack + DimensionRift count) / div × per, max value.
  {
    name: /^SkillPowerResultAdder1011601_(\d+)_(\d+)$/,
    summary: "自身充能层数+目标破裂强度+次元裂隙层数每满div点最终威力+per(上限value)",
    skillMods(c) {
      const m = /_(\d+)_(\d+)$/.exec(c.script.scriptName);
      if (!m) return;
      const sum = c.actor.getCount("Charge") + c.target.getPotency("Burst") + c.target.getCount("DimensionRift");
      const v = Math.min(c.script.value ?? 0, Math.floor(sum / Number(m[1])) * Number(m[2]));
      if (v > 0) return { finalPower: v };
    },
  },
  // SkillAbility_SkillPowerResultAdderViaOnUseBuffCheckAndUse: owner's bd.buffKeyword count ≥ bd.turn → consume, +bd.value final power.
  {
    name: "SkillPowerResultAdderViaOnUseBuffCheckAndUse",
    summary: "指定状态层数不低于turn时消耗并使最终威力+value",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      if (side(c, bd.buffOwner).getCount(bd.buffKeyword) < (bd.turn ?? 0) || (bd.value ?? 0) <= 0) return;
      if ((bd.turn ?? 0) > 0) c.consume(bd.buffOwner === "Target" ? "target" : "actor", bd.buffKeyword, bd.turn!);
      return { finalPower: bd.value };
    },
  },
);

registerAbilities(
  noDamageAbility("AddShieldOnRSByStack", "回合开始按层数获得护盾"),
  // BuffAbility_BreakthroughHorseResultAdder.CheckCondition: stack at max → SkillPowerResultAdder +value.
  {
    name: "BreakthroughHorseResultAdder",
    summary: "本效果层数为最大值(5)时最终威力+value",
    coinMods(c: AbilityCtx) {
      if (c.side !== "actor" || c.status.potency < 5) return;
      return { finalPower: c.ability.value ?? 0 };
    },
  },
  noDamageAbility("BreakthroughHorseTakeBuff", "受到单技能伤害≥100时获得守护"),
  noDamageAbility("AggroAdderOnRoundEndByStack", "回合结束提高挑衅值"),
  // BuffAbility_LegStrengthHorseYisang.BeforeAttack: give main target Vibration potency = stack (round limit bd.limit).
  {
    name: "LegStrengthHorseYisang",
    summary: "攻击前使主要目标增加(本效果层数)级震颤强度(每回合最多6级)",
    coinMods(c: AbilityCtx) {
      if (c.side !== "actor" || c.coinIndex !== 0) return;
      const key = `legHorse:${c.turn}`;
      const used = c.state.get(key) ?? 0;
      const amt = Math.min(c.status.potency, (c.ability.buffData?.limit ?? 6) - used);
      if (amt <= 0) return;
      c.state.set(key, used + amt);
      c.give("target", c.ability.buffData?.buffKeyword ?? "Vibration", amt, 0, 0);
    },
  },
  // BuffAbility_TakeDmgMultiplierIfOneSideAttack: owner takes value (−10%) when hit one-sided (unopposed attacks are one-sided).
  {
    name: "TakeDmgMultiplierIfOneSideAttack",
    summary: "受到单方面攻击的伤害+value(−10%)",
    coinMods: (c: AbilityCtx) => (c.side === "target" ? { dmg: c.ability.value ?? 0 } : undefined),
  },
  // BuffAbility_TakeDmgMulByIndexUnit: attacker IncludedInAssociation(INDEX_FINGER) → +value taken.
  {
    name: "TakeDmgMulByIndexUnit",
    summary: "受到属于食指的单位的伤害+value",
    coinMods: (c: AbilityCtx) => (c.side === "target" && INDEX_FINGER_IDS.has(c.identityId) ? { dmg: c.ability.value ?? 0 } : undefined),
  },
  {
    name: "AddShieldBeforeTakeAttackDamageByMaxHpRatio",
    summary: "受到攻击前按体力上限比例获得护盾",
    approx: "护盾未建模（目标持有时会吸收体力伤害）",
  },
  noDamageAbility("ActivateBuffEffectBack", "仅视觉效果"),
  // BuffAbility_AtkAdderViaBuffCheck: owner's bd.buffKeyword stack ≥ bd.stack (turn ≥ bd.turn) → attack level +value.
  {
    name: "AtkAdderViaBuffCheck",
    summary: "指定状态不低于stack层时攻击等级+value",
    coinMods(c: AbilityCtx) {
      if (c.side !== "actor") return;
      const bd = c.ability.buffData;
      const s = bd?.buffKeyword ? c.actor : undefined;
      if (!s || !bd?.buffKeyword) return;
      if (s.getPotency(bd.buffKeyword) >= (bd.stack ?? 0) && s.getCount(bd.buffKeyword) >= (bd.turn ?? 0)) return { offense: c.ability.value ?? 0 };
    },
  },
  {
    name: "DefAdderViaBuffCheck",
    summary: "指定状态不低于stack层时防御等级+value",
    approx: "目标持有时的防御等级提升未建模",
  },
  {
    name: "TakeBuffTurnAdderIfSelfAndBuffStackCheck",
    summary: "本效果不低于value层时自身技能获得的充能层数+1",
    approx: "获得状态时的层数加成未建模",
  },
  // BuffAbility_AttackDmgMultiplierViaSelfBuffStackCheck: own stack ≥ round(value) → min(Charge stack × bd.value, bd.limit%).
  {
    name: "AttackDmgMultiplierViaSelfBuffStackCheck",
    summary: "本效果不低于value层时伤害+(充能强度×4%)(最多+20%)",
    coinMods(c: AbilityCtx) {
      if (c.side !== "actor" || c.status.potency < Math.round(c.ability.value ?? 0)) return;
      const bd = c.ability.buffData;
      if (!bd?.buffKeyword) return;
      let v = c.actor.getPotency(bd.buffKeyword) * (bd.value ?? 0);
      if (bd.limit && bd.limit > 0) v = Math.min(v, bd.limit * 0.01);
      if (v > 0) return { dmg: v };
    },
  },
  noDamageAbility("GiveBuffOnNextTurnByOverStack", "超过最大值的层数于下回合获得"),
);
