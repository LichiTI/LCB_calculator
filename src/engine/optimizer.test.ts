import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CoreData } from "../data/game-data";
import { createPresetForIdentity, perCoinDefaults } from "../config/preset-factory";
import { optimizeSchedule } from "./optimizer";
import { analyzeSkillBonusCap } from "./bonus-tier";
import { newExternalBuff } from "../config/external-buffs";
import { simulateScenario } from "./simulator";

const corePath = new URL("../../public/data/core.json", import.meta.url);

describe.skipIf(!existsSync(corePath))("6T optimizer & bonus tiers (real data)", () => {
  const core = JSON.parse(readFileSync(corePath, "utf8")) as CoreData;
  const data = { identities: core.identities, skills: core.skills, buffs: core.buffs };
  const hl = core.identities.find((i) => i.id === 10617)!;

  it("bonus cap analysis for 10617 skills", () => {
    const caps = Object.fromEntries([1061701, 1061702, 1061703, 1061704].map((id) => [id, analyzeSkillBonusCap(core.skills[String(id)]!)]));
    // S1: dmg +10% cap, coin power +2 (consume 3 count x2)
    expect(caps[1061701]!.dmg).toBeCloseTo(0.1);
    expect(caps[1061701]!.coinPower).toBe(2);
    expect(caps[1061703]!.dmg).toBeCloseTo(0.3);
    expect(caps[1061703]!.coinPower).toBe(3);
    expect(caps[1061704]!.dmg).toBeCloseTo(0.75);
  });

  it("external buffs raise damage; tiers are monotonic", () => {
    const base = createPresetForIdentity(hl, core.skills, core.manifest.dataVersion, "t");
    const run = (tier: string, ext = false) =>
      simulateScenario(data, {
        ...base,
        actor: { ...base.actor, externalBuffs: ext ? [newExternalBuff({ name: "x", dmgPct: 10, offenseLevel: 2 })] : [] },
        simulation: { ...base.simulation, bonusTier: tier },
      }).totals.total;
    const none = run("none");
    const power = run("power");
    const full = run("full");
    expect(power).toBeGreaterThanOrEqual(none);
    expect(full).toBeGreaterThanOrEqual(power);
    expect(run("full", true)).toBeGreaterThan(full);
  }, 20000);

  it("enumerates single (60) and double (13860) slot schedules", () => {
    const preset = createPresetForIdentity(hl, core.skills, core.manifest.dataVersion, "t");
    const single = optimizeSchedule(data, preset, { slots: 1 });
    expect(single.evaluated).toBe(60);
    expect(single.best!.total).toBeGreaterThanOrEqual(single.worst!.total);
    const t0 = Date.now();
    const dbl = optimizeSchedule(data, preset, { slots: 2 });
    expect(dbl.evaluated).toBe(13860);
    console.log("10617 single best (S1x3,S2x2,S3x1):", single.best, "worst", single.worst?.total);
    console.log("10617 double best (S1x3,S2x2,S3x1):", dbl.best, "worst", dbl.worst?.total, `${Date.now() - t0}ms`);

    // Now test S1 replaced with Counter (1061704 Customer Announcement: CNTx3, S2x2, S3x1)
    const cntSkill = core.skills["1061704"]!;
    const cntPreset = {
      ...preset,
      skillGroups: {
        ...preset.skillGroups,
        base: preset.skillGroups.base.map((b, i) =>
          i === 0 ? { ...b, entryId: "cnt", skillId: 1061704, slot: "CNT", ...perCoinDefaults(cntSkill.coinCount) } : b,
        ),
      },
    };
    const cntSingle = optimizeSchedule(data, cntPreset, { slots: 1 });
    const cntDouble = optimizeSchedule(data, cntPreset, { slots: 2 });
    console.log("10617 single best (CNTx3,S2x2,S3x1):", cntSingle.best, "worst", cntSingle.worst?.total);
    console.log("10617 double best (CNTx3,S2x2,S3x1):", cntDouble.best, "worst", cntDouble.worst?.total);
    expect(cntSingle.best!.total).toBeGreaterThan(single.best!.total);
    expect(cntDouble.best!.total).toBeGreaterThan(dbl.best!.total);
  }, 120000);

  it("12T single slot enumerates 2 valid consecutive decks (60 x 60) and normalizes to a 6-skill wheel", () => {
    const preset = createPresetForIdentity(hl, core.skills, core.manifest.dataVersion, "t");
    const r = optimizeSchedule(data, preset, { slots: 1, turns: 12 });
    expect(r.evaluated).toBe(3600);
    expect(r.turns).toBe(12);
    const best = r.best!;
    // each 6-turn half is one complete 3/2/1 deck
    for (const half of [best.turns.slice(0, 6), best.turns.slice(6)]) {
      const flat = half.flat();
      expect(flat.filter((x) => x === "s3")).toHaveLength(1);
      expect(flat.filter((x) => x === "s2")).toHaveLength(2);
    }
    expect(best.wheelTotal).toBeCloseTo(best.total / 2, 0);
  }, 120000);

  it("ranks by expected value (CRN Monte Carlo) and reports timings; all-heads stays the default", () => {
    const preset = createPresetForIdentity(hl, core.skills, core.manifest.dataVersion, "t");
    const ah = optimizeSchedule(data, preset, { slots: 1 });
    expect(ah.rankBy).toBe("allHeads");
    expect(ah.best!.ev).toBeUndefined();
    const ev6 = optimizeSchedule(data, preset, { slots: 1, rankBy: "expected" });
    const ev6b = optimizeSchedule(data, preset, { slots: 1, rankBy: "expected" });
    expect(ev6.evaluated).toBe(60);
    expect(ev6.best!.ev!.samples).toBe(150);
    expect(ev6.best!.ev!.mean).toBe(ev6b.best!.ev!.mean); // reproducible (fixed seed)
    for (let i = 1; i < ev6.top.length; i++) expect(ev6.top[i - 1]!.ev!.mean).toBeGreaterThanOrEqual(ev6.top[i]!.ev!.mean);
    expect(ev6.best!.ev!.p10).toBeLessThanOrEqual(ev6.best!.ev!.p90);
    const ah12 = optimizeSchedule(data, preset, { slots: 1, turns: 12 });
    const ev12 = optimizeSchedule(data, preset, { slots: 1, turns: 12, rankBy: "expected" });
    expect(ev12.evaluated).toBe(3600);
    console.log(`EV ranking timings: 6T ${ev6.elapsedMs}ms (all-heads ${ah.elapsedMs}ms), 12T ${ev12.elapsedMs}ms (all-heads ${ah12.elapsedMs}ms); best6 EV ${ev6.best!.ev!.mean.toFixed(1)} vs AH ${ah.best!.total}; best12 EV ${ev12.best!.ev!.mean.toFixed(1)} vs AH ${ah12.best!.total}`);
  }, 300000);
});
