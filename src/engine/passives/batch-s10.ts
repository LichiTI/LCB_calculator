/** Script/status batch 10 — see data/il2cpp/dossiers/scripts-10.md */
import { replaceIfBuff } from "./skill-replace";
import { attackWeightDiff } from "../attack-weight";
import { triggerVibrationExplosion, type StatusContainer } from "../status";
import { noDamageAbility, noDamageScript, registerAbilities, registerScripts, type PassiveCtx, type ScriptCtx, type ScriptData } from "./framework";

type BD = NonNullable<ScriptData["buffData"]>;

// ---- 10514 spore bullets (PassiveAbility_1051402): max Long 10 / Short 6 (_DEFAULT_MAX_*_BULLET_CAPACITY).
const SPORE_LONG = "MeursaultSporeBulletLong";
const SPORE_SHORT = "MeursaultSporeBulletShort";
const SPORE_RELOAD_KEY = "spore:reload"; // 1 = reserved this action, 2 = done
const SPORE_EMPTY_KEY = "spore:empty";
const SPORE_RELOAD_APPROX = "装填消耗的理智((16-剩余孢子弹)/2)未计入";
const reserveSporeReload = (c: ScriptCtx) => {
  if (c.action.shared.get(SPORE_RELOAD_KEY) !== 2) c.action.shared.set(SPORE_RELOAD_KEY, 1);
};
/** BulletReloadByAbility at OnEndBehaviour: LoseBuffAllStack both, refill to max capacity. */
function sporeReload(c: ScriptCtx): void {
  if (c.action.shared.get(SPORE_RELOAD_KEY) !== 1) return;
  c.action.shared.set(SPORE_RELOAD_KEY, 2);
  for (const [kw, max] of [[SPORE_LONG, 10], [SPORE_SHORT, 6]] as const) {
    const cur = c.actor.getPotency(kw);
    if (cur > 0) c.lose("actor", kw, cur);
    c.give("actor", kw, max, 0);
  }
  c.note("孢子弹装填：基础 10 / 霰弹 6");
}
/** OnCanceledByLackOfBuffsAtStartCoin: DisableCoin for the rest of the skill + reload (RELOAD_BY_CANCEL). */
function sporeCancel(c: ScriptCtx, why: string): void {
  reserveSporeReload(c);
  c.cancelCoin(`${why}，取消后续硬币并装填`, { rest: true });
}
/** "技能使用中消耗了所有孢子弹" → later coins are cancelled and the unit reloads. */
function markIfAllSpent(c: ScriptCtx): void {
  if (c.actor.getPotency(SPORE_LONG) + c.actor.getPotency(SPORE_SHORT) > 0) return;
  c.action.shared.set(SPORE_EMPTY_KEY, 1);
  reserveSporeReload(c);
}
function sporeAllSpent(c: ScriptCtx): boolean {
  if (!c.action.shared.get(SPORE_EMPTY_KEY)) return false;
  c.cancelCoin("孢子弹已耗尽，取消后续硬币", { rest: true });
  return true;
}

/** AbilityBase.GetSingleUnit(buffOwner): "Self" → actor, otherwise the main target. */
const owner = (c: ScriptCtx, bd: BD | undefined): StatusContainer => (bd?.buffOwner === "Self" ? c.actor : c.target);

/** Combustion + Vibration potency of the main target (10512 skill scripts). */
const burnVib = (c: ScriptCtx): number => c.target.getPotency("Combustion") + c.target.getPotency("Vibration");

/** *ViaBuffDivide: trunc(stack/bd.stack) and trunc(turn/bd.turn) (only for non-zero divisors). */
function dividedUnits(c: ScriptCtx, bd: BD): number {
  const o = owner(c, bd);
  const s = bd.stack ?? 0;
  const t = bd.turn ?? 0;
  const p = o.getPotency(bd.buffKeyword!);
  const n = o.getCount(bd.buffKeyword!);
  return (s > 0 && p > 0 ? Math.trunc(p / s) : 0) + (t > 0 && n > 0 ? Math.trunc(n / t) : 0);
}

function vibrationExplosion(c: ScriptCtx, tag: string): boolean {
  const rec = triggerVibrationExplosion(c.target, c.turn, tag);
  if (!rec) return false;
  if (rec.hpDamage > 0) c.extraDamage(rec.hpDamage, `${tag}（震颤-灼热）`);
  else c.note(`${tag}：混乱阈值前移 ${rec.staggerShift}`);
  return true;
}

