/** Script/status batch 05 — see data/il2cpp/dossiers/scripts-05.md */
import { triggerVibrationExplosion } from "../status";
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

type BD = NonNullable<ScriptData["buffData"]>;
type Side = "actor" | "target";

const BLADE_LINEAGE = [10103, 10208, 10308, 10508, 10815, 11002, 11102];

function bdOf(c: ScriptCtx): BD {
  return c.script.buffData ?? {};
}
/** Resolve a buffData owner/target string ("Self"/"Target"/"") to a side; default given. */
function sideOf(who: string | undefined, def: Side): Side {
  if (who === "Self") return "actor";
  if (who === "Target" || who === "EveryEnemy") return "target";
  return def;
}
function box(c: PassiveCtx, s: Side) {
  return s === "actor" ? c.actor : c.target;
}
/** GiveBuff with raw buffData amounts (stack → potency, turn → count). */
function giveBd(c: PassiveCtx, bd: BD, def: Side, potency = bd.stack ?? 0, count = bd.turn ?? 0): void {
  if (!bd.buffKeyword || (potency <= 0 && count <= 0)) return;
  c.give(sideOf(bd.target, def), bd.buffKeyword, Math.max(0, potency), Math.max(0, count), (bd.activeRound ?? 0) === 1 ? 1 : 0);
}
function isBasic(c: PassiveCtx): boolean {
  const s = c.skill?.slot;
  return s === "S1" || s === "S2" || s === "S3";
}
function curHpPct(c: PassiveCtx): number {
  return 100 - c.battle.lostHpPct;
}

/** Cross-script records within one skill use (coin-scope hooks only see their own coin). */
/** c.action.shared keys: coin indices that hit on heads (CoinAbility_OnSucceedAttackHead); Vibration potency used by this use's coin effect (10309_base). */
const HEAD_COINS = "OnSucceedAttackHead:coins";
const VIB_USED = "10309:vibUsed";

/**
 * Ally pick for "lowest Breath ally" effects (GetAliveListExceptAbnormalitySelf + sort by Breath).
 * Ally Breath is unknown: assume declared allies (Breath 0) are picked first; self is picked only when fewer than `n` allies are declared.
 */
function selfPicked(c: PassiveCtx, n: number): boolean {
  return c.battle.allies.length < n;
}

