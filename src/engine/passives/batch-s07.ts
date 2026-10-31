/** Script/status batch 07 — see data/il2cpp/dossiers/scripts-07.md */
import { giveAdder, noDamageAbility, noDamageScript, registerAbilities, registerScripts, type PassiveCtx, type ScriptCtx, type ScriptData } from "./framework";
import type { StatusContainer } from "../status";

type Bd = NonNullable<ScriptData["buffData"]>;
interface SkillShape {
  coins: { abilityScriptList?: ScriptData[] }[];
}

/** SkillAbility_BasicBuff-style check: owner's activated stack ≥ bd.stack and turn ≥ bd.turn (stack = potency, turn = count). */
function buffCheck(c: PassiveCtx, bd: Bd | undefined): boolean {
  if (!bd?.buffKeyword) return false;
  const owner = bd.buffOwner === "Target" ? c.target : c.actor;
  if (!owner.get(bd.buffKeyword)) return false;
  return owner.getPotency(bd.buffKeyword) >= (bd.stack ?? 0) && owner.getCount(bd.buffKeyword) >= (bd.turn ?? 0);
}

/** RedEyeBase / PenanceBase move the stacks to the *Second / *Third ids at 8 / 16 stacks; read all forms. */
const stageStacks = (s: StatusContainer, base: "RedEye" | "Penance") =>
  s.getPotency(`${base}First`) + s.getPotency(`${base}Second`) + s.getPotency(`${base}Third`);

// ---------------------------------------------------------------- last-coin damage bonus (CoinAbility_LastCoinDmgUpOnSucceedAttackByRatio)
// Each carrying coin, on a (heads) hit, arms its own flag; the action's last coin then gets +ratio from every armed ability
// (GetAnotherCoinAttackDmgMultiplier). Coin-scope hooks only run on the carrying coin, so armed ratios are kept in c.action.shared.
const LAST_COIN_KEY = "LastCoinDmgUp:entries";
const RE_LAST_COIN = /^LastCoinDmgUpOnSucceedAttack(Head)?ByRatio(\d+)$/;

function isLastCoin(c: PassiveCtx): boolean {
  return c.skill != null && c.coinIndex === c.skill.coinCount - 1;
}

function lastCoinBonus(c: ScriptCtx): number {
  if (!isLastCoin(c)) return 0;
  const entries = c.action.shared.get(LAST_COIN_KEY) as { coin: number; ratio: number }[] | undefined;
  if (!entries) return 0;
  return entries.filter((e) => e.coin < c.coinIndex!).reduce((s, e) => s + e.ratio, 0);
}

function lastCoinCarriesScript(skillData: unknown): boolean {
  const coins = (skillData as SkillShape).coins ?? [];
  return (coins[coins.length - 1]?.abilityScriptList ?? []).some((s) => RE_LAST_COIN.test(s.scriptName));
}

const lastCoinHandler = (name: string) => {
  const m = RE_LAST_COIN.exec(name)!;
  const headOnly = Boolean(m[1]);
  const ratio = Number(m[2]) / 100;
  return {
    name,
    summary: `${headOnly ? "正面" : ""}命中时使本技能最后一枚硬币伤害+${m[2]}%`,
    approx: "最后一枚硬币不带此类效果时，仅在已翻译的技能脚本(1040503)中结算加成",
    coinMods(c: ScriptCtx) {
      const v = lastCoinBonus(c);
      return v ? { dmg: v } : undefined;
    },
    onCoinHit(c: ScriptCtx) {
      if ((headOnly && !c.isHeads) || isLastCoin(c) || c.coinIndex == null) return;
      const i = c.coinIndex;
      const prev = (c.action.shared.get(LAST_COIN_KEY) as { coin: number; ratio: number }[] | undefined) ?? [];
      const entries = prev.filter((e) => e.coin < i); // a reused coin re-arms its own flag
      entries.push({ coin: i, ratio });
      c.action.shared.set(LAST_COIN_KEY, entries);
    },
  };
};

