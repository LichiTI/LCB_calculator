/**
 * Battle-passive framework.
 *
 * Passive logic lives only in game code (PassiveAbility_<id> classes, IL2CPP). Each handler here is a hand translation
 * of one class, registered by id. The simulator calls the hooks at the matching battle timings:
 *   onBattleStart  – once per encounter, turn 1 only (first appearance / "登场时" effects)
 *   onTurnStart    – each turn before actions. NOTE: the game's PassiveAbility.OnBattleStart ("战斗开始时") runs at the
 *                    combat phase of EVERY turn, so translate it here unless the code guards it to once per battle.
 *   skillMods      – on-use modifiers (OnStartTurn_BeforeLog / GetSkillPowerAdder / GetCoinScaleAdder / GetAttackDmgMultiplier
 *                    evaluated with the state at skill start)
 *   coinMods       – per-coin modifiers (evaluated before each coin's damage); `basePower` returned here is a per-coin base
 *                    power (added to that coin's rolled power only, for GetSkillPowerAdder families re-read per coin)
 *   onCoinHit      – OnSucceedAttack (after the hit's own coin effects)
 *   onSkillEnd     – OnEndSkill / OnEndAttack
 *   onRoundEnd     – OnRoundEnd (before status decay)
 */
import type { BattleCtx } from "../param-scripts";
import type { StatusChange, StatusChangeEvent, StatusContainer, StatusInterceptResult } from "../status";
import type { ActionRecord } from "../action-record";
export type { ActionRecord } from "../action-record";
import type { AtkType, SinAttribute } from "../../config/game-data";

export interface PassiveSkillInfo {
  id: number;
  /** "S1" | "S2" | "S3" | "DEF" | "EGO" | null */
  slot: string | null;
  sin: string | undefined;
  atkType: string | undefined;
  defType: string | undefined;
  coinCount: number;
  basePower: number;
}

export interface PassiveMods {
  coinScale: number;
  basePower: number;
  finalPower: number;
  /** Attack damage multiplier, additive (0.1 = +10%). */
  dmg: number;
  offense: number;
  /**
   * Flat attack damage adder (BattleActionModel.GetAttackDmgAdder, e.g. SkillAbility_AttackDmgAdder*). Optional, default 0.
   * GiveAttackDamage adds it after the multipliers: + adder × (1 + max(0, sinRes + atkRes + levelDiff terms)), then floors.
   */
  atkDmgAdder?: number;
}

/**
 * Crit chance contribution for one coin (BattleActionModel.GetCriticalChance @0x147D560):
 *   chance = (unit + take) × (1 + Σmul) + Σadd
 * unit = BattleUnitModel.GetCriticalChance (Breath potency × 5%, BuffAbility/PassiveAbility GetCriticalChanceAdder);
 * take = target BuffDetail.GetTakeCriticalChanceAdder; mul = SkillModel.GetCriticalChanceMultiplier (SkillAbility, summed);
 * add = SkillModel/CoinModel.GetCriticalChanceAdder. Return the parts a handler contributes (ratios, 0.1 = 10%).
 */
export interface CritChanceMod {
  /** Added to the unit's base chance (inside the multiplier): status/passive GetCriticalChanceAdder, target TakeCritical adders. */
  unit?: number;
  /** Added to the skill multiplier sum (SkillAbility.GetCriticalChanceMultiplier; 1 = chance × 2). */
  mul?: number;
  /** Added after the multiplier (SkillAbility/CoinAbility.GetCriticalChanceAdder). */
  add?: number;
}

