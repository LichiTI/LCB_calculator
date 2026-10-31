/**
 * Stage C deterministic event simulator.
 *
 * - Unopposed (no clash) attack resolution using formulas verified in GameAssembly.dll (formula.ts).
 * - DOT / resource bookkeeping via status.ts; skill / coin scripts via effects.ts (verified families only).
 * - Every unverified effect, unmodelled status or unsupported scenario element becomes a `gap`;
 *   `exact` is true only when no gap could affect the reported numbers.
 *
 * Event order per coin (BattleUnitModel.GiveAttackDamage @ 0x14B1660):
 *   coin toss -> (attacker Laceration) -> power update -> crit roll -> hit damage
 *   -> target OnTakeAttackDamage (Burst / Sinking) -> coin OnSucceedAttack effects -> extra damage.
 * Round end: Combustion triggers, then round-end count decay and next-round buff activation.
 */

import type { BattleCtx } from "./param-scripts";
import { PASSIVES, SINNER_NAMES, ZERO_MODS, addMods, abilityHandler, resistLevelOf, scriptHandler, type AbilityCtx, type PassiveCtx, type PassiveHandler, type PassiveMods, type ScriptCtx, type ScriptData, type StatusHookOpts, type StatusHookScope } from "./passives";

/** Target speed used when the scenario does not set one. */
export const DEFAULT_TARGET_SPEED = 3;
import type { NormalizedBuff, NormalizedIdentity, NormalizedSkill, SinAttribute, AtkType } from "../config/game-data";
import type { BaseSkillEntry, FollowUpEntry, Preset, SkillModifiers } from "../config/preset-types";
import {
  applyCoinToPower,
  calculateCoinAttackDamage,
  coinHeadsProbability,
  RULES_VERSION,
  type CoinDamageBreakdown,
} from "./formula";
import { DeterministicRng } from "./prng";
import { staticAttackWeight } from "./attack-weight";
import { baseEntryFor } from "../config/preset-factory";
import { createActionRecord, type MutableActionRecord } from "./action-record";
import { donActionAt, readTeammateSupport, type TeammateSupport } from "./teammate-support";
import { buffAbilityLogic, passiveLogic, scriptLogic } from "./logic-meta";
import { analyzeSkillBonusCap, type BonusTier, type SkillBonusCap } from "./bonus-tier";
import { matchesSkill, readExternalBuffs, SOURCE_LABEL, type ExternalBuff } from "../config/external-buffs";
import {
  StatusContainer,
  triggerBurstOnHit,
  triggerCombustionOnRoundEnd,
  triggerLacerationOnAttackCoinToss,
  triggerSinkingOnHit,
  type DotTriggerRecord,
  type StatusChangeRecord,
  type StatusInterceptOptions,
} from "./status";
import {
  classifyCoinScripts,
  evaluateCoinPreHitEffects,
  evaluateLiveSkillEffects,
  evaluateSkillStartEffects,
  executeCoinOnHitEffects,
  executeSkillEndEffects,
  getActiveCoinRerollLimit,
  checkBuffCondition,
  applyBuffData,
  type EffectContext,
  type EffectObservation,
} from "./effects";

export type CoinMode = "allHeads" | "allTails" | "monteCarlo";

export interface SimulationData {
  identities: NormalizedIdentity[];
  skills: Record<string, NormalizedSkill>;
  buffs: Record<string, NormalizedBuff>;
}

export interface SimulationOptions {
  coinMode?: CoinMode;
  /** Overrides preset.simulation.samples for monteCarlo. */
  samples?: number;
  /** Overrides preset.simulation.seed. */
  seed?: number;
}

/** Battle passives the simulator implements. */
export const MODELLED_PASSIVES = new Set<number>([1061701, 1061712]);

export type GapImpact = "damage" | "approx" | "untriggered" | "none";

export interface Gap {
  kind: "effect" | "passive" | "status" | "scenario" | "skill" | "extraDamage";
  id: string;
  message: string;
  where?: string;
  /** How much the gap matters for the reported damage (from extracted game logic). Default "damage". */
  impact?: GapImpact;
  /** Why it does not matter / what was assumed. */
  reason?: string;
  skillId?: number;
  coinIndex?: number;
}

export interface SimEvent {
  turn: number;
  entryId?: string;
  skillId?: number;
  kind: "useSkill" | "coin" | "extraDamage" | "dot" | "status" | "roundEnd" | "followUp" | "note";
  coinIndex?: number;
  isRerolled?: boolean;
  heads?: boolean;
  critical?: boolean;
  power?: number;
  coinScale?: number;
  offenseLevel?: number;
  defenseLevel?: number;
  damage?: number;
  floatDamage?: number;
  extraRatio?: number;
  breakdown?: CoinDamageBreakdown;
  dot?: DotTriggerRecord;
  status?: StatusChangeRecord;
  message?: string;
}

export interface EntryTotals {
  entryId: string;
  skillId: number | null;
  uses: number;
  direct: number;
  extra: number;
  dotHp: number;
  total: number;
  /** Opt-in (battle.countSubTargets): damage to sub-targets of this entry; not part of total. */
  subTarget?: number;
  /** Ally joint-attack damage triggered by this entry (see Totals.ally). */
  ally?: number;
}

export interface DotBreakdownRow {
  statusId: string;
  turn: number;
  triggers: number;
  hpDamage: number;
  spDamage: number;
  staggerShift: number;
}

export interface Totals {
  direct: number;
  extra: number;
  dotHp: number;
  dotSp: number;
  staggerShift: number;
  /** direct + extra + dotHp (HP actually removed from the target; capped by HP when limited). */
  total: number;
  /** HP damage the actor took from its own statuses (e.g. self Laceration). Not part of total. */
  selfHpDamage: number;
  /**
   * Opt-in multi-target model (battle.countSubTargets): damage dealt to sub-targets (each assumed identical to the main
   * target). Not part of total (= main target); all-target damage = total + subTarget. Absent when the option is off.
   */
  subTarget?: number;
  /**
   * Opt-in ally joint/supportive attacks (PassiveCtx.allyAttack, needs declared allies): damage dealt by allies. Part of total
   * only when battle.countAllyDamage is on. Absent when no ally attack happened.
   */
  ally?: number;
}

export interface DotBalanceRow {
  statusId: string;
  side: "target" | "actor";
  initialPotency: number;
  initialCount: number;
  potencyAdded: number;
  countAdded: number;
  countConsumed: number;
  netCount: number;
  finalPotency: number;
  finalCount: number;
}

export interface SimulationResult {
  rulesVersion: string;
  mode: Preset["simulation"]["mode"];
  coinMode: CoinMode;
  exact: boolean;
  /** exact = nothing unknown; approx = only stated assumptions; gaps = damage-relevant logic is missing. */
  quality: "exact" | "approx" | "gaps";
  gaps: Gap[];
  assumptions: string[];
  totals: Totals;
  perEntry: EntryTotals[];
  dotBreakdown: DotBreakdownRow[];
  dotBalance?: DotBalanceRow[];
  statusApplications: (StatusChangeRecord & { turn: number })[];
  remainingStatuses: { side: "actor" | "target"; id: string; potency: number; count: number }[];
  events: SimEvent[];
  monteCarlo?: MonteCarloStats;
  /** Skill replacements (变身/替换, BattleActionModel.ChangeSkill) that happened, per entry (first Monte Carlo sample). */
  skillReplacements?: SkillReplacementRow[];
}

export interface SkillReplacementRow {
  entryId: string;
  fromSkillId: number;
  toSkillId: number;
  reason: string;
  uses: number;
}

// ---------------------------------------------------------------- scenario helpers

const SIN_TO_RESIST_KEY: Record<SinAttribute, string | null> = {
  CRIMSON: "wrath", SCARLET: "lust", AMBER: "sloth", SHAMROCK: "gluttony",
  AZURE: "gloom", INDIGO: "pride", VIOLET: "envy", NEUTRAL: null,
};
const ATK_TO_RESIST_KEY: Record<AtkType, string> = { SLASH: "slash", PENETRATE: "pierce", HIT: "blunt" };
export const DEFAULT_IDENTITY_LEVEL = 65;

