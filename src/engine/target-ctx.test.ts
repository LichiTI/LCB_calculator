import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CoreData } from "../data/game-data";
import { createPresetForIdentity } from "../config/preset-factory";
import { registerScripts, resistLevelOf } from "./passives";
import { simulateScenario } from "./simulator";

describe("resistLevelOf (UnitModel.GetAttributeResistLevelByType thresholds)", () => {
  it("maps multipliers to RESIST_VALUE", () => {
    expect(resistLevelOf(0)).toBe("IMMUNE");
    expect(resistLevelOf(0.5)).toBe("RESIST");
    expect(resistLevelOf(0.75)).toBe("ENDURE");
    expect(resistLevelOf(1)).toBe("NORMAL");
    expect(resistLevelOf(1.5)).toBe("VULNERABLE");
    expect(resistLevelOf(2)).toBe("WEAK");
  });
});

const corePath = new URL("../../public/data/core.json", import.meta.url);

describe.skipIf(!existsSync(corePath))("PassiveCtx target resist / unit keyword readers", () => {
  const core = JSON.parse(readFileSync(corePath, "utf8")) as CoreData;
  const id = core.identities.find((i) => i.id === 10216) ?? core.identities[0];
  const seen: string[] = [];
  registerScripts({
    name: "__TestTargetCtx",
    summary: "test",
    skillMods(c) {
      seen.push(
        [
          c.targetResist?.({ sin: "SHAMROCK" }),
          c.targetResistLevel?.({ sin: "SHAMROCK" }),
          c.targetResistLevel?.({ atkType: "PENETRATE" }),
          c.targetHasUnitKeyword?.("bloodfiend"),
          c.targetHasUnitKeyword?.("MACHINE"),
        ].join("|"),
      );
    },
  });

  function run(target: Record<string, unknown>) {
    seen.length = 0;
    const skills: Record<string, unknown> = {};
    for (const [k, s] of Object.entries(core.skills as unknown as Record<string, { id: number; abilityScripts?: unknown[] }>)) {
      skills[k] = Math.trunc(s.id / 100) === id!.id ? { ...s, abilityScripts: [...(s.abilityScripts ?? []), { scriptName: "__TestTargetCtx" }] } : s;
    }
    const p = createPresetForIdentity(id!, core.skills, core.manifest.dataVersion, "t");
    const scen = ((p as { scenario?: Record<string, unknown> }).scenario ??= {});
    scen.target = { ...((scen.target as Record<string, unknown>) ?? {}), ...target };
    simulateScenario({ identities: core.identities, skills: skills as unknown as CoreData["skills"], buffs: core.buffs }, p, { coinMode: "allHeads" });
    return seen[0];
  }

  it.skipIf(!id)("defaults and scenario values", () => {
    expect(run({})).toBe("1|NORMAL|NORMAL|false|false");
    expect(run({ sinResistances: { gluttony: 2 }, physicalResistances: { pierce: 1.5 }, unitKeywords: ["BLOODFIEND"] })).toBe(
      "2|WEAK|VULNERABLE|true|false",
    );
  });
});