export interface PassiveCtx {
  turn: number;
  identityId: number;
  /** Actor's SP (sanity), -45..45; constant during an unopposed simulation. */
  actorSp: number;
  /** Whether the target has SP at all. */
  targetHasSp: boolean;
  actor: StatusContainer;
  target: StatusContainer;
  battle: BattleCtx;
  /** Per-passive persistent counters for the whole battle (e.g. "usedThisTurn", stacks). */
  state: Map<string, number>;
  skill?: PassiveSkillInfo;
  coinIndex?: number;
  isHeads?: boolean;
  isCritical?: boolean;
  isRerolled?: boolean;
  /** Final damage of the coin hit that just landed (onCoinHit). */
  lastHitDamage?: number;
  /** Record of the current / most recent skill use (BattleActionModel.UsedBuffStack/Turn); undefined before any skill use. */
  action?: ActionRecord;
  /** Script names of the current skill (skill-level + every coin); undefined outside a skill use. */
  skillScripts?: readonly string[];
  /** Target SP when the scenario gives the target SP (target.hasSp + target.initialSp); otherwise undefined. */
  targetSp?: number;
  /**
   * Coin-list editor of the skill about to be used. Only defined in the skill-start window (ScriptHandler/AbilityHandler
   * onSkillStart and ScriptHandler.skillMods); edits are applied before the first coin, so coinCount reflects them.
   */
  coins?: CoinEditor;
  /** Apply a status (potency/count) to a side. */
  give(side: "actor" | "target", keyword: string, potency: number, count: number, activeRound?: 0 | 1): void;
  /** Gain resource stacks on the actor, honoring GetStackRoundLimit*. */
  gain(keyword: string, amount: number): void;
  /** Reduce count (turn) of a status, logged as a status change. */
  consume(side: "actor" | "target", keyword: string, count: number): void;
  /** Reduce potency of a status. */
  lose(side: "actor" | "target", keyword: string, amount: number): void;
  /**
   * Fixed extra HP damage on the target (not an attack hit).
   * Without `opts` the amount is dealt as-is (legacy behaviour). With `opts.sin` it is resolved like
   * BattleUnitModel.TakeHpDamageAppliedAttributeResist: Util.Round(amount × target sin resistance), where the resistance
   * is the scenario value plus status AttributeResistAdderByStack (same as for attack hits). `opts.atkType` additionally
   * multiplies by the target's physical resistance (the game's attribute damage does not; only pass it when the
   * translated code explicitly applies physical resist).
   */
  extraDamage(amount: number, desc: string, opts?: ExtraDamageOpts): void;
  note(msg: string): void;
  /** True if an ally matching a sinner name / identity id is declared present in scenario.battle.allies. */
  allyPresent(...keys: string[]): boolean;
  /**
   * Target current HP ratio (0..1). Scenario target.hpRatio (default 1); when target.hpTracking is on it decreases with the
   * HP damage dealt so far (÷ target.maxHp), otherwise it stays fixed at the starting ratio.
   */
  targetHpRatio(): number;
  /** 1 − targetHpRatio(). */
  targetLostHpRatio(): number;
  /** Actor current HP ratio (0..1) = 1 − battle.lostHpPct / 100. */
  selfHpRatio(): number;
  /** Target max HP from scenario target.maxHp / target.hp; null when the scenario does not specify one. */
  targetMaxHp(): number | null;
  /** Actor max HP = floor(identity hp.base + hp.perLevel × level) (0 when no identity). */
  selfMaxHp(): number;
  /**
   * Register a status-change filter on one or both sides (applied centrally in StatusContainer.apply / consumeCount /
   * losePotency, i.e. to every source incl. generic engine effects). Return a new delta (0 blocks), {replaceWith} or undefined.
   * scope: "skill" (until this skill ends), "turn" (until round end), "persistent", or { whileStatus, on? } (while that
   * status is present on `on`, default the intercepted side). opts.key de-duplicates re-registration (hooks run per coin).
   * Optional for backward compatibility: call as c.interceptStatus?.(…).
   */
  interceptStatus?(scope: StatusHookScope, fn: (change: SidedStatusChange) => StatusInterceptResult, opts?: StatusHookOpts): void;
  /** Same lifetimes as interceptStatus; called after each effective change (before/after amounts). */
  onStatusChange?(scope: StatusHookScope, fn: (ev: StatusChangeEvent & { side: "actor" | "target" }) => void, opts?: StatusHookOpts): void;
  /**
   * Util.CutInActionBySkillId / BattleUnitModel.CutInAction by the actor itself: queue an extra use of `skillId`, executed
   * right after the current skill (same turn). Damage is reported under its own entry "追加行动:<label|skillId>".
   * opts.key + opts.perTurn limit queued uses per turn (default 1 per key). Returns false when not queued. Optional.
   */
  queueAction?(skillId: number, opts?: { label?: string; key?: string; perTurn?: number }): boolean;
  /** Opt-in stagger model (scenario target.staggerThresholdsPct + target.hpTracking): true while the target is staggered. */
  targetStaggered?(): boolean;
  /**
   * Opt-in enemy-action model (scenario.duel): outcome of the current skill's clash — "win" / "lose", or null when the
   * skill did not clash (default: never). parryingCount = assumed clash count (scenario.duel.parryingCount, default 1).
   */
  duelResult?(): "win" | "lose" | null;
  parryingCount?: number;
  /**
   * Effective target resistance multiplier (UnitModel.GetAttributeResistValue / GetAtkResistValue): scenario value, sin side
   * + status AttributeResistAdderByStack. Both given → product; none → 1. Optional: call as c.targetResist?.(…).
   */
  targetResist?(opts: ExtraDamageOpts): number;
  /** Game resist category of the target for a sin or attack type (UnitModel.Get{Attribute,Atk}ResistLevelByType). */
  targetResistLevel?(opts: ExtraDamageOpts): ResistLevel;
  /** Target has a UNIT_KEYWORD / association (scenario target.unitKeywords, case-insensitive). Optional. */
  targetHasUnitKeyword?(keyword: string): boolean;
  /** Actor identity has a UNIT_KEYWORD / association (identity unitKeywords + associations). Optional. */
  actorHasUnitKeyword?(keyword: string): boolean;
  /**
   * Opt-in multi-target model (scenario battle.targetCount / battle.countSubTargets). Attack weight (攻击容量) of the current
   * skill = attrs.targetNum + estimated TagetNumAdder* scripts + runtime changes; 1 outside a skill.
   */
  attackWeight?(): number;
  /** Alive enemy count (scenario battle.targetCount, default 1). */
  targetCount?(): number;
  /** Units this skill hits = min(attackWeight, targetCount) (BattleActionModel.GetAliveTargetUnitModelList). */
  hitTargetCount?(): number;
  /** Change the current skill's attack weight (TargetNumAdder / OverwriteTargetNum). No-op outside a skill. */
  addAttackWeight?(n: number): void;
  setAttackWeight?(n: number): void;
  /**
   * Declared allies (scenario battle.allies) that are identity ids, resolved to identity data (sinner-name entries cannot be
   * resolved and are omitted). Optional.
   */
  allyIdentities?(): { id: number; associations: string[]; unitKeywords: string[]; battlePassiveIds: number[] }[];
  /**
   * Opt-in ally joint / supportive attack: the declared ally `allyId` uses `skillId` on the target (ally skill data at the
   * actor's level, no ally passives/scripts, no crit; coins per coin mode). Recorded in totals.ally; added to total only when
   * scenario battle.countAllyDamage is on. chance < 1 → rolled in Monte Carlo, scaled (expected value) otherwise.
   * Returns the damage recorded (0 when not executed). key/perTurn limit executions (default 1 per turn per key).
   */
  allyAttack?(o: { allyId: number; skillId: number; label?: string; key?: string; perTurn?: number; dmgMul?: number; chance?: number }): number;
}

