/** Script/status batch 16 — see data/il2cpp/dossiers/scripts-16.md */
import {
  noDamageAbility,
  noDamageScript,
  registerAbilities,
  registerScripts,
  type AbilityCtx,
  type PassiveCtx,
  type ScriptCtx,
  type ScriptData,
} from "./framework";

// Already registered elsewhere (not re-registered here):
//   GiveBuffOnSucceedAttackByDuplicateStack_Burst → batch-s01 RegExp family;
//   GiveBuffOnSucceedAttackIfHasStack_ReinforcedTattooIshmael1 / _Charge2 → batch-s03 RegExp family;
//   GiveBuffOnREPerStack (WindBladeIshmael) → batch-s14.

type BD = NonNullable<ScriptData["buffData"]>;
type Side = "actor" | "target";

const BLACK_CLOUD = [10403, 10602, 10712, 10811, 10902, 11208];
/** BUFF_CATEGORY_KEYWORD.VIBRATION_CONVERTED / VIBRATION_MERGED members (core.json buffs[].categoryKeywordList). */
const VIB_CONVERTED_OR_MERGED = [
  "VibrationBleeding", "VibrationChain", "VibrationCollapse", "VibrationContinue", "VibrationCrack", "VibrationDistribution",
  "VibrationEcho", "VibrationFocusing", "VibrationIgnition", "VibrationSpring", "VibrationNesting",
];

const bdOf = (c: ScriptCtx): BD => c.script.buffData ?? {};
function sideOf(who: string | undefined, def: Side): Side {
  if (who === "Self") return "actor";
  if (who === "Target" || who === "EveryEnemy") return "target";
  return def;
}
const box = (c: PassiveCtx, s: Side) => (s === "actor" ? c.actor : c.target);
function giveBd(c: PassiveCtx, bd: BD, def: Side, potency = bd.stack ?? 0, count = bd.turn ?? 0): void {
  if (!bd.buffKeyword || (potency <= 0 && count <= 0)) return;
  c.give(sideOf(bd.target, def), bd.buffKeyword, Math.max(0, potency), Math.max(0, count), (bd.activeRound ?? 0) === 1 ? 1 : 0);
}
const isBasic = (c: PassiveCtx) => ["S1", "S2", "S3"].includes(c.skill?.slot ?? "");
const curHpPct = (c: PassiveCtx) => 100 - c.battle.lostHpPct;
function assocCount(c: PassiveCtx, ids: number[]): number {
  return 1 + ids.filter((id) => id !== c.identityId && c.allyPresent(String(id))).length;
}
/** Per-turn activation limit (CoinAbility/SkillAbility turnLimit, "每回合最多N次"). */
function perTurn(c: PassiveCtx, n: number, key = "lim"): boolean {
  const k = `${key}:${c.turn}`;
  const used = c.state.get(k) ?? 0;
  if (used >= n) return false;
  c.state.set(k, used + 1);
  return true;
}
const num = (re: RegExp, s: string, i = 1) => Number(re.exec(s)?.[i] ?? 0);

/** c.action.shared key: snapshot of target Laceration before each coin (for GiveAdditionalBuff10814: copy of the coin's Laceration give as Burn). */
const LAC_SNAP = "10814:lacSnap";

/** Round-start give for status abilities: next-round give queued at round end (turn ≥ 2) + live give before the first coin (turn 1). */
function roundStartHooks(compute: (c: AbilityCtx) => { kw: string; p: number; t: number; dest: Side } | null) {
  return {
    // OnRoundStart_After_Event: ability onRoundStart (fires at every turn start, incl. turn 1, with the live stack).
    onRoundStart(c: AbilityCtx) {
      c.state.set(`rs:${c.turn}`, 1);
      const g = compute(c);
      if (g && (g.p > 0 || g.t > 0)) c.give(g.dest, g.kw, g.p, g.t, 0);
    },
    // Turn 1 fallback for statuses given by stage-start passives (they run after the engine's turn-1 round start).
    coinMods(c: AbilityCtx) {
      if (c.turn !== 1 || c.state.get("rs:1")) return;
      c.state.set("rs:1", 1);
      const g = compute(c);
      if (g && (g.p > 0 || g.t > 0)) c.give(g.dest, g.kw, g.p, g.t, 0);
    },
  };
}

