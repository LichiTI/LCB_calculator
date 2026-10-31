import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CoreData } from "../data/game-data";
import { createPresetForIdentity } from "../config/preset-factory";
import { simulateScenario } from "./simulator";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const corePath = join(rootDir, "public", "data", "core.json");

describe.skipIf(!existsSync(corePath))("Stage D — real game data coverage audit", () => {
  it("evaluates all 192 Uptie 4 identities and writes data/reports/coverage-matrix.json", () => {
    const core = JSON.parse(readFileSync(corePath, "utf8")) as CoreData;
    const simData = {
      identities: core.identities,
      skills: core.skills,
      buffs: core.buffs,
    };

    const identityRows: {
      id: number;
      exactWithoutPassives: boolean;
      staticTotalAllHeads: number;
      staticDirectAllHeads: number;
      staticDotAllHeads: number;
      effectGaps: string[];
      statusGaps: string[];
    }[] = [];

    let exactCount = 0;
    const gapCounts = new Map<string, number>();

    for (const identity of core.identities) {
      const preset = createPresetForIdentity(identity, core.skills, core.manifest.dataVersion, `Audit ${identity.id}`);
      preset.actor.battlePassives = "none";
      const res = simulateScenario(simData, preset, { coinMode: "allHeads" });
      const resMc = simulateScenario(simData, preset, { coinMode: "monteCarlo", samples: 10, seed: 42 });
      const effectGaps = resMc.gaps.filter((g) => g.kind === "effect").map((g) => g.id);
      const statusGaps = resMc.gaps.filter((g) => g.kind === "status").map((g) => g.id);
      for (const g of resMc.gaps) {
        const key = `${g.kind}:${g.id}`;
        gapCounts.set(key, (gapCounts.get(key) ?? 0) + 1);
      }
      if (resMc.exact) exactCount++;
      identityRows.push({
        id: identity.id,
        exactWithoutPassives: resMc.exact,
        staticTotalAllHeads: res.totals.total,
        staticDirectAllHeads: res.totals.direct,
        staticDotAllHeads: res.totals.dotHp,
        effectGaps,
        statusGaps,
      });
    }

    const topGaps = [...gapCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([key, count]) => ({ key, count }));

    const report = {
      rulesVersion: "2026.10.29-il2cpp-v1",
      totalIdentities: core.identities.length,
      fullyExactSkillSetIdentities: exactCount,
      topRemainingGaps: topGaps,
      identities: identityRows,
    };

    const outPath = join(rootDir, "data", "reports", "coverage-matrix.json");
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    expect(core.identities.length).toBeGreaterThanOrEqual(190);
    expect(exactCount).toBeGreaterThan(0);
  });
});
