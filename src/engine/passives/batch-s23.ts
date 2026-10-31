/** Script/status batch 23 — see data/il2cpp/dossiers/scripts-23.md */
import { replaceIfBuff } from "./skill-replace";
import type { StatusContainer } from "../status";
import { noDamageAbility, noDamageScript, registerAbilities, registerScripts, type PassiveCtx, type ScriptCtx, type ScriptData } from "./framework";

// Already handled elsewhere (not re-registered here):
//  - SkillPowerAdderOnUseViaBuffCheckDevideByStackWithLimit3 → batch-s15 RegExp
//  - GiveBuffOnREPerStack (LanternGregBigBird) → batch-s10 / batch-s14
//  - GiveBuffOnRoundEnd (HurtNightStiletto) → native in status.ts

type BD = NonNullable<ScriptData["buffData"]>;
interface CondData { category?: string; type?: string; conditionBuffData?: BD; resultBuffData?: BD }
interface RawSkill { abilityScripts?: ScriptData[]; coins?: { abilityScriptList?: ScriptData[] }[] }

const bdOf = (c: ScriptCtx): BD => c.script.buffData ?? {};
const ownerOf = (c: PassiveCtx, o?: string): StatusContainer => (o === "Target" || o === "AbnormalityTarget" ? c.target : c.actor);
const has = (s: StatusContainer, kw: string): boolean => {
  const st = s.get(kw);
  return !!st && (st.potency > 0 || st.count > 0);
};
function giveBD(c: PassiveCtx, bd: BD | undefined, stack = bd?.stack ?? 0, turn = bd?.turn ?? 0): void {
  if (!bd?.buffKeyword || (stack <= 0 && turn <= 0)) return;
  c.give(bd.target === "Self" ? "actor" : "target", bd.buffKeyword, Math.max(0, stack), Math.max(0, turn), bd.activeRound === 1 ? 1 : 0);
}
const perTurnOnce = (c: PassiveCtx, key: string): boolean => {
  const k = `${key}:${c.turn}`;
  if (c.state.get(k)) return false;
  c.state.set(k, 1);
  return true;
};
/**
 * CoinAbility_Chaser11213Tier1/2/3.CheckTargetCondition → PassiveAbility_1121302.ActiveChaser: CutInAction(_FIXED_SKILL_ID 1121305),
 * at most _ACTIVE_LIMIT_PER_ROUND (2) per round; not from "慈悲" itself. Tier2: target HP ratio ≤ value or buffOwner bd
 * stack ≥ bd.stack & turn ≥ bd.turn; Tier3 additionally: target staggered (IsBreak).
 */
function chaser11213(c: ScriptCtx, tier3: boolean): void {
  if (c.skill?.id === 1121305) return;
  const bd = bdOf(c);
  const s = bd.buffKeyword ? ownerOf(c, bd.buffOwner).get(bd.buffKeyword) : undefined;
  const buffOk = !!s && (s.potency > 0 || s.count > 0) && s.potency >= (bd.stack ?? 0) && s.count >= (bd.turn ?? 0);
  const hpOk = c.targetHpRatio() <= (c.script.value ?? 0.2);
  const staggerOk = tier3 && c.targetStaggered?.() === true;
  if (!buffOk && !hpOk && !staggerOk) return;
  c.queueAction?.(1121305, { label: "慈悲", key: "Chaser1121305", perTurn: 2 });
}

