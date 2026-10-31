/** Script/status batch 19 — see data/il2cpp/dossiers/scripts-19.md */
import { triggerVibrationExplosion } from "../status";
import {
  blockSkillGains,
  blockSkillReactLoss,
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
interface CoinLike {
  abilityScriptList?: ScriptData[];
}
interface SkillLike {
  coins?: CoinLike[];
}

const giveBD = (c: PassiveCtx, bd: BD | undefined, stack = bd?.stack ?? 0, turn = bd?.turn ?? 0) => {
  if (!bd?.buffKeyword || (stack <= 0 && turn <= 0)) return;
  c.give(bd.target === "Self" ? "actor" : "target", bd.buffKeyword, stack, turn, bd.activeRound ? 1 : 0);
};
const isLastCoin = (c: PassiveCtx) => c.skill != null && c.coinIndex === c.skill.coinCount - 1;
/** 10917 (卡其色黑云会) receives Charge as ChargeKhakiAlly (initBuffs). */
const chargeKw = (c: PassiveCtx) => (c.actor.get("ChargeKhakiAlly") || c.identityId === 10917 ? "ChargeKhakiAlly" : "Charge");
/** ResonanceManager.GetAttributeResonance(skill sin), or GetMaxAttributeResonanceOfAll when the skill has no sin. */
const skillResonance = (c: PassiveCtx) => {
  const sin = c.skill?.sin;
  const r = c.battle.resonance ?? {};
  return sin ? (r[sin] ?? 0) : Math.max(0, ...Object.values(r));
};
const maxResonance = (c: PassiveCtx) => Math.max(0, ...Object.values(c.battle.resonance ?? {}));

/** One Vibration explosion on a side: stagger shift only, except VibrationIgnition (HP damage, target side only). */
const explode = (c: PassiveCtx, desc: string, side: "actor" | "target" = "target") => {
  const rec = triggerVibrationExplosion(side === "target" ? c.target : c.actor, c.turn, desc);
  if (!rec) return null;
  if (side === "target" && rec.hpDamage > 0) c.extraDamage(rec.hpDamage, rec.sourceDesc);
  else c.note(`${desc}：${side === "target" ? "目标" : "自身"}震颤引爆（混乱阈值前移 ${rec.staggerShift}）`);
  return rec;
};

/**
 * SkillAbility_11011baseNoGiveBuff.OnStartTurn_BeforeLog: target Burst stack ≥ bd.stack && turn ≥ bd.turn (snapshot per skill use)
 * → BlockGivingBuff(Burst): every Burst gain (stack or turn, any script of this action) is blocked until the skill ends.
 */
const blockKey = (c: PassiveCtx) => `11011block:${c.turn}:${c.skill?.id}`;
const snapshotBlock = (c: ScriptCtx) => {
  const bd = c.script.buffData;
  const on = !!bd && c.target.getPotency("Burst") >= (bd.stack ?? 15) && c.target.getCount("Burst") >= (bd.turn ?? 3);
  c.state.set(blockKey(c), on ? 1 : 0);
  if (!on) return;
  c.note(`${c.script.scriptName}：目标破裂≥${bd?.stack}级且≥${bd?.turn}层，本技能不再施加破裂`);
  // BattleActionModel.BlockGivingBuff is only consulted by this action's Skill/CoinAbility GiveBuff → only this skill's own sources.
  blockSkillGains(c, "Burst");
};
/** Read only from the handler that snapshotted (c.state is per handler). */
const burstBlocked = (c: PassiveCtx) => c.state.get(blockKey(c)) === 1;

registerScripts(
  {
    // SkillAbility_BuffToTwoAllyAndSelf10917 (BuffToOneAlly10917.OnBattleStart): self + chosen allies gain buffData (AttackUp 2, this turn)
    // and a 5% max-HP shield; a [PersonalityCharge] ally gets +1 (name suffix). Only the self part affects this unit's damage.
    name: "BuffToTwoAllyAndSelf10917_AttackUp1",
    summary: "战斗开始时自身获得2层攻击等级提升（友方部分与护盾不影响本次伤害）",
    approx: "友方增益与护盾未模拟",
    skillMods(c) {
      const key = `10917bt:${c.turn}`;
      if (c.state.get(key)) return;
      c.state.set(key, 1);
      const bd = c.script.buffData;
      c.give("actor", bd?.buffKeyword ?? "AttackUp", bd?.stack ?? 2, 0, 0);
    },
  },
  {
    // CoinAbility_VibrationExplosionOnSucceedAttackIfUsingBuffTurnAndLoseTargetVibrationTurn<N>:
    // CheckCondition: self Charge stack ≥ bd.stack && turn ≥ bd.turn(5) → UseBuffTurn(Round(bd.value)=5), then
    // (base) target Vibration stack > 0 → explosion, LoseBuffTurn(Vibration, N).
    name: "VibrationExplosionOnSucceedAttackIfUsingBuffTurnAndLoseTargetVibrationTurn1",
    summary: "命中时若自身充能≥5层，消耗5层并使目标震颤引爆、目标震颤层数-1",
    onCoinHit(c) {
      const bd = c.script.buffData;
      const kw = chargeKw(c);
      if (c.actor.getCount(kw) < (bd?.turn ?? 5) || c.actor.getPotency(kw) < (bd?.stack ?? 0)) return;
      c.consume("actor", kw, Math.round(bd?.value ?? 5));
      if (explode(c, c.script.scriptName)) c.consume("target", "Vibration", 1);
    },
  },
  {
    // …OnWinDuel_Breath: after a clash win, crits of this skill do not consume Breath (react loss blocked for the skill).
    name: "BlockLoseSinBuffByReactWithActionOnWinDuel_Breath",
    summary: "拼点胜利后本技能暴击不消耗呼吸法",
    approx: "仅在可选敌方行动模型（拼点胜利）下触发",
    onWinDuel(c) {
      blockSkillReactLoss(c, "Breath", { side: "actor", key: "winDuelBreath" });
    },
  },
  {
    // CoinAbility_VibrationExplosionOnSucceedAttackThenGiveBuffIfTargetHasStack_<Kw><N>: explosion, then target <Kw> stack ≥ N → GiveBuff(bd).
    name: "VibrationExplosionOnSucceedAttackThenGiveBuffIfTargetHasStack_Vibration5",
    summary: "命中引爆目标震颤；目标震颤强度≥5时施加buffData（下回合守护）",
    onCoinHit(c) {
      if (!explode(c, c.script.scriptName)) return;
      if (c.target.getPotency("Vibration") >= 5) giveBD(c, c.script.buffData);
    },
  },
  noDamageScript("HealFirstBreakSectionOnSuccessAttackByDamageRatio5", "命中后按伤害量50%使自身混乱阈值后移"),
  {
    // SkillAbility_MariachiCriticalChanceAdderByTargetMp.GetCriticalChanceAdder: main target MP < 0 → (−MP) × _RATIO(0.022)
    // (SkillAbility adder: added after the crit-chance multiplier). Needs scenario target SP (c.targetSp).
    name: "MariachiCriticalChanceAdderByTargetMp",
    summary: "目标理智低于0时按其理智增加暴击率（每点负理智+2.2%）",
    approx: "需在场景中设置目标理智值（未设置时不增加）；目标理智在模拟中不变",
    critChance(c) {
      const sp = c.targetSp;
      if (sp == null || sp >= 0) return;
      return { add: -sp * 0.022 };
    },
  },
  {
    // class unresolved — description: target has unit keyword <MACHINE_BOUND_ORGANISM> → dmg +10%.
    name: "AttackDmgUpByRatio10IfTargetHasUnitKeyword_MACHINE_BOUND_ORGANISM",
    summary: "目标属于<机械融合生命体>时伤害+10%",
    approx: "类未解析：按名字/描述（目标单位关键词→伤害+N%）",
    coinMods(c) {
      const m = /^AttackDmgUpByRatio(\d+)IfTargetHasUnitKeyword_(\w+)$/.exec(c.script.scriptName);
      if (m && c.targetHasUnitKeyword?.(m[2]!)) return { dmg: Number(m[1]) * 0.01 };
    },
  },
  noDamageScript("DamageFirstBreakSectionOnSuccessAttackByDamageRatio5", "命中后按伤害量50%使目标混乱阈值前移"),
  {
    // CoinAbility_GiveBuffOnSuccessAttackUsingBuffStack_<Kw><N>: self <Kw> stack ≥ N → UseBuffStack(N), GiveBuff(bd) to target.
    name: "GiveBuffOnSuccessAttackUsingBuffStack_Talisman5",
    summary: "命中时消耗自身5层符咒并对目标施加5层符咒",
    onCoinHit(c) {
      const bd = c.script.buffData;
      const n = bd?.stack ?? 5;
      if (c.actor.getPotency("Talisman") < n) return;
      c.lose("actor", "Talisman", n);
      giveBD(c, bd);
    },
  },
  {
    // CoinAbility_1100703_1(_gaksung4th, STACK_SELF=10).OnSucceedAttack:
    //   self Vibration turn ≥ 10 → give target Vibration turn = own turn, UseBuffAllTurn(self);
    //   else self +STACK_SELF Vibration stack, self explosion; OnGiveBsGaugeUp(onExplosion) → GiveHpDamageAppliedAtkResist(target, value).
    name: "1100703_1_gaksung4th",
    summary: "自身震颤≥10层时转移全部震颤层数给目标；否则自身+10级震颤并自爆，对目标造成等量打击伤害",
    approx: "自身无震颤时按获得1层计算",
    onCoinHit(c) {
      const own = c.actor.getCount("Vibration");
      if (own >= 10) {
        c.consume("actor", "Vibration", own);
        c.give("target", "Vibration", 0, own, 0);
        return;
      }
      c.give("actor", "Vibration", 10, own > 0 ? 0 : 1, 0);
      const rec = explode(c, "1100703_1_gaksung4th", "actor");
      if (rec && rec.staggerShift > 0) c.extraDamage(rec.staggerShift, `自身震颤引爆量${rec.staggerShift}转为对目标的打击伤害`, { atkType: "HIT" });
    },
  },
  {
    // 1100803_3_3: after a clash win, on hit → GiveBuff(bd: Vulnerable 1 → Target), turnLimit 2.
    name: "1100803_3_3",
    summary: "拼点胜利后命中施加buffData（易损）",
    approx: "仅在可选敌方行动模型（拼点胜利）下触发；turnLimit 按每回合次数",
    onCoinHit(c) {
      if (c.duelResult?.() !== "win") return;
      const lim = (c.script as { turnLimit?: number }).turnLimit ?? 99;
      const k = `n:${c.turn}`;
      const n = c.state.get(k) ?? 0;
      if (n >= lim) return;
      c.state.set(k, n + 1);
      giveBD(c, c.script.buffData);
    },
  },
  {
    // SkillAbility_AttackDmgUpOnlyWinDuelByRatio<N>[IfFaster]: attack damage + N% only when the skill won its clash
    // (IfFaster: self speed > target speed). By name (no class dump); param-scripts gives 0 when unopposed.
    name: /^AttackDmgUpOnlyWinDuelByRatio(\d+)(IfFaster)?$/,
    summary: "拼点胜利时伤害+N%（IfFaster：自身速度更快时）",
    approx: "仅在可选敌方行动模型（拼点胜利）下触发；按脚本名实现",
    coinMods(c) {
      const m = /^AttackDmgUpOnlyWinDuelByRatio(\d+)(IfFaster)?$/.exec(c.script.scriptName)!;
      if (c.duelResult?.() !== "win" || (m[2] && !(c.battle.selfSpeed > c.battle.targetSpeed))) return;
      return { dmg: Number(m[1]) * 0.01 };
    },
  },
  {
    name: /^AttackDmgUpOnlyWinDuelByRatio(\d+)PerParryingCountWithLimit(\d+)$/,
    summary: "拼点胜利时每次拼点伤害+N%（上限 M%）",
    approx: "仅在可选敌方行动模型（拼点胜利）下触发；拼点次数取场景 duel.parryingCount",
    coinMods(c) {
      const m = /^AttackDmgUpOnlyWinDuelByRatio(\d+)PerParryingCountWithLimit(\d+)$/.exec(c.script.scriptName)!;
      if (c.duelResult?.() !== "win") return;
      return { dmg: Math.min(Number(m[1]) * (c.parryingCount ?? 1), Number(m[2])) * 0.01 };
    },
  },
  {
    // class unresolved (sibling of s15 _Limit3/_Limit5): self DefenseUp += min(floor(Vibration turn / 2) × stack, 4)
    name: "GiveBuffOnUsePerBuffTurn_Vibration2_Limit4",
    summary: "使用时自身每2层震颤获得1层防御等级提升(最多4层)",
    approx: "类未解析，按描述实现",
    skillMods(c) {
      const n = Math.min(Math.floor(c.actor.getCount("Vibration") / 2) * (c.script.buffData?.stack ?? 1), 4);
      if (n > 0) c.give("actor", "DefenseUp", n, 0, 0);
    },
  },
  noDamageScript("TenthSinclairSecondSkillSecondCoinAbility_DefenseUp2", "命中时使带防御等级提升的友方下回合获得攻击等级提升"),
  {
    // CoinAbility_TenthSinclairThirdSkillThirdCoinAbility: n = min(self Vibration turn, bd.limit 8) → UseBuffTurn(n), target Vibration turn +n.
    name: "TenthSinclairThirdSkillThirdCoinAbility",
    summary: "命中时消耗自身最多8层震颤，对目标施加等量震颤层数",
    onCoinHit(c) {
      const n = Math.min(c.actor.getCount("Vibration"), c.script.buffData?.limit ?? 8);
      if (n <= 0) return;
      c.consume("actor", "Vibration", n);
      c.give("target", "Vibration", 0, n, 0);
    },
  },
  noDamageScript("1101103GiveBuffOnSucceedAttack", "末枚硬币威力加成未生效时下回合获得迅捷"),
  {
    // SkillAbility_1101103LastCoinDmgUp_<Kw><N>: OnStartTurn target <Kw> stack ≥ N → mul = min(self Devyat stack × value, limit × 0.01);
    // GetAttackDmgMultiplier only for action.GetLastCoin().
    name: "1101103LastCoinDmgUp_Burst15",
    summary: "目标破裂≥15级时，自身每层[DevyatDimensionalSackSinclair]使末枚硬币伤害+4%(最多120%)",
    skillMods(c) {
      const bd = c.script.buffData;
      const key = `1101103ldu:${c.turn}:${c.skill?.id}`;
      const mul =
        c.target.getPotency("Burst") >= 15
          ? Math.min(c.actor.getPotency(bd?.buffKeyword ?? "DevyatDimensionalSackSinclair") * (bd?.value ?? 0.04), (bd?.limit ?? 120) * 0.01)
          : 0;
      c.state.set(key, mul);
    },
    coinMods(c) {
      if (!isLastCoin(c)) return;
      const mul = c.state.get(`1101103ldu:${c.turn}:${c.skill?.id}`) ?? 0;
      if (mul > 0) return { dmg: mul };
    },
  },
  {
    // SkillAbility_11011NoGiveBuffLastCoinScaleAdder: condition (target Burst ≥ bd.stack, turn ≥ bd.turn) → BlockGivingBuff(Burst)
    // and GetCoinScaleAdder(last coin) = bd.value (4).
    name: "11011NoGiveBuffLastCoinScaleAdder",
    summary: "目标破裂≥15级且≥3层时，本技能不施加破裂，末枚硬币威力+4",
    skillMods(c) {
      snapshotBlock(c);
    },
    coinMods(c) {
      if (isLastCoin(c) && burstBlocked(c)) return { coinScale: c.script.buffData?.value ?? 4 };
    },
  },
  {
    // SkillAbility_11011ReplaceBuff_<Kw><N>: same condition → block Burst; OnSucceedAttack: if the coin would give Burst
    // (GetGivingStackByBuff | GetGivingTurnByBuff ≠ 0) → GiveBuff_BySkill(<Kw>, N) to target.
    name: "11011ReplaceBuff_DefenseDown2",
    summary: "目标破裂≥15级且≥3层时，本技能命中时改为施加2层防御等级降低而非破裂",
    skillMods(c) {
      snapshotBlock(c);
    },
    onCoinHit(c) {
      if (!burstBlocked(c)) return;
      const coin = (c.skillData as SkillLike).coins?.[c.coinIndex ?? -1];
      const givesBurst = (coin?.abilityScriptList ?? []).some(
        (s) => s.buffData?.buffKeyword === "Burst" && ((s.buffData.stack ?? 0) > 0 || (s.buffData.turn ?? 0) > 0),
      );
      if (givesBurst) c.give("target", "DefenseDown", 2, 0, 0);
    },
  },
  {
    // SkillAbility_EleventhSinclairCoinAdderSkillAbility<a>And<b>And<per>And<max>.CalculateCoinAdder:
    //   min(floor(self Devyat(693) stack / a) × per + floor(target Burst(41) stack / b) × per, max).
    name: /^EleventhSinclairCoinAdderSkillAbility(\d+)And(\d+)And(\d+)And(\d+)$/,
    summary: "自身每10层[DevyatDimensionalSackSinclair]与目标每6级破裂各使硬币威力+1（合计最多+2）",
    coinMods(c) {
      const [a, b, per, max] = (/(\d+)And(\d+)And(\d+)And(\d+)$/.exec(c.script.scriptName) ?? []).slice(1).map(Number);
      if (!a || !b) return;
      const v = Math.min(
        Math.floor(c.actor.getPotency("DevyatDimensionalSackSinclair") / a) * (per ?? 1) + Math.floor(c.target.getPotency("Burst") / b) * (per ?? 1),
        max ?? 2,
      );
      if (v > 0) return { coinScale: v };
    },
  },
  {
    // class unresolved — description: extra Burst turn = min(floor(self Devyat / 10) × bd.turn, 3) (base given by GiveBuffOnSucceedAttack).
    name: "GiveBuffOnSucceedAttackDevideByStackWithLimit3_DevyatDimensionalSackSinclair10",
    summary: "命中时自身每10层[DevyatDimensionalSackSinclair]对目标额外施加1层破裂(最多3层)",
    approx: "类未解析，按描述实现",
    onCoinHit(c) {
      const n = Math.min(Math.floor(c.actor.getPotency("DevyatDimensionalSackSinclair") / 10) * (c.script.buffData?.turn ?? 1), 3);
      if (n > 0) c.give("target", "Burst", 0, n, 0);
    },
  },
  {
    // class unresolved — description: extra Burst stack = min(floor(self Devyat / 8) × bd.stack, 4).
    name: "GiveBuffOnSucceedAttackDevideByStackWithLimit4_DevyatDimensionalSackSinclair8",
    summary: "命中时自身每8层[DevyatDimensionalSackSinclair]使目标额外增加1级破裂强度(最多4级)",
    approx: "类未解析，按描述实现",
    onCoinHit(c) {
      const n = Math.min(Math.floor(c.actor.getPotency("DevyatDimensionalSackSinclair") / 8) * (c.script.buffData?.stack ?? 1), 4);
      if (n > 0) c.give("target", "Burst", n, 0, 0);
    },
  },
  noDamageScript("GiveBuffOnUseIfStackLess_DevyatDimensionalSackSinclair31", "[DevyatDimensionalSackSinclair]≤30层时下回合获得迅捷"),
  {
    // SkillAbility_AttackLevelAdder1101203Reinforced_<max>_<pct>.CalculateAttackAdder:
    //   min(Round(maxResonance / value), max); any perfect resonance → × (1 + pct × 0.01).
    name: /^AttackLevelAdder1101203Reinforced_(\d+)_(\d+)$/,
    summary: "战斗开始时按(最大共鸣数/2)增加攻击等级(最多3)；存在完全共鸣时翻倍",
    approx: "Util.Round 按描述向下取整",
    skillMods(c) {
      const [max, pct] = (/_(\d+)_(\d+)$/.exec(c.script.scriptName) ?? []).slice(1).map(Number);
      let v = Math.min(Math.floor(maxResonance(c) / Math.max(1, c.script.value ?? 2)), max ?? 3);
      if (v > 0 && (c.battle.perfectResonance ?? 0) > 0) v = Math.floor(v * (1 + (pct ?? 100) * 0.01));
      if (v > 0) return { offense: v };
    },
  },
  {
    // CoinAbility_DmgUpByReso1101202_<N>: resonance(skill sin) ≥ N → dmg + jsonValue.
    name: /^DmgUpByReso1101202_(\d+)$/,
    summary: "包括本技能在内共鸣数≥N时本硬币伤害+value",
    coinMods(c) {
      const n = Number(/_(\d+)$/.exec(c.script.scriptName)?.[1] ?? 3);
      if (skillResonance(c) >= n) return { dmg: c.script.value ?? 0.2 };
    },
  },
  {
    // CoinAbility_DmgUpByReso1101203_<max>: min(resonance(skill sin) × jsonValue, max × 0.01).
    name: /^DmgUpByReso1101203_(\d+)$/,
    summary: "每1点包括本技能在内的共鸣数使本硬币伤害+value（有上限）",
    coinMods(c) {
      const max = Number(/_(\d+)$/.exec(c.script.scriptName)?.[1] ?? 30) * 0.01;
      const v = Math.min(skillResonance(c) * (c.script.value ?? 0.05), max);
      if (v > 0) return { dmg: v };
    },
  },
);

registerAbilities(
  noDamageAbility("NoirScissorAllyOnDie", "持有者阵亡时施加者恢复理智并获得攻击等级提升（击杀不模拟）"),
  noDamageAbility("ActivateBuffEffectBackCenter", "仅视觉效果"),
  {
    // BuffAbility_TalismanOnSA (holder attacks): target Burst turn ≥ limit(1) → target UseBuffTurn(Burst, 1),
    // then Burst stack + max(floor(Talisman stack / value 2), 1).
    name: "TalismanOnSA",
    summary: "持有者命中时消耗目标1层破裂，使其增加(符咒层数/2)级破裂强度(至少1)",
    onCoinHit(c: AbilityCtx) {
      if (c.side !== "actor") return;
      const bd = c.ability.buffData;
      if (c.target.getCount("Burst") < (bd?.limit ?? 1)) return;
      c.consume("target", "Burst", 1);
      const n = Math.max(Math.floor(c.status.potency / (bd?.value ?? 2)), bd?.limit ?? 1);
      if (n > 0) c.give("target", "Burst", n, 0, 0);
    },
  },
  {
    // BuffAbility_TalismanOnTAD (holder takes attack damage): holder Burst stack + max(floor(stack / 2), 1); Talisman stack −1.
    name: "TalismanOnTAD",
    summary: "持有者受到攻击时增加(符咒层数/2)级破裂强度(至少1)，符咒层数-1",
    onCoinHit(c: AbilityCtx) {
      if (c.side !== "target") return;
      const bd = c.ability.buffData;
      const n = Math.max(Math.floor(c.status.potency / (bd?.value ?? 2)), bd?.limit ?? 1);
      if (n > 0) c.give("target", "Burst", n, 0, 0);
      c.lose("target", "Talisman", 1);
    },
  },
  {
    // BuffAbility_TalismanOnRE: stack ≥ Round(value 6) → TakeAbsHpDamage_Buff(stack), all Talisman consumed.
    name: "TalismanOnRE",
    summary: "回合结束时符咒≥6层则消耗全部并受到等量固定伤害",
    onRoundEnd(c: AbilityCtx) {
      if (c.side !== "target") return;
      const p = c.status.potency;
      if (p < Math.round(c.ability.value ?? 6)) return;
      c.lose("target", "Talisman", p);
      c.extraDamage(p, `符咒${p}层：回合结束固定伤害`);
    },
  },
);
