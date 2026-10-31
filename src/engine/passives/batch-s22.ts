/** Script/status batch 22 — see data/il2cpp/dossiers/scripts-22.md */
import { triggerVibrationExplosion, type StatusContainer } from "../status";
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

// Already covered elsewhere (not re-registered here):
//   GiveBuffOnSucceedAttackIfHasStack_{ReinforcedTattooSpiderOutis1,Laceration1,Laceration7,Sinking5} → batch-s03 RegExp family
//   GiveBuffOnSucceedAttackIfHasTurn_Vibration5 → batch-s01 RegExp family
// Statuses with an empty ability list (no logic to translate): LCA_Bullet, CountSkillMidOutis, Unjust_Enrichment.

interface SkillLike { coins?: { abilityScriptList?: ScriptData[] }[] }

const isDefaultSkill = (c: PassiveCtx): boolean => c.skill?.slot === "S1" || c.skill?.slot === "S2" || c.skill?.slot === "S3";

function vibrationExplosion(c: PassiveCtx, tag: string): boolean {
  const rec = triggerVibrationExplosion(c.target, c.turn, tag);
  if (!rec) return false;
  if (rec.hpDamage > 0) c.extraDamage(rec.hpDamage, `${tag}（震颤-灼热）`);
  else c.note(`${tag}：混乱阈值前移 ${rec.staggerShift}`);
  return true;
}

function perTurn(c: PassiveCtx, key: string, max = 1): boolean {
  const k = `${key}:${c.turn}`;
  const used = c.state.get(k) ?? 0;
  if (used >= max) return false;
  c.state.set(k, used + 1);
  return true;
}

// ---------------------------------------------------------------- LCA bullets (11114)
const LCA = "LCA_Bullet";
const lcaKey = (c: ScriptCtx) => `LCA_Bullet:used:${c.coinIndex ?? -1}`;

/**
 * LCA_Bullet consumed by UseBullet[necessary:LCA_Bullet:N] on the current coin (0 if none/insufficient); stored in c.action.shared.
 * Exported for DmgUpByBullet11114 ("本硬币伤害+消耗的LCA弹数×30%") and similar readers.
 */
export function lcaBulletsUsed(c: ScriptCtx): number {
  return (c.action.shared.get(lcaKey(c)) as number | undefined) ?? 0;
}

/** CoinModel.GetConsumeBulletCount over the skill's coins, limited sequentially by bullets held. */
function plannedBulletUse(c: ScriptCtx, keyword: string): number {
  let remain = c.actor.getPotency(keyword);
  let total = 0;
  for (const coin of (c.skillData as SkillLike)?.coins ?? []) {
    for (const s of coin.abilityScriptList ?? []) {
      const m = /^UseBullet\[necessary:([A-Za-z_]+):(\d+)\]$/.exec(s.scriptName);
      if (!m || m[1] !== keyword) continue;
      const need = Number(m[2]);
      if (remain >= need) {
        remain -= need;
        total += need;
      }
    }
  }
  return total;
}

