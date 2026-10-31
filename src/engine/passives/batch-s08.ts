/** Script/status batch 08 — see data/il2cpp/dossiers/scripts-08.md */
import { attackWeightDiff } from "../attack-weight";
import {
  noDamageAbility,
  noDamageScript,
  registerAbilities,
  registerScripts,
  type AbilityCtx,
  type PassiveCtx,
  type ScriptCtx,
  type ScriptData,
  type ScriptHandler,
} from "./framework";

type BD = NonNullable<ScriptData["buffData"]>;

const isDefaultSkill = (c: PassiveCtx) => c.skill?.slot === "S1" || c.skill?.slot === "S2" || c.skill?.slot === "S3";
const ownerOf = (c: PassiveCtx, who?: string) => (who === "Target" ? c.target : c.actor);
/** 10416 (黑派) receives Charge as ChargeNoirAlly (subIdList contains Charge). */
const kwFor = (c: PassiveCtx, kw: string) =>
  kw === "Charge" && (c.actor.get("ChargeNoirAlly") || c.identityId === 10416) ? "ChargeNoirAlly" : kw;

function giveBD(c: PassiveCtx, bd: BD | undefined, stack = bd?.stack ?? 0, turn = bd?.turn ?? 0): void {
  if (!bd?.buffKeyword || (stack <= 0 && turn <= 0)) return;
  const side = bd.target === "Self" ? "actor" : "target";
  c.give(side, side === "actor" ? kwFor(c, bd.buffKeyword) : bd.buffKeyword, Math.max(0, stack), Math.max(0, turn), (bd.activeRound ?? 0) as 0 | 1);
}

/** Spend count (层数) of an actor status; returns the amount spent. */
function useCount(c: PassiveCtx, id: string, n: number): number {
  const have = c.actor.getCount(id);
  const used = Math.min(have, Math.max(0, Math.trunc(n)));
  if (used <= 0) return 0;
  c.actor.consumeCount(id, used);
  c.note(`消耗 ${used} 层 ${id}`);
  return used;
}

/** Buff-stack division used by *ViaBuffDiv scripts: floor(stack/bd.stack) + floor(turn/bd.turn). */
function divCount(potency: number, count: number, bd: BD): number {
  let n = 0;
  if ((bd.stack ?? 0) > 0) n += Math.floor(potency / bd.stack!);
  if ((bd.turn ?? 0) > 0) n += Math.floor(count / bd.turn!);
  return n;
}
const capLimit = (v: number, bd: BD) => ((bd.limit ?? 0) > 0 ? Math.min(v, bd.limit!) : v);

// BuffAbility_10416GiveBuffOnSelfChargingTurn (on NoirSuitAlly): gaining Charge turn by own default skill → same NoirSuit stacks,
// spending → ×2 (_MUL_FOR_USE, desc), at most 30 per round (ability value). Fed explicitly by the 10416 scripts below.
const noirRound = new WeakMap<object, { turn: number; n: number }>();
function noirCharge(c: PassiveCtx, gained: number, used: number): void {
  if (!c.actor.get("NoirSuitAlly") || !isDefaultSkill(c)) return;
  let rec = noirRound.get(c.actor);
  if (!rec || rec.turn !== c.turn) rec = { turn: c.turn, n: 0 };
  const add = Math.min(gained + used * 2, 30 - rec.n);
  if (add <= 0) return;
  rec.n += add;
  noirRound.set(c.actor, rec);
  c.give("actor", "NoirSuitAlly", add, 0);
}

function realisation(name: string): ScriptHandler {
  const max = Number(/useMax(\d+)$/.exec(name)![1]);
  return {
    // SkillAbility_10416DmgMultiplierByRealisationOST.OnStartTurn_BeforeLog: UseBuffStack(RealisationAlly(2071), min(stack, max))，
    // 伤害 +used×jsonValue；_DIV_V1/_ADDER_V2 由名字第2/3个整数给出（此处无）→ 无威力加成（最终威力+1 来自另一脚本）
    name,
    summary: `消耗最多${max}层觉醒织纹，每层伤害+value`,
    skillMods(c) {
      const used = Math.min(c.actor.getPotency("RealisationAlly"), max);
      if (used <= 0) return;
      c.lose("actor", "RealisationAlly", used);
      return { dmg: used * (c.script.value ?? 0) };
    },
  };
}

