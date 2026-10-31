/**
 * Effect script handlers verified against GameAssembly.dll, plus unknown-effect gap reporting.
 *
 * Principle (docs/开发交接计划.md §6.3): only script families whose rules were read from the binary are executed.
 * Everything else becomes an `unverified` observation → simulator gap → result is not "exact".
 * Behaviour verified against the game client (local research notes, not distributed).
 *
 * BuffReferenceData layout: buffKeyword+0x10, target+0x20, buffOwner+0x28, stack+0x30, turn+0x34,
 * activeRound+0x38, value(float)+0x3c, limit+0x40.  SkillAbility_BasicBuff.Init @0xD54E70 copies stack→+0x78.
 *
 * Verified semantics:
 *  - *ViaBuffCheck.CheckCondition (@0xC163C0, @0xC53F40, @0x2A316C0): unit = GetSingleUnit(buffOwner);
 *    ActivatedStack >= data.stack && ActivatedTurn >= data.turn.
 *  - CoinScaleAdder[OnStartTurn]ViaBuffCheck.GetScaleAdder (@0xBB8E80): Util.Round(value).
 *    Non-OnStartTurn variant is evaluated live per coin (GetCoinScaleAdder @0xC2C610 re-checks the condition).
 *  - CoinScaleAdder[OnStartTurn]ViaBuffCheckDevideByStackWithLimit<N> (@0xC2DFE0 / @0xC2E9E0, Init @0xC2DDE0):
 *    floor(ActivatedStack / (data.stack || 1)) * Round(value), capped by data.limit (>0) and N (digits of name).
 *  - SkillPowerResultAdderViaOnUseBuffCheck: condition at OnStartTurn (@0xC4A290) → +Round(value) snapshot.
 *  - SkillPowerResultAdderOnUseViaBuffDevide.CalculateAdder (@0xC58A80): (stack/data.stack [if both>0]
 *    + turn/data.turn [if both>0]) * IntegerValue, capped by data.limit (>0); snapshot at OnStartTurn.
 *  - AttackDmgUpByRatio[OnUse]ViaBuffCheck (@0xBBA840): condition → +value.
 *  - AttackDmgUpByRatio[OnUse]ViaBuffCheckDevideByStackWithLimit<N> (@0xBBE530/@0xBBEA60, @0xBBF6E0/@0xBBFA90):
 *    condition → floor(stack / data.stack) * value, min(N * 0.01).
 *  - CoinAbility_DmgUpByBuff (@0x2A316C0 / @0x2A318D0): condition → +value to this coin's damage multiplier.
 *  - CoinAbility_GiveBuffOnSucceedAttack[Head|Tail] / GiveBuffOnSuccessCriticalAttack: give buffData on hit.
 *  - SkillAbility_GiveBuffOnSucceedAttack.OnSucceedAttack(action, coin, ...): skill-scope, per coin hit.
 *  - CoinAbility_VibrationExplosionOnSucceedAttack(And|Then)LoseTargetVibrationTurn<N> (@0x2BB31B0):
 *    FirstBsGaugeUp(Vibration stack) then LoseBuffTurn(Vibration, N).
 */

import { evalParamScript, type BattleCtx } from "./param-scripts";
import { scriptHandler } from "./passives/framework";
import type { AbilityScript, BuffData } from "../config/game-data";
import { StatusContainer, triggerVibrationExplosion, type DotTriggerRecord, type StatusChangeRecord } from "./status";

export type EffectStatus = "verified" | "cosmetic" | "unverified";

export interface EffectObservation {
  scriptName: string;
  scope: "skill" | "coin";
  skillId: number;
  coinIndex?: number;
  status: EffectStatus;
  note?: string;
}

export interface EffectContext {
  turn: number;
  skillId: number;
  coinIndex?: number;
  isHeads?: boolean;
  isCritical?: boolean;
  isClashWin?: boolean;
  isRerolled?: boolean;
  /** Resolved damage of the current coin hit (used by ratio bonus damage on rerolled coin). */
  lastCoinResolvedDamage?: number;
  /** Exact unfloored float damage of the current coin hit. */
  lastCoinFloatDamage?: number;
  /** Bonus HP damage triggered during executeCoinOnHitEffects (e.g. GiveAmberDmgByRatioOnSAIfRerolled1061703). */
  bonusHitDamages?: { amount: number; floatAmount?: number; ratio?: number; desc: string }[];
  actorStatuses: StatusContainer;
  targetStatuses: StatusContainer;
  targetHasSp: boolean;
  targetGloomResist: number;
  disabledEffectIds: Set<string>;
  statusChanges: StatusChangeRecord[];
  dotTriggers: DotTriggerRecord[];
  /** Per-battle / per-skill activation counters shared across turns. */
  onceFlags?: Map<string, number>;
  /** Battle situation (speeds, target count, allies). */
  battle?: BattleCtx;
}

/** Scripts with no numeric impact in an unopposed single-target simulation. */
const COSMETIC_SCRIPTS = new Set([
  "KeywordForUI",
  "HiddenSkill",
  "SuperCoin",
  "CannotReusedSkill",
  "IgnoreDefenseSkill",
  "DealRandomTargetAmongTargetsMTFirst",
  "Empty",
  "EmptyBody",
  "SupportiveDefense",
  "CommonSkillSlotEffectOncePerListen1061704",
]);
const COSMETIC_PATTERNS = [
  /^AddTauntOnUse\d*$/,
  /^ParryingPowerResultAdder/,
  /^GiveBuffOnLoseDuel$/,
  /^GiveBuffOnSucceedEvade$/,
  /^MarkGiveCharge/,
  /^MarkSubKeyword/,
  /^OverwriteToSuperCoinViaBuffCheck$/,
];

/** Memoised: both lists are static module constants. */
const COSMETIC_CACHE = new Map<string, boolean>();

export function isCosmeticScript(name: string): boolean {
  let v = COSMETIC_CACHE.get(name);
  if (v === undefined) {
    v = COSMETIC_SCRIPTS.has(name) || COSMETIC_PATTERNS.some((p) => p.test(name));
    COSMETIC_CACHE.set(name, v);
  }
  return v;
}

/** Util.Round on the float value (values in data are integral or .5-free in practice). */
const roundValue = (v: number | undefined) => Math.round(v ?? 0);

function ownerContainer(ctx: EffectContext, bd: BuffData): StatusContainer {
  return bd.buffOwner === "Self" ? ctx.actorStatuses : ctx.targetStatuses;
}

function activatedStack(c: StatusContainer, keyword: string): number {
  return c.getPotency(keyword);
}

function activatedTurn(c: StatusContainer, keyword: string): number {
  return c.getCount(keyword);
}

/** *ViaBuffCheck.CheckCondition: stack >= data.stack && turn >= data.turn on GetSingleUnit(buffOwner). */
export function checkBuffCondition(ctx: EffectContext, bd: BuffData | undefined): boolean {
  if (!bd?.buffKeyword) return false;
  const c = ownerContainer(ctx, bd);
  return activatedStack(c, bd.buffKeyword) >= (bd.stack ?? 0) && activatedTurn(c, bd.buffKeyword) >= (bd.turn ?? 0);
}

function nameDigits(name: string): number {
  const m = /(\d+)$/.exec(name);
  return m ? Number(m[1]) : 0;
}