// ---------------------------------------------------------------- GivingLacerationAndVibrationStackAdderViaBuffCheck emulation
const PLAIN_GIVE: Record<string, (c: ScriptCtx) => boolean> = {
  GiveBuffOnSucceedAttack: () => true,
  GiveBuffOnSucceedAttackHead: (c) => Boolean(c.isHeads),
  GiveBuffOnSuccessCriticalAttack: (c) => Boolean(c.isCritical),
};

registerScripts(
  noDamageScript("BuffStackAdderOnWinDuel2", "拼点胜利时额外施加层数（拼点专属）"),
  // SkillAbility_SkillPowerAdderViaBuffCheck.GetSkillPowerAdder: CheckCondition(owner stack ≥ bd.stack && turn ≥ bd.turn) → +round(bd.value).
  {
    name: "SkillPowerAdderViaBuffCheck",
    summary: "指定单位带有足量状态时技能基础威力+value",
    // timing audit: GetSkillPowerAdder re-checked for every coin → per-coin base power
    coinMods(c) {
      const bd = c.script.buffData;
      if (buffCheck(c, bd)) return { basePower: Math.round(bd?.value ?? 0) };
    },
  },
  noDamageScript("1040403_3", "命中带流血/麻痹的目标时下回合施加体力恢复降低"),
  // SkillAbility_AttackDmgAdderByTargetLostHpRatio<P>Max<M>: OnStartTurn adder = round(target lost HP (maxHp − hp) × P×0.01), cap M
  // → GetAttackDmgAdder (flat, added after multipliers × (1 + max(0, resist/level terms))).
  {
    name: "AttackDmgAdderByTargetLostHpRatio5Max20",
    summary: "伤害附加目标已失去体力的5%（最多20）",
    approx: "未设置目标最大体力时无法换算已失去体力，不计入；取整按向下取整",
    skillMods(c) {
      const max = c.targetMaxHp();
      if (max == null) return;
      const lostHp = Math.round(max * c.targetLostHpRatio());
      const add = Math.min(Math.floor(lostHp * 0.05 + 1e-7), 20);
      return add > 0 ? { atkDmgAdder: add } : undefined;
    },
  },
  lastCoinHandler("LastCoinDmgUpOnSucceedAttackHeadByRatio10"),
  lastCoinHandler("LastCoinDmgUpOnSucceedAttackHeadByRatio5"),
  // SkillAbility_1040503 (CoinScaleAdderOnStartTurnViaBuffCheckAndUse): Charge turn ≥ bd.turn(15) → UseBuffTurn(15), coin power +5.
  {
    name: "1040503",
    summary: "使用时充能层数≥15：消耗15层充能，硬币威力+5",
    skillMods(c) {
      const bd = c.script.buffData;
      const need = bd?.turn ?? 15;
      if (c.actor.getCount("Charge") < need) return;
      c.actor.consumeCount("Charge", need);
      c.note(`消耗${need}层充能，硬币威力+${bd?.value ?? 5}`);
      return { coinScale: Math.round(bd?.value ?? 5) };
    },
    // Skill 1040503's last coin carries no LastCoinDmgUp script, so the armed last-coin bonus is resolved here.
    coinMods(c) {
      if (lastCoinCarriesScript(c.skillData)) return;
      const v = lastCoinBonus(c);
      return v ? { dmg: v } : undefined;
    },
  },
  noDamageScript("1040503_4", "击杀时获得充能力场"),
  // CoinAbility_AttackDmgUpByRatioIfHpRatioLessThan<M>..<N>: target HP ratio < N% → coin dmg +M%
  {
    name: "AttackDmgUpByRatio30IfHpRatioLessThan30",
    summary: "目标体力低于30%时本硬币伤害+30%",
    coinMods(c) {
      return c.targetHpRatio() < 0.3 ? { dmg: 0.3 } : undefined;
    },
  },
  // SkillAbility_WCorpRyoshuThirdSkillAbility_ConditionTurnLessThan: 7 ≤ Charge turn < 15 → UseBuffAllTurn, lose 3%×(15−used) max HP, coin +5.
  {
    name: "WCorpRyoshuThirdSkillAbility_ConditionTurnLessThan15",
    summary: "使用时充能层数在7~14：消耗全部充能，硬币威力+5",
    approx: "按缺少层数消耗自身体力(3%/层)未计入（不影响输出）",
    skillMods(c) {
      const bd = c.script.buffData;
      const n = c.actor.getCount("Charge");
      if (n < (bd?.turn ?? 7) || n >= 15) return;
      c.actor.consumeCount("Charge", n);
      c.note(`消耗${n}层充能（并失去${3 * (15 - n)}%最大体力），硬币威力+${bd?.value ?? 5}`);
      return { coinScale: Math.round(bd?.value ?? 5) };
    },
  },
  // CoinAbility_1040603.OnSucceedAttack/CheckStackAndTurn: give bd stack/turn to target; ×bd.value (2) on critical.
  {
    name: "1040603",
    summary: "命中时施加震颤/破裂（暴击时强度与层数×2）",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const mul = c.isCritical ? bd.value ?? 2 : 1;
      c.give("target", bd.buffKeyword, Math.round((bd.stack ?? 0) * mul), Math.round((bd.turn ?? 0) * mul));
    },
  },
  // CoinAbility_UseBullet (necessary): consumes 1 Bullet when the coin is used; without bullets the coin does not activate.
  {
    name: "UseBullet[necessary:Bullet:1]",
    summary: "掷出硬币时消耗1发弹药；弹药不足时硬币不发动",
    beforeCoin(c) {
      if (c.actor.getPotency("Bullet") <= 0) c.cancelCoin("弹药不足（UseBullet[necessary:Bullet:1]）");
    },
    coinMods(c) {
      if (c.actor.getPotency("Bullet") <= 0) {
        c.note(`硬币${(c.coinIndex ?? 0) + 1}缺少弹药：实际不会发动`);
        return;
      }
      c.lose("actor", "Bullet", 1);
    },
  },
  // SkillAbility_1040802_Targetting.OnCompleteCommand: Breath turn ≥ 6 → UseBuffTurn(6), target num +2.
  {
    name: "1040802_Targetting",
    summary: "战斗开始时呼吸法层数≥6：消耗6层呼吸法（攻击目标数+2）",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!buffCheck(c, bd)) return;
      c.actor.consumeCount(bd!.buffKeyword!, bd!.turn ?? 6);
      c.addAttackWeight?.(2);
      c.note(`消耗${bd!.turn ?? 6}层${bd!.buffKeyword}`);
    },
  },
  noDamageScript("1040803_1", "击杀后对带有[MarkOfButler]的其他目标重复使用技能"),
  {
    name: "CriticalDmgUpByRatioIfTargetBreak40",
    summary: "目标处于混乱时暴击伤害+40%（需启用混乱模型）",
    // GetAttackDmgMultiplier: critical && target IsBreak → +0.4 (opt-in stagger model: scenario target.staggerThresholdsPct + hpTracking).
    coinMods(c) {
      if (c.isCritical && c.targetStaggered?.()) return { dmg: 0.4 };
    },
  },
  noDamageScript("DamageFirstBreakSectionOnSuccessAttackByDamageRatio3", "按伤害量30%使目标混乱阈值前移"),
  // CoinAbility_YurodivyRyoshuFirstSkillCoinAbility (GiveBuffOnSucceedAttackByDuplicateTurn): self Vibration turn += target Vibration turn × value (≤ limit).
  {
    name: "YurodivyRyoshuFirstSkillCoinAbility_Vibration",
    summary: "命中时对自身施加等同目标震颤层数的震颤（最多4层）",
    onCoinHit(c) {
      const bd = c.script.buffData;
      const n = Math.min(Math.trunc(c.target.getCount("Vibration") * (bd?.value ?? 1)), bd?.limit ?? 4);
      if (n > 0) c.give("actor", "Vibration", 0, n);
    },
  },
  // CoinAbility_YurodivyRyoshuSecondSkillCoinAbility.OnSucceedAttack: UseBuffTurn(self Vibration, ≤ limit) → give target that many turns.
  {
    name: "YurodivyRyoshuSecondSkillCoinAbility",
    summary: "命中时消耗自身震颤层数，对目标施加等量震颤层数（最多5层）",
    onCoinHit(c) {
      const n = Math.min(c.actor.getCount("Vibration"), c.script.buffData?.limit ?? 5);
      if (n <= 0) return;
      c.actor.consumeCount("Vibration", n);
      c.give("target", "Vibration", 0, n);
    },
  },
  // CoinAbility_GiveBuffOnSucceedAttackByDuplicateStackDevideByValue: self RedEyeFirst += floor(target Laceration stack / value) (≤ limit).
  {
    name: "GiveBuffOnSucceedAttackByDuplicateStackDevideByValue_Laceration",
    summary: "命中时获得(目标流血强度/2)层赤瞳（最多3层）",
    onCoinHit(c) {
      const bd = c.script.buffData;
      const n = Math.min(Math.floor(c.target.getPotency("Laceration") / Math.max(1, bd?.value ?? 2)), bd?.limit ?? 3);
      if (n > 0) c.give("actor", bd?.buffKeyword ?? "RedEyeFirst", n, 0);
    },
  },
  // SkillAbility_TenthRyoshuSecondSkillFirstAbilityAnd.GetCoinScaleAdder: RedEye + Penance stacks ≥ 15 → coin power +1.
  {
    name: "TenthRyoshuSecondSkillFirstAbility15And1",
    summary: "赤瞳与忏悔层数之和≥15时硬币威力+1",
    coinMods(c) {
      if (stageStacks(c.actor, "RedEye") + stageStacks(c.actor, "Penance") >= 15) return { coinScale: 1 };
    },
  },
  noDamageScript("TenthRyoshuSecondSkillThirdCoinAbility_RedEyeFirst7", "赤瞳≥7时下回合获得迅捷"),
  {
    // SkillAbility_TenthRyoshuThirdSkillFirstAbility<N>.OnBeforeTurn: self RedEyeFirst ≥ N && PenanceFirst ≥ N → ChangeSkill(1041005).
    name: "TenthRyoshuThirdSkillFirstAbility15",
    summary: "赤瞳与忏悔均≥15时改为使用“动真格地碎颅”(1041005)",
    beforeUse(c) {
      if (c.actor.getPotency("RedEyeFirst") >= 15 && c.actor.getPotency("PenanceFirst") >= 15) c.replaceSkill?.(1041005, "赤瞳与忏悔均≥15");
    },
  },
  // SkillAbility_TenthRyoshuThirdSkillThirdAbilityAndAnd: SP == max → clash +2, coin +1, lose 15 SP at end.
  {
    name: "TenthRyoshuThirdSkillThirdAbility2And1And15",
    summary: "理智值为最大值时硬币威力+1（拼点威力+2，结束后失去15理智）（未启用）",
    approx: "需要读取自身理智值：硬币威力+1未计入",
  },
  noDamageScript("TenthRyoshuThirdSkillThirdCoinFirstAbility", "按忏悔层数恢复自身与友方体力"),
  noDamageScript("TenthRyoshuThirdSkillThirdCoinSecondAbility", "按忏悔层数恢复自身与友方理智"),
  // SkillAbility_AttackDmgUp1111203.CalculateDmgMul: speedDiff > 0 → diff × floor(target Burst stack / bd.stack) × value (+turn part), cap limit%.
  {
    name: "AttackDmgUp1111203",
    summary: "速度高于目标时伤害+(速度差×目标破裂强度)%（最多50%）",
    coinMods(c) {
      const bd = c.script.buffData;
      const diff = c.battle.selfSpeed - c.battle.targetSpeed;
      if (diff <= 0 || !bd?.buffKeyword) return;
      const per = bd.value ?? 0.01;
      let v = 0;
      if ((bd.stack ?? 0) > 0) v += diff * Math.floor(c.target.getPotency(bd.buffKeyword) / bd.stack!) * per;
      if ((bd.turn ?? 0) > 0) v += diff * Math.floor(c.target.getCount(bd.buffKeyword) / bd.turn!) * per;
      if ((bd.limit ?? 0) > 0) v = Math.min(v, bd.limit! * 0.01);
      return v > 0 ? { dmg: v } : undefined;
    },
  },
  // GiveBuffOnSucceedAttackIfSelfSpeedNotLessThanValue: self speed ≥ bd.value → give bd buff.
  {
    name: "GiveBuffOnSucceedAttackIfSelfSpeedNotLessThanValue",
    summary: "命中时若自身速度≥10，对目标施加1层破裂",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword || c.battle.selfSpeed < (bd.value ?? 10)) return;
      c.give(bd.target === "Self" ? "actor" : "target", bd.buffKeyword, bd.stack ?? 0, bd.turn ?? 0);
    },
  },
  // SkillAbility_AttackDmgMultiplierOSTViaLacerationAndVibrationStackTarget: snapshot (Laceration + Vibration stack) × jsonValue, cap _<N>%.
  {
    name: /^AttackDmgMultiplierOSTViaLacerationAndVibrationStackTarget_(\d+)$/,
    summary: "使用时目标流血与震颤强度之和每1级伤害+1%（有上限）",
    skillMods(c) {
      const cap = Number(/_(\d+)$/.exec(c.script.scriptName)![1]) * 0.01;
      const sum = c.target.getPotency("Laceration") + c.target.getPotency("Vibration");
      const v = Math.min(sum * (c.script.value ?? 0.01), cap);
      return v > 0 ? { dmg: v } : undefined;
    },
  },
  // SkillAbility_GivingLacerationAndVibrationStackAdderViaBuffCheck: target has GazeRyoshu → this skill's Laceration/Vibration
  // potency gains +2. Emulated: after plain GiveBuffOnSucceedAttack(Head/Critical) coin scripts that add potency, add the extra.
  {
    name: "GivingLacerationAndVibrationStackAdderViaBuffCheck",
    summary: "目标带有[GazeRyoshu]时本技能增加的流血/震颤强度额外+2",
    approx: "仅对普通“命中时施加”类硬币效果追加强度；其他施加途径未覆盖",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!c.target.get(bd?.buffKeyword ?? "GazeRyoshu")) return;
      const add = bd?.stack ?? 2;
      const coin = (c.skillData as SkillShape).coins?.[c.coinIndex ?? -1];
      for (const s of coin?.abilityScriptList ?? []) {
        const kw = s.buffData?.buffKeyword;
        if (kw !== "Laceration" && kw !== "Vibration") continue;
        if ((s.buffData?.stack ?? 0) <= 0 || s.buffData?.target === "Self") continue;
        if (PLAIN_GIVE[s.scriptName]?.(c)) c.give("target", kw, add, 0);
      }
    },
  },
);