registerScripts(
  noDamageScript("GetIsReloadedSkill11114", "记录本技能是否已触发装填（标记）"),
  // CoinAbility_LCAOutisVEOnSA (base VibrationExplosion): on hit, if the target has SP → VibrationExplosion + lose `value`
  // Vibration count; target SP < 0 → AzureTakeDamageUp 1 (once per turn). Base explosion comes from the coin's built-in script.
  {
    name: /^LCAOutisVEOnSA_AzureTakeDamageUp\d+$/,
    summary: "命中时若目标带有理智值，追加震颤引爆并使其震颤层数-1；目标理智<0时施加1层忧郁易损(每回合1次，理智取场景值)",
    onCoinHit(c) {
      if (!c.targetHasSp || (c.target.getPotency("Vibration") <= 0 && c.target.getCount("Vibration") <= 0)) return;
      vibrationExplosion(c, "LCA震颤引爆");
      c.consume("target", "Vibration", Math.max(1, Math.round(c.script.value ?? 1)));
      if (c.targetSp !== undefined && c.targetSp < 0 && c.state.get("azure") !== c.turn) {
        c.state.set("azure", c.turn);
        c.give("target", "AzureTakeDamageUp", Number(/(\d+)$/.exec(c.script.scriptName)![1]), 0);
      }
    },
  },
  // SkillAbility_ReloadOnEndAttack1111404_{max}: OnEndAttack LCA_Bullet ≤ value → TryReload (system ability 397, ≤ max per battle):
  // LoseBuffAllStack(LCA_Bullet) then refill.
  {
    name: /^ReloadOnEndAttack1111404_(\d+)$/,
    summary: "技能结束时LCA龟裂弹不高于2发则完全装填(每场战斗最多5次)",
    approx: "装填量按最大值16发",
    onSkillEnd(c) {
      if (c.scope !== "skill") return;
      const max = Number(/_(\d+)$/.exec(c.script.scriptName)![1]);
      const cur = c.actor.getPotency(LCA);
      if (cur > Math.round(c.script.value ?? 2) || (c.state.get("reloads") ?? 0) >= max) return;
      c.state.set("reloads", (c.state.get("reloads") ?? 0) + 1);
      if (cur < 16) c.give("actor", LCA, 16 - cur, 0);
      c.note("LCA龟裂弹完全装填");
    },
  },
  // SkillAbility_SkillPowerAdder11114: base power + Σ GetConsumeBulletCount of the skill's coins (bullets held permitting).
  {
    name: "SkillPowerAdder11114",
    summary: "本技能每将消耗1发LCA龟裂弹，基础威力+1",
    skillMods(c) {
      return { basePower: plannedBulletUse(c, LCA) };
    },
  },
  {
    name: "UseBullet[necessary:LCA_Bullet:2]",
    summary: "掷出硬币时消耗2发LCA龟裂弹；不足时硬币不发动",
    beforeCoin(c) {
      if (c.actor.getPotency(LCA) < 2) c.cancelCoin("LCA龟裂弹不足（需要2发）");
    },
    coinMods(c) {
      c.action.shared.set(lcaKey(c), 0);
      if (c.actor.getPotency(LCA) < 2) {
        c.note(`硬币${(c.coinIndex ?? 0) + 1}缺少LCA龟裂弹：实际不会发动`);
        return;
      }
      c.lose("actor", LCA, 2);
      c.action.shared.set(lcaKey(c), 2);
    },
  },
  // ---------------------------------------------------------------- 11115
  {
    // SkillAbility_ChangeToSuperCoinViaBuffCheckUnderIndex1111502.OnStartTurn_BeforeLog: own bd keyword stack ≥ bd.stack →
    //   from coin index (bd.value − 1) on, (stack) coins get CoinAbility_OverwriteToSuperCoin (clash-only).
    name: "ChangeToSuperCoinViaBuffCheckUnderIndex1111502",
    summary: "从第3枚硬币起使(强化纹身层数)枚硬币转化为[SuperCoin]（仅影响拼点）",
    onSkillStart(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword || !c.coins) return;
      const n = c.actor.getPotency(bd.buffKeyword);
      if (n <= 0 || n < (bd.stack ?? 1)) return;
      const from = Math.max(0, Math.round(bd.value ?? 3) - 1);
      for (let i = from; i < Math.min(c.coins.count, from + n); i++) c.coins.makeSuper(i);
    },
  },
  // SkillAbility_CoinScaleAdderCheckSumOfPerfectResonance_{ATTR}_{N}: ResonanceManager.GetSumOfPerfectResonance(ATTR) ≥ N → +value.
  {
    name: /^CoinScaleAdderCheckSumOfPerfectResonance_([A-Z]+)_(\d+)$/,
    summary: "指定属性完全共鸣数不低于N时硬币威力+value",
    approx: "引擎只有最长完全共鸣长度，不区分属性",
    skillMods(c) {
      const n = Number(/_(\d+)$/.exec(c.script.scriptName)![1]);
      if ((c.battle.perfectResonance ?? 0) >= n) return { coinScale: Math.round(c.script.value ?? 1) };
    },
  },
  // SkillAbility_CoinScaleAdderDivideBySumOfTwoBuffStack_{A}_{B}: (owner A + B potency) / bd.stack × value, max limit.
  {
    name: /^CoinScaleAdderDivideBySumOfTwoBuffStack_([A-Za-z]+)_([A-Za-z]+)$/,
    summary: "目标两种状态强度之和每N级，硬币威力+value(有上限)",
    skillMods(c) {
      const [, a, b] = /_([A-Za-z]+)_([A-Za-z]+)$/.exec(c.script.scriptName)!;
      const bd = c.script.buffData;
      const div = bd?.stack ?? 0;
      if (div <= 0) return;
      const o = bd?.buffOwner === "Self" ? c.actor : c.target;
      let v = Math.trunc((o.getPotency(a!) + o.getPotency(b!)) / div) * (bd?.value ?? 1);
      if ((bd?.limit ?? 0) > 0) v = Math.min(v, bd!.limit!);
      return { coinScale: v };
    },
  },
  noDamageScript("DamageFirstBreakSectionOnSuccessAttack5", "命中时使目标混乱阈值前移5"),
  // CoinAbility_GiveAdditionalAtkDmgOnSucceedAttack1111502_{A}_{B}_{ATK}: self bd keyword ≥ stack → extra dmg =
  // coin final dmg × min(limit, target A+B potency) × value(0.01).
  {
    name: /^GiveAdditionalAtkDmgOnSucceedAttack1111502_([A-Za-z]+)_([A-Za-z]+)_([A-Z]+)$/,
    summary: "带有强化纹身时，命中追加(目标烧伤+流血强度)%的本硬币最终伤害(最多20%)",
    approx: "追加伤害按向下取整",
    onCoinHit(c) {
      const [, a, b] = /_([A-Za-z]+)_([A-Za-z]+)_[A-Z]+$/.exec(c.script.scriptName)!;
      const bd = c.script.buffData;
      if (!bd?.buffKeyword || c.actor.getPotency(bd.buffKeyword) < (bd.stack ?? 1)) return;
      const pct = Math.min(bd.limit ?? 20, c.target.getPotency(a!) + c.target.getPotency(b!)) * (bd.value ?? 0.01);
      const dmg = Math.floor((c.lastHitDamage ?? 0) * pct);
      if (dmg > 0) c.extraDamage(dmg, "强化纹身追加伤害", { atkType: /_([A-Z]+)$/.exec(c.script.scriptName)![1] as import("../../config/game-data").AtkType });
    },
  },
  // SkillAbility_GiveBuffOnSuccedAttackIfHasSwordBuff11115: with sword buff (bd keyword) the skill's Laceration grants
  // (RightAfterGiveBuffBySkill, keyword 39) also give the same amount of Combustion (38).
  {
    name: "GiveBuffOnSuccedAttackIfHasSwordBuff11115",
    summary: "剑处于第二/第三阶段时，本技能命中施加流血时额外施加等量烧伤",
    approx: "仅镜像本硬币 GiveBuffOnSucceedAttack 的基础流血施加量",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword || !c.actor.get(bd.buffKeyword) || !isDefaultSkill(c)) return;
      const coin = (c.skillData as SkillLike)?.coins?.[c.coinIndex ?? -1];
      for (const s of coin?.abilityScriptList ?? []) {
        if (s.scriptName !== "GiveBuffOnSucceedAttack" || s.buffData?.buffKeyword !== "Laceration") continue;
        const st = s.buffData.stack ?? 0;
        const tu = s.buffData.turn ?? 0;
        if (st > 0 || tu > 0) c.give("target", "Combustion", st, tu, s.buffData.activeRound === 1 ? 1 : 0);
      }
    },
  },
  // SkillAbility_SkillLevelAdderOnStartTurnDivideByResonance_{limit}: offense level + min(limit, maxResonance / value).
  {
    name: /^SkillLevelAdderOnStartTurnDivideByResonance_(\d+)$/,
    summary: "使用时按(最大共鸣数/value)增加攻击等级(有上限)",
    skillMods(c) {
      const limit = Number(/_(\d+)$/.exec(c.script.scriptName)![1]);
      const max = Math.max(0, ...Object.values(c.battle.resonance ?? {}));
      const div = Math.max(1, c.script.value ?? 1);
      return { offense: Math.min(limit, Math.floor(max / div)) };
    },
  },
  // ---------------------------------------------------------------- 11204 / 11205
  noDamageScript("HealHpOnSucceedAttackViaBuffStackCheckByRatioMax20", "命中时按目标流血强度恢复体力"),
  // CoinAbility_1120503_1: on hit, target has Vibration → VibrationExplosion; on explosion: target Vibration count −2,
  // use up to 4 own Charge count and give the target that much Burst count.
  {
    name: "1120503_1",
    summary: "命中时震颤引爆，使目标震颤层数-2，并消耗最多4层充能对目标施加等量破裂层数",
    onCoinHit(c) {
      if (c.target.getPotency("Vibration") <= 0 && c.target.getCount("Vibration") <= 0) return;
      vibrationExplosion(c, "震颤引爆");
      c.consume("target", "Vibration", 2);
      const used = Math.min(4, c.actor.getCount("Charge"));
      if (used <= 0) return;
      c.consume("actor", "Charge", used);
      c.give("target", "Burst", 0, used);
    },
  },
  {
    name: "AttackDmgUpByRatio10IfBreak",
    summary: "目标陷入混乱时本硬币伤害+10%（需启用混乱模型）",
    coinMods(c) {
      if (c.targetStaggered?.()) return { dmg: 0.1 };
    },
  },
  // ---------------------------------------------------------------- 11209
  // CoinAbility_112090341 (base 11209034): on hit, 50%: absorb 10 target Sinking potency; always next turn PlusCoinValueUp 1
  // and AttackDmgUp 3 (override).
  {
    name: /^112090341_\d+$/,
    summary: "命中时吸收目标10级沉沦强度，下回合获得1层硬币强化与3层伤害强化(50%概率不吸收)",
    approx: "50%随机分支固定为“吸收”",
    onCoinHit(c) {
      const amount = c.script.buffData?.stack ?? 10;
      const have = c.target.getPotency("Sinking");
      if (have > 0) c.lose("target", "Sinking", Math.min(have, amount));
      c.give("actor", "PlusCoinValueUp", 1, 0, 1);
      c.give("actor", "AttackDmgUp", 3, 0, 1);
    },
  },
  noDamageScript("GiveBuffOnBreakTarget", "技能结束时目标陷入混乱则施加沉沦层数（不模拟混乱）"),
  // ---------------------------------------------------------------- 11210
  // SkillAbility_CoinScaleAdderOnStartTurnIfSkillUsedBuffStack_{Kw}{N}: action.GetUsedBuffStack(Kw) ≥ N → coin power +1.
  {
    name: /^CoinScaleAdder1OnStartTurnIfSkillUsedBuffStack_([A-Za-z]+?)(\d+)$/,
    summary: "本技能消耗的指定状态不低于N层时硬币威力+1",
    approx: "消耗量按“超出10层的部分”(1121003 描述)估算；消耗由其他脚本执行",
    skillMods(c) {
      const [, kw, n] = /_([A-Za-z]+?)(\d+)$/.exec(c.script.scriptName)!;
      const used = Math.max(0, c.actor.getPotency(kw!) - 10);
      if (used >= Number(n)) return { coinScale: 1 };
    },
  },
  // SkillAbility_GiveBuffOnUseIfSelfHpRatioNotLessThan{N}: current HP ratio ≥ N% → GiveBuff(bd).
  {
    name: /^GiveBuffOnUseIfSelfHpRatioNotLessThan(\d+)$/,
    summary: "使用时若现存体力不低于N%，获得buffData状态",
    skillMods(c) {
      const n = Number(/(\d+)$/.exec(c.script.scriptName)![1]);
      const bd = c.script.buffData;
      if (!bd?.buffKeyword || 100 - c.battle.lostHpPct < n) return;
      c.give(bd.target === "Self" ? "actor" : "target", bd.buffKeyword, bd.stack ?? 0, bd.turn ?? 0, bd.activeRound === 1 ? 1 : 0);
    },
  },
  // SkillAbility_GiveBuffOnUseIfStackLess_{Kw}{N}: owner Kw stack < N → GiveBuff(bd).
  {
    name: /^GiveBuffOnUseIfStackLess_([A-Za-z]+?)(\d+)$/,
    summary: "使用时若指定状态层数低于N，获得buffData状态",
    skillMods(c) {
      const [, kw, n] = /_([A-Za-z]+?)(\d+)$/.exec(c.script.scriptName)!;
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const o = bd.buffOwner === "Target" ? c.target : c.actor;
      if (o.getPotency(kw!) >= Number(n)) return;
      c.give(bd.target === "Self" ? "actor" : "target", bd.buffKeyword, bd.stack ?? 0, bd.turn ?? 0, bd.activeRound === 1 ? 1 : 0);
    },
  },
  // SkillAbility_GiveBuffOnUseWithBloodDinnerIfHasStack_{Kw}{N}[min:max:step]: owner Kw ≥ N → use BloodDinner (min..max, step);
  // give bd.stack × (used / step).
  {
    name: /^GiveBuffOnUseWithBloodDinnerIfHasStack_([A-Za-z]+?)(\d+)\[(\d+):(\d+):(\d+)\]$/,
    summary: "指定状态达到N层时，使用时消耗血宴(每6层获得1层buffData状态，最多60层)",
    skillMods(c) {
      const [, kw, n, mn, mx, st] = /_([A-Za-z]+?)(\d+)\[(\d+):(\d+):(\d+)\]$/.exec(c.script.scriptName)!;
      const bd = c.script.buffData;
      if (!bd?.buffKeyword || c.actor.getPotency(kw!) < Number(n)) return;
      const step = Number(st);
      const use = Math.min(Number(mx), Math.floor(c.actor.getPotency("BloodDinner") / step) * step);
      if (use < Number(mn)) return;
      c.lose("actor", "BloodDinner", use);
      c.give(bd.target === "Target" ? "target" : "actor", bd.buffKeyword, (bd.stack ?? 1) * (use / step), 0);
    },
  },
);

