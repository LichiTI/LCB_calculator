/**
 * Status / Buff state tracking and DOT / SinBuff / VolatileBuff processors.
 *
 * Verified against GameAssembly.dll:
 *   - CountableBuff.OverWriteForSinBuff @ 0x10BA3C0
 *   - CountableBuff.NeedToDestroy @ 0x10BA7A0
 *   - ChargeSinBuff.NeedToDestroy @ 0x2113220
 *   - BuffAbility_Combustion.Ability @ 0x10C8580
 *   - BuffAbility_Laceration.Ability @ 0x10C5620
 *   - BuffAbility_Burst.Ability @ 0x10C5B30
 *   - BuffAbility_Sinking.OnTakeAttackDamage @ 0x10C6090
 *   - BattleUnitModel.SinkingSurge @ 0x14BB7B0
 *   - BattleUnitModel.VibrationExplosion @ 0x14AEF90
 *   - BuffAbility_Breath.GetCriticalChanceAdder @ 0x10CA290
 */

import type { AtkType, NormalizedBuff, SinAttribute } from "../config/game-data";
import { amountSemantics, DOT_IDS, isDotId, type DotId } from "../config/status-terms";

export interface StatusInstance {
  id: string;
  buffClass: string;
  /** Potency (强度) for SinBuff/ChargeSinBuff; stack for VolatileBuff/CountableBuff. */
  potency: number;
  /** Count (层数) for SinBuff/ChargeSinBuff; mirrors potency for single-dimension buffs. */
  count: number;
  maxPotency: number;
  maxCount: number;
}

export interface StatusChangeRecord {
  statusId: string;
  target: "actor" | "target";
  before: { potency: number; count: number };
  after: { potency: number; count: number };
  reason: string;
}

export interface DotTriggerRecord {
  turn: number;
  statusId: DotId | string;
  trigger: "onCoinToss" | "onHit" | "onRoundEnd" | "sinkingSurge" | "vibrationExplosion";
  potencyAtTrigger: number;
  countBefore: number;
  countAfter: number;
  hpDamage: number;
  spDamage: number;
  staggerShift: number;
  sourceDesc: string;
}

const VERIFIED_BUFF_ABILITIES = new Set<string>([
  "AtkSkillPowerResultAdderAsStack",
  "SkillPowerResultAdderAsStack",
  "SkillPowerResultAdder",
  "DefaultSkillPowerAdder",
  "SkillPowerAdder",
  "SkillPowerAdderAsStack",
  "AtkDamageMultiplierByStack",
  "AtkDamageMultiplier",
  "AttackDmgMultiplier",
  "DefaultAtkSkillAtkDamageMultiplier",
  "DefaultAtkSkillAtkDamageMultiplierByStack",
  "TakeAtkDamageMultiplierByStack",
  "TakeAtkDamageMultiplier",
  "TakeAtkDmgMultiplierWarinessHonglu",
  "AtkAdderByStack",
  "DefAdderByStack",
  "AtkAdderPerStack",
  "DefAdderPerStack",
  "AtkAdder",
  "DefAdder",
  "SpeedAdderAsStack",
  "MinSpeedAdder",
  "MaxSpeedAdder",
  "MinSpeedAdderIncludeFirstTurn",
  "MaxSpeedAdderIncludeFirstTurn",
  "CoinScaleAdderByStack",
  "AttributeResistAdderByStack",
  "OverrideCoinScale",
  "LoseStackOnAfterCheckCoin",
  "LoseStackOnRoundEnd",
  "LoseStackOnRoundEndWarinessHonglu",
  "LoseTurnOnRoundEnd",
  "ReadyToListenHonglu",
  "GiveBuffOnRoundEnd",
  "GiveBuffTimeToListenHonglu",
  "ChangeMpTimeToListenHonglu",
  "CantGetBuff",
  "NoirBindArmorAlly",
  "GiveBuffOnTakeAttackDamageIfHasShieldHonglu",
  "DestroyOnGiverDieWarinessHonglu",
  "SupportProtect",
  "ActivateBuffEffect",
  "ActivateBuffEffectSkin",
  "LoseAllStackOnDie",
  "AggroAdderOnRoundStart",
]);

