/**
 * "吃满加成" analyzer: derives the capped value of every conditional bonus script on a skill,
 * assuming its condition is always satisfied. Used by simple mode / bonus tiers.
 *
 * Caps follow the same verified formulas as effects.ts (limit field and the <N> name suffix).
 * Scripts covered here are disabled for that skill while a tier is active, so they are never
 * counted twice.
 */
import type { AbilityScript, NormalizedSkill } from "../config/game-data";
import type { CoreData } from "../data/game-data";
import { DOT_IDS } from "../config/status-terms";
import { getCoinScriptRerollLimit } from "./effects";

export type BonusTier = "none" | "power" | "full";

export const BONUS_TIER_LABEL: Record<BonusTier, string> = {
  none: "按实际状态（不假设）",
  power: "吃满威力加成（不含条件增伤）",
  full: "吃满威力 + 条件增伤",
};

export interface SkillBonusCap {
  /** Coin power added to every coin. */
  coinPower: number;
  /** Final power (skill power result) added to every coin roll. */
  finalPower: number;
  /** Conditional damage multiplier (0.3 = +30%) applying to every coin. */
  dmg: number;
  /** Per-coin conditional damage multiplier. */
  coinDmg: number[];
  /** Skill-wide critical damage multiplier bonus (when crit is active). */
  critDmg: number;
  /** Per-coin critical damage multiplier bonus (when crit is active). */
  coinCritDmg: number[];
  /** Index of the coin that reuses when its buff condition is met (e.g. TimeToListenHonglu on 10617 S2/S3). */
  rerollCoinIndex: number | null;
  /** Number of times the reroll coin reuses (default 1 when rerollCoinIndex != null; up to 5 for Upto5). */
  rerollCoinCount: number;
  /** Extra damage ratio on the reused coin hit (e.g. GiveAmberDmgByRatioOnSAIfRerolled1061703 = 0.3). */
  rerollBonusDmgRatio: number;
  powerScripts: string[];
  dmgScripts: string[];
  lines: string[];
}

const digits = (name: string) => {
  const m = /(\d+)$/.exec(name);
  return m ? Number(m[1]) : 0;
};
const cap = (limit: number | undefined, n: number) => {
  const l = limit && limit > 0 ? limit : Infinity;
  const nn = n > 0 ? n : Infinity;
  const v = Math.min(l, nn);
  return Number.isFinite(v) ? v : 0;
};

const RE_CRIT_DMG_RATIO = /^CriticalDmgUpByRatio(\d+)$/;
const RE_CRIT_DMG_DIV_LIVE = /^CriticalDmgUpByRatioOn(?:CriticalActivated|StartTurn)ViaBuffCheckDevideByStackWithLimit(\d+)$/;