registerScripts(
  // CoinAbility_GiveBuffOnSucceedAttackHead1081102: heads hit (turnLimit) → give buffData; if alive BLACK_CLOUD allies (incl. self) ≥ bd.limit
  // → keyword/stack replaced by the name suffix (Vulnerable 2).
  {
    name: /^GiveBuffOnSucceedAttackHead1081102_([A-Za-z]+?)(\d+)$/,
    summary: "正面命中时施加1层斩击易损(每回合1次)；黑云会≥6名时改为2层易损",
    onCoinHit(c) {
      if (!c.isHeads || !perTurn(c, 1)) return;
      const bd = bdOf(c);
      const m = /_([A-Za-z]+?)(\d+)$/.exec(c.script.scriptName)!;
      if (assocCount(c, BLACK_CLOUD) >= (bd.limit ?? Infinity)) giveBd(c, { ...bd, buffKeyword: m[1] }, "target", Number(m[2]), 0);
      else giveBd(c, bd, "target");
    },
  },
  // SkillAbility_CoinScaleAdder1081203.CalculateCoinScaleAdder (OnStartTurn): floor((main target Burst stack + turn) / jsonValue) × IntegerValue, cap limit.
  {
    name: "CoinScaleAdder1081203",
    summary: "主要目标破裂强度与层数之和每有7点，硬币威力+1(最多+5)",
    skillMods(c) {
      const bd = bdOf(c);
      const kw = bd.buffKeyword ?? "Burst";
      const per = Math.max(1, c.script.value ?? 1);
      let v = Math.floor((c.target.getPotency(kw) + c.target.getCount(kw)) / per) * (bd.value ?? 1);
      if ((bd.limit ?? 0) > 0) v = Math.min(v, bd.limit!);
      if (v > 0) return { coinScale: v };
    },
  },
  // CoinAbility_CriticalDmgUp10812 / DmgUp10812.GetAttackDmgMultiplier: (self Breath + target <kw>) × bd.value + jsonValue, cap limit%.
  {
    name: "CriticalDmgUp10812",
    summary: "暴击时本硬币伤害+(value+自身呼吸法强度+目标破裂强度)%(有上限)",
    coinMods(c) {
      if (!c.isCritical) return;
      return { dmg: dmg10812(c) };
    },
  },
  {
    name: "DmgUp10812",
    summary: "本硬币伤害+(value+自身呼吸法强度+目标破裂强度)%(有上限)",
    coinMods(c) {
      return { dmg: dmg10812(c) };
    },
  },
  noDamageScript("GiveBuffOnSACThenKillEnemyOnEndCoin", "暴击命中后击杀目标时获得状态（击杀不在模拟中发生）"),
  // CoinAbility_GiveBuffOnSucceedAttackHeadByDuplicateTurn_<Kw>: heads hit → give buffData with turn = owner <Kw> count (cap limit).
  {
    name: /^GiveBuffOnSucceedAttackHeadByDuplicateTurn_([A-Za-z]+)$/,
    summary: "正面命中时获得层数等同于目标指定状态层数的buffData状态(有上限)",
    onCoinHit(c) {
      if (!c.isHeads) return;
      const kw = /_([A-Za-z]+)$/.exec(c.script.scriptName)![1]!;
      const bd = bdOf(c);
      let t = box(c, sideOf(bd.buffOwner, "target")).getCount(kw);
      if ((bd.limit ?? 0) > 0) t = Math.min(t, bd.limit!);
      if (t > 0) giveBd(c, bd, "actor", bd.stack && bd.stack > 0 ? bd.stack : 0, t);
    },
  },
  // SkillAbility_AttackDmgUpIfTargetVibrationConvertedOrMerged: target has a VIBRATION_CONVERTED/MERGED category buff → +jsonValue.
  {
    name: "AttackDmgUpIfTargetVibrationConvertedOrMerged",
    summary: "目标处于转换/融合震颤状态时伤害+value",
    coinMods(c) {
      if (VIB_CONVERTED_OR_MERGED.some((id) => c.target.get(id))) return { dmg: c.script.value ?? 0 };
    },
  },
  // SkillAbility_CoinScaleAdderOnSTViaVibrationAndBuffCheck/Divide: owner's (bd kw + Vibration) stack/bd.stack (+ turn/bd.turn) × IntegerValue, cap limit.
  {
    name: "CoinScaleAdderOnSTViaVibrationAndBuffDivide",
    summary: "目标震颤与指定状态强度之和每满N级，硬币威力+value(有上限)",
    skillMods(c) {
      const bd = bdOf(c);
      if (!bd.buffKeyword) return;
      const o = box(c, sideOf(bd.buffOwner, "target"));
      const p = o.getPotency(bd.buffKeyword) + o.getPotency("Vibration");
      const t = o.getCount(bd.buffKeyword) + o.getCount("Vibration");
      const div = ((bd.stack ?? 0) > 0 ? Math.floor(p / bd.stack!) : 0) + ((bd.turn ?? 0) > 0 ? Math.floor(t / bd.turn!) : 0);
      let v = div * (bd.value ?? 1);
      if ((bd.limit ?? 0) > 0) v = Math.min(v, bd.limit!);
      if (v > 0) return { coinScale: v };
    },
  },
  noDamageScript("Discard10813", "同一行动槽另一技能不同时丢弃前者"),
  // CoinAbility_SwitchVibrationOnSAIfNotConverted: on hit, target not already converted → SwitchTargetVibrationToSpecial(bd keyword).
  {
    name: "SwitchVibrationOnSAIfNotConverted",
    summary: "命中时若目标震颤未被转换，则转换为指定特殊震颤",
    onCoinHit(c) {
      const kw = bdOf(c).buffKeyword;
      if (!kw || VIB_CONVERTED_OR_MERGED.some((id) => c.target.get(id))) return;
      if (c.target.convert("Vibration", kw)) c.note(`目标震颤转换为${kw}`);
    },
  },
  // CoinAbility_AdditionalDmg1081403_<N>: on hit, envy resonance r > 0 → trunc(finalDmg × min(r × jsonValue, N%)) slash damage.
  {
    name: /^AdditionalDmg1081403_(\d+)$/,
    summary: "命中时额外造成本硬币伤害×(嫉妒共鸣数×5%)的斩击伤害(最多30%)",
    approx: "以本硬币实际体力伤害代替最终伤害",
    onCoinHit(c) {
      const r = c.battle.resonance?.VIOLET ?? 0;
      if (r <= 0) return;
      const ratio = Math.min(r * (c.script.value ?? 0), num(/_(\d+)$/, c.script.scriptName) * 0.01);
      const d = Math.trunc((c.lastHitDamage ?? 0) * ratio);
      if (d > 0) c.extraDamage(d, `嫉妒共鸣${r}：额外斩击伤害${Math.round(ratio * 100)}%`, { atkType: "SLASH" });
    },
  },
  // SkillAbility_AttackLevelAdder10814Reinforced_<max>_<pct>: Round(max attribute resonance / jsonValue) capped at max;
  // if a perfect resonance exists → × (1 + pct%).
  {
    name: /^AttackLevelAdder10814Reinforced_(\d+)_(\d+)$/,
    summary: "按最大共鸣数/2增加攻击等级(最多3)；包含完全共鸣时翻倍",
    approx: "“该共鸣包括完全共鸣”按存在任意完全共鸣判断",
    skillMods(c) {
      const m = /_(\d+)_(\d+)$/.exec(c.script.scriptName)!;
      const maxRes = Math.max(0, ...Object.values(c.battle.resonance ?? {}));
      let n = Math.min(Math.floor(maxRes / Math.max(1, c.script.value ?? 2)), Number(m[1]));
      if (n > 0 && (c.battle.perfectResonance ?? 0) > 0) n += Math.floor(n * Number(m[2]) * 0.01);
      if (n > 0) return { offense: n };
    },
  },
  // SkillAbility_CoinScaleAdderViaCombustionAndBuffCheck: not evade; owner's (bd kw + Combustion) stack ≥ bd.stack → +IntegerValue.
  {
    name: "CoinScaleAdderViaCombustionAndBuffCheck",
    summary: "目标烧伤与指定状态强度之和不低于N级时硬币威力+value",
    coinMods(c) {
      const bd = bdOf(c);
      if (!bd.buffKeyword) return;
      const o = box(c, sideOf(bd.buffOwner, "target"));
      const okP = (bd.stack ?? 0) > 0 && o.getPotency(bd.buffKeyword) + o.getPotency("Combustion") >= bd.stack!;
      const okT = (bd.turn ?? 0) > 0 && o.getCount(bd.buffKeyword) + o.getCount("Combustion") >= bd.turn!;
      if (okP || okT) return { coinScale: bd.value ?? 1 };
    },
  },
  // SkillAbility_GiveAdditionalBuff10814_<coins…>: with HeatingWireIshmael at use, Laceration given by the listed coins (1-based)
  // is copied as Combustion (buffData stack/turn −1 = same amount).
  {
    name: /^GiveAdditionalBuff10814((?:_\d+)+)$/,
    summary: "带有[HeatingWireIshmael]时，指定硬币命中施加流血时额外施加等量烧伤",
    approx: "施加量按命中前后目标流血强度/层数的增量判定",
    skillMods(c) {
      c.state.set("wire", c.actor.get("HeatingWireIshmael") ? 1 : 0);
    },
    coinMods(c) {
      c.action.shared.set(LAC_SNAP, { p: c.target.getPotency("Laceration"), c: c.target.getCount("Laceration") });
    },
    onCoinHit(c) {
      if (!c.state.get("wire") || c.coinIndex == null) return;
      const coins = c.script.scriptName.split("_").slice(1).map((s) => Number(s) - 1);
      if (!coins.includes(c.coinIndex)) return;
      const s = c.action.shared.get(LAC_SNAP) as { p: number; c: number } | undefined;
      if (!s) return;
      const dp = c.target.getPotency("Laceration") - s.p;
      const dc = c.target.getCount("Laceration") - s.c;
      if (dp > 0 || dc > 0) c.give("target", "Combustion", Math.max(0, dp), Math.max(0, dc));
    },
  },
  // CoinAbility_GiveAdditionalHitDmgOnSuccessAttackTarget<N>: on hit → N HIT damage (GiveHpDamageAppliedAtkResist).
  {
    name: /^GiveAdditionalHitDmgOnSuccessAttackTarget(\d+)$/,
    summary: "命中时对目标额外造成N点打击伤害",
    onCoinHit(c) {
      const n = num(/(\d+)$/, c.script.scriptName);
      if (n > 0) c.extraDamage(n, `额外打击伤害 ${n}`, { atkType: "HIT" });
    },
  },
  noDamageScript("GiveBuffOnEndAttackIfCounter", "以反击技能使用时攻击结束后获得状态（模拟无反击）"),
  // SkillAbility_ResultAdderIfCounter10814.CalcResultAdder (OnStartTurn): floor(self <kw> stack / max(bd.stack,1)) × IntegerValue, cap limit.
  {
    name: "ResultAdderIfCounter10814",
    summary: "自身每有5层[ResentmentIshmael]，最终威力+1(最多+3)",
    skillMods(c) {
      const bd = bdOf(c);
      if (!bd.buffKeyword) return;
      let v = Math.floor(c.actor.getPotency(bd.buffKeyword) / Math.max(1, bd.stack ?? 1)) * (bd.value ?? 1);
      if ((bd.limit ?? 0) > 0) v = Math.min(v, bd.limit!);
      if (v > 0) return { finalPower: v };
    },
  },
  // Class not resolved in IL2CPP index; same family as CoinScaleAdderViaMyBreathYourSinking_div_limit (batch-s03) — desc fallback:
  // (self Breath + target Laceration) per <div> → +1 coin power, max <limit>, evaluated on use.
  {
    name: /^CoinScaleAdderViaMyBreathYourLacerationOnStartTurn_div(\d+)_limit(\d+)$/,
    summary: "自身呼吸法强度与目标流血强度之和每有6级，硬币威力+1(最多+2)",
    approx: "类未能解析，按描述实现",
    skillMods(c) {
      const m = /_div(\d+)_limit(\d+)$/.exec(c.script.scriptName)!;
      const v = Math.min(Math.floor((c.actor.getPotency("Breath") + c.target.getPotency("Laceration")) / Math.max(1, Number(m[1]))), Number(m[2]));
      if (v > 0) return { coinScale: v };
    },
  },
  // SkillAbility_GiveBuffOnEndAttackByBuffDiv_<Kw><N>: owner <Kw> stack ≥ N → give buffData × floor(stack/N) (cap limit). desc: 1/turn.
  {
    name: /^GiveBuffOnEndAttackByBuffDiv_([A-Za-z]+?)(\d+)$/,
    summary: "技能结束时自身每有N层指定状态，获得1层buffData状态(有上限，每回合1次)",
    onSkillEnd(c) {
      const m = /_([A-Za-z]+?)(\d+)$/.exec(c.script.scriptName)!;
      const bd = bdOf(c);
      const per = Math.max(1, Number(m[2]));
      const st = box(c, sideOf(bd.buffOwner, "actor")).getPotency(m[1]!);
      if (st < per || !perTurn(c, 1)) return;
      let n = Math.floor(st / per) * (bd.stack ?? 1);
      if ((bd.limit ?? 0) > 0) n = Math.min(n, bd.limit!);
      giveBd(c, bd, "actor", n, (bd.turn ?? 0) * Math.floor(st / per));
    },
  },
  // SkillAbility_GiveBuffOnEndAttackIfHas_<Kw>: owner has <Kw> at end of attack → give buffData. desc: 1/turn.
  {
    name: /^GiveBuffOnEndAttackIfHas_([A-Za-z]+)$/,
    summary: "攻击结束时若自身带有指定状态，获得buffData状态(每回合1次)",
    onSkillEnd(c) {
      const kw = /_([A-Za-z]+)$/.exec(c.script.scriptName)![1]!;
      const bd = bdOf(c);
      if (box(c, sideOf(bd.buffOwner, "actor")).get(kw) && perTurn(c, 1)) giveBd(c, bd, "actor");
    },
  },
  // SkillAbility_10816LoseHpBAAndAttackDmgUp_<hp>_<dmg>: BeforeAttack: has bd keyword (RougeIshmaelEclose) or pays hp% max HP → dmg +dmg%.
  {
    name: /^10816LoseHpBAAndAttackDmgUp_(\d+)_(\d+)$/,
    summary: "攻击前若带有[RougeIshmaelEclose]（否则消耗20%体力）则伤害+40%",
    approx: "未带有该状态时自身失去的体力未计入（按体力足够处理）",
    skillMods(c) {
      const m = /_(\d+)_(\d+)$/.exec(c.script.scriptName)!;
      const kw = bdOf(c).buffKeyword;
      if (kw && !c.actor.get(kw)) c.note(`未带有${kw}：消耗${m[1]}%体力（未计入）`);
      return { dmg: Number(m[2]) * 0.01 };
    },
  },
  // CoinAbility_GiveAttributeDmgOSADivideByBuffStackRatio_<SIN>: on hit → finalDmg × min(floor(owner kw stack / bd.stack) × bd.value, limit%) as <SIN> damage.
  {
    name: /^GiveAttributeDmgOSADivideByBuffStackRatio_([A-Z]+)$/,
    summary: "命中时按自身充能强度额外造成本硬币伤害一定比例的属性伤害(每级10%，最多30%)",
    approx: "以本硬币实际体力伤害代替最终伤害",
    onCoinHit(c) {
      const bd = bdOf(c);
      if (!bd.buffKeyword) return;
      const st = box(c, sideOf(bd.buffOwner, "actor")).getPotency(bd.buffKeyword);
      let ratio = Math.floor(st / Math.max(1, bd.stack ?? 1)) * (bd.value ?? 0);
      if ((bd.limit ?? 0) > 0) ratio = Math.min(ratio, bd.limit! * 0.01);
      const d = Math.trunc((c.lastHitDamage ?? 0) * ratio);
      if (d > 0) c.extraDamage(d, `${/_([A-Z]+)$/.exec(c.script.scriptName)![1]}属性追加伤害 ${Math.round(ratio * 100)}%`, { sin: /_([A-Z]+)$/.exec(c.script.scriptName)![1] as import("../../config/game-data").SinAttribute });
    },
  },
  // SkillAbility_GiveBuffOnUseIfSelfHpRatioNotLessThan<N>: on use, own HP ≥ N% → give buffData.
  {
    name: /^GiveBuffOnUseIfSelfHpRatioNotLessThan(\d+)$/,
    summary: "使用时若现存体力不低于N%，施加buffData状态",
    skillMods(c) {
      if (curHpPct(c) >= num(/(\d+)$/, c.script.scriptName)) giveBd(c, bdOf(c), "actor");
    },
  },
  {
    name: /^HealSelfRerollOnSuccessAttackByHpRatioPerChargeStackWithLimit(\d+)$/,
    summary: "重复使用的硬币命中时按充能强度回复体力（不影响本次伤害）",
  },
  // SkillAbility_RougeCoinScaleAdderOnUseViaBuffTurnCheckAndUse: on use, Charge count (+ DinnerField) < bd.turn → fill (HP cost per desc);
  // use bd.turn Charge count; coin scale + Round(jsonValue).
  {
    name: "RougeCoinScaleAdderOnUseViaBuffTurnCheckAndUse",
    summary: "使用时充能不足N层则消耗体力补足，消耗N层充能并使硬币威力+value",
    approx: "补足充能所消耗的体力(3%×差额)未计入；红色晚宴(友方)充能来源未建模",
    skillMods(c) {
      const bd = bdOf(c);
      const kw = bd.buffKeyword ?? "Charge";
      const need = bd.turn ?? 0;
      const have = c.actor.getCount(kw);
      if (have < need) {
        c.give("actor", kw, 0, need - have);
        c.note(`充能不足：消耗${3 * (need - have)}%体力补足至${need}层（体力未计入）`);
      }
      c.consume("actor", kw, need);
      return { coinScale: Math.round(c.script.value ?? 0) };
    },
  },
);