export interface EvaluatedBuffModifiers {
  basePowerAdder: number;
  skillPowerResultAdder: number;
  coinScaleAdder: number;
  coinScaleOverride: number | null;
  attackDmgMultiplier: number;
  takeAttackDmgMultiplier: number;
  offenseLevelAdder: number;
  defenseLevelAdder: number;
  sinResistAdder: number;
}
export class StatusContainer {
  private readonly states = new Map<string, StatusInstance>();
  private readonly nextRoundStates = new Map<string, { potency: number; count: number }>();
  private readonly cumulativeTurnConsumed = new Map<string, number>();
  private readonly gainedThisTurn = new Map<string, number>();

  constructor(private readonly buffDefs: Record<string, NormalizedBuff> = {}) {}

  /** Returns true if a status is fully modelled (either a core DOT/resource or all of its BuffAbilities are verified). */
  isFullyModelled(id: string): boolean {
    if (isDotId(id) || id === "Breath" || id === "Charge") return true;
    const def = this.buffDefs[id];
    if (!def) {
      // Built-in standard VolatileBuff fallbacks when buffDefs is empty (e.g. unit tests)
      return [
        "Enhancement", "Reduction", "AttackDmgUp", "AttackDmgDown",
        "Protection", "Vulnerable", "AttackUp", "AttackDown",
        "DefenseUp", "DefenseDown", "Agility", "Binding",
        "Paralysis", "PlusCoinValueUp", "PlusCoinValueDown",
        "MinusCoinValueUp", "MinusCoinValueDown",
        "SlashDamageUp", "PenetrateDamageUp", "HitDamageUp",
        "SlashTakeDamageUp", "PenetrateTakeDamageUp", "HitTakeDamageUp",
      ].includes(id);
    }
    if (def.buffClass === "TypoOnlyBuff") return true;
    const list = def.list ?? [];
    if (list.length === 0) return false;
    return list.every((item) => VERIFIED_BUFF_ABILITIES.has(item.ability));
  }

  private getBuiltInAbilities(id: string): { ability: string; value?: number; [k: string]: unknown }[] {
    const def = this.buffDefs[id];
    if (def?.list) return def.list;
    switch (id) {
      case "Enhancement": return [{ ability: "AtkSkillPowerResultAdderAsStack", value: 1 }];
      case "Reduction": return [{ ability: "AtkSkillPowerResultAdderAsStack", value: -1 }];
      case "AttackDmgUp": return [{ ability: "AtkDamageMultiplierByStack", value: 0.1 }];
      case "AttackDmgDown": return [{ ability: "AtkDamageMultiplierByStack", value: -0.1 }];
      case "Protection": return [{ ability: "TakeAtkDamageMultiplierByStack", value: -0.1 }];
      case "Vulnerable": return [{ ability: "TakeAtkDamageMultiplierByStack", value: 0.1 }];
      case "AttackUp": return [{ ability: "AtkAdderByStack", value: 1 }];
      case "AttackDown": return [{ ability: "AtkAdderByStack", value: -1 }];
      case "DefenseUp": return [{ ability: "DefAdderByStack", value: 1 }];
      case "DefenseDown": return [{ ability: "DefAdderByStack", value: -1 }];
      case "Agility": return [{ ability: "SpeedAdderAsStack", value: 1 }];
      case "Binding": return [{ ability: "SpeedAdderAsStack", value: -1 }];
      case "Paralysis": return [{ ability: "OverrideCoinScale", value: 0 }, { ability: "LoseStackOnAfterCheckCoin", value: 1 }];
      case "PlusCoinValueUp": return [{ ability: "CoinScaleAdderByStack", coinOperator: "ADD", value: 1 }];
      case "PlusCoinValueDown": return [{ ability: "CoinScaleAdderByStack", coinOperator: "ADD", value: -1 }];
      case "MinusCoinValueUp": return [{ ability: "CoinScaleAdderByStack", coinOperator: "SUB", value: 1 }];
      case "MinusCoinValueDown": return [{ ability: "CoinScaleAdderByStack", coinOperator: "SUB", value: -1 }];
      case "SlashDamageUp": return [{ ability: "AtkDamageMultiplierByStack", atk: "SLASH", value: 0.1 }];
      case "PenetrateDamageUp": return [{ ability: "AtkDamageMultiplierByStack", atk: "PENETRATE", value: 0.1 }];
      case "HitDamageUp": return [{ ability: "AtkDamageMultiplierByStack", atk: "HIT", value: 0.1 }];
      case "SlashTakeDamageUp": return [{ ability: "TakeAtkDamageMultiplierByStack", atk: "SLASH", value: 0.1 }];
      case "PenetrateTakeDamageUp": return [{ ability: "TakeAtkDamageMultiplierByStack", atk: "PENETRATE", value: 0.1 }];
      case "HitTakeDamageUp": return [{ ability: "TakeAtkDamageMultiplierByStack", atk: "HIT", value: 0.1 }];
      default: return [];
    }
  }