/**
 * RESIST_VALUE (game enum order). Note the game's naming: WEAK = 致命(Fatal), VULNERABLE = 脆弱(Weak),
 * ENDURE = 抵抗(Endured), RESIST = 微弱(Ineffective), IMMUNE = 免疫.
 */
export type ResistLevel = "WEAK" | "VULNERABLE" | "NORMAL" | "ENDURE" | "RESIST" | "IMMUNE";

/** UnitModel.GetAttributeResistLevelByType thresholds (floats @0x188830E48/0x18883100C/0x18883104C/0x188831134). */
export function resistLevelOf(r: number): ResistLevel {
  if (r <= 0) return "IMMUNE";
  if (r <= 0.51) return "RESIST";
  if (r < 0.99) return "ENDURE";
  if (r < 1.01) return "NORMAL";
  if (r <= 1.51) return "VULNERABLE";
  return "WEAK";
}

/** SkillModel coin list edits (SkillAbility.CopyCoinModelAndAddToListByIndex / BattleUtil.AddSuperCoinScriptToCoin). */
export interface CoinEditor {
  /** Coin count including coins added so far in this window. */
  readonly count: number;
  /**
   * Append a copy of coin `copyOf` (0-based, original list) to the end of the coin list: same operator, scale and coin scripts
   * (CoinModel copy ctor + CreateCoinAbilities). `power` overrides the scale; `scripts` are extra coin scripts; `super` marks it SuperCoin.
   * Returns false when the index is out of range.
   */
  add(o: { copyOf: number; power?: number; scripts?: ScriptData[]; super?: boolean }): boolean;
  /**
   * Turn coin(s) into SuperCoin (grey grade-2 "unbreakable" coin). Only affects clash destruction; tosses are unchanged
   * (no head bias in CoinModel.Roll), so unopposed damage is unaffected. Exposed to scripts as ScriptCtx.isSuperCoin.
   */
  makeSuper(index: number | "all" | "last"): void;
}