export function applyBuffData(ctx: EffectContext, script: AbilityScript, reasonPrefix: string): void {
  const bd = script.buffData;
  if (!bd?.buffKeyword) return;
  const toSelf = (bd.target || "Target") === "Self";
  const container = toSelf ? ctx.actorStatuses : ctx.targetStatuses;
  const activeRound: 0 | 1 = bd.activeRound === 1 ? 1 : 0;
  let stack = bd.stack ?? 0;
  let turn = bd.turn ?? 0;
  if (stack <= 0 && turn <= 0) return;
  if (!toSelf) {
    // GiveBuffStackAdder/TurnAdderToEnemyIfDefaultSkillNotZero (e.g. Firstlight): +X when the skill already gives that amount.
    for (const a of ctx.actorStatuses.activeAbilities()) {
      if (a.buffData?.buffKeyword !== bd.buffKeyword) continue;
      if (a.ability === "GiveBuffStackAdderToEnemyIfDefaultSkillNotZero" && stack > 0) stack += a.buffData.stack ?? 0;
      if (a.ability === "GiveBuffTurnAdderToEnemyIfDefaultSkillNotZero" && turn > 0) turn += a.buffData.turn ?? 0;
    }
  }
  const { before, after } = toSelf && activeRound === 0 && turn === 0 && hasRoundLimit(container, bd.buffKeyword)
    ? container.gainLimited(bd.buffKeyword, stack)
    : container.apply(bd.buffKeyword, stack, turn, activeRound);
  ctx.statusChanges.push({
    statusId: bd.buffKeyword,
    target: toSelf ? "actor" : "target",
    before,
    after,
    reason: `${reasonPrefix}:${script.scriptName}${activeRound === 1 ? "(下回合)" : ""}`,
  });
}

export const DEFAULT_BATTLE: BattleCtx = { selfSpeed: 0, targetSpeed: 0, targetCount: 1, lostHpPct: 0, allies: [], resonance: {}, perfectResonance: 0 };
const EMPTY_STATUSES = new StatusContainer({});

function hasRoundLimit(c: StatusContainer, keyword: string): boolean {
  return c.activeAbilities().some((a) => a.statusId === c.resolveId(keyword) && /^GetStackRoundLimit/.test(a.ability)) ||
    /^StigmaWorkshopCelloCase/.test(keyword);
}

function divideCount(c: StatusContainer, keyword: string, divisor: number, limit?: number): number {
  let n = Math.trunc(activatedStack(c, keyword) / Math.max(1, divisor));
  if ((limit ?? 0) > 0) n = Math.min(n, limit!);
  return n;
}

const RE_GENERIC_SKILL_DEFERRED = [
  /^GiveRandomBuffOnSucceedAttack\w*_[A-Za-z]+_[A-Za-z]+$/,
  /^SwitchVibrationOnSucceedAttack\d*$/,
  /^GiveBuffOnEndAttackToAllAttackedTargets\d*$/,
  /^UseBuffAndHealHpRatioOnEndAttack\d*$/,
  /^ChangeSkillOnBeforeTurn/,
  /^ShowSkillSlotUIEffect/,
  /^ParryingResultAdder/,
];

// ------------------------------------------------------------------ skill-scope classification

const RE_CS_LIVE = /^CoinScaleAdderViaBuffCheck$/;
const RE_CS_SNAP = /^CoinScaleAdderOnStartTurnViaBuffCheck$/;
const RE_CS_SNAP_AND_USE = /^CoinScaleAdderOnStartTurnViaBuffCheckAndUse$/;
const RE_CS_DIV_LIVE = /^CoinScaleAdderViaBuffCheckDevideByStackWithLimit\d+$/;
const RE_CS_DIV_SNAP = /^CoinScaleAdderOnStartTurnViaBuffCheckDevideByStackWithLimit\d+$/;
const RE_CS_DIV_TURN_LIVE = /^CoinScaleAdderViaBuffCheckDevideByTurnWithLimit\d+$/;
const RE_CS_DIV_TURN_SNAP = /^CoinScaleAdderOnStartTurnViaBuffCheckDevideByTurnWithLimit\d+$/;
const RE_SPR_LIVE = /^SkillPowerResultAdderViaBuffCheck$/;
const RE_SPR_DIV_LIVE = /^SkillPowerResultAdderViaBuffCheckDevideByStackWithLimit\d+$/;
const RE_SPR_DIV_SNAP = /^SkillPowerResultAdderViaOnUseBuffCheckDevideByStackWithLimit\d+$/;
const RE_DMG_LIVE = /^AttackDmgUpByRatioViaBuffCheck$/;
const RE_DMG_SNAP = /^AttackDmgUpByRatioOnUseViaBuffCheck$/;
const RE_DMG_DIV_LIVE = /^AttackDmgUpByRatioViaBuffCheckDevideByStackWithLimit\d+$/;
const RE_DMG_DIV_SNAP = /^AttackDmgUpByRatioOnUseViaBuffCheckDevideByStackWithLimit\d+$/;
const RE_TWO_STACK_CS = /^CoinScaleAdderOnStartTurnDivideBySumOfTwoBuffStack_([A-Za-z]+)_([A-Za-z]+)$/;
const RE_TWO_STACK_SPR = /^SkillPowerResultAdder(?:OnSTViaSumOfTwoBuffStackDivide|DivideBySumOfTwoBuffStack)_([A-Za-z]+)_([A-Za-z]+)$/;
/**
 * Skill-scope adders the game recomputes on every query (per coin / per hit) rather than snapshotting at OnStartTurn:
 *  - SkillAbility_AttackDmgMultiplierByBuffStack{Both,Target}10216.GetAttackDmgMultiplier → CalcAttackDmgMultiplier(action, target)
 *  - SkillAbility_SkillPowerResultAdderDivideBySumOfTwoBuffStack (base …SumOfTwoBuffStack has no OnStartTurn; the “OnSTVia…” variant does)
 *  - SkillAbility_AttackDmgUpPerNegativeBuffCountWithLimit / …ByRatioViaNegativeBuffCntWithLimit / …ByNegativeBuffCount:
 *    GetAttackDmgMultiplier calls BattleUnitModel.GetNegativeBuffCount each time.
 */
const RE_BYSTACK_DMG_LIVE = /^AttackDmgMultiplierByBuffStack(Both|Target|Self)\d*$/;
const RE_TWO_STACK_SPR_LIVE = /^SkillPowerResultAdderDivideBySumOfTwoBuffStack_([A-Za-z]+)_([A-Za-z]+)$/;
const RE_PARAM_DMG_LIVE = [/^AttackDmgUp\d+PerNegativeBuffCountWithLimit\d+$/, /^AttackDmgUpByRatio\d+ViaNegativeBuffCntWithLimit\d+$/, /^AttackDmgUpByNegativeBuffCount_limit\d+$/, /^AttackDmgUpNegativeBuffCountDivideWithLimit_\d+_\d+_\d+$/];
/**
 * Timing audit (data/reports/timing-audit.md):
 *  - CriticalDmgUpByRatioOnStartTurnViaBuffCheckDevideByStack*: OnStartTurn_BeforeLog latches _isActivated + _dmgMultiplier;
 *    GetAttackDmgMultiplier only checks isCritical → value is a use-time snapshot (applied on critical coins).
 *  - AttackDmgUpByRatioOnUseViaBuffCheckDevideByStack*: OnStartTurn latches _conditionSatisfied (+0x90); GetAttackDmgMultiplier
 *    then calls the virtual GetDmgMultiplier, which divides the *current* stack → condition at use, amount per hit.
 */
const RE_CRIT_DMG_DIV_ST = /^CriticalDmgUpByRatioOnStartTurnViaBuffCheckDevideByStack(?:WithLimit\d+)?$/;
const latchKey = (ctx: EffectContext, name: string) => `latch:${ctx.turn}:${ctx.skillId}:${name}`;
const isLiveParamDmg = (name: string) => RE_PARAM_DMG_LIVE.some((p) => p.test(name));
const SKILL_SCOPE_DEFERRED = new Set([
  "GiveBuffOnSucceedAttack",
  "GiveBuffOnWinDuel",
  "GiveBuffOnEndAttack",
  "GiveBuffOnEndSkill",
  "GiveBuffOnEndTurnIfSelfBuffTurnLess",
  "GiveBuffOnEndAttackIfNotHas_TimeToListenHonglu",
  "UseBuffAllStackOnEndAttack",
  "ChangeSkillOnBeforeDefenseOncePerListen1061704",
  "VibrationExplosionOnWinDuelAndLoseTargetVibrationTurn1",
]);