function dmg10812(c: ScriptCtx): number {
  const bd = bdOf(c);
  const sum = c.actor.getPotency("Breath") + c.target.getPotency(bd.buffKeyword ?? "Burst");
  const v = sum * (bd.value ?? 0) + (c.script.value ?? 0);
  return (bd.limit ?? 0) > 0 ? Math.min(v, bd.limit! * 0.01) : v;
}

registerAbilities(
  // BuffAbility_GiveBuffOnRSPerStack.OnRoundStart_After_Event: n = floor(stack / value) → GiveBuff(bd.stack×n, bd.turn×n), capped by limit.
  {
    name: "GiveBuffOnRSPerStack",
    summary: "回合开始时本状态强度每有value级，给予buffData状态",
    ...roundStartHooks((c) => {
      const bd = c.ability.buffData;
      if (!bd?.buffKeyword) return null;
      // CountableBuff (e.g. HanafudaCombo) keeps its stack in count only.
      const n = Math.floor((c.status.potency || c.status.count) / Math.max(1, c.ability.value ?? 1));
      let p = (bd.stack ?? 0) * n;
      let t = (bd.turn ?? 0) * n;
      if ((bd.limit ?? 0) > 0) {
        p = Math.min(p, bd.limit!);
        t = Math.min(t, bd.limit!);
      }
      const other: Side = c.side === "actor" ? "target" : "actor";
      return { kw: bd.buffKeyword, p, t, dest: bd.target === "Target" ? other : c.side };
    }),
  },
  // BuffAbility_LoseTurnOnRoundStart: count −= Round(value) at round start (applied once per turn before the first coin).
  {
    name: "LoseTurnOnRoundStart",
    summary: "回合开始时本状态层数减少value",
    onRoundStart(c: AbilityCtx) {
      const n = Math.round(c.ability.value ?? 1);
      if (n > 0) c.consume(c.side, c.status.id, n);
    },
  },
  // BuffAbility_GiveBuffOnSTWithLimitCount_<N>: on each skill use (OnStartTurn_BeforeLog), ≤ N per round → GiveBuff_ByBuff(buffData).
  {
    name: /^GiveBuffOnSTWithLimitCount_(\d+)$/,
    summary: "使用技能时给予buffData状态(每回合最多N次)",
    coinMods(c: AbilityCtx) {
      if (c.side !== "actor" || c.coinIndex !== 0 || c.isRerolled) return;
      const bd = c.ability.buffData;
      if (!bd?.buffKeyword) return;
      const lim = num(/_(\d+)$/, c.ability.ability);
      if (!perTurn(c, lim, "st")) return;
      const mul = c.ability.value ?? 1;
      const p = (bd.stack ?? 0) < 0 ? Math.round(c.status.potency * mul) : bd.stack ?? 0;
      const t = (bd.turn ?? 0) < 0 ? Math.round(c.status.potency * mul) : bd.turn ?? 0;
      if (p > 0 || t > 0) c.give(bd.target === "Target" ? "target" : "actor", bd.buffKeyword, p, t, (bd.activeRound ?? 0) === 1 ? 1 : 0);
    },
  },
  // BuffAbility_GiveBuffOnBattleEnd.OnBattleEnd (end of each turn's combat): GiveBuff_ByBuff(buffData); negative → stack × value.
  {
    name: "GiveBuffOnBattleEnd",
    summary: "战斗结束时给予buffData状态",
    approx: "战斗结束时机按回合结束(状态衰减前)处理",
    onRoundEnd(c: AbilityCtx) {
      const bd = c.ability.buffData;
      if (!bd?.buffKeyword) return;
      const mul = c.ability.value ?? 1;
      const p = (bd.stack ?? 0) < 0 ? Math.round(c.status.potency * mul) : bd.stack ?? 0;
      const t = (bd.turn ?? 0) < 0 ? Math.round(c.status.potency * mul) : bd.turn ?? 0;
      if (p <= 0 && t <= 0) return;
      const other: Side = c.side === "actor" ? "target" : "actor";
      c.give(bd.target === "Target" ? other : c.side, bd.buffKeyword, p, t, (bd.activeRound ?? 0) === 1 ? 1 : 0);
    },
  },
  // BuffAbility_LoseAllStackOnBattleEnd: remove all stacks at battle end.
  {
    name: "LoseAllStackOnBattleEnd",
    summary: "战斗结束时解除本状态",
    onRoundEnd(c: AbilityCtx) {
      if (c.status.potency > 0) c.lose(c.side, c.status.id, c.status.potency);
    },
  },
  // BuffAbility_DefaultAtkSkillAtkDamageMultiplierByStackWithLimit_<L>: default (non-defense) attack skill of matching atk type →
  // min(stack × value, L%).
  {
    name: /^DefaultAtkSkillAtkDamageMultiplierByStackWithLimit_(\d+)$/,
    summary: "基础攻击技能(指定攻击类型)每层伤害+value(有上限)",
    coinMods(c: AbilityCtx) {
      if (c.side !== "actor" || !isBasic(c)) return;
      const atk = (c.ability as { atk?: string }).atk;
      if (atk && c.skill?.atkType !== atk) return;
      const v = Math.min(c.status.potency * (c.ability.value ?? 0), num(/_(\d+)$/, c.ability.ability) * 0.01);
      if (v > 0) return { dmg: v };
    },
  },
  noDamageAbility("DefenseParryingReducerWindBladeIshmael_2_1_5", "守备技能拼点威力降低"),
);
