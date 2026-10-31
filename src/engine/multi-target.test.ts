import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CoreData } from "../data/game-data";
import { createPresetForIdentity } from "../config/preset-factory";
import { simulateScenario } from "./simulator";
import { staticAttackWeight } from "./attack-weight";

const corePath = new URL("../../public/data/core.json", import.meta.url);

describe("staticAttackWeight", () => {
  const self = (pot: Record<string, number>) => ({ getPotency: (k: string) => pot[k] ?? 0, getCount: () => 0 });
  it("targetNum + buffData adders", () => {
    expect(staticAttackWeight({ attrs: { targetNum: 3 } }, self({})).weight).toBe(3);
    const s = { attrs: { targetNum: 1 }, abilityScripts: [{ scriptName: "TagetNumAdderBBPerViaBuffCheck1WithLimit2", buffData: { buffKeyword: "X", stack: 10 } }] };
    expect(staticAttackWeight(s, self({ X: 35 })).weight).toBe(3);
    const d = { attrs: { targetNum: 1 }, abilityScripts: [{ scriptName: "TargetNumAdderOnStartTurnDivideByBuffStack10716", buffData: { buffKeyword: "E", stack: 1, value: -1, limit: 2 } }] };
    expect(staticAttackWeight(d, self({ E: 1 })).weight).toBe(1);
    expect(staticAttackWeight(d, self({ E: 5 })).weight).toBe(3);
  });
});

describe.skipIf(!existsSync(corePath))("opt-in multi-target model", () => {
  const core = JSON.parse(readFileSync(corePath, "utf8")) as CoreData;
  const id = core.identities.find((i) => i.id === 10714);
  const run = (battle: Record<string, unknown>) => {
    const p = createPresetForIdentity(id!, core.skills, core.manifest.dataVersion, "t");
    const scen = ((p as { scenario?: Record<string, unknown> }).scenario ??= {});
    scen.battle = { ...((scen.battle as Record<string, unknown>) ?? {}), ...battle };
    return simulateScenario(core, p, { coinMode: "allHeads" });
  };
  it.skipIf(!id)("defaults: no subTarget field; toggle adds sub-target damage only", () => {
    const base = run({});
    expect(base.totals.subTarget).toBeUndefined();
    expect(run({ countSubTargets: true }).totals.subTarget).toBe(0);
    const multi = run({ targetCount: 5, countSubTargets: true });
    const multiOff = run({ targetCount: 5 });
    expect(multi.totals.total).toBe(multiOff.totals.total);
    expect(multi.totals.subTarget ?? 0).toBeGreaterThan(0);
  });
});