function coinScaleDivide(ctx: EffectContext, script: AbilityScript): number {
  const bd = script.buffData!;
  const c = ownerContainer(ctx, bd);
  const divisor = (bd.stack ?? 0) !== 0 ? bd.stack! : 1;
  let v = Math.trunc(activatedStack(c, bd.buffKeyword!) / divisor) * roundValue(bd.value);
  if ((bd.limit ?? 0) > 0) v = Math.min(v, bd.limit!);
  return Math.min(v, nameDigits(script.scriptName));
}

function coinScaleDivideByTurn(ctx: EffectContext, script: AbilityScript): number {
  const bd = script.buffData!;
  const c = ownerContainer(ctx, bd);
  const divisor = (bd.turn ?? 0) !== 0 ? bd.turn! : 1;
  let v = Math.trunc(activatedTurn(c, bd.buffKeyword!) / divisor) * roundValue(bd.value);
  if ((bd.limit ?? 0) > 0) v = Math.min(v, bd.limit!);
  return Math.min(v, nameDigits(script.scriptName));
}

function twoBuffStackSumDivide(ctx: EffectContext, script: AbilityScript, kwA: string, kwB: string): number {
  const bd = script.buffData;
  if (!bd) return 0;
  const c = ownerContainer(ctx, bd);
  const sum = activatedStack(c, kwA) + activatedStack(c, kwB);
  const divisor = (bd.stack ?? 0) > 0 ? bd.stack! : 1;
  if (sum < divisor) return 0;
  const mult = roundValue(bd.value ?? script.value ?? 1);
  let v = Math.trunc(sum / divisor) * (mult > 0 ? mult : 1);
  if ((bd.limit ?? 0) > 0) v = Math.min(v, bd.limit!);
  return v;
}

function dmgDivide(ctx: EffectContext, script: AbilityScript): number {
  const bd = script.buffData!;
  const c = ownerContainer(ctx, bd);
  const divisor = bd.stack ?? 0;
  if (divisor <= 0) return 0; // game would divide by zero; data never has this
  const v = Math.trunc(activatedStack(c, bd.buffKeyword!) / divisor) * (bd.value ?? 0);
  return Math.min(v, nameDigits(script.scriptName) * 0.01);
}

export interface SkillSnapshot {
  skillPowerResultAdder: number;
  coinScaleAdder: number;
  attackDmgMultiplier: number;
  /** Base power adder from on-use scripts (SkillPowerAdder*). */
  basePowerAdder: number;
  /** Rerolls granted to the coin carrying RerollLastCoin* (decided on use). */
  lastCoinRerolls: number;
  observations: EffectObservation[];
}

/**
 * Evaluate on-use (OnStartTurn) effects: snapshots + GiveBuffOnUse. Live-evaluated families are only classified here.
 */