/** Per-turn counter in script state. */
function perTurn(c: ScriptCtx, key: string, max: number): boolean {
  const k = `${key}:${c.turn}`;
  const used = c.state.get(k) ?? 0;
  if (used >= max) return false;
  c.state.set(k, used + 1);
  return true;
}

registerScripts(
  // ---------------------------------------------------------------- 10512
  // SkillAbility_CoinScaleAdder10512_{div}_{per}_{max}: main target Combustion+Vibration potency / div × per, max.
  {
    name: /^CoinScaleAdder10512_(\d+)_(\d+)_(\d+)$/,
    summary: "主要目标烧伤强度与震颤强度之和每有N级，硬币威力+M(有上限)",
    // timing audit: GetCoinScaleAdder → CalculateCoinScaleAdder on every query (no OnStartTurn) → per coin
    coinMods(c) {
      const [, d, p, m] = /_(\d+)_(\d+)_(\d+)$/.exec(c.script.scriptName)!;
      return { coinScale: Math.min(Number(m), Math.trunc(burnVib(c) / Number(d)) * Number(p)) };
    },
  },
  // SkillAbility_SkillPowerResultAdder10512_{div}_{per}_{max}: same sum → final power.
  {
    name: /^SkillPowerResultAdder10512_(\d+)_(\d+)_(\d+)$/,
    summary: "主要目标烧伤强度与震颤强度之和每有N级，最终威力+M(有上限)",
    // timing audit: GetSkillPowerResultAdder → CalculateResultAdder on every query → per coin
    coinMods(c) {
      const [, d, p, m] = /_(\d+)_(\d+)_(\d+)$/.exec(c.script.scriptName)!;
      return { finalPower: Math.min(Number(m), Math.trunc(burnVib(c) / Number(d)) * Number(p)) };
    },
  },
  {
    // SkillAbility_SpecialSkill1051203.OnBeforeTurn: self BulletPropellantSpecialAlly ≥ 1 → ChangeSkill(1051205).
    name: "SpecialSkill1051203",
    summary: "回合开始前自身带有猛虎标弹时改为使用技能1051205",
    beforeUse(c) {
      replaceIfBuff(c, 1051205, { reason: "带有猛虎标弹" });
    },
  },
  // Bullet consumption / damage bonus of 10512 bullet coins is handled by passives 1051202/1051211 (batch-p04).
  noDamageScript("UseBullet[optional:BulletPropellantAlly:1]", "掷出硬币时可选消耗1发虎标弹（消耗由被动1051202处理）"),
  // CoinAbility_VEOnSAAndLoseTargetVibrationTurnAdditinalValueTimesViaBuffCheck{lose}:
  // CheckCondition (self bd.buffKeyword stack ≥ bd.stack) → on hit: explosion + lose `lose` Vibration count, then `value` more times.
  {
    name: /^VEOnSAAndLoseTargetVibrationTurnAdditinalValueTimesViaBuffCheck(\d+)$/,
    summary: "带有指定弹药时命中触发震颤引爆并使目标震颤层数减少，额外重复value次",
    approx: "条件在掷硬币时检查（弹药由被动在命中时消耗）",
    coinMods(c) {
      const bd = c.script.buffData;
      const ok = !!bd?.buffKeyword && c.actor.getPotency(bd.buffKeyword) >= (bd.stack ?? 0) && c.actor.getCount(bd.buffKeyword) >= (bd.turn ?? 0);
      c.state.set(`ve:${c.turn}:${c.coinIndex}`, ok ? 1 : 0);
    },
    onCoinHit(c) {
      if (!c.state.get(`ve:${c.turn}:${c.coinIndex}`)) return;
      const lose = Number(/(\d+)$/.exec(c.script.scriptName)![1]);
      const times = 1 + Math.round(c.script.value ?? 0);
      for (let i = 0; i < times; i++) {
        if (c.target.getPotency("Vibration") <= 0 && c.target.getCount("Vibration") <= 0) break;
        vibrationExplosion(c, `震颤引爆${i + 1}`);
        c.target.consumeCount("Vibration", lose, false);
      }
    },
  },
  // ---------------------------------------------------------------- 10513
  noDamageScript("AddBloodDinnerOnKillTarget20", "目标阵亡时获得20层血宴"),
  // SkillAbility_AttackDmgUpOnUseViaBuffDivide.CalculateDmgMul (snapshot at use): (divided units) × value, max limit%.
  {
    name: "AttackDmgUpOnUseViaBuffDivide",
    summary: "使用时按指定状态层数/强度每N点使本技能伤害+X%(有上限)",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      let dmg = dividedUnits(c, bd) * (bd.value ?? 0);
      if ((bd.limit ?? 0) > 0) dmg = Math.min(dmg, bd.limit! * 0.01);
      return { dmg };
    },
  },
  // SkillAbility_CoinScaleAdderOnUseViaBuffDevide.GetScaleAdder: (divided units) × value, max limit.
  {
    name: "CoinScaleAdderOnUseViaBuffDevide",
    summary: "使用时按指定状态强度/层数每N点使硬币威力+X(有上限)",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      let v = dividedUnits(c, bd) * (bd.value ?? 1);
      if ((bd.limit ?? 0) > 0) v = Math.min(v, bd.limit!);
      return { coinScale: v };
    },
  },
  // SkillAbility_GiveBloodArmorByMaxResonanceAndAdditionalOnUse: max attribute resonance > 0 → self + N allies get 1 BloodArmor
  // (2 per turn); lust resonance → extra to allies.
  {
    name: /^GiveBloodArmorByMaxResonanceAndAdditionalOnUse_limit\d+$/,
    summary: "使用时(存在共鸣)使自身与(最大共鸣数)名友方获得1层[BloodArmorMeursault](每回合2次)",
    approx: "友方获得部分不影响本单位输出，未建模",
    skillMods(c) {
      const max = Math.max(0, ...Object.values(c.battle.resonance ?? {}));
      if (max <= 0 || !perTurn(c, "ba", c.script.value ?? 2)) return;
      c.give("actor", "BloodArmorMeursault", 1, 0);
    },
  },
  {
    // SkillAbility_SkillChangeSpecialTo<id>.OnBeforeTurn: buffOwner kw stack ≥ bd.stack && has kw → ChangeSkill(id).
    name: "SkillChangeSpecialTo1051305",
    summary: "自身[BloodArmorMeursault]≥5层时改为使用“开幕”(1051305)",
    beforeUse(c) {
      replaceIfBuff(c, 1051305, { reason: "[BloodArmorMeursault]≥5" });
    },
  },
  // SkillAbility_SpreadBloodArmorTo{Highest,Lowest}MaxHpOnStartTurn_[min:max:step]: use BloodDinner (min..max, step);
  // per step self (+1 ally) gets 1 BloodArmorMeursault (once per turn); failure → GiveBuff(bd) (self Laceration +10).
  {
    name: /^SpreadBloodArmorTo(?:Highest|Lowest)MaxHpOnStartTurn_activeRound\d\[(\d+):(\d+):(\d+)\]$/,
    summary: "使用时消耗血宴(每5层使自身与1名友方获得1层[BloodArmorMeursault])；未消耗则自身流血强度+10",
    approx: "友方获得部分未建模；每回合1次的限制同时作用于失败分支",
    skillMods(c) {
      const [, mn, mx, st] = /\[(\d+):(\d+):(\d+)\]$/.exec(c.script.scriptName)!.map(Number);
      if (!perTurn(c, "spread", 1)) return;
      const have = c.actor.getPotency("BloodDinner");
      const use = Math.min(mx!, Math.floor(have / st!) * st!);
      if (use >= mn!) {
        c.lose("actor", "BloodDinner", use);
        c.give("actor", "BloodArmorMeursault", Math.floor(use / st!), 0);
      } else {
        const bd = c.script.buffData;
        if (bd?.buffKeyword) c.give(bd.target === "Self" ? "actor" : "target", bd.buffKeyword, bd.stack ?? 0, bd.turn ?? 0);
      }
    },
  },
  // ---------------------------------------------------------------- 10514
  // SkillAbility_AttackDmgMultiplierDivideByLessThenTargetNum.CalcAttackDamageMultiplier: (weight − alive targets) / name int × jsonValue
  {
    name: "AttackDmgMultiplierDivideByLessThenTargetNum_1",
    summary: "攻击容量高于攻击目标数时，每高于1点伤害+value",
    approx: "攻击容量=技能 targetNum + TagetNumAdder 类脚本估算 + 脚本运行时增减；存活目标数取场景“目标数量”",
    coinMods(c) {
      const { diff } = attackWeightDiff(c);
      const div = Number(/_(\d+)$/.exec(c.script.scriptName)?.[1] ?? 1) || 1;
      const n = Math.floor(diff / div);
      if (n > 0) return { dmg: n * (c.script.value ?? 0) };
    },
  },
  noDamageScript("AttackDmgMultiplierToSubTarget", "对次要目标伤害变化（仅副目标伤害统计时生效，由引擎处理）"),
  noDamageScript("CanDealOnlyOneByMainTargetPriority", "本硬币仅命中主要目标（副目标伤害统计时跳过）"),
  // SkillAbility_CoinScaleAdderOnSTViaCombustionAndBuffDivide: (target Combustion potency + bd keyword potency) / stack × value, max limit.
  {
    name: "CoinScaleAdderOnSTViaCombustionAndBuffDivide",
    summary: "目标烧伤强度与指定状态强度之和每N级，硬币威力+1(有上限)",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword || !(bd.stack! > 0)) return;
      const o = owner(c, bd);
      let v = Math.trunc((o.getPotency("Combustion") + o.getPotency(bd.buffKeyword)) / bd.stack!) * (bd.value ?? 1);
      if ((bd.limit ?? 0) > 0) v = Math.min(v, bd.limit!);
      return { coinScale: v };
    },
  },
  // CoinAbility_GiveBuffAndAdditionalDmgOnSA1051403 (base 1051402): on hit give `value` BeeSpore; if BeeSpore at max (15):
  // abs HP dmg = Combustion potency × BeeSpore / 10, target Combustion count −1, remove BeeSpore.
  {
    name: "GiveBuffAndAdditionalDmgOnSA1051403",
    summary: "命中时施加孢子；目标孢子满15层时造成(烧伤强度×孢子层数/10)点伤害，烧伤层数-1并解除孢子",
    approx: "ForceToActivateSinBuffEffect(强制触发烧伤)未建模；孢子施加量取 value",
    onCoinHit(c) {
      const v = Math.round(c.script.value ?? 0);
      if (v > 0) c.give("target", "MeursaultBeeSpore", v, 0);
      const spore = c.target.getPotency("MeursaultBeeSpore");
      if (spore < 15) return;
      const dmg = Math.floor((c.target.getPotency("Combustion") * spore) / 10);
      if (dmg > 0) c.extraDamage(dmg, "孢子爆发");
      c.target.consumeCount("Combustion", 1, false);
      c.target.destroy("MeursaultBeeSpore");
    },
  },
  // SkillAbility_GiveBuffOnSA1051401: OnBeforeTurn SporeBulletLong at max → on hit give bd (PenetrateTakeDamageUp 1), once per turn.
  {
    name: "GiveBuffOnSA1051401",
    summary: "使用前孢子弹[基础]为最大值时，命中施加1层[PenetrateTakeDamageUp](每回合1次)",
    skillMods(c) {
      c.state.set(`full:${c.turn}`, c.actor.getPotency("MeursaultSporeBulletLong") >= 10 ? 1 : 0);
    },
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!c.state.get(`full:${c.turn}`) || !bd?.buffKeyword || !perTurn(c, "give", 1)) return;
      c.give("target", bd.buffKeyword, bd.stack ?? 0, bd.turn ?? 0);
    },
  },
  // SkillAbility_RecoverBullet1051403_{max}_{sp}_{gain}: OnBeforeTurn Long ≤ max → lose sp SP, gain `gain` Long.
  {
    name: /^RecoverBullet1051403_(\d+)_(\d+)_(\d+)$/,
    summary: "使用前孢子弹[基础]不高于2发时消耗6点理智并获得3发",
    approx: "理智消耗未建模（引擎理智为常量）",
    skillMods(c) {
      const [, mx, , g] = /_(\d+)_(\d+)_(\d+)$/.exec(c.script.scriptName)!.map(Number);
      if (c.actor.getPotency("MeursaultSporeBulletLong") <= mx!) c.give("actor", "MeursaultSporeBulletLong", g!, 0);
    },
  },
  // SkillAbility_ReloadOnEA1051402.OnEndAttack: Long ≤ 1 → ReserveReloadByAbility; PassiveAbility_1051402 reloads at OnEndBehaviour.
  {
    name: "ReloadOnEA1051402",
    summary: "技能结束时孢子弹[基础]不高于1发则装填孢子弹(基用10/霰弹6)",
    approx: SPORE_RELOAD_APPROX,
    onSkillEnd(c) {
      if (c.actor.getPotency(SPORE_LONG) <= 1) reserveSporeReload(c);
      sporeReload(c);
    },
  },
  // SkillAbility_ReloadOnEA1051403.OnStartBehaviour: ReserveReloadByAbility(MUTE) → reload at OnEndBehaviour.
  {
    name: "ReloadOnEA1051403",
    summary: "技能结束时装填孢子弹(基用10/霰弹6)",
    approx: SPORE_RELOAD_APPROX,
    skillMods(c) {
      reserveSporeReload(c);
    },
    onSkillEnd: sporeReload,
  },
  // SkillAbility_ReloadOnBS1051404 (守备技能): OnBattleStart → ReserveReloadByAbility → reload at OnEndBehaviour.
  {
    name: "ReloadOnBS1051404",
    summary: "使用本守备技能时装填孢子弹(基用10/霰弹6)",
    approx: SPORE_RELOAD_APPROX,
    skillMods(c) {
      reserveSporeReload(c);
    },
    onSkillEnd: sporeReload,
  },
  {
    name: "UseBullet[necessary:MeursaultSporeBulletLong:1]",
    summary: "掷出硬币时消耗1发孢子弹[基础]；不足时取消本硬币及后续硬币并装填",
    beforeCoin(c) {
      if (sporeAllSpent(c)) return;
      if (c.actor.getPotency(SPORE_LONG) <= 0) sporeCancel(c, "孢子弹[基础]不足");
    },
    onSkillEnd: sporeReload,
    coinMods(c) {
      if (c.actor.getPotency("MeursaultSporeBulletLong") <= 0) {
        c.note(`硬币${(c.coinIndex ?? 0) + 1}缺少孢子弹[基础]：实际不会发动`);
        return;
      }
      c.lose("actor", "MeursaultSporeBulletLong", 1);
      markIfAllSpent(c);
    },
  },
  {
    name: "UseBullet[necessary:MeursaultSporeBulletShort:1]",
    summary: "掷出硬币时消耗1发孢子弹[霰弹]；无霰弹时用2发基础弹转换1发，仍不足则取消本硬币及后续硬币并装填",
    approx: "转换消耗的2点理智未计入",
    beforeCoin(c) {
      if (sporeAllSpent(c)) return;
      if (c.actor.getPotency(SPORE_SHORT) > 0) return;
      // PassiveAbility_1051402.OnBeforeStartCoin: no Short → lose 2 SP + 2 Long, gain 1 Short.
      if (c.actor.getPotency(SPORE_LONG) >= 2) {
        c.lose("actor", SPORE_LONG, 2);
        c.give("actor", SPORE_SHORT, 1, 0);
        c.note("霰弹不足：消耗2发基础弹转换为1发霰弹");
        return;
      }
      sporeCancel(c, "孢子弹[霰弹]不足");
    },
    onSkillEnd: sporeReload,
    coinMods(c) {
      if (c.actor.getPotency("MeursaultSporeBulletShort") <= 0) {
        c.note(`硬币${(c.coinIndex ?? 0) + 1}缺少孢子弹[霰弹]：实际不会发动`);
        return;
      }
      c.lose("actor", "MeursaultSporeBulletShort", 1);
      markIfAllSpent(c);
    },
  },
  // ---------------------------------------------------------------- 10515
  {
    // SkillAbility_Skill1051503CoinAdder.OnStartTurn_BeforeLog: owner HP < 50% or target BearClawWound stack ≥ 5
    //   (ConditionBase: GetActivatedBuffStack(24) ≥ _BUFF_STACK_CONDITION 5) → CopyCoinModelAndAddToListByIndex(2).
    name: "Skill1051503CoinAdder",
    summary: "现存体力<50%或目标被撕裂的色彩≥5层时额外使用第3枚硬币1次",
    onSkillStart(c) {
      if (cond1051503(c)) c.coins?.add({ copyOf: 2 });
    },
  },
  {
    // SkillAbility_Skill1051503FourthCoinSpecialAction_div<D>_perMax<M>: OnStartTurn flags CheckTargetCondition (claw ≥ 5);
    //   OnSucceedAttack on coin index 3 (the added coin): n = claw stack / D → randomly split n between +Laceration / +Sinking
    //   potency (each ≤ M).
    name: /^Skill1051503FourthCoinSpecialAction_div(\d+)_perMax(\d+)$/,
    summary: "追加硬币命中时随机使目标增加(被撕裂的色彩层数/3)级流血或沉沦强度(各最多3)",
    approx: "随机分配按交替分配（流血优先）",
    onSkillStart(c) {
      c.action.shared.set("1051503:targetCond", clawStack(c) >= 5 ? 1 : 0);
    },
    onCoinHit(c) {
      if (c.coinIndex !== 3 || !c.isAddedCoin || !c.action.shared.get("1051503:targetCond")) return;
      const [, div = 3, max = 3] = (c.script.scriptName.match(/\d+/g) ?? []).map(Number);
      const s = clawStack(c);
      if (s < div) return;
      const n = Math.floor(s / div);
      const sink = Math.min(max, Math.floor(n / 2));
      const lac = Math.min(max, n - sink);
      const sink2 = Math.min(max, n - lac);
      if (lac > 0) c.give("target", "Laceration", lac, 0);
      if (sink2 > 0) c.give("target", "Sinking", sink2, 0);
    },
  },
  {
    // SkillAbility_Skill1051503SuperCoinChanger.OnStartTurn_BeforeLog: same condition → AddSuperCoinScriptToCoin on every coin.
    name: "Skill1051503SuperCoinChanger",
    summary: "满足条件时本技能所有硬币转化为[SuperCoin]（仅影响拼点）",
    onSkillStart(c) {
      if (cond1051503(c)) c.coins?.makeSuper("all");
    },
  },
);

