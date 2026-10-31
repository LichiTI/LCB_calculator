import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CoreData } from "../data/game-data";
import { createPresetForIdentity } from "../config/preset-factory";
import { simulateScenario } from "./simulator";

const corePath = new URL("../../public/data/core.json", import.meta.url);

/** ScriptHandler.beforeUse → c.replaceSkill (BattleActionModel.ChangeSkill) runs the replacement skill instead. */
describe.skipIf(!existsSync(corePath))("skill replacement (变身/替换)", () => {
  const core = JSON.parse(readFileSync(corePath, "utf8")) as CoreData;
  const simData = { identities: core.identities, skills: core.skills, buffs: core.buffs };
  const run = (identityId: number, actorStatuses: { id: string; potency: number; count: number }[]) => {
    const idt = core.identities.find((i) => i.id === identityId)!;
    const p = createPresetForIdentity(idt, core.skills, core.manifest.dataVersion, "scan");
    (p.actor as Record<string, unknown>).initialStatuses = actorStatuses;
    return simulateScenario(simData, p, { coinMode: "allHeads" });
  };

  it("SpecialSkill1051203: with BulletPropellantSpecialAlly the S3 becomes 1051205", () => {
    const before = run(10512, []);
    expect(before.skillReplacements ?? []).toHaveLength(0);
    const after = run(10512, [{ id: "BulletPropellantSpecialAlly", potency: 1, count: 0 }]);
    const rows = after.skillReplacements ?? [];
    expect(rows.some((r) => r.fromSkillId === 1051203 && r.toSkillId === 1051205)).toBe(true);
    expect(after.events.some((e) => e.kind === "note" && /变身\/替换\] 1051203 → 1051205/.test(e.message ?? ""))).toBe(true);
    expect(after.events.some((e) => e.kind === "useSkill" && e.skillId === 1051205)).toBe(true);
    expect(after.assumptions.some((a) => a.includes("1051203 → 1051205"))).toBe(true);
  });

  it("SpecialSkill1011403: BreakthroughHorse 5 → 1011405 and all stacks are spent", () => {
    const res = run(10114, [{ id: "BreakthroughHorse", potency: 5, count: 0 }]);
    expect((res.skillReplacements ?? []).some((r) => r.fromSkillId === 1011403 && r.toSkillId === 1011405)).toBe(true);
  });
});