export function evaluateSkillStartEffects(scripts: AbilityScript[], ctx: EffectContext): SkillSnapshot {
  const out: SkillSnapshot = { skillPowerResultAdder: 0, coinScaleAdder: 0, attackDmgMultiplier: 0, basePowerAdder: 0, lastCoinRerolls: 0, observations: [] };
  const obs = (name: string, status: EffectStatus, note?: string) =>
    out.observations.push({ scriptName: name, scope: "skill", skillId: ctx.skillId, status, note });

  for (const script of scripts) {
    const name = script.scriptName;
    if (ctx.disabledEffectIds.has(name)) continue;
    const bd = script.buffData;
    if (isCosmeticScript(name)) { obs(name, "cosmetic"); continue; }
    const th = scriptHandler(name);
    if (th) { obs(name, "verified", th.approx); continue; }
    const pe = evalParamScript(script, ctx.battle ?? DEFAULT_BATTLE, ctx.actorStatuses, ctx.targetStatuses);
    if (pe && isLiveParamDmg(name)) {
      obs(name, "verified", pe.note); // evaluated per coin by evaluateLiveSkillEffects
      continue;
    }
    if (pe) {
      out.coinScaleAdder += pe.coinScale;
      out.basePowerAdder += pe.basePower;
      out.skillPowerResultAdder += pe.finalPower;
      out.attackDmgMultiplier += pe.dmg;
      obs(name, "verified", pe.note);
      continue;
    }

    if (/^GiveBuffOnUse\d+$/.test(name) && bd?.buffKeyword) {
      applyBuffData(ctx, script, "使用时");
      obs(name, "verified");
      continue;
    }
    if (/^GiveBuffOnBattleStart\d+$/.test(name) && bd?.buffKeyword) {
      const key = `battleStart:${ctx.skillId}:${name}`;
      const limit = Math.max(1, Math.round(script.value ?? 1));
      const used = ctx.onceFlags?.get(key) ?? 0;
      if (used < limit) {
        ctx.onceFlags?.set(key, used + 1);
        applyBuffData(ctx, script, "战斗开始(每场限次)");
      }
      obs(name, "verified");
      continue;
    }
    if (/^RerollLastCoinOnStartTurnViaBuffCheck\d*$/.test(name)) {
      if (checkBuffCondition(ctx, bd)) out.lastCoinRerolls += Math.max(1, roundValue(bd?.value ?? 1));
      obs(name, "verified");
      continue;
    }
    if (/^RerollLastCoinOnStartTurnDivideByBuffStack\d*$/.test(name) && bd?.buffKeyword) {
      out.lastCoinRerolls += divideCount(ownerContainer(ctx, bd), bd.buffKeyword, bd.stack ?? 1, bd.limit) * Math.max(1, roundValue(bd.value ?? 1));
      obs(name, "verified");
      continue;
    }
    const divStart = /^GiveBuffOnStartTurnDivideByStack_([A-Za-z]+)$/.exec(name);
    if (divStart && bd?.buffKeyword) {
      const src = bd.buffOwner === "Target" ? ctx.targetStatuses : ctx.actorStatuses;
      const n = divideCount(src, divStart[1]!, bd.value ?? 1, bd.limit);
      if (n > 0) applyBuffData(ctx, { ...script, buffData: { ...bd, stack: (bd.stack ?? 0) * n, turn: (bd.turn ?? 0) * n } }, `使用时(${divStart[1]}÷${bd.value})`);
      obs(name, "verified");
      continue;
    }
    if (name === "GiveBuffOnStartTurnToAllTargets" && bd?.buffKeyword) {
      applyBuffData(ctx, { ...script, buffData: { ...bd, target: bd.target ?? "Target" } }, "使用时(全体目标)");
      obs(name, "verified");
      continue;
    }
    if (name === "LoseBuffOnStartTurn" && bd?.buffKeyword) {
      const self = (bd.target ?? "Self") === "Self";
      const r = (self ? ctx.actorStatuses : ctx.targetStatuses).losePotency(bd.buffKeyword, bd.stack ?? 0);
      if (r) ctx.statusChanges.push({ statusId: bd.buffKeyword, target: self ? "actor" : "target", ...r, reason: name });
      obs(name, "verified");
      continue;
    }
    if (name === "LoseBuffOnWinDuel") {
      obs(name, "verified", "无对拼模式下不触发");
      continue;
    }
    if (RE_BYSTACK_DMG_LIVE.test(name) && bd?.buffKeyword) {
      obs(name, "verified"); // evaluated per coin by evaluateLiveSkillEffects (CalcAttackDmgMultiplier on every hit)
      continue;
    }
    if (/^AttackDmgMultiplierByLoseHpRatio\d*_\d+$/.test(name)) {
      obs(name, "verified", "按自身满血（已损失体力 0%）计算");
      continue;
    }
    if (RE_GENERIC_SKILL_DEFERRED.some((p) => p.test(name))) {
      obs(name, "verified");
      continue;
    }
    if (name === "GiveBuffOnUse" || name === "GiveBuffOnBattleStart") {
      applyBuffData(ctx, script, name === "GiveBuffOnBattleStart" ? "战斗开始" : "使用时");
      obs(name, "verified");
      continue;
    }
    if (name === "GiveBuffOnBattleStartIfNotHas_SupportProtect") {
      if (!ctx.actorStatuses.get("SupportProtect")) {
        applyBuffData(ctx, script, "战斗开始获得援护防御");
      }
      obs(name, "verified");
      continue;
    }
    if (name === "GiveBuffOnUsePerBuffStack_Charge1_Limit15" && bd?.buffKeyword) {
      // Applied at skill end (executeSkillEndEffects) so turn-start steady state (14 stacks = +2 Offense Level) applies during the attack
      obs(name, "verified");
      continue;
    }
    if (name === "GiveBuffOnUseIfUsingBuffTurn_Charge6" && bd?.buffKeyword) {
      if (activatedTurn(ctx.actorStatuses, "Charge") >= 6) {
        const { before, after } = ctx.actorStatuses.consumeCount("Charge", 6);
        ctx.statusChanges.push({ statusId: ctx.actorStatuses.resolveId("Charge"), target: "actor", before, after, reason: `${name}:consume` });
        applyBuffData(ctx, script, "消耗6层充能下回合援护防御");
      }
      obs(name, "verified");
      continue;
    }
    if (name === "GiveBuffOnUseIfNotHas_TimeToListenHonglu" && bd?.buffKeyword) {
      if (!ctx.actorStatuses.get("TimeToListenHonglu")) {
        applyBuffData(ctx, script, "获得听讲准备");
      }
      obs(name, "verified");
      continue;
    }
    if (RE_CS_SNAP.test(name) && bd?.buffKeyword) {
      if (checkBuffCondition(ctx, bd)) out.coinScaleAdder += roundValue(bd.value);
      obs(name, "verified");
      continue;
    }
    if (RE_CS_SNAP_AND_USE.test(name) && bd?.buffKeyword) {
      if (checkBuffCondition(ctx, bd)) {
        out.coinScaleAdder += roundValue(bd.value);
        const c = ownerContainer(ctx, bd);
        const side = bd.buffOwner === "Self" ? "actor" : "target";
        if ((bd.stack ?? 0) > 0) {
          const { before, after } = c.consumeCount(bd.buffKeyword, bd.stack!);
          ctx.statusChanges.push({ statusId: bd.buffKeyword, target: side, before, after, reason: `${name}:useStack` });
        }
        if ((bd.turn ?? 0) > 0) {
          const { before, after } = c.consumeCount(bd.buffKeyword, bd.turn!);
          ctx.statusChanges.push({ statusId: bd.buffKeyword, target: side, before, after, reason: `${name}:useTurn` });
        }
      }
      obs(name, "verified");
      continue;
    }
    if (RE_CS_DIV_SNAP.test(name) && bd?.buffKeyword) {
      if (checkBuffCondition(ctx, bd)) out.coinScaleAdder += coinScaleDivide(ctx, script);
      obs(name, "verified");
      continue;
    }
    if (RE_CS_DIV_TURN_SNAP.test(name) && bd?.buffKeyword) {
      if (checkBuffCondition(ctx, bd)) out.coinScaleAdder += coinScaleDivideByTurn(ctx, script);
      obs(name, "verified");
      continue;
    }
    if (RE_SPR_DIV_SNAP.test(name) && bd?.buffKeyword) {
      if (checkBuffCondition(ctx, bd)) out.skillPowerResultAdder += coinScaleDivide(ctx, script);
      obs(name, "verified");
      continue;
    }
    if (name === "SkillPowerResultAdderViaOnUseBuffCheck" && bd?.buffKeyword) {
      if (checkBuffCondition(ctx, bd)) out.skillPowerResultAdder += roundValue(bd.value);
      obs(name, "verified");
      continue;
    }
    if (name === "SkillPowerResultAdderOnUseViaBuffDevide" && bd?.buffKeyword) {
      const c = ownerContainer(ctx, bd);
      const st = activatedStack(c, bd.buffKeyword);
      const tu = activatedTurn(c, bd.buffKeyword);
      const ds = bd.stack ?? 0;
      const dt = bd.turn ?? 0;
      let v = (st > 0 && ds > 0 ? Math.trunc(st / ds) : 0) + (tu > 0 && dt > 0 ? Math.trunc(tu / dt) : 0);
      v *= roundValue(bd.value);
      if ((bd.limit ?? 0) > 0) v = Math.min(v, bd.limit!);
      out.skillPowerResultAdder += v;
      obs(name, "verified");
      continue;
    }
    const twoCsMatch = RE_TWO_STACK_CS.exec(name);
    if (twoCsMatch && bd) {
      out.coinScaleAdder += twoBuffStackSumDivide(ctx, script, twoCsMatch[1]!, twoCsMatch[2]!);
      obs(name, "verified");
      continue;
    }
    if (name === "CoinScaleAdderOnStartTurnViaLacerationAndVibrationStackSumDivision" && bd) {
      out.coinScaleAdder += twoBuffStackSumDivide(ctx, script, "Laceration", "Vibration");
      obs(name, "verified");
      continue;
    }
    if (name === "CoinScaleAdderDevideCombustionAndVibrationOnStartTurn" && bd) {
      out.coinScaleAdder += twoBuffStackSumDivide(ctx, script, "Combustion", "Vibration");
      obs(name, "verified");
      continue;
    }
    const twoSprMatch = RE_TWO_STACK_SPR.exec(name);
    if (twoSprMatch && bd && RE_TWO_STACK_SPR_LIVE.test(name)) {
      obs(name, "verified"); // evaluated per coin by evaluateLiveSkillEffects
      continue;
    }
    if (twoSprMatch && bd) {
      out.skillPowerResultAdder += twoBuffStackSumDivide(ctx, script, twoSprMatch[1]!, twoSprMatch[2]!);
      obs(name, "verified");
      continue;
    }
    if (RE_DMG_SNAP.test(name) && bd?.buffKeyword) {
      if (checkBuffCondition(ctx, bd)) out.attackDmgMultiplier += bd.value ?? 0;
      obs(name, "verified");
      continue;
    }
    if (RE_DMG_DIV_SNAP.test(name) && bd?.buffKeyword) {
      // condition latched at use; amount re-evaluated per hit in evaluateLiveSkillEffects
      ctx.onceFlags?.set(latchKey(ctx, name), checkBuffCondition(ctx, bd) ? 1 : 0);
      if (!ctx.onceFlags && checkBuffCondition(ctx, bd)) out.attackDmgMultiplier += dmgDivide(ctx, script);
      obs(name, "verified");
      continue;
    }
    if (name === "AttackDmgUpOnUseViaBuffCheckDivideByStack" && bd?.buffKeyword) {
      if (checkBuffCondition(ctx, bd) && (bd.stack ?? 0) > 0) {
        const c = ownerContainer(ctx, bd);
        let v = Math.trunc(activatedStack(c, bd.buffKeyword) / bd.stack!) * (bd.value ?? 0);
        if ((bd.limit ?? 0) > 0) v = Math.min(v, bd.limit! * 0.01);
        out.attackDmgMultiplier += v;
      }
      obs(name, "verified");
      continue;
    }
    if (name === "CoinScaleAdderOnUseViaUsingBuffAmount" && bd?.buffKeyword) {
      // [WhenUse] Consume <turn> Count of <keyword> to gain Coin Power +<value> (max <limit> times).
      const c = ownerContainer(ctx, bd);
      const per = Math.max(1, bd.turn ?? 1);
      const times = Math.max(1, bd.limit ?? 1);
      const side = bd.buffOwner === "Self" ? "actor" : "target";
      let used = 0;
      while (used < times && activatedTurn(c, bd.buffKeyword) >= per) {
        const { before, after } = c.consumeCount(bd.buffKeyword, per);
        ctx.statusChanges.push({ statusId: c.resolveId(bd.buffKeyword), target: side, before, after, reason: `${name}:consume` });
        used++;
      }
      out.coinScaleAdder += used * roundValue(bd.value ?? 1);
      obs(name, "verified");
      continue;
    }
    if (
      (RE_CS_LIVE.test(name) ||
        RE_CS_DIV_LIVE.test(name) ||
        RE_CS_DIV_TURN_LIVE.test(name) ||
        RE_SPR_LIVE.test(name) ||
        RE_SPR_DIV_LIVE.test(name) ||
        RE_DMG_LIVE.test(name) ||
        RE_DMG_DIV_LIVE.test(name) ||
        name === "CriticalDmgUpByRatioViaBuffCheck" ||
        RE_CRIT_DMG_DIV_LIVE.test(name)) &&
      bd?.buffKeyword
    ) {
      if (RE_CRIT_DMG_DIV_ST.test(name)) ctx.onceFlags?.set(latchKey(ctx, name), checkBuffCondition(ctx, bd) ? dmgDivide(ctx, script) : 0);
      obs(name, "verified"); // evaluated per coin by evaluateLiveSkillEffects
      continue;
    }
    if (RE_CRIT_DMG_RATIO.test(name)) {
      obs(name, "verified");
      continue;
    }
    if (SKILL_SCOPE_DEFERRED.has(name)) {
      obs(name, "verified", name === "GiveBuffOnWinDuel" ? "无对拼模式下不触发" : undefined);
      continue;
    }
    obs(name, "unverified", "技能效果未纳入已验证处理器，需手动修正");
  }
  return out;
}

