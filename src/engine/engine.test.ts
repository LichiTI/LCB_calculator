import { describe, expect, it } from "vitest";
import {
  applyCoinToPower,
  calculateClashLevelPowerAdder,
  calculateCoinAttackDamage,
  clashCountBonusTerm,
  coinHeadsProbability,
  criticalBonusTerm,
  levelDiffBonusTerm,
  resistanceBonusTerm,
} from "./formula";
import { DeterministicRng } from "./prng";
import {
  StatusContainer,
  triggerBurstOnHit,
  triggerCombustionOnRoundEnd,
  triggerLacerationOnAttackCoinToss,
  triggerSinkingOnHit,
  triggerSinkingSurge,
  triggerVibrationExplosion,
} from "./status";
import { calculateStaticCycle, simulateScenario, type SimulationData } from "./simulator";
import type { Preset } from "../config/preset-types";
import type { NormalizedIdentity, NormalizedSkill } from "../config/game-data";

describe("formula.ts — verified GameAssembly.dll combat formulas", () => {
  it("computes piecewise resistance bonus term f_res(R) (GiveAttackDamage @ 0x14B2C6F)", () => {
    expect(resistanceBonusTerm(2.0)).toBeCloseTo(1.0, 6);
    expect(resistanceBonusTerm(1.5)).toBeCloseTo(0.5, 6);
    expect(resistanceBonusTerm(1.0)).toBeCloseTo(0.0, 6);
    // Crucial: 0 <= R < 1 multiplies (R - 1) by 0.5
    expect(resistanceBonusTerm(0.75)).toBeCloseTo(-0.125, 6);
    expect(resistanceBonusTerm(0.5)).toBeCloseTo(-0.25, 6);
    expect(resistanceBonusTerm(0.0)).toBeCloseTo(-0.5, 6);
    expect(resistanceBonusTerm(-0.5)).toBeCloseTo(-0.5, 6);
  });

  it("computes offense vs defense level difference term diff / (|diff| + 25)", () => {
    expect(levelDiffBonusTerm(60, 60)).toBe(0);
    expect(levelDiffBonusTerm(85, 60)).toBeCloseTo(25 / 50, 6);
    expect(levelDiffBonusTerm(35, 60)).toBeCloseTo(-25 / 50, 6);
  });

  it("computes clash skill power result adder max(0, trunc(diff / 3))", () => {
    expect(calculateClashLevelPowerAdder(60, 60)).toBe(0);
    expect(calculateClashLevelPowerAdder(62, 60)).toBe(0);
    expect(calculateClashLevelPowerAdder(63, 60)).toBe(1);
    expect(calculateClashLevelPowerAdder(68, 60)).toBe(2);
    expect(calculateClashLevelPowerAdder(50, 60)).toBe(0);
  });

  it("computes critical bonus (0.2 + adder) * max(0, 1 + mult) and clash count bonus (0.03 * count)", () => {
    expect(criticalBonusTerm(false)).toBe(0);
    expect(criticalBonusTerm(true)).toBeCloseTo(0.2, 6);
    expect(criticalBonusTerm(true, 0.1, 0.5)).toBeCloseTo(0.45, 6);
    expect(clashCountBonusTerm(0)).toBe(0);
    expect(clashCountBonusTerm(3)).toBeCloseTo(0.09, 6);
  });

  it("computes coin heads probability and positive / negative coin rolls", () => {
    expect(coinHeadsProbability(0)).toBeCloseTo(0.5, 6);
    expect(coinHeadsProbability(45)).toBeCloseTo(0.95, 6);
    expect(coinHeadsProbability(-45)).toBeCloseTo(0.05, 6);
    expect(coinHeadsProbability(60)).toBe(1);

    // Positive coin (ADD)
    expect(applyCoinToPower(4, "ADD", 3, 1, true)).toEqual({ nextPower: 8, effectiveScale: 4 });
    expect(applyCoinToPower(4, "ADD", 3, 1, false)).toEqual({ nextPower: 4, effectiveScale: 4 });

    // Negative coin (SUB): heads subtracts scale, tails keeps current power
    expect(applyCoinToPower(12, "SUB", 5, 0, true)).toEqual({ nextPower: 7, effectiveScale: 5 });
    expect(applyCoinToPower(12, "SUB", 5, 0, false)).toEqual({ nextPower: 12, effectiveScale: 5 });
    // Clamped to >= 0
    expect(applyCoinToPower(3, "SUB", 5, 0, true)).toEqual({ nextPower: 0, effectiveScale: 5 });
    // Negative scale adder cannot reduce effectiveScale below 0
    expect(applyCoinToPower(4, "ADD", 2, -5, true)).toEqual({ nextPower: 4, effectiveScale: 0 });
  });

  it("calculates single-coin attack damage with floor and min guarantee max(1, floor(P*0.05))", () => {
    const normal = calculateCoinAttackDamage({
      rolledPower: 10,
      atkResist: 1.0,
      sinResist: 1.0,
      offenseLevel: 60,
      defenseLevel: 60,
      isCritical: false,
      attackDmgMultiplier: 0.2,
      takeAttackDmgMultiplier: 0,
    });
    expect(normal.staticMultiplier).toBeCloseTo(1.0, 6);
    expect(normal.dynamicMultiplier).toBeCloseTo(1.2, 6);
    expect(normal.resolvedDamage).toBe(12);

    // Endure (0.5 physical, 0.5 sin) -> static = 1 - 0.25 - 0.25 = 0.5
    const endure = calculateCoinAttackDamage({
      rolledPower: 10,
      atkResist: 0.5,
      sinResist: 0.5,
      offenseLevel: 60,
      defenseLevel: 60,
      isCritical: false,
      attackDmgMultiplier: 0,
      takeAttackDmgMultiplier: 0,
    });
    expect(endure.staticMultiplier).toBeCloseTo(0.5, 6);
    expect(endure.resolvedDamage).toBe(5);

    // Extreme negative dynamic multiplier triggers minimum guarantee max(1, floor(40 * 0.05)) = 2
    const minGuarantee = calculateCoinAttackDamage({
      rolledPower: 40,
      atkResist: 0.0,
      sinResist: 0.0,
      offenseLevel: 60,
      defenseLevel: 60,
      isCritical: false,
      attackDmgMultiplier: -1.0,
      takeAttackDmgMultiplier: 0,
    });
    expect(minGuarantee.minGuaranteeDamage).toBe(2);
    expect(minGuarantee.resolvedDamage).toBe(2);
  });
});

