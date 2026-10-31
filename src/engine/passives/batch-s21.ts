/** Script/status batch 21 — see data/il2cpp/dossiers/scripts-21.md */
import { negativeBuffCount } from "../param-scripts";
import { triggerVibrationExplosion } from "../status";
import { lcaBulletsUsed } from "./batch-s22";
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
//   GiveBuffOnSucceedAttackByDuplicateStack_DarkFlame / _FreischutzShotCount → batch-s01 RegExp family
//   GiveRandomDebuffSinStackWithoutKeyword3 → batch-s01
//   GiveBuffOnSucceedAttackIfHasStack_LineCuttingPersonality1 → batch-s03 RegExp family
//   GiveBuffOnUseWithBloodDinnerGainBuffStackIfFailed_Laceration5[6:60:6] → batch-s05 RegExp family
//   GiveBuffOnSucceedAttackIfHasTurn_TimeRentalTwoPersonality1 → batch-s01 RegExp family
//   status LineCuttingPersonality: TakeAtkDamageMultiplierViaBuffCheckDevideByStack → batch-s08 (LineCuttingEffect below)

type BD = NonNullable<ScriptData["buffData"]>;

/** BUFF_CATEGORY_KEYWORD.VIBRATION_CONVERTED / VIBRATION_MERGED members (core.json buffs[].categoryKeywordList). */
const VIB_CONVERTED_OR_MERGED = [
  "VibrationBleeding", "VibrationChain", "VibrationCollapse", "VibrationContinue", "VibrationCrack", "VibrationDistribution",
  "VibrationEcho", "VibrationFocusing", "VibrationIgnition", "VibrationNesting", "VibrationSpring",
];

const FSC = "FreischutzShotCount";
const BLOOD_SCISSOR = "BloodScissorPersonalityFirst";
const STIGMA_STEPS = ["StigmaWorkshopHandStep1", "StigmaWorkshopHandStep2", "StigmaWorkshopHandStep3"];
const isDefaultSkill = (c: PassiveCtx) => c.skill?.slot === "S1" || c.skill?.slot === "S2" || c.skill?.slot === "S3";
const GIVE_ADDER_APPROX = "以本技能期间对目标的状态增加拦截实现（技能开始时注册，含使用时施加）";

/** Emulates GetGiveBuff{Stack,Turn}Adder of the actor's status: during a default skill, positive bd keyword gains on the enemy +N. */
function giveAdderToEnemy(c: AbilityCtx, kind: "stack" | "turn"): void {
  const bd = c.ability.buffData;
  const add = kind === "stack" ? bd?.stack ?? 0 : bd?.turn ?? 0;
  if (c.side !== "actor" || !isDefaultSkill(c) || !bd?.buffKeyword || add <= 0) return;
  const kw = bd.buffKeyword;
  c.interceptStatus?.("skill", (ch) => (ch.buffId === kw && ch.kind === kind && ch.delta > 0 ? ch.delta + add : undefined), {
    side: "target",
    key: `${c.status.id}:${c.ability.ability}`,
  });
}

/** BuffAbility_StigmaHandStackLimitRoundUnion: per-round cap (value, default 20) on Stigma step gains; one interceptor per turn. */
function stigmaLimit(c: AbilityCtx): void {
  if (c.side !== "actor") return;
  const cap = c.ability.value ?? 20;
  const store = c.state;
  const k = `gained:${c.turn}`;
  c.interceptStatus?.(
    "turn",
    (ch) => {
      if (!STIGMA_STEPS.includes(ch.buffId) || ch.kind !== "stack" || ch.delta <= 0) return;
      const gained = store.get(k) ?? 0;
      const d = Math.max(0, Math.min(ch.delta, cap - gained));
      store.set(k, gained + d);
      return d;
    },
    { side: "actor", key: `StigmaHandStackLimit:${c.turn}` },
  );
}

/** BasicBuff.GiveBuff with buffData (target "Self" → actor, otherwise main target). */
function giveBD(c: PassiveCtx, bd: BD | undefined, stack = bd?.stack ?? 0, turn = bd?.turn ?? 0): void {
  if (!bd?.buffKeyword || (stack <= 0 && turn <= 0)) return;
  c.give(bd.target === "Self" ? "actor" : "target", bd.buffKeyword, Math.max(0, stack), Math.max(0, turn), bd.activeRound === 1 ? 1 : 0);
}

