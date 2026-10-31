import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CoreData } from "../data/game-data";
import { createPresetForIdentity } from "../config/preset-factory";
import { simulateScenario } from "./simulator";

const corePath = new URL("../../public/data/core.json", import.meta.url);

describe.skipIf(!existsSync(corePath))("opt-in enemy action / clash model", () => {
  const core = JSON.parse(readFileSync(corePath, "utf8")) as CoreData;
  const run = (id: number, order: string[], scenario: Record<string, unknown> = {}) => {
    const idt = core.identities.find((i) => i.id === id)!;
    const p = createPresetForIdentity(idt, core.skills, core.manifest.dataVersion, "duel");
    const ids = new Map(p.skillGroups.base.map((e) => [e.slot, e.entryId]));
    const sched = (p.simulation.actionSchedule ?? []).slice(0, order.length);
    sched.forEach((a, i) => (a.entryId = ids.get(order[i]!) ?? a.entryId));
    p.simulation.actionSchedule = sched;
    Object.assign(p.scenario as Record<string, unknown>, scenario);
    return simulateScenario({ identities: core.identities, skills: core.skills, buffs: core.buffs }, p, { coinMode: "allHeads" });
  };
  const has = (id: number) => core.identities.some((i) => i.id === id);

  it.skipIf(!has(11001))("clash win enables OnlyWinDuel damage; lose deals no damage; default unchanged", () => {
    const base = run(11001, ["S2"]);
    const none = run(11001, ["S2"], { duel: { outcome: "none" } });
    expect(none.totals.total).toBe(base.totals.total);
    const win = run(11001, ["S2"], { duel: { outcome: "win" } });
    expect(win.totals.total).toBeGreaterThan(base.totals.total); // AttackDmgUpOnlyWinDuelByRatio30 on 1100102
    const lose = run(11001, ["S2"], { duel: { outcome: "lose" } });
    expect(lose.totals.direct).toBe(0);
  });

  it.skipIf(!has(11012))("enemy hits on the actor fire OnTakeAttack (1101211 VendettaMark)", () => {
    const vend = (r: ReturnType<typeof simulateScenario>) => r.statusApplications.filter((s) => s.statusId === "VendettaMark" && s.target === "target" && s.after.potency > s.before.potency);
    expect(vend(run(11012, ["S1"]))).toEqual([]);
    const hit = run(11012, ["S1"], { enemyActions: [{ turn: 1, coinCount: 2, takeHits: 2 }] });
    expect(vend(hit).length).toBe(1); // once per turn
  });
});