/** Static classification of a skill-scope script for UI badges (without mutating containers). */
export function classifySkillScript(script: AbilityScript): EffectStatus {
  const name = script.scriptName;
  const bd = script.buffData;
  if (isCosmeticScript(name)) return "cosmetic";
  if (
    name === "GiveBuffOnUse" ||
    name === "GiveBuffOnBattleStart" ||
    name === "GiveBuffOnBattleStartIfNotHas_SupportProtect" ||
    name === "GiveBuffOnUsePerBuffStack_Charge1_Limit15" ||
    name === "GiveBuffOnUseIfUsingBuffTurn_Charge6" ||
    name === "GiveBuffOnUseIfNotHas_TimeToListenHonglu" ||
    name === "CoinScaleAdderOnUseViaUsingBuffAmount" ||
    SKILL_SCOPE_DEFERRED.has(name) ||
    RE_TWO_STACK_CS.test(name) ||
    RE_TWO_STACK_SPR.test(name) ||
    name === "CoinScaleAdderOnStartTurnViaLacerationAndVibrationStackSumDivision" ||
    name === "CoinScaleAdderDevideCombustionAndVibrationOnStartTurn"
  ) {
    return "verified";
  }
  if (
    bd?.buffKeyword &&
    (RE_CS_SNAP.test(name) ||
      RE_CS_SNAP_AND_USE.test(name) ||
      RE_CS_DIV_SNAP.test(name) ||
      RE_CS_DIV_TURN_SNAP.test(name) ||
      RE_SPR_DIV_SNAP.test(name) ||
      name === "SkillPowerResultAdderViaOnUseBuffCheck" ||
      name === "SkillPowerResultAdderOnUseViaBuffDevide" ||
      RE_DMG_SNAP.test(name) ||
      RE_DMG_DIV_SNAP.test(name) ||
      name === "AttackDmgUpOnUseViaBuffCheckDivideByStack" ||
      RE_CS_LIVE.test(name) ||
      RE_CS_DIV_LIVE.test(name) ||
      RE_CS_DIV_TURN_LIVE.test(name) ||
      RE_SPR_LIVE.test(name) ||
      RE_SPR_DIV_LIVE.test(name) ||
      RE_DMG_LIVE.test(name) ||
      RE_DMG_DIV_LIVE.test(name) ||
      name === "CriticalDmgUpByRatioViaBuffCheck" ||
      RE_CRIT_DMG_DIV_LIVE.test(name))
  ) {
    return "verified";
  }
  if (RE_CRIT_DMG_RATIO.test(name)) return "verified";
  return "unverified";
}

const RE_CRIT_DMG_RATIO = /^CriticalDmgUpByRatio(\d+)$/;
const RE_CRIT_DMG_DIV_LIVE = /^CriticalDmgUpByRatioOn(?:CriticalActivated|StartTurn)ViaBuffCheckDevideByStack(?:WithLimit(\d+))?$/;

/** Live (per coin) skill-scope adders: re-checked each time the game queries them. */
export function evaluateLiveSkillEffects(
  scripts: AbilityScript[],
  ctx: EffectContext,
): { coinScaleAdder: number; skillPowerResultAdder: number; attackDmgMultiplier: number } {
  let coinScaleAdder = 0;
  let skillPowerResultAdder = 0;
  let attackDmgMultiplier = 0;
  for (const script of scripts) {
    const name = script.scriptName;
    const bd = script.buffData;
    if (ctx.disabledEffectIds.has(name)) continue;
    const mCritRatio = RE_CRIT_DMG_RATIO.exec(name);
    if (mCritRatio) {
      if (ctx.isCritical) attackDmgMultiplier += Number(mCritRatio[1]) * 0.01;
      continue;
    }
    if (isLiveParamDmg(name)) {
      const pe = evalParamScript(script, ctx.battle ?? DEFAULT_BATTLE, ctx.actorStatuses, ctx.targetStatuses);
      if (pe) attackDmgMultiplier += pe.dmg;
      continue;
    }
    const twoSprLive = RE_TWO_STACK_SPR_LIVE.exec(name);
    if (twoSprLive && bd) {
      skillPowerResultAdder += twoBuffStackSumDivide(ctx, script, twoSprLive[1]!, twoSprLive[2]!);
      continue;
    }
    const byStack = RE_BYSTACK_DMG_LIVE.exec(name);
    if (byStack && bd?.buffKeyword) {
      // CalcAttackDmgMultiplier: (self and/or target activated stack) × 0.01 …, cap limit × 0.01
      const kw = bd.buffKeyword;
      const sum = (byStack[1] !== "Target" ? activatedStack(ctx.actorStatuses, kw) : 0) + (byStack[1] !== "Self" ? activatedStack(ctx.targetStatuses, kw) : 0);
      let v = Math.trunc(sum / Math.max(1, bd.stack ?? 1)) * (bd.value ?? 0.01);
      if ((bd.limit ?? 0) > 0) v = Math.min(v, bd.limit! * 0.01);
      attackDmgMultiplier += v;
      continue;
    }
    if (!bd?.buffKeyword) continue;
    if (RE_CS_LIVE.test(name)) {
      if (checkBuffCondition(ctx, bd)) coinScaleAdder += roundValue(bd.value);
    } else if (RE_CS_DIV_LIVE.test(name)) {
      if (checkBuffCondition(ctx, bd)) coinScaleAdder += coinScaleDivide(ctx, script);
    } else if (RE_CS_DIV_TURN_LIVE.test(name)) {
      if (checkBuffCondition(ctx, bd)) coinScaleAdder += coinScaleDivideByTurn(ctx, script);
    } else if (RE_SPR_LIVE.test(name)) {
      if (checkBuffCondition(ctx, bd)) skillPowerResultAdder += roundValue(bd.value);
    } else if (RE_SPR_DIV_LIVE.test(name)) {
      if (checkBuffCondition(ctx, bd)) skillPowerResultAdder += coinScaleDivide(ctx, script);
    } else if (RE_DMG_LIVE.test(name)) {
      if (checkBuffCondition(ctx, bd)) attackDmgMultiplier += bd.value ?? 0;
    } else if (RE_DMG_DIV_LIVE.test(name)) {
      if (checkBuffCondition(ctx, bd)) attackDmgMultiplier += dmgDivide(ctx, script);
    } else if (name === "CriticalDmgUpByRatioViaBuffCheck") {
      if (ctx.isCritical && checkBuffCondition(ctx, bd)) attackDmgMultiplier += bd.value ?? 0;
    } else if (RE_CRIT_DMG_DIV_LIVE.test(name)) {
      if (RE_CRIT_DMG_DIV_ST.test(name)) {
        const latched = ctx.onceFlags?.get(latchKey(ctx, name));
        if (ctx.isCritical) attackDmgMultiplier += latched ?? (checkBuffCondition(ctx, bd) ? dmgDivide(ctx, script) : 0);
      } else if (ctx.isCritical && checkBuffCondition(ctx, bd)) attackDmgMultiplier += dmgDivide(ctx, script);
    } else if (RE_DMG_DIV_SNAP.test(name) && ctx.onceFlags?.get(latchKey(ctx, name))) {
      attackDmgMultiplier += dmgDivide(ctx, script);
    }
  }
  return { coinScaleAdder, skillPowerResultAdder, attackDmgMultiplier };
}

