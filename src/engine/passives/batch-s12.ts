/** Script/status batch 12 — see data/il2cpp/dossiers/scripts-12.md */
import { triggerVibrationExplosion, type StatusContainer } from "../status";
import { vibrationUsed1060903 } from "./batch-s11";
import { noDamageAbility, noDamageScript, registerAbilities, registerScripts, type ScriptCtx, type ScriptData } from "./framework";

type BD = NonNullable<ScriptData["buffData"]>;
interface CoinLike { scale?: number; operatorType?: string; abilityScriptList?: ScriptData[] }
interface SkillLike { id: number; basePower: number; abilityScripts?: ScriptData[]; coins: CoinLike[] }

/** AbilityBase.GetSingleUnit(buffOwner): "Self" → actor, otherwise the main target. */
const owner = (c: ScriptCtx, bd: BD | undefined): StatusContainer => (bd?.buffOwner === "Self" ? c.actor : c.target);
/** Identities with UNIT_KEYWORD.BLACK_BEAST (core.json), for SkillAbility_106130301.GetHeishouUnits via declared allies. */
const HEISHOU_IDS = ["10114", "10212", "10313", "10411", "10714", "10912", "11014", "11112", "11212"];

function buffCheck(c: ScriptCtx, bd: BD | undefined): boolean {
  if (!bd?.buffKeyword) return false;
  const o = owner(c, bd);
  return o.getPotency(bd.buffKeyword) >= (bd.stack ?? 0) && o.getCount(bd.buffKeyword) >= (bd.turn ?? 0);
}

function giveBD(c: ScriptCtx, bd: BD | undefined, stack = bd?.stack ?? 0, turn = bd?.turn ?? 0): void {
  if (!bd?.buffKeyword || (stack <= 0 && turn <= 0)) return;
  c.give(bd.target === "Self" ? "actor" : "target", bd.buffKeyword, stack, turn, bd.activeRound === 1 ? 1 : 0);
}

// ---- Full-Stop Office Hong Lu bullets (Bullet = keyword 55)
/** Bullets a coin will consume (CoinModel.GetConsumeBulletCount): UseBullet[optional:Bullet:N] → N, FullStopHongluThree1 → 3, Two1 → 2 (desc). */
function coinBulletUse(coin: CoinLike): number {
  let n = 0;
  for (const s of coin.abilityScriptList ?? []) {
    const m = /^UseBullet\[(?:optional|necessary):Bullet:(\d+)\]$/.exec(s.scriptName);
    if (m) n += Number(m[1]);
    else if (s.scriptName === "UseBullet[optional:Bullet:::FullStopHongluThree1]") n += 3;
    else if (s.scriptName === "UseBullet[optional:Bullet:::FullStopHongluTwo1]") n += 2;
  }
  return n;
}

/** CoinAbility_FullStopHongluAttackDmgUpByRatio.GetAttackDmgMultiplier: min(_MAX_USE_COUNT, Bullet stack) × jsonValue. */
function fullStopDmg(name: string, max: number) {
  return {
    name,
    summary: `本硬币伤害+(消耗弹药数×value)，最多计${max}发`,
    approx: "按硬币伤害结算前的弹药数计算（弹药在命中后由 UseBullet 消耗）",
    coinMods(c: ScriptCtx) {
      const n = Math.min(max, c.actor.getPotency("Bullet"));
      return n > 0 ? { dmg: n * (c.script.value ?? 0) } : undefined;
    },
  };
}

/** CoinAbility_UseBullet (optional): consume up to N bullets for this coin; consumed after the hit so damage scripts see them. */
function useBullet(name: string, max: number) {
  return {
    name,
    summary: `本硬币消耗最多${max}发弹药（可选，不足时不影响发动）`,
    onCoinHit(c: ScriptCtx) {
      if (c.isRerolled) return;
      const n = Math.min(max, c.actor.getPotency("Bullet"));
      if (n > 0) c.lose("actor", "Bullet", n);
    },
  };
}

/** CoinScaleAdderOST...AndSelfBreathStack: sum = owner keyword stack + self Breath stack; check sum >= bd.stack && turn >= bd.turn. */
function breathSum(c: ScriptCtx, bd: BD | undefined): number | null {
  if (!bd?.buffKeyword) return null;
  const o = owner(c, bd);
  const sum = o.getPotency(bd.buffKeyword) + c.actor.getPotency("Breath");
  if (sum < (bd.stack ?? 0) || o.getCount(bd.buffKeyword) < (bd.turn ?? 0)) return null;
  return sum;
}

