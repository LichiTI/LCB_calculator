import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import type { CoreData } from "../data/game-data";
import { createPresetForIdentity } from "../config/preset-factory";
import { simulateScenario } from "./simulator";
import { StatusContainer } from "./status";

const corePath = new URL("../../public/data/core.json", import.meta.url);
const outPath = new URL("../../data/reports/damage-gaps.json", import.meta.url);

/** Aggregates damage-relevant gaps over all identities (default preset, all heads) into data/reports/damage-gaps.json. */
describe.skipIf(!existsSync(corePath))("damage gap ranking", () => {
  it("ranks unmodelled damage-relevant logic by identity count", () => {
    const core = JSON.parse(readFileSync(corePath, "utf8")) as CoreData;
    const simData = { identities: core.identities, skills: core.skills, buffs: core.buffs };
    const fam = new Map<string, { kind: string; identities: Set<number>; names: Set<string> }>();
    let clean = 0;
    let noApprox = 0;
    const approxFam = new Map<string, { identities: Set<number>; reason: string }>();
    const perIdentity: { id: number; total: number; damageGaps: string[]; approxGaps: string[] }[] = [];
    for (const idt of core.identities) {
      const p = createPresetForIdentity(idt, core.skills, core.manifest.dataVersion, "scan");
      const res = simulateScenario(simData, p, { coinMode: "allHeads" });
      const dmg = res.gaps.filter((g) => (g.impact ?? "damage") === "damage");
      // Approximations: translated handlers / passives with an `approx` note (counted as modelled above, kept visible here).
      const approx = res.gaps.filter((g) => g.impact === "approx" && g.kind !== "scenario");
      if (!dmg.length) clean++;
      if (!approx.length) noApprox++;
      perIdentity.push({ id: idt.id, total: res.totals.total, damageGaps: dmg.map((g) => `${g.kind}:${g.id}`), approxGaps: [...new Set(approx.map((g) => `${g.kind}:${g.id}`))] });
      for (const g of approx) {
        const k = `${g.kind}:${g.id}`;
        const f = approxFam.get(k) ?? { identities: new Set(), reason: g.reason ?? "" };
        f.identities.add(idt.id);
        approxFam.set(k, f);
      }
      for (const g of dmg) {
        const family = g.kind === "passive" ? "passive" : `${g.kind}:${String(g.id).replace(/\d+/g, "#")}`;
        const f = fam.get(family) ?? { kind: g.kind, identities: new Set(), names: new Set() };
        f.identities.add(idt.id);
        f.names.add(String(g.id));
        fam.set(family, f);
      }
    }
    const ranking = [...fam.entries()]
      .map(([family, f]) => ({ family, kind: f.kind, identities: f.identities.size, variants: f.names.size, examples: [...f.names].slice(0, 6) }))
      .sort((a, b) => b.identities - a.identities);
    const sc = new StatusContainer(core.buffs);
    const statusAbilities: Record<string, string[]> = {};
    for (const f of fam.values()) if (f.kind === "status") for (const n of f.names) statusAbilities[n] = sc.unmodelledAbilities(n);
    const approxRanking = [...approxFam.entries()]
      .map(([id, f]) => ({ id, identities: f.identities.size, reason: f.reason }))
      .sort((a, b) => b.identities - a.identities);
    writeFileSync(
      outPath,
      JSON.stringify({ total: core.identities.length, noDamageGaps: clean, noApproxGaps: noApprox, approxCount: approxFam.size, ranking, approxRanking, perIdentity, statusAbilities }, null, 1),
    );
  }, 120000);
});