  /**
   * Evaluate active BuffAbilities on this container for an attack coin / skill.
   * Verified from GameAssembly.dll @ 0x10CA0D0..0x1D11CC0.
   */
  evaluateCombatModifiers(params: {
    atkType?: AtkType;
    sinAttr?: SinAttribute;
    coinOperator?: string;
    actorSp?: number;
    actorHasTimeToListen?: boolean;
  }): EvaluatedBuffModifiers {
    const out: EvaluatedBuffModifiers = {
      basePowerAdder: 0,
      skillPowerResultAdder: 0,
      coinScaleAdder: 0,
      coinScaleOverride: null,
      attackDmgMultiplier: 0,
      takeAttackDmgMultiplier: 0,
      offenseLevelAdder: 0,
      defenseLevelAdder: 0,
      sinResistAdder: 0,
    };

    for (const inst of this.allActive()) {
      const stack = inst.potency;
      if (stack <= 0) continue;
      for (const item of this.getBuiltInAbilities(inst.id)) {
        const ab = item.ability;
        const val = typeof item.value === "number" ? item.value : 0;
        const atkFilter = typeof item.atk === "string" ? item.atk : undefined;
        const attrFilter = typeof item.attribute === "string" ? item.attribute : undefined;
        if (atkFilter && params.atkType && atkFilter !== params.atkType) continue;
        if (attrFilter && params.sinAttr && attrFilter !== params.sinAttr && ab !== "AttributeResistAdderByStack") continue;

        switch (ab) {
          case "DefaultSkillPowerAdder":
          case "SkillPowerAdder":
            out.basePowerAdder += Math.round(val);
            break;
          case "SkillPowerAdderAsStack": {
            const opFilter = typeof item.coinOperator === "string" ? item.coinOperator : undefined;
            if (!opFilter || !params.coinOperator || opFilter === params.coinOperator) {
              out.basePowerAdder += stack * Math.round(val);
            }
            break;
          }
          case "GiveBuffTimeToListenHonglu":
            // TimeToListenHonglu: at 40+ SP, applies 1 Sloth DMG Up (+10% on AMBER) and 1 Base Power Up to Le Noir identities
            if ((params.actorSp ?? 45) >= 40) {
              out.basePowerAdder += 1;
              if (params.sinAttr === "AMBER") out.attackDmgMultiplier += 0.1;
            }
            break;
          case "AtkSkillPowerResultAdderAsStack":
          case "SkillPowerResultAdderAsStack":
            out.skillPowerResultAdder += stack * Math.round(val);
            break;
          case "SkillPowerResultAdder":
            out.skillPowerResultAdder += Math.round(val);
            break;
          case "AtkDamageMultiplierByStack":
          case "DefaultAtkSkillAtkDamageMultiplierByStack":
            out.attackDmgMultiplier += stack * val;
            break;
          case "AtkDamageMultiplier":
          case "AttackDmgMultiplier":
          case "DefaultAtkSkillAtkDamageMultiplier":
            out.attackDmgMultiplier += val;
            break;
          case "TakeAtkDamageMultiplierByStack":
            out.takeAttackDmgMultiplier += stack * val;
            break;
          case "TakeAtkDmgMultiplierWarinessHonglu":
            if (params.actorHasTimeToListen) {
              out.takeAttackDmgMultiplier += stack * val;
            }
            break;
          case "TakeAtkDamageMultiplier":
            out.takeAttackDmgMultiplier += val;
            break;
          case "AtkAdderByStack":
            out.offenseLevelAdder += Math.round(stack * val);
            break;
          case "DefAdderByStack":
            out.defenseLevelAdder += Math.round(stack * val);
            break;
          case "AtkAdderPerStack": {
            const div = Math.round(val);
            if (div !== 0) out.offenseLevelAdder += Math.trunc(stack / div);
            break;
          }
          case "DefAdderPerStack": {
            const div = Math.round(val);
            if (div !== 0) out.defenseLevelAdder += Math.trunc(stack / div);
            break;
          }
          case "AtkAdder":
            out.offenseLevelAdder += Math.round(val);
            break;
          case "DefAdder":
            out.defenseLevelAdder += Math.round(val);
            break;
          case "CoinScaleAdderByStack": {
            const opFilter = typeof item.coinOperator === "string" ? item.coinOperator : undefined;
            if (!opFilter || !params.coinOperator || opFilter === params.coinOperator) {
              out.coinScaleAdder += stack * Math.round(val);
            }
            break;
          }
          case "AttributeResistAdderByStack":
            if (attrFilter && params.sinAttr && attrFilter === params.sinAttr) {
              out.sinResistAdder += stack * val;
            }
            break;
          case "OverrideCoinScale":
            out.coinScaleOverride = Math.round(val);
            break;
        }
      }
    }
    return out;
  }

