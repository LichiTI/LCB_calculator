/** Script/status batch 15 — see data/il2cpp/dossiers/scripts-15.md */
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

/** 10416 (黑派) receives Charge as ChargeNoirAlly (subIdList contains Charge). */
const kwFor = (c: PassiveCtx, kw: string) =>
  kw === "Charge" && (c.actor.get("ChargeNoirAlly") || c.identityId === 10416) ? "ChargeNoirAlly" : kw;
const sideOf = (c: PassiveCtx, who?: string) => (who === "Target" ? c.target : c.actor);
const giveBD = (c: PassiveCtx, bd: BD | undefined, stack = bd?.stack ?? 0, turn = bd?.turn ?? 0) => {
  if (!bd?.buffKeyword || (stack <= 0 && turn <= 0)) return;
  const side = bd.target === "Self" ? "actor" : "target";
  c.give(side, side === "actor" ? kwFor(c, bd.buffKeyword) : bd.buffKeyword, stack, turn, bd.activeRound ? 1 : 0);
};
const nameInts = (n: string) => (n.match(/\d+/g) ?? []).map(Number);

/** One Vibration explosion on the target: stagger shift only, except VibrationIgnition which deals HP damage. */
const explode = (c: PassiveCtx, desc: string): boolean => {
  const rec = triggerVibrationExplosion(c.target, c.turn, desc);
  if (!rec) return false;
  if (rec.hpDamage > 0) c.extraDamage(rec.hpDamage, rec.sourceDesc);
  else c.note(`${desc}：震颤引爆（混乱阈值前移 ${rec.staggerShift}）`);
  return true;
};

/** NiddlePinAlly losing `n` stacks: NiddlePinAllyGivebuff (Laceration n×1 on holder) + NiddlePinAllyGiveDmg (n×3 SCARLET dmg). */
const niddlePinLost = (c: PassiveCtx, n: number, lacPer = 1, dmgPer = 3) => {
  if (n <= 0) return;
  c.give("target", "Laceration", n * lacPer, 0, 0);
  const dmg = Math.trunc(n * dmgPer);
  if (dmg > 0) c.extraDamage(dmg, `针刺失去${n}层（每层${dmgPer}点暴怒属性伤害）`, { sin: "SCARLET" });
};

interface CoinData {
  abilityScriptList?: ScriptData[];
}