// ---------------------------------------------------------------- 12区燃料 (FirePunchFuel / FirePunchFuelOverheated)
// BuffAbility_FirePunchFuel.CheckBuffLevel: stack > 50 → FirePunchFuel(911), ≤ 50 → FirePunchFuelOverheated(912);
// BeforeUseBuff treats both keywords as fuel. Fuel spent by the current action comes from c.action (BattleActionModel.UsedBuffStack).
const FUEL = "FirePunchFuel";
const OVERHEAT = "FirePunchFuelOverheated";
const fuelKw = (c: PassiveCtx) => (c.actor.getPotency(OVERHEAT) > 0 && c.actor.getPotency(FUEL) <= 0 ? OVERHEAT : FUEL);
const fuelAmount = (c: PassiveCtx) => c.actor.getPotency(FUEL) + c.actor.getPotency(OVERHEAT);
const fuelUsed = (c: ScriptCtx): number => c.action.consumedStack(FUEL) + c.action.consumedStack(OVERHEAT);
function useFuel(c: PassiveCtx, n: number): number {
  const amt = Math.min(n, fuelAmount(c));
  if (amt <= 0) return 0;
  const kw = fuelKw(c);
  c.lose("actor", kw, amt);
  const left = c.actor.getPotency(FUEL);
  if (kw === FUEL && left > 0 && left <= 50 && c.actor.convert(FUEL, OVERHEAT)) c.note("燃料≤50层：转化为过热燃料");
  return amt;
}
const coinUsesFuel = (c: ScriptCtx): boolean =>
  ((c.skillData as RawSkill).coins?.[c.coinIndex ?? -1]?.abilityScriptList ?? []).some((s) => s.scriptName.includes(FUEL));

// ---------------------------------------------------------------- 染血之手 (BloodyHandGreg)
const BLOODY = ["BloodyHandGregFirst", "BloodyHandGregSecond", "BloodyHandGregThird"];
const bloodyKw = (c: PassiveCtx) => BLOODY.find((k) => c.actor.getPotency(k) > 0) ?? BLOODY[0]!;
const bloodyUsed = (c: ScriptCtx): number => BLOODY.reduce((s, k) => s + c.action.consumedStack(k), 0);

