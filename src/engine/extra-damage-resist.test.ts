import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CoreData } from "../data/game-data";
import { createPresetForIdentity } from "../config/preset-factory";
import { registerScripts } from "./passives";
import { simulateScenario } from "./simulator";

const corePath = new URL("../../public/data/core.json", import.meta.url);

/** PassiveCtx.extraDamage optional resistance (TakeHpDamageAppliedAttributeResist: Round(value × sin resist)). */
describe.skipIf(!existsSync(corePath))("extraDamage resistance option", () => {
  const core = JSON.parse(readFileSync(corePath, "utf8")) as CoreData;
  const id = core.identities.find((i) => i.id === 10216) ?? core.identities[0];

  registerScripts({
    name: "__TestExtraDamageResist",
    summary: "test",
    onCoinHit(c) {
      if (c.coinIndex !== 0) return;
      c.extraDamage(101, "__plain");
      c.extraDamage(101, "__sin", { sin: "SHAMROCK" });
      c.extraDamage(101, "__phys", { atkType: "SLASH" });
    },
  });

  function run(sinRes: Record<string, number>, physRes: Record<string, number>) {
    const skills: Record<string, unknown> = {};
    for (const [k, s] of Object.entries(core.skills as unknown as Record<string, { id: number; abilityScripts?: unknown[] }>)) {
      skills[k] = Math.trunc(s.id / 100) === id!.id ? { ...s, abilityScripts: [...(s.abilityScripts ?? []), { scriptName: "__TestExtraDamageResist" }] } : s;
    }
    const p = createPresetForIdentity(id!, core.skills, core.manifest.dataVersion, "t");
    const scen = ((p as { scenario?: Record<string, unknown> }).scenario ??= {});
    const target = ((scen.target as Record<string, unknown> | undefined) ?? (scen.target = {})) as Record<string, unknown>;
    target.sinResistances = sinRes;
    target.physicalResistances = physRes;
    const res = simulateScenario({ identities: core.identities, skills: skills as unknown as CoreData["skills"], buffs: core.buffs }, p, { coinMode: "allHeads" });
    const first = (tag: string) => res.events.find((e) => e.kind === "extraDamage" && e.message?.includes(tag))?.damage;
    return { plain: first("__plain"), sin: first("__sin"), phys: first("__phys") };
  }

  it.skipIf(!id)("default unchanged; sin / physical resist applied with Round when requested", () => {
    const r = run({ gluttony: 1.5 }, { slash: 0.5 });
    expect(r.plain).toBe(101);
    expect(r.sin).toBe(Math.round(101 * 1.5)); // 152
    expect(r.phys).toBe(Math.round(101 * 0.5)); // 51
    const n = run({}, {});
    expect(n.sin).toBe(101);
  });
});