/** Coin pre-hit damage multiplier (CoinAbility_DmgUpByBuff, CriticalDmgUpByJsonValue, CriticalDmgUpByRatio<N>, etc.). */
export function evaluateCoinPreHitEffects(scripts: AbilityScript[], ctx: EffectContext): { coinDmgMultiplier: number } {
  let coinDmgMultiplier = 0;
  for (const script of scripts) {
    const name = script.scriptName;
    if (ctx.disabledEffectIds.has(name)) continue;
    const bd = script.buffData;
    const pe = evalParamScript(script, ctx.battle ?? DEFAULT_BATTLE, ctx.actorStatuses, ctx.targetStatuses);
    if (pe) {
      coinDmgMultiplier += pe.dmg;
      continue;
    }
    if (name === "DmgUpByBuff" && checkBuffCondition(ctx, bd)) {
      coinDmgMultiplier += bd?.value ?? 0;
    } else if (
      (name === "CriticalDmgUpByJsonValue" ||
        name === "FullStopHongluCriticalAttackDmgUpByRatio" ||
        name === "BrokenUnitCriticalDmgUpByJsonValue") &&
      ctx.isCritical
    ) {
      coinDmgMultiplier += script.value ?? bd?.value ?? 0;
    } else if (
      (name === "CriticalDmgUpByBuffStack" ||
        name === "CriticalDmgUpByBuffStackIfAlly" ||
        name === "CriticalDmgUpByRatioViaBuffCheckDevideByStack" ||
        name === "CriticalDmgUpByBuff1071103" ||
        name === "CriticalDmgUpOnSCViaSelfBreathAndBuffDivide") &&
      ctx.isCritical &&
      bd?.buffKeyword
    ) {
      const c = ownerContainer(ctx, bd);
      const divisor = Math.max(1, bd.stack ?? 1);
      let v = Math.trunc(activatedStack(c, bd.buffKeyword) / divisor) * (bd.value ?? 0);
      if ((bd.limit ?? 0) > 0) {
        const cap = bd.limit! > 2 ? bd.limit! * 0.01 : bd.limit! * (bd.value ?? 0);
        v = Math.min(v, cap);
      }
      coinDmgMultiplier += v;
    } else if (name === "CriticalDmgUpByBreathStackAndTurnLimit40" && ctx.isCritical) {
      const b = ctx.actorStatuses.get("Breath");
      const sum = (b?.potency ?? 0) + (b?.count ?? 0);
      coinDmgMultiplier += Math.min(0.4, sum * 0.01);
    } else if (/^AttackDmgMultiplierDivideByBuffStackTargetIfHasBuff\d*_([A-Za-z]+)$/.test(name) && bd?.buffKeyword) {
      const need = /_([A-Za-z]+)$/.exec(name)![1]!;
      if (ctx.actorStatuses.get(need)) {
        let v = Math.trunc(activatedStack(ctx.targetStatuses, bd.buffKeyword) / Math.max(1, bd.stack ?? 1)) * (bd.value ?? 0.01);
        if ((bd.limit ?? 0) > 0) v = Math.min(v, bd.limit! * 0.01);
        coinDmgMultiplier += v;
      }
    } else {
      const m = RE_CRIT_DMG_RATIO.exec(name);
      if (m && ctx.isCritical) {
        coinDmgMultiplier += Number(m[1]) * 0.01;
      }
    }
  }
  return { coinDmgMultiplier };
}

/** VibrationExplosionOnSucceedAttack[IfRerollCoin]<id>_<times>_<limit per skill>. */
const RE_VIB_NUMBERED = /^VibrationExplosionOnSucceedAttack(IfRerollCoin)?\d+_(\d+)_(\d+)$/;
const RE_VIB_LOSE = /^VibrationExplosionOnSucceedAttack(?:And|Then)LoseTargetVibrationTurn\d+$/;
const RE_VIB_BUFF_CHECK_LOSE = /^VibrationExplosion(?:OnSucceedAttackViaBuffCheck|OSAIfBuffCheck)AndLoseTargetVibrationTurn\d+$/;

/** Classify coin scripts once per skill so unknown ones are reported even if the coin never lands. */
export function classifyCoinScripts(scripts: AbilityScript[], skillId: number, coinIndex: number): EffectObservation[] {
  return scripts.map((s) => {
    const name = s.scriptName;
    const known =
      name === "GiveBuffOnSucceedAttack" ||
      name === "GiveBuffOnSucceedAttackIfUsableInDuel" ||
      name === "GiveBuffOnSucceedAttackHead" ||
      name === "GiveBuffOnSucceedAttackTail" ||
      name === "GiveBuffOnSuccessCriticalAttack" ||
      name === "GiveBuffOnSAIfRerolled" ||
      name === "GiveBuffOnSAAddTurnByValueIfRerolled" ||
      name === "GiveMpDmgOnSAIfRerolled1061702" ||
      name === "GiveBuffThisAndNextTurnOnSAIfRerolled1061702" ||
      name === "GiveAmberDmgByRatioOnSAIfRerolled1061703" ||
      getCoinScriptRerollLimit(s) > 0 ||
      name === "DmgUpByBuff" ||
      name === "CriticalDmgUpByJsonValue" ||
      name === "FullStopHongluCriticalAttackDmgUpByRatio" ||
      name === "BrokenUnitCriticalDmgUpByJsonValue" ||
      name === "CriticalDmgUpByBuffStack" ||
      name === "CriticalDmgUpByBuffStackIfAlly" ||
      name === "CriticalDmgUpByRatioViaBuffCheckDevideByStack" ||
      name === "CriticalDmgUpByBuff1071103" ||
      name === "CriticalDmgUpOnSCViaSelfBreathAndBuffDivide" ||
      name === "CriticalDmgUpByBreathStackAndTurnLimit40" ||
      RE_CRIT_DMG_RATIO.test(name) ||
      name === "VibrationExplosionOnSucceedAttack" ||
      RE_VIB_LOSE.test(name) ||
      RE_VIB_BUFF_CHECK_LOSE.test(name) ||
      RE_VIB_NUMBERED.test(name) ||
      scriptHandler(name) != null ||
      evalParamScript(s, DEFAULT_BATTLE, EMPTY_STATUSES, EMPTY_STATUSES) != null ||
      /^RerollLastCoin\d*$/.test(name) ||
      /^GiveSpecificBuffOnSucceedAttackDivideByBuffStack\d*_[A-Za-z]+_[A-Za-z]+$/.test(name) ||
      /^SwitchVibrationOnSucceedAttack\d*$/.test(name) ||
      /^AttackDmgMultiplierDivideByBuffStackTargetIfHasBuff\d*_[A-Za-z]+$/.test(name);
    const status: EffectStatus = isCosmeticScript(name) ? "cosmetic" : known ? "verified" : "unverified";
    return { scriptName: name, scope: "coin" as const, skillId, coinIndex, status, note: status === "unverified" ? "硬币效果未纳入已验证处理器" : undefined };
  });
}