export type StatusHookScope = "skill" | "turn" | "persistent" | { whileStatus: string; on?: "actor" | "target" };
export interface StatusHookOpts {
  side?: "actor" | "target" | "both";
  key?: string;
  /** Interceptor order (ascending, default 0). */
  order?: number;
}
export type SidedStatusChange = StatusChange & { side: "actor" | "target" };

/** Optional resistance handling for PassiveCtx.extraDamage. */
export interface ExtraDamageOpts {
  /** Damage attribute (sin); applies the target's sin resistance. NEUTRAL / undefined → ×1. */
  sin?: SinAttribute;
  /** Physical attack type; applies the target's physical resistance. */
  atkType?: AtkType;
  /**
   * "To all targets" damage: with battle.countSubTargets the same amount is also counted once per sub-target
   * (hitTargetCount − 1) in totals.subTarget. Main-target result is unchanged.
   */
  allTargets?: boolean;
}

export interface PassiveHandler {
  id: number;
  /** One-line Chinese summary of what is modelled. */
  summary: string;
  /** Assumption / approximation note shown in the result; omit when exact. */
  approx?: string;
  onBattleStart?(c: PassiveCtx): void;
  /**
   * Before a skill is used (PassiveAbility.OnChangeSkillBeforeCompleteCommand / BeforeCompleteCommand): may call
   * c.replaceSkill(id, reason) to swap the skill about to be used (runs after skill-scope ScriptHandler.beforeUse).
   */
  beforeUse?(c: PassiveCtx & { replaceSkill(newSkillId: number, reason?: string): boolean }): void;
  onTurnStart?(c: PassiveCtx): void;
  skillMods?(c: PassiveCtx): Partial<PassiveMods> | void;
  coinMods?(c: PassiveCtx): Partial<PassiveMods> | void;
  onCoinHit?(c: PassiveCtx): void;
  onSkillEnd?(c: PassiveCtx): void;
  onRoundEnd?(c: PassiveCtx): void;
  /** Opt-in stagger model: the target just became staggered (HP crossed a scenario stagger threshold). */
  onTargetStagger?(c: PassiveCtx): void;
  /** Opt-in enemy-action model: the current skill won / lost its clash (before the attack; c.skill set). */
  onWinDuel?(c: PassiveCtx): void;
  onLoseDuel?(c: PassiveCtx): void;
  /** Opt-in enemy-action model: the actor was hit by an enemy attack coin (c.lastHitDamage = assumed damage, may be 0). */
  onTakeAttack?(c: PassiveCtx): void;
  /** Crit chance contribution for the coin about to be rolled (c.coinIndex / c.isHeads / c.isRerolled set; isCritical unset). */
  critChance?(c: PassiveCtx): CritChanceMod | void;
  /** OnVibrationExplosion: a unit (ev.side) was Tremor-Burst by any source during the simulation. */
  onVibrationExplosion?(c: PassiveCtx, ev: VibrationExplosionEvent): void;
}