registerScripts(
  // SkillAbility_CoinScaleAdderViaSelfBreathAndBuffCheck.CheckDivide: (self Breath + owner kw) stack/bd.stack + turn/bd.turn;
  // _Divide.CalculateCoinScaleAdder: divide × IntegerValue, capped by limit.
  {
    name: "CoinScaleAdderViaSelfBreathAndBuffDivide",
    summary: "自身呼吸法强度与目标指定状态强度之和每满N级，硬币威力+value(有上限)",
    coinMods(c) {
      const bd = bdOf(c);
      if (!bd.buffKeyword) return;
      const o = box(c, sideOf(bd.buffOwner, "target"));
      const p = c.actor.getPotency("Breath") + o.getPotency(bd.buffKeyword);
      const t = c.actor.getCount("Breath") + o.getCount(bd.buffKeyword);
      const div = ((bd.stack ?? 0) > 0 ? Math.floor(p / bd.stack!) : 0) + ((bd.turn ?? 0) > 0 ? Math.floor(t / bd.turn!) : 0);
      let v = div * (bd.value ?? 1);
      if ((bd.limit ?? 0) > 0) v = Math.min(v, bd.limit!);
      if (v > 0) return { coinScale: v };
    },
  },
  // SkillAbility_CriticalDmgUpIndexMark.GetAttackDmgMultiplier: crit && action has IndexPrescriptTargetMark system ability → +value.
  {
    name: "CriticalDmgUpIndexMark",
    summary: "本技能被指令标记时，暴击伤害+value",
    approx: "指令标记按“基础技能均已被标记”假设（与食指被动处理一致）",
    coinMods(c) {
      if (c.isCritical && isBasic(c)) return { dmg: c.script.value ?? 0 };
    },
  },
  // CoinAbility_DmgUpByBuffStack: floor(stack/bd.stack)×bd.value, cap limit%; _1021403: stack ≥ N (name suffix) → + jsonValue.
  {
    name: /^DmgUpByBuffStack1021403_(\d+)$/,
    summary: "自身每有1层指令加护，本硬币伤害+5%(最多40%)；加护达到N层时改为+60%",
    coinMods(c) {
      const bd = bdOf(c);
      if (!bd.buffKeyword) return;
      const n = Number(/_(\d+)$/.exec(c.script.scriptName)![1]);
      const st = box(c, sideOf(bd.buffOwner, "actor")).getPotency(bd.buffKeyword);
      if (st < Math.max(1, bd.stack ?? 1)) return;
      let d = Math.floor(st / Math.max(1, bd.stack ?? 1)) * (bd.value ?? 0);
      if ((bd.limit ?? 0) > 0) d = Math.min(d, bd.limit! * 0.01);
      if (st >= n) d += c.script.value ?? 0;
      return { dmg: d };
    },
  },
  // SkillAbility_GiveBuffOnUseAddStackByBlessingOfIndex.OnStartTurn_BeforeLog: stack = floor(Blessing / jsonValue)×IntegerValue + bd.stack, turn = bd.turn.
  {
    name: "GiveBuffOnUseAddStackByBlessingOfIndex",
    summary: "使用时获得呼吸法层数，并按指令加护层数/3增加呼吸法强度",
    skillMods(c) {
      const bd = bdOf(c);
      const bless = c.actor.getPotency("BlessingOfIndexPrescriptAlly");
      let add = Math.floor(bless / Math.max(1, c.script.value ?? 1)) * (bd.value ?? 1);
      if ((bd.limit ?? 0) > 0) add = Math.min(add, bd.limit!);
      giveBd(c, bd, "actor", add + (bd.stack ?? 0), bd.turn ?? 0);
    },
  },
  // SkillAbility_RingFingerBodyOnUseBuffTier3Shared(1021503): if Charge(Body Art) count ≥ bd.turn → use min(count, limit);
  // GetSkillPowerResultAdder = Round(jsonValue); GetAttackDamageMultiplier = used × bd.value (DIVIDE_TURN 1). 1021503: no SuperCoin, no target adder.
  {
    name: "RingFingerBodyOnUseBuff1021503",
    summary: "充能(体术)不低于10层时消耗至多20层：最终威力+2，每消耗1层伤害+3%",
    skillMods(c) {
      const bd = bdOf(c);
      const kw = bd.buffKeyword ?? "Charge";
      const cnt = c.actor.getCount(kw);
      if (cnt < (bd.turn ?? 0) || cnt <= 0) return;
      const use = (bd.limit ?? 0) > 0 ? Math.min(cnt, bd.limit!) : cnt;
      c.actor.consumeCount(kw, use);
      c.note(`消耗 ${use} 层${kw}`);
      return { finalPower: Math.round(c.script.value ?? 0), dmg: use * (bd.value ?? 0) };
    },
  },
  // SkillAbility_RingFingerBodyOnUseBuffTier2Shared: count ≥ bd.turn → use IntegerValue(5) Charge; clash power +jsonValue, last coin → SuperCoin.
  {
    name: "RingFingerBodyOnUseBuffTier2Shared",
    summary: "充能(体术)不低于10层时消耗5层：拼点威力+1，最后一枚硬币转为[SuperCoin]",
    approx: "拼点威力不影响单方面攻击；[SuperCoin]（必定正面）未单独建模，按模拟的硬币正反处理",
    skillMods(c) {
      const bd = bdOf(c);
      const kw = bd.buffKeyword ?? "Charge";
      const cnt = c.actor.getCount(kw);
      if (cnt < (bd.turn ?? 0) || cnt <= 0) return;
      const use = Math.min(cnt, Math.max(1, bd.value ?? 1));
      c.actor.consumeCount(kw, use);
      c.note(`消耗 ${use} 层${kw}`);
    },
  },
  // SkillAbility_1030203: Charge count ≥ 10 → UseBuffTurn 10, coin scale +4; else lose 20% HP (self).
  {
    name: "1030203",
    summary: "充能不低于10层时消耗10层并使硬币威力+4，否则失去20%体力",
    approx: "充能不足时自身失去体力未计入",
    skillMods(c) {
      if (c.actor.getCount("Charge") >= 10) {
        c.actor.consumeCount("Charge", 10);
        c.note("消耗10层充能");
        return { coinScale: 4 };
      }
      c.note("充能不足10层：自身失去20%体力（未计入）");
    },
  },
  // SkillAbility_GiveBuffOnUseIfUnderPercentHpSelf<N>: on use, if own HP ratio < N% → GiveBuff(buffData).
  {
    name: /^GiveBuffOnUseIfUnderPercentHpSelf(\d+)$/,
    summary: "使用时若现存体力低于N%，施加buffData状态",
    skillMods(c) {
      const n = Number(/(\d+)$/.exec(c.script.scriptName)![1]);
      if (curHpPct(c) < n) giveBd(c, bdOf(c), "actor");
    },
  },
  // CoinAbility_GiveBuffOnSucceedAttackHeadIfHasStack: heads hit && buffOwner's <Kw> stack ≥ N → GiveBuff(buffData).
  {
    name: /^GiveBuffOnSucceedAttackHeadIfHasStack_([A-Za-z]+?)(\d+)$/,
    summary: "正面命中时，若指定单位的条件状态层数不低于N，施加buffData状态",
    onCoinHit(c) {
      if (!c.isHeads) return;
      const m = /_([A-Za-z]+?)(\d+)$/.exec(c.script.scriptName)!;
      const bd = bdOf(c);
      if (box(c, sideOf(bd.buffOwner, "target")).getPotency(m[1]!) >= Number(m[2])) giveBd(c, bd, "target");
    },
  },
  {
    // CoinAbility_GiveBuffOnSucceedAttackAfterWinDuel: on hit, only when this skill won its clash → GiveBuff(bd).
    name: "GiveBuffOnSucceedAttackAfterWinDuel",
    summary: "拼点胜利后命中时施加 buffData 状态",
    approx: "仅在可选敌方行动模型（拼点胜利）下触发",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (c.duelResult?.() !== "win" || !bd?.buffKeyword || ((bd.stack ?? 0) <= 0 && (bd.turn ?? 0) <= 0)) return;
      c.give(bd.target === "Self" ? "actor" : "target", bd.buffKeyword, Math.max(0, bd.stack ?? 0), Math.max(0, bd.turn ?? 0), bd.activeRound === 1 ? 1 : 0);
    },
  },
  // SkillAbility_1030602_1/_4 (and 1030603_4).GetSkillLevelAdder: min(maxPerfectResonance / DIVIDE, MAX); envy ×(1+MUL_IF_VIOLET); ≤7-unit encounter ×2.
  ...["1030602_4", "1030603_4"].map((name) => ({
    name,
    summary: "按最大完全共鸣数/2增加攻击等级（最多6）",
    approx: "完全共鸣的罪孽种类未知，嫉妒共鸣+50%未计；集中遭遇战(人数上限≤7)翻倍未计",
    skillMods(c: ScriptCtx) {
      const n = Math.min(Math.floor((c.battle.perfectResonance ?? 0) / 2), 6);
      if (n > 0) return { offense: n };
    },
  })),
  noDamageScript("HealMpLowetMpAllyOnKT6", "击杀时为理智最低友方回复理智"),
  // CoinAbility_GiveBuffOnSAIfTurnNotGreaterThan(_<Kw><N>): on hit, buffOwner's <Kw> count ≤ N → GiveBuff(buffData).
  {
    name: /^GiveBuffOnSAIfTurnNotGreaterThan_([A-Za-z]+?)(\d+)$/,
    summary: "命中时若目标条件状态层数不高于N，施加buffData状态",
    onCoinHit(c) {
      const m = /_([A-Za-z]+?)(\d+)$/.exec(c.script.scriptName)!;
      const bd = bdOf(c);
      if (box(c, sideOf(bd.buffOwner, "target")).getCount(m[1]!) <= Number(m[2])) giveBd(c, bd, "target");
    },
  },
  // CoinAbility_MLD<N>: OnSucceedAttack checks own HP ratio < N% → CheckReRoll true (once).
  {
    name: /^MLD(\d+)$/,
    summary: "现存体力低于N%时重复使用本硬币1次",
    rerolls(c) {
      const n = Number(/(\d+)$/.exec(c.script.scriptName)![1]);
      return curHpPct(c) < n ? 1 : 0;
    },
  },
  // CoinAbility_1030802_2: crit hit → lowest-Breath ally gains bd.stack Breath potency (+bd.value if BLADE_LINEAGE).
  {
    name: "1030802_2",
    summary: "暴击命中时使呼吸法最低的1名友方增加2级呼吸法强度（剑契组再+2）",
    approx: "友方呼吸法未知：仅在未声明队友时由自身获得",
    onCoinHit(c) {
      if (!c.isCritical || !selfPicked(c, 1)) return;
      const bd = bdOf(c);
      const add = (bd.stack ?? 0) + (BLADE_LINEAGE.includes(c.identityId) ? bd.value ?? 0 : 0);
      if (add > 0) c.give("actor", bd.buffKeyword ?? "Breath", add, 0);
    },
  },
  // CoinAbility_1030803_3_1: crit hit → 2 lowest-Breath allies gain bd.turn Breath count (+IntegerValue if BLADE_LINEAGE).
  {
    name: "1030803_3_1",
    summary: "暴击命中时使呼吸法最低的2名友方获得2层呼吸法（剑契组再+2）",
    approx: "友方呼吸法未知：声明队友少于2名时自身也会被选中",
    onCoinHit(c) {
      if (!c.isCritical || !selfPicked(c, 2)) return;
      const bd = bdOf(c);
      const add = (bd.turn ?? 0) + (BLADE_LINEAGE.includes(c.identityId) ? bd.value ?? 0 : 0);
      if (add > 0) c.give("actor", bd.buffKeyword ?? "Breath", 0, add);
    },
  },
  noDamageScript("1030803_3_3", "击杀目标时下回合使自身与1名友方获得斩击伤害强化（击杀不在模拟中发生）"),
  // CoinAbility_OnSucceedAttackHead: flags the coin when it hits on heads (read by atkDmgMultiplier…areHead).
  {
    name: "OnSucceedAttackHead",
    summary: "记录正面命中的硬币（供最后一枚硬币增伤判定）",
    onCoinHit(c) {
      let set = c.action.shared.get(HEAD_COINS) as Set<number> | undefined;
      if (c.coinIndex === 0 || !set) c.action.shared.set(HEAD_COINS, (set = new Set()));
      if (c.isHeads && c.coinIndex != null) set.add(c.coinIndex);
    },
  },
  // CoinAbility_atkDmgMultiplierdonkitoareHead: (#coins a..b flagged by OnSucceedAttackHead) × N × 0.01.
  {
    name: /^atkDmgMultiplier(\d+)donki(\d+)to(\d+)areHead$/,
    summary: "第a~b枚硬币每有1枚正面命中，本硬币伤害+N%",
    coinMods(c) {
      const m = /^atkDmgMultiplier(\d+)donki(\d+)to(\d+)areHead$/.exec(c.script.scriptName)!;
      const set = c.action.shared.get(HEAD_COINS) as Set<number> | undefined;
      if (!set) return;
      let n = 0;
      for (let i = Number(m[2]); i <= Number(m[3]); i++) if (i !== c.coinIndex && set.has(i)) n++;
      if (n > 0) return { dmg: n * Number(m[1]) * 0.01 };
    },
  },
  // CoinAbility_1030901_1_1(_gaksung4th) / 1030902: target has Vibration → use ≤limit potency; self gains used×2 Vibration count;
  // 1030902: next turn target Binding (used−1).
  {
    name: "1030902_1_1_gaksung4th",
    summary: "命中时消耗目标至多3级震颤强度，自身获得(消耗量×2)层震颤，下回合对目标施加(消耗量-1)层束缚",
    onCoinHit(c) {
      c.action.shared.set(VIB_USED, 0);
      const bd = bdOf(c);
      const p = c.target.getPotency("Vibration");
      if (p <= 0) return;
      const n = (bd.limit ?? 0) > 0 ? Math.min(p, bd.limit!) : p;
      c.lose("target", "Vibration", n);
      c.action.shared.set(VIB_USED, n);
      c.give("actor", "Vibration", 0, n * 2);
      if (n - 1 > 0) c.give("target", "Binding", n - 1, 0, 1);
    },
  },
  noDamageScript("10309_base", "记录本技能消耗的震颤强度（供其他硬币效果判定）"),
  noDamageScript("AddTauntOSA4", "命中时下回合增加行动槽挑衅值"),
  // CoinAbility_SwitchVibrationOnSucceedAttackIfFasterThanTarget: own speed > target speed → SwitchTargetVibrationToSpecial(bd keyword).
  {
    name: "SwitchVibrationOnSucceedAttackIfFasterThanTarget",
    summary: "命中时若目标速度低于自身，使目标震颤转换为指定特殊震颤",
    approx: "特殊震颤自身的额外效果按其状态定义处理",
    onCoinHit(c) {
      const kw = bdOf(c).buffKeyword;
      if (!kw || !(c.battle.targetSpeed < c.battle.selfSpeed)) return;
      if (c.target.convert("Vibration", kw)) c.note(`目标震颤转换为${kw}`);
    },
  },
  // CoinAbility_TCorpDonQuixoteSecondSkillSecondCoinAbility<i>And<n>: this skill's coin effect used ≥ n Vibration → Explosion + lose 1 Vibration count.
  {
    name: /^TCorpDonQuixoteSecondSkillSecondCoinAbility(\d+)And(\d+)$/,
    summary: "若本技能的硬币效果消耗了目标的震颤强度，则使其震颤爆发并使震颤层数-1",
    onCoinHit(c) {
      const m = /And(\d+)$/.exec(c.script.scriptName)!;
      if (((c.action.shared.get(VIB_USED) as number | undefined) ?? 0) < Number(m[1])) return;
      const rec = triggerVibrationExplosion(c.target, c.turn, "硬币效果：震颤爆发");
      if (rec?.hpDamage) c.extraDamage(rec.hpDamage, rec.sourceDesc);
      else if (rec) c.note("目标震颤爆发");
      c.target.consumeCount("Vibration", 1, false);
    },
  },
  // CoinAbility_TCorpDonQuixoteThirdSkillCoinAbility(_<Kw><N>): target <Kw> potency ≥ N → (unless self has TimeRentalTwoPersonality) use N, give buffData.
  {
    name: /^TCorpDonQuixoteThirdSkillCoinAbility_([A-Za-z]+?)(\d+)$/,
    summary: "命中时若目标震颤强度不低于10级，消耗10级（带有时间租赁时不消耗）并施加2层时停",
    onCoinHit(c) {
      const m = /_([A-Za-z]+?)(\d+)$/.exec(c.script.scriptName)!;
      const n = Number(m[2]);
      if (c.target.getPotency(m[1]!) < n) return;
      if (!c.actor.get("TimeRentalTwoPersonality")) c.lose("target", m[1]!, n);
      giveBd(c, bdOf(c), "target");
    },
  },
  noDamageScript("103100101", "命中时按造成体力伤害的比例回复自身体力"),
  noDamageScript("AddBloodDinnerOnKillTarget60", "击杀目标时获得血宴（击杀不在模拟中发生）"),
  noDamageScript("GiveBuffOnKillMainTarget", "击杀主要目标时施加状态（击杀不在模拟中发生）"),
  // SkillAbility_GiveBuffOnUseWithBloodDinner(GainBuffStackIfFailed)_<Kw><N>[a:b:c]: use BloodDinner (≥a, ≤b, per c) → give buffData × units;
  // FailToUseBloodDinner → self gains <Kw> N potency.
  {
    name: /^GiveBuffOnUseWithBloodDinnerGainBuffStackIfFailed_([A-Za-z]+?)(\d+)\[(\d+):(\d+):(\d+)\]$/,
    summary: "使用时消耗至多50层血宴，每10层获得1层血铠；未消耗时自身增加N级指定状态强度",
    approx: "血宴用量参数[a:b:c]按[最低:最多:每份]解读，只消耗能换算的整份",
    skillMods(c) {
      const m = /_([A-Za-z]+?)(\d+)\[(\d+):(\d+):(\d+)\]$/.exec(c.script.scriptName)!;
      const [min, max, per] = [Number(m[3]), Number(m[4]), Math.max(1, Number(m[5]))];
      const have = c.actor.getPotency("BloodDinner");
      const units = have >= min ? Math.floor(Math.min(have, max) / per) : 0;
      if (units > 0) {
        c.lose("actor", "BloodDinner", units * per);
        const bd = bdOf(c);
        giveBd(c, bd, "actor", units * (bd.stack ?? 1), bd.turn ?? 0);
      } else {
        c.give("actor", m[1]!, Number(m[2]), 0);
      }
    },
  },
);

