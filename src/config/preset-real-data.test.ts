import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CoreData } from "../data/game-data";
import { makeIndex } from "../data/game-data";
import { hasErrors, parsePreset, serializePreset, validatePreset } from "./preset";
import { createPresetForIdentity } from "./preset-factory";

const corePath = new URL("../../public/data/core.json", import.meta.url);

describe.skipIf(!existsSync(corePath))("default presets over real data", () => {
  const core = JSON.parse(readFileSync(corePath, "utf8")) as CoreData;
  const index = makeIndex(core);

  it("every identity gets a valid, round-trippable default preset", () => {
    const failures: string[] = [];
    for (const identity of core.identities) {
      const p = createPresetForIdentity(identity, core.skills, core.manifest.dataVersion, `t${identity.id}`);
      const issues = validatePreset(p, index).filter((i) => i.severity === "error");
      if (issues.length) failures.push(`${identity.id}: ${issues.map((i) => `${i.code} ${i.path}`).join("; ")}`);
      const back = parsePreset(serializePreset(p), index);
      if (!back.preset || serializePreset(back.preset) !== serializePreset(p)) failures.push(`${identity.id}: round trip`);
      // standard pool 3/2/1 must be represented with correct coin array sizes
      for (const e of p.skillGroups.base) {
        expect(e.coinDots).toHaveLength(core.skills[String(e.skillId)]!.coinCount);
      }
    }
    expect(failures).toEqual([]);
  });

  it("10105 default matches the documented skill pool", () => {
    const p = createPresetForIdentity(core.identities.find((i) => i.id === 10105)!, core.skills, core.manifest.dataVersion, "x");
    expect(p.skillGroups.base.map((e) => [e.entryId, e.skillId, e.usesPerCycle, e.coinDots!.length])).toEqual([
      ["s1", 1010501, 3, 2], ["s2", 1010502, 2, 1], ["s3", 1010503, 1, 3],
    ]);
    expect(hasErrors(validatePreset(p, index))).toBe(false);
  });
});