/** Vibration explosion (Tremor Burst) event; potency/count are the exploded Vibration's values at the burst. */
export interface VibrationExplosionEvent {
  side: "actor" | "target";
  /** Resolved Vibration status id (Vibration or a converted variant such as VibrationFocusing). */
  statusId: string;
  potency: number;
  count: number;
  turn: number;
}

export const PASSIVES = new Map<number, PassiveHandler>();

// ---------------------------------------------------------------- skill / coin scripts and status abilities

/** Raw script entry from skill data (scriptName, value, buffData). */
export interface ScriptData {
  scriptName: string;
  value?: number;
  buffData?: { buffKeyword?: string; buffOwner?: string; target?: string; stack?: number; turn?: number; value?: number; limit?: number; activeRound?: number };
  [k: string]: unknown;
}

export interface ScriptCtx extends PassiveCtx {
  script: ScriptData;
  /** "skill" for skill-level abilityScripts, "coin" for a coin's abilityScriptList. */
  scope: "skill" | "coin";
  /** Index of the coin carrying a coin script (scope "coin"). */
  ownerCoinIndex?: number;
  /** Full normalized skill data (coins with their abilityScriptList, attrs). */
  skillData: unknown;
  /**
   * Engine-maintained record of the current skill use (all coins, all scripts/passives/effects):
   * statuses spent via consume/lose/effect consumption, plus a shared scratch map reset at skill start.
   */
  action: ActionRecord;
  /**
   * CoinAbility.AffectNextCoin: modifiers for the following coin of the same skill use (index ownerCoinIndex/coinIndex + 1),
   * applied to every pass of that coin. Repeated calls from the same script on the same coin overwrite (ability attached once).
   */
  nextCoin: { addPower(n: number): void; addFinalPower(n: number): void };
  /**
   * Cancel the current coin before it is tossed (only effective from `beforeCoin`): no roll, damage, on-hit or reuse.
   * `rest: true` also cancels every later coin of this skill use (SkillModel.DisableCoin on lack of ammo).
   */
  cancelCoin(reason: string, opts?: { rest?: boolean }): void;
  /**
   * BattleActionModel.ChangeSkill (SkillAbility.OnBeforeTurn / OnSetTarget): replace the skill about to be used by `newSkillId`.
   * Only defined inside ScriptHandler.beforeUse; returns false if the skill is unknown or was already used in this replacement chain.
   * The replacement's coins/scripts run instead; logged as "变身/替换" in events and result.skillReplacements.
   */
  replaceSkill?(newSkillId: number, reason?: string): boolean;
  /** The coin being resolved (coinIndex) is a SuperCoin. */
  isSuperCoin?: boolean;
  /** The coin being resolved (coinIndex) was added by an ability (CoinEditor.add). */
  isAddedCoin?: boolean;
}

/**
 * Translation of one SkillAbility_/CoinAbility_ class, keyed by exact script name (or a RegExp for name-parameterised ones).
 * Coin-scope hooks (coinMods/onCoinHit) run only for the coin that carries the script; skill-scope ones for every coin.
 */