/** BattleUnitModel.VibrationExplosion on the target; only VibrationIgnition deals HP damage. */
function vibrationExplosion(c: ScriptCtx, tag: string): void {
  const rec = triggerVibrationExplosion(c.target, c.turn, tag);
  if (!rec) return;
  if (rec.hpDamage > 0) c.extraDamage(rec.hpDamage, `${tag}（震颤-灼热）`);
  else c.note(`${tag}：混乱阈值前移 ${rec.staggerShift}`);
}

registerScripts(
  // CoinAbility_1110702_1.OnSucceedAttack: own FreischutzShotCount < 4 → self +1 FSC, then target DarkFlame = own FSC (next round).
  {
    name: "1110702_1",
    summary: "命中时若自身魔弹射击数<4：获得1层，并于下回合对目标施加等同其层数的黑焰",
    onCoinHit(c) {
      if (c.actor.getPotency(FSC) >= 4) return;
      c.give("actor", FSC, 1, 0);
      const n = c.actor.getPotency(FSC);
      if (n > 0) c.give("target", "DarkFlame", n, 0, 1);
    },
  },
  // SkillAbility_1110703: OnStartBehaviour self +1 FSC (buffData), lose (FSC-1)×5 SP, target num = FSC, SP ≤ 10 → 50% random target.
  // GetSkillPowerAdder/GetCoinScaleAdder: FSC ≥ 7 → +15 / +6; FSC ≥ 4 → +2 / +2. OnEndBehaviour: FSC ≥ 7 → lose all FSC.
  {
    name: "1110703",
    summary: "使用前获得1层魔弹射击数；≥4层基础威力+2、硬币威力+2，7层基础威力+15、硬币威力+6；技能结束时7层则清零",
    approx: "理智值损失与理智≤10时随机目标未建模（理智值恒定）",
    skillMods(c) {
      giveBD(c, c.script.buffData);
      const n = c.actor.getPotency(FSC);
      if (n > 0) c.setAttackWeight?.(n);
      if (n >= 7) return { basePower: 15, coinScale: 6 };
      if (n >= 4) return { basePower: 2, coinScale: 2 };
    },
    onSkillEnd(c) {
      const n = c.actor.getPotency(FSC);
      if (n >= 7) c.lose("actor", FSC, n);
    },
  },
  // CoinAbility_EighthOutisThirdSkillSecondCoinAbility(_gaksung4th: DEVIDE 1, DMG_MAX 30): target has EchoOfMansion →
  // Gloom (attribute 4) HP damage = min(Sinking stack / DEVIDE, DMG_MAX).
  {
    name: "EighthOutisThirdSkillSecondCoinAbility_gaksung4th",
    summary: "命中时若目标带有[EchoOfMansion]，额外造成等于其沉沦强度的忧郁伤害(最多30)",
    onCoinHit(c) {
      if (!c.target.get("EchoOfMansion")) return;
      const dmg = Math.min(Math.floor(c.target.getPotency("Sinking") / 1), 30);
      if (dmg > 0) c.extraDamage(dmg, "宅邸回响：沉沦强度的忧郁伤害", { sin: "AZURE" });
    },
  },
  noDamageScript("1110903", "使用时使仪表盘上两侧友方下回合获得迅捷"),
  // CoinAbility_RingFingerOutisSecondSkillCoinAbility<base>And<per>And<max> (RerollOnSAUpto): prob = (base + per × negCount) × 0.01.
  {
    name: /^RingFingerOutisSecondSkillCoinAbility(\d+)And(\d+)And(\d+)$/,
    summary: "命中后按(基础+每种负面状态)概率重复使用本硬币（每技能最多N次）",
    approx: "仅当概率≥100%时计入重复使用；概率<100%未建模（无随机数）",
    rerolls(c) {
      const m = /(\d+)And(\d+)And(\d+)$/.exec(c.script.scriptName)!;
      const p = (Number(m[1]) + Number(m[2]) * negativeBuffCount(c.target)) * 0.01;
      return p >= 1 ? Number(m[3]) : 0;
    },
  },
  noDamageScript("RingFingerOutisThirdSkillCoinAbility", "目标混乱或被击杀时给予理智最高的友方穿刺伤害提升"),
  noDamageScript("1111002", "消耗充能后使自身与友方获得充能力场"),
  // SkillAbility_1111003.OnBattleStart: self (and max-resonance Charge allies, ≤5) gain ChargeLoad = own Charge stack.
  {
    name: "1111003",
    summary: "战斗开始时获得等同于自身充能强度的[ChargeLoad]",
    approx: "按技能使用时机给予；友方分配未建模",
    skillMods(c) {
      const n = c.actor.getPotency("Charge");
      if (n > 0) c.give("actor", c.script.buffData?.buffKeyword ?? "ChargeLoad", n, 0);
    },
  },
  // CoinAbility_1111003_4_2.OnSucceedAttack: n = 5 − own Charge stack; n > 0 → self Charge count +n.
  {
    name: "1111003_4_2",
    summary: "命中时使自身获得(5−充能强度)层充能",
    onCoinHit(c) {
      const n = 5 - c.actor.getPotency("Charge");
      if (n > 0) c.give("actor", "Charge", 0, n);
    },
  },
  // SkillAbility_WCorpOutisThirdSkillSecondAbility<stack>And<min>And<max>And<power>: Charge stack ≥ a and a2 ≤ turn < a3 →
  // UseBuffAllTurn(Charge), coin power +a4.
  {
    name: /^WCorpOutisThirdSkillSecondAbility(\d+)And(\d+)And(\d+)And(\d+)$/,
    summary: "充能强度≥2且层数在7~14之间时消耗所有充能层数，硬币威力+2",
    skillMods(c) {
      const m = /(\d+)And(\d+)And(\d+)And(\d+)$/.exec(c.script.scriptName)!;
      const [st, lo, hi, add] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
      const n = c.actor.getCount("Charge");
      if (c.actor.getPotency("Charge") < st || n < lo || n >= hi) return;
      c.consume("actor", "Charge", n);
      return { coinScale: add };
    },
  },
  noDamageScript("AddBloodDinnerOnBreakOrKillTarget20", "击杀/混乱目标时获得血宴（不在模拟中发生）"),
  noDamageScript("AddBloodDinnerOnBreakOrKillTargetViaBuffCheck", "击杀带缝纫对象的目标时额外获得血宴（不在模拟中发生）"),
  noDamageScript("EleventhOutisPayback", "击杀/混乱目标时返还已消耗血剪的一半（不在模拟中发生）"),
  noDamageScript("GiveBuffOnBreakOrKillTargetIfHasStack_LineCuttingPersonality1", "击杀/混乱带缝纫对象的目标时获得血剪（不在模拟中发生）"),
  // CoinAbility_EleventhOutisThirdSkillFourthCoinAbility<a>And<m1>And<max1>And<b>And<m2>And<max2> (×0.001 on ratios):
  // own BloodScissor ≥ b → stack × m2 (≤ max2); ≥ a → stack × m1 (≤ max1).
  {
    name: /^EleventhOutisThirdSkillFourthCoinAbility(\d+)And(\d+)And(\d+)And(\d+)And(\d+)And(\d+)$/,
    summary: "血剪≥10层时本硬币伤害+层数×3%(最多57%)；≥20层时改为+层数×4%(最多120%)",
    coinMods(c) {
      const p = /(\d+)And(\d+)And(\d+)And(\d+)And(\d+)And(\d+)$/.exec(c.script.scriptName)!.slice(1).map(Number);
      const n = c.actor.getPotency(BLOOD_SCISSOR);
      if (n >= p[3]!) return { dmg: Math.min(n * p[4]! * 0.001, p[5]! * 0.001) };
      if (n >= p[0]!) return { dmg: Math.min(n * p[1]! * 0.001, p[2]! * 0.001) };
    },
  },
  // SkillAbility_GiveBuffOnUseWithBloodDinnerGainBuffTurnIfFailed_<Kw><N>[a:b:c]: use BloodDinner → buffData × units;
  // FailToUseBloodDinner → self gains <Kw> N count (GiveBuff_BySkill turn).
  {
    name: /^GiveBuffOnUseWithBloodDinnerGainBuffTurnIfFailed_([A-Za-z]+?)(\d+)\[(\d+):(\d+):(\d+)\]$/,
    summary: "使用时消耗血宴，每份获得1层血剪；未消耗时自身获得N层指定状态",
    approx: "血宴用量参数[a:b:c]按[最低:最多:每份]解读（与 batch-s05 同族一致）",
    skillMods(c) {
      const m = /_([A-Za-z]+?)(\d+)\[(\d+):(\d+):(\d+)\]$/.exec(c.script.scriptName)!;
      const [min, max, per] = [Number(m[3]), Number(m[4]), Math.max(1, Number(m[5]))];
      const have = c.actor.getPotency("BloodDinner");
      const units = have >= min ? Math.floor(Math.min(have, max) / per) : 0;
      if (units > 0) {
        c.lose("actor", "BloodDinner", units * per);
        const bd = c.script.buffData;
        giveBD(c, bd ? { ...bd, target: "Self" } : undefined, units * (bd?.stack ?? 1), 0);
      } else {
        c.give("actor", m[1]!, 0, Number(m[2]));
      }
    },
  },
  // SkillAbility_ForceToDestroyBuffOnEndSkill.OnEndBehaviour: ForceToDestroyBuff(buffKeyword) on GetSingleUnit(target).
  {
    name: "ForceToDestroyBuffOnEndSkill",
    summary: "技能结束时解除指定状态",
    onSkillEnd(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      (bd.target === "Self" ? c.actor : c.target).destroy(bd.buffKeyword);
    },
  },
  // CoinAbility_GiveBuff111130202.OnSucceedAttack: target Vibration stack ≥ limit(10) → UseBuffStack(value 4) → both +2 Vibration count.
  {
    name: "GiveBuff111130202",
    summary: "命中时若目标震颤强度≥10：消耗其4级震颤强度，并对目标与自身施加2层震颤",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!bd || c.target.getPotency("Vibration") < (bd.limit ?? 10)) return;
      c.lose("target", "Vibration", bd.value ?? 4);
      c.give("target", "Vibration", 0, bd.turn ?? 2);
      c.give("actor", "Vibration", 0, bd.turn ?? 2);
    },
  },
  // SkillAbility_GiveBuffOnEndSkill1111303.OnEndBehaviour: without SystemAbility_1111303 → add it, GiveBuff(OutisNoHat) (once per battle).
  {
    name: "GiveBuffOnEndSkill1111303",
    summary: "技能结束时获得[OutisNoHat]（每场战斗1次）",
    onSkillEnd(c) {
      if (c.state.get("done")) return;
      c.state.set("done", 1);
      giveBD(c, c.script.buffData);
    },
  },
  // CoinAbility_OnStartCoin1111303_<per%>_<max%>: OnStartCoin → coin power = min(floor(own Vibration turn / bd.turn) × bd.value, bd.limit),
  // dmg = min(turn × jsonValue, max% × 0.01); then UseBuffAllTurn(Vibration).
  {
    name: /^OnStartCoin1111303_(\d+)_(\d+)$/,
    summary: "掷出硬币时消耗自身所有震颤层数：每4层硬币威力+1(最多+5)，每层伤害+2%(最多+100%)",
    coinMods(c) {
      if (c.isRerolled) return;
      const bd = c.script.buffData ?? {};
      const max = Number(/_(\d+)$/.exec(c.script.scriptName)![1]) * 0.01;
      const n = c.actor.getCount("Vibration");
      if (n <= 0) return;
      const per = Math.max(1, bd.turn ?? 4);
      let cs = Math.floor(n / per) * (bd.value ?? 1);
      if ((bd.limit ?? 0) > 0) cs = Math.min(cs, bd.limit!);
      const dmg = Math.min(n * (c.script.value ?? 0.02), max);
      c.consume("actor", "Vibration", n);
      return { coinScale: cs, dmg };
    },
  },
  // CoinAbility_SwitchVibration1111302.OnSucceedAttack: target not VIBRATION_CONVERTED/MERGED and own Vibration turn ≥ value(3) →
  // UseBuffTurn(own Vibration, 3), SwitchTargetVibrationToSpecial(buffKeyword).
  {
    name: "SwitchVibration1111302",
    summary: "命中时若目标未处于转换/融合震颤：消耗自身3层震颤，使目标震颤转换为[VibrationChainPersonality]",
    approx: "数据中关键字为 VibrationChain，按描述转换为 VibrationChainPersonality（人格版本）",
    onCoinHit(c) {
      if (VIB_CONVERTED_OR_MERGED.some((id) => c.target.get(id))) return;
      const need = c.script.buffData?.value ?? 3;
      if (c.actor.getCount("Vibration") < need) return;
      c.consume("actor", "Vibration", need);
      if (c.target.convert("Vibration", "VibrationChainPersonality")) c.note("震颤转换为 VibrationChainPersonality");
    },
  },
  // CoinAbility_UseBuff1111303: target has Vibration → use = min(stack, limit 3); UseBuffStack; self Vibration count +use×jsonValue(2);
  // target Binding (next round) = use + value(−1).
  {
    name: "UseBuff1111303",
    summary: "命中时消耗目标最多3级震颤强度：自身获得(消耗量×2)层震颤，下回合对目标施加(消耗量−1)层束缚",
    onCoinHit(c) {
      const bd = c.script.buffData ?? {};
      const use = Math.min(c.target.getPotency("Vibration"), bd.limit ?? 3);
      if (use <= 0) return;
      c.lose("target", "Vibration", use);
      const self = Math.trunc(use * (c.script.value ?? 2));
      if (self > 0) c.give("actor", "Vibration", 0, self);
      const bind = use + (bd.value ?? -1);
      if (bind > 0) c.give("target", bd.buffKeyword ?? "Binding", 0, bind, 1);
    },
  },
  // CoinAbility_VibrationExplosionOnSucceedAttackViaBuffCheck: buffOwner's stack ≥ bd.stack && turn ≥ bd.turn → VibrationExplosion.
  {
    name: "VibrationExplosionOnSucceedAttackViaBuffCheck",
    summary: "命中时若满足状态条件(自身带有[TimeRentalTwoPersonality])，使目标震颤引爆",
    onCoinHit(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const o = bd.buffOwner === "Self" ? c.actor : c.target;
      if (!o.get(bd.buffKeyword) || o.getPotency(bd.buffKeyword) < (bd.stack ?? 0) || o.getCount(bd.buffKeyword) < (bd.turn ?? 0)) return;
      vibrationExplosion(c, "震颤引爆");
    },
  },
  // SkillAbility_CoinScaleAdderOnSTViaVibrationAndBuffCheck.CheckDivide: owner's (kw + Vibration) stack ≥ bd.stack (turn ≥ bd.turn) → +IntegerValue.
  {
    name: "CoinScaleAdderOnSTViaVibrationAndBuffCheck",
    summary: "目标沉沦与震颤强度之和≥6时硬币威力+1",
    skillMods(c) {
      const bd = c.script.buffData;
      if (!bd?.buffKeyword) return;
      const o = bd.buffOwner === "Self" ? c.actor : c.target;
      const s = o.getPotency(bd.buffKeyword) + o.getPotency("Vibration");
      const t = o.getCount(bd.buffKeyword) + o.getCount("Vibration");
      if (s < (bd.stack ?? 0) || t < (bd.turn ?? 0)) return;
      return { coinScale: bd.value ?? 1 };
    },
  },
  // CoinAbility_DmgUpByBullet11114.GetAttackDmgMultiplier: own LCA_Bullet ≥ coin's consume count (UseBullet…:2) → count × jsonValue.
  // UseBullet[necessary:LCA_Bullet:2] (batch-s22) runs first on the same coin and records the spend; lcaBulletsUsed > 0 ⇔ pre-spend stack ≥ N.
  {
    name: "DmgUpByBullet11114",
    summary: "自身[LCA_Bullet]足够本硬币消耗时，伤害+(消耗数×30%)",
    coinMods(c) {
      const n = lcaBulletsUsed(c);
      if (n > 0) return { dmg: n * (c.script.value ?? 0.3) };
    },
  },
);

