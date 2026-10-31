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
import { donActionAt, readTeammateSupport, type TeammateSupport } from "./teammate-support";
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
} from "./status";
import {
  classifyCoinScripts,
  evaluateCoinPreHitEffects,
  evaluateLiveSkillEffects,
  evaluateSkillStartEffects,
  executeCoinOnHitEffects,
  executeSkillEndEffects,
  getActiveCoinRerollLimit,
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

export interface Gap {
  kind: "effect" | "passive" | "status" | "scenario" | "skill" | "extraDamage";
  id: string;
  message: string;
  where?: string;
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
  gaps: Gap[];
  assumptions: string[];
  totals: Totals;
  perEntry: EntryTotals[];
  dotBreakdown: DotBreakdownRow[];
  dotBalance?: DotBalanceRow[];
  statusApplications: (StatusChangeRecord & { turn: number })[];
  remainingStatuses: { side: "actor" | "target"; id: string; potency: number; count: number }[];
  events: SimEvent[];
  monteCarlo?: { samples: number; mean: number; stderr: number; observedMin: number; observedMax: number; meanDirect: number; meanDot: number };
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
  speed: number | null;
  physical: Record<string, number>;
  sin: Record<string, number>;
  initialStatuses: { id: string; potency: number; count: number }[];
  shield: number;
  staggerPolicy: string;
  enemyActions: { turn: number; coinCount: number }[];
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
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
  const enemyActions: { turn: number; coinCount: number }[] = [];
  if (Array.isArray(sc.enemyActions)) {
    for (const a of sc.enemyActions) {
      const o = (a ?? {}) as Record<string, unknown>;
      if (typeof o.turn === "number") enemyActions.push({ turn: o.turn, coinCount: Math.max(0, Math.trunc(num(o.coinCount, 0))) });
    }
  }
  return {
    hpMode: t.hpMode === "limited" ? "limited" : "unlimited",
    hp: typeof t.hp === "number" ? t.hp : null,
    defenseLevel: typeof t.defenseLevel === "number" ? t.defenseLevel : null,
    hasSp: t.hasSp === true,
    speed: typeof t.speed === "number" ? t.speed : null,
    physical,
    sin: sinRes,
    initialStatuses: parseStatusList(t.initialStatuses),
    shield: num(t.shield, 0),
    staggerPolicy: typeof t.staggerPolicy === "string" ? t.staggerPolicy : "disabled",
    enemyActions,
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
  totals: Totals;
  perEntry: Map<string, EntryTotals>;
  dotRows: Map<string, DotBreakdownRow>;
  statusApps: (StatusChangeRecord & { turn: number })[];
  events: SimEvent[];
  gaps: Map<string, Gap>;
  recordEvents: boolean;
  /** Tracks whether ChangeSkillOnBeforeDefenseOncePerListen1061704 has already consumed its 1061704->1061706 upgrade in the current Listen cycle. */
  listenCounterUsed?: boolean;
  /** Tracks the last turn in which ReadyToListenHonglu was gained (max 1 stack per turn). */
  readyToListenTurn?: number;
  /** Teammate support model (e.g. Le Noir Brand Manager Don Quixote). */
  support?: TeammateSupport | null;
  /** Burst-triggered support grants already given this turn. */
  supportBurstGrants?: number;
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
  externalBuffs: ExternalBuff[];
  tier: BonusTier;
  tierCaps: Map<number, SkillBonusCap>;
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
function dealHp(st: RunState, amount: number): number {
  if (amount <= 0 || st.targetDead) return 0;
  if (st.targetHpLeft == null) return amount;
  const lost = Math.min(st.targetHpLeft, amount);
  st.targetHpLeft -= lost;
  if (st.targetHpLeft <= 0) st.targetDead = true;
  return lost;
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
    if (o.status === "unverified") {
      addGap(st, {
        kind: "effect",
        id: o.scriptName,
        where: `${entryId} / 技能 ${o.skillId}${o.coinIndex != null ? ` / 硬币 ${o.coinIndex + 1}` : ""}`,
        message: o.note ?? "未验证效果",
      });
    }
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
  };
}

function manualArray(mods: SkillModifiers, key: "coinPowerDeltas" | "coinDamageBonusPcts", i: number): number {
  const arr = mods[key];
  return Array.isArray(arr) ? num(arr[i], 0) : 0;
}

/** Execute one skill use. Returns resolved hit damages of landed coins (for afterSkill extra damage). */
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

  const atkType = skill.attrs.atkType;
  const defType = skill.attrs.defType;
  if (!atkType || !(atkType in ATK_TO_RESIST_KEY) || (defType && defType !== "ATTACK" && defType !== "COUNTER")) {
    const defScripts = skill.abilityScripts ?? [];
    const defCtx = makeEffectCtx(sc, st, turn, skill.id);
    evaluateSkillStartEffects(defScripts, defCtx);
    executeSkillEndEffects(defScripts, defCtx);
    flushEffectCtx(st, defCtx, entry);
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
  if (defType === "COUNTER") {
    addGap(st, { kind: "skill", id: String(skill.id), where: entryId, message: "反击技能按主动攻击结算，实际需敌方攻击触发" });
  }

  const skillScripts = skill.abilityScripts ?? [];
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
  let power = Math.max(0, basePower + skillStartBuffs.basePowerAdder + extSum("basePower"));
  pushEvent(st, {
    turn, entryId, skillId: skill.id, kind: "useSkill", power,
    message: `基础威力 ${basePower}${mods.basePower != null ? "（手动覆盖）" : ""}${skillStartBuffs.basePowerAdder ? ` +${skillStartBuffs.basePowerAdder}(状态)` : ""}${extSum("basePower") ? ` +${extSum("basePower")}(外部)` : ""}；使用时快照：最终威力 +${start.skillPowerResultAdder}，硬币威力 +${start.coinScaleAdder}，伤害 +${(start.attackDmgMultiplier * 100).toFixed(0)}%${cap && (capCoin || capFinal || capDmg) ? `；吃满假设：硬币 +${capCoin} 最终 +${capFinal}${capDmg ? ` 伤害 +${Math.round(capDmg * 100)}%` : ""}` : ""}`,
  });

  const baseOffense = sc.level + num(skill.attrs.skillLevelCorrection, 0);
  const baseDefense = sc.target.defenseLevel ?? sc.level;
  const atkResist = sc.target.physical[ATK_TO_RESIST_KEY[atkType as AtkType]] ?? 1;
  const sinAttr = skill.attrs.attributeType;
  const sinKey = sinAttr ? SIN_TO_RESIST_KEY[sinAttr] : null;
  const baseSinResist = sinKey ? sc.target.sin[sinKey] ?? 1 : 1;
  const headsP = coinHeadsProbability(sc.sp);
  const extraCfg = mods.totalExtraDamage;
  const landed: { resolved: number; lost: number }[] = [];
  let skillRerolledOnce = false;

  const forceCritByFullTier = (sc.preset.actor as Record<string, unknown>).forceFullCrit === true;

  for (let i = 0; i < skill.coins.length; i++) {
    if (st.targetDead) break;
    const coin = skill.coins[i]!;
    let pass = 0;
    let maxRerolls = 0;
    while (pass <= maxRerolls && !st.targetDead) {
      const isRerolled = pass > 0;
      pass++;

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
      actorSp: sc.sp,
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

    // Critical: Breath potency * 5% (BuffAbility_Breath.GetCriticalChanceAdder @ 0x10CA290); consumes 1 Breath count.
    const breathP = st.actor.getPotency("Breath");
    const critChance = forceCritByFullTier ? 1 : Math.min(1, breathP * 0.05);
    let critical = false;
    if (critChance > 0) {
      critical = st.coinMode === "monteCarlo" ? st.rng.prob(critChance) : critChance >= 1;
      if (st.coinMode !== "monteCarlo" && critChance < 1) {
        addGap(st, { kind: "scenario", id: "criticalChance", message: "固定正反面模式下暴击率 <100% 时按未暴击计算；请使用 Monte Carlo 查看期望" });
      }
      if (critical && st.actor.get("Breath")) {
        const { before, after } = st.actor.consumeCount("Breath", 1);
        const ch: StatusChangeRecord = { statusId: "Breath", target: "actor", before, after, reason: "criticalConsume" };
        st.statusApps.push({ ...ch, turn });
        pushEvent(st, { turn, entryId, skillId: skill.id, kind: "status", coinIndex: i, status: ch });
      }
    }

    const coinCtx: EffectContext = { ...makeEffectCtx(sc, st, turn, skill.id), coinIndex: i, isHeads: heads, isCritical: critical, isRerolled };
    const live = evaluateLiveSkillEffects(skillScripts, coinCtx);
    const manualDelta = mods.totalCoinPowerDelta + manualArray(mods, "coinPowerDeltas", i);
    const rawScaleForRoll = actorBuffMods.coinScaleOverride != null ? actorBuffMods.coinScaleOverride : coin.scale;
    const totalScaleAdder =
      actorBuffMods.coinScaleOverride != null
        ? 0
        : start.coinScaleAdder + live.coinScaleAdder + actorBuffMods.coinScaleAdder + manualDelta + capCoin + extSum("coinPower");
    const step = applyCoinToPower(power, coin.operatorType, rawScaleForRoll, totalScaleAdder, heads);
    if (coin.operatorType !== "ADD" && coin.operatorType !== "SUB") {
      addGap(st, { kind: "skill", id: `${skill.id}#coin${i + 1}`, where: entryId, message: `未知硬币运算符 ${coin.operatorType}` });
    }
    power = step.nextPower;
    const rolledPower = Math.max(0, power + start.skillPowerResultAdder + live.skillPowerResultAdder + actorBuffMods.skillPowerResultAdder + capFinal + extSum("finalPower"));

    const pre = evaluateCoinPreHitEffects(coin.abilityScriptList ?? [], coinCtx);

    const manualPct = (mods.totalDamageBonusPct + manualArray(mods, "coinDamageBonusPcts", i)) / 100;
    const offense = Math.max(1, baseOffense + actorBuffMods.offenseLevelAdder + extSum("offenseLevel"));
    const defense = Math.max(1, baseDefense + targetBuffMods.defenseLevelAdder);
    const sinResist = baseSinResist + targetBuffMods.sinResistAdder;
    const capCritDmg = critical && cap && sc.tier === "full" ? (cap.critDmg + (cap.coinCritDmg[i] ?? 0)) : 0;
    const breakdown = calculateCoinAttackDamage({
      rolledPower,
      atkResist,
      sinResist,
      offenseLevel: offense,
      defenseLevel: defense,
      isCritical: critical,
      attackDmgMultiplier:
        start.attackDmgMultiplier + live.attackDmgMultiplier + pre.coinDmgMultiplier + actorBuffMods.attackDmgMultiplier + manualPct +
        capDmg + (cap && sc.tier === "full" ? cap.coinDmg[i] ?? 0 : 0) + capCritDmg + extSum("dmgPct") / 100,
      takeAttackDmgMultiplier: targetBuffMods.takeAttackDmgMultiplier + extSum("takeDmgPct") / 100,
    });
    const lost = dealHp(st, breakdown.resolvedDamage);
    st.totals.direct += lost;
    st.totals.total += lost;
    entry.direct += lost;
    entry.total += lost;
    landed.push({ resolved: breakdown.resolvedDamage, lost });
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
    flushEffectCtx(st, coinCtx, entry);
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
      const limit = getActiveCoinRerollLimit(coin.abilityScriptList ?? [], coinCtx, forceReroll);
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
        addGap(st, { kind: "scenario", id: `followUpChance:${fu.entryId}`, message: `追击 ${fu.entryId} 触发概率 ${chance} <1，固定模式下按不触发计算` });
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
    setupGaps.push({ kind: "scenario", id: "stagger", message: "混乱/混乱阶段尚未建模，震颤仅记录阈值变化" });
  }
  if (target.shield > 0) setupGaps.push({ kind: "scenario", id: "shield", message: "护盾尚未建模，按无护盾计算" });
  const sim = preset.simulation as Record<string, unknown>;
  if (sim.clashMode && sim.clashMode !== "unopposed") {
    setupGaps.push({ kind: "scenario", id: "clash", message: `拼点模式 ${String(sim.clashMode)} 尚未实现，按无对拼计算` });
  }
  const MODELLED_BATTLE_PASSIVES = new Set<number>([1061701, 1061712]);
  if (preset.actor.battlePassives !== "none" && identity) {
    for (const pid of identity.battlePassiveIds) {
      if (MODELLED_BATTLE_PASSIVES.has(pid)) continue;
      setupGaps.push({ kind: "passive", id: String(pid), message: "战斗被动尚未建模；如影响伤害请用手动修正或在 actor.battlePassives 选择 none 后自行补偿" });
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
  return {
    sc: {
      data, preset, identity, level, sp, target,
      disabled: new Set(preset.actor.disabledEffectIds ?? []),
      followUps: preset.skillGroups.followUps ?? [],
      externalBuffs,
      tier,
      tierCaps: new Map(),
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
    totals: { direct: 0, extra: 0, dotHp: 0, dotSp: 0, staggerShift: 0, total: 0, selfHpDamage: 0 },
    perEntry: new Map(),
    dotRows: new Map(),
    statusApps: [],
    events: [],
    gaps: new Map(),
    recordEvents,
    support: readTeammateSupport(sc.preset.simulation.teammateSupport),
  };
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

function noteUnmodelledStatuses(st: RunState) {
  for (const [side, c] of [["actor", st.actor], ["target", st.target]] as const) {
    for (const s of c.allActive()) {
      if (!c.isFullyModelled(s.id)) {
        addGap(st, { kind: "status", id: s.id, where: side === "actor" ? "自身" : "目标", message: "该状态的数值效果尚未完全建模（仅记录层数）" });
      }
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
    let explicitAssist = false;
    for (const act of schedule.filter((a) => a.turn === turn)) {
      const e = byId.get(act.entryId);
      if (!e) {
        addGap(st, { kind: "scenario", id: act.entryId, message: `行动表引用了不存在的技能项 ${act.entryId}` });
        continue;
      }
      const skill = resolveEntrySkill(sc, st, e);
      if (skill) {
        if (skill.abilityScripts?.some((s) => s.scriptName === "SupportiveDefense")) explicitAssist = true;
        executeSkill(sc, st, turn, e.entryId, e, skill, 0);
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
  for (const k of Object.keys(agg.totals) as (keyof Totals)[]) agg.totals[k] += st.totals[k];
  for (const [id, e] of st.perEntry) {
    const a = entryTotals(agg, id, e.skillId);
    a.uses += e.uses; a.direct += e.direct; a.extra += e.extra; a.dotHp += e.dotHp; a.total += e.total;
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
  return {
    rulesVersion: RULES_VERSION,
    mode,
    coinMode,
    exact: gaps.length === 0,
    gaps,
    assumptions,
    totals: st.totals,
    perEntry: [...st.perEntry.values()],
    dotBreakdown: [...st.dotRows.values()].sort((a, b) => a.turn - b.turn || a.statusId.localeCompare(b.statusId)),
    dotBalance,
    statusApplications: st.statusApps,
    remainingStatuses: remaining,
    events: st.events,
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
  const rng = new DeterministicRng(seed);
  const first = runOnce(sc, coinMode, rng, true);
  const totals = [first.totals.total];
  let sumDirect = first.totals.direct;
  let sumDot = first.totals.dotHp;
  const allGaps = new Map(first.gaps);
  for (let i = 1; i < samples; i++) {
    const st = runOnce(sc, coinMode, rng, false);
    totals.push(st.totals.total);
    sumDirect += st.totals.direct;
    sumDot += st.totals.dotHp;
    for (const [k, g] of st.gaps) if (!allGaps.has(k)) allGaps.set(k, g);
  }
  first.gaps = allGaps;
  const mean = totals.reduce((a, b) => a + b, 0) / samples;
  const variance = samples > 1 ? totals.reduce((a, b) => a + (b - mean) ** 2, 0) / (samples - 1) : 0;
  assumptions.push(`Monte Carlo：种子 ${seed}，样本 ${samples}；事件日志展示第 1 个样本，汇总为第 1 个样本的数值`);
  const result = finalize(sc, first, coinMode, assumptions, setupGaps);
  result.monteCarlo = {
    samples,
    mean,
    stderr: Math.sqrt(variance / samples),
    observedMin: Math.min(...totals),
    observedMax: Math.max(...totals),
    meanDirect: sumDirect / samples,
    meanDot: sumDot / samples,
  };
  return result;
}

/** Convenience alias matching the plan's public API name. */
export function calculateStaticCycle(data: SimulationData, preset: Preset, options: SimulationOptions = {}): SimulationResult {
  return simulateScenario(data, { ...preset, simulation: { ...preset.simulation, mode: "staticCycle" } }, options);
}