export function analyzeSkillBonusCap(skill: NormalizedSkill): SkillBonusCap {
  const out: SkillBonusCap = {
    coinPower: 0,
    finalPower: 0,
    dmg: 0,
    coinDmg: skill.coins.map(() => 0),
    critDmg: 0,
    coinCritDmg: skill.coins.map(() => 0),
    rerollCoinIndex: null,
    rerollCoinCount: 0,
    rerollBonusDmgRatio: 0,
    powerScripts: [],
    dmgScripts: [],
    lines: [],
  };
  const addPower = (s: AbilityScript, coin: number, final: number) => {
    if (coin === 0 && final === 0) return;
    out.coinPower += coin;
    out.finalPower += final;
    out.powerScripts.push(s.scriptName);
    out.lines.push(`${s.scriptName}: ${coin ? `硬币威力 +${coin}` : ""}${coin && final ? "，" : ""}${final ? `最终威力 +${final}` : ""}`);
  };
  const addDmg = (s: AbilityScript, v: number) => {
    if (v === 0) return;
    out.dmg += v;
    out.dmgScripts.push(s.scriptName);
    out.lines.push(`${s.scriptName}: 伤害 +${Math.round(v * 100)}%`);
  };
  const addCritDmg = (s: AbilityScript, v: number) => {
    if (v === 0) return;
    out.critDmg += v;
    out.dmgScripts.push(s.scriptName);
    out.lines.push(`${s.scriptName}: 暴击伤害 +${Math.round(v * 100)}%`);
  };

  for (const s of skill.abilityScripts ?? []) {
    const n = s.scriptName;
    const bd = s.buffData;
    const val = Math.round(bd?.value ?? s.value ?? 0);
    if (/^CoinScaleAdder(OnStartTurn)?ViaBuffCheck(AndUse)?$/.test(n)) addPower(s, val, 0);
    else if (/^CoinScaleAdder(OnStartTurn)?ViaBuffCheckDevideBy(Stack|Turn)WithLimit\d+$/.test(n)) addPower(s, cap(bd?.limit, digits(n)), 0);
    else if (/^CoinScaleAdderOnStartTurnDivideBySumOfTwoBuffStack_/.test(n) || /^CoinScaleAdder(OnStartTurnViaLacerationAndVibrationStackSumDivision|DevideCombustionAndVibrationOnStartTurn)$/.test(n))
      addPower(s, cap(bd?.limit, 0) || Math.max(1, val), 0);
    else if (n === "CoinScaleAdderOnUseViaUsingBuffAmount") addPower(s, Math.max(1, bd?.limit ?? 1) * Math.max(1, val), 0);
    else if (/^SkillPowerResultAdderVia(OnUse)?BuffCheck$/.test(n)) addPower(s, 0, val);
    else if (/^SkillPowerResultAdderVia(OnUse)?BuffCheckDevideByStackWithLimit\d+$/.test(n)) addPower(s, 0, cap(bd?.limit, digits(n)));
    else if (n === "SkillPowerResultAdderOnUseViaBuffDevide") addPower(s, 0, cap(bd?.limit, 0) || val);
    else if (/^SkillPowerResultAdder(OnSTViaSumOfTwoBuffStackDivide|DivideBySumOfTwoBuffStack)_/.test(n)) addPower(s, 0, cap(bd?.limit, 0) || Math.max(1, val));
    else if (/^AttackDmgUpByRatio(OnUse)?ViaBuffCheck$/.test(n)) addDmg(s, bd?.value ?? 0);
    else if (/^AttackDmgUpByRatio(OnUse)?ViaBuffCheckDevideByStackWithLimit\d+$/.test(n)) addDmg(s, digits(n) * 0.01);
    else if (n === "AttackDmgUpOnUseViaBuffCheckDivideByStack") addDmg(s, (bd?.limit ?? 0) * 0.01);
    else if (n === "CriticalDmgUpByRatioViaBuffCheck") addCritDmg(s, bd?.value ?? s.value ?? 0);
    else if (RE_CRIT_DMG_DIV_LIVE.test(n)) addCritDmg(s, digits(n) * 0.01);
    else if (RE_CRIT_DMG_RATIO.test(n)) addCritDmg(s, digits(n) * 0.01);
  }
  skill.coins.forEach((c, i) => {
    for (const s of c.abilityScriptList ?? []) {
      const n = s.scriptName;
      const bd = s.buffData;
      const rerollLimit = getCoinScriptRerollLimit(s);
      if (n === "DmgUpByBuff" && bd?.value) {
        out.coinDmg[i]! += bd.value;
        out.dmgScripts.push(n);
        out.lines.push(`硬币 ${i + 1} ${n}: 伤害 +${Math.round(bd.value * 100)}%`);
      } else if (
        n === "CriticalDmgUpByJsonValue" ||
        n === "FullStopHongluCriticalAttackDmgUpByRatio" ||
        n === "BrokenUnitCriticalDmgUpByJsonValue"
      ) {
        const v = s.value ?? bd?.value ?? 0;
        if (v > 0) {
          out.coinCritDmg[i]! += v;
          out.dmgScripts.push(n);
          out.lines.push(`硬币 ${i + 1} ${n}: 暴击伤害 +${Math.round(v * 100)}%`);
        }
      } else if (RE_CRIT_DMG_RATIO.test(n)) {
        const v = digits(n) * 0.01;
        out.coinCritDmg[i]! += v;
        out.dmgScripts.push(n);
        out.lines.push(`硬币 ${i + 1} ${n}: 暴击伤害 +${Math.round(v * 100)}%`);
      } else if (
        n === "CriticalDmgUpByBuffStack" ||
        n === "CriticalDmgUpByBuffStackIfAlly" ||
        n === "CriticalDmgUpByRatioViaBuffCheckDevideByStack" ||
        n === "CriticalDmgUpByBuff1071103" ||
        n === "CriticalDmgUpOnSCViaSelfBreathAndBuffDivide"
      ) {
        const lim = bd?.limit ?? 0;
        const v = lim > 2 ? lim * 0.01 : lim > 0 ? lim * (bd?.value ?? 0.1) : (bd?.value ?? 0.3);
        if (v > 0) {
          out.coinCritDmg[i]! += v;
          out.dmgScripts.push(n);
          out.lines.push(`硬币 ${i + 1} ${n}: 暴击伤害至多 +${Math.round(v * 100)}%`);
        }
      } else if (n === "CriticalDmgUpByBreathStackAndTurnLimit40") {
        out.coinCritDmg[i]! += 0.4;
        out.dmgScripts.push(n);
        out.lines.push(`硬币 ${i + 1} ${n}: 暴击伤害至多 +40%`);
      } else if (rerollLimit > 0) {
        out.rerollCoinIndex = i;
        out.rerollCoinCount = Math.max(out.rerollCoinCount, rerollLimit);
        out.lines.push(`硬币 ${i + 1} ${n}: 满足条件时重投 ${rerollLimit} 次`);
      } else if (n === "GiveAmberDmgByRatioOnSAIfRerolled1061703") {
        out.rerollBonusDmgRatio = s.value ?? 0.3;
        out.lines.push(`硬币 ${i + 1} 重投追加 ${Math.round(out.rerollBonusDmgRatio * 100)}% 怠惰伤害`);
      }
    }
  });
  return out;
}