describe("status.ts — SinBuff / ChargeSinBuff / DOT triggers", () => {
  it("initializes missing dimension to 1 for SinBuff and preserves Charge tier >= 2 when count hits 0", () => {
    const c = new StatusContainer();
    // Applying potency=4, count=0 on empty Burst -> (4, 1)
    c.apply("Burst", 4, 0, 0);
    expect(c.get("Burst")).toMatchObject({ potency: 4, count: 1 });
    // Subsequent potency=2, count=0 -> (6, 1)
    c.apply("Burst", 2, 0, 0);
    expect(c.get("Burst")).toMatchObject({ potency: 6, count: 1 });

    // Charge: adding count=5, potency=0 -> potency=1, count=5
    c.apply("Charge", 0, 5, 0);
    expect(c.get("Charge")).toMatchObject({ potency: 1, count: 5 });
    // Consuming all 5 count at tier 1 destroys Charge
    c.consumeCount("Charge", 5);
    expect(c.get("Charge")).toBeUndefined();

    // Charge at tier 2 (potency=2, count=3) persists when count drops to 0
    c.apply("Charge", 2, 3, 0);
    c.consumeCount("Charge", 3);
    expect(c.get("Charge")).toMatchObject({ potency: 2, count: 0 });
  });

  it("triggers Burst, Sinking, SinkingSurge, Laceration, Combustion, and VibrationExplosion accurately", () => {
    const c = new StatusContainer();
    c.apply("Burst", 5, 2, 0);
    const b1 = triggerBurstOnHit(c, 1, "hit1");
    expect(b1).toMatchObject({ hpDamage: 5, countBefore: 2, countAfter: 1 });
    const b2 = triggerBurstOnHit(c, 1, "hit2");
    expect(b2).toMatchObject({ hpDamage: 5, countBefore: 1, countAfter: 0 });
    expect(c.get("Burst")).toBeUndefined();

    // Sinking: SP damage when targetHasSp=true, rounded gloom HP damage when targetHasSp=false
    c.apply("Sinking", 6, 2, 0);
    const sSp = triggerSinkingOnHit(c, 1, true, 1.5, "hitSp");
    expect(sSp).toMatchObject({ hpDamage: 0, spDamage: 6, countAfter: 1 });
    const sHp = triggerSinkingOnHit(c, 1, false, 1.5, "hitHp");
    expect(sHp).toMatchObject({ hpDamage: 9, spDamage: 0, countAfter: 0 });

    // SinkingSurge: potency * count * gloomResist and destroys Sinking
    c.apply("Sinking", 10, 4, 0);
    const surge = triggerSinkingSurge(c, 1, false, 1.2, "surge");
    expect(surge).toMatchObject({ hpDamage: 48, countBefore: 4, countAfter: 0 });
    expect(c.get("Sinking")).toBeUndefined();

    // Combustion & Laceration & VibrationExplosion
    c.apply("Combustion", 7, 1, 0);
    expect(triggerCombustionOnRoundEnd(c, 1)).toMatchObject({ hpDamage: 7, countAfter: 0 });
    c.apply("Laceration", 4, 1, 0);
    expect(triggerLacerationOnAttackCoinToss(c, 1, "toss")).toMatchObject({ hpDamage: 4, countAfter: 0 });
    c.apply("Vibration", 8, 2, 0);
    expect(triggerVibrationExplosion(c, 1, "burst")).toMatchObject({ hpDamage: 0, staggerShift: 8, countAfter: 2 });
  });
});