interface TargetScenario {
  hpMode: "unlimited" | "limited";
  hp: number | null;
  defenseLevel: number | null;
  hasSp: boolean;
  /** Target SP from preset target.initialSp (null when not given). */
  sp: number | null;
  speed: number | null;
  physical: Record<string, number>;
  sin: Record<string, number>;
  initialStatuses: { id: string; potency: number; count: number }[];
  shield: number;
  staggerPolicy: string;
  enemyActions: { turn: number; coinCount: number; takeHits?: number }[];
  /** Starting HP ratio of the target (0..1, default 1). */
  hpRatio: number;
  /** Max HP used to convert dealt damage into HP ratio (target.maxHp → target.hp → 1e6). */
  maxHp: number;
  /** When true the target HP ratio decreases with damage dealt; default false = ratio stays at hpRatio. */
  hpTracking: boolean;
  /** True when target.maxHp or target.hp was given (maxHp is then a real value, not the 1e6 fallback). */
  maxHpKnown: boolean;
  /** UNIT_KEYWORD / association names of the target (upper-cased), from scenario target.unitKeywords (default []). */
  unitKeywords: string[];
  /** Opt-in stagger model: target.staggerThresholdsPct (HP % thresholds, e.g. [70, 40]); effective only with hpTracking. */
  staggerThresholdsPct: number[];
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Opt-in enemy-action / clash model (scenario.duel). Absent or outcome "none" → null: no clashes (default, unchanged).
 * outcome "win": each attack skill on a clash turn wins its clash (OnWinDuel triggers, SP + spOnWin) then attacks with all coins.
 * outcome "lose": it loses (OnLoseDuel triggers), deals no damage, and the enemy's remaining coins hit the actor (OnTakeAttack).
 * turns: clash turns (default: turns with a scenario.enemyActions entry, or every turn when there is none).
 */
interface DuelCfg { outcome: "win" | "lose"; parryingCount: number; spOnWin: number; turns: number[] | null }

function readDuel(preset: Preset): DuelCfg | null {
  const d = ((preset.scenario ?? {}) as Record<string, unknown>).duel as Record<string, unknown> | string | undefined;
  const o = typeof d === "string" ? { outcome: d } : d ?? {};
  if (o.outcome !== "win" && o.outcome !== "lose") return null;
  return {
    outcome: o.outcome,
    parryingCount: Math.max(1, Math.trunc(num(o.parryingCount, 1))),
    spOnWin: num(o.spOnWin, 10),
    turns: Array.isArray(o.turns) ? o.turns.filter((t): t is number => typeof t === "number") : null,
  };
}

function parseStatusList(raw: unknown): { id: string; potency: number; count: number }[] {
  if (!Array.isArray(raw)) return [];
  const out: { id: string; potency: number; count: number }[] = [];
  for (const r of raw) {
    if (r && typeof r === "object") {
      const o = r as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id : typeof o.statusId === "string" ? o.statusId : null;
      if (id) out.push({ id, potency: Math.max(0, Math.trunc(num(o.potency, 0))), count: Math.max(0, Math.trunc(num(o.count, 0))) });
    }
  }
  return out;
}

function readTarget(preset: Preset): TargetScenario {
  const sc = (preset.scenario ?? {}) as Record<string, unknown>;
  const t = (sc.target ?? {}) as Record<string, unknown>;
  const phys = (t.physicalResistances ?? {}) as Record<string, unknown>;
  const sin = (t.sinResistances ?? {}) as Record<string, unknown>;
  const physical: Record<string, number> = {};
  for (const k of ["slash", "pierce", "blunt"]) physical[k] = num(phys[k], 1);
  const sinRes: Record<string, number> = {};
  for (const k of ["wrath", "lust", "sloth", "gluttony", "gloom", "pride", "envy"]) sinRes[k] = num(sin[k], 1);
  const enemyActions: { turn: number; coinCount: number; takeHits?: number }[] = [];
  if (Array.isArray(sc.enemyActions)) {
    for (const a of sc.enemyActions) {
      const o = (a ?? {}) as Record<string, unknown>;
      if (typeof o.turn === "number") enemyActions.push({ turn: o.turn, coinCount: Math.max(0, Math.trunc(num(o.coinCount, 0))), ...(typeof o.takeHits === "number" && o.takeHits > 0 ? { takeHits: Math.trunc(o.takeHits) } : {}) });
    }
  }
  return {
    hpMode: t.hpMode === "limited" ? "limited" : "unlimited",
    hp: typeof t.hp === "number" ? t.hp : null,
    defenseLevel: typeof t.defenseLevel === "number" ? t.defenseLevel : null,
    hasSp: t.hasSp === true,
    sp: typeof t.initialSp === "number" ? t.initialSp : null,
    speed: typeof t.speed === "number" ? t.speed : null,
    physical,
    sin: sinRes,
    initialStatuses: parseStatusList(t.initialStatuses),
    shield: num(t.shield, 0),
    staggerPolicy: typeof t.staggerPolicy === "string" ? t.staggerPolicy : "disabled",
    enemyActions,
    hpRatio: Math.min(1, Math.max(0, num(t.hpRatio, 1))),
    maxHp: Math.max(1, num(t.maxHp, typeof t.hp === "number" && t.hp > 0 ? t.hp : 1e6)),
    hpTracking: t.hpTracking === true,
    maxHpKnown: num(t.maxHp, 0) > 0 || (typeof t.hp === "number" && t.hp > 0),
    unitKeywords: Array.isArray(t.unitKeywords) ? t.unitKeywords.filter((k): k is string => typeof k === "string" && k.trim() !== "").map((k) => k.trim().toUpperCase()) : [],
    staggerThresholdsPct: Array.isArray(t.staggerThresholdsPct) ? t.staggerThresholdsPct.filter((v): v is number => typeof v === "number" && v > 0 && v < 100).sort((a, b) => b - a) : [],
  };
}

// ---------------------------------------------------------------- runtime state

interface RunState {
  rng: DeterministicRng;
  coinMode: CoinMode;
  actor: StatusContainer;
  target: StatusContainer;
  targetHpLeft: number | null;
  targetDead: boolean;
  /** HP damage dealt to the target so far (for target HP ratio tracking). */
  targetHpDealt?: number;
  totals: Totals;
  perEntry: Map<string, EntryTotals>;
  dotRows: Map<string, DotBreakdownRow>;
  statusApps: (StatusChangeRecord & { turn: number })[];
  events: SimEvent[];
  gaps: Map<string, Gap>;
  recordEvents: boolean;
  /** Tracks whether ChangeSkillOnBeforeDefenseOncePerListen1061704 has already consumed its 1061704->1061706 upgrade in the current Listen cycle. */
  listenCounterUsed?: boolean;
  /** Shared once-per-battle / per-skill counters for effect scripts. */
  onceFlags: Map<string, number>;
  /** Turn in which a ChangeSkillOnBeforeTurn* transformation already fired. */
  skillChangeTurn?: number;
  /** Per-passive persistent state. */
  passiveState: Map<number | string, Map<string, number>>;
  /** Tracks the last turn in which ReadyToListenHonglu was gained (max 1 stack per turn). */
  readyToListenTurn?: number;
  /** Teammate support model (e.g. Le Noir Brand Manager Don Quixote). */
  support?: TeammateSupport | null;
  /** Burst-triggered support grants already given this turn. */
  supportBurstGrants?: number;
  /** Per-action (current skill use) consumption record + shared scratch, exposed to scripts as ScriptCtx.action. */
  action?: MutableActionRecord;
  /** Current skill/coin context, used when a Vibration explosion dispatches onVibrationExplosion hooks. */
  abilityRun?: { r: ScriptRun | null; entry: EntryTotals | null };
  /** Attack weight of the skill being executed (opt-in multi-target model); null outside a skill. */
  atkWeight?: { base: number; add: number; set: number | null } | null;
  /** Skill replacements by ScriptHandler.beforeUse → c.replaceSkill (key entryId|from|to). */
  replacements?: Map<string, SkillReplacementRow>;
  /** Skill decided at round start (OnBeforeTurn) for the scheduled action about to execute; consumed by executeSkill. */
  preReplaced?: NormalizedSkill;
  /** Actor cut-in / follow-up skill uses queued by PassiveCtx.queueAction (run after the current skill). */
  pendingActions?: { skillId: number; label: string }[];
  /** queueAction per-turn counters (key|turn). */
  queuedActionCounts?: Map<string, number>;
  /** Opt-in stagger model: last turn (inclusive) the target stays staggered; threshold indices already crossed. */
  staggeredUntil?: number;
  staggerCrossed?: Set<number>;
  /** Set by dealHp when a stagger threshold is crossed; dispatched (onTargetStagger) after the current coin / dot. */
  staggerPending?: boolean;
  /** Opt-in stagger model config (set at run start only when target.hpTracking and staggerThresholdsPct are given). */
  staggerCfg?: { thresholdsPct: number[]; hpRatio: number; maxHp: number };
  /** Opt-in enemy-action model: SP gained during the run (clash wins, HealMpOnWinDuel…); added to the preset SP. */
  spDelta?: number;
  /** Opt-in enemy-action model: clash outcome of the skill being executed (null/undefined = no clash). */
  duel?: "win" | "lose" | null;
}

interface StaticCtx {
  data: SimulationData;
  preset: Preset;
  identity: NormalizedIdentity | null;
  level: number;
  sp: number;
  target: TargetScenario;
  disabled: Set<string>;
  followUps: FollowUpEntry[];
  /** Opt-in enemy-action model (scenario.duel); null = no clashes (default). */
  duel?: DuelCfg | null;
  externalBuffs: ExternalBuff[];
  tier: BonusTier;
  tierCaps: Map<number, SkillBonusCap>;
  battle: BattleCtx;
  passives: PassiveHandler[];
}

function tierCapFor(sc: StaticCtx, skill: NormalizedSkill): SkillBonusCap | null {
  if (sc.tier === "none") return null;
  let c = sc.tierCaps.get(skill.id);
  if (!c) {
    c = analyzeSkillBonusCap(skill);
    sc.tierCaps.set(skill.id, c);
  }
  return c;
}

function disabledFor(sc: StaticCtx, skillId: number): Set<string> {
  const skill = sc.data.skills[String(skillId)];
  const cap = skill ? tierCapFor(sc, skill) : null;
  if (!cap) return sc.disabled;
  const extra = sc.tier === "full" ? [...cap.powerScripts, ...cap.dmgScripts] : cap.powerScripts;
  if (!extra.length) return sc.disabled;
  return new Set([...sc.disabled, ...extra]);
}

function addGap(st: RunState, gap: Gap) {
  const key = `${gap.kind}:${gap.id}:${gap.where ?? ""}`;
  if (!st.gaps.has(key)) st.gaps.set(key, gap);
}

function pushEvent(st: RunState, ev: SimEvent) {
  if (st.recordEvents) st.events.push(ev);
}

function entryTotals(st: RunState, entryId: string, skillId: number | null): EntryTotals {
  let e = st.perEntry.get(entryId);
  if (!e) {
    e = { entryId, skillId, uses: 0, direct: 0, extra: 0, dotHp: 0, total: 0 };
    st.perEntry.set(entryId, e);
  }
  return e;
}

/** Apply HP loss to the target honoring limited HP / shield. Returns HP actually lost. */
/** Current skill attack weight (攻击容量); 1 outside a skill. */
function currentAttackWeight(st: RunState): number {
  const w = st.atkWeight;
  return w ? Math.max(1, Math.trunc(w.set ?? w.base + w.add)) : 1;
}

/** Units hit by the current skill = min(attack weight, alive enemies) (BattleActionModel.GetAliveTargetUnitModelList). */
function hitTargetCount(sc: StaticCtx, st: RunState): number {
  return Math.max(1, Math.min(currentAttackWeight(st), sc.battle.targetCount));
}

/**
 * Opt-in sub-target damage (battle.countSubTargets): `amountEach` dealt to each of `n` sub-targets, assumed identical to the
 * main target (same resists/statuses, HP not tracked). Recorded only in totals.subTarget / entry.subTarget.
 */
/** Declared allies given as identity ids (battle.allies), resolved to identity data; the actor itself is excluded. */
function declaredAllyIdentities(sc: StaticCtx): NormalizedIdentity[] {
  const out: NormalizedIdentity[] = [];
  for (const a of sc.battle.allies) {
    if (!/^\d{5}$/.test(a.trim())) continue;
    const id = sc.data.identities.find((i) => i.id === Number(a.trim()));
    if (id && id.id !== sc.identity?.id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Opt-in ally joint / supportive attack (CutInAction by a declared ally). The ally skill is resolved from its own skill data at
 * the actor's level: base power + coins (heads per coin mode; Monte Carlo rolls 50%), no ally passives/scripts/crit, target
 * resistances and current target-side combat modifiers apply. Damage → totals.ally; into total only with battle.countAllyDamage.
 */
function runAllyAttack(
  sc: StaticCtx,
  st: RunState,
  turn: number,
  entry: EntryTotals | null,
  o: { allyId: number; skillId: number; label?: string; key?: string; perTurn?: number; dmgMul?: number; chance?: number },
): number {
  const skill = sc.data.skills[String(o.skillId)];
  if (!skill || st.targetDead || !sc.battle.allies.length) return 0;
  const key = `ally:${o.key ?? `${o.allyId}:${o.skillId}`}|${turn}`;
  const used = st.onceFlags.get(key) ?? 0;
  if (used >= Math.max(1, o.perTurn ?? 1)) return 0;
  st.onceFlags.set(key, used + 1);
  const chance = Math.max(0, Math.min(1, o.chance ?? 1));
  if (chance <= 0 || (st.coinMode === "monteCarlo" && chance < 1 && !st.rng.prob(chance))) return 0;
  const scale = st.coinMode === "monteCarlo" ? 1 : chance;
  const atkType = skill.attrs.atkType as AtkType;
  if (!atkType || !(atkType in ATK_TO_RESIST_KEY)) return 0;
  const sinAttr = skill.attrs.attributeType;
  const sinKey = sinAttr ? SIN_TO_RESIST_KEY[sinAttr] : null;
  const atkResist = sc.target.physical[ATK_TO_RESIST_KEY[atkType]] ?? 1;
  const offense = Math.max(1, sc.level + num(skill.attrs.skillLevelCorrection, 0));
  let power = skill.basePower;
  let total = 0;
  const parts: number[] = [];
  for (const coin of skill.coins) {
    const heads = st.coinMode === "monteCarlo" ? st.rng.prob(0.5) : st.coinMode !== "allTails";
    power = applyCoinToPower(power, coin.operatorType, coin.scale, 0, heads).nextPower;
    const tm = st.target.evaluateCombatModifiers({ atkType, sinAttr, coinOperator: coin.operatorType });
    const b = calculateCoinAttackDamage({
      rolledPower: Math.max(0, power),
      atkResist,
      sinResist: (sinKey ? sc.target.sin[sinKey] ?? 1 : 1) + tm.sinResistAdder,
      offenseLevel: offense,
      defenseLevel: Math.max(1, (sc.target.defenseLevel ?? sc.level) + tm.defenseLevelAdder),
      isCritical: false,
      attackDmgMultiplier: o.dmgMul ?? 0,
      takeAttackDmgMultiplier: tm.takeAttackDmgMultiplier,
      attackDmgAdder: 0,
    });
    const d = Math.floor(b.resolvedDamage * scale);
    parts.push(d);
    total += d;
  }
  const sid = Math.trunc(o.allyId / 100) % 100;
  const name = `${o.label ?? ""}${SINNER_NAMES[sid]?.[0] ?? ""}#${o.allyId}`;
  let counted = 0;
  if (sc.battle.countAllyDamage) {
    counted = dealHp(st, total);
    st.totals.total += counted;
    if (entry) entry.total += counted;
  }
  st.totals.ally = (st.totals.ally ?? 0) + (sc.battle.countAllyDamage ? counted : total);
  if (entry) entry.ally = (entry.ally ?? 0) + (sc.battle.countAllyDamage ? counted : total);
  pushEvent(st, {
    turn, kind: "note", skillId: o.skillId, damage: sc.battle.countAllyDamage ? counted : total,
    message: `友方联合攻击:${name}（技能 ${o.skillId}）硬币 ${parts.join("+")} = ${total}${scale < 1 ? `（触发率 ${Math.round(scale * 100)}% 期望）` : ""}${sc.battle.countAllyDamage ? "，计入总伤" : "，未计入自身总伤"}`,
  });
  addGap(st, {
    kind: "scenario", id: "allyAttack", impact: "approx",
    message: "友方联合/援护攻击按队友技能基础数据结算",
    reason: "队友攻击：同等级、无队友被动/技能脚本/暴击，不触发目标状态；不影响自身伤害（除非开启“计入友方伤害”）",
  });
  return total;
}

/**
 * Dawn Office joint attack (PassiveAbility_DawnAdditionalAttack): the passive owner gives SystemAbility_PassiveCheckAttack1021601
 * to DAWN allies; when one ends an attack with a default skill (HasSkillAsDefaultSkillIncludeDefenseSkill) the owner cuts in its
 * additional attack. Here: actor is DAWN and a declared ally owns the passive → that ally attacks (once per turn, assumed).
 * Additional skill per owner = its hidden COUNTER skill in data (10216 → 1021607, 11216 → 1121607; GetAdditionalAttackSkillID
 * returns a field, value taken from data).
 */
const DAWN_JOINT_SKILL: Record<number, number> = { 10216: 1021607, 11216: 1121607 };
function dawnAllyJointAttack(sc: StaticCtx, st: RunState, turn: number, skill: NormalizedSkill, entry: EntryTotals | null): void {
  const me = sc.identity;
  if (!me || !sc.battle.allies.length || !(me.associations ?? []).includes("DAWN")) return;
  const isDefault = me.skillPool.some((p) => p.skillId === skill.id) || me.defenseSkillIds.includes(skill.id);
  if (!isDefault) return;
  const owner = declaredAllyIdentities(sc).find((a) => DAWN_JOINT_SKILL[a.id] != null);
  if (!owner) return;
  runAllyAttack(sc, st, turn, entry, { allyId: owner.id, skillId: DAWN_JOINT_SKILL[owner.id]!, key: "dawnJoint", label: "黎明事务所 " });
}

function addSubTargetDamage(st: RunState, entry: EntryTotals | null, amountEach: number, n: number): number {
  if (st.totals.subTarget == null || n <= 0 || amountEach <= 0) return 0;
  const d = Math.floor(amountEach) * n;
  st.totals.subTarget += d;
  if (entry) entry.subTarget = (entry.subTarget ?? 0) + d;
  return d;
}

function dealHp(st: RunState, amount: number): number {
  if (amount <= 0 || st.targetDead) return 0;
  if (st.targetHpLeft == null) {
    st.targetHpDealt = (st.targetHpDealt ?? 0) + amount;
    checkStagger(st);
    return amount;
  }
  const lost = Math.min(st.targetHpLeft, amount);
  st.targetHpLeft -= lost;
  st.targetHpDealt = (st.targetHpDealt ?? 0) + lost;
  if (st.targetHpLeft <= 0) st.targetDead = true;
  checkStagger(st);
  return lost;
}

/** Opt-in stagger model: mark the target staggered when its tracked HP ratio first drops to/below a threshold. */
function checkStagger(st: RunState): void {
  const cfg = st.staggerCfg;
  if (!cfg || st.targetDead) return;
  const ratio = Math.max(0, cfg.hpRatio - (st.targetHpDealt ?? 0) / cfg.maxHp) * 100;
  const crossed = (st.staggerCrossed ??= new Set());
  cfg.thresholdsPct.forEach((pct, i) => {
    if (crossed.has(i) || ratio > pct) return;
    crossed.add(i);
    st.staggerPending = true;
  });
}

function recordDot(st: RunState, rec: DotTriggerRecord, entry: EntryTotals | null) {
  const hpLost = dealHp(st, rec.hpDamage);
  st.totals.dotHp += hpLost;
  st.totals.dotSp += rec.spDamage;
  st.totals.staggerShift += rec.staggerShift;
  st.totals.total += hpLost;
  if (entry) {
    entry.dotHp += hpLost;
    entry.total += hpLost;
  }
  if (st.support?.enabled && rec.trigger === "vibrationExplosion" && (st.supportBurstGrants ?? 0) < st.support.burstCapPerTurn) {
    st.supportBurstGrants = (st.supportBurstGrants ?? 0) + 1;
    supplyCharge(st, rec.turn, st.support.burstCharge, "黑派经理被动1031504:带钉目标被震颤引爆");
  }
  const key = `${rec.statusId}#${rec.turn}`;
  const row = st.dotRows.get(key) ?? { statusId: rec.statusId, turn: rec.turn, triggers: 0, hpDamage: 0, spDamage: 0, staggerShift: 0 };
  row.triggers += 1;
  row.hpDamage += hpLost;
  row.spDamage += rec.spDamage;
  row.staggerShift += rec.staggerShift;
  st.dotRows.set(key, row);
  pushEvent(st, { turn: rec.turn, kind: "dot", dot: { ...rec, hpDamage: hpLost }, message: rec.sourceDesc });
}

function supplyCharge(st: RunState, turn: number, amount: number, reason: string) {
  if (amount <= 0) return;
  const { before, after } = st.actor.apply("Charge", 0, amount, 0);
  const ch: StatusChangeRecord = { statusId: st.actor.resolveId("Charge"), target: "actor", before, after, reason };
  st.statusApps.push({ ...ch, turn });
  pushEvent(st, { turn, kind: "status", status: ch });
}

/** Turn-start supplies from the teammate (Don acts before the main identity). */
function applySupportTurnStart(st: RunState, turn: number) {
  const sup = st.support;
  st.supportBurstGrants = 0;
  if (!sup?.enabled) return;
  const act = donActionAt(sup, turn);
  if (turn === 1) supplyCharge(st, turn, sup.entryCharge, "黑派经理被动1031502:首次登场给黑派友方充能");
  if (act === "s1") supplyCharge(st, turn, sup.s1Charge, "黑派经理一技能1031501:给充能最低的黑派友方充能");
  if (act === "s3" && sup.s3AttackUp > 0) {
    const { before, after } = st.actor.apply("AttackUp", sup.s3AttackUp, 0, 0);
    const ch: StatusChangeRecord = { statusId: "AttackUp", target: "actor", before, after, reason: "黑派经理三技能1031503:战斗开始给最快黑派友方攻击等级提升" };
    st.statusApps.push({ ...ch, turn });
    pushEvent(st, { turn, kind: "status", status: ch });
  }
  const own = Math.min(sup.burstCapPerTurn, sup.donBursts[act] ?? 0);
  for (let i = 0; i < own; i++) {
    st.supportBurstGrants = (st.supportBurstGrants ?? 0) + 1;
    supplyCharge(st, turn, sup.burstCharge, `黑派经理被动1031504:自身${act.toUpperCase()}引爆带钉目标`);
  }
  pushEvent(st, { turn, kind: "note", message: `黑派经理本回合行动：${act.toUpperCase()}` });
}

function flushEffectCtx(st: RunState, ctx: EffectContext, entry: EntryTotals | null) {
  for (const ch of ctx.statusChanges) {
    st.statusApps.push({ ...ch, turn: ctx.turn });
    pushEvent(st, { turn: ctx.turn, kind: "status", status: ch, skillId: ctx.skillId, coinIndex: ctx.coinIndex });
  }
  ctx.statusChanges.length = 0;
  for (const d of ctx.dotTriggers) recordDot(st, d, entry);
  ctx.dotTriggers.length = 0;
}

function noteObservations(st: RunState, obs: EffectObservation[], entryId: string) {
  for (const o of obs) {
    if (o.status !== "unverified") continue;
    const info = scriptLogic(o.scriptName, o.scope);
    addGap(st, {
      kind: "effect",
      id: o.scriptName,
        where: `${entryId} / 技能 ${o.skillId}${o.coinIndex != null ? ` / 硬币 ${o.coinIndex + 1}` : ""}`,
        message: o.note ?? "未验证效果",
      impact: info?.impact ?? "damage",
      reason: info?.reason,
      skillId: o.skillId,
      coinIndex: o.coinIndex,
    });
  }
}

function rollHeads(st: RunState, p: number): boolean {
  if (st.coinMode === "allHeads") return true;
  if (st.coinMode === "allTails") return false;
  return st.rng.prob(p);
}

function makeEffectCtx(sc: StaticCtx, st: RunState, turn: number, skillId: number): EffectContext {
  return {
    turn,
    skillId,
    actorStatuses: st.actor,
    targetStatuses: st.target,
    targetHasSp: sc.target.hasSp,
    targetGloomResist: sc.target.sin.gloom ?? 1,
    disabledEffectIds: disabledFor(sc, skillId),
    statusChanges: [],
    dotTriggers: [],
    onceFlags: st.onceFlags,
    battle: sc.battle,
  };
}

// ---------------------------------------------------------------- battle passives

function passiveSkillInfo(skill: NormalizedSkill): PassiveCtx["skill"] {
  return {
    id: skill.id,
    slot: (skill as { slot?: string | null }).slot ?? null,
    sin: skill.attrs.attributeType,
    atkType: skill.attrs.atkType,
    defType: skill.attrs.defType,
    coinCount: skill.coins.length,
    basePower: skill.basePower,
  };
}

function makePassiveCtx(sc: StaticCtx, st: RunState, turn: number, h: { id: number | string }, extra: Partial<PassiveCtx>, entry: EntryTotals | null): PassiveCtx {
  let state = st.passiveState.get(h.id);
  if (!state) st.passiveState.set(h.id, (state = new Map()));
  const record = (statusId: string, side: "actor" | "target", before: { potency: number; count: number }, after: { potency: number; count: number }) => {
    const ch: StatusChangeRecord = { statusId, target: side, before, after, reason: `被动${h.id}` };
    st.statusApps.push({ ...ch, turn });
    pushEvent(st, { turn, kind: "status", status: ch });
  };
  const allies = sc.battle.allies.map((a) => a.toLowerCase());
  return {
    turn,
    identityId: sc.identity?.id ?? 0,
    actorSp: curSp(sc, st),
    targetHasSp: sc.target.hasSp,
    actor: st.actor,
    target: st.target,
    battle: sc.battle,
    state,
    action: st.action,
    coins: coinEditor(st),
    targetSp: sc.target.hasSp && sc.target.sp != null ? sc.target.sp : undefined,
    skillScripts: extra.skill ? skillScriptNames(sc, extra.skill.id) : undefined,
    ...extra,
    give(side, keyword, potency, count, activeRound = 0) {
      const c = side === "actor" ? st.actor : st.target;
      const { before, after } = c.apply(keyword, potency, count, activeRound, String(h.id));
      record(keyword, side, before, after);
    },
    gain(keyword, amount) {
      const r = st.actor.gainLimited(keyword, amount);
      if (r.after.potency !== r.before.potency) record(keyword, "actor", r.before, r.after);
    },
    consume(side, keyword, count) {
      const cont = side === "actor" ? st.actor : st.target;
      if (count <= 0 || !cont.get(keyword)) return;
      const { before, after } = cont.consumeCount(keyword, count, true, String(h.id));
      record(cont.resolveId(keyword), side, before, after);
    },
    lose(side, keyword, amount) {
      const r = (side === "actor" ? st.actor : st.target).losePotency(keyword, amount, String(h.id));
      if (r) record(keyword, side, r.before, r.after);
    },
    extraDamage(amount, desc, opts) {
      let amt = amount;
      let tag = "";
      if (opts && (opts.sin || opts.atkType)) {
        const r = extraDamageResist(sc, st, opts.sin, opts.atkType);
        // BattleUnitModel.TakeHpDamageAppliedAttributeResist: Util.Round(value × attribute resist)
        amt = Math.round(amount * r);
        tag = `（耐性×${+r.toFixed(3)}：${Math.floor(amount)}→${Math.max(0, amt)}）`;
      }
      const lost = dealHp(st, Math.max(0, Math.floor(amt)));
      st.totals.extra += lost;
      st.totals.total += lost;
      if (entry) {
        entry.extra += lost;
        entry.total += lost;
      }
      pushEvent(st, { turn, kind: "extraDamage", damage: lost, message: `[被动${h.id}] ${desc}${tag}` });
      if (opts?.allTargets && amt > 0) {
        const n = hitTargetCount(sc, st) - 1;
        const d = addSubTargetDamage(st, entry, amt, n);
        if (d) pushEvent(st, { turn, kind: "note", message: `[被动${h.id}] ${desc}：副目标 ${n} 名 ×${Math.floor(amt)} = ${d}（计入副目标伤害）` });
      }
    },
    note(msg) {
      pushEvent(st, { turn, kind: "note", message: `[被动${h.id}] ${msg}` });
    },
    allyPresent(...keys) {
      for (const k of keys) {
        const kl = k.toLowerCase();
        if (allies.includes(kl)) return true;
        // sinner names map to identity ids of that sinner (id / 1000 % 100 → sinner number for 1xxyy ids)
        for (const [sid, names] of Object.entries(SINNER_NAMES)) {
          if (!names.some((n) => n.toLowerCase() === kl)) continue;
          if (allies.some((a) => names.some((n) => n.toLowerCase() === a) || (/^1\d{4}$/.test(a) && Math.trunc(Number(a) / 100) % 100 === Number(sid)))) return true;
        }
      }
      return false;
    },
    targetHpRatio: () => targetHpRatioOf(sc, st),
    targetLostHpRatio: () => 1 - targetHpRatioOf(sc, st),
    selfHpRatio: () => 1 - sc.battle.lostHpPct / 100,
    targetMaxHp: () => (sc.target.maxHpKnown ? sc.target.maxHp : null),
    selfMaxHp: () => (sc.identity?.hp ? Math.floor(sc.identity.hp.base + sc.identity.hp.perLevel * sc.level) : 0),
    queueAction(skillId, opts) {
      if (!sc.data.skills[String(skillId)] || st.targetDead) return false;
      const key = `${opts?.key ?? `${h.id}:${skillId}`}|${turn}`;
      const counts = (st.queuedActionCounts ??= new Map());
      const n = counts.get(key) ?? 0;
      if (n >= Math.max(1, opts?.perTurn ?? 1)) return false;
      counts.set(key, n + 1);
      (st.pendingActions ??= []).push({ skillId, label: opts?.label ?? String(skillId) });
      pushEvent(st, { turn, kind: "note", message: `[${h.id}] 追加行动：${opts?.label ?? skillId}（技能 ${skillId}）` });
      return true;
    },
    targetStaggered: () => st.staggeredUntil != null && turn <= st.staggeredUntil,
    duelResult: () => st.duel ?? null,
    parryingCount: st.duel ? sc.duel?.parryingCount ?? 1 : 0,
    interceptStatus(scope, fn, opts) {
      registerStatusHook(st, scope, opts, (side, cont, o) => cont.addStatusInterceptor((ch) => fn({ ...ch, side }), o));
    },
    onStatusChange(scope, fn, opts) {
      registerStatusHook(st, scope, opts, (side, cont, o) => cont.addStatusObserver((ev) => fn({ ...ev, side }), o));
    },
    targetResist: (o) => extraDamageResist(sc, st, o.sin, o.atkType),
    targetResistLevel: (o) => resistLevelOf(extraDamageResist(sc, st, o.sin, o.atkType)),
    targetHasUnitKeyword: (k) => (sc.target.unitKeywords ?? []).includes(k.trim().toUpperCase()),
    actorHasUnitKeyword: (k) => {
      const ku = k.trim().toUpperCase();
      const id = sc.identity;
      return Boolean(id && [...(id.unitKeywords ?? []), ...(id.associations ?? [])].some((x) => x.toUpperCase() === ku));
    },
    attackWeight: () => currentAttackWeight(st),
    targetCount: () => sc.battle.targetCount,
    hitTargetCount: () => hitTargetCount(sc, st),
    addAttackWeight: (n) => {
      if (st.atkWeight && Number.isFinite(n)) st.atkWeight.add += Math.trunc(n);
    },
    setAttackWeight: (n) => {
      if (st.atkWeight && Number.isFinite(n)) st.atkWeight.set = Math.max(1, Math.trunc(n));
    },
    allyIdentities: () => declaredAllyIdentities(sc),
    allyAttack: (o) => runAllyAttack(sc, st, turn, entry, o),
  };
}

/** Shared registration for PassiveCtx.interceptStatus / onStatusChange (see framework.ts). */
function registerStatusHook(
  st: RunState,
  scope: StatusHookScope,
  opts: StatusHookOpts | undefined,
  add: (side: "actor" | "target", cont: StatusContainer, o: StatusInterceptOptions) => void,
): void {
  const sides: ("actor" | "target")[] = !opts?.side || opts.side === "both" ? ["actor", "target"] : [opts.side];
  for (const side of sides) {
    const cont = side === "actor" ? st.actor : st.target;
    const o: StatusInterceptOptions = { key: opts?.key ? `${opts.key}@${side}` : undefined, order: opts?.order };
    if (typeof scope === "object") {
      const holder = (scope.on ?? side) === "actor" ? st.actor : st.target;
      const id = scope.whileStatus;
      o.scope = "persistent";
      o.alive = () => holder.get(id) !== undefined;
    } else o.scope = scope;
    add(side, cont, o);
  }
}

/** Target current HP ratio: fixed at scenario target.hpRatio unless target.hpTracking (then minus dealt / maxHp, clamped ≥ 0). */
function targetHpRatioOf(sc: StaticCtx, st: RunState): number {
  const t = sc.target;
  if (!t.hpTracking) return t.hpRatio;
  return Math.min(1, Math.max(0, t.hpRatio - (st.targetHpDealt ?? 0) / t.maxHp));
}

type PassiveHook = "onBattleStart" | "onTurnStart" | "onCoinHit" | "onSkillEnd" | "onRoundEnd" | "onTargetStagger" | "onWinDuel" | "onLoseDuel" | "onTakeAttack";

/** Current actor SP: preset SP + SP gained in the run (opt-in clash model), clamped to [-45, 45]. */
function curSp(sc: StaticCtx, st: RunState): number {
  return Math.max(-45, Math.min(45, sc.sp + (st.spDelta ?? 0)));
}

/** Data-driven clash scripts on the skill (skill scope + every coin), BuffAbility/PassiveAbility/handler OnWinDuel / OnLoseDuel. */
function runDuel(sc: StaticCtx, st: RunState, turn: number, entryId: string, skill: NormalizedSkill, entry: EntryTotals): void {
  const cfg = sc.duel;
  if (!cfg || (cfg.turns ? !cfg.turns.includes(turn) : sc.target.enemyActions.length > 0 && !sc.target.enemyActions.some((a) => a.turn === turn))) return;
  const win = cfg.outcome === "win";
  st.duel = cfg.outcome;
  pushEvent(st, { turn, entryId, skillId: skill.id, kind: "note", message: `[敌方行动] 拼点${win ? "胜利" : "失败"}（假设，拼点次数 ${cfg.parryingCount}）` });
  const ctx = makeEffectCtx(sc, st, turn, skill.id);
  const all = [...(skill.abilityScripts ?? []), ...skill.coins.flatMap((c) => c.abilityScriptList ?? [])];
  for (const s of all) {
    if (sc.disabled.has(s.scriptName)) continue;
    const n = s.scriptName;
    if ((win && n === "GiveBuffOnWinDuel") || (!win && n === "GiveBuffOnLoseDuel")) applyBuffData(ctx, s, win ? "拼点胜利" : "拼点失败");
    else if (win && n === "LoseBuffOnWinDuel" && s.buffData?.buffKeyword) {
      const self = (s.buffData.target ?? "Target") === "Self";
      const r = (self ? st.actor : st.target).losePotency(s.buffData.buffKeyword, s.buffData.stack ?? 0, `${skill.id}:${n}`);
      if (r) ctx.statusChanges.push({ statusId: s.buffData.buffKeyword, target: self ? "actor" : "target", ...r, reason: `拼点胜利:${n}` });
    } else if (win && /^HealMpOnWinDuelSelf(\d+)$/.test(n)) st.spDelta = (st.spDelta ?? 0) + Number(/(\d+)$/.exec(n)![1]);
  }
  flushEffectCtx(st, ctx, entry);
  if (win) {
    // Clash win SP gain (assumed scenario.duel.spOnWin, default 10).
    st.spDelta = (st.spDelta ?? 0) + cfg.spOnWin;
    pushEvent(st, { turn, entryId, skillId: skill.id, kind: "note", message: `[敌方行动] 拼点胜利：理智 +${cfg.spOnWin} → ${curSp(sc, st)}` });
  }
  const hook = win ? "onWinDuel" : "onLoseDuel";
  runPassiveHook(sc, st, turn, hook, { skill: passiveSkillInfo(skill) }, entry);
  runScriptHook(sc, st, turn, hook, { skill }, entry);
  runAbilityHook(sc, st, turn, hook, { skill }, entry);
  if (!win) {
    const hits = sc.target.enemyActions.find((a) => a.turn === turn)?.coinCount || 1;
    takeEnemyHits(sc, st, turn, hits, entry, skill);
    pushEvent(st, { turn, entryId, skillId: skill.id, kind: "note", message: "[敌方行动] 拼点失败：本技能硬币全部被摧毁，不造成伤害" });
  }
}

/** Opt-in enemy-action model: the actor is hit by `hits` enemy attack coins (OnTakeAttack on passives and actor statuses). */
function takeEnemyHits(sc: StaticCtx, st: RunState, turn: number, hits: number, entry: EntryTotals | null, skill?: NormalizedSkill): void {
  for (let k = 0; k < hits; k++) {
    pushEvent(st, { turn, kind: "note", message: `[敌方行动] 自身受到第 ${k + 1} 次攻击` });
    runPassiveHook(sc, st, turn, "onTakeAttack", { ...(skill ? { skill: passiveSkillInfo(skill) } : {}), lastHitDamage: 0 }, entry);
    for (const { h, c } of abilityCtxs(sc, st, turn, skill ? { skill } : null, entry)) if (c.side === "actor") h.onTakeAttack?.(c);
  }
}

/** Opt-in stagger model: a threshold was crossed → target staggered this turn and the next; fire onTargetStagger. */
function dispatchStagger(sc: StaticCtx, st: RunState, turn: number, entry: EntryTotals | null): void {
  if (!st.staggerPending) return;
  st.staggerPending = false;
  st.staggeredUntil = turn + 1;
  pushEvent(st, { turn, kind: "note", message: "目标体力越过混乱阈值：进入混乱（至下回合结束，物理耐性视为×2.0）" });
  runPassiveHook(sc, st, turn, "onTargetStagger", {}, entry);
}

/** Target resistance multiplier for PassiveCtx.extraDamage opts (sin: scenario + AttributeResistAdderByStack; physical: scenario). */
function extraDamageResist(sc: StaticCtx, st: RunState, sin: SinAttribute | undefined, atkType: AtkType | undefined): number {
  let r = 1;
  const sinKey = sin ? SIN_TO_RESIST_KEY[sin] : null;
  if (sin && sinKey) r *= (sc.target.sin[sinKey] ?? 1) + st.target.evaluateCombatModifiers({ sinAttr: sin }).sinResistAdder;
  if (atkType) r *= sc.target.physical[ATK_TO_RESIST_KEY[atkType]] ?? 1;
  return Math.max(0, r);
}

function runPassiveHook(sc: StaticCtx, st: RunState, turn: number, hook: PassiveHook, extra: Partial<PassiveCtx>, entry: EntryTotals | null): void {
  for (const h of sc.passives) {
    const fn = h[hook];
    if (fn) fn.call(h, makePassiveCtx(sc, st, turn, h, extra, entry));
  }
}

function runPassiveMods(sc: StaticCtx, st: RunState, turn: number, hook: "skillMods" | "coinMods", extra: Partial<PassiveCtx>, entry: EntryTotals | null): PassiveMods {
  let m = ZERO_MODS;
  for (const h of sc.passives) {
    const fn = h[hook];
    if (fn) m = addMods(m, fn.call(h, makePassiveCtx(sc, st, turn, h, extra, entry)));
  }
  return m;
}

// ---------------------------------------------------------------- translated skill/coin scripts and status abilities

/** Start a fresh per-action record and observe active spends on both sides (BattleActionModel.UsedBuffStack/Turn). */
function beginActionRecord(st: RunState): void {
  const rec = st.action ?? (st.action = createActionRecord());
  rec.reset();
  st.actor.consumeListener = (id, s, t) => rec.add("actor", id, s, t);
  st.target.consumeListener = (id, s, t) => rec.add("target", id, s, t);
}

/** Stop observing spends (the record keeps its values until the next skill use starts). */
function endActionRecord(st: RunState): void {
  st.actor.consumeListener = null;
  st.target.consumeListener = null;
}

interface ScriptRun {
  skill: NormalizedSkill;
  coinIndex?: number;
  isHeads?: boolean;
  isCritical?: boolean;
  isRerolled?: boolean;
  lastHitDamage?: number;
}

function scriptEntries(skill: NormalizedSkill, coinIndex: number | undefined, includeAllCoins = false) {
  const out: { s: ScriptData; scope: "skill" | "coin"; ownerCoinIndex?: number }[] = [];
  for (const s of skill.abilityScripts ?? []) out.push({ s: s as unknown as ScriptData, scope: "skill" });
  skill.coins.forEach((c, i) => {
    if (!includeAllCoins && i !== coinIndex) return;
    for (const s of c.abilityScriptList ?? []) out.push({ s: s as unknown as ScriptData, scope: "coin", ownerCoinIndex: i });
  });
  return out;
}

function makeScriptCtx(sc: StaticCtx, st: RunState, turn: number, e: { s: ScriptData; scope: "skill" | "coin"; ownerCoinIndex?: number }, r: ScriptRun, entry: EntryTotals | null): ScriptCtx {
  const base = makePassiveCtx(sc, st, turn, { id: `${r.skill.id}:${e.s.scriptName}` }, {
    skill: passiveSkillInfo(r.skill), coinIndex: r.coinIndex, isHeads: r.isHeads, isCritical: r.isCritical, isRerolled: r.isRerolled, lastHitDamage: r.lastHitDamage,
  }, entry);
  const action = st.action ?? (st.action = createActionRecord());
  const srcCoin = e.ownerCoinIndex ?? r.coinIndex;
  const affectNext = (kind: "coinScale" | "finalPower", n: number) => {
    if (srcCoin == null || !n) return;
    let m = action.shared.get(NEXT_COIN_KEY) as Map<string, { coin: number; coinScale: number; finalPower: number }> | undefined;
    if (!m) action.shared.set(NEXT_COIN_KEY, (m = new Map()));
    const k = `${srcCoin}|${e.s.scriptName}`;
    const cur = m.get(k) ?? { coin: srcCoin + 1, coinScale: 0, finalPower: 0 };
    cur[kind] = n;
    m.set(k, cur);
  };
  return Object.assign(base, {
    script: e.s, scope: e.scope, ownerCoinIndex: e.ownerCoinIndex, skillData: r.skill, action,
    isSuperCoin: r.coinIndex != null ? isSuperCoinObj(r.skill.coins[r.coinIndex]) : undefined,
    isAddedCoin: r.coinIndex != null ? isAddedCoinObj(r.skill.coins[r.coinIndex]) : undefined,
    nextCoin: { addPower: (n: number) => affectNext("coinScale", n), addFinalPower: (n: number) => affectNext("finalPower", n) },
    cancelCoin: (reason: string, opts?: { rest?: boolean }) => {
      const why = reason || e.s.scriptName;
      action.shared.set(CANCEL_COIN_KEY, why);
      if (opts?.rest) action.shared.set(CANCEL_REST_KEY, why);
    },
  });
}

const NEXT_COIN_KEY = "__engine:nextCoin";
const CANCEL_COIN_KEY = "__engine:cancelCoin";
/** Set by cancelCoin(reason, { rest: true }): every later coin of the same skill use is cancelled too (SkillModel.DisableCoin). */
const CANCEL_REST_KEY = "__engine:cancelRest";

/** AffectNextCoin modifiers targeting coin `i` of the current skill use. */
function nextCoinMods(st: RunState, i: number): { coinScale: number; finalPower: number } {
  const m = st.action?.shared.get(NEXT_COIN_KEY) as Map<string, { coin: number; coinScale: number; finalPower: number }> | undefined;
  const out = { coinScale: 0, finalPower: 0 };
  if (m) for (const v of m.values()) if (v.coin === i) { out.coinScale += v.coinScale; out.finalPower += v.finalPower; }
  return out;
}

/** OnStartCoin: run `beforeCoin` hooks of skill-scope scripts and the coin's own scripts; returns the cancel reason, if any. */
function coinCancelReason(sc: StaticCtx, st: RunState, turn: number, r: ScriptRun, entry: EntryTotals | null): string | null {
  const action = st.action ?? (st.action = createActionRecord());
  const rest = action.shared.get(CANCEL_REST_KEY) as string | undefined;
  if (rest) return `后续硬币已取消（${rest}）`;
  action.shared.delete(CANCEL_COIN_KEY);
  for (const e of scriptEntries(r.skill, r.coinIndex)) {
    if (sc.disabled.has(e.s.scriptName)) continue;
    const h = scriptHandler(e.s.scriptName);
    if (h?.beforeCoin) h.beforeCoin(makeScriptCtx(sc, st, turn, e, r, entry));
  }
  const reason = action.shared.get(CANCEL_COIN_KEY) as string | undefined;
  action.shared.delete(CANCEL_COIN_KEY);
  return reason ?? null;
}

/** Skill-scope hooks run for every coin; coin-scope hooks only for the carrying coin. */
function runScriptMods(sc: StaticCtx, st: RunState, turn: number, hook: "skillMods" | "coinMods", r: ScriptRun, entry: EntryTotals | null): PassiveMods {
  let m = ZERO_MODS;
  for (const e of scriptEntries(r.skill, r.coinIndex)) {
    if (sc.disabled.has(e.s.scriptName)) continue;
    const h = scriptHandler(e.s.scriptName);
    const fn = h?.[hook];
    if (fn) m = addMods(m, fn.call(h, makeScriptCtx(sc, st, turn, e, r, entry)));
  }
  return m;
}

function runScriptHook(sc: StaticCtx, st: RunState, turn: number, hook: "onCoinHit" | "onSkillEnd" | "onWinDuel" | "onLoseDuel", r: ScriptRun, entry: EntryTotals | null): void {
  // onSkillEnd runs for skill-scope scripts and for the scripts of every coin of the skill.
  for (const e of scriptEntries(r.skill, r.coinIndex, hook !== "onCoinHit")) {
    if (sc.disabled.has(e.s.scriptName)) continue;
    const h = scriptHandler(e.s.scriptName);
    const fn = h?.[hook];
    if (fn) fn.call(h, makeScriptCtx(sc, st, turn, e, r, entry));
  }
}

/**
 * Crit chance parts contributed by translated handlers for the coin about to be rolled (see framework CritChanceMod):
 * passives + skill-scope scripts + the coin's scripts + status abilities on both sides. r.isCritical is unset here.
 */
function critChanceParts(sc: StaticCtx, st: RunState, turn: number, r: ScriptRun, entry: EntryTotals | null): { unit: number; mul: number; add: number } {
  const out = { unit: 0, mul: 0, add: 0 };
  const acc = (m: { unit?: number; mul?: number; add?: number } | void) => {
    if (!m) return;
    out.unit += Number.isFinite(m.unit) ? m.unit! : 0;
    out.mul += Number.isFinite(m.mul) ? m.mul! : 0;
    out.add += Number.isFinite(m.add) ? m.add! : 0;
  };
  for (const h of sc.passives) {
    if (h.critChance) acc(h.critChance(makePassiveCtx(sc, st, turn, h, { skill: passiveSkillInfo(r.skill), coinIndex: r.coinIndex, isHeads: r.isHeads, isRerolled: r.isRerolled }, entry)));
  }
  for (const e of scriptEntries(r.skill, r.coinIndex)) {
    if (sc.disabled.has(e.s.scriptName)) continue;
    const h = scriptHandler(e.s.scriptName);
    if (h?.critChance) acc(h.critChance(makeScriptCtx(sc, st, turn, e, r, entry)));
  }
  for (const { h, c } of abilityCtxs(sc, st, turn, r, entry)) if (h.critChance) acc(h.critChance(c));
  return out;
}

function scriptRerolls(sc: StaticCtx, st: RunState, turn: number, r: ScriptRun, entry: EntryTotals | null): number {
  let n = 0;
  for (const e of scriptEntries(r.skill, r.coinIndex)) {
    if (e.scope !== "coin") continue;
    const h = scriptHandler(e.s.scriptName);
    if (h?.rerolls) n = Math.max(n, h.rerolls(makeScriptCtx(sc, st, turn, e, r, entry)));
  }
  return n;
}

function abilityCtxs(sc: StaticCtx, st: RunState, turn: number, r: ScriptRun | null, entry: EntryTotals | null) {
  const out: { h: NonNullable<ReturnType<typeof abilityHandler>>; c: AbilityCtx }[] = [];
  for (const [side, cont] of [["actor", st.actor], ["target", st.target]] as const) {
    for (const inst of cont.allActive()) {
      const def = sc.data.buffs[inst.id];
      for (const item of (def?.list ?? []) as { ability: string; value?: number; buffData?: ScriptData["buffData"] }[]) {
        const h = abilityHandler(item.ability);
        if (!h) continue;
        const base = makePassiveCtx(sc, st, turn, { id: `${side}:${inst.id}:${item.ability}` }, r ? {
          skill: passiveSkillInfo(r.skill), coinIndex: r.coinIndex, isHeads: r.isHeads, isCritical: r.isCritical, isRerolled: r.isRerolled, lastHitDamage: r.lastHitDamage,
        } : {}, entry);
        out.push({ h, c: Object.assign(base, { side, status: { id: inst.id, potency: inst.potency, count: inst.count }, ability: item, action: st.action }) });
      }
    }
  }
  return out;
}

function runAbilityMods(sc: StaticCtx, st: RunState, turn: number, r: ScriptRun, entry: EntryTotals | null): PassiveMods {
  let m = ZERO_MODS;
  for (const { h, c } of abilityCtxs(sc, st, turn, r, entry)) if (h.coinMods) m = addMods(m, h.coinMods(c));
  return m;
}

function runAbilityHook(
  sc: StaticCtx,
  st: RunState,
  turn: number,
  hook: "onCoinHit" | "onRoundEnd" | "onRoundStart" | "onBattleStart" | "onSkillStart" | "onWinDuel" | "onLoseDuel",
  r: ScriptRun | null,
  entry: EntryTotals | null,
): void {
  for (const { h, c } of abilityCtxs(sc, st, turn, r, entry)) h[hook]?.(c);
}

/**
 * Tremor Burst observer: dispatch onVibrationExplosion to abilities of statuses on the exploded unit and to battle passives
 * (BuffAbility/PassiveAbility.OnVibrationExplosion).
 */
function dispatchVibrationExplosion(sc: StaticCtx, st: RunState, side: "actor" | "target", rec: DotTriggerRecord): void {
  const cont = side === "actor" ? st.actor : st.target;
  const ev = { side, statusId: cont.resolveId("Vibration"), potency: rec.potencyAtTrigger, count: rec.countBefore, turn: rec.turn };
  const run = st.abilityRun;
  for (const { h, c } of abilityCtxs(sc, st, rec.turn, run?.r ?? null, run?.entry ?? null)) {
    if (c.side === side) h.onVibrationExplosion?.(c, ev);
  }
  const extra: Partial<PassiveCtx> = run?.r ? { skill: passiveSkillInfo(run.r.skill), coinIndex: run.r.coinIndex } : {};
  for (const h of sc.passives) h.onVibrationExplosion?.(makePassiveCtx(sc, st, rec.turn, h, extra, run?.entry ?? null), ev);
}

// ---------------------------------------------------------------- coin list edits at skill start
// SkillAbility.CopyCoinModelAndAddToListByIndex → SkillModel.AddCoinByAbility appends `new CoinModel(original)` (same operator,
// scale, coin abilities rebuilt from ClassInfo) to the coin list; OnAddCoinByAbility may then attach extra coin scripts
// (e.g. BattleUtil.AddSuperCoinScriptToCoin). SuperCoin = CoinAbility_OverwriteToSuperCoin (grey colour, grade 2): it only
// changes clash destruction (CoinModel.IsDestroyableCoin); CoinModel.Roll has no SuperCoin bias.
type CoinEditor = import("./passives").CoinEditor;
type SkillCoin = NormalizedSkill["coins"][number];
const SUPER_COINS = new WeakSet<object>();
const ADDED_COINS = new WeakSet<object>();
const COIN_EDIT_KEY = "__engine:coinEdit";
interface CoinEditState {
  base: readonly SkillCoin[];
  adds: { copyOf: number; power?: number; scripts?: ScriptData[]; super?: boolean }[];
  supers: (number | "all" | "last")[];
}

function openCoinEdit(st: RunState, skill: NormalizedSkill): void {
  const action = st.action ?? (st.action = createActionRecord());
  action.shared.set(COIN_EDIT_KEY, { base: skill.coins, adds: [], supers: [] } satisfies CoinEditState);
}

/** PassiveCtx.coins: defined only while a coin-edit window is open. */
function coinEditor(st: RunState): CoinEditor | undefined {
  const s = st.action?.shared.get(COIN_EDIT_KEY) as CoinEditState | undefined;
  if (!s) return undefined;
  return {
    get count() {
      return s.base.length + s.adds.length;
    },
    add(o) {
      if (!Number.isInteger(o.copyOf) || o.copyOf < 0 || o.copyOf >= s.base.length) return false;
      s.adds.push(o);
      return true;
    },
    makeSuper(index) {
      s.supers.push(index);
    },
  };
}

/** Close the window; returns the skill with the final coin list (a shallow copy when anything changed). */
function closeCoinEdit(st: RunState, turn: number, skill: NormalizedSkill, entryId: string): NormalizedSkill {
  const s = st.action?.shared.get(COIN_EDIT_KEY) as CoinEditState | undefined;
  st.action?.shared.delete(COIN_EDIT_KEY);
  if (!s || (!s.adds.length && !s.supers.length)) return skill;
  const coins: SkillCoin[] = [...skill.coins];
  for (const a of s.adds) {
    const src = s.base[a.copyOf]!;
    const nc: SkillCoin = {
      ...src,
      ...(a.power != null ? { scale: a.power } : {}),
      abilityScriptList: [...(src.abilityScriptList ?? []), ...((a.scripts ?? []) as unknown as NonNullable<SkillCoin["abilityScriptList"]>)],
    };
    ADDED_COINS.add(nc);
    if (a.super) SUPER_COINS.add(nc);
    coins.push(nc);
    pushEvent(st, { turn, entryId, skillId: skill.id, kind: "note", coinIndex: coins.length - 1, message: `[追加硬币] 复制第${a.copyOf + 1}枚硬币作为第${coins.length}枚${a.super ? "（SuperCoin）" : ""}` });
  }
  const marked: number[] = [];
  for (const sel of s.supers) {
    const idxs = sel === "all" ? coins.map((_, i) => i) : [sel === "last" ? coins.length - 1 : sel];
    for (const i of idxs) {
      const c = coins[i];
      if (!c || SUPER_COINS.has(c)) continue;
      const nc = ADDED_COINS.has(c) ? c : { ...c };
      SUPER_COINS.add(nc);
      coins[i] = nc;
      marked.push(i + 1);
    }
  }
  if (marked.length) pushEvent(st, { turn, entryId, skillId: skill.id, kind: "note", message: `[SuperCoin] 第${marked.join("、")}枚硬币转化为不可摧毁硬币（仅影响拼点）` });
  return { ...skill, coins };
}

const isSuperCoinObj = (c: unknown): boolean => c != null && SUPER_COINS.has(c as object);
const isAddedCoinObj = (c: unknown): boolean => c != null && ADDED_COINS.has(c as object);

/** ScriptHandler.onSkillStart for skill-scope scripts and every coin's scripts (coin-edit window open). */
function runScriptSkillStart(sc: StaticCtx, st: RunState, turn: number, r: ScriptRun, entry: EntryTotals | null): void {
  for (const e of scriptEntries(r.skill, undefined, true)) {
    if (sc.disabled.has(e.s.scriptName)) continue;
    const h = scriptHandler(e.s.scriptName);
    if (h?.onSkillStart) h.onSkillStart(makeScriptCtx(sc, st, turn, e, r, entry));
  }
}

/** Script names of a skill (skill-level + all coins), memoised per skill object (PassiveCtx.skillScripts). */
const SKILL_SCRIPT_NAMES = new WeakMap<object, readonly string[]>();
function skillScriptNames(sc: StaticCtx, skillId: number): readonly string[] {
  const sk = sc.data.skills[String(skillId)];
  if (!sk) return [];
  let v = SKILL_SCRIPT_NAMES.get(sk);
  if (!v) {
    v = [...(sk.abilityScripts ?? []).map((s) => s.scriptName), ...sk.coins.flatMap((c) => (c.abilityScriptList ?? []).map((s) => s.scriptName))];
    SKILL_SCRIPT_NAMES.set(sk, v);
  }
  return v;
}

function manualArray(mods: SkillModifiers, key: "coinPowerDeltas" | "coinDamageBonusPcts", i: number): number {
  const arr = mods[key];
  return Array.isArray(arr) ? num(arr[i], 0) : 0;
}

/** Execute one skill use. Returns resolved hit damages of landed coins (for afterSkill extra damage). */
/**
 * BattleActionModel.ChangeSkill before use: run skill-scope ScriptHandler.beforeUse of the skill about to be used; a handler may
 * call c.replaceSkill(id, reason) and the replacement skill (its coins/scripts) is executed instead. Chains up to 3, no repeats.
 * Runs at the very start of executeSkill so every later stage (start effects, coins, next-coin/cancel-coin) sees the new skill.
 */
function applySkillReplacement(sc: StaticCtx, st: RunState, turn: number, entryId: string, skill: NormalizedSkill, entry: EntryTotals | null): NormalizedSkill {
  const seen = new Set<number>([skill.id]);
  for (let depth = 0; depth < 3; depth++) {
    let next: { skill: NormalizedSkill; reason: string } | null = null;
    for (const s of skill.abilityScripts ?? []) {
      if (sc.disabled.has(s.scriptName)) continue;
      const h = scriptHandler(s.scriptName);
      if (!h?.beforeUse) continue;
      const c = makeScriptCtx(sc, st, turn, { s: s as unknown as ScriptData, scope: "skill" }, { skill }, entry);
      c.replaceSkill = (id: number, reason?: string) => {
        const t = sc.data.skills[String(id)];
        if (!t) {
          addGap(st, { kind: "skill", id: String(id), where: entryId, message: `替换技能 ${id} 不在数据中（${s.scriptName}）` });
          return false;
        }
        if (seen.has(t.id) || next) return false;
        next = { skill: t, reason: reason || s.scriptName };
        return true;
      };
      h.beforeUse.call(h, c);
      if (next) break;
    }
    // Passive-level skill changes (PassiveAbility.OnChangeSkillBeforeCompleteCommand), after the skill's own scripts.
    if (!next) {
      for (const p of sc.passives) {
        if (!p.beforeUse) continue;
        const pc = makePassiveCtx(sc, st, turn, p, { skill: passiveSkillInfo(skill) }, entry) as PassiveCtx & { replaceSkill(id: number, reason?: string): boolean };
        pc.replaceSkill = (id: number, reason?: string) => {
          const t = sc.data.skills[String(id)];
          if (!t) {
            addGap(st, { kind: "skill", id: String(id), where: entryId, message: `替换技能 ${id} 不在数据中（被动 ${p.id}）` });
            return false;
          }
          if (seen.has(t.id) || next) return false;
          next = { skill: t, reason: reason || `被动${p.id}` };
          return true;
        };
        p.beforeUse.call(p, pc);
        if (next) break;
      }
    }
    if (!next) break;
    const { skill: to, reason } = next as { skill: NormalizedSkill; reason: string };
    pushEvent(st, { turn, entryId, skillId: to.id, kind: "note", message: `[变身/替换] ${skill.id} → ${to.id}：${reason}` });
    const m = st.replacements ?? (st.replacements = new Map());
    const k = `${entryId}|${skill.id}|${to.id}`;
    const row = m.get(k);
    if (row) row.uses += 1;
    else m.set(k, { entryId, fromSkillId: skill.id, toSkillId: to.id, reason, uses: 1 });
    seen.add(to.id);
    skill = to;
  }
  return skill;
}

function executeSkill(
  sc: StaticCtx,
  st: RunState,
  turn: number,
  entryId: string,
  mods: SkillModifiers,
  skill: NormalizedSkill,
  chainDepth: number,
): void {
  const entry = entryTotals(st, entryId, skill.id);
  entry.uses += 1;
  if (st.targetDead) {
    pushEvent(st, { turn, entryId, skillId: skill.id, kind: "note", message: "目标已死亡，动作取消" });
    return;
  }
  skill = st.preReplaced ?? applySkillReplacement(sc, st, turn, entryId, skill, entry);
  st.preReplaced = undefined;

  const atkType = skill.attrs.atkType;
  const defType = skill.attrs.defType;
  if (!atkType || !(atkType in ATK_TO_RESIST_KEY) || (defType && defType !== "ATTACK" && defType !== "COUNTER")) {
    const defScripts = skill.abilityScripts ?? [];
    const defCtx = makeEffectCtx(sc, st, turn, skill.id);
    evaluateSkillStartEffects(defScripts, defCtx);
    executeSkillEndEffects(defScripts, defCtx);
    flushEffectCtx(st, defCtx, entry);
    // Defense-skill script handlers (e.g. ReloadOnBS1051404 / TacticalReloadBulletLamentOnBattleStart): use + end hooks.
    beginActionRecord(st);
    runScriptMods(sc, st, turn, "skillMods", { skill }, entry);
    runScriptHook(sc, st, turn, "onSkillEnd", { skill }, entry);
    endActionRecord(st);
    pushEvent(st, { turn, entryId, skillId: skill.id, kind: "useSkill", power: skill.basePower, message: `守备技能（${defType ?? "DEFENSE"}）：已触发使用时/回合末状态效果，不造成直接伤害` });
    return;
  }
  // ChangeSkillOnBeforeDefenseOncePerListen1061704: while TimeToListenHonglu is active, 1061704 upgrades to 1061706 once per Listen window.
  for (const s of skill.abilityScripts ?? []) {
    if (s.scriptName === "ChangeSkillOnBeforeDefenseOncePerListen1061704" && s.value && st.actor.get("TimeToListenHonglu") && !st.listenCounterUsed) {
      const upgraded = sc.data.skills[String(s.value)];
      if (upgraded) {
        st.listenCounterUsed = true;
        pushEvent(st, { turn, entryId, skillId: upgraded.id, kind: "note", message: `[听讲时间] 触发反击升级：${skill.id} → ${upgraded.id}` });
        skill = upgraded;
      }
      break;
    }
  }
  // ChangeSkillOnBeforeTurn*: resource threshold transforms the skill (once per turn; 10216 variant blocked by CaseOverheating).
  for (const s of skill.abilityScripts ?? []) {
    if (!/^ChangeSkillOnBeforeTurn/.test(s.scriptName) || !s.value || st.skillChangeTurn === turn) continue;
    if (/\d{5}$/.test(s.scriptName) && st.actor.get("CaseOverheating")) continue;
    if (!checkBuffCondition(makeEffectCtx(sc, st, turn, skill.id), s.buffData)) continue;
    const upgraded = sc.data.skills[String(s.value)];
    if (!upgraded) continue;
    st.skillChangeTurn = turn;
        pushEvent(st, { turn, entryId, skillId: upgraded.id, kind: "note", message: `[资源变身] ${skill.id} → ${upgraded.id}` });
    skill = upgraded;
    break;
  }
  if (defType === "COUNTER") {
    addGap(st, { kind: "skill", id: String(skill.id), where: entryId, message: "反击技能按主动攻击结算，实际需敌方攻击触发" });
  }

  const skillScripts = skill.abilityScripts ?? [];
  beginActionRecord(st);
  noteApproxScripts(sc, st, skill, entryId);
  st.atkWeight = { base: Math.max(1, Number(skill.attrs.targetNum ?? 1) || 1), add: 0, set: null };
  // Ability onSkillStart: before the skill's on-use (WhenUse) statuses are applied.
  openCoinEdit(st, skill);
  runAbilityHook(sc, st, turn, "onSkillStart", { skill }, entry);
  runScriptSkillStart(sc, st, turn, { skill }, entry);
  skill = closeCoinEdit(st, turn, skill, entryId);
  const ctx = makeEffectCtx(sc, st, turn, skill.id);
  const start = evaluateSkillStartEffects(skillScripts, ctx);
  noteObservations(st, start.observations, entryId);
  skill.coins.forEach((c, i) => noteObservations(st, classifyCoinScripts(c.abilityScriptList ?? [], skill.id, i), entryId));
  flushEffectCtx(st, ctx, entry);

  const basePower = mods.basePower ?? skill.basePower;
  const skillStartBuffs = st.actor.evaluateCombatModifiers({ atkType: atkType as AtkType, sinAttr: skill.attrs.attributeType, actorSp: sc.sp });
  const ext = sc.externalBuffs.filter((b) => matchesSkill(b, skill.attrs.attributeType, atkType, skill.slot, skill));
  const extSum = (k: "basePower" | "coinPower" | "finalPower" | "offenseLevel" | "dmgPct" | "takeDmgPct") => ext.reduce((s, b) => s + b[k], 0);
  const cap = tierCapFor(sc, skill);
  const capCoin = cap ? cap.coinPower : 0;
  const capFinal = cap ? cap.finalPower : 0;
  const capDmg = cap && sc.tier === "full" ? cap.dmg : 0;
  openCoinEdit(st, skill);
  // Attack weight: static TagetNumAdder* estimate on the statuses after on-use effects; skillMods may add/overwrite.
  if (st.atkWeight) st.atkWeight.base = staticAttackWeight(skill, st.actor).weight;
  const pmods = addMods(runPassiveMods(sc, st, turn, "skillMods", { skill: passiveSkillInfo(skill) }, entry), runScriptMods(sc, st, turn, "skillMods", { skill }, entry));
  skill = closeCoinEdit(st, turn, skill, entryId);
  let power = Math.max(0, basePower + skillStartBuffs.basePowerAdder + start.basePowerAdder + pmods.basePower + extSum("basePower"));
  pushEvent(st, {
    turn, entryId, skillId: skill.id, kind: "useSkill", power,
    message: `基础威力 ${basePower}${mods.basePower != null ? "（手动覆盖）" : ""}${skillStartBuffs.basePowerAdder ? ` +${skillStartBuffs.basePowerAdder}(状态)` : ""}${extSum("basePower") ? ` +${extSum("basePower")}(外部)` : ""}；使用时快照：最终威力 +${start.skillPowerResultAdder}，硬币威力 +${start.coinScaleAdder}，伤害 +${(start.attackDmgMultiplier * 100).toFixed(0)}%${cap && (capCoin || capFinal || capDmg) ? `；吃满假设：硬币 +${capCoin} 最终 +${capFinal}${capDmg ? ` 伤害 +${Math.round(capDmg * 100)}%` : ""}` : ""}`,
  });

  const baseOffense = sc.level + num(skill.attrs.skillLevelCorrection, 0);
  const baseDefense = sc.target.defenseLevel ?? sc.level;
  dispatchStagger(sc, st, turn, entry);
  // Opt-in stagger model: a staggered target's physical resistances are Fatal (×2.0).
  const atkResist = st.staggeredUntil != null && turn <= st.staggeredUntil ? 2 : sc.target.physical[ATK_TO_RESIST_KEY[atkType as AtkType]] ?? 1;
  const sinAttr = skill.attrs.attributeType;
  const sinKey = sinAttr ? SIN_TO_RESIST_KEY[sinAttr] : null;
  const baseSinResist = sinKey ? sc.target.sin[sinKey] ?? 1 : 1;
  runDuel(sc, st, turn, entryId, skill, entry);
  const headsP = coinHeadsProbability(curSp(sc, st));
  const extraCfg = mods.totalExtraDamage;
  const landed: { resolved: number; lost: number }[] = [];
  let skillRerolledOnce = false;

  const forceCritByFullTier = (sc.preset.actor as Record<string, unknown>).forceFullCrit === true;

  for (let i = 0; i < skill.coins.length && st.duel !== "lose"; i++) {
    if (st.targetDead) break;
    const coin = skill.coins[i]!;
    let pass = 0;
    let maxRerolls = 0;
    while (pass <= maxRerolls && !st.targetDead) {
      const isRerolled = pass > 0;
      pass++;

    // OnStartCoin: a coin-scope script may cancel the coin before the toss (e.g. UseBullet[necessary] without ammo).
    const cancelReason = coinCancelReason(sc, st, turn, { skill, coinIndex: i, isRerolled }, entry);
    if (cancelReason) {
      pushEvent(st, { turn, entryId, skillId: skill.id, kind: "note", coinIndex: i, message: `硬币 ${i + 1}${isRerolled ? "（重投）" : ""}未发动：${cancelReason}` });
      break;
    }

    // Self Laceration triggers when the actor tosses an offensive coin.
    const selfBleed = triggerLacerationOnAttackCoinToss(st.actor, turn, `${entryId} 硬币 ${i + 1} 投掷（自身流血）`);
    if (selfBleed) {
      st.totals.selfHpDamage += selfBleed.hpDamage;
      pushEvent(st, { turn, entryId, skillId: skill.id, kind: "dot", coinIndex: i, dot: selfBleed, message: "自身流血（不计入对目标伤害）" });
    }

    const heads = rollHeads(st, headsP);
    const actorBuffMods = st.actor.evaluateCombatModifiers({
      atkType: atkType as AtkType,
      sinAttr,
      coinOperator: coin.operatorType,
      actorSp: curSp(sc, st),
    });
    const hasTimeToListen =
      Boolean(st.actor.get("TimeToListenHonglu")) || (sc.preset.simulation.mode === "staticCycle" && sc.tier === "full");
    const targetBuffMods = st.target.evaluateCombatModifiers({
      atkType: atkType as AtkType,
      sinAttr,
      coinOperator: coin.operatorType,
      actorHasTimeToListen: hasTimeToListen,
    });

    // Consume LoseStackOnAfterCheckCoin (e.g. Paralysis) after checking this coin.
    for (const ch of st.actor.onAfterCheckCoin("actor")) {
      st.statusApps.push({ ...ch, turn });
      pushEvent(st, { turn, entryId, skillId: skill.id, kind: "status", coinIndex: i, status: ch });
    }

    // Critical (BattleActionModel.GetCriticalChance @0x147D560): (Breath potency × 5% [BuffAbility_Breath.GetCriticalChanceAdder
    // @0x10CA290] + handler unit/take adders) × (1 + Σ skill multipliers) + Σ skill/coin adders; consumes 1 Breath count on crit.
    // Fixed heads/tails modes: crit only when the chance reaches 100% (forceFullCrit = always); Monte Carlo rolls the chance.
    const breathP = st.actor.getPotency("Breath");
    const ccp = forceCritByFullTier ? null : critChanceParts(sc, st, turn, { skill, coinIndex: i, isHeads: heads, isRerolled }, entry);
    const critChance = forceCritByFullTier ? 1 : Math.max(0, Math.min(1, (breathP * 0.05 + ccp!.unit) * (1 + ccp!.mul) + ccp!.add));
    let critical = false;
    if (critChance > 0) {
      critical = st.coinMode === "monteCarlo" ? st.rng.prob(critChance) : critChance >= 1;
      if (st.coinMode !== "monteCarlo" && critChance < 1) {
        addGap(st, { kind: "scenario", id: "criticalChance", message: "固定正反面模式下暴击率 <100% 时按未暴击计算；请使用 Monte Carlo 查看期望", impact: "approx", reason: "呼吸法暴击率按未暴击计；Monte Carlo 模式给出期望" });
      }
      if (critical && st.actor.get("Breath")) {
        const { before, after } = st.actor.consumeCount("Breath", 1, true, "react:Breath");
        const ch: StatusChangeRecord = { statusId: "Breath", target: "actor", before, after, reason: "criticalConsume" };
        st.statusApps.push({ ...ch, turn });
        pushEvent(st, { turn, entryId, skillId: skill.id, kind: "status", coinIndex: i, status: ch });
      }
    }

    const coinCtx: EffectContext = { ...makeEffectCtx(sc, st, turn, skill.id), coinIndex: i, isHeads: heads, isCritical: critical, isRerolled };
    const live = evaluateLiveSkillEffects(skillScripts, coinCtx);
    const coinRun: ScriptRun = { skill, coinIndex: i, isHeads: heads, isCritical: critical, isRerolled };
    st.abilityRun = { r: coinRun, entry };
    const cmods = addMods(addMods(runPassiveMods(sc, st, turn, "coinMods", { skill: passiveSkillInfo(skill), coinIndex: i, isHeads: heads, isCritical: critical, isRerolled }, entry), runScriptMods(sc, st, turn, "coinMods", coinRun, entry)), runAbilityMods(sc, st, turn, coinRun, entry));
    const manualDelta = mods.totalCoinPowerDelta + manualArray(mods, "coinPowerDeltas", i);
    const nextMods = nextCoinMods(st, i);
    const rawScaleForRoll = actorBuffMods.coinScaleOverride != null ? actorBuffMods.coinScaleOverride : coin.scale;
    const totalScaleAdder =
      actorBuffMods.coinScaleOverride != null
        ? 0
        : start.coinScaleAdder + live.coinScaleAdder + actorBuffMods.coinScaleAdder + manualDelta + capCoin + extSum("coinPower") + pmods.coinScale + cmods.coinScale + nextMods.coinScale;
    const step = applyCoinToPower(power, coin.operatorType, rawScaleForRoll, totalScaleAdder, heads);
    if (coin.operatorType !== "ADD" && coin.operatorType !== "SUB") {
      addGap(st, { kind: "skill", id: `${skill.id}#coin${i + 1}`, where: entryId, message: `未知硬币运算符 ${coin.operatorType}` });
    }
    power = step.nextPower;
    // Per-coin base power (coinMods.basePower, e.g. SkillPowerAdderViaBuffCheck): the game re-reads GetSkillPowerAdder for every
    // coin, so it is added to this coin's rolled power only (not carried into the running power).
    const rolledPower = Math.max(0, power + cmods.basePower + start.skillPowerResultAdder + live.skillPowerResultAdder + actorBuffMods.skillPowerResultAdder + capFinal + extSum("finalPower") + pmods.finalPower + cmods.finalPower + nextMods.finalPower);

    const pre = evaluateCoinPreHitEffects(coin.abilityScriptList ?? [], coinCtx);

    const manualPct = (mods.totalDamageBonusPct + manualArray(mods, "coinDamageBonusPcts", i)) / 100;
    const offense = Math.max(1, baseOffense + actorBuffMods.offenseLevelAdder + extSum("offenseLevel") + pmods.offense + cmods.offense);
    const defense = Math.max(1, baseDefense + targetBuffMods.defenseLevelAdder);
    const sinResist = baseSinResist + targetBuffMods.sinResistAdder;
    const capCritDmg = critical && cap && sc.tier === "full" ? (cap.critDmg + (cap.coinCritDmg[i] ?? 0)) : 0;
    const dmgArgs: Parameters<typeof calculateCoinAttackDamage>[0] = {
      rolledPower,
      atkResist,
      sinResist,
      offenseLevel: offense,
      defenseLevel: defense,
      isCritical: critical,
      attackDmgMultiplier:
        start.attackDmgMultiplier + live.attackDmgMultiplier + pre.coinDmgMultiplier + actorBuffMods.attackDmgMultiplier + manualPct +
        st.actor.specificSkillDmgBonus(skill.id) + pmods.dmg + cmods.dmg +
        capDmg + (cap && sc.tier === "full" ? cap.coinDmg[i] ?? 0 : 0) + capCritDmg + extSum("dmgPct") / 100,
      takeAttackDmgMultiplier: targetBuffMods.takeAttackDmgMultiplier + extSum("takeDmgPct") / 100,
      attackDmgAdder: (pmods.atkDmgAdder ?? 0) + (cmods.atkDmgAdder ?? 0),
    };
    const breakdown = calculateCoinAttackDamage(dmgArgs);
    const lost = dealHp(st, breakdown.resolvedDamage);
    st.totals.direct += lost;
    st.totals.total += lost;
    entry.direct += lost;
    entry.total += lost;
    landed.push({ resolved: breakdown.resolvedDamage, lost });
    // Opt-in sub-targets: the coin hits min(weight, enemies) units; each sub-target is assumed identical to the main target.
    // CanDealOnlyMainTarget* / CanDealOnlyOneByMainTargetPriority coins skip sub-targets; CoinAbility_AttackDmgMultiplierToSubTarget
    // (target ≠ main target → +jsonValue) applies only to them.
    if (st.totals.subTarget != null) {
      const coinNames = (coin.abilityScriptList ?? []).map((s) => s.scriptName);
      const subN = coinNames.some((n) => /^CanDealOnly(?:MainTarget|OneByMainTargetPriority)/.test(n)) ? 0 : hitTargetCount(sc, st) - 1;
      if (subN > 0) {
        const subAdd = (coin.abilityScriptList ?? []).filter((s) => s.scriptName === "AttackDmgMultiplierToSubTarget").reduce((a, s) => a + (s.value ?? 0), 0);
        const each = subAdd ? calculateCoinAttackDamage({ ...dmgArgs, attackDmgMultiplier: dmgArgs.attackDmgMultiplier + subAdd }).resolvedDamage : breakdown.resolvedDamage;
        const d = addSubTargetDamage(st, entry, each, subN);
        if (d) pushEvent(st, { turn, entryId, skillId: skill.id, kind: "note", coinIndex: i, message: `副目标 ${subN} 名 ×${each} = ${d}${subAdd ? `（对副目标伤害 ${subAdd > 0 ? "+" : ""}${Math.round(subAdd * 100)}%）` : ""}` });
      }
    }
    pushEvent(st, {
      turn, entryId, skillId: skill.id, kind: "coin", coinIndex: i, isRerolled, heads, critical,
      power: rolledPower, coinScale: step.effectiveScale, offenseLevel: offense, defenseLevel: defense,
      damage: lost, breakdown,
    });

    // Target OnTakeAttackDamage: Burst, then Sinking (existing statuses before this coin's effects).
    const where = `${entryId} 硬币 ${i + 1} 命中`;
    const burst = triggerBurstOnHit(st.target, turn, where);
    if (burst) recordDot(st, burst, entry);
    const sink = triggerSinkingOnHit(st.target, turn, sc.target.hasSp, sc.target.sin.gloom ?? 1, where);
    if (sink) recordDot(st, sink, entry);

    // Coin OnSucceedAttack effects.
    coinCtx.lastCoinResolvedDamage = breakdown.resolvedDamage;
    coinCtx.lastCoinFloatDamage = breakdown.rawFloatDamage;
    executeCoinOnHitEffects(coin.abilityScriptList ?? [], skillScripts, coinCtx);
    // GetStackOnSucceedAttack*: resource buffs gaining stacks per landed hit (round-limited).
    for (const a of st.actor.activeAbilities()) {
      if (!/^GetStackOnSucceedAttack/.test(a.ability) || !a.buffData?.buffKeyword) continue;
      const r = st.actor.gainLimited(a.buffData.buffKeyword, a.buffData.stack ?? 0);
      if (r.after.potency !== r.before.potency) coinCtx.statusChanges.push({ statusId: st.actor.resolveId(a.buffData.buffKeyword), target: "actor", before: r.before, after: r.after, reason: a.ability });
    }
    flushEffectCtx(st, coinCtx, entry);
    runPassiveHook(sc, st, turn, "onCoinHit", { skill: passiveSkillInfo(skill), coinIndex: i, isHeads: heads, isCritical: critical, isRerolled, lastHitDamage: lost }, entry);
    runScriptHook(sc, st, turn, "onCoinHit", { ...coinRun, lastHitDamage: lost }, entry);
    runAbilityHook(sc, st, turn, "onCoinHit", { ...coinRun, lastHitDamage: lost }, entry);
    dispatchStagger(sc, st, turn, entry);
    if (coinCtx.bonusHitDamages?.length) {
      for (const b of coinCtx.bonusHitDamages) {
        const bLost = dealHp(st, b.amount);
        st.totals.extra += bLost;
        st.totals.total += bLost;
        entry.extra += bLost;
        entry.total += bLost;
        pushEvent(st, {
          turn,
          entryId,
          skillId: skill.id,
          kind: "extraDamage",
          coinIndex: i,
          damage: bLost,
          floatDamage: b.floatAmount,
          extraRatio: b.ratio,
          message: b.desc,
        });
      }
    }

    // Manual per-coin DOT overlay (after game effects of this coin).
    const dots = Array.isArray(mods.coinDots) ? mods.coinDots[i] : undefined;
    if (dots) {
      for (const [id, amt] of Object.entries(dots)) {
        if (!amt || (amt.potency <= 0 && amt.count <= 0)) continue;
        const { before, after } = st.target.apply(id, amt.potency, amt.count, 0);
        const ch: StatusChangeRecord = { statusId: id, target: "target", before, after, reason: `manualCoinDot#${i + 1}` };
        st.statusApps.push({ ...ch, turn });
        pushEvent(st, { turn, entryId, skillId: skill.id, kind: "status", coinIndex: i, status: ch });
      }
    }

    // Manual extra damage per landed coin.
    if (extraCfg.trigger === "afterEachLandedCoin") {
      applyExtraDamage(st, turn, entryId, skill.id, extraCfg, extraCfg.reference === "actualHpLost" ? lost : breakdown.resolvedDamage, entry, i);
    }

    const forceReroll = sc.preset.simulation.mode === "staticCycle" && sc.tier === "full";
    if (!isRerolled && !skillRerolledOnce) {
      const lastCoinReroll = (coin.abilityScriptList ?? []).some((s) => /^RerollLastCoin\d*$/.test(s.scriptName));
      const limit = Math.max(getActiveCoinRerollLimit(coin.abilityScriptList ?? [], coinCtx, forceReroll), lastCoinReroll ? start.lastCoinRerolls : 0, scriptRerolls(sc, st, turn, coinRun, entry));
      if (limit > 0) {
        maxRerolls = limit;
        skillRerolledOnce = true;
        pushEvent(st, { turn, entryId, skillId: skill.id, kind: "note", coinIndex: i, message: `硬币 ${i + 1} 触发重投 (Reuse ×${limit})` });
        continue;
      }
    }
    if (pass <= maxRerolls) {
      continue;
    }
    break;
    }
  }

  if (extraCfg.trigger === "afterSkill" && landed.length) {
    const base = landed.reduce((s, l) => s + (extraCfg.reference === "actualHpLost" ? l.lost : l.resolved), 0);
    applyExtraDamage(st, turn, entryId, skill.id, extraCfg, base, entry, undefined);
  }

  const endCtx = makeEffectCtx(sc, st, turn, skill.id);
  executeSkillEndEffects(skillScripts, endCtx);
  flushEffectCtx(st, endCtx, entry);
  runPassiveHook(sc, st, turn, "onSkillEnd", { skill: passiveSkillInfo(skill) }, entry);
  runScriptHook(sc, st, turn, "onSkillEnd", { skill }, entry);
  dawnAllyJointAttack(sc, st, turn, skill, entry);
  st.actor.clearStatusInterceptors("skill");
  st.duel = null;
  st.target.clearStatusInterceptors("skill");
  st.atkWeight = null;
  endActionRecord(st);

  // Follow-ups triggered by this entry.
  for (const fu of sc.followUps) {
    if (!fu.enabled || fu.skillId == null) continue;
    if (!fu.trigger.sourceEntryIds.includes(entryId)) continue;
    if (chainDepth >= Math.max(0, fu.maxChainDepth)) {
      addGap(st, { kind: "scenario", id: `chainLimit:${fu.entryId}`, message: `追击 ${fu.entryId} 达到链深上限 ${fu.maxChainDepth}，后续追击被截断` });
      continue;
    }
    if (fu.trigger.event === "onWinDuel") {
      addGap(st, { kind: "scenario", id: `followUpDuel:${fu.entryId}`, message: "无对拼模式下不触发“拼点胜利”追击" });
      continue;
    }
    let times = 1;
    if (fu.trigger.event === "afterEachLandedCoin") times = landed.length;
    times = Math.min(times, Math.max(0, fu.trigger.maxPerSourceAction));
    for (let k = 0; k < times; k++) {
      const chance = Math.min(1, Math.max(0, fu.trigger.chance));
      if (chance < 1 && st.coinMode !== "monteCarlo") {
        addGap(st, { kind: "scenario", id: `followUpChance:${fu.entryId}`, message: `追击 ${fu.entryId} 触发概率 ${chance} <1，固定模式下按不触发计算`, impact: "approx" });
        continue;
      }
      if (chance < 1 && !st.rng.prob(chance)) continue;
      const fuSkill = sc.data.skills[String(fu.skillId)];
      if (!fuSkill) {
        addGap(st, { kind: "skill", id: String(fu.skillId), where: fu.entryId, message: "追击技能不存在" });
        continue;
      }
      pushEvent(st, { turn, entryId: fu.entryId, skillId: fuSkill.id, kind: "followUp", message: `由 ${entryId} 触发追击` });
      const nextDepth = fu.allowTriggeringOtherFollowUps ? chainDepth + 1 : Number.MAX_SAFE_INTEGER;
      executeSkill(sc, st, turn, fu.entryId, fu, fuSkill, nextDepth);
    }
  }

  // Actor cut-in / follow-up skills queued by handlers (PassiveCtx.queueAction): run after this skill, own result entry.
  if (st.pendingActions?.length && chainDepth < 6) {
    const queued = st.pendingActions.splice(0);
    for (const q of queued) {
      const qSkill = sc.data.skills[String(q.skillId)];
      if (!qSkill || st.targetDead) continue;
      const qId = `追加行动:${q.label}`;
      pushEvent(st, { turn, entryId: qId, skillId: qSkill.id, kind: "followUp", message: `由 ${entryId} 触发追击/追加行动：${q.label}` });
      executeSkill(sc, st, turn, qId, baseEntryFor(qSkill, qId, 1), qSkill, chainDepth + 1);
    }
  }
}

function applyExtraDamage(
  st: RunState,
  turn: number,
  entryId: string,
  skillId: number,
  cfg: SkillModifiers["totalExtraDamage"],
  base: number,
  entry: EntryTotals,
  coinIndex: number | undefined,
) {
  if (cfg.fixedDamage === 0 && cfg.ratioPct === 0) return;
  if (cfg.modifierPolicy !== "fixed") {
    addGap(st, { kind: "extraDamage", id: cfg.modifierPolicy, where: entryId, message: `追伤修正规则 ${cfg.modifierPolicy} 尚未实现，按固定追加处理` });
  }
  if (cfg.canTriggerOnHit) {
    addGap(st, { kind: "extraDamage", id: "canTriggerOnHit", where: entryId, message: "追伤二次触发命中效果尚未实现" });
  }
  // Fixed HP plus ratio of the chosen base; floored once (design default, not a game rule).
  const amount = Math.max(0, Math.floor(cfg.fixedDamage + (base * cfg.ratioPct) / 100 + 1e-7));
  const lost = dealHp(st, amount);
  st.totals.extra += lost;
  st.totals.total += lost;
  entry.extra += lost;
  entry.total += lost;
  pushEvent(st, { turn, entryId, skillId, kind: "extraDamage", coinIndex, damage: lost, message: `追伤 固定 ${cfg.fixedDamage} + ${cfg.ratioPct}% × ${base}` });
}

function roundEnd(sc: StaticCtx, st: RunState, turn: number, explicitAssist = false) {
  runPassiveHook(sc, st, turn, "onRoundEnd", {}, null);
  runAbilityHook(sc, st, turn, "onRoundEnd", null, null);
  // 10617 Assist Defense (SupportProtect -> 1061705 Warning Announcement):
  // When SupportProtect is active during the turn, intercepting an attack triggers 1061705:
  // - If not has TimeToListenHonglu, gain 1 ReadyToListenHonglu (max 1 per turn)
  // - [WhenUse] Only if 6 [ChargeNoirAlly] Count can be consumed, gain 1 SupportProtect next turn
  //   (refunded by Passive 1061701 at 8+ NoirBindArmorAlly). Counter alone gives only +4 Count,
  //   so a cold single-slot T1 cannot chain; the WinDuel +4 arrives after the consume check.
  // - [WinDuel] Gain +4 [ChargeNoirAlly] Count
  if (sc.identity?.id === 10617 && st.actor.get("SupportProtect") && !explicitAssist) {
    if (!st.actor.get("TimeToListenHonglu") && st.readyToListenTurn !== turn) {
      const { before, after } = st.actor.apply("ReadyToListenHonglu", 1, 0, 0);
      st.readyToListenTurn = turn;
      const ch: StatusChangeRecord = { statusId: "ReadyToListenHonglu", target: "actor", before, after, reason: "援护防御(1061705):获得听讲准备" };
      st.statusApps.push({ ...ch, turn });
      pushEvent(st, { turn, kind: "status", status: ch });
    }
    if (st.actor.getCount("Charge") >= 6) {
      const { before, after } = st.actor.consumeCount("Charge", 6);
      st.statusApps.push({ statusId: st.actor.resolveId("Charge"), target: "actor", before, after, reason: "援护防御(1061705):消耗6充能续下回合援护防御", turn });
      st.actor.apply("SupportProtect", 1, 0, 1);
      if (sc.preset.actor.battlePassives !== "none" && st.actor.getPotency("NoirBindArmorAlly") >= 8) {
        st.actor.apply("Charge", 0, 6, 0);
      }
    } else {
      pushEvent(st, { turn, kind: "note", message: "援护防御(1061705):保存层数不足 6，无法续下回合援护防御" });
    }
    // 1061705 [WinDuel] Gain +4 [ChargeNoirAlly] Count
    const { before: cb, after: ca } = st.actor.apply("Charge", 0, 4, 0);
    st.statusApps.push({ statusId: st.actor.resolveId("Charge"), target: "actor", before: cb, after: ca, reason: "援护防御(1061705):拼点胜利+4充能", turn });
  }
  // Opt-in enemy-action model: unclashed enemy attacks that land on the actor (scenario.enemyActions[].takeHits).
  for (const act of sc.target.enemyActions) if (act.turn === turn && act.takeHits) takeEnemyHits(sc, st, turn, act.takeHits, null);
  // Enemy coin tosses (scripted) trigger target Laceration.
  for (const act of sc.target.enemyActions.filter((a) => a.turn === turn)) {
    for (let c = 0; c < act.coinCount; c++) {
      const rec = triggerLacerationOnAttackCoinToss(st.target, turn, `敌方第 ${c + 1} 枚攻击硬币投掷`);
      if (rec) recordDot(st, rec, null);
    }
  }
  const burn = triggerCombustionOnRoundEnd(st.target, turn);
  if (burn) recordDot(st, burn, null);
  const selfBurn = triggerCombustionOnRoundEnd(st.actor, turn);
  if (selfBurn) {
    st.totals.selfHpDamage += selfBurn.hpDamage;
    pushEvent(st, { turn, kind: "dot", dot: selfBurn, message: "自身烧伤（不计入对目标伤害）" });
  }
  for (const [side, container] of [["target", st.target], ["actor", st.actor]] as const) {
    for (const ch of container.onRoundEndDecay()) {
      const rec = { ...ch, target: side };
      st.statusApps.push({ ...rec, turn });
      pushEvent(st, { turn, kind: "status", status: rec });
      if (side === "actor" && ch.reason === "ReadyToListenHonglu->TimeToListenHonglu") {
        // Passive 1061712: entering TimeToListenHonglu inflicts 2 WarinessHonglu on enemies and resets the 1061704->1061706 limit.
        const { before, after } = st.target.apply("WarinessHonglu", 2, 0, 0);
        const wRec: StatusChangeRecord = { statusId: "WarinessHonglu", target: "target", before, after, reason: "被动1061712:进入听讲时间施加听觉惩罚" };
        st.statusApps.push({ ...wRec, turn });
        pushEvent(st, { turn, kind: "status", status: wRec });
        st.listenCounterUsed = false;
      }
    }
  }
  pushEvent(st, { turn, kind: "roundEnd", message: `第 ${turn} 回合结束` });
}

// ---------------------------------------------------------------- setup

function buildStatic(data: SimulationData, preset: Preset): { sc: StaticCtx; assumptions: string[]; setupGaps: Gap[] } {
  const assumptions: string[] = [];
  const setupGaps: Gap[] = [];
  const identity = data.identities.find((i) => i.id === preset.actor.identityId) ?? null;
  if (!identity) setupGaps.push({ kind: "scenario", id: "identity", message: `人格 ${preset.actor.identityId} 不在数据中` });
  const level = preset.actor.level ?? DEFAULT_IDENTITY_LEVEL;
  if (preset.actor.level == null) assumptions.push(`人格等级未设置，按 ${DEFAULT_IDENTITY_LEVEL} 级计算`);
  const sp = num(preset.actor.initialSp, 0);
  assumptions.push(`理智 ${sp}，正面概率 ${(coinHeadsProbability(sp) * 100).toFixed(0)}%（0.5 + 理智×1%，无对拼时理智不变）`);
  const target = readTarget(preset);
  if (target.defenseLevel == null) assumptions.push("目标防御等级未设置，按与人格等级相同（等级差 0）计算");
  assumptions.push("无对拼（unopposed）：拼点次数 0，硬币全部命中");
  if (target.staggerPolicy !== "disabled") {
    setupGaps.push({ kind: "scenario", id: "stagger", message: "混乱/混乱阶段尚未建模，震颤仅记录阈值变化", impact: "approx", reason: "按目标不进入混乱计算" });
  }
  if (target.shield > 0) setupGaps.push({ kind: "scenario", id: "shield", message: "护盾尚未建模，按无护盾计算" });
  const sim = preset.simulation as Record<string, unknown>;
  if (sim.clashMode && sim.clashMode !== "unopposed") {
    setupGaps.push({ kind: "scenario", id: "clash", message: `拼点模式 ${String(sim.clashMode)} 尚未实现，按无对拼计算` });
  }
  if (preset.actor.battlePassives !== "none" && identity) {
    for (const pid of identity.battlePassiveIds) {
      if (MODELLED_PASSIVES.has(pid) || PASSIVES.has(pid)) continue;
      const info = passiveLogic(pid);
      setupGaps.push({
        kind: "passive",
        id: String(pid),
        message: info?.dependsOnAlly ? "战斗被动尚未建模（部分效果依赖队友在场）" : "战斗被动尚未建模",
        impact: info?.impact ?? "damage",
        reason: info?.reason,
      });
    }
  }
  for (const pid of preset.actor.supportPassiveIds ?? []) {
    setupGaps.push({ kind: "passive", id: String(pid), message: "支援被动的具体效果未自动建模；请在「外部加成」中填写其数值" });
  }
  const externalBuffs = readExternalBuffs(preset.actor.externalBuffs);
  for (const b of externalBuffs.filter((x) => x.enabled)) {
    const parts = [
      b.basePower && `基础威力 ${b.basePower > 0 ? "+" : ""}${b.basePower}`,
      b.coinPower && `硬币威力 ${b.coinPower > 0 ? "+" : ""}${b.coinPower}`,
      b.finalPower && `最终威力 ${b.finalPower > 0 ? "+" : ""}${b.finalPower}`,
      b.offenseLevel && `攻击等级 ${b.offenseLevel > 0 ? "+" : ""}${b.offenseLevel}`,
      b.dmgPct && `伤害 ${b.dmgPct > 0 ? "+" : ""}${b.dmgPct}%`,
      b.takeDmgPct && `目标受伤 ${b.takeDmgPct > 0 ? "+" : ""}${b.takeDmgPct}%`,
    ].filter(Boolean);
    assumptions.push(`外部加成（${SOURCE_LABEL[b.source]}）${b.name}：${parts.join("，") || "无数值"}${b.sin || b.atk || b.slot ? `（仅限 ${[b.sin, b.atk, b.slot].filter(Boolean).join("/")}）` : ""}`);
  }
  const rawTier = (preset.simulation as Record<string, unknown>).bonusTier;
  const tier: BonusTier = rawTier === "power" || rawTier === "full" ? rawTier : "none";
  if (tier !== "none") {
    assumptions.push(tier === "full"
      ? "吃满假设：技能自身的条件威力加成与条件增伤按上限计入（对应脚本不再按实际状态重复结算）"
      : "吃满假设：技能自身的条件威力加成按上限计入；条件增伤仍按实际状态结算");
  }
  const passives: PassiveHandler[] =
    preset.actor.battlePassives !== "none" && identity ? identity.battlePassiveIds.map((pid) => PASSIVES.get(pid)).filter((h): h is PassiveHandler => !!h) : [];
  for (const h of passives) {
    if (h.approx) setupGaps.push({ kind: "passive", id: String(h.id), message: `战斗被动已建模：${h.summary}`, impact: "approx", reason: h.approx });
  }
  const bRaw = ((preset.scenario ?? {}) as Record<string, unknown>).battle as Record<string, unknown> | undefined;
  const battle: BattleCtx = {
    selfSpeed: typeof bRaw?.selfSpeed === "number" ? bRaw.selfSpeed : identity?.speed?.max ?? 0,
    targetSpeed: typeof bRaw?.targetSpeed === "number" ? bRaw.targetSpeed : target.speed ?? DEFAULT_TARGET_SPEED,
    targetCount: Math.max(1, Math.trunc(num(bRaw?.targetCount, num(((preset.scenario ?? {}) as { target?: { count?: unknown } }).target?.count, 1)))),
    countSubTargets: bRaw?.countSubTargets === true,
    countAllyDamage: bRaw?.countAllyDamage === true,
    lostHpPct: Math.min(100, Math.max(0, num(bRaw?.lostHpPct, 0))),
    allies: Array.isArray(bRaw?.allies) ? (bRaw!.allies as unknown[]).map(String) : [],
    resonance: Object.fromEntries(Object.entries((bRaw?.resonance ?? {}) as Record<string, unknown>).map(([k, v]) => [k, Math.max(0, Math.trunc(num(v, 0)))])),
    perfectResonance: Math.max(0, Math.trunc(num(bRaw?.perfectResonance, 0))),
  };
  assumptions.push(
    `战斗情境：自身速度 ${battle.selfSpeed}${typeof bRaw?.selfSpeed === "number" ? "" : "（默认取人格最高速度）"}，目标速度 ${battle.targetSpeed}${typeof bRaw?.targetSpeed === "number" || target.speed != null ? "" : "（默认）"}，敌方目标 ${battle.targetCount} 个，已损失体力 ${battle.lostHpPct}%，在场队友 ${battle.allies.length ? battle.allies.join("、") : "无"}`,
  );
  const duelCfg = readDuel(preset);
  if (duelCfg) assumptions.push(`敌方行动（可选）：${duelCfg.turns ? `第 ${duelCfg.turns.join("/")} 回合` : "拼点回合"}的攻击技能均假设拼点${duelCfg.outcome === "win" ? `胜利（理智 +${duelCfg.spOnWin}/次，硬币无损）` : "失败（不造成伤害，自身受击）"}`);
  if (target.hpRatio !== 1 || target.hpTracking) assumptions.push(
    `目标体力：初始 ${Math.round(target.hpRatio * 100)}%${target.hpTracking ? `，随造成的伤害下降（最大体力 ${target.maxHp}）` : "，固定不变"}；按体力比例判定的效果据此计算`,
  );
  return {
    sc: {
      data, preset, identity, level, sp, target,
      disabled: new Set(preset.actor.disabledEffectIds ?? []),
      followUps: preset.skillGroups.followUps ?? [],
      duel: readDuel(preset),
      externalBuffs,
      tier,
      tierCaps: new Map(),
      battle,
      passives,
    },
    assumptions,
    setupGaps,
  };
}

function freshState(sc: StaticCtx, coinMode: CoinMode, rng: DeterministicRng, recordEvents: boolean): RunState {
  const actor = new StatusContainer(sc.data.buffs);
  const target = new StatusContainer(sc.data.buffs);
  const st: RunState = {
    rng, coinMode, actor, target,
    targetHpLeft: sc.target.hpMode === "limited" ? sc.target.hp ?? 0 : null,
    targetDead: false,
    totals: { direct: 0, extra: 0, dotHp: 0, dotSp: 0, staggerShift: 0, total: 0, selfHpDamage: 0, ...(sc.battle.countSubTargets ? { subTarget: 0 } : {}) },
    perEntry: new Map(),
    dotRows: new Map(),
    statusApps: [],
    events: [],
    gaps: new Map(),
    onceFlags: new Map(),
    passiveState: new Map(),
    recordEvents,
    support: readTeammateSupport(sc.preset.simulation.teammateSupport),
    staggerCfg: sc.target.hpTracking && sc.target.staggerThresholdsPct.length ? { thresholdsPct: sc.target.staggerThresholdsPct, hpRatio: sc.target.hpRatio, maxHp: sc.target.maxHp } : undefined,
  };
  actor.vibrationExplosionListener = (rec) => dispatchVibrationExplosion(sc, st, "actor", rec);
  target.vibrationExplosionListener = (rec) => dispatchVibrationExplosion(sc, st, "target", rec);
  for (const b of sc.identity?.initBuffs ?? []) actor.apply(b.buff, b.stack ?? 0, b.turn ?? 0, 0);
  const userActorInit = parseStatusList(sc.preset.actor.initialStatuses);
  if (sc.tier !== "none" && sc.identity?.id === 10617) {
    if (!userActorInit.some((s) => s.id === "Charge" || s.id === "ChargeNoirAlly")) {
      actor.apply("ChargeNoirAlly", 6, 20, 0);
    }
    if (!userActorInit.some((s) => s.id === "NoirBindArmorAlly")) {
      actor.apply("NoirBindArmorAlly", 14, 0, 0);
    }
  }
  for (const s of userActorInit) actor.apply(s.id, s.potency, s.count, 0);
  for (const s of sc.target.initialStatuses) target.apply(s.id, s.potency, s.count, 0);
  return st;
}

/** Translated skill/coin scripts with a stated approximation → "approx" gaps (visible in reports, not counted as damage gaps). */
function noteApproxScripts(sc: StaticCtx, st: RunState, skill: NormalizedSkill, entryId: string) {
  for (const e of scriptEntries(skill, undefined, true)) {
    if (sc.disabled.has(e.s.scriptName)) continue;
    const h = scriptHandler(e.s.scriptName);
    if (!h?.approx) continue;
    addGap(st, {
      kind: "effect",
      id: e.s.scriptName,
      where: `${entryId} / 技能 ${skill.id}${e.ownerCoinIndex != null ? ` / 硬币 ${e.ownerCoinIndex + 1}` : ""}`,
      message: `脚本已建模：${h.summary}`,
      impact: "approx",
      reason: h.approx,
      skillId: skill.id,
      coinIndex: e.ownerCoinIndex,
    });
  }
  // Status abilities translated with a stated approximation (they count as modelled for the damage-gap check).
  for (const [side, c] of [["actor", st.actor], ["target", st.target]] as const) {
    for (const s of c.allActive()) {
      for (const item of (sc.data.buffs[s.id]?.list ?? []) as { ability: string }[]) {
        const h = abilityHandler(item.ability);
        if (h?.approx) addGap(st, { kind: "status", id: `${s.id}:${item.ability}`, where: side === "actor" ? "自身" : "目标", message: `状态能力已建模：${h.summary}`, impact: "approx", reason: h.approx });
      }
    }
  }
}

function noteUnmodelledStatuses(st: RunState) {
  for (const [side, c] of [["actor", st.actor], ["target", st.target]] as const) {
    for (const s of c.allActive()) {
      const missing = c.unmodelledAbilities(s.id);
      if (!missing.length && c.isFullyModelled(s.id)) continue;
      const infos = missing.map((a) => buffAbilityLogic(a));
      const impact = !missing.length ? "damage" : infos.some((i) => !i || i.impact === "damage") ? "damage" : infos.some((i) => i?.impact === "untriggered") ? "untriggered" : "none";
      addGap(st, {
        kind: "status",
        id: s.id,
        where: side === "actor" ? "自身" : "目标",
        message: "该状态的数值效果尚未完全建模（仅记录层数）",
        impact,
        reason: impact === "damage" ? undefined : infos.map((i) => i?.reason).filter(Boolean)[0],
      });
    }
  }
}

function resolveEntrySkill(sc: StaticCtx, st: RunState, e: BaseSkillEntry): NormalizedSkill | null {
  const s = sc.data.skills[String(e.skillId)];
  if (!s) addGap(st, { kind: "skill", id: String(e.skillId), where: e.entryId, message: "技能不存在" });
  return s ?? null;
}

function runOnce(sc: StaticCtx, coinMode: CoinMode, rng: DeterministicRng, recordEvents: boolean): RunState {
  const preset = sc.preset;
  const base = preset.skillGroups.base;
  const mode = preset.simulation.mode;

  if (mode === "staticCycle") {
    // Reset scenario before every use; weight by usesPerCycle. Cross-turn DOT (Combustion) excluded.
    const agg = freshState(sc, coinMode, rng, recordEvents);
    for (const e of base) {
      const skill = resolveEntrySkill(sc, agg, e);
      if (!skill || e.usesPerCycle <= 0) continue;
      for (let u = 0; u < e.usesPerCycle; u++) {
        const st = freshState(sc, coinMode, rng, recordEvents && u === 0);
        runAbilityHook(sc, st, 1, "onRoundStart", null, null);
        runPassiveHook(sc, st, 1, "onBattleStart", {}, null);
        runPassiveHook(sc, st, 1, "onTurnStart", {}, null);
        runAbilityHook(sc, st, 1, "onBattleStart", null, null);
        executeSkill(sc, st, 1, e.entryId, e, skill, 0);
        noteUnmodelledStatuses(st);
        mergeState(agg, st, u === 0);
      }
    }
    return agg;
  }

  const st = freshState(sc, coinMode, rng, recordEvents);
  const schedule = [...(preset.simulation.actionSchedule ?? [])].sort((a, b) => a.turn - b.turn || a.order - b.order);
  const lastScheduled = schedule.reduce((m, a) => Math.max(m, a.turn), 0);
  const turns = Math.max(lastScheduled, num(preset.simulation.turnCount, lastScheduled));
  const byId = new Map(base.map((e) => [e.entryId, e]));
  for (let turn = 1; turn <= turns; turn++) {
    noteUnmodelledStatuses(st);
    applySupportTurnStart(st, turn);
    runAbilityHook(sc, st, turn, "onRoundStart", null, null);
    if (turn === 1) runPassiveHook(sc, st, turn, "onBattleStart", {}, null);
    runPassiveHook(sc, st, turn, "onTurnStart", {}, null);
    runAbilityHook(sc, st, turn, "onBattleStart", null, null);
    let explicitAssist = false;
    // OnBeforeTurn: skill changes (BattleActionModel.ChangeSkill) are decided for every slotted action of this round from the
    // round-start state, before any action resolves; executeSkill then uses the pre-decided skill (st.preReplaced).
    const preDecide = (preset.simulation as { skillChangeTiming?: string }).skillChangeTiming !== "execution";
    const acts = schedule.filter((a) => a.turn === turn).map((act) => {
      const e = byId.get(act.entryId);
      const skill = e ? resolveEntrySkill(sc, st, e) : null;
      const to = preDecide && e && skill ? applySkillReplacement(sc, st, turn, e.entryId, skill, entryTotals(st, e.entryId, skill.id)) : null;
      return { act, e, skill, to };
    });
    for (const { act, e, skill, to } of acts) {
      if (!e) {
        addGap(st, { kind: "scenario", id: act.entryId, message: `行动表引用了不存在的技能项 ${act.entryId}` });
        continue;
      }
      if (skill) {
        if (skill.abilityScripts?.some((s) => s.scriptName === "SupportiveDefense")) explicitAssist = true;
        st.preReplaced = to ?? undefined;
        executeSkill(sc, st, turn, e.entryId, e, skill, 0);
        st.preReplaced = undefined;
      }
    }
    noteUnmodelledStatuses(st);
    roundEnd(sc, st, turn, explicitAssist);
    if (st.targetDead) {
      pushEvent(st, { turn, kind: "note", message: "目标死亡，模拟结束" });
      break;
    }
  }
  if (lastScheduled === 0) addGap(st, { kind: "scenario", id: "emptySchedule", message: "行动表为空" });
  return st;
}

function mergeState(agg: RunState, st: RunState, keepEvents: boolean) {
  for (const k of Object.keys({ ...agg.totals, ...st.totals }) as (keyof Totals)[]) agg.totals[k] = (agg.totals[k] ?? 0) + (st.totals[k] ?? 0);
  for (const [id, e] of st.perEntry) {
    const a = entryTotals(agg, id, e.skillId);
    a.uses += e.uses; a.direct += e.direct; a.extra += e.extra; a.dotHp += e.dotHp; a.total += e.total;
    if (e.subTarget != null) a.subTarget = (a.subTarget ?? 0) + e.subTarget;
    if (e.ally != null) a.ally = (a.ally ?? 0) + e.ally;
  }
  for (const [k, r] of st.dotRows) {
    const a = agg.dotRows.get(k) ?? { ...r, triggers: 0, hpDamage: 0, spDamage: 0, staggerShift: 0 };
    a.triggers += r.triggers; a.hpDamage += r.hpDamage; a.spDamage += r.spDamage; a.staggerShift += r.staggerShift;
    agg.dotRows.set(k, a);
  }
  if (keepEvents) {
    agg.statusApps.push(...st.statusApps);
    agg.events.push(...st.events);
  }
  for (const [k, g] of st.gaps) if (!agg.gaps.has(k)) agg.gaps.set(k, g);
  for (const [k, r] of st.replacements ?? []) {
    const m = agg.replacements ?? (agg.replacements = new Map());
    const a = m.get(k);
    if (a) a.uses += r.uses;
    else m.set(k, { ...r });
  }
}

function finalize(sc: StaticCtx, st: RunState, coinMode: CoinMode, assumptions: string[], setupGaps: Gap[]): SimulationResult {
  for (const g of setupGaps) addGap(st, g);
  const mode = sc.preset.simulation.mode;
  if (mode === "staticCycle") assumptions.push("状态重置的六技能加权伤害：每次使用前恢复初始场景，跨回合 DOT（烧伤）不计入");
  else assumptions.push("每个行动按行动表的回合执行；回合结束结算烧伤与层数衰减；残留状态单独列出，不提前计入未来 DOT");
  if (coinMode === "allHeads") assumptions.push("硬币全部正面（场景假设，不是伤害上限）");
  if (coinMode === "allTails") assumptions.push("硬币全部反面");
  const remaining: SimulationResult["remainingStatuses"] = [];
  if (mode !== "staticCycle") {
    for (const [side, c] of [["actor", st.actor], ["target", st.target]] as const) {
      for (const s of c.allActive()) remaining.push({ side, id: s.id, potency: s.potency, count: s.count });
    }
  }
  const balanceMap = new Map<string, DotBalanceRow>();
  const ensureBal = (side: "target" | "actor", statusId: string): DotBalanceRow => {
    const key = `${side}:${statusId}`;
    let row = balanceMap.get(key);
    if (!row) {
      const initList = side === "target" ? sc.target.initialStatuses : parseStatusList((sc.preset.actor as Record<string, unknown>).initialStatuses);
      const init = initList.find((x) => x.id === statusId);
      const rem = remaining.find((x) => x.side === side && x.id === statusId);
      row = {
        statusId,
        side,
        initialPotency: init?.potency ?? 0,
        initialCount: init?.count ?? 0,
        potencyAdded: 0,
        countAdded: 0,
        countConsumed: 0,
        netCount: 0,
        finalPotency: rem?.potency ?? 0,
        finalCount: rem?.count ?? 0,
      };
      balanceMap.set(key, row);
    }
    return row;
  };
  for (const ch of st.statusApps) {
    const dp = ch.after.potency - ch.before.potency;
    const dc = ch.after.count - ch.before.count;
    if (dp === 0 && dc === 0) continue;
    const row = ensureBal(ch.target, ch.statusId);
    if (dp > 0) row.potencyAdded += dp;
    if (dc > 0) row.countAdded += dc;
    if (dc < 0) row.countConsumed += -dc;
  }
  for (const d of st.dotRows.values()) {
    if (d.statusId === "Burst" || d.statusId === "Sinking" || d.statusId === "Combustion" || d.statusId === "Laceration") {
      const row = ensureBal("target", d.statusId);
      row.countConsumed += d.triggers;
    }
  }
  for (const row of balanceMap.values()) {
    row.netCount = row.countAdded - row.countConsumed;
  }
  const dotBalance = [...balanceMap.values()].filter(
    (r) => r.initialPotency > 0 || r.initialCount > 0 || r.potencyAdded > 0 || r.countAdded > 0 || r.countConsumed > 0,
  );
  const gaps = [...st.gaps.values()];
  const skillReplacements = [...(st.replacements?.values() ?? [])];
  for (const r of skillReplacements) assumptions.push(`技能变身/替换：${r.entryId} ${r.fromSkillId} → ${r.toSkillId}（${r.reason}，${r.uses} 次）`);
  return {
    rulesVersion: RULES_VERSION,
    mode,
    coinMode,
    exact: !gaps.some((g) => (g.impact ?? "damage") === "damage" || g.impact === "approx"),
    quality: gaps.some((g) => (g.impact ?? "damage") === "damage") ? "gaps" : gaps.some((g) => g.impact === "approx") ? "approx" : "exact",
    gaps,
    assumptions,
    totals: st.totals,
    perEntry: [...st.perEntry.values()],
    dotBreakdown: [...st.dotRows.values()].sort((a, b) => a.turn - b.turn || a.statusId.localeCompare(b.statusId)),
    dotBalance,
    statusApplications: st.statusApps,
    remainingStatuses: remaining,
    events: st.events,
    ...(skillReplacements.length ? { skillReplacements } : {}),
  };
}

/** Public entry point: simulate a preset against normalized game data. */
export function simulateScenario(data: SimulationData, preset: Preset, options: SimulationOptions = {}): SimulationResult {
  const sim = preset.simulation as Record<string, unknown>;
  const presetMode = sim.randomMode === "allHeads" || sim.randomMode === "allTails" ? (sim.randomMode as CoinMode) : "monteCarlo";
  const coinMode = options.coinMode ?? presetMode;
  const seed = options.seed ?? num(preset.simulation.seed, 20261030);
  const { sc, assumptions, setupGaps } = buildStatic(data, preset);

  if (coinMode !== "monteCarlo") {
    const st = runOnce(sc, coinMode, new DeterministicRng(seed), true);
    return finalize(sc, st, coinMode, assumptions, setupGaps);
  }

  const samples = Math.max(1, Math.trunc(options.samples ?? num(preset.simulation.samples, 1000)));
  const { first, gaps, stats } = monteCarloRuns(sc, samples, seed, true);
  first.gaps = gaps;
  assumptions.push(`Monte Carlo（期望值）：种子 ${seed}，样本 ${samples}（第 i 个样本使用独立子种子，可复现）；硬币正反与 <100% 暴击率均按概率抽样；事件日志与上方分项展示第 1 个样本，期望/分位数见 Monte Carlo 摘要`);
  const result = finalize(sc, first, coinMode, assumptions, setupGaps);
  result.monteCarlo = stats;
  return result;
}

/** Monte Carlo summary (期望值): sample mean / spread of total damage plus mean sub-totals. */
export interface MonteCarloStats {
  samples: number;
  seed: number;
  mean: number;
  /** Standard error of the mean (std / √samples). */
  stderr: number;
  /** Sample standard deviation of the total. */
  std: number;
  p10: number;
  p50: number;
  p90: number;
  observedMin: number;
  observedMax: number;
  meanDirect: number;
  meanExtra: number;
  meanDot: number;
  meanDotSp: number;
}

/**
 * Seed of Monte Carlo sample i: sample 0 uses the seed itself, the others an fmix32-hashed sub-seed. Each sample owns its
 * RNG stream, so the same (seed, i) gives the same random numbers for every schedule (common random numbers).
 */
export function mcSampleSeed(seed: number, i: number): number {
  if (i === 0) return seed >>> 0;
  let h = (seed ^ Math.imul(i, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function monteCarloRuns(sc: StaticCtx, samples: number, seed: number, recordFirst: boolean) {
  const totals: number[] = [];
  let d = 0, x = 0, h = 0, s = 0;
  let first: RunState | null = null;
  const gaps = new Map<string, Gap>();
  for (let i = 0; i < samples; i++) {
    const st = runOnce(sc, "monteCarlo", new DeterministicRng(mcSampleSeed(seed, i)), recordFirst && i === 0);
    if (i === 0) first = st;
    totals.push(st.totals.total);
    d += st.totals.direct; x += st.totals.extra; h += st.totals.dotHp; s += st.totals.dotSp;
    for (const [k, g] of st.gaps) if (!gaps.has(k)) gaps.set(k, g);
  }
  const mean = totals.reduce((a, b) => a + b, 0) / samples;
  const variance = samples > 1 ? totals.reduce((a, b) => a + (b - mean) ** 2, 0) / (samples - 1) : 0;
  const sorted = [...totals].sort((a, b) => a - b);
  const stats: MonteCarloStats = {
    samples, seed, mean, std: Math.sqrt(variance), stderr: Math.sqrt(variance / samples),
    p10: quantile(sorted, 0.1), p50: quantile(sorted, 0.5), p90: quantile(sorted, 0.9),
    observedMin: sorted[0]!, observedMax: sorted[sorted.length - 1]!,
    meanDirect: d / samples, meanExtra: x / samples, meanDot: h / samples, meanDotSp: s / samples,
  };
  return { first: first!, gaps, stats };
}

/** Expected-value statistics only (no events / result assembly); used by the optimizer's expected-value ranking. */
export function simulateExpected(data: SimulationData, preset: Preset, options: { samples?: number; seed?: number } = {}): MonteCarloStats {
  const { sc } = buildStatic(data, preset);
  const samples = Math.max(1, Math.trunc(options.samples ?? num(preset.simulation.samples, 1000)));
  return monteCarloRuns(sc, samples, options.seed ?? num(preset.simulation.seed, 20261030), false).stats;
}

/** Convenience alias matching the plan's public API name. */
export function calculateStaticCycle(data: SimulationData, preset: Preset, options: SimulationOptions = {}): SimulationResult {
  return simulateScenario(data, { ...preset, simulation: { ...preset.simulation, mode: "staticCycle" } }, options);
}
