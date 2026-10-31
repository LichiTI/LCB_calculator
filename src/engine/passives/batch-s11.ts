/** Script/status batch 11 — see data/il2cpp/dossiers/scripts-11.md */
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

type BD = NonNullable<ScriptData["buffData"]>;
interface SkillShape {
  coins: { abilityScriptList?: ScriptData[] }[];
}

const owner = (c: PassiveCtx, bd: BD | undefined): StatusContainer => (bd?.buffOwner === "Self" ? c.actor : c.target);

/** CoinAbility_BasicBuff.GiveBuff with buffData (optional stack/turn override). */
function giveBD(c: PassiveCtx, bd: BD | undefined, stack = bd?.stack ?? 0, turn = bd?.turn ?? 0): void {
  if (!bd?.buffKeyword || (stack <= 0 && turn <= 0)) return;
  c.give(bd.target === "Self" ? "actor" : "target", bd.buffKeyword, stack, turn, bd.activeRound === 1 ? 1 : 0);
}

const isDefaultInclDef = (c: PassiveCtx) => ["S1", "S2", "S3", "DEF"].includes(c.skill?.slot ?? "");

/** Vibration explosion on the target; only VibrationIgnition deals HP damage. */
function vibrationExplosion(c: PassiveCtx, tag: string): void {
  const rec = triggerVibrationExplosion(c.target, c.turn, tag);
  if (!rec) return;
  if (rec.hpDamage > 0) c.extraDamage(rec.hpDamage, `${tag}（震颤-灼热）`);
  else c.note(`${tag}：混乱阈值前移 ${rec.staggerShift}`);
}

/** Plain on-hit give scripts (CoinAbility_GiveBuffOnSucceedAttack[Head]/OnSuccessCriticalAttack) and their trigger check. */
const PLAIN_GIVE: Record<string, (c: PassiveCtx) => boolean> = {
  GiveBuffOnSucceedAttack: () => true,
  GiveBuffOnSucceedAttackHead: (c) => Boolean(c.isHeads),
  GiveBuffOnSuccessCriticalAttack: (c) => Boolean(c.isCritical),
};

/**
 * SkillAbility_1060903 records the Vibration turns it used (UsedVibrationTurn); its coin abilities read it.
 * Thin wrapper over the per-action record (c.action.consumedTurn); kept exported for the coin-4 script in batch-s12.
 */
export function vibrationUsed1060903(c: ScriptCtx): number {
  return c.action.consumedTurn("Vibration");
}

const HP_DMG = (n: number) => ({
  name: `GiveHpDmgOnSucceedAttackHeadTarget${n}`,
  summary: `正面命中时对目标额外造成${n}点伤害`,
  // CoinAbility_GiveHpDmgOnSucceedAttackHeadTarget.OnSucceedAttack: heads → GiveAbsHpDamage(N).
  onCoinHit(c: ScriptCtx) {
    if (c.isHeads) c.extraDamage(n, `正面命中追加${n}点伤害`);
  },
});