registerAbilities(
  noDamageAbility("CheckNormalExtendedInitBulletBase", "登场时补满弹药（初始弹药由场景设定）"),
  noDamageAbility("PenanceBase", "忏悔阶段切换与回合开始护盾"),
  noDamageAbility("PenanceMpHeal", "基础技能获得忏悔的硬币命中时恢复理智"),
  {
    name: "RedEyeBase",
    summary: "赤瞳层数达到8/16时切换为强化阶段（未建模）",
    approx: "阶段切换(RedEyeSecond/Third)未建模；阶段强化的流血强度加成需“修改施加状态数值”能力",
  },
  // BuffAbility_GiveBuffStackAdderIfDefaultSkill: default-skill coin effects giving bd.buffKeyword get +bd.stack potency.
  {
    name: "GiveBuffStackAdderIfDefaultSkill",
    summary: "基础技能硬币效果施加的指定状态强度额外增加",
    // GetGiveBuffStackAdder: own default skill (S1-S3) gives bd.buffKeyword → + bd.stack potency (only when the give has potency).
    onSkillStart(c) {
      const bd = c.ability.buffData;
      if (c.side !== "actor" || !bd?.buffKeyword || !bd.stack || !["S1", "S2", "S3"].includes(c.skill?.slot ?? "")) return;
      giveAdder(c, "skill", { key: `GBSAIDS:${c.status.id}`, buffId: bd.buffKeyword, amount: bd.stack, kinds: ["stack"], side: "target", ownSkillOnly: true });
    },
  },
);