registerScripts(
  {
    // CoinAbility_GiveBuffOnSucceedAttack1071603_<a>_<b>_<c>_<d>: SystemAbility_Skill1071603 (506) 层数≥1/2/3/4 时
    // 对震颤/烧伤的强度与层数各加 a/b/c/d。系统能力层数对应目标的 DuelEdgeAlly 层数（描述）。
    name: /^GiveBuffOnSucceedAttack1071603(?:_\d+){4}$/,
    summary: "命中施加buffData；按目标[DuelEdgeAlly]层数(≥1/2/3/4)各额外+强度/层数",
    approx: "SystemAbility_Skill1071603 层数按目标[DuelEdgeAlly]层数近似",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!bd) return;
      const adds = nameInts(c.script.scriptName).slice(1);
      const lv = c.target.getPotency("DuelEdgeAlly");
      let bonus = 0;
      adds.forEach((v, i) => {
        if (lv >= i + 1) bonus += v;
      });
      giveBD(c, bd, (bd.stack ?? 0) + bonus, (bd.turn ?? 0) + bonus);
    },
  },
  {
    // SkillAbility_SkillTier3EffectOnSetTarget10716.OnSetTarget: skill 1071603 && target DuelEdgeAlly(1833) = 5 → action system ability
    // BAS_SkillTier3Effect10716 + portrait effect only (UI). The actual swap to 1071606 is ChangeToSpecialSkillOnBeforeTurn1071606 (batch-s14).
    name: "SkillTier3EffectOnSetTarget10716",
    summary: "目标[DuelEdgeAlly]达5层时显示技能强化特效（实际替换由 ChangeToSpecialSkillOnBeforeTurn1071606 处理，不影响本次伤害）",
  },
  {
    // CoinAbility_VibrationExplosionOnSucceedAttack10716: 目标 DuelEdgeAlly≥bd.stack 或自身有 EvolvingManual(1835)
    // → 引爆 Round(value) 次，否则 1 次；每次引爆后目标震颤层数减少（bd.value，默认1）。
    name: "VibrationExplosionOnSucceedAttack10716",
    summary: "命中引爆震颤（满足[DuelEdgeAlly]/[EvolvingManual]条件时引爆value次），每次减少震颤层数",
    onCoinHit(c) {
      const bd = c.script.buffData;
      const cond =
        c.target.getPotency("DuelEdgeAlly") >= (bd?.stack ?? 1) || c.actor.getPotency("EvolvingManual") > 0;
      const times = cond ? Math.max(1, Math.round(c.script.value ?? 1)) : 1;
      for (let i = 0; i < times; i++) {
        if (!explode(c, "VibrationExplosionOnSucceedAttack10716")) break;
        c.consume("target", "Vibration", bd?.value ?? 1);
      }
    },
  },
  {
    // SkillAbility_FillBuffTurnWithMaxHpCostOnUse: 自身 Charge 层数 ≥ bd.value 且 < bd.turn → 补满到 turn，
    // 自损 缺少量×value(0.02)×最大体力。
    name: "FillBuffTurnWithMaxHpCostOnUse",
    summary: "使用时消耗体力将充能层数补到turn",
    approx: "自身体力消耗未建模（不影响伤害）",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.turn) return;
      const id = kwFor(c, bd.buffKeyword ?? "Charge");
      const cur = c.actor.getCount(id);
      if (cur < (bd.value ?? 0) || cur >= bd.turn) return;
      c.give("actor", id, 0, bd.turn - cur, 0);
    },
  },
  {
    // CoinAbility_GiveBuffOnSAAddStackByBuffStackDivide_NeedlekinAlly<D>: stack = floor(自身NeedlekinAlly/D)×value (limit)
    name: /^GiveBuffOnSAAddStackByBuffStackDivide_NeedlekinAlly(\d+)$/,
    summary: "命中按自身[NeedlekinAlly]层数对目标施加[NiddlePinAlly]",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!bd) return;
      const div = Number(/(\d+)$/.exec(c.script.scriptName)?.[1] ?? 1) || 1;
      let n = Math.floor(sideOf(c, bd.buffOwner || "Self").getPotency("NeedlekinAlly") / div) * (bd.value ?? 1);
      if ((bd.limit ?? 0) > 0) n = Math.min(n, bd.limit!);
      giveBD(c, bd, (bd.stack ?? 0) + n, bd.turn ?? 0);
    },
  },
  {
    // CoinAbility_GiveBuffOnSAOnce1071703: 每次技能限1次，命中给自身 Charge。
    name: "GiveBuffOnSAOnce1071703",
    summary: "每次技能限1次：命中时获得充能",
    onCoinHit(c) {
      const key = `GiveBuffOnSAOnce1071703:${c.turn}:${c.skill?.id}`;
      if (c.state.get(key)) return;
      c.state.set(key, 1);
      giveBD(c, c.script.buffData);
    },
  },
  {
    // CoinAbility_GiveBuffOnSAViaSpecialLacerationSum1071703_<N>: 目标 NiddlePinAlly ≥ N → LoseBuffStack N，
    // 并施加 buffData (NiddlePinnedAlly 1, activeRound 1)。失去层数触发 NiddlePinAlly 的失层效果。
    name: /^GiveBuffOnSAViaSpecialLacerationSum1071703_(\d+)$/,
    summary: "目标[NiddlePinAlly]≥N层时使其失去N层（触发针刺效果）并施加[NiddlePinnedAlly]",
    onCoinHit(c) {
      const n = Number(/(\d+)$/.exec(c.script.scriptName)?.[1] ?? 5);
      if (c.target.getPotency("NiddlePinAlly") < n) return;
      c.lose("target", "NiddlePinAlly", n);
      niddlePinLost(c, n);
      giveBD(c, c.script.buffData);
    },
  },
  {
    // CoinAbility_GivePenetrateDmgByNeedlekinRatio1071701: 自身 NeedlekinAlly(2130)>0 →
    // max(1, trunc(本硬币伤害×层数×value)) 穿刺伤害（GiveHpDamageAppliedAtkResist）。
    name: "GivePenetrateDmgByNeedlekinRatio1071701",
    summary: "命中按本硬币伤害×[NeedlekinAlly]层数×1%追加穿刺伤害",
    onCoinHit(c) {
      const n = c.actor.getPotency("NeedlekinAlly");
      if (n <= 0) return;
      const dmg = Math.max(1, Math.trunc((c.lastHitDamage ?? 0) * n * (c.script.value ?? 0.01)));
      c.extraDamage(dmg, `针刺追加穿刺伤害（${n}层）`, { atkType: "PENETRATE" });
    },
  },
  {
    // SkillAbility_UseAllChargeAndDinnerTurnOnUse1071703_<div>_<csMax>_<base>_<ratio%>_<max%>:
    // used = min(全部Charge, 20)；硬币威力 +min(floor(used/div), csMax)；伤害 +min((used-base)×ratio, max)。
    name: /^UseAllChargeAndDinnerTurnOnUse1071703(?:_\d+){5}$/,
    summary: "使用时消耗全部充能(最多20)：每7层硬币威力+1(最多+2)，每层伤害+2%(最多+40%)",
    approx: "晚宴力场(DinnerField)补充充能未建模",
    skillMods(c) {
      const [, div = 7, csMax = 2, base = 0, ratio = 2, max = 40] = nameInts(c.script.scriptName);
      const id = kwFor(c, "Charge");
      const used = Math.min(c.actor.getCount(id), 20);
      if (used <= 0) return;
      c.consume("actor", id, used);
      const coinScale = Math.min(Math.floor(used / (div || 1)), csMax);
      const dmg = used - base > 0 ? Math.min((used - base) * ratio * 0.01, max * 0.01) : 0;
      return { coinScale, dmg };
    },
  },
  {
    // SkillAbility_1080203_gaksung4th.OnCompleteCommand: 自身 Charge ≥ 8 → UseBuffTurn 8；否则随机选目标（无伤害影响）。
    name: "1080203_gaksung4th",
    summary: "战斗开始时消耗8层充能（不足时随机选目标）",
    skillMods(c) {
      const id = kwFor(c, "Charge");
      if (c.actor.getCount(id) >= 8) c.consume("actor", id, 8);
    },
  },
  noDamageScript("DamageFirstBreakSectionOnSuccessAttack1ByDamageRatio", "命中使目标混乱阈值前移本硬币伤害10%"),
  noDamageScript("DamageFirstBreakSectionOnSuccessAttack2ByDamageRatio", "命中使目标混乱阈值前移本硬币伤害20%"),
  noDamageScript("DamageFirstBreakSectionOnSuccessAttack3ByDamageRatio", "命中使目标混乱阈值前移本硬币伤害30%"),
  noDamageScript("DamageFirstBreakSectionOnSuccessAttack4ByDamageRatio", "命中使目标混乱阈值前移本硬币伤害40%"),
  {
    // SkillAbility_1080301(_gaksung4th).GetBuffStackAdder: 体力<50% 时本技能给予的呼吸法(43)强度 +_ADDED_STACK(3)。
    name: "1080301_gaksung4th",
    summary: "体力低于50%时本技能施加的呼吸法强度+3",
    onCoinHit(c) {
      if (c.battle.lostHpPct <= 50) return;
      const coins = (c.skillData as { coins?: CoinData[] } | undefined)?.coins;
      const list = coins?.[c.coinIndex ?? -1]?.abilityScriptList ?? [];
      const n = list.filter(
        (s) => s.scriptName === "GiveBuffOnSucceedAttack" && s.buffData?.buffKeyword === "Breath" && (s.buffData.stack ?? 0) > 0,
      ).length;
      if (n > 0) c.give("actor", "Breath", 3 * n, 0, 0);
    },
  },
  {
    // SkillAbility_1080302.OnStartTurn_BeforeLog: 体力<50% → CopyCoinModelAndAddToListByIndex(0), (1)。
    name: "1080302",
    summary: "体力低于50%时额外使用第1、2枚硬币各1次",
    onSkillStart(c) {
      if (c.selfHpRatio() >= 0.5) return;
      c.coins?.add({ copyOf: 0 });
      c.coins?.add({ copyOf: 1 });
    },
  },
  {
    // CoinAbility_VibrationExplosionOnSucceedAttackAndLoseTargetVibrationTurn<N> (attached to the coin added by
    // SkillAbility_11216AddCoinAndExplosionIfStigmaHand): on hit, target has Vibration → explode, then LoseBuffTurn(Vibration, N).
    name: /^VibrationExplosionOnSucceedAttackAndLoseTargetVibrationTurn(\d+)$/,
    summary: "命中引爆震颤，并使目标震颤层数减少N层",
    onCoinHit(c) {
      const n = Number(/Turn(\d+)$/.exec(c.script.scriptName)?.[1] ?? 0);
      if (!explode(c, c.script.scriptName)) return;
      if (n > 0) c.consume("target", "Vibration", n);
    },
  },
  {
    // CoinAbility_VibrationExplosionOnSucceedAttackThenLoseTargetVibrationTurn<N>ThenGiveBuff:
    // 目标有震颤 → 引爆；引爆时 LoseBuffTurn(Vibration, N)；随后施加 buffData。
    name: /^VibrationExplosionOnSucceedAttackThenLoseTargetVibrationTurn(\d+)ThenGiveBuff$/,
    summary: "命中引爆震颤，使目标震颤层数减少N层并施加buffData状态",
    onCoinHit(c) {
      const n = Number(/Turn(\d+)ThenGiveBuff$/.exec(c.script.scriptName)?.[1] ?? 0);
      if (!explode(c, c.script.scriptName)) return;
      if (n > 0) c.consume("target", "Vibration", n);
      giveBD(c, c.script.buffData);
    },
  },
  {
    // CoinAbility_GiveBuffOnSuccessAttackUsingBuffTurn: 自身震颤层数≥5 → UseBuffTurn(5) 并施加 buffData
    name: "GiveBuffOnSuccessAttackUsingBuffTurn_Vibration5",
    summary: "命中时消耗自身5层震颤并施加buffData状态",
    onCoinHit(c) {
      if (c.actor.getCount("Vibration") < 5) return;
      c.consume("actor", "Vibration", 5);
      giveBD(c, c.script.buffData);
    },
  },
  // SkillAbility_10808024_MAR_20_T (no ISIL dump): description — adjacent allies gain AttackDmgUp; orders the right-side ally to make a
  //   supportive attack. Modelled: first declared ally identity attacks with its tier-1 skill (once per use).
  {
    name: "10808024_MAR_20_T",
    summary: "两侧友方攻击提升/命令右侧友方援护攻击",
    approx: "类无 ISIL：按描述建模为第一名已声明队友（人格ID）以其1技能援护攻击；队友攻击提升未计入",
    onSkillEnd(c) {
      const a = (c.allyIdentities?.() ?? [])[0];
      if (a) c.allyAttack?.({ allyId: a.id, skillId: a.id * 100 + 1, key: `mar:${c.skill?.id}`, label: "援护攻击 ", perTurn: 3 });
    },
  },
  noDamageScript("1080802_4", "战斗开始时为两侧友方施加增益"),
  {
    // SkillAbility_10808031_<r>_<max>: 伤害 + min(目标已损失体力%×r×0.001, max×0.01)
    name: "10808031_3_30",
    summary: "目标每失去1%体力伤害+0.3%(最多30%)",
    approx: "已失去体力%按向下取整计算（ISIL 中取整函数未解析）",
    coinMods(c) {
      const d = Math.min(Math.floor(c.targetLostHpRatio() * 100 + 1e-9) * 3 * 0.001, 30 * 0.01);
      return d > 0 ? { dmg: d } : undefined;
    },
  },
  noDamageScript("10808034_2_10", "目标混乱/击杀时为友方恢复理智并施加呼吸法"),
  noDamageScript("10808044", "为友方增加嘲讽值/施加守护"),
  {
    // CoinAbility_1081003.OnAttackConfirmed: used = 自身全部震颤层数(UseBuffAllTurn)；目标震颤强度 + min(used, stack)；
    // GetAttackDmgMultiplier: min((used-stack)×value, limit×0.01)。
    name: "1081003",
    summary: "消耗自身全部震颤，使目标震颤强度增加(最多20)，溢出部分每层伤害+5%(最多50%)",
    coinMods(c) {
      const bd = c.script.buffData;
      if (!bd) return;
      const key = `1081003:${c.turn}:${c.skill?.id}:${c.ownerCoinIndex}`;
      let over = c.state.get(key);
      if (over == null) {
        const used = c.actor.getCount("Vibration");
        over = 0;
        if (used > 0) {
          c.consume("actor", "Vibration", used);
          c.give("target", "Vibration", Math.min(used, bd.stack ?? 20), 0, 0);
          over = Math.max(0, used - (bd.stack ?? 20));
        }
        c.state.set(key, over);
      }
      if (over > 0) return { dmg: Math.min(over * (bd.value ?? 0.05), (bd.limit ?? 50) * 0.01) };
    },
  },
  {
    // class unresolved — 按描述：使目标增加 min(floor(自身震颤层数/2)×stack, 4) 级震颤强度
    name: "GiveBuffOnSucceedAttackDevideByTurnWithLimit4_Vibration2",
    summary: "命中按自身震颤层数/2使目标增加震颤强度(最多4)",
    approx: "类未解析，按描述实现",
    onCoinHit(c) {
      const bd = c.script.buffData;
      const n = Math.min(Math.floor(c.actor.getCount("Vibration") / 2) * (bd?.stack ?? 1), 4);
      if (n > 0) c.give("target", "Vibration", n, 0, 0);
    },
  },
  {
    // class unresolved — 按描述：自身每2层震颤获得1层防御等级提升(最多3)
    name: "GiveBuffOnUsePerBuffTurn_Vibration2_Limit3",
    summary: "使用时自身每2层震颤获得1层防御等级提升(最多3层)",
    approx: "类未解析，按描述实现",
    skillMods(c) {
      const n = Math.min(Math.floor(c.actor.getCount("Vibration") / 2) * (c.script.buffData?.stack ?? 1), 3);
      if (n > 0) c.give("actor", "DefenseUp", n, 0, 0);
    },
  },
  {
    // class unresolved — 按描述：自身每2层震颤获得1层防御等级提升(最多5)
    name: "GiveBuffOnUsePerBuffTurn_Vibration2_Limit5",
    summary: "使用时自身每2层震颤获得1层防御等级提升(最多5层)",
    approx: "类未解析，按描述实现",
    skillMods(c) {
      const n = Math.min(Math.floor(c.actor.getCount("Vibration") / 2) * (c.script.buffData?.stack ?? 1), 5);
      if (n > 0) c.give("actor", "DefenseUp", n, 0, 0);
    },
  },
  {
    // SkillAbility_SkillPowerAdderOnUseViaBuffCheckDevideByStackWithLimit<N>.GetPowerAdder:
    //   min(N, floor(强度 / bd.stack) × bd.value) 基础威力
    name: /^SkillPowerAdderOnUseViaBuffCheckDevideByStackWithLimit(\d+)$/,
    summary: "按[buffKeyword]强度每满stack级基础威力+value(上限见脚本名)",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const limit = Number(/(\d+)$/.exec(c.script.scriptName)?.[1] ?? 0);
      const per = bd.stack && bd.stack > 0 ? bd.stack : 1;
      const v = Math.min(limit, Math.floor(sideOf(c, bd.buffOwner).getPotency(bd.buffKeyword) / per) * (bd.value ?? 1));
      if (v > 0) return { basePower: v };
    },
  },
  {
    // CoinAbility_ForceToActivateBuffOSAValueTimes: 重复 value 次：目标带有 kw → ForceToActivateSinBuffEffect，层数-turn
    name: "ForceToActivateBuffOSAValueTimes",
    summary: "命中时触发目标的指定状态value次，每次层数减少",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const times = Math.max(0, Math.round(c.script.value ?? 1));
      for (let i = 0; i < times; i++) {
        const p = c.target.getPotency(bd.buffKeyword);
        if (p <= 0 || c.target.getCount(bd.buffKeyword) <= 0) break;
        c.extraDamage(p, `强制触发${bd.buffKeyword}（第${i + 1}次）`);
        c.consume("target", bd.buffKeyword, Math.max(1, bd.turn ?? 1));
      }
    },
  },
  noDamageScript("GiveBuffOnBattleStartExceptSelf1081102_5", "战斗开始时为黑云会友方施加伤害强化"),
);