/** BUFF_UNIQUE_KEYWORD 24 = 被撕裂的色彩[红色] (BearClawWound; the ally variant shares the meaning). */
function clawStack(c: PassiveCtx): number {
  return c.target.getPotency("BearClawWoundAlly") + c.target.getPotency("BearClawWound");
}
/** SkillAbility_Skill1051503ConditionBase: owner HP ratio < 0.5 or CheckTargetCondition (claw stack ≥ 5). */
function cond1051503(c: PassiveCtx): boolean {
  return c.selfHpRatio() < 0.5 || clawStack(c) >= 5;
}

registerAbilities(
  noDamageAbility("ConcentratedAttack", "集中攻击：集中遭遇战专属（普通战斗无效；数值由被动1051102近似）"),
  noDamageAbility("BulletPropellantAlly", "虎标弹消耗计数（由被动1051202处理）"),
  // BuffAbility_ParadeConcentrationTakeDmgMultiplier: +value from SCARLET skills; ×2 regardless of sin if attacker is La Manchaland.
  {
    name: "ParadeConcentrationTakeDmgMultiplier",
    summary: "受到色欲技能伤害+10%（拉·曼却领人格为任意属性+20%）",
    coinMods(c) {
      if (c.side !== "target" || c.status.potency <= 0) return;
      // attacker UNIT_KEYWORD LA_MANCHA_LAND → value × 2 regardless of sin; else _ATTRI 1 (SCARLET) → value
      if (c.actorHasUnitKeyword?.("LA_MANCHA_LAND")) return { dmg: (c.ability.value ?? 0.1) * 2 };
      if (c.skill?.sin === "SCARLET") return { dmg: c.ability.value ?? 0.1 };
    },
  },
  noDamageAbility("ParadeConcentrationGiveDmgMultiplier", "满层时对拉·曼却领人格伤害-20%（敌方目标非拉·曼却领）"),
  // BuffAbility_ParadeConcentrationLoseCheck: −1 stack after each attack by/against the owner.
  {
    name: "ParadeConcentrationLoseCheck",
    summary: "命中的技能攻击结束后层数-1",
    approx: "于技能最后一枚硬币命中时结算",
    onCoinHit(c) {
      if (c.skill && c.coinIndex === c.skill.coinCount - 1) c.lose(c.side, c.status.id, 1);
    },
  },
  // BuffAbility_GiveBuffOnREPerStack: round end, per `value` stacks give bd.stack/bd.turn × (stack/value) to self.
  {
    name: "GiveBuffOnREPerStack",
    summary: "回合结束时每有N层，使自身获得指定状态",
    onRoundEnd(c) {
      const bd = c.ability.buffData;
      const per = c.ability.value ?? 0;
      if (!bd?.buffKeyword || per <= 0) return;
      const k = Math.trunc(c.status.potency / per);
      if (k > 0) c.give(c.side, bd.buffKeyword, k * (bd.stack ?? 0), k * (bd.turn ?? 0));
    },
  },
  noDamageAbility("MeursaultBeeSporeDie", "带孢子单位死亡时使默尔索获得工蜂"),
  noDamageAbility("MeursaultBeeSporeEffect", "孢子特效显示"),
);