  /** Consume LoseStackOnAfterCheckCoin buffs (e.g. Paralysis) after tossing a coin. */
  onAfterCheckCoin(side: "actor" | "target"): StatusChangeRecord[] {
    const changes: StatusChangeRecord[] = [];
    for (const inst of this.allActive()) {
      for (const item of this.getBuiltInAbilities(inst.id)) {
        if (item.ability === "LoseStackOnAfterCheckCoin") {
          const lose = Math.max(1, Math.round(typeof item.value === "number" ? item.value : 1));
          const { before, after } = this.consumeCount(inst.id, lose);
          changes.push({ statusId: inst.id, target: side, before, after, reason: "afterCheckCoinConsume" });
        }
      }
    }
    return changes;
  }

  clone(): StatusContainer {
    const copy = new StatusContainer(this.buffDefs);
    for (const [k, v] of this.states) {
      copy.states.set(k, { ...v });
    }
    for (const [k, v] of this.nextRoundStates) {
      copy.nextRoundStates.set(k, { ...v });
    }
    for (const [k, v] of this.cumulativeTurnConsumed) {
      copy.cumulativeTurnConsumed.set(k, v);
    }
    for (const [k, v] of this.gainedThisTurn) {
      copy.gainedThisTurn.set(k, v);
    }
    return copy;
  }

  /**
   * Resolve a keyword to the actual stored status. Unique variants declare their base keyword in
   * subIdList (e.g. ChargeNoirAlly -> Charge) and are treated as that keyword by effect checks.
   */
  resolveId(id: string): string {
    const s = this.states.get(id);
    if (s && (s.potency > 0 || s.count > 0)) return id;
    for (const [k, inst] of this.states) {
      if (inst.potency <= 0 && inst.count <= 0) continue;
      if (this.buffDefs[k]?.subIdList?.includes(id)) return k;
    }
    return id;
  }

  get(id: string): StatusInstance | undefined {
    const s = this.states.get(this.resolveId(id));
    if (!s || (s.potency <= 0 && s.count <= 0)) return undefined;
    return s;
  }

  getPotency(id: string): number {
    return this.get(id)?.potency ?? 0;
  }

  getCount(id: string): number {
    const s = this.get(id);
    if (!s) return 0;
    return this.isSingleDim(s.buffClass) ? s.potency : s.count;
  }

  private isSingleDim(buffClass: string | undefined): boolean {
    if (amountSemantics(buffClass) === "countOnlyFromStack") return true;
    switch (buffClass) {
      case "SinBuff":
      case "ChargeSinBuff":
      case "UsedTurnReportSinBuff":
      case "CollapsableSinBuff":
      case "CountableBuff":
      case "CountableBuffWithCustomDescParams":
      case "unknown":
      case undefined:
        return false;
      default:
        return true;
    }
  }

  allActive(): StatusInstance[] {
    return [...this.states.values()].filter((s) => s.potency > 0 || s.count > 0);
  }

