import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CoreData } from "../data/game-data";
import { createPresetForIdentity } from "../config/preset-factory";
import { simulateScenario } from "./simulator";
import { registerScripts } from "./passives";

const corePath = new URL("../../public/data/core.json", import.meta.url);

registerScripts({
  name: "__test_queue_action_s1",
  summary: "test: queue an extra use of 1101101 after this skill",
  onSkillEnd(c) {
    c.queueAction?.(1101101, { label: "test", key: "__test_queue" });
  },
});

let staggerHits = 0;
registerScripts({
  name: "__test_count_staggered_hits",
  summary: "test: count coin hits while the target is staggered",
  onCoinHit(c) {
    if (c.targetStaggered?.()) staggerHits++;
  },
});

describe.skipIf(!existsSync(corePath))("queueAction / opt-in stagger model (simulator)", () => {
  const core = JSON.parse(readFileSync(corePath, "utf8")) as CoreData;
  const idt = core.identities.find((i) => i.id === 11011);

  const run = (order: string[], opts: { patch?: (s: CoreData["skills"]) => void; target?: Record<string, unknown> } = {}) => {
    const skills = JSON.parse(JSON.stringify(core.skills)) as CoreData["skills"];
    opts.patch?.(skills);
    const p = createPresetForIdentity(idt!, skills, core.manifest.dataVersion, "queue");
    const ids = new Map(p.skillGroups.base.map((e) => [e.slot, e.entryId]));
    const sched = (p.simulation.actionSchedule ?? []).slice(0, order.length);
    sched.forEach((a, i) => (a.entryId = ids.get(order[i]!) ?? a.entryId));
    p.simulation.actionSchedule = sched;
    Object.assign(p.scenario.target as Record<string, unknown>, opts.target ?? {});
    return simulateScenario({ identities: core.identities, skills, buffs: core.buffs }, p, { coinMode: "allHeads" });
  };

  it.skipIf(!idt)("queued action runs after the skill under its own result entry", () => {
    const base = run(["S1"]);
    const res = run(["S1"], {
      patch: (s) => {
        const sk = s["1101101"] as unknown as { abilityScripts?: { scriptName: string }[] };
        sk.abilityScripts = [...(sk.abilityScripts ?? []), { scriptName: "__test_queue_action_s1" }];
      },
    });
    const fu = res.perEntry.find((e) => e.entryId === "追加行动:test");
    expect(fu).toBeDefined();
    expect(fu!.uses).toBe(1); // per-turn key limit: the queued 1101101 does not queue itself again
    expect(fu!.total).toBeGreaterThan(0);
    expect(res.totals.total).toBeGreaterThan(base.totals.total);
  });

  it.skipIf(!idt)("stagger model is off by default and marks the target staggered when HP crosses a threshold", () => {
    const patch = (s: CoreData["skills"]) => {
      for (const id of ["1101101", "1101102"]) {
        const sk = s[id] as unknown as { abilityScripts?: { scriptName: string }[] };
        sk.abilityScripts = [...(sk.abilityScripts ?? []), { scriptName: "__test_count_staggered_hits" }];
      }
    };
    staggerHits = 0;
    const off = run(["S1", "S2"], { patch });
    expect(staggerHits).toBe(0);
    const on = run(["S1", "S2"], { patch, target: { hpTracking: true, maxHp: 60, staggerThresholdsPct: [70, 40] } });
    expect(staggerHits).toBeGreaterThan(0);
    expect(on.totals.total).toBeGreaterThanOrEqual(off.totals.total);
  });
});