registerScripts(
  {
    // SkillAbility_SpecialSkill1041203.OnBeforeTurn/CheckCondition: Σ enemies GazeRyoshu stack ≥ bd.stack(7) or any ContemptRyoshu ≥ 1
    // → ChangeSkill(1041205). Single target: the main target only.
    name: "SpecialSkill1041203",
    summary: "全体敌方视线≥7层或带轻蔑时，使用前转化为“轻蔑下所倾落的敬畏之视线”(1041205)",
    approx: "单体模拟：仅统计主要目标的视线层数",
    beforeUse(c) {
      if (c.target.getPotency("GazeRyoshu") >= (c.script.buffData?.stack ?? 7) || c.target.getPotency("ContemptRyoshu") >= 1) {
        c.replaceSkill?.(1041205, "视线≥7层或带轻蔑");
      }
    },
  },
  {
    // CoinAbility_SwitchVibrationOnSucceedAttack(IfUsableInDuel): 命中且硬币未被摧毁 → SwitchTargetVibrationToSpecial(buffKeyword)
    name: "SwitchVibrationOnSucceedAttackIfUsableInDuel",
    summary: "命中时将目标的震颤转换为指定特殊震颤",
    onCoinHit(c) {
      const kw = c.script.buffData?.buffKeyword;
      if (kw && c.target.convert("Vibration", kw)) c.note(`震颤转换为 ${kw}`);
    },
  },
  {
    // SkillAbility_CoinScaleAdderOnSTViaSelfBreathAndBuffCheck.CheckDivide: (目标[kw]+自身呼吸法) 强度/stack + 层数/turn，×value，上限 limit
    name: "CoinScaleAdderOnSTViaSelfBreathAndBuffDivide",
    summary: "自身呼吸法强度与目标指定状态强度之和每满stack级，硬币威力+value(上限limit)",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const o = ownerOf(c, bd.buffOwner ?? "Target");
      const n = divCount(o.getPotency(bd.buffKeyword) + c.actor.getPotency("Breath"), o.getCount(bd.buffKeyword) + c.actor.getCount("Breath"), bd);
      const v = capLimit(n * (bd.value ?? 1), bd);
      if (v > 0) return { coinScale: v };
    },
  },
  {
    // SkillAbility_GiveBuffBeforeAttackIfOnesideAttack: BeforeAttack，无拼点(单方面攻击)时施加 buffData
    name: "GiveBuffBeforeAttackIfOnesideAttack",
    summary: "单方面攻击时，攻击前施加buffData状态",
    approx: "按无拼点（单方面攻击）处理",
    skillMods(c) {
      giveBD(c, c.script.buffData);
    },
  },
  {
    // CoinAbility_GiveBuffOnSucceedAttackByDuplicateStackDevideByValue.GetStack: Round(目标Burst/bd.value)+jsonValue，上限 limit（描述：向下取整）
    name: "GiveBuffOnSucceedAttackByDuplicateStackDevideByValue_Burst",
    summary: "命中时使自身增加(目标破裂强度/value)+N级呼吸法强度(上限limit)",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!bd) return;
      const div = (bd.value ?? 1) || 1;
      const n = capLimit(Math.floor(ownerOf(c, bd.buffOwner ?? "Target").getPotency("Burst") / div) + (c.script.value ?? 0), bd);
      giveBD(c, bd, n, 0);
    },
  },
  noDamageScript("Passive1041301SetMotion", "仅演出动作"),
  noDamageScript("Passive1041303SetVoice", "仅语音"),
  {
    // CoinAbility_GiveScarletDmgOSAViaBuffDiv(_TYPE=AZURE): 命中 → (owner[kw] 强度/stack + 层数/turn)×value 点忧郁伤害(GiveHpDamageAppliedAttributeResist)
    name: "GiveAzureDmgOSAViaBuffDiv",
    summary: "命中时造成相当于目标沉沦强度的忧郁伤害",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const o = ownerOf(c, bd.buffOwner ?? "Target");
      const dmg = capLimit(divCount(o.getPotency(bd.buffKeyword), o.getCount(bd.buffKeyword), bd) * (bd.value ?? 1), bd);
      if (dmg > 0) c.extraDamage(dmg, `忧郁追加伤害(${bd.buffKeyword})`, { sin: "AZURE" });
    },
  },
  {
    name: "UseBullet[necessary:BulletGodok:1]",
    summary: "本硬币消耗1发孤独弹药；弹药不足时硬币不发动",
    beforeCoin(c) {
      if (c.actor.getPotency("BulletGodok") <= 0) c.cancelCoin("孤独弹药不足（UseBullet[necessary:BulletGodok:1]）");
    },
    coinMods(c) {
      if (c.actor.getPotency("BulletGodok") > 0) c.lose("actor", "BulletGodok", 1);
      else c.note("孤独弹药不足（实际无法使用该技能）");
    },
  },
  {
    // SkillAbility_AttackDmgMultiplierOnUseDivideByLessThenTargetNum: (攻击容量 - 存活目标数)/名字整数 × jsonValue
    name: "AttackDmgMultiplierOnUseDivideByLessThenTargetNum_1",
    summary: "攻击容量高于目标数时，每高1点伤害+value",
    approx: "攻击容量=技能 targetNum + TagetNumAdder 类脚本估算 + 脚本运行时增减；存活目标数取场景“目标数量”",
    coinMods(c) {
      const { diff } = attackWeightDiff(c);
      const div = Number(/_(\d+)$/.exec(c.script.scriptName)?.[1] ?? 1) || 1;
      const n = Math.floor(diff / div);
      if (n > 0) return { dmg: n * (c.script.value ?? 0) };
    },
  },
  {
    // CoinAbility_ForceToActivateBuffOSA(Critical): 暴击命中且目标带有 kw → ForceToActivateSinBuffEffect，层数-turn
    name: "ForceToActivateBuffOSACritical",
    summary: "暴击命中时触发目标的指定状态(烧伤/流血)并使其层数减少",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!c.isCritical || !bd?.buffKeyword) return;
      const p = c.target.getPotency(bd.buffKeyword);
      if (p <= 0 || c.target.getCount(bd.buffKeyword) <= 0) return;
      c.extraDamage(p, `暴击强制触发${bd.buffKeyword}`);
      c.target.consumeCount(bd.buffKeyword, Math.max(1, bd.turn ?? 1));
    },
  },
  {
    // SkillAbility_GiveBuffOnEndAttack1041503: 攻击结束，对命中目标随机分配 (SojiRyoshuEchoPast + value) 层（单目标全部给予）
    name: "GiveBuffOnEndAttack1041503",
    summary: "攻击结束对目标施加(纠缠层数+10)层剑痕[残像]",
    onSkillEnd(c) {
      const bd = c.script.buffData;
      if (!bd) return;
      giveBD(c, bd, capLimit(c.actor.getPotency("SojiRyoshuEchoPast") + (bd.value ?? 0), bd), 0);
    },
  },
  {
    // CoinAbility_GiveBuffOnSucceedAttackByDuplicateStack: stack = 自身 SojiRyoshuEchoPast 层数，上限 limit
    name: "GiveBuffOnSucceedAttackByDuplicateStack_SojiRyoshuEchoPast",
    summary: "命中时对目标施加层数等于自身纠缠层数的剑痕[残像](上限limit)",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!bd) return;
      giveBD(c, bd, capLimit(ownerOf(c, bd.buffOwner ?? "Self").getPotency("SojiRyoshuEchoPast"), bd), 0);
    },
  },
  {
    // CoinAbility_GiveAtkTypeDmgOSAByRatioViaBuffDiv(SLASH, Critical): 暴击命中 → trunc(finalDmg × 层数/stack × value) 斩击伤害
    name: "GiveSlashDmgOSACByRatioViaBuffDiv",
    summary: "暴击命中时追加本硬币最终伤害×(纠缠层数×value)的斩击伤害",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!c.isCritical || !bd?.buffKeyword) return;
      const o = ownerOf(c, bd.buffOwner ?? "Self");
      const ratio = capLimit(divCount(o.getPotency(bd.buffKeyword), o.getCount(bd.buffKeyword), bd) * (bd.value ?? 0), bd);
      const dmg = Math.trunc((c.lastHitDamage ?? 0) * ratio);
      if (dmg > 0) c.extraDamage(dmg, `暴击追加斩击伤害(${Math.round(ratio * 100)}%)`, { atkType: "SLASH" });
    },
  },
  {
    // 类未解析：按描述/buffData — 目标烧伤强度+流血强度 每满 stack 级，基础威力 +value(上限 limit)
    name: "SkillPowerAdderOnSTViaSumOfTwoBuffStackDivide_Combustion_Laceration",
    summary: "目标烧伤强度与流血强度之和每有6级，基础威力+1(最多+5)",
    approx: "类未解析，按描述与 buffData 实现",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd) return;
      const o = ownerOf(c, bd.buffOwner ?? "Target");
      const sum = o.getPotency("Combustion") + o.getPotency("Laceration");
      const v = capLimit(Math.floor(sum / ((bd.stack ?? 6) || 6)) * (bd.value ?? 1), bd);
      if (v > 0) return { basePower: v };
    },
  },
  {
    // SkillAbility_10416AddShieldByMaxHpRatioUseBuffTurnBase.AddShield: 充能强度≥stack 且层数≥turn → UseBuffTurn(limit)，护盾 maxHp×value
    name: "10416AddShieldByMaxHpRatioOBSIfUseBuffTurn",
    summary: "战斗开始时充能强度≥3且层数≥12则消耗6层充能获得护盾(每回合最多2次)",
    approx: "护盾不影响输出未建模；按技能使用时结算（实际为战斗开始）",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const id = kwFor(c, bd.buffKeyword);
      const key = `t${c.turn}`;
      const n = c.state.get(key) ?? 0;
      if (n >= (Number(c.script.turnLimit) || 2)) return;
      if (c.actor.getPotency(id) < (bd.stack ?? 0) || c.actor.getCount(id) < (bd.turn ?? 0)) return;
      c.state.set(key, n + 1);
      noirCharge(c, 0, useCount(c, id, bd.limit ?? 0));
    },
  },
  {
    // CoinAbility_10416BuffTurnChargingOSAByBuffStack.CheckStackAndTurn: 层数 = 自身充能强度 + stack，上限 limit
    name: "10416BuffTurnChargingOSAByBuffStack",
    summary: "命中时获得(充能强度+3)层充能(最多6层)",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const id = kwFor(c, bd.buffKeyword);
      const n = capLimit(c.actor.getPotency(id) + (bd.stack ?? 0), bd);
      if (n <= 0) return;
      c.give("actor", id, 0, n);
      noirCharge(c, n, 0);
    },
  },
  {
    // 类未解析：按名字(power1/scale0)与 buffData — 层数≥limit 时消耗 turn 层，最终威力+power、硬币威力+scale、伤害+value
    name: "10416DmgMultiplierAndPowerAdderOSTIfUseBuffTurn_power1_scale0_parrying0",
    summary: "充能层数≥12时消耗6层，最终威力+1、伤害+20%",
    approx: "类未解析，按描述、脚本名参数与 buffData 实现",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const id = kwFor(c, bd.buffKeyword);
      if (c.actor.getCount(id) < (bd.limit ?? 0)) return;
      const used = useCount(c, id, bd.turn ?? 0);
      if (used <= 0) return;
      noirCharge(c, 0, used);
      const m = /power(\d+)_scale(\d+)/.exec(c.script.scriptName);
      return { finalPower: Number(m?.[1] ?? 0), coinScale: Number(m?.[2] ?? 0), dmg: bd.value ?? 0 };
    },
  },
  realisation("10416DmgMultiplierByRealisationOST_useMax15"),
  realisation("10416DmgMultiplierByRealisationOST_useMax20"),
  {
    // SkillAbility_10416DmgMultiplierOSTByUseBuffTurn: 层数≥limit → UseBuffTurn(min(层数, turn))，伤害 +used×value
    name: "10416DmgMultiplierOSTByUseBuffTurn",
    summary: "充能层数达到条件时消耗最多20层，每层伤害+1%",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const id = kwFor(c, bd.buffKeyword);
      if (c.actor.getCount(id) < (bd.limit ?? 0)) return;
      const used = useCount(c, id, bd.turn ?? 0);
      if (used <= 0) return;
      noirCharge(c, 0, used);
      return { dmg: used * (bd.value ?? 0) };
    },
  },
  {
    // SkillAbility_GiveBuffConditionalOnStartTurn: conditionalData 条件满足 → 以 resultBuffData 施加
    name: "GiveBuffConditionalOnStartTurn",
    summary: "使用时按条件施加状态（如充能层数<12时获得2层充能）",
    skillMods(c) {
      const cd = c.script.conditionalData as { category?: string; type?: string; conditionBuffData?: BD; resultBuffData?: BD } | undefined;
      const cond = cd?.conditionBuffData;
      if (!cd || !cond?.buffKeyword) return;
      const o = ownerOf(c, cond.buffOwner ?? "Self");
      const id = o === c.actor ? kwFor(c, cond.buffKeyword) : cond.buffKeyword;
      const byTurn = /Turn/i.test(cd.category ?? "");
      const v = byTurn ? o.getCount(id) : o.getPotency(id);
      const th = (byTurn ? cond.turn : cond.stack) ?? 0;
      const t = cd.type ?? "";
      const ok = t === "Less" ? v < th : t === "LessOrEqual" ? v <= th : t === "Greater" ? v > th : t === "Equal" ? v === th : v >= th;
      if (!ok) return;
      const r = cd.resultBuffData;
      giveBD(c, r);
      if (r?.target === "Self" && r.buffKeyword === "Charge") noirCharge(c, r.turn ?? 0, 0);
    },
  },
  {
    // CoinAbility_GiveBuffOnSuccessAttackUsingBuffTurn: 自身 kw 层数≥N → UseBuffTurn(N) 并施加 buffData
    name: "GiveBuffOnSuccessAttackUsingBuffTurn_Charge2",
    summary: "命中时消耗2层充能并施加buffData状态",
    onCoinHit(c: ScriptCtx) {
      const id = kwFor(c, "Charge");
      if (c.actor.getCount(id) < 2) return;
      useCount(c, id, 2);
      giveBD(c, c.script.buffData);
    },
  },
);