/** Max rerolls a single coin script can grant when its condition is satisfied. */
export function getCoinScriptRerollLimit(s: AbilityScript): number {
  const n = s.scriptName;
  if (
    n === "RerollViaBuffCheckUpto1" ||
    n === "RerollOnSAViaBuffCheckUpto1" ||
    n === "RerollOnSAHViaBuffCheckUpto1" ||
    n === "RerollOnSAIfSelfSpeedNotLessThan10Upto1" ||
    n === "1081501CoinRerollOSA_agilityCondition3" ||
    n === "1081506CoinRerollOSACri_agilityCondition5" ||
    n === "RerollOnSuccessCriticalAttackHead" ||
    n === "RerollOnSAViaConditionalBuffCheckAndUseResult" ||
    n === "RerollOnSAViaConditionalBuffCheckAndUseResultIfAnyTargetAlive" ||
    n === "RerollOnSucceedAttack10615" ||
    n === "1071405RerollOnSucceedAttack" ||
    n === "RerollOnSAH1101402" ||
    n === "ReRoll1101502" ||
    n === "Reroll1091307" ||
    n === "Reroll1091501_Upto1" ||
    n === "Reroll21008" ||
    n === "OnSucceedAttackReroll21008"
  ) {
    return 1;
  }
  if (n === "RerollOnSACUpto2" || n === "Reroll1091506_Upto2" || n === "RerollCoinByValue") {
    return Math.max(1, Math.min(3, Math.round(s.value ?? 2)));
  }
  if (n === "RerollOnSACUpto3") return 3;
  if (n === "RerollOnSAHUpto5" || n === "RerollOnSAIfSelfMpNotLessThan0Upto5") return 5;
  return 0;
}

/** Check how many times a coin should be reused after hitting. */
export function getActiveCoinRerollLimit(coinScripts: AbilityScript[], ctx: EffectContext, forceByFullTier = false): number {
  let maxRerolls = 0;
  for (const s of coinScripts) {
    const n = s.scriptName;
    if (ctx.disabledEffectIds.has(n)) continue;
    const limit = getCoinScriptRerollLimit(s);
    if (limit <= 0) continue;
    if (forceByFullTier) {
      maxRerolls = Math.max(maxRerolls, limit);
      continue;
    }
    if (n === "RerollViaBuffCheckUpto1" || n === "RerollOnSAViaBuffCheckUpto1" || n === "RerollOnSucceedAttack10615" || n === "1071405RerollOnSucceedAttack" || n === "ReRoll1101502" || n === "Reroll21008") {
      if (checkBuffCondition(ctx, s.buffData)) maxRerolls = Math.max(maxRerolls, limit);
    } else if (n === "RerollOnSAHViaBuffCheckUpto1" || n === "RerollOnSAH1101402") {
      if (ctx.isHeads && checkBuffCondition(ctx, s.buffData)) maxRerolls = Math.max(maxRerolls, limit);
    } else if (n === "RerollOnSuccessCriticalAttackHead" || n === "1081506CoinRerollOSACri_agilityCondition5") {
      if (ctx.isHeads && ctx.isCritical) maxRerolls = Math.max(maxRerolls, limit);
    } else if (n === "RerollOnSAViaConditionalBuffCheckAndUseResult" || n === "RerollOnSAViaConditionalBuffCheckAndUseResultIfAnyTargetAlive") {
      const cond = (s as unknown as { conditionalData?: { conditionBuffData?: BuffData } }).conditionalData?.conditionBuffData;
      if (checkBuffCondition(ctx, cond)) maxRerolls = Math.max(maxRerolls, limit);
    } else if (n === "RerollOnSAHUpto5") {
      if (ctx.isHeads) maxRerolls = Math.max(maxRerolls, limit);
    } else if (n === "RerollOnSAIfSelfSpeedNotLessThan10Upto1" || n === "1081501CoinRerollOSA_agilityCondition3") {
      if (activatedStack(ctx.actorStatuses, "Agility") >= 3) maxRerolls = Math.max(maxRerolls, limit);
    } else {
      maxRerolls = Math.max(maxRerolls, limit);
    }
  }
  return maxRerolls;
}

export function shouldRerollCoin(coinScripts: AbilityScript[], ctx: EffectContext, forceByFullTier = false): boolean {
  return getActiveCoinRerollLimit(coinScripts, ctx, forceByFullTier) > 0;
}

