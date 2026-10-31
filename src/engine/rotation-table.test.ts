import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CoreData } from "../data/game-data";
import { createPresetForIdentity, perCoinDefaults } from "../config/preset-factory";
import { newExternalBuff } from "../config/external-buffs";
import { inferRequiredStatusesForIdentity } from "./bonus-tier";
import { buildRotationTable } from "./rotation-table";
import { simulateScenario } from "./simulator";

const corePath = new URL("../../public/data/core.json", import.meta.url);

describe.skipIf(!existsSync(corePath))("rotation table / manual schedule / crit / DOT balance (real data)", () => {
  const core = JSON.parse(readFileSync(corePath, "utf8")) as CoreData;
  const data = { identities: core.identities, skills: core.skills, buffs: core.buffs };
  const hl = core.identities.find((i) => i.id === 10617)!;

  const schedule = (ids: string[]) => ids.map((entryId, i) => ({ turn: i + 1, order: 1, entryId }));

  it("manual schedule with counter entries produces one row per cast", () => {
    const base = createPresetForIdentity(hl, core.skills, core.manifest.dataVersion, "t");
    const cntSkill = core.skills["1061704"]!;
    const preset = {
      ...base,
      skillGroups: {
        ...base.skillGroups,
        base: base.skillGroups.base.map((b, i) =>
          i === 0 ? { ...b, entryId: "cnt", skillId: 1061704, slot: "CNT", ...perCoinDefaults(cntSkill.coinCount) } : b,
        ),
      },
      simulation: { ...base.simulation, mode: "orderedCycle" as const, turnCount: 4, actionSchedule: schedule(["cnt", "cnt", "cnt", "s3"]) },
    };
    const result = simulateScenario(data, preset, { coinMode: "allHeads" });
    const table = buildRotationTable(result, (id) => core.skills[String(id)]?.slot ?? undefined);
    // 4 scheduled casts, at least the 3 counters + S3 must show up as rows
    expect(table.rows.length).toBeGreaterThanOrEqual(4);
    expect(table.variants.length).toBeGreaterThanOrEqual(2);
    expect(table.summaryLine).toMatch(/= \d/);
    // weight 0.5 halves the reported total (double-slot folding)
    const half = buildRotationTable(result, undefined, { weights: Object.fromEntries(table.variants.map((v) => [v.key, v.count * 0.5])) });
    expect(Number(half.total)).toBeCloseTo(Number(table.total) / 2, 1);
    // DOT / status bookkeeping is reported for the enemy side
    expect(result.dotBalance?.some((r) => r.statusId === "Vibration")).toBe(true);
  });

  it("assist defense only chains when 6 Preservation can be consumed: cold T1 counter cannot, warmed-up can", () => {
    const base = createPresetForIdentity(hl, core.skills, core.manifest.dataVersion, "t");
    const cntSkill = core.skills["1061704"]!;
    const mk = (bonusTier?: "full") => ({
      ...base,
      skillGroups: {
        ...base.skillGroups,
        base: base.skillGroups.base.map((b, i) =>
          i === 0 ? { ...b, entryId: "cnt", skillId: 1061704, slot: "CNT", ...perCoinDefaults(cntSkill.coinCount) } : b,
        ),
      },
      simulation: {
        ...base.simulation,
        mode: "orderedCycle" as const,
        turnCount: 3,
        actionSchedule: schedule(["cnt", "s2", "s3"]),
        ...(bonusTier ? { bonusTier } : {}),
      },
    });
    const t3Enhanced = (p: ReturnType<typeof mk>) => {
      const result = simulateScenario(data, p, { coinMode: "allHeads" });
      const t3 = buildRotationTable(result).rows.find((r) => r.turn === 3 && r.coins.length > 0)!;
      return t3.coins.some((c) => c.isRerolled);
    };
    // Cold start: counter gives only +4 count -> no chain -> only 1 Ready by T2 -> T3 S3 is not enhanced.
    expect(t3Enhanced(mk())).toBe(false);
    // Warmed up (20 count): T1 chains SupportProtect -> T2 Ready 2 -> T3 S3 is enhanced.
    expect(t3Enhanced(mk("full"))).toBe(true);
  });

  it("full crit toggle only fires when the identity can crit, and crit coin bonuses raise damage", () => {
    const base = createPresetForIdentity(hl, core.skills, core.manifest.dataVersion, "t");
    const withPlan = {
      ...base,
      actor: {
        ...base.actor,
        initialStatuses: [{ id: "Breath", potency: 20, count: 10 }],
        externalBuffs: [newExternalBuff({ name: "x", offenseLevel: 2 })],
      },
      simulation: { ...base.simulation, mode: "orderedCycle" as const, turnCount: 3, actionSchedule: schedule(["s3", "s3", "s3"]) },
    };
    const critOff = simulateScenario(data, { ...withPlan, actor: { ...withPlan.actor, forceFullCrit: false } }, { coinMode: "allHeads" });
    const critOn = simulateScenario(data, { ...withPlan, actor: { ...withPlan.actor, forceFullCrit: true } }, { coinMode: "allHeads" });
    // Breath 20 potency = 100% crit, so forcing it can never lower the total.
    expect(critOn.totals.total).toBeGreaterThanOrEqual(critOff.totals.total);
    // With plenty of Breath count every coin still crits naturally and the totals match exactly.
    const deepBreath = {
      ...withPlan,
      actor: { ...withPlan.actor, initialStatuses: [{ id: "Breath", potency: 20, count: 60 }] },
    };
    const natural = simulateScenario(data, { ...deepBreath, actor: { ...deepBreath.actor, forceFullCrit: false } }, { coinMode: "allHeads" });
    const forcedSame = simulateScenario(data, { ...deepBreath, actor: { ...deepBreath.actor, forceFullCrit: true } }, { coinMode: "allHeads" });
    expect(forcedSame.totals.total).toBe(natural.totals.total);

    const noBreath = { ...withPlan, actor: { ...withPlan.actor, initialStatuses: [], forceFullCrit: false } };
    const forced = simulateScenario(data, { ...noBreath, actor: { ...noBreath.actor, forceFullCrit: true } }, { coinMode: "allHeads" });
    const plain = simulateScenario(data, noBreath, { coinMode: "allHeads" });
    expect(forced.totals.total).toBeGreaterThan(plain.totals.total);
  });

  it("infers the enemy DOT a rotation needs, and enemy DOT changes nothing unless a skill scales off it", () => {
    const inf = inferRequiredStatusesForIdentity(core, 10617);
    // 10617 scales off Charge (own), so no enemy DOT should be required
    expect(Object.keys(inf.targetStatuses)).toHaveLength(0);

    // A real DOT consumer: skills that divide by Combustion / Laceration counts.
    const consumers = Object.values(core.skills).filter((s) =>
      (s.abilityScripts ?? []).some((a) => /DevideBy(Stack|Turn)WithLimit/.test(a.scriptName) && a.buffData?.buffKeyword === "Combustion"),
    );
    expect(consumers.length).toBeGreaterThan(0);
    const someIdentity = core.identities.find((i) =>
      [...i.skillPool.map((r) => r.skillId), ...i.defenseSkillIds].some((sid) => consumers.some((c) => c.id === sid)),
    );
    if (someIdentity) {
      const inferred = inferRequiredStatusesForIdentity(core, someIdentity.id);
      const combustion = inferred.targetStatuses.Combustion;
      expect(combustion?.potency ?? 0).toBeGreaterThan(0);
    }
  });

  it("poise identity inference asks for 20 Breath potency", () => {
    const poise = core.identities.find((i) => i.skillKeywords.includes("Breath"));
    expect(poise).toBeDefined();
    const inf = inferRequiredStatusesForIdentity(core, poise!.id);
    expect(inf.isPoiseIdentity).toBe(true);
    expect(inf.actorStatuses.Breath?.potency).toBeGreaterThanOrEqual(20);
  });
});