/** GiveBuffOnRoundStart give with owner stack `st`; returns whether anything was given. */
function roundStartGive(c: AbilityCtx, st: number, activeRound: 0 | 1): boolean {
  const bd = c.ability.buffData!;
  const mul = c.ability.value ?? 1;
  const p = (bd.stack ?? 0) < 0 ? Math.round(st * mul) : bd.stack ?? 0;
  const t = (bd.turn ?? 0) < 0 ? Math.round(st * mul) : bd.turn ?? 0;
  if (p <= 0 && t <= 0) return false;
  const other: Side = c.side === "actor" ? "target" : "actor";
  c.give(bd.target === "Target" ? other : c.side, bd.buffKeyword!, p, t, activeRound);
  return true;
}

registerAbilities(
  noDamageAbility("BlessingOfIndexPrescriptEffect", "获得指令加护时的特效"),
  // BuffAbility_GiveBuffOnRoundStart.OnRoundStart_After_Event: GiveBuff_ByBuff(buffData); negative stack/turn → Round(status stack × value).
  // DECISION (s04/s05 conflict): single implementation here, merging both. The s04 approach (queue a next-round give at round end using
  // the stack projected after the status' own LoseStackOnRoundEndByRatio) keeps the round-start timing (buff already present at skill
  // start) and is used for turns ≥ 2; the s05 approach (give before the first coin of the turn with the live stack) is kept only as a
  // fallback for turns where no round-end give was queued (turn 1 with initial statuses — OnRoundStart fires on turn 1 in game).
  {
    name: "GiveBuffOnRoundStart",
    summary: "回合开始时由状态施加buffData状态（负数数值按持有层数×value）",
    // OnRoundStart_After_Event: real round-start hook (live stack, after the status' own round-end loss; turn 1 included).
    onRoundStart(c: AbilityCtx) {
      if (!c.ability.buffData?.buffKeyword) return;
      c.state.set(`rs:${c.turn}`, 1);
      roundStartGive(c, c.status.potency, 0);
    },
    // Turn 1: statuses given by stage-start passives (run after the engine's turn-1 round start) still get their round-start give.
    coinMods(c: AbilityCtx) {
      if (c.turn !== 1 || c.state.get("rs:1") || !c.ability.buffData?.buffKeyword) return;
      c.state.set("rs:1", 1);
      roundStartGive(c, c.status.potency, 0);
    },
  },
  {
    name: "AddShieldOnRoundStartByCurrentHpRatio",
    summary: "回合开始时获得现存体力×value的护盾",
    approx: "护盾未建模：若持有者为目标，实际体力伤害会被护盾吸收",
  },
  noDamageAbility("IronMaidenPersonality", "受到攻击者最后一枚硬币攻击时反伤并施加流血（受击触发）"),
);
