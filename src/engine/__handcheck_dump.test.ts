import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import type { CoreData } from "../data/game-data";
import { createPresetForIdentity } from "../config/preset-factory";
import { simulateScenario } from "./simulator";

const corePath = new URL("../../public/data/core.json", import.meta.url);
const IDS = [10211, 10310, 10909, 10610, 10104, 10815, 11215, 10412, 10515, 10414, 10717, 11009];

it.skipIf(!existsSync(corePath))("dump hand-check data", () => {
  const core = JSON.parse(readFileSync(corePath, "utf8")) as CoreData;
  const simData = { identities: core.identities, skills: core.skills, buffs: core.buffs };
  const out: any = {};
  for (const n of IDS) {
    const id = core.identities.find((i) => i.id === n)!;
    const p = createPresetForIdentity(id, core.skills, core.manifest.dataVersion, "h");
    const res = simulateScenario(simData, p, { coinMode: "allHeads" });
    out[n] = {
      preset: { level: (p as any).level, entries: (p as any).entries ?? (p as any).team, scenario: (p as any).scenario },
      totals: res.totals,
      events: res.events.filter((e: any) => e.kind !== "coin" || true).map((e: any) => ({ ...e, breakdown: e.breakdown })),
      status: res.statusApplications,
      dot: res.dotBreakdown,
      exact: (res as any).exact,
      assumptions: (res as any).assumptions,
    };
  }
  writeFileSync(process.env.HC_OUT ?? "hc.json", JSON.stringify(out, null, 1));
}, 600000);