export interface ScriptHandler {
  name: string | RegExp;
  summary: string;
  approx?: string;
  /**
   * Before the skill is used (SkillAbility.OnBeforeTurn / OnSetTarget), skill-scope scripts only, before any other hook;
   * may call `c.replaceSkill(id, reason)`. Runs again for the replacement skill's scripts (chain, no repeats).
   */
  beforeUse?(c: ScriptCtx): void;
  /**
   * Skill use start (OnStartTurn_BeforeLog), after status abilities' onSkillStart and before on-use (WhenUse) statuses;
   * skill-scope scripts and every coin's scripts. `c.coins` is defined here (add / SuperCoin).
   */
  onSkillStart?(c: ScriptCtx): void;
  /** Modifiers snapshotted at skill use (OnStartTurn). */
  skillMods?(c: ScriptCtx): Partial<PassiveMods> | void;
  /** Coin start (OnStartCoin), before the toss; may call `c.cancelCoin(reason)` (e.g. UseBullet[necessary] without ammo). */
  beforeCoin?(c: ScriptCtx): void;
  /** Per-coin modifiers before damage. */
  coinMods?(c: ScriptCtx): Partial<PassiveMods> | void;
  /** Extra reuses (rerolls) of the carrying coin after it hits. */
  rerolls?(c: ScriptCtx): number;
  /** Crit chance contribution for the coin about to be rolled (skill-scope: every coin; coin-scope: carrying coin). */
  critChance?(c: ScriptCtx): CritChanceMod | void;
  onCoinHit?(c: ScriptCtx): void;
  onSkillEnd?(c: ScriptCtx): void;
  /** Opt-in enemy-action model: this skill won / lost its clash (runs for skill-scope and every coin's scripts). */
  onWinDuel?(c: ScriptCtx): void;
  onLoseDuel?(c: ScriptCtx): void;
}

export const SCRIPTS = new Map<string, ScriptHandler>();
export const SCRIPT_PATTERNS: ScriptHandler[] = [];

export function registerScripts(...hs: ScriptHandler[]): void {
  for (const h of hs) {
    if (typeof h.name === "string") SCRIPTS.set(h.name, h);
    else SCRIPT_PATTERNS.push(h);
  }
  SCRIPT_CACHE.clear();
}

/** Memoised name → handler resolution (null = no handler). Cleared on every register call; first matching pattern wins. */
const SCRIPT_CACHE = new Map<string, ScriptHandler | null>();

export function scriptHandler(name: string): ScriptHandler | undefined {
  let h = SCRIPT_CACHE.get(name);
  if (h === undefined) {
    h = SCRIPTS.get(name) ?? SCRIPT_PATTERNS.find((p) => (p.name as RegExp).test(name)) ?? null;
    SCRIPT_CACHE.set(name, h);
  }
  return h ?? undefined;
}

/** Scripts that provably never change this unit's damage (clash-only, targeting, healing...). */
export function noDamageScript(name: string, summary: string): ScriptHandler {
  return { name, summary: `${summary}（不影响本次伤害）` };
}

export interface AbilityCtx extends PassiveCtx {
  /** Which unit owns the status carrying this ability. */
  side: "actor" | "target";
  status: { id: string; potency: number; count: number };
  ability: { ability: string; value?: number; buffData?: ScriptData["buffData"] };
  /** Record of the current skill use (BattleActionModel.UsedBuffStack/Turn); undefined outside a skill use. */
  action?: ActionRecord;
}

/**
 * Translation of one BuffAbility_ class, keyed by ability name. Runs for every active status carrying it, on either side.
 * For side "target", coinMods.dmg means extra damage taken by the target (TakeAtkDamageMultiplier).
 */
export interface AbilityHandler {
  name: string | RegExp;
  summary: string;
  approx?: string;
  coinMods?(c: AbilityCtx): Partial<PassiveMods> | void;
  /** Crit chance contribution for the actor's coin about to be rolled (check c.side: "actor" = own adder, "target" = TakeCritical). */
  critChance?(c: AbilityCtx): CritChanceMod | void;
  onCoinHit?(c: AbilityCtx): void;
  /** Opt-in enemy-action model: the unit holding this status (c.side) won / lost a clash, or was hit by an enemy attack (actor only). */
  onWinDuel?(c: AbilityCtx): void;
  onLoseDuel?(c: AbilityCtx): void;
  onTakeAttack?(c: AbilityCtx): void;
  onRoundEnd?(c: AbilityCtx): void;
  /** BuffAbility.OnRoundStart(_After_Event): each turn at round start, before passives' onTurnStart. */
  onRoundStart?(c: AbilityCtx): void;
  /** BuffAbility.OnBattleStart ("战斗开始时"): each turn at the combat phase, after passives' onBattleStart/onTurnStart. */
  onBattleStart?(c: AbilityCtx): void;
  /** Each skill use, right after the action record starts and before the skill's on-use (WhenUse) statuses are applied. */
  onSkillStart?(c: AbilityCtx): void;
  /**
   * BuffAbility.OnVibrationExplosion: the unit holding this status (c.side === ev.side) was Tremor-Burst.
   * Dispatched only for statuses on the exploded unit; c.skill is the current skill use when the burst came from one.
   */
  onVibrationExplosion?(c: AbilityCtx, ev: VibrationExplosionEvent): void;
}