registerScripts(
  // SkillAbility_TenthGregorThirdSkillDmgUp<a>And<b>And<c>: lostRatio / (a×0.001) × (b×0.001), max c×0.001.
  {
    name: /^TenthGregorThirdSkillDmgUp(\d+)And(\d+)And(\d+)$/,
    summary: "自身每失去1%体力伤害+1.5%（最多+90%）",
    skillMods(c) {
      const m = /(\d+)And(\d+)And(\d+)$/.exec(c.script.scriptName)!;
      const per = Number(m[1]) * 0.001;
      const v = Math.min(((c.battle.lostHpPct / 100) / per) * Number(m[2]) * 0.001, Number(m[3]) * 0.001);
      return v > 0 ? { dmg: v } : undefined;
    },
  },
  // SkillAbility_TenthGregorThirdSkillHpRecover.OnStartTurn: use all BloodyHandGreg stack above bd.stack(10); heal used × value.
  {
    name: "TenthGregorThirdSkillHpRecover",
    summary: "消耗所有超出10层的[BloodyHandGregFirst]，恢复(消耗层数×3)点体力",
    approx: "体力恢复未计入",
    skillMods(c) {
      const kw = bloodyKw(c);
      const used = c.actor.getPotency(kw) - (bdOf(c).stack ?? 10);
      if (used <= 0) return;
      c.lose("actor", kw, used);
    },
  },
  // SkillAbility_TenthGregorThirdSkillReroll: UsedBuffStack(BloodyHandGreg) ≥ bd.stack(20) → reroll count Round(value); applied by the coin ability.
  {
    name: "TenthGregorThirdSkillReroll",
    summary: "消耗了20层[BloodyHandGregFirst]时重复使用最后一枚硬币（由硬币效果执行）",
  },
  // CoinAbility_TenthGregorThirdSkillRerollCoinAbility.CheckReRoll: skill has TenthGregorThirdSkillReroll with satisfied count.
  {
    name: "TenthGregorThirdSkillRerollCoinAbility",
    summary: "满足条件时重复使用本硬币1次",
    rerolls(c) {
      const r = ((c.skillData as RawSkill).abilityScripts ?? []).find((s) => s.scriptName === "TenthGregorThirdSkillReroll");
      if (!r) return 0;
      return bloodyUsed(c) >= (r.buffData?.stack ?? 20) ? Math.max(1, Math.round(r.buffData?.value ?? 1)) : 0;
    },
  },
  // CoinAbility_AtackDmgUp1121103 (AttackDmgUpByRatioViaUsedBuffCheckDevideByStack): used fuel / bd.stack × bd.value, max limit%.
  {
    name: "AtackDmgUp1121103",
    summary: "本技能每消耗1层燃料，本硬币伤害+2%（最多+50%）",
    coinMods(c) {
      const bd = bdOf(c);
      const v = Math.min(Math.floor(fuelUsed(c) / Math.max(1, bd.stack ?? 1)) * (bd.value ?? 0.02), (bd.limit ?? 50) * 0.01);
      return v > 0 ? { dmg: v } : undefined;
    },
  },
  // SkillAbility_AttackDmgUp1121102.GetAttackDmgMultiplier: self has bd keyword ≥ bd.stack and the coin has a fuel-consuming ability → +value.
  {
    name: "AttackDmgUp1121102",
    summary: "消耗燃料的硬币伤害+15%（过热燃料时+30%）",
    coinMods(c) {
      const bd = bdOf(c);
      if (!bd.buffKeyword || c.actor.getPotency(bd.buffKeyword) < (bd.stack ?? 1) || !coinUsesFuel(c)) return;
      return { dmg: bd.value ?? 0 };
    },
  },
  // SkillAbility_AttackDmgUpOnUse1121103.OnStartTurn: use min(fuel, limit 25); dmg = used × value (×2 when overheated).
  {
    name: "AttackDmgUpOnUse1121103",
    summary: "使用时消耗至多25层燃料，每层伤害+2%（过热燃料时每层+4%）",
    skillMods(c) {
      const bd = bdOf(c);
      const overheated = fuelKw(c) === OVERHEAT;
      const used = useFuel(c, bd.limit ?? 25);
      if (used <= 0) return;
      return { dmg: used * (bd.value ?? 0.02) * (overheated ? 2 : 1) };
    },
  },
  // CoinAbility_GiveBuffOSAByStack/ByTurn1121102_<kw><n>: self fuel ≥ n → UseBuffStack(n), give buffData to the IntegerValue(2) enemies with lowest Combustion.
  {
    name: /^GiveBuffOSABy(?:Stack|Turn)1121102_FirePunchFuel(\d+)$/,
    summary: "命中时消耗10层燃料，使烧伤最低的2名敌人增加烧伤强度/层数",
    approx: "多目标：仅对主要目标施加",
    onCoinHit(c) {
      const n = Number(/(\d+)$/.exec(c.script.scriptName)![1]);
      if (fuelAmount(c) < n) return;
      useFuel(c, n);
      const bd = bdOf(c);
      if (bd.buffKeyword) c.give("target", bd.buffKeyword, bd.stack ?? 0, bd.turn ?? 0, bd.activeRound === 1 ? 1 : 0);
    },
  },
  // SkillAbility_GiveBuffOnKill1121103.OnEndBehaviour: action used fuel (911) or killed a target → give buffData (HitDamageUp 2 next turn).
  {
    name: "GiveBuffOnKill1121103",
    summary: "本技能消耗了燃料（或击杀目标）时，下回合获得2层[HitDamageUp]",
    onSkillEnd(c) {
      if (fuelUsed(c) > 0) giveBD(c, bdOf(c));
    },
  },
  // CoinAbility_GiveBuffOnSuccessAttackIfSkillUsedBuffStackThisAction_<kw><n>: action.UsedBuffStack(kw) ≥ n → give buffData.
  {
    name: "GiveBuffOnSuccessAttackIfSkillUsedBuffStackThisAction_FirePunchFuel1",
    summary: "命中时若本技能消耗了燃料，使目标增加2级烧伤强度并施加1层烧伤",
    onCoinHit(c) {
      if (fuelUsed(c) >= 1) giveBD(c, bdOf(c));
    },
  },
  // CoinAbility_GiveBuffOnSuccessAttackUsingBuffStack_<kw><n>: fuel ≥ n → UseBuffStack(n), give buffData.
  {
    name: "GiveBuffOnSuccessAttackUsingBuffStack_FirePunchFuel15",
    summary: "命中时消耗15层燃料并对目标施加2层烧伤",
    onCoinHit(c) {
      if (fuelAmount(c) < 15) return;
      useFuel(c, 15);
      giveBD(c, bdOf(c));
    },
  },
  // SkillAbility_CoinScaleAdder1121203_<div>_<per>_<max>: (self Breath + target Burst) / div × per, max;
  // with SnakeStance (bd) → div = jsonValue, per = IntegerValue, max = bd.limit.
  {
    name: /^CoinScaleAdder1121203_(\d+)_(\d+)_(\d+)$/,
    summary: "自身呼吸法与目标破裂强度之和每8级硬币威力+1（最多+4）；带有[SnakeStance]时每5级+1（最多+6）",
    skillMods(c) {
      const m = /_(\d+)_(\d+)_(\d+)$/.exec(c.script.scriptName)!;
      const bd = bdOf(c);
      const snake = !!bd.buffKeyword && ownerOf(c, bd.buffOwner).getPotency(bd.buffKeyword) >= (bd.stack ?? 1);
      const div = snake ? Math.max(1, c.script.value ?? 5) : Number(m[1]);
      const per = snake ? Math.round(bd.value ?? 1) : Number(m[2]);
      const max = snake ? bd.limit ?? 6 : Number(m[3]);
      const sum = c.actor.getPotency("Breath") + c.target.getPotency("Burst");
      const v = Math.min(Math.floor(sum / div) * per, max);
      return v > 0 ? { coinScale: v } : undefined;
    },
  },
  // CoinAbility_DmgUpByBuff1121203_<max%>: (target Burst + self Breath) × jsonValue, max max%.
  {
    name: /^DmgUpByBuff1121203_(\d+)$/,
    summary: "目标破裂与自身呼吸法强度之和每1级本硬币伤害+10%（最多+200%）",
    coinMods(c) {
      const max = Number(/_(\d+)$/.exec(c.script.scriptName)![1]) * 0.01;
      const v = Math.min((c.target.getPotency("Burst") + c.actor.getPotency("Breath")) * (c.script.value ?? 0.1), max);
      return v > 0 ? { dmg: v } : undefined;
    },
  },
  // CoinAbility_UseBurstPoisonOnSA: target has BurstPoison → consume bd.stack.
  {
    name: "UseBurstPoisonOnSA",
    summary: "命中时消耗目标2层[BurstPoison]",
    onCoinHit(c) {
      const bd = bdOf(c);
      const kw = bd.buffKeyword ?? "BurstPoison";
      if (has(c.target, kw)) c.lose("target", kw, bd.stack ?? 2);
    },
  },
  // CoinAbility_Chaser11213Tier2/3 → PassiveAbility_1121302.ActiveChaser ("慈悲" follow-up).
  {
    name: "Chaser11213Tier2",
    summary: "命中时若敌人体力≤value(20%)或目标带有[HorrHurtNightStiletto]，则追加使用“慈悲”(1121305，每回合≤2次)",
    approx: "“慈悲”按自身追加行动在本技能后立即执行（单列为追加行动）",
    onCoinHit(c) {
      chaser11213(c, false);
    },
  },
  {
    name: "Chaser11213Tier3",
    summary: "命中时若目标混乱、体力≤value(20%)或带有[HorrHurtNightStiletto]，则追加使用“慈悲”(1121305，每回合≤2次)",
    approx: "“慈悲”按自身追加行动在本技能后立即执行；混乱仅在可选混乱模型下成立",
    onCoinHit(c) {
      chaser11213(c, true);
    },
  },
  {
    // SkillAbility_SkillChangeSpecialTo<id>.OnBeforeTurn: buffOwner(Target) CriHurtNightStiletto ≥ 1 → ChangeSkill(1121306); once per turn (desc).
    name: "SkillChangeSpecialTo1121306",
    summary: "使用前若目标带有[CriHurtNightStiletto]，改为使用“夜锥”(1121306)（每回合1次）",
    beforeUse(c) {
      if (c.state.get("turn") === c.turn) return;
      if (replaceIfBuff(c, 1121306, { reason: "目标带有[CriHurtNightStiletto]" })) c.state.set("turn", c.turn);
    },
  },
  // SkillAbility_CoinScaleAdder1121401_<diff>_<selfMax>: target speed ≥ self + diff, self speed ≤ selfMax, or target has bd kw
  // → coin power Round(jsonValue), dmg + bd.value.
  {
    name: /^CoinScaleAdder1121401_(\d+)_(\d+)$/,
    summary: "目标速度高于自身至少3点、自身速度≤1或目标带有[DelusionGregBigBird]时，硬币威力+1（部分技能伤害+40%）",
    coinMods(c) {
      const m = /_(\d+)_(\d+)$/.exec(c.script.scriptName)!;
      const bd = bdOf(c);
      const ok =
        c.battle.targetSpeed - c.battle.selfSpeed >= Number(m[1]) ||
        c.battle.selfSpeed <= Number(m[2]) ||
        (!!bd.buffKeyword && c.target.getPotency(bd.buffKeyword) >= (bd.stack ?? 1));
      if (!ok) return;
      return { coinScale: Math.round(c.script.value ?? 1), dmg: bd.value ?? 0 };
    },
  },
  // OnStartTurn: owner Sinking + Combustion ≥ bd.stack → coin power +value (class not resolved; per description).
  {
    name: "CoinScaleAdderOnStartTurnCheckSumOfTwoBuffStack_Sinking_Combustion",
    summary: "目标沉沦与烧伤强度之和不低于6级时硬币威力+1",
    skillMods(c) {
      const bd = bdOf(c);
      const o = ownerOf(c, bd.buffOwner ?? "Target");
      if (o.getPotency("Sinking") + o.getPotency("Combustion") >= (bd.stack ?? 6)) return { coinScale: Math.round(c.script.value ?? 1) };
    },
  },
  // CoinAbility_DmgMul1121403: target (abnormality) has DelusionGregBigBird or HP ≤ jsonValue → dmg + bd.value.
  {
    name: "DmgMul1121403",
    summary: "目标体力≤25%或带有[DelusionGregBigBird]时本硬币伤害+60%",
    approx: "ISIL 仅对异想体部位(BattleUnitModel_Abnormality_Part)判定体力条件，此处假设目标满足",
    coinMods(c) {
      const bd = bdOf(c);
      if (bd.buffKeyword && c.target.getPotency(bd.buffKeyword) >= (bd.stack ?? 1)) return { dmg: bd.value ?? 0.6 };
      if (c.targetHpRatio() <= (c.script.value ?? 0.25)) return { dmg: bd.value ?? 0.6 };
    },
  },
  // CoinAbility_GiveAdditionalAzureDmgByRatioOnSuccessAttackTargetViaBuffCheck: check → finalDmg × bd.value Azure damage.
  {
    name: "GiveAdditionalAzureDmgByRatioOnSuccessAttackTargetViaBuffCheck",
    summary: "命中时若目标带有[DelusionGregBigBird]，追加本硬币伤害80%的忧郁伤害",
    onCoinHit(c) {
      const bd = bdOf(c);
      if (!bd.buffKeyword || ownerOf(c, bd.buffOwner).getPotency(bd.buffKeyword) < (bd.stack ?? 1)) return;
      const d = Math.trunc((c.lastHitDamage ?? 0) * (bd.value ?? 0.8));
      if (d > 0) c.extraDamage(d, "忧郁追加伤害", { sin: "AZURE" });
    },
  },
  // CoinAbility_GiveAdditionalHitDmgOnSATargetByRatio: Trunc(finalDmg × jsonValue) HIT damage (atk resist applied).
  {
    name: "GiveAdditionalHitDmgOnSATargetByRatio",
    summary: "命中时追加本硬币伤害×value的打击伤害",
    onCoinHit(c) {
      const d = Math.trunc((c.lastHitDamage ?? 0) * (c.script.value ?? 0));
      if (d > 0) c.extraDamage(d, "打击追加伤害", { atkType: "HIT" });
    },
  },
  // SkillAbility_GiveBuffAndRecoverMp1121403.OnEndAttack: target DelusionGregBigBird ≥ 3 (or dead) → give buffData (1/turn).
  {
    name: "GiveBuffAndRecoverMp1121403",
    summary: "攻击结束时目标[DelusionGregBigBird]为3层：下回合获得1层[PlusCoinValueUp]（每回合1次）",
    onSkillEnd(c) {
      if (c.target.getPotency("DelusionGregBigBird") < 3) return;
      if (perTurnOnce(c, "plusCoin")) giveBD(c, bdOf(c));
    },
  },
  noDamageScript("ParryingResultPowerAdder1121401_3_1", "满足条件时拼点威力+2"),
  // CoinAbility_GiveBuffOSAConditional: conditionalData satisfied → resultBuffData, else buffData.
  {
    name: "GiveBuffOSAConditional",
    summary: "命中时施加状态；满足条件时改为施加结果状态（如充能≥3时光电改为3层）",
    onCoinHit(c) {
      const cd = c.script.conditionalData as CondData | undefined;
      const cond = cd?.conditionBuffData;
      let ok = false;
      if (cond?.buffKeyword) {
        const o = ownerOf(c, cond.buffOwner ?? "Self");
        const byTurn = /Turn/i.test(cd?.category ?? "");
        const v = byTurn ? o.getCount(cond.buffKeyword) : o.getPotency(cond.buffKeyword);
        const th = (byTurn ? cond.turn : cond.stack) ?? 0;
        const t = cd?.type ?? "";
        ok = t === "Less" ? v < th : t === "LessOrEqual" ? v <= th : t === "Greater" ? v > th : t === "Equal" ? v === th : v >= th;
      }
      giveBD(c, ok ? cd?.resultBuffData : bdOf(c));
    },
  },
  // SkillAbility_GiveBuffOnBattleStartByDuplicateStack_<kw>: stack = min(self kw stack, limit) → GiveBuff (1/turn).
  {
    name: "GiveBuffOnBattleStartByDuplicateStack_Charge",
    summary: "战斗开始时获得层数等同充能强度的防御状态（最多5层，每回合1次）",
    skillMods(c) {
      if (!perTurnOnce(c, "dupCharge")) return;
      const bd = bdOf(c);
      const n = Math.min(c.actor.getPotency("Charge"), (bd.limit ?? 0) > 0 ? bd.limit! : Infinity);
      if (n > 0) giveBD(c, bd, n, 0);
    },
  },
  // CoinAbility_GiveBuffOnSucceedAttackByDuplicateTurnByStackAdderByValue_<kw>: has kw → turn = min(kw stack + Round(value), limit).
  {
    name: "GiveBuffOnSucceedAttackByDuplicateTurnByStackAdderByValue_Charge",
    summary: "命中时获得(充能强度+2)层充能（最多5层）",
    onCoinHit(c) {
      const bd = bdOf(c);
      const o = ownerOf(c, bd.buffOwner ?? "Self");
      if (!has(o, "Charge")) return;
      const n = Math.min(o.getPotency("Charge") + Math.round(bd.value ?? 0), (bd.limit ?? 0) > 0 ? bd.limit! : Infinity);
      if (n > 0) giveBD(c, { ...bd, buffKeyword: bd.buffKeyword ?? "Charge" }, 0, n);
    },
  },
);