/** Estimated final skill power at the current coin (GetFinalSkillPowerResult is not exposed): base + skill-level Charge adders + heads coin scales. */
function estimatePower(c: ScriptCtx): number {
  const sk = c.skillData as SkillLike;
  let base = sk.basePower;
  let coinAdd = 0;
  let finalAdd = 0;
  for (const s of sk.abilityScripts ?? []) {
    const bd = s.buffData;
    if (!bd?.buffKeyword) continue;
    const o = owner(c, bd);
    const st = o.getPotency(bd.buffKeyword);
    if (s.scriptName === "SkillPowerAdderViaBuffDevide" && st >= (bd.stack ?? 0)) base += Math.min(Math.floor(st / Math.max(1, bd.stack ?? 1)) * (bd.value ?? 1), bd.limit || Infinity);
    const m = /^CoinScaleAdderViaBuffCheckDevideByStackWithLimit(\d+)$/.exec(s.scriptName);
    if (m && st >= (bd.stack ?? 0)) coinAdd += Math.min(Math.floor(st / Math.max(1, bd.stack ?? 1)) * (bd.value ?? 1), Number(m[1]));
    if (s.scriptName === "SkillPowerResultAdderViaBuffCheck" && buffCheck(c, bd)) finalAdd += Math.round(bd.value ?? 0);
  }
  let p = base;
  for (let i = 0; i <= (c.coinIndex ?? 0) && i < sk.coins.length; i++) {
    const coin = sk.coins[i]!;
    if (i === c.coinIndex && !c.isHeads) continue;
    const sc = (coin.scale ?? 0) + coinAdd;
    p = coin.operatorType === "SUB" ? p - sc : coin.operatorType === "MUL" ? p * sc : p + sc;
  }
  return Math.max(0, p + finalAdd);
}

