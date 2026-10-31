import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CoreData } from "../data/game-data";
import { createPresetForIdentity } from "../config/preset-factory";
import { simulateScenario } from "./simulator";

const corePath = new URL("../../public/data/core.json", import.meta.url);

describe.skipIf(!existsSync(corePath))("opt-in ally joint attacks", () => {
  const core = JSON.parse(readFileSync(corePath, "utf8")) as CoreData;
  const run = (actor: number, battle: Record<string, unknown>) => {
    const id = core.identities.find((i) => i.id === actor)!;
    const p = createPresetForIdentity(id, core.skills, core.manifest.dataVersion, "t");
    const scen = ((p as { scenario?: Record<string, unknown> }).scenario ??= {});
    scen.battle = { ...((scen.battle as Record<string, unknown>) ?? {}), ...battle };
    return simulateScenario(core, p, { coinMode: "allHeads" });
  };

  it("Dawn joint attack: ally damage separate unless counted", () => {
    const base = run(11009, {});
    expect(base.totals.ally).toBeUndefined();
    const sep = run(11009, { allies: ["10216"] });
    expect(sep.totals.ally ?? 0).toBeGreaterThan(0);
    expect(sep.totals.total).toBe(base.totals.total);
    const counted = run(11009, { allies: ["10216"], countAllyDamage: true });
    expect(counted.totals.total).toBe(base.totals.total + (counted.totals.ally ?? 0));
    expect(sep.events.some((e) => e.message?.startsWith("友方联合攻击:"))).toBe(true);
  });

  it("Don Quixote 1031504 inserts 审判！ per declared LE_NOIR ally", () => {
    const noir = core.identities.find((i) => i.id !== 10315 && i.associations.includes("LE_NOIR"));
    if (!noir) return;
    const r = run(10315, { allies: [String(noir.id)] });
    expect(r.events.some((e) => e.message?.includes("审判"))).toBe(true);
    expect(r.totals.total).toBeGreaterThan(run(10315, {}).totals.total);
  });
});