/** Coin OnSucceedAttack effects (after the hit damage and target OnTakeAttackDamage triggers). */
export function executeCoinOnHitEffects(coinScripts: AbilityScript[], skillScripts: AbilityScript[], ctx: EffectContext): void {
  const tag = `硬币${(ctx.coinIndex ?? 0) + 1}`;
  for (const script of skillScripts) {
    const sn = script.scriptName;
    if (ctx.disabledEffectIds.has(sn)) continue;
    if (sn === "GiveBuffOnSucceedAttack") {
      applyBuffData(ctx, script, `${tag}命中(技能)`);
    }
    const rnd = /^GiveRandomBuffOnSucceedAttack\w*_([A-Za-z]+)_([A-Za-z]+)$/.exec(sn);
    if (rnd && script.buffData) {
      // Random pick; deterministic mode alternates (A on odd hits, B on even hits) to approximate the 50/50 expectation.
      const kw = (ctx.onceFlags?.get(`rnd:${ctx.skillId}:${ctx.turn}`) ?? 0) % 2 === 0 ? rnd[1]! : rnd[2]!;
      ctx.onceFlags?.set(`rnd:${ctx.skillId}:${ctx.turn}`, (ctx.onceFlags?.get(`rnd:${ctx.skillId}:${ctx.turn}`) ?? 0) + 1);
      applyBuffData(ctx, { ...script, buffData: { ...script.buffData, buffKeyword: kw, target: "Target" } }, `${tag}命中随机(交替近似)`);
    }
    if (/^SwitchVibrationOnSucceedAttack\d*$/.test(sn) && script.buffData?.buffKeyword) switchVibration(ctx, script.buffData.buffKeyword, tag);
  }
  for (const script of coinScripts) {
    const name = script.scriptName;
    if (ctx.disabledEffectIds.has(name)) continue;
    if (name === "GiveBuffOnSucceedAttack" || name === "GiveBuffOnSucceedAttackIfUsableInDuel") applyBuffData(ctx, script, `${tag}命中`);
    else if (name === "GiveBuffOnSucceedAttackHead" && ctx.isHeads) applyBuffData(ctx, script, `${tag}正面命中`);
    else if (name === "GiveBuffOnSucceedAttackTail" && !ctx.isHeads) applyBuffData(ctx, script, `${tag}反面命中`);
    else if (name === "GiveBuffOnSuccessCriticalAttack" && ctx.isCritical) applyBuffData(ctx, script, `${tag}暴击命中`);
    else if (name === "GiveBuffOnSAIfRerolled" && ctx.isRerolled) applyBuffData(ctx, script, `${tag}重投命中`);
    else if (name === "GiveBuffThisAndNextTurnOnSAIfRerolled1061702" && ctx.isRerolled && script.buffData?.buffKeyword) {
      applyBuffData({ ...ctx }, { ...script, buffData: { ...script.buffData, activeRound: 0 } }, `${tag}重投命中(本回合)`);
      applyBuffData({ ...ctx }, { ...script, buffData: { ...script.buffData, activeRound: 1 } }, `${tag}重投命中(下回合)`);
    } else if (name === "GiveAmberDmgByRatioOnSAIfRerolled1061703" && ctx.isRerolled) {
      const baseRatio = script.value ?? 0.3;
      const amberDown = ctx.targetStatuses.getPotency("AmberResistDown");
      const effRatio = baseRatio * (1 + amberDown * 0.1);
      const floatAmount = (ctx.lastCoinFloatDamage ?? ctx.lastCoinResolvedDamage ?? 0) * effRatio;
      const bonus = Math.max(0, Math.floor((ctx.lastCoinResolvedDamage ?? 0) * effRatio + 1e-7));
      if (bonus > 0 || floatAmount > 0) {
        ctx.bonusHitDamages ??= [];
        ctx.bonusHitDamages.push({
          amount: bonus,
          floatAmount,
          ratio: Math.round(effRatio * 100) / 100,
          desc: `${tag}重投怠惰追加伤害 (${Math.round(effRatio * 100)}%)`,
        });
      }
    } else if (/^SwitchVibrationOnSucceedAttack\d*$/.test(name) && script.buffData?.buffKeyword) {
      switchVibration(ctx, script.buffData.buffKeyword, tag);
    } else if (/^GiveSpecificBuffOnSucceedAttackDivideByBuffStack\d*_([A-Za-z]+)_([A-Za-z]+)$/.test(name) && script.buffData?.buffKeyword) {
      const m = /_([A-Za-z]+)_([A-Za-z]+)$/.exec(name)!;
      const bd = script.buffData;
      const n = divideCount(ownerContainer(ctx, bd), bd.buffKeyword!, bd.value ?? 1, bd.limit);
      if (n > 0) {
        for (const kw of [m[1]!, m[2]!]) {
          applyBuffData(ctx, { ...script, buffData: { ...bd, buffKeyword: kw, stack: (bd.stack ?? 0) * n, turn: (bd.turn ?? 0) * n, target: bd.target ?? "Target" } }, `${tag}命中(按层数)`);
        }
      }
    } else if (RE_VIB_NUMBERED.test(name)) {
      const m = RE_VIB_NUMBERED.exec(name)!;
      if (!m[1] || ctx.isRerolled) {
        const key = `vib:${ctx.skillId}:${ctx.turn}:${name}`;
        const times = Number(m[2]);
        const limit = Number(m[3]);
        for (let k = 0; k < times && (ctx.onceFlags?.get(key) ?? 0) < limit; k++) {
          ctx.onceFlags?.set(key, (ctx.onceFlags?.get(key) ?? 0) + 1);
          const rec = triggerVibrationExplosion(ctx.targetStatuses, ctx.turn, `技能 ${ctx.skillId} ${tag} 震颤引爆`);
          if (!rec) break;
          ctx.dotTriggers.push(rec);
          const { before, after } = ctx.targetStatuses.consumeCount("Vibration", 1);
          ctx.statusChanges.push({ statusId: ctx.targetStatuses.resolveId("Vibration"), target: "target", before, after, reason: name });
        }
      }
    } else if (name === "VibrationExplosionOnSucceedAttack") {
      const rec = triggerVibrationExplosion(ctx.targetStatuses, ctx.turn, `技能 ${ctx.skillId} ${tag} 震颤引爆`);
      if (rec) ctx.dotTriggers.push(rec);
    } else if (RE_VIB_LOSE.test(name)) {
      const rec = triggerVibrationExplosion(ctx.targetStatuses, ctx.turn, `技能 ${ctx.skillId} ${tag} 震颤引爆`);
      if (rec) ctx.dotTriggers.push(rec);
      const lose = nameDigits(name);
      if (lose > 0 && ctx.targetStatuses.get("Vibration")) {
        const { before, after } = ctx.targetStatuses.consumeCount("Vibration", lose);
        ctx.statusChanges.push({ statusId: "Vibration", target: "target", before, after, reason: `${name}` });
      }
    } else if (RE_VIB_BUFF_CHECK_LOSE.test(name)) {
      if (checkBuffCondition(ctx, script.buffData)) {
        const rec = triggerVibrationExplosion(ctx.targetStatuses, ctx.turn, `技能 ${ctx.skillId} ${tag} 震颤引爆(条件满足)`);
        if (rec) ctx.dotTriggers.push(rec);
        const lose = nameDigits(name);
        if (lose > 0 && ctx.targetStatuses.get("Vibration")) {
          const { before, after } = ctx.targetStatuses.consumeCount("Vibration", lose);
          ctx.statusChanges.push({ statusId: "Vibration", target: "target", before, after, reason: `${name}` });
        }
      }
    }
  }
}

function switchVibration(ctx: EffectContext, toId: string, tag: string): void {
  const r = ctx.targetStatuses.convert("Vibration", toId);
  if (r) ctx.statusChanges.push({ statusId: toId, target: "target", before: { potency: 0, count: 0 }, after: r.after, reason: `${tag}震颤转换为${toId}` });
}

/** Execute end-of-attack skill scripts (GiveBuffOnEndAttack, UseBuffAllStackOnEndAttack). */
export function executeSkillEndEffects(scripts: AbilityScript[], ctx: EffectContext): void {
  for (const script of scripts) {
    const name = script.scriptName;
    if (ctx.disabledEffectIds.has(name)) continue;
    if (name === "GiveBuffOnEndAttack" || name === "GiveBuffOnEndSkill") {
      applyBuffData(ctx, script, "攻击结束");
    } else if (/^GiveBuffOnEndAttackToAllAttackedTargets\d*$/.test(name) && script.buffData?.buffKeyword) {
      applyBuffData(ctx, { ...script, buffData: { ...script.buffData, target: "Target" } }, "攻击结束(被攻击目标)");
    } else if (/^UseBuffAndHealHpRatioOnEndAttack\d*$/.test(name) && script.buffData?.buffKeyword) {
      const bd = script.buffData;
      const cur = activatedStack(ctx.actorStatuses, bd.buffKeyword!);
      const r = ctx.actorStatuses.losePotency(bd.buffKeyword!, Math.min(cur, bd.limit ?? cur));
      if (r) ctx.statusChanges.push({ statusId: bd.buffKeyword!, target: "actor", ...r, reason: name });
    } else if (name === "GiveBuffOnEndTurnIfSelfBuffTurnLess" && script.buffData?.buffKeyword) {
      const kw = script.buffData.buffKeyword;
      const threshold = script.value ?? 10;
      if (activatedTurn(ctx.actorStatuses, kw) < threshold) {
        applyBuffData(ctx, script, `技能结束补充能(<${threshold})`);
      }
    } else if (name === "GiveBuffOnEndAttackIfNotHas_TimeToListenHonglu" && script.buffData?.buffKeyword) {
      if (!ctx.actorStatuses.get("TimeToListenHonglu")) {
        applyBuffData(ctx, script, "技能结束获得听讲准备");
      }
    } else if (name === "GiveBuffOnUsePerBuffStack_Charge1_Limit15" && script.buffData?.buffKeyword) {
      const bd = script.buffData;
      const p = activatedStack(ctx.actorStatuses, "Charge");
      const add = Math.min(15, p * Math.max(1, bd.stack ?? 3));
      if (add > 0) {
        const { before, after } = ctx.actorStatuses.apply(bd.buffKeyword!, add, 0, 0);
        ctx.statusChanges.push({ statusId: bd.buffKeyword!, target: "actor", before, after, reason: name });
      }
    } else if (name === "UseBuffAllStackOnEndAttack" && script.buffData?.buffKeyword) {
      const bd = script.buffData;
      const kw = bd.buffKeyword!;
      const toSelf = (bd.target || bd.buffOwner || "Self") === "Self";
      const container = toSelf ? ctx.actorStatuses : ctx.targetStatuses;
      if (container.get(kw)) {
        const before = container.destroy(kw);
        ctx.statusChanges.push({
          statusId: kw,
          target: toSelf ? "actor" : "target",
          before,
          after: { potency: 0, count: 0 },
          reason: "攻击结束清空层数:UseBuffAllStackOnEndAttack",
        });
      }
    }
  }
}