  private getMeta(id: string): { buffClass: string; maxPotency: number; maxCount: number } {
    const def = this.buffDefs[id];
    const buffClass =
      def?.buffClass ??
      (id === "Charge"
        ? "ChargeSinBuff"
        : isDotId(id) || id === "Breath"
          ? "SinBuff"
          : "VolatileBuff");
    const maxPotency = def?.maxStack ?? (buffClass === "ChargeSinBuff" ? 20 : 99);
    const maxCount = def?.maxTurn ?? (buffClass === "ChargeSinBuff" ? 20 : 99);
    return { buffClass, maxPotency, maxCount };
  }

  /**
   * Apply a status amount to activeRound (0 = this round, 1 = next round).
   * Follows CountableBuff.OverWriteForSinBuff @ 0x10BA3C0:
   *   - For SinBuff (Combustion, Laceration, Vibration, Burst, Sinking, Breath):
   *     * If current status is absent (potency==0 && count==0):
   *       - Applying potency > 0 with count == 0 initializes count = 1.
   *       - Applying count > 0 with potency == 0 initializes potency = 1.
   *   - For ChargeSinBuff (Charge, keyword==6):
   *     * Adding count > 0 with potency == 0 on activeRound==0 initializes potency = 1 (starts at tier 1).
   *   - For VolatileBuff (e.g. Enhancement, Vulnerable, DefenseDown, AttackDmgUp):
   *     * Single-dimension stack (stored in potency; count mirrors potency for countOnlyFromStack).
   */
  apply(
    rawId: string,
    addPotency: number,
    addCount: number,
    activeRound: 0 | 1 = 0,
  ): { before: { potency: number; count: number }; after: { potency: number; count: number } } {
    const id = this.resolveId(rawId);
    const meta = this.getMeta(id);
    const singleDim = this.isSingleDim(meta.buffClass);

    if (activeRound === 1) {
      const prev = this.nextRoundStates.get(id) ?? { potency: 0, count: 0 };
      const next = {
        potency: Math.min(meta.maxPotency, prev.potency + Math.max(0, addPotency)),
        count: Math.min(meta.maxCount, prev.count + Math.max(0, addCount)),
      };
      this.nextRoundStates.set(id, next);
      return { before: prev, after: next };
    }

    const existing = this.states.get(id);
    const before = existing
      ? { potency: existing.potency, count: existing.count }
      : { potency: 0, count: 0 };

    let p = Math.max(0, Math.trunc(addPotency));
    let c = Math.max(0, Math.trunc(addCount));
    if (p === 0 && c === 0 && meta.buffClass !== "UsedTurnReportSinBuff") {
      return { before, after: before };
    }

    if (singleDim) {
      // Single-dimension stack buff: either potency or count input adds to the stack
      let delta = p > 0 ? p : c;
      const limitPerTurn = this.buffDefs[id]?.stackLimitPerTurn;
      if (typeof limitPerTurn === "number" && limitPerTurn > 0) {
        const used = this.gainedThisTurn.get(id) ?? 0;
        delta = Math.max(0, Math.min(delta, limitPerTurn - used));
        if (delta === 0) return { before, after: before };
        this.gainedThisTurn.set(id, used + delta);
      }
      const newStack = Math.min(meta.maxPotency, before.potency + delta);
      const inst: StatusInstance = {
        id,
        buffClass: meta.buffClass,
        potency: newStack,
        count: newStack,
        maxPotency: meta.maxPotency,
        maxCount: meta.maxCount,
      };
      this.states.set(id, inst);
      return { before, after: { potency: inst.potency, count: inst.count } };
    }

    // SinBuff / ChargeSinBuff (two-dimensional: potency = stack, count = turn)
    let curP = before.potency;
    let curC = before.count;

    // CountableBuff.OverWriteForSinBuff @ 0x10BA3C0
    // ChargeSinBuff (Charge): only auto-initializes potency = 1 when count > 0, potency == 0, and activeRound == 0.
    // Standard SinBuff: if absent, adding potency > 0 with count == 0 sets count = 1; adding count > 0 with potency == 0 sets potency = 1.
    if (curP === 0 && curC === 0) {
      if (meta.buffClass === "ChargeSinBuff" || meta.buffClass === "UsedTurnReportSinBuff") {
        if (c > 0 && p === 0) {
          p = 1;
        }
      } else {
        if (p > 0 && c === 0) {
          c = 1;
        } else if (c > 0 && p === 0) {
          p = 1;
        }
      }
    }

    curP = Math.min(meta.maxPotency, curP + p);
    curC = Math.min(meta.maxCount, curC + c);

    const inst: StatusInstance = {
      id,
      buffClass: meta.buffClass,
      potency: curP,
      count: curC,
      maxPotency: meta.maxPotency,
      maxCount: meta.maxCount,
    };
    this.checkDestroy(inst);
    const after = this.states.get(id)
      ? { potency: inst.potency, count: inst.count }
      : { potency: 0, count: 0 };
    return { before, after };
  }