const atkOf = (c: AbilityCtx): string | undefined => (c.ability as { atk?: unknown }).atk as string | undefined;

/** BuffAbility_SheutFractureMaxStack effect at max stack (see registration below). */
function sheutMax(c: AbilityCtx): void {
  const bd = c.ability.buffData;
  if (perTurn(c, "sheut") && bd?.buffKeyword) c.give("target", bd.buffKeyword, bd.stack ?? 1, bd.turn ?? 0);
  const dmg = Math.trunc(c.target.getPotency("Sinking") * (c.ability.value ?? 1));
  if (dmg > 0) c.extraDamage(dmg, "影之龟裂（忧郁）", { sin: "AZURE" });
  c.consume("target", "Sinking", Math.round(bd?.value ?? 1));
  c.target.destroy(c.status.id);
}

registerAbilities(
  // BuffAbility_SheutFractureMaxStack.RightAfterGettingBuff: at max stack, once per turn (system ability 396):
  // GiveBuff(AzureTakeDamageUp 1), Azure HP dmg = trunc(Sinking potency × value), lose bd.value Sinking count.
  {
    name: "SheutFractureMaxStack",
    summary: "影之龟裂满10层：施加1层忧郁易损(每回合1次)，受到等同沉沦强度的忧郁伤害并使沉沦层数-1，随后解除",
    approx: "在获得状态的瞬间检查满层（仅当已持有影之龟裂时；一次从0到满层时在命中后补查）；解除本效果取自描述",
    coinMods(c) {
      if (c.side !== "target") return;
      // RightAfterGettingBuff: observe gains while SheutFracture is present and fire the instant it reaches max stack.
      c.onStatusChange?.(
        { whileStatus: c.status.id },
        (ev) => {
          if (ev.buffId === c.status.id && ev.after.potency >= 10 && ev.before.potency < ev.after.potency) sheutMax(c);
        },
        { side: "target", key: `sheutMax:${c.status.id}` },
      );
    },
    onCoinHit(c) {
      if (c.side !== "target" || c.target.getPotency(c.status.id) < 10) return;
      sheutMax(c);
    },
  },
  noDamageAbility("SheutFractureOnDie", "阵亡时将一半层数转移给友方"),
  noDamageAbility("SheutFractureOnRS", "回合开始时场上无LCA人格则解除"),
  // BuffAbility_TheUdjatOutisOnBS (GiveBuffOnBattleStart): battle start → self Protection (limited by passive 1111402 remainder).
  {
    name: "TheUdjatOutisOnBS",
    summary: "战斗开始时获得1层守护",
    approx: "被动1111402的守护上限未建模",
    onBattleStart(c) {
      if (c.side !== "actor") return;
      const bd = c.ability.buffData;
      if (bd?.buffKeyword) c.give("actor", bd.buffKeyword, bd.stack ?? 1, bd.turn ?? 0);
    },
  },
  noDamageAbility("UdjatTargetCoinProb", "使敌方硬币正面概率减半（拼点/敌方攻击）"),
  // BuffAbility_DefaultSkillDmgMultiplierViaBuffCheckDevideByStack: default skill (S1–S3), atk filter;
  // floor(owner stack / bd.stack) × value, cap limit%.
  {
    name: "DefaultSkillDmgMultiplierViaBuffCheckDevideByStack",
    summary: "基础技能：指定单位每带有N级指定状态，造成的伤害+value(有上限)",
    coinMods(c) {
      if (c.side !== "actor" || !isDefaultSkill(c)) return;
      const atk = atkOf(c);
      if (atk && c.skill?.atkType && atk !== c.skill.atkType) return;
      const bd = c.ability.buffData;
      if (!bd?.buffKeyword) return;
      const o = bd.buffOwner === "Self" ? c.actor : c.target;
      const div = Math.max(1, bd.stack ?? 1);
      let d = Math.floor(o.getPotency(bd.buffKeyword) / div) * (c.ability.value ?? 0);
      if ((bd.limit ?? 0) > 0) d = Math.min(d, bd.limit! * 0.01);
      if (d > 0) return { dmg: d };
    },
  },
  // BuffAbility_AdditionalDmgMiddleFatherSwordOneOutis.OnSucceedAttack: default skill last coin, target Laceration ≥ bd.stack →
  // extra dmg trunc(finalDmg × value).
  {
    name: "AdditionalDmgMiddleFatherSwordOneOutis",
    summary: "基础技能最后一枚硬币命中时，若目标流血强度≥20，追加该硬币最终伤害10%的打击伤害",
    onCoinHit(c) {
      if (c.side !== "actor" || !isDefaultSkill(c) || !c.skill || c.coinIndex !== c.skill.coinCount - 1) return;
      const atk = atkOf(c);
      if (atk && c.skill.atkType && atk !== c.skill.atkType) return;
      const bd = c.ability.buffData;
      if (c.target.getPotency(bd?.buffKeyword ?? "Laceration") < (bd?.stack ?? 20)) return;
      const dmg = Math.floor((c.lastHitDamage ?? 0) * (c.ability.value ?? 0.1));
      if (dmg > 0) c.extraDamage(dmg, "封印之剑追加伤害", { atkType: (atk ?? c.skill.atkType ?? "HIT") as import("../../config/game-data").AtkType });
    },
  },
);