/** Script families that scale power / damage / crit off a status (and therefore need it present). */
const RE_SCALING_SCRIPT =
  /^(CoinScaleAdder|SkillPowerResultAdder|AttackDmgUp|AtkDamageMultiplier|TakeAtkDamage|CriticalDmgUp|CriticalChanceUp|DmgUp|DamageUp|DefAdder|AtkAdder)/;

export interface InferredIdentityStatuses {  isPoiseIdentity: boolean;
  hasCritBonusScripts: boolean;
  targetStatuses: Record<string, { potency: number; count: number }>;
  actorStatuses: Record<string, { potency: number; count: number }>;
  summaryNotes: string[];
}

/**
 * Scan all skills of an identity to infer the minimum Target DOT (potency & count) and
 * Actor Breath/Charge needed to satisfy all conditional power & damage caps.
 */
export function inferRequiredStatusesForIdentity(core: CoreData, identityId: number): InferredIdentityStatuses {
  const idObj = core.identities.find((i) => i.id === identityId);
  const targetStatuses: Record<string, { potency: number; count: number }> = {};
  const actorStatuses: Record<string, { potency: number; count: number }> = {};
  const summaryNotes: string[] = [];
  if (!idObj) {
    return { isPoiseIdentity: false, hasCritBonusScripts: false, targetStatuses, actorStatuses, summaryNotes };
  }

  const allSkillIds = [...idObj.skillPool.map((r: { skillId: number }) => r.skillId), ...idObj.defenseSkillIds];
  const skills = allSkillIds
    .map((sid) => core.skills[String(sid)])
    .filter((s: NormalizedSkill | undefined): s is NormalizedSkill => Boolean(s));

  let isPoiseIdentity = idObj.skillKeywords.includes("Breath");
  let hasCritBonusScripts = false;

  const requireStatus = (side: "actor" | "target", kw: string, reqPotency: number, reqCount: number) => {
    const map = side === "actor" ? actorStatuses : targetStatuses;
    const prev = map[kw] ?? { potency: 0, count: 0 };
    map[kw] = {
      potency: Math.max(prev.potency, Math.ceil(reqPotency)),
      count: Math.max(prev.count, Math.ceil(reqCount)),
    };
  };

  for (const s of skills) {
    const capInfo = analyzeSkillBonusCap(s);
    if (capInfo.critDmg > 0 || capInfo.coinCritDmg.some((v) => v > 0)) {
      hasCritBonusScripts = true;
      isPoiseIdentity = true;
    }
    const allScripts: AbilityScript[] = [
      ...(s.abilityScripts ?? []),
      ...s.coins.flatMap((c) => c.abilityScriptList ?? []),
    ];
    for (const sc of allScripts) {
      const n = sc.scriptName;
      const bd = sc.buffData;
      if (!bd?.buffKeyword) continue;
      // Only scripts that scale power / damage / crit off a status create a requirement;
      // pure application scripts (GiveBuffOnSucceedAttack etc.) must not demand pre-existing DOT.
      if (!RE_SCALING_SCRIPT.test(n)) continue;
      const kw = bd.buffKeyword;
      const isDot = (DOT_IDS as readonly string[]).includes(kw);
      const isBreathOrCharge = kw === "Breath" || kw === "Charge";
      if (!isDot && !isBreathOrCharge) continue;
      const side: "actor" | "target" = bd.buffOwner === "Self" || isBreathOrCharge ? "actor" : "target";
      if (kw === "Breath") isPoiseIdentity = true;

      let needStack = bd.stack ?? 0;
      let needTurn = bd.turn ?? 0;
      const d = digits(n);
      if (/DevideByStackWithLimit\d+$/.test(n) && (bd.stack ?? 0) > 0) {
        if (/AttackDmgUp|CriticalDmgUp/.test(n) && (bd.value ?? 0) > 0) {
          const steps = Math.ceil((d * 0.01) / bd.value!);
          needStack = Math.max(needStack, steps * bd.stack!);
        } else {
          const steps = cap(bd.limit, d) / Math.max(1, Math.round(bd.value ?? 1));
          needStack = Math.max(needStack, steps * bd.stack!);
        }
      } else if (/DevideByTurnWithLimit\d+$/.test(n) && (bd.turn ?? 0) > 0) {
        const steps = cap(bd.limit, d) / Math.max(1, Math.round(bd.value ?? 1));
        needTurn = Math.max(needTurn, steps * bd.turn!);
      } else if ((bd.limit ?? 0) > 0 && (bd.stack ?? 0) > 0) {
        needStack = Math.max(needStack, bd.stack! * Math.min(bd.limit!, 10));
      }
      if (isDot && needStack > 0 && needTurn === 0) {
        needTurn = 6; // give enough count so DOT doesn't immediately expire mid-skill
      }
      if (needStack > 0 || needTurn > 0) {
        requireStatus(side, kw, needStack, needTurn);
      }
    }
  }

  if (isPoiseIdentity) {
    const prev = actorStatuses.Breath ?? { potency: 0, count: 0 };
    actorStatuses.Breath = {
      potency: Math.max(prev.potency, 20), // 20 Poise potency = 100% Crit rate!
      count: Math.max(prev.count, 10),
    };
    summaryNotes.push(`呼吸法全暴击：自身呼吸法 ≥ 20 强度 / ${actorStatuses.Breath.count} 层（暴击率 100%，基础暴伤 +20%${hasCritBonusScripts ? " + 技能暴伤加成" : ""}）`);
  }

  for (const [kw, st] of Object.entries(targetStatuses)) {
    summaryNotes.push(`吃满所需敌方 ${kw}：强度 ≥ ${st.potency} / 层数 ≥ ${st.count}`);
  }

  return { isPoiseIdentity, hasCritBonusScripts, targetStatuses, actorStatuses, summaryNotes };
}