  /** Consume count (turn) from a status (e.g. DOT trigger, Breath crit, Charge spend). */
  consumeCount(
    id: string,
    amount: number,
    isActiveSpend = true,
  ): { before: { potency: number; count: number }; after: { potency: number; count: number } } {
    const resolved = this.resolveId(id);
    const inst = this.states.get(resolved);
    if (!inst) {
      return { before: { potency: 0, count: 0 }, after: { potency: 0, count: 0 } };
    }
    const before = { potency: inst.potency, count: inst.count };
    const want = Math.max(0, Math.trunc(amount));
    const actual = Math.min(inst.count, want);
    inst.count = Math.max(0, inst.count - want);
    if (this.isSingleDim(inst.buffClass)) {
      inst.potency = inst.count;
    } else if (inst.buffClass === "UsedTurnReportSinBuff" && isActiveSpend && actual > 0) {
      const prevCum = this.cumulativeTurnConsumed.get(resolved) ?? 0;
      const nextCum = prevCum + actual;
      this.cumulativeTurnConsumed.set(resolved, nextCum);
      const gained = Math.trunc(nextCum / 10) - Math.trunc(prevCum / 10);
      if (gained > 0) {
        inst.potency = Math.min(inst.maxPotency, inst.potency + gained);
      }
    }
    this.checkDestroy(inst);
    const cur = this.states.get(resolved);
    return {
      before,
      after: cur ? { potency: cur.potency, count: cur.count } : { potency: 0, count: 0 },
    };
  }

  /** Destroy a status completely (e.g. SinkingSurge). */
  destroy(id: string): { potency: number; count: number } {
    const inst = this.states.get(id);
    const before = inst ? { potency: inst.potency, count: inst.count } : { potency: 0, count: 0 };
    this.states.delete(id);
    return before;
  }

  /**
   * Check whether a status expires when count reaches 0:
   *   - SinBuff: destroyed when count <= 0 (potency resets to 0).
   *   - ChargeSinBuff (NeedToDestroy @ 0x2113220 + BuffModel.LoseTurn @ 0x1E619B0):
   *     when count reaches 0, if potency >= 2 (Charge tier >= 2), Charge persists with count = 0;
   *     only destroyed when potency <= 0 || (count <= 0 && potency < 2).
   */
  private checkDestroy(inst: StatusInstance): void {
    if (inst.buffClass === "SinBuff") {
      if (inst.count <= 0 || inst.potency <= 0) {
        this.states.delete(inst.id);
      } else {
        this.states.set(inst.id, inst);
      }
      return;
    }
    if (inst.buffClass === "ChargeSinBuff") {
      if (inst.potency <= 0 || (inst.count <= 0 && inst.potency < 2)) {
        this.states.delete(inst.id);
      } else {
        this.states.set(inst.id, inst);
      }
      return;
    }
    if (inst.buffClass === "UsedTurnReportSinBuff") {
      if (inst.potency <= 0 && inst.count <= 0) {
        this.states.delete(inst.id);
      } else {
        this.states.set(inst.id, inst);
      }
      return;
    }
    if (inst.potency <= 0 && inst.count <= 0) {
      this.states.delete(inst.id);
    } else {
      this.states.set(inst.id, inst);
    }
  }