export const ABILITIES = new Map<string, AbilityHandler>();
export const ABILITY_PATTERNS: AbilityHandler[] = [];

export function registerAbilities(...hs: AbilityHandler[]): void {
  for (const h of hs) {
    if (typeof h.name === "string") ABILITIES.set(h.name, h);
    else ABILITY_PATTERNS.push(h);
  }
  ABILITY_CACHE.clear();
}

const ABILITY_CACHE = new Map<string, AbilityHandler | null>();

export function abilityHandler(name: string): AbilityHandler | undefined {
  let h = ABILITY_CACHE.get(name);
  if (h === undefined) {
    h = ABILITIES.get(name) ?? ABILITY_PATTERNS.find((p) => (p.name as RegExp).test(name)) ?? null;
    ABILITY_CACHE.set(name, h);
  }
  return h ?? undefined;
}

export function noDamageAbility(name: string, summary: string): AbilityHandler {
  return { name, summary: `${summary}（不影响本次伤害）` };
}

export function registerPassives(...hs: PassiveHandler[]): void {
  for (const h of hs) PASSIVES.set(h.id, h);
}

/** Passives whose effects provably never change damage dealt by this unit (SP heal, stagger resist, ally-only buffs…). */
export function noDamagePassive(id: number, summary: string): PassiveHandler {
  return { id, summary: `${summary}（不影响本单位输出）` };
}

export const ZERO_MODS: PassiveMods = { coinScale: 0, basePower: 0, finalPower: 0, dmg: 0, offense: 0 };

export function addMods(a: PassiveMods, b: Partial<PassiveMods> | void): PassiveMods {
  if (!b) return a;
  return {
    coinScale: a.coinScale + (b.coinScale ?? 0),
    basePower: a.basePower + (b.basePower ?? 0),
    finalPower: a.finalPower + (b.finalPower ?? 0),
    dmg: a.dmg + (b.dmg ?? 0),
    offense: a.offense + (b.offense ?? 0),
    ...(a.atkDmgAdder || b.atkDmgAdder ? { atkDmgAdder: (a.atkDmgAdder ?? 0) + (b.atkDmgAdder ?? 0) } : {}),
  };
}

/** Sinner name aliases used by allyPresent (sinner id → names). */
export const SINNER_NAMES: Record<number, string[]> = {
  1: ["李箱", "Yi Sang", "YiSang"],
  2: ["浮士德", "Faust"],
  3: ["堂吉诃德", "Don Quixote", "DonQuixote"],
  4: ["良秀", "Ryoshu"],
  5: ["默尔索", "Meursault"],
  6: ["鸿璐", "Hong Lu", "HongLu"],
  7: ["希斯克利夫", "Heathcliff"],
  8: ["以实玛利", "Ishmael"],
  9: ["罗佳", "Rodion"],
  10: ["辛克莱", "Sinclair"],
  11: ["奥提斯", "Outis"],
  12: ["格里高尔", "Gregor"],
};

// ---------------------------------------------------------------- status interceptor helpers

/**
 * True if a status change comes from the current skill's own abilities. In the game BattleActionModel.BlockGivingBuff is only
 * consulted by SkillAbility/CoinAbility GiveBuff (not by passives or other units): scripts of this skill carry source
 * "<skillId>:<scriptName>", generic engine effects (effects.ts) carry no source.
 */