registerScripts(
  // SkillAbility_CoinScaleAdderIfNotDamagedPrevTurn: round 1 → 0; damage taken last turn → 0; else +N.
  {
    name: "CoinScaleAdderIfNotDamagedPrevTurn1",
    summary: "上回合未受到伤害时硬币威力+1（第1回合不生效）",
    approx: "模拟中目标不攻击，自身从未受伤",
    skillMods(c) {
      if (c.turn > 1) return { coinScale: 1 };
    },
  },
  {
    name: "CoinScaleAdderIfNotDamagedPrevTurn2",
    summary: "上回合未受到伤害时硬币威力+2（第1回合不生效）",
    approx: "模拟中目标不攻击，自身从未受伤",
    skillMods(c) {
      if (c.turn > 1) return { coinScale: 2 };
    },
  },
  // SkillAbility_1060202.BeforeAttack: target Laceration turn < 4 → CopyCoinModelAndAddToListByIndex(0), (1) (extra uses).
  {
    name: "1060202",
    summary: "目标流血层数低于4层时额外使用第1、2枚硬币各1次",
    // BeforeAttack runs after the on-use statuses: modelled in the skillMods coin-edit window.
    skillMods(c) {
      if (c.target.getCount("Laceration") >= 4) return;
      c.coins?.add({ copyOf: 0 });
      c.coins?.add({ copyOf: 1 });
    },
  },
  // SkillAbility_BuffStackAdderOnStartBattle.GetBuffStackAdder: +N stack to every buff this skill gives (activated at battle start).
  {
    name: "BuffStackAdderOnStartBattle1",
    summary: "本技能施加的状态强度/层数(stack)额外+1",
    approx: "仅对普通“命中时施加”类硬币效果追加；其他施加途径未覆盖",
    onCoinHit(c) {
      const coin = (c.skillData as SkillShape).coins?.[c.coinIndex ?? -1];
      for (const s of coin?.abilityScriptList ?? []) {
        const bd = s.buffData;
        if (!bd?.buffKeyword || (bd.stack ?? 0) <= 0 || !PLAIN_GIVE[s.scriptName]?.(c)) continue;
        c.give(bd.target === "Self" ? "actor" : "target", bd.buffKeyword, 1, 0, bd.activeRound === 1 ? 1 : 0);
      }
    },
  },
  // CoinAbility_1060302_3: heads hit, not a reused coin, target HP ratio < _HP_RATIO_COND (0.25) → reuse coin.
  {
    name: "1060302_3",
    summary: "正面命中且目标体力低于25%时重复使用本硬币",
    rerolls(c) {
      return c.isHeads && !c.isRerolled && c.targetHpRatio() < 0.25 ? 1 : 0;
    },
  },
  // CoinAbility_1060303_4th.GetAttackDmgMultiplier: reused skill && heads && target Laceration stack ≥ 10 → +value.
  {
    name: "1060303_4th",
    summary: "重复使用技能时正面且目标流血强度≥10则伤害+50%（未启用）",
    approx: "技能重复使用仅在击杀时发生，模拟中不触发",
  },
  {
    name: "AttackDmgUpByRatio100IfReuseSkillHead",
    summary: "重复使用技能时正面硬币伤害+100%（未启用）",
    approx: "技能重复使用仅在击杀时发生，模拟中不触发",
  },
  // CoinAbility_AttackDmgUpByRatioIfHead.GetAttackDmgMultiplier: heads → +N%.
  {
    name: "AttackDmgUpByRatio50IfHead",
    summary: "正面时本硬币伤害+50%",
    coinMods(c) {
      if (c.isHeads) return { dmg: 0.5 };
    },
  },
  // CoinAbility_AttackDmgUpByRatioIfReuseCoinHead: coin reused ([coin+0x44]) && heads → +N%.
  {
    name: "AttackDmgUpByRatio50IfReuseCoinHead",
    summary: "重复使用的本硬币正面时伤害+50%",
    coinMods(c) {
      if (c.isRerolled && c.isHeads) return { dmg: 0.5 };
    },
  },
  HP_DMG(3),
  HP_DMG(7),
  noDamageScript("ReuseOnKillTargetOnce", "击杀目标时重复使用技能"),
  // CoinAbility_1060402_2_gaksung: give buffData turn; SP ≥ 45 → +2 turn, else SP ≥ 30 → +1.
  {
    name: "1060402_2_gaksung",
    summary: "命中时施加1层烧伤；理智≥30额外+1层，≥45额外+2层",
    onCoinHit(c) {
      const bd = c.script.buffData;
      const add = c.actorSp >= 45 ? 2 : c.actorSp >= 30 ? 1 : 0;
      giveBD(c, bd, bd?.stack ?? 0, (bd?.turn ?? 0) + add);
    },
  },
  noDamageScript("1060403_2", "目标烧伤≥6层时按伤害30%使混乱阈值前移"),
  // CoinAbility_GiveBuffOnSucceedAttackSetTurnAsValueIfHasStack_<Kw><N>: owner <Kw> stack ≥ N → turn = round(value).
  {
    name: /^GiveBuffOnSucceedAttackSetTurnAsValueIfHasStack_([A-Za-z]+?)(\d+)$/,
    summary: "命中时施加指定状态；buffOwner的指定状态不低于N级时额外施加value层",
    onCoinHit(c) {
      const m = /^GiveBuffOnSucceedAttackSetTurnAsValueIfHasStack_([A-Za-z]+?)(\d+)$/.exec(c.script.scriptName)!;
      const bd = c.script.buffData;
      const ok = owner(c, bd).getPotency(m[1]!) >= Number(m[2]);
      giveBD(c, bd, bd?.stack ?? 0, ok ? Math.round(bd?.value ?? 0) : bd?.turn ?? 0);
    },
  },
  // SkillAbility_CoinScaleAdderIfSelfHpRatioNotLessThan: HP ratio ≥ N% → coin power +M.
  {
    name: /^CoinScaleAdder(\d+)IfSelfHpRatioNotLessThan(\d+)$/,
    summary: "自身现存体力不低于N%时硬币威力+M",
    coinMods(c) {
      const m = /^CoinScaleAdder(\d+)IfSelfHpRatioNotLessThan(\d+)$/.exec(c.script.scriptName)!;
      if (100 - c.battle.lostHpPct >= Number(m[2])) return { coinScale: Number(m[1]) };
    },
  },
  // CoinAbility_DmgUpByBuffStack: owner stack ≥ bd.stack && turn ≥ bd.turn → floor(stack / bd.stack) × value, cap limit%.
  {
    name: "DmgUpByBuffStack",
    summary: "按指定单位的状态强度提升本硬币伤害",
    coinMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const o = owner(c, bd);
      const st = o.getPotency(bd.buffKeyword);
      if (st < (bd.stack ?? 0) || o.getCount(bd.buffKeyword) < (bd.turn ?? 0)) return;
      const div = (bd.stack ?? 0) > 0 ? Math.floor(st / bd.stack!) : 1;
      let v = div * (bd.value ?? 0);
      if ((bd.limit ?? 0) > 0) v = Math.min(v, bd.limit! * 0.01);
      return v > 0 ? { dmg: v } : undefined;
    },
  },
  // CoinAbility_GiveBuffOnSucceedAttackByDuplicateTurnByStack: give bd keyword with turn = owner(self) <Kw> stack.
  {
    name: "GiveBuffOnSucceedAttackByDuplicateTurnByStack_KCorpSerum",
    summary: "命中时对目标施加层数等同自身K公司安瓿层数的破裂",
    onCoinHit(c) {
      const n = owner(c, c.script.buffData).getPotency("KCorpSerum");
      if (n > 0) giveBD(c, c.script.buffData, 0, n);
    },
  },
  // SkillAbility_1060603.CheckCondition: Charge turn ≥ 10 → use all Charge turns, allies get ChargeForceField (used × 0.5).
  {
    name: "1060603_Charge10",
    summary: "使用时充能≥10层：消耗全部充能（友方获得充能力场）",
    approx: "友方获得充能力场不影响本单位输出",
    skillMods(c) {
      const n = c.actor.getCount("Charge");
      if (n >= 10) c.consume("actor", "Charge", n);
    },
  },
  noDamageScript("GiveBuffOnSucceedAttackDevideByTurnWithLimit4_Charge5", "按充能层数下回合获得充能力场（护盾）"),
  // SkillAbility_AttackDmgMultiplierByTargetLostHpRatio<N>Max<M>: (1 − target HP ratio) × N×0.01, cap M×0.01
  {
    name: "AttackDmgMultiplierByTargetLostHpRatio50Max50",
    summary: "目标每失去1%体力伤害+0.5%（最多50%）",
    coinMods(c) {
      const d = Math.min(c.targetLostHpRatio() * 0.5, 0.5);
      return d > 0 ? { dmg: d } : undefined;
    },
  },
  // CoinAbility_GiveBuffOnSucceedAttackSetTurnBySpeedDiff(IfFasterThanTarget): turn = min(speed diff, value).
  {
    name: "GiveBuffOnSucceedAttackSetTurnBySpeedDiffIfFasterThanTarget",
    summary: "命中时若速度高于目标，按速度差施加流血层数（最多4层）",
    onCoinHit(c) {
      const diff = c.battle.selfSpeed - c.battle.targetSpeed;
      if (diff <= 0) return;
      const bd = c.script.buffData;
      giveBD(c, bd, bd?.stack ?? 0, Math.min(diff, bd?.value ?? 4));
    },
  },
  noDamageScript("HealMpOnSucceedAttackHeadSelfViaBuffCheckDevideByStackWithLimit10", "按目标流血强度恢复理智"),
  // SkillAbility_DieciHongluCoinScaleAdderAbility: KnowledgeExplored stack ≥ bd.stack → coin + (stack − bd.stack + round(value)).
  {
    name: "DieciHongluCoinScaleAdderAbility",
    summary: "[KnowledgeExplored]达到条件时硬币威力+(层数-2+value)",
    approx: "丢弃行动槽技能未建模",
    skillMods(c) {
      const bd = c.script.buffData;
      const st = c.actor.getPotency(bd?.buffKeyword ?? "KnowledgeExplored");
      const need = bd?.stack ?? 2;
      if (st < need) return;
      const v = st - need + Math.round(bd?.value ?? 0);
      return v > 0 ? { coinScale: v } : undefined;
    },
  },
  // CoinAbility_DieciHongluRerollCoinAbility<N>.CheckReRoll: KnowledgeExplored ≥ N → reuse while count < stack − N + 1.
  {
    name: /^DieciHongluRerollCoinAbility(\d+)$/,
    summary: "按[KnowledgeExplored]层数重复使用本硬币(层数-1次)",
    rerolls(c) {
      const n = Number(/(\d+)$/.exec(c.script.scriptName)![1]);
      const st = c.actor.getPotency("KnowledgeExplored");
      return st >= n ? st - n + 1 : 0;
    },
  },
  noDamageScript("HealMpSelfOnBreakOrKillTarget10", "目标混乱或击杀时恢复理智"),
  // SkillAbility_1060903_2: Vibration turn ≥ 15 → use 15, else ≥ 10 → use 10; coin power = clamp(used / bd.turn, 2, 3) × value.
  {
    name: "1060903_2",
    summary: "使用时消耗自身震颤层数：≥15层消耗15层硬币威力+3，否则≥10层消耗10层硬币威力+2",
    skillMods(c) {
      const bd = c.script.buffData;
      const n = c.actor.getCount("Vibration");
      const used = n >= 15 ? 15 : n >= 10 ? 10 : 0;
      if (!used) return;
      c.consume("actor", "Vibration", used);
      const v = Math.min(3, Math.max(2, Math.floor(used / Math.max(1, bd?.turn ?? 5)))) * (bd?.value ?? 1);
      return { coinScale: v };
    },
  },
  // CoinAbility_YurodivyHongluThirdSkillCoinFirstAbility: if skill used Vibration → PileUpVibrationToSpecial(VibrationEcho).
  {
    name: "YurodivyHongluThirdSkillCoinFirstAbility_VibrationNesting",
    summary: "若使用时消耗了震颤，命中时使目标震颤融合为[VibrationEcho]（未建模）",
    approx: "需要“震颤融合(PileUpVibrationToSpecial)”能力：未转换",
    onCoinHit(c) {
      if (vibrationUsed1060903(c) > 0) c.note("震颤融合为[VibrationEcho]（未模拟）");
    },
  },
  // CoinAbility_YurodivyHongluThirdSkillCoinSecondAbilityAnd: used ≥ N → VibrationExplosion, target loses M Vibration turn.
  {
    name: /^YurodivyHongluThirdSkillCoinSecondAbility(\d+)And(\d+)$/,
    summary: "若使用时消耗了不低于10层震颤，命中时使目标震颤引爆并减少1层震颤",
    onCoinHit(c) {
      const m = /(\d+)And(\d+)$/.exec(c.script.scriptName)!;
      if (vibrationUsed1060903(c) < Number(m[1])) return;
      vibrationExplosion(c, "震颤引爆");
      if (c.target.get("Vibration")) c.consume("target", "Vibration", Number(m[2]));
    },
  },
);