  /**
   * End-of-round transition:
   * 1. Combustion (Burn) triggers before round-end decay (handled by caller via triggerCombustion).
   * 2. Vibration / Charge / Breath decay 1 count at round end.
   * 3. VolatileBuffs expire at round end, and next-round queued buffs move to active.
   */
  onRoundEndDecay(): StatusChangeRecord[] {
    const changes: StatusChangeRecord[] = [];
    for (const [id, inst] of [...this.states.entries()]) {
      if (inst.buffClass === "VolatileBuff" || inst.buffClass === "VolatileResistBuff") {
        const before = { potency: inst.potency, count: inst.count };
        this.states.delete(id);
        changes.push({ statusId: id, target: "target", before, after: { potency: 0, count: 0 }, reason: "roundEndExpire" });
      } else if (id === "Vibration" || id === "Breath" || id === "Charge") {
        const { before, after } = this.consumeCount(id, 1, false);
        changes.push({ statusId: id, target: "target", before, after, reason: "roundEndCountDecay" });
      } else {
        for (const item of this.getBuiltInAbilities(id)) {
          const val = Math.max(1, Math.round(typeof item.value === "number" ? item.value : 1));
          if (item.ability === "ReadyToListenHonglu" && inst.potency >= 2) {
            const before = { potency: inst.potency, count: inst.count };
            this.states.delete(id);
            changes.push({ statusId: id, target: "actor", before, after: { potency: 0, count: 0 }, reason: "ReadyToListenHonglu->TimeToListenHonglu" });
            const prev = this.nextRoundStates.get("TimeToListenHonglu") ?? { potency: 0, count: 0 };
            this.nextRoundStates.set("TimeToListenHonglu", { potency: Math.max(prev.potency, 2), count: Math.max(prev.count, 2) });
            break;
          } else if (item.ability === "LoseStackOnRoundEnd" || item.ability === "LoseStackOnRoundEndWarinessHonglu") {
            const before = { potency: inst.potency, count: inst.count };
            inst.potency = Math.max(0, inst.potency - val);
            if (this.isSingleDim(inst.buffClass)) inst.count = inst.potency;
            this.checkDestroy(inst);
            const cur = this.states.get(id);
            changes.push({
              statusId: id,
              target: "target",
              before,
              after: cur ? { potency: cur.potency, count: cur.count } : { potency: 0, count: 0 },
              reason: item.ability,
            });
          } else if (item.ability === "LoseTurnOnRoundEnd") {
            const { before, after } = this.consumeCount(id, val, false);
            changes.push({ statusId: id, target: "target", before, after, reason: "LoseTurnOnRoundEnd" });
          }
        }
      }
    }
    // Activate next-round buffs
    for (const [id, queued] of this.nextRoundStates.entries()) {
      if (queued.potency > 0 || queued.count > 0) {
        const { before, after } = this.apply(id, queued.potency, queued.count, 0);
        changes.push({ statusId: id, target: "target", before, after, reason: "activateNextRoundBuff" });
      }
    }
    this.nextRoundStates.clear();
    this.gainedThisTurn.clear();
    return changes;
  }
}

/**
 * Trigger Combustion (Burn) at round end (BuffAbility_Combustion.Ability @ 0x10C8580).
 * Deals potency HP damage and consumes 1 count.
 */
export function triggerCombustionOnRoundEnd(
  statuses: StatusContainer,
  turn: number,
): DotTriggerRecord | null {
  const burn = statuses.get("Combustion");
  if (!burn || burn.potency <= 0 || burn.count <= 0) return null;
  const potency = burn.potency;
  const countBefore = burn.count;
  const { after } = statuses.consumeCount("Combustion", 1);
  return {
    turn,
    statusId: "Combustion",
    trigger: "onRoundEnd",
    potencyAtTrigger: potency,
    countBefore,
    countAfter: after.count,
    hpDamage: potency,
    spDamage: 0,
    staggerShift: 0,
    sourceDesc: "回合结束烧伤结算",
  };
}

/**
 * Trigger Laceration (Bleed) when tossing an offensive skill coin (BuffAbility_Laceration.Ability @ 0x10C5620).
 * Deals potency HP damage and consumes 1 count.
 */
export function triggerLacerationOnAttackCoinToss(
  statuses: StatusContainer,
  turn: number,
  sourceDesc: string,
): DotTriggerRecord | null {
  const bleed = statuses.get("Laceration");
  if (!bleed || bleed.potency <= 0 || bleed.count <= 0) return null;
  const potency = bleed.potency;
  const countBefore = bleed.count;
  const { after } = statuses.consumeCount("Laceration", 1);
  return {
    turn,
    statusId: "Laceration",
    trigger: "onCoinToss",
    potencyAtTrigger: potency,
    countBefore,
    countAfter: after.count,
    hpDamage: potency,
    spDamage: 0,
    staggerShift: 0,
    sourceDesc,
  };
}