const onTarget = (c: AbilityCtx) => c.side === "target";

registerAbilities(
  {
    // BuffAbility_GazeRyoshuAbility: 持有者受到 10412(0x28AC) 攻击伤害 +层数×value；回合结束满层(7) → 下回合转化为轻蔑
    name: "GazeRyoshuAbility",
    summary: "视线：每层使受到良秀(#10412)的伤害+10%；满7层回合结束转化为轻蔑",
    approx: "持有者阵亡时转移视线未建模；转化时移除视线按描述处理",
    coinMods(c) {
      if (onTarget(c) && c.identityId === 10412) return { dmg: c.status.potency * (c.ability.value ?? 0.1) };
    },
    onRoundEnd(c) {
      if (!onTarget(c) || c.target.getPotency("GazeRyoshu") < 7) return;
      c.give("target", "ContemptRyoshu", 1, 0, 1);
      c.target.destroy("GazeRyoshu");
      c.note("视线满7层：下回合转化为轻蔑");
    },
  },
  noDamageAbility("AddShieldOnRSByBuffStack", "回合开始按呼吸法强度获得护盾"),
  noDamageAbility("AggroAdderOnRoundEnd", "挑衅值增加"),
  {
    // BuffAbility_GiveBuffOnTakeSinBuffDamage(_Sinking): 受到沉沦伤害时自身+1层余香
    name: "GiveBuffOnTakeSinBuffDamage_Sinking",
    summary: "余香：受到沉沦伤害时获得1层余香",
    approx: "以“命中时目标带有沉沦”近似受到沉沦伤害",
    onCoinHit(c) {
      if (onTarget(c) && c.target.getPotency("Sinking") > 0 && c.target.get("AlriuneEGOThey")) c.give("target", "AlriuneEGOThey", 1, 0);
    },
  },
  {
    // BuffAbility_VibrationExplosion10414.RightAfterGettingBuff: 满层 → 震颤强度+2、震颤引爆、受到沉沦强度的忧郁伤害、解除余香
    name: "VibrationExplosion10414",
    summary: "余香满30层：震颤强度+2并引爆，受到相当于沉沦强度的忧郁伤害，解除余香",
    approx: "震颤引爆仅影响混乱阈值未计；本回合不可再获得余香未建模",
    onCoinHit(c) {
      if (!onTarget(c) || c.target.getPotency("AlriuneEGOThey") < 30) return;
      c.give("target", "Vibration", 2, 0);
      const s = c.target.getPotency("Sinking");
      if (s > 0) c.extraDamage(s, "余香满层：忧郁伤害(沉沦强度)", { sin: "AZURE" });
      c.target.destroy("AlriuneEGOThey");
    },
  },
  noDamageAbility("GiveBuffOnVibrationExplosion10414", "震颤引爆时向其他友方扩散余香"),
  noDamageAbility("GiveBuffToAlliesOnDie10414", "阵亡时扩散余香"),
  noDamageAbility("AlriuneEGOTheyEffect", "仅特效"),
  noDamageAbility("AlriuneEGOWeEffect", "仅特效"),
  {
    // BuffAbility_TakeAtkDamageMultiplierViaBuffCheckDevideByStack.CalculateTakeDmgMultiplier (ISIL):
    //   floor(层数/stack)×_value + bd.value，上限 bd.limit×0.01(_DEFAULT_RATIO)。能力未给 value 时按 bd.value 作每档系数（缝纫对象：每级流血+0.5%，最多10%）。
    name: "TakeAtkDamageMultiplierViaBuffCheckDevideByStack",
    summary: "每带有stack层，受到指定类型攻击伤害+value",
    coinMods(c) {
      const bd = c.ability.buffData;
      const atk = (c.ability as { atk?: string }).atk;
      if (!onTarget(c) || !bd || (atk && c.skill?.atkType !== atk)) return;
      const o = bd.buffKeyword && bd.buffKeyword !== c.status.id ? c.target : null;
      const p = o ? o.getPotency(bd.buffKeyword!) : c.status.potency;
      const n = Math.floor(p / ((bd.stack ?? 1) || 1));
      if (n <= 0) return;
      const per = c.ability.value ?? bd.value ?? 0.01;
      const flat = c.ability.value != null ? bd.value ?? 0 : 0;
      let v = n * per + flat;
      if ((bd.limit ?? 0) > 0) v = Math.min(v, bd.limit! * 0.01);
      if (v > 0) return { dmg: v };
    },
  },
  noDamageAbility("ActivateBuffEffectSkin_Center", "仅特效"),
  {
    // BuffAbility_SojiRyoshuEchoFutureTakeDmgMul: 攻击者为 10415 且为基础技能 → 受到伤害 +value
    name: "SojiRyoshuEchoFutureTakeDmgMul",
    summary: "残影：受到蜘蛛巢之刃良秀(#10415)基础技能的伤害+5%",
    coinMods(c) {
      if (onTarget(c) && c.identityId === 10415 && isDefaultSkill(c)) return { dmg: c.ability.value ?? 0.05 };
    },
  },
  {
    name: "SojiRyoshuEchoPastMinMaxStack",
    summary: "纠缠：最小/最大层数管理",
    approx: "纠缠的最小层数补足与最大层数提升（系统能力层数）未建模",
  },
  noDamageAbility("10416GiveBuffBeforeTakeAttackIfHasShield", "带护盾受到攻击时获得大衣层数"),
  {
    name: "10416GiveBuffOnSelfChargingTurn",
    summary: "通过自身基础技能获得/消耗充能层数时获得黑派大衣层数(每回合最多30层)",
    approx: "仅由本批 10416 脚本的充能获得/消耗驱动；GiveBuffOnUse 等通用脚本带来的充能变化、被动消耗未计入",
  },
  {
    // BuffAbility_10416BuffChangerORE.OnRoundEnd: 层数达到 value(100) → 下回合转化为 RealisationAlly(100)
    name: "10416BuffChangerORE",
    summary: "黑派大衣达到100层时，下回合转化为100层觉醒织纹",
    onRoundEnd(c) {
      if (c.side !== "actor" || c.actor.getPotency("NoirSuitAlly") < (c.ability.value ?? 100)) return;
      const bd = c.ability.buffData;
      c.actor.destroy("NoirSuitAlly");
      c.give("actor", bd?.buffKeyword ?? "RealisationAlly", bd?.stack ?? 100, 0, 1);
    },
  },
  noDamageAbility("DefSkillPowerResultAdderAsStack", "忍耐：仅提高守备技能最终威力"),
);