// ---------------------------------------------------------------- status abilities

/** GiveBuffStackAdderIfDefaultSkillNotZero emulation: snapshot target potency before the coin, add after if it rose. */
const adderKey = (c: AbilityCtx) => `snap:${c.turn}:${c.ability.buffData?.buffKeyword}`;

const CLAW_WOUNDS = ["BearClawWound", "BearClawWoundAlly", "EagleClawWound", "EagleClawWoundAlly"];

registerAbilities(
  // BuffAbility_GiveBuffOnTakeAttackDamagePerStackWithRoundLimitAndSkillLimit_<round>_<skill>:
  // owner takes attack damage → gain floor(own stack / value) × bd.stack of bd keyword (limits per round / per skill).
  {
    name: /^GiveBuffOnTakeAttackDamagePerStackWithRoundLimitAndSkillLimit_(\d+)_(\d+)$/,
    summary: "受到攻击时每带有value层本状态，自身获得对应状态(每回合/每技能限次)",
    onCoinHit(c) {
      if (c.side !== "target") return;
      const m = /_(\d+)_(\d+)$/.exec(c.ability.ability)!;
      const rk = `r:${c.turn}`;
      const sk = `s:${c.turn}:${c.skill?.id}`;
      if ((c.state.get(rk) ?? 0) >= Number(m[1]) || (c.state.get(sk) ?? 0) >= Number(m[2])) return;
      const bd = c.ability.buffData;
      const n = Math.floor(c.status.potency / Math.max(1, c.ability.value ?? 1));
      if (!bd?.buffKeyword || n <= 0) return;
      c.state.set(rk, (c.state.get(rk) ?? 0) + 1);
      c.state.set(sk, (c.state.get(sk) ?? 0) + 1);
      c.give("target", bd.buffKeyword, n * (bd.stack ?? 0), n * (bd.turn ?? 0));
    },
  },
  // BuffAbility_GiveBuffOnREBearClawWound.OnRoundEnd: floor(stack / value) × bd.stack (≤ limit) of bd keyword to self next round.
  {
    name: "GiveBuffOnREBearClawWound",
    summary: "回合结束时每带有4层本状态，下回合自身获得1层防御等级降低(最多2层)",
    onRoundEnd(c) {
      const bd = c.ability.buffData;
      const k = Math.floor(c.status.potency / Math.max(1, c.ability.value ?? 4));
      if (!bd?.buffKeyword || k <= 0) return;
      let n = k * (bd.stack ?? 0);
      if ((bd.limit ?? 0) > 0) n = Math.min(n, bd.limit!);
      if (n > 0) c.give(c.side, bd.buffKeyword, n, 0, bd.activeRound === 1 ? 1 : 0);
    },
  },
  noDamageAbility("BearClawWoundAllyEffect", "仅特效显示"),
  // AtkDamageMultiplierViaDivideStackCategory_FAUVISM_CLAW_WOUND: target claw-wound stacks / bd.stack × value, cap limit%.
  // (class not resolved; follows buffData and desc: every 3 stacks +5%, max 15%)
  {
    name: "AtkDamageMultiplierViaDivideStackCategory_FAUVISM_CLAW_WOUND",
    summary: "目标每带有3层被撕裂的色彩类状态，伤害+5%(最多15%)",
    approx: "能力类未解析，按buffData与描述实现",
    coinMods(c) {
      if (c.side !== "actor") return;
      const bd = c.ability.buffData;
      const sum = CLAW_WOUNDS.reduce((s, k) => s + c.target.getPotency(k), 0);
      let v = Math.floor(sum / Math.max(1, bd?.stack ?? 3)) * (c.ability.value ?? 0.05);
      if ((bd?.limit ?? 0) > 0) v = Math.min(v, bd!.limit! * 0.01);
      return v > 0 ? { dmg: v } : undefined;
    },
  },
  // BuffAbility_GiveBuffStackAdderIfDefaultSkillNotZero: default skill (incl. defense) giving bd keyword with stack > 0 → +bd.stack.
  {
    name: "GiveBuffStackAdderIfDefaultSkillNotZero",
    summary: "基础技能施加指定状态强度时额外+1",
    approx: "以命中前后目标强度上升推断“施加了该状态”，近似处理",
    coinMods(c) {
      if (c.side !== "actor" || !isDefaultInclDef(c) || !c.ability.buffData?.buffKeyword) return;
      c.state.set(adderKey(c), c.target.getPotency(c.ability.buffData.buffKeyword));
    },
    onCoinHit(c) {
      const kw = c.ability.buffData?.buffKeyword;
      if (c.side !== "actor" || !isDefaultInclDef(c) || !kw) return;
      const before = c.state.get(adderKey(c));
      c.state.delete(adderKey(c));
      if (before !== undefined && c.target.getPotency(kw) > before) c.give("target", kw, c.ability.buffData?.stack ?? 1, 0);
    },
  },
  // BuffAbility_FaubismMaskMeursaultGiveBuffOnBGAD.BeforeGiveAttackDamage: default skill, target without Laceration →
  // give buffData (Laceration turn 2), limit per round.
  {
    name: "FaubismMaskMeursaultGiveBuffOnBGAD",
    summary: "基础技能命中前若目标没有流血，对其施加2层流血(每回合1次)",
    coinMods(c) {
      if (c.side !== "actor" || !isDefaultInclDef(c) || c.target.get("Laceration")) return;
      const key = `bgad:${c.turn}`;
      const bd = c.ability.buffData;
      if ((c.state.get(key) ?? 0) >= (bd?.limit ?? 1)) return;
      c.state.set(key, (c.state.get(key) ?? 0) + 1);
      giveBD(c, bd);
    },
  },
);