registerAbilities(
  {
    name: "BloodyHandGregBase",
    summary: "染血之手按层数(≥10/≥20)转化为II/III阶段",
    approx: "阶段转化及II/III阶段的攻击等级提升、基础技能额外破裂/流血未建模",
  },
  noDamageAbility("FirePunchFuel", "燃料≤50层时转为过热燃料（消耗时由本批次处理器转换）"),
  noDamageAbility("NightStilettoUpgrader", "回合结束时创伤为2层则下回合转化为深度创伤"),
  // BuffAbility_LanternGregBigBird.OnRoundEnd: max stack (8) and enemy alive → UseBuffAllStack, give DelusionGregBigBird 3 to the
  // highest-HP enemy (next turn); taunt +10.
  {
    name: "LanternGregBigBird",
    summary: "回合结束时目灯为8层：消耗全部层数，下回合对目标施加3层[DelusionGregBigBird]",
    approx: "按主要目标为体力最高的敌人处理；挑衅值未建模",
    onRoundEnd(c) {
      if (c.side !== "actor" || c.status.potency < 8) return;
      c.lose("actor", c.status.id, c.status.potency);
      const bd = c.ability.buffData;
      c.give("target", bd?.buffKeyword ?? "DelusionGregBigBird", bd?.stack ?? 3, bd?.turn ?? 0, bd?.activeRound === 1 ? 1 : 0);
    },
  },
);
