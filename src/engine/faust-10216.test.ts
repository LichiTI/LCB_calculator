import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CoreData } from "../data/game-data";
import { createPresetForIdentity } from "../config/preset-factory";
import { simulateScenario } from "./simulator";
import { optimizeSchedule } from "./optimizer";

const corePath = new URL("../../public/data/core.json", import.meta.url);

describe.skipIf(!existsSync(corePath))("Dawn Faust 10216 resource kit", () => {
  const core = JSON.parse(readFileSync(corePath, "utf8")) as CoreData;
  const simData = { identities: core.identities, skills: core.skills, buffs: core.buffs };
  const id = core.identities.find((i) => i.id === 10216);

  it.skipIf(!id)("builds Cello Case stacks, rerolls and transforms", () => {
    const p = createPresetForIdentity(id!, core.skills, core.manifest.dataVersion, "faust");
    const res = simulateScenario(simData, p, { coinMode: "allHeads" });
    const notes = res.events.filter((e) => e.kind === "note").map((e) => `T${e.turn} ${e.message}`);
    const cello = res.statusApplications
      .filter((s) => /StigmaWorkshopCelloCase/.test(s.statusId))
      .map((s) => `T${s.turn} ${s.reason} ${s.before.potency}->${s.after.potency}`);
    expect(cello.length).toBeGreaterThan(0);
    expect(notes.some((n) => n.includes("1021603 → 1021606"))).toBe(true);
    expect(notes.some((n) => /重投 \(Reuse ×2\)/.test(n))).toBe(true);
  });

  // Regression baselines (see data/reports/faust-10216-check.md). AttackDmgMultiplierByBuffStackBoth10216 is per hit:
  // T6 1021606 coin damage 11/16/21/26/31 (was 357 total while it was snapshotted at skill start).
  it.skipIf(!id)("default 6T total = 361 (direct 341 + DoT 20)", () => {
    const p = createPresetForIdentity(id!, core.skills, core.manifest.dataVersion, "faust");
    const res = simulateScenario(simData, p, { coinMode: "allHeads" });
    expect(res.totals.direct).toBe(341);
    expect(res.totals.dotHp).toBe(20);
    expect(res.totals.total).toBe(361);
    const t6 = res.events.filter((e) => e.kind === "coin" && e.turn === 6).map((e) => (e as { damage: number }).damage);
    expect(t6).toEqual([11, 16, 21, 26, 31]);
  });

  it.skipIf(!id)("optimizer 6T single-slot best = 377", () => {
    const p = createPresetForIdentity(id!, core.skills, core.manifest.dataVersion, "faust");
    const o = optimizeSchedule(simData, p, { slots: 1, turns: 6 });
    expect(o.best?.total).toBe(377);
    expect(o.worst?.total).toBe(291);
  }, 120000);
});