describe("simulator.ts — static cycle, multi-turn DOT, modifiers, and deterministic PRNG", () => {
  const mockIdentity: NormalizedIdentity = {
    id: 10101,
    characterId: 1,
    rank: 3,
    updatedDate: 20260101,
    appearance: "Test",
    uptie: 4,
    unitKeywords: [],
    associations: [],
    skillKeywords: [],
    uniqueAttribute: "CRIMSON",
    hp: { base: 70, perLevel: 2.5 },
    defCorrection: 0,
    speed: { min: 4, max: 7 },
    staggerThresholdsPct: [65, 35, 15],
    atkResist: { SLASH: 1, PENETRATE: 0.5, HIT: 2 },
    skills: [],
    defenseSkillIds: [],
    Passives: [],
    battlePassiveIds: [],
    supporterPassiveIds: [],
    passiveConflicts: [],
    initBuffs: [],
    warnings: [],
  } as unknown as NormalizedIdentity;

  const mockSkill: NormalizedSkill = {
    id: 1010101,
    file: "test",
    skillType: "SKILL",
    skillTier: 1,
    slot: "S1",
    requireIDList: [],
    owners: [10101],
    discoveredVia: ["attributeList"],
    levelsAvailable: [1, 2, 3, 4],
    levelsMerged: [1, 2, 3, 4],
    fieldSourceLevel: {},
    basePower: 4,
    coinCount: 2,
    attrs: {
      attributeType: "AZURE",
      atkType: "SLASH",
      defType: "ATTACK",
      skillLevelCorrection: 0,
    },
    abilityScripts: [
      {
        scriptName: "CoinScaleAdderViaBuffCheck",
        buffData: { buffKeyword: "Sinking", buffOwner: "Target", stack: 1, turn: 0, value: 1 },
      },
    ],
    coins: [
      {
        index: 0,
        operatorType: "ADD",
        scale: 3,
        abilityScriptList: [
          {
            scriptName: "GiveBuffOnSucceedAttack",
            buffData: { buffKeyword: "Sinking", target: "Target", stack: 2, turn: 2, activeRound: 0 },
          },
        ],
      },
      {
        index: 1,
        operatorType: "ADD",
        scale: 3,
        abilityScriptList: [
          {
            scriptName: "GiveBuffOnSucceedAttack",
            buffData: { buffKeyword: "Combustion", target: "Target", stack: 5, turn: 2, activeRound: 0 },
          },
        ],
      },
    ],
  };

  const simData: SimulationData = {
    identities: [mockIdentity],
    skills: { "1010101": mockSkill },
    buffs: {},
  };

  function makePreset(): Preset {
    return {
      schemaVersion: 1,
      presetId: "test-preset",
      name: "Test Preset",
      dataVersion: "test",
      rulesVersion: null,
      actor: {
        identityId: 10101,
        uptie: 4,
        level: 60,
        initialSp: 0,
        battlePassives: "none",
      },
      skillGroups: {
        base: [
          {
            entryId: "s1",
            skillId: 1010101,
            usesPerCycle: 1,
            basePower: null,
            totalCoinPowerDelta: 0,
            totalDamageBonusPct: 0,
            totalExtraDamage: {
              fixedDamage: 0,
              ratioPct: 0,
              reference: "resolvedHitDamage",
              trigger: "afterSkill",
              modifierPolicy: "fixed",
              canTriggerOnHit: false,
            },
            coinPowerDeltas: [0, 0],
            coinDamageBonusPcts: [0, 0],
            coinDots: [{}, {}],
          },
        ],
        followUps: [],
      },
      scenario: {
        target: {
          hpMode: "unlimited",
          hp: null,
          defenseLevel: 60,
          hasSp: false,
          physicalResistances: { slash: 1, pierce: 1, blunt: 1 },
          sinResistances: { wrath: 1, lust: 1, sloth: 1, gluttony: 1, gloom: 1, pride: 1, envy: 1 },
          initialStatuses: [],
        },
      },
      simulation: {
        mode: "multiTurn",
        turnCount: 1,
        seed: 42,
        samples: 50,
        actionSchedule: [{ turn: 1, order: 1, entryId: "s1" }],
      },
    };
  }

  it("evaluates live CoinScaleAdderViaBuffCheck after coin 1 applies Sinking and triggers Sinking + Combustion", () => {
    const preset = makePreset();
    const res = simulateScenario(simData, preset, { coinMode: "allHeads" });
    expect(res.exact).toBe(true);
    // Coin 1: no Sinking yet -> scale=3 -> power=4+3=7 -> 7 direct dmg; then applies Sinking (2,2)
    // Coin 2: Target now has Sinking >= 1 -> live CoinScaleAdder +1 -> scale=4 -> power=7+4=11 -> 11 direct dmg;
    //         on hit triggers Sinking (2 gloom HP dmg, count 2->1) and applies Combustion (5,2)
    // Round end: Combustion triggers for 5 HP dmg (count 2->1)
    expect(res.totals.direct).toBe(7 + 11);
    expect(res.totals.dotHp).toBe(2 + 5);
    expect(res.totals.total).toBe(25);
  });

  it("resets statuses and excludes round-end Combustion in staticCycle mode, while applying manual modifiers", () => {
    const preset = makePreset();
    preset.skillGroups.base[0]!.basePower = 6;
    preset.skillGroups.base[0]!.totalCoinPowerDelta = 1;
    preset.skillGroups.base[0]!.coinPowerDeltas = [1, 0];
    preset.skillGroups.base[0]!.totalDamageBonusPct = 50;
    preset.skillGroups.base[0]!.coinDots = [{ Burst: { potency: 3, count: 1 } }, {}];

    const res = calculateStaticCycle(simData, preset, { coinMode: "allHeads" });
    // Coin 1: base 6 + scale (3 + 1 + 1 = 5) = 11; * 1.5 = floor(16.5) = 16; applies Sinking(2,2) + manual Burst(3,1)
    // Coin 2: live Sinking check (+1) + totalCoinPowerDelta (+1) -> scale (3 + 2 = 5) -> power 11 + 5 = 16; * 1.5 = 24;
    //         triggers Burst (3) + Sinking (2) = 5 DOT HP; no round-end Combustion in staticCycle
    expect(res.totals.direct).toBe(16 + 24);
    expect(res.totals.dotHp).toBe(5);
    expect(res.totals.total).toBe(45);
  });

  it("produces bit-identical Monte Carlo results for the same seed", () => {
    const preset = makePreset();
    const r1 = simulateScenario(simData, preset, { coinMode: "monteCarlo", seed: 12345, samples: 100 });
    const r2 = simulateScenario(simData, preset, { coinMode: "monteCarlo", seed: 12345, samples: 100 });
    expect(r1.monteCarlo).toEqual(r2.monteCarlo);
    expect(new DeterministicRng(99).nextFloat()).toBe(new DeterministicRng(99).nextFloat());
  });

  it("applies VolatileBuffs (Enhancement, AttackDmgUp, Vulnerable, Protection, Paralysis) and marks exact=true", () => {
    const preset = makePreset();
    preset.actor.initialStatuses = [
      { id: "Enhancement", potency: 2, count: 2 },
      { id: "AttackDmgUp", potency: 3, count: 3 },
      { id: "Paralysis", potency: 1, count: 1 },
    ];
    (preset.scenario.target as Record<string, unknown>).initialStatuses = [
      { id: "Vulnerable", potency: 2, count: 2 },
      { id: "Protection", potency: 1, count: 1 },
    ];

    const res = simulateScenario(simData, preset, { coinMode: "allHeads" });
    expect(res.exact).toBe(true);
    // Coin 1: Paralysis overrides coinScale to 0 (and consumes 1 stack of Paralysis) -> power = 4;
    //         Enhancement(2) adds +2 to rolledPower -> rolledPower = 6;
    //         dynamicMultiplier = 1 + 0.3 (AttackDmgUp 3) + (0.2 - 0.1) (Vulnerable 2, Protection 1) = 1.4
    //         damage = floor(6 * 1.4) = 8; applies Sinking(2,2)
    // Coin 2: Paralysis is now 0 -> scale = 3 + 1(Sinking check) = 4 -> power = 4 + 4 = 8;
    //         rolledPower = 8 + 2(Enhancement) = 10; * 1.4 = 14
    expect(res.totals.direct).toBe(8 + 14);
  });
});