/**
 * Trigger Burst (Rupture) on taking attack hit damage (BuffAbility_Burst.Ability @ 0x10C5B30).
 * Deals potency HP damage and consumes 1 count.
 */
export function triggerBurstOnHit(
  statuses: StatusContainer,
  turn: number,
  sourceDesc: string,
): DotTriggerRecord | null {
  const burst = statuses.get("Burst");
  if (!burst || burst.potency <= 0 || burst.count <= 0) return null;
  const potency = burst.potency;
  const countBefore = burst.count;
  const { after } = statuses.consumeCount("Burst", 1);
  return {
    turn,
    statusId: "Burst",
    trigger: "onHit",
    potencyAtTrigger: potency,
    countBefore,
    countAfter: after.count,
    hpDamage: potency,
    spDamage: 0,
    staggerShift: 0,
    sourceDesc,
  };
}

/**
 * Trigger Sinking on taking attack hit damage (BuffAbility_Sinking.OnTakeAttackDamage @ 0x10C6090).
 * - If target has SP (hasSp=true): deals potency SP damage (0 HP damage).
 * - If target has no SP (hasSp=false): deals Math.round(potency * gloomResist) Gloom HP damage (Util.Round @ 0x122CB60).
 * Consumes 1 count.
 */
export function triggerSinkingOnHit(
  statuses: StatusContainer,
  turn: number,
  targetHasSp: boolean,
  gloomResist: number,
  sourceDesc: string,
): DotTriggerRecord | null {
  const sinking = statuses.get("Sinking");
  if (!sinking || sinking.potency <= 0 || sinking.count <= 0) return null;
  const potency = sinking.potency;
  const countBefore = sinking.count;
  const { after } = statuses.consumeCount("Sinking", 1);
  const hpDamage = targetHasSp ? 0 : Math.max(0, Math.round(potency * gloomResist));
  const spDamage = targetHasSp ? potency : 0;
  return {
    turn,
    statusId: "Sinking",
    trigger: "onHit",
    potencyAtTrigger: potency,
    countBefore,
    countAfter: after.count,
    hpDamage,
    spDamage,
    staggerShift: 0,
    sourceDesc,
  };
}

/**
 * Trigger Sinking Surge / Deluge (BattleUnitModel.SinkingSurge @ 0x14BB7B0).
 * Total amount = potency * count. Destroys Sinking.
 */
export function triggerSinkingSurge(
  statuses: StatusContainer,
  turn: number,
  targetHasSp: boolean,
  gloomResist: number,
  sourceDesc: string,
): DotTriggerRecord | null {
  const sinking = statuses.get("Sinking");
  if (!sinking || sinking.potency <= 0 || sinking.count <= 0) return null;
  const potency = sinking.potency;
  const countBefore = sinking.count;
  const rawTotal = potency * countBefore;
  statuses.destroy("Sinking");
  const hpDamage = targetHasSp ? 0 : Math.max(0, Math.round(rawTotal * gloomResist));
  const spDamage = targetHasSp ? rawTotal : 0;
  return {
    turn,
    statusId: "Sinking",
    trigger: "sinkingSurge",
    potencyAtTrigger: potency,
    countBefore,
    countAfter: 0,
    hpDamage,
    spDamage,
    staggerShift: 0,
    sourceDesc,
  };
}

/**
 * Trigger Vibration Explosion / Tremor Burst (BattleUnitModel.VibrationExplosion @ 0x14AEF90).
 * Raises stagger threshold by Vibration potency. Does NOT deal HP damage or consume count by itself.
 */
export function triggerVibrationExplosion(
  statuses: StatusContainer,
  turn: number,
  sourceDesc: string,
): DotTriggerRecord | null {
  const vib = statuses.get("Vibration");
  if (!vib || vib.potency <= 0 || vib.count <= 0) return null;
  return {
    turn,
    statusId: "Vibration",
    trigger: "vibrationExplosion",
    potencyAtTrigger: vib.potency,
    countBefore: vib.count,
    countAfter: vib.count,
    hpDamage: 0,
    spDamage: 0,
    staggerShift: vib.potency,
    sourceDesc,
  };
}

export { DOT_IDS, isDotId, type DotId };