registerScripts(
  // CoinAbility_YurodivyHongluThirdSkillCoinThirdAbility<A>And<B>And<C>: Vibration consumed by SkillAbility_1060903 (Σ[+0x88]) >= A →
  // target VibrationExplosion + LoseBuffTurnBySkill(Vibration, B); consumed < C → self VibrationExplosion
  {
    name: "YurodivyHongluThirdSkillCoinThirdAbility10And1And15",
    summary: "若使用时消耗了≥10层震颤：命中时使目标震颤引爆并减少1层震颤；消耗<15层则自身也震颤引爆",
    approx: "消耗量取自 batch-s11 的 vibrationUsed1060903；自身震颤引爆不影响对目标伤害",
    onCoinHit(c) {
      const used = vibrationUsed1060903(c);
      if (used < 10) return;
      const rec = triggerVibrationExplosion(c.target, c.turn, "犯人就是你！ 震颤引爆");
      if (rec?.hpDamage) c.extraDamage(rec.hpDamage, "震颤引爆（震颤-灼热）");
      if (c.target.get("Vibration")) c.consume("target", "Vibration", 1);
      if (used < 15) c.note("自身震颤引爆（不影响对目标伤害）");
    },
  },

  // CoinAbility_1061003.OnSucceedAttack: target Burst stack >= bd.stack(15) or target HP ratio < value(0.3) → reroll (once per skill)
  {
    name: "1061003",
    summary: "目标破裂强度≥15或体力<30%时重复使用本硬币（每技能1次）",
    rerolls(c) {
      const bd = c.script.buffData;
      const burst = c.target.getPotency(bd?.buffKeyword ?? "Burst") >= (bd?.stack ?? 15);
      return burst || c.targetHpRatio() < (bd?.value ?? 0.3) ? 1 : 0;
    },
  },

  // SkillAbility_10610AdditionalCoinScaleAdder.GetCoinScaleAdder: activated at use (target Burst stack >= 15 && turn >= 3) → +value;
  // target unit keyword 33/34 (血魔/血袋) adds IntegerValue more
  {
    name: "10610AdditionalCoinScaleAdder",
    summary: "使用时目标破裂强度≥15且层数≥3则硬币威力+1（血魔/血袋目标额外+1）",
    skillMods(c) {
      if (!buffCheck(c, c.script.buffData)) return;
      const v = Math.round(c.script.buffData?.value ?? 1);
      // UNIT_KEYWORD 34 BLOODFIEND / 33 BLOODBAG → + buffData.IntegerValue
      const extra = c.targetHasUnitKeyword?.("BLOODFIEND") || c.targetHasUnitKeyword?.("BLOODBAG") ? v : 0;
      return { coinScale: v + extra };
    },
  },

  // SkillAbility_CoverMeFullStopHeath.OnStartTurn_BeforeLog: CheckCondition (random < jsonValue, resonance-dependent part unresolved)
  //   and Heath 10711 alive → Heath cuts in his tier-2 skill (_TARGET_HEATH_SKILL_TIER 2 → 1071102) on the main target.
  {
    name: "CoverMeFullStopHeath",
    summary: "句点事务所希斯克利夫(#10711)在场时按概率(value)由其以2技能掩护射击",
    approx: "概率取 value（共鸣相关部分未解析）；固定硬币模式按期望值计；需在场队友填写 10711",
    onSkillEnd(c) {
      if (!(c.allyIdentities?.() ?? []).some((a) => a.id === 10711)) return;
      c.allyAttack?.({ allyId: 10711, skillId: 1071102, key: `cover:${c.skill?.id}`, label: "掩护射击 ", chance: c.script.value ?? 1 });
    },
  },

  fullStopDmg("FullStopHongluAttackDmgUpByRatioUseOneBullet", 1),
  fullStopDmg("FullStopHongluAttackDmgUpByRatioUseTwoBullet", 2),
  fullStopDmg("FullStopHongluAttackDmgUpByRatioUseThreeBullet", 3),
  noDamageScript("FullStopHongluBSGuage", "命中时按伤害量使目标混乱阈值前移"),
  noDamageScript("FullStopHongluBSGuageByUsableBulletCount", "按可用弹药数使目标混乱阈值前移"),

  // CoinAbility_FullStopHongluGiveBuffOnSucceedAttack: Bullet stack > 0 → GiveBuffOnSucceedAttack (buffData)
  {
    name: "FullStopHongluGiveBuffOnSucceedAttack",
    summary: "带有弹药时命中给予buffData状态（自身呼吸法强度+2）",
    approx: "弹药判定按本硬币结算前的弹药数",
    coinMods(c) {
      c.state.set("hasBullet", c.actor.getPotency("Bullet") > 0 ? 1 : 0);
    },
    onCoinHit(c) {
      if (c.state.get("hasBullet")) giveBD(c, c.script.buffData);
    },
  },

  // SkillAbility_FullStopHongluSkillPowerAdder.CalculateSkillPowerAdder: min(Σ coin consume-bullet counts, Bullet stack) → base power
  {
    name: "FullStopHongluSkillPowerAdder",
    summary: "本技能每将消耗1发弹药，基础威力+1",
    skillMods(c) {
      const total = (c.skillData as SkillLike).coins.reduce((s, coin) => s + coinBulletUse(coin), 0);
      const add = Math.min(total, c.actor.getPotency("Bullet"));
      return add > 0 ? { basePower: add } : undefined;
    },
  },

  // SkillAbility_FullStopHongluUpgradeSkillBeforeUse.OnBeforeTurn: HasPassive(1061102 or 1061111) && CheckHeathCondition (Heathcliff 10711
  // on the field) → ChangeSkill(_upgradeSkillID): 2nd 1061102→1061105, 3rd 1061103→1061106 (same coins upgraded; ids by core data).
  ...([["FullStopHongluUpgrade2ndSkillBeforeUse", 1061105], ["FullStopHongluUpgrade3rdSkillBeforeUse", 1061106]] as const).map(([name, to]) => ({
    name,
    summary: `希斯克利夫(10711)在场时，使用前转化为联合技能(${to})`,
    approx: "升级技能 id 由核心数据推断（get__upgradeSkillID 未导出常量）；希斯克利夫需在场景 battle.allies 中声明",
    beforeUse(c: ScriptCtx) {
      if (c.allyPresent("10711")) c.replaceSkill?.(to, "希斯克利夫(10711)在场");
    },
  })),

  useBullet("UseBullet[optional:Bullet:1]", 1),
  useBullet("UseBullet[optional:Bullet:::FullStopHongluThree1]", 3),
  useBullet("UseBullet[optional:Bullet:::FullStopHongluTwo1]", 2),

  // SkillAbility_1061202 (_5).OnStartTurn_BeforeLog: Charge turn in [IntegerValue 5, limit 10) → buffData (Sinking 10 to self) + Charge turn to 10;
  // Charge stack >= 5 (name suffix) → no CantIdentify; target num +1 (multi-target)
  {
    name: "1061202_5",
    summary: "充能层数5~9时自身沉沦强度+10并补充充能至10层",
    approx: "引擎的“消耗10层充能、硬币威力+2”（CoinScaleAdderOnStartTurnViaBuffCheckAndUse）先于本脚本结算；补充后在此代为结算一次。若使用前充能为15~19层会多算一次；多目标未建模",
    skillMods(c) {
      const bd = c.script.buffData;
      const n = c.actor.getCount("Charge");
      const lim = bd?.limit ?? 10;
      if (n < Math.round(bd?.value ?? 5) || n >= lim) return;
      giveBD(c, bd);
      c.give("actor", "Charge", 0, lim - n);
      const andUse = (c.skillData as SkillLike).abilityScripts?.find((s) => s.scriptName === "CoinScaleAdderOnStartTurnViaBuffCheckAndUse" && s.buffData?.buffKeyword === "Charge");
      if (!andUse?.buffData || c.actor.getCount("Charge") < (andUse.buffData.turn ?? 0)) return;
      c.consume("actor", "Charge", andUse.buffData.turn ?? 0);
      return { coinScale: Math.round(andUse.buffData.value ?? 0) };
    },
  },

  // CoinAbility_AttackDmgUpByBuff1061203 (DmgUpByBuff): Charge stack >= bd.stack(3) → stack × value(0.2), cap limit(100) × 0.01
  {
    name: "AttackDmgUpByBuff1061203",
    summary: "充能强度≥3时每级充能强度使本硬币伤害+20%（最多+100%）",
    coinMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const st = owner(c, bd).getPotency(bd.buffKeyword);
      if (st < (bd.stack ?? 0)) return;
      return { dmg: Math.min(st * (bd.value ?? 0), (bd.limit ?? 100) * 0.01) };
    },
  },

  // SkillAbility_AttackDmgUpByRatioBBViaBuffCheckAndUse.BeforeBehaviour: check (Charge turn >= 8) → UseBuffTurn 8 → dmg +value(0.4)
  {
    name: "AttackDmgUpByRatioBBViaBuffCheckAndUse",
    summary: "攻击前若满足状态条件则消耗该状态并使本技能伤害+value",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword || !buffCheck(c, bd)) return;
      const side = bd.buffOwner === "Self" ? "actor" : "target";
      if ((bd.stack ?? 0) > 0) c.lose(side, bd.buffKeyword, bd.stack!);
      if ((bd.turn ?? 0) > 0) c.consume(side, bd.buffKeyword, bd.turn!);
      return { dmg: bd.value ?? 0 };
    },
  },

  // CoinAbility_AttackDmgUpByResult1061203_<cap>: GetFinalSkillPowerResult × jsonValue, cap = <cap> × 0.01
  {
    name: /^AttackDmgUpByResult1061203_(\d+)$/,
    summary: "本硬币伤害+(本技能威力×value)（有上限）",
    approx: "当前硬币的最终威力不可得：按基础威力+充能相关加成+正面硬币威力估算",
    coinMods(c) {
      const cap = Number(/_(\d+)$/.exec(c.script.scriptName)![1]) * 0.01;
      return { dmg: Math.min(estimatePower(c) * (c.script.value ?? 0), cap) };
    },
  },

  noDamageScript("DamageFirstBreakSectionOnSAByDmgRatioWithOnes10", "命中时按伤害量10%使目标混乱阈值前移"),
  noDamageScript("DamageFirstBreakSectionOnSAByDmgRatioWithOnes5", "命中时按伤害量5%使目标混乱阈值前移"),

  // SkillAbility_SkillPowerAdderViaBuffDevide.GetPowerAdder: owner has buff → floor(stack / bd.stack) (or turn / bd.turn) × value, cap limit
  {
    name: "SkillPowerAdderViaBuffDevide",
    summary: "指定单位每带有N级某状态，基础威力+value（有上限）",
    // timing audit: GetSkillPowerAdder → GetPowerAdder on every coin → per-coin base power
    coinMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const o = owner(c, bd);
      if (!o.get(bd.buffKeyword)) return;
      const k = (bd.stack ?? 0) > 0 ? Math.floor(o.getPotency(bd.buffKeyword) / bd.stack!) : (bd.turn ?? 0) > 0 ? Math.floor(o.getCount(bd.buffKeyword) / bd.turn!) : 0;
      let add = k * Math.round(bd.value ?? 1);
      if ((bd.limit ?? 0) > 0) add = Math.min(add, bd.limit!);
      return add > 0 ? { basePower: add } : undefined;
    },
  },

  noDamageScript("106130101", "战斗开始使其他友方获得忍耐"),
  noDamageScript("106130201", "战斗开始使装备暴食技能的其他友方获得暴食伤害强化"),
  {
    // SkillAbility_106130301.OnEndBehaviour: Heishou (UNIT_KEYWORD.BLACK_BEAST) allies other than self → HeishouCombo +
    // Util.CutInActionByTier (ally chain); none → OnFailCombo → Util.CutInActionBySkillId(_FAILURE_ALT_SKILLID 1061306).
    name: "106130301",
    summary: "黑兽连携结束后追加使用“开辟君主之道吧”；未声明黑兽友方时连携失败，追加使用“孑然一身，舍生取园”(1061306)",
    approx: "声明黑兽友方时：友方连携攻击与随后追加技能未建模（仅记录）",
    onSkillEnd(c) {
      if (c.allyPresent(...HEISHOU_IDS)) {
        c.note("已声明黑兽友方：友方连携攻击未建模");
        return;
      }
      c.queueAction?.(1061306, { label: "孑然一身，舍生取园", key: "106130301" });
    },
  },
  noDamageScript("106130302", "仅标记类（SkillAbility_106130302 无逻辑）"),

  // CoinAbility_AttackDmgUpByRatio: +N × 0.01 coin damage
  {
    name: /^AttackDmgUpByRatio(\d{1,3})$/, // 1-3 digits: longer suffixes are skill ids (e.g. AttackDmgUpByRatio1021103)
    summary: "本硬币伤害+N%",
    coinMods(c) {
      return { dmg: Number(/(\d+)$/.exec(c.script.scriptName)![1]) * 0.01 };
    },
  },

  // SkillAbility_CoinScaleAdderOSTViaBuffCheckAndSelfBreathStack: (target Burst + self Breath) >= stack → +value (at use)
  {
    name: "CoinScaleAdderOSTViaBuffCheckAndSelfBreathStack",
    summary: "使用时目标破裂强度与自身呼吸法强度之和≥N则硬币威力+value",
    approx: "两者按相加判定（ISIL 只能看出读取了两项强度）",
    skillMods(c) {
      return breathSum(c, c.script.buffData) != null ? { coinScale: Math.round(c.script.buffData?.value ?? 1) } : undefined;
    },
  },
  // ...DivideByStackWithLimitAndSelfBreathStack<L>: min(floor(sum / stack) × IntegerValue, L)
  ...[2, 3].map((lim) => ({
    name: `CoinScaleAdderOSTViaBuffCheckDivideByStackWithLimitAndSelfBreathStack${lim}`,
    summary: `使用时目标破裂强度与自身呼吸法强度之和每有N级硬币威力+1（最多+${lim}）`,
    skillMods(c: ScriptCtx) {
      const bd = c.script.buffData;
      const sum = breathSum(c, bd);
      if (sum == null) return;
      const add = Math.min(Math.floor(sum / Math.max(1, bd?.stack ?? 1)) * Math.round(bd?.value ?? 1), lim);
      return add > 0 ? { coinScale: add } : undefined;
    },
  })),

  // CoinAbility_AdditionalActionOnSA1061402: target neg count >= value(5), once per turn → cut-in skill 1061408
  {
    // SkillAbility_UseAllNeedlekinAndGiveBuffToAlliesOnUse1071705 (OnUse): consume all NeedlekinAlly; ally buffs not modelled.
    name: "UseAllNeedlekinAndGiveBuffToAlliesOnUse1071705",
    summary: "使用时消耗全部[NeedlekinAlly]",
    approx: "按消耗层数给友方的增益未建模；消耗时机按使用时（不再提供攻击等级）",
    skillMods(c) {
      const s = c.actor.get("NeedlekinAlly");
      if (s && s.potency > 0) c.lose("actor", "NeedlekinAlly", s.potency);
    },
  },
  {
    name: "AdditionalActionOnSA1061402",
    summary: "命中时目标负面状态≥value(5)种则追加使用装置艺术第3号“简易肋骨”(1061408，每回合1次)",
    approx: "插入行动按自身追加行动在本技能后执行",
    onCoinHit(c) {
      if (c.target.countByBuffType("Negative") < (c.script.value ?? 5)) return;
      c.queueAction?.(1061408, { label: "简易肋骨", key: "AdditionalActionOnSA1061402", perTurn: (c.script as { turnLimit?: number }).turnLimit ?? 1 });
    },
  },
);

registerAbilities(
  noDamageAbility("TakeHpHealMultiplierByStack", "受到的体力恢复量减少"),
);