registerAbilities(
  {
    // BuffAbility_NiddlePinAllyGivebuff.RightAfterLosingBuff: 失去层数×stack 级流血施加给持有者。
    // 回合结束 LoseStackOnRoundEnd(1) 失层在此预先结算（onRoundEnd 早于衰减）。
    name: "NiddlePinAllyGivebuff",
    summary: "针刺失去层数时使持有者增加等量流血强度",
    onRoundEnd(c: AbilityCtx) {
      if (c.side !== "target") return;
      const n = Math.min(1, c.status.potency);
      if (n > 0) c.give("target", "Laceration", n * (c.ability.buffData?.stack ?? 1), 0, 0);
    },
  },
  {
    // BuffAbility_NiddlePinAllyGiveDmg.RightAfterLosingBuff: 失去层数×value(3) SCARLET 属性伤害。
    name: "NiddlePinAllyGiveDmg",
    summary: "针刺失去层数时每层造成3点暴怒属性伤害",
    onRoundEnd(c: AbilityCtx) {
      if (c.side !== "target") return;
      const n = Math.min(1, c.status.potency);
      const dmg = Math.trunc(n * (c.ability.value ?? 3));
      if (dmg > 0) c.extraDamage(dmg, `针刺回合结束失去${n}层`, { sin: "SCARLET" });
    },
  },
  noDamageAbility("NiddlePinAllyRoundEndActionFor11016", "回合结束时与11016辛克莱联动施加状态"),
);