export function isOwnSkillSource(skillId: number | undefined, source: string | undefined): boolean {
  return source === undefined || (skillId !== undefined && source.startsWith(`${skillId}:`));
}

/**
 * BattleActionModel.BlockGivingBuff(keyword) for the rest of this skill use: gains of `keyword` (any side) given by this skill's own
 * scripts are dropped. `kinds` limits it to stack and/or turn gains. `onBlocked` receives each blocked change (e.g. to convert the
 * blocked amount into something else). No-op if the context has no interceptor support.
 */
export function blockSkillGains(
  c: PassiveCtx,
  keyword: string,
  opts: { kinds?: ("stack" | "turn")[]; key?: string; onBlocked?: (ch: SidedStatusChange) => void } = {},
): void {
  const skillId = c.skill?.id;
  const kinds = opts.kinds ?? ["stack", "turn"];
  for (const k of kinds) c.action?.shared.set(`blockGive:${keyword}:${k}`, true);
  c.interceptStatus?.(
    "skill",
    (ch) => {
      if (ch.buffId !== keyword || ch.delta <= 0 || !kinds.includes(ch.kind) || !isOwnSkillSource(skillId, ch.source)) return undefined;
      opts.onBlocked?.(ch);
      return 0;
    },
    { side: "both", key: opts.key ?? `blockGive:${keyword}:${kinds.join("+")}` },
  );
}

/**
 * GetGiveBuffStackAdder / GetGiveBuffTurnAdder: add `amount` to each matching status gain (only to dimensions the give already
 * contains, i.e. delta > 0). `when` filters (e.g. owner/target conditions at give time); `ownSkillOnly` limits it to this skill's
 * own scripts (source "<skillId>:..." or generic effects).
 */
export function giveAdder(
  c: PassiveCtx,
  scope: StatusHookScope,
  opts: {
    key: string;
    buffId: string;
    amount: number | ((ch: SidedStatusChange) => number);
    kinds?: ("stack" | "turn")[];
    side?: "actor" | "target" | "both";
    ownSkillOnly?: boolean;
    when?: (ch: SidedStatusChange) => boolean;
  },
): void {
  const skillId = c.skill?.id;
  const kinds = opts.kinds ?? ["stack", "turn"];
  c.interceptStatus?.(
    scope,
    (ch) => {
      if (ch.buffId !== opts.buffId || ch.delta <= 0 || !kinds.includes(ch.kind)) return undefined;
      if (opts.ownSkillOnly && !isOwnSkillSource(skillId, ch.source)) return undefined;
      if (opts.when && !opts.when(ch)) return undefined;
      const add = Math.trunc(typeof opts.amount === "function" ? opts.amount(ch) : opts.amount);
      return add ? Math.max(0, ch.delta + add) : undefined;
    },
    { side: opts.side ?? "both", key: opts.key },
  );
}

/** Whether blockSkillGains(keyword) is active for the current skill use (BattleActionModel.BlockGivingBuff query). */
export function skillGainBlocked(c: PassiveCtx, keyword: string, kind: "stack" | "turn" = "stack"): boolean {
  return c.action?.shared.get(`blockGive:${keyword}:${kind}`) === true;
}

/**
 * BattleActionModel.BlockLoseBuffByReactWithAction(keyword) for the rest of this skill use: the count loss caused by the status
 * reacting to this attack (source "react:<keyword>", e.g. Burst/Laceration/Sinking trigger on hit) is dropped.
 */
export function blockSkillReactLoss(c: PassiveCtx, keyword: string, opts: { side?: "actor" | "target" | "both"; key?: string } = {}): void {
  c.interceptStatus?.(
    "skill",
    (ch) => (ch.buffId === keyword && ch.kind === "turn" && ch.delta < 0 && ch.source === `react:${keyword}` ? 0 : undefined),
    { side: opts.side ?? "target", key: opts.key ?? `blockReactLoss:${keyword}` },
  );
}
