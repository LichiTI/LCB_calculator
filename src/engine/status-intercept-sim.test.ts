import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CoreData } from "../data/game-data";
import { createPresetForIdentity } from "../config/preset-factory";
import { simulateScenario } from "./simulator";
import { registerScripts } from "./passives";

const corePath = new URL("../../public/data/core.json", import.meta.url);

registerScripts({
  name: "__test_intercept_block_target_gains",
  summary: "test: block every status gain on the target for this skill",
  skillMods(c) {
    c.interceptStatus?.("skill", (ch) => (ch.delta > 0 ? 0 : undefined), { side: "target", key: "__test" });
  },
});

describe.skipIf(!existsSync(corePath))("interceptStatus end-to-end (simulator)", () => {
  const core = JSON.parse(readFileSync(corePath, "utf8")) as CoreData;
  const idt = core.identities.find((i) => i.id === 11011);

  const run = (order: string[], skillPatch?: (skills: CoreData["skills"]) => void, targetInit: unknown[] = []) => {
    const skills = JSON.parse(JSON.stringify(core.skills)) as CoreData["skills"];
    skillPatch?.(skills);
    const p = createPresetForIdentity(idt!, skills, core.manifest.dataVersion, "intercept");
    const ids = new Map(p.skillGroups.base.map((e) => [e.slot, e.entryId]));
    const sched = (p.simulation.actionSchedule ?? []).slice(0, order.length);
    sched.forEach((a, i) => (a.entryId = ids.get(order[i]!) ?? a.entryId));
    p.simulation.actionSchedule = sched;
    (p.scenario.target as { initialStatuses: unknown[] }).initialStatuses = targetInit;
    return simulateScenario({ identities: core.identities, skills, buffs: core.buffs }, p, { coinMode: "allHeads" });
  };
  const targetGains = (res: ReturnType<typeof simulateScenario>, turn: number) =>
    res.statusApplications.filter((s) => s.turn === turn && s.target === "target" && s.after.potency + s.after.count > s.before.potency + s.before.count);

  it.skipIf(!idt)("skill-scope interceptor blocks during the skill and is cleared afterwards", () => {
    const s1 = (p: CoreData["skills"]) => {
      const sk = p["1101101"] as unknown as { abilityScripts?: { scriptName: string }[] };
      sk.abilityScripts = [...(sk.abilityScripts ?? []), { scriptName: "__test_intercept_block_target_gains" }];
    };
    const base = run(["S1", "S2"]);
    expect(targetGains(base, 1).length).toBeGreaterThan(0);
    const res = run(["S1", "S2"], s1);
    expect(targetGains(res, 1)).toEqual([]);
    // turn 2 (S2, no interceptor): gains happen again → the skill-scope entry was cleared at skill end
    expect(targetGains(res, 2).length).toBeGreaterThan(0);
    expect(targetGains(res, 2).length).toBe(targetGains(base, 2).length);
  });

  it.skipIf(!idt)("11011 NoGiveBuff blocks this skill's own Burst gains on a 15/3+ Burst target", () => {
    const res = run(["S3"], undefined, [{ id: "Burst", potency: 20, count: 5 }]);
    const burstUp = res.statusApplications.filter(
      (s) => s.turn === 1 && s.target === "target" && s.statusId === "Burst" && (s.after.potency > s.before.potency || s.after.count > s.before.count),
    );
    expect(burstUp).toEqual([]);
  });
});