registerAbilities(
  // BuffAbility_DarkFlame.OnRoundEnd: Pride (attribute 5) HP damage = DarkFlame stack × Combustion stack; then removed (desc).
  // Defense level −stack comes from DefAdderByStack (status.ts).
  {
    name: "DarkFlame",
    summary: "黑焰：回合结束时受到(层数×烧伤强度)点傲慢伤害，随后解除",
    onRoundEnd(c) {
      if (c.side !== "target") return;
      const dmg = c.status.potency * c.target.getPotency("Combustion");
      if (dmg > 0) c.extraDamage(dmg, "黑焰：层数×烧伤强度的傲慢伤害", { sin: "INDIGO" });
      c.target.destroy(c.status.id);
    },
  },
  noDamageAbility("LineCuttingEffect", "缝纫对象的视觉特效"),

  // ---------------------------------------------------------------- StigmaWorkshopHandStep1/2/3 (黎明之火)
  // BuffAbility_StigmaHandStackLimitRoundUnion: gains of the status capped at value(20) per round (system ability 514, shared by steps).
  {
    name: "StigmaHandStackLimitRoundUnion",
    summary: "黎明之火每回合最多获得20层",
    approx: "回合开始（状态已存在时）或技能开始时注册上限拦截",
    onRoundStart(c) {
      stigmaLimit(c);
    },
    onSkillStart(c) {
      stigmaLimit(c);
    },
  },
  // BuffAbility_StigmaHandCombustionSelf_stackDiv<a>_turnDiv<b>.OnRoundStart_After_Event: stack ≥ a → self Combustion +floor(stack/a);
  // stack ≥ b → self Combustion count +floor(stack/b).
  {
    name: /^StigmaHandCombustionSelf_stackDiv(\d+)_turnDiv(\d+)$/,
    summary: "回合开始时每5层使自身烧伤强度+1、每10层对自身施加1层烧伤",
    onRoundStart(c) {
      if (c.side !== "actor") return;
      const [, a, b] = /stackDiv(\d+)_turnDiv(\d+)$/.exec(c.ability.ability)!.map(Number);
      const s = c.status.potency;
      const pot = s >= a! ? Math.floor(s / a!) : 0;
      const cnt = s >= b! ? Math.floor(s / b!) : 0;
      if (pot > 0 || cnt > 0) c.give("actor", "Combustion", pot, cnt);
    },
  },
  // BuffAbility_GetStigmaHandOSA_div<d>_limit<l>.OnSucceedAttack: default attack skill hit → self StigmaWorkshopHandStep1(1852)
  // += min(1 + floor(target Combustion / d), l).
  {
    name: /^GetStigmaHandOSA_div(\d+)_limit(\d+)$/,
    summary: "基础攻击技能命中时获得(1+目标烧伤强度/3)层黎明之火(最多3层)",
    onCoinHit(c) {
      if (c.side !== "actor" || !isDefaultSkill(c)) return;
      const [, d, l] = /div(\d+)_limit(\d+)$/.exec(c.ability.ability)!.map(Number);
      const comb = c.target.getPotency("Combustion");
      const n = Math.min(comb >= d! ? 1 + Math.floor(comb / d!) : 1, l!);
      c.gain(c.status.id, n);
    },
  },
  // BuffAbility_Give{Stack,Turn}AdderToEnemyIfDefaultSkillNotZero.GetGiveBuff{Stack,Turn}Adder: own default skill gives bd keyword to an
  // enemy with current stack/turn > 0 → +bd.stack / +bd.turn.
  {
    name: "GiveBuffStackAdderToEnemyIfDefaultSkillNotZero",
    summary: "自身基础技能使敌方增加的指定状态强度额外+N",
    approx: GIVE_ADDER_APPROX,
    onSkillStart(c) {
      giveAdderToEnemy(c, "stack");
    },
  },
  {
    name: "GiveBuffTurnAdderToEnemyIfDefaultSkillNotZero",
    summary: "自身基础技能对敌方施加的指定状态层数额外+N",
    approx: GIVE_ADDER_APPROX,
    onSkillStart(c) {
      giveAdderToEnemy(c, "turn");
    },
  },
);
