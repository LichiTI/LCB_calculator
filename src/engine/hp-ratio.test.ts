import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CoreData } from "../data/game-data";
import { createPresetForIdentity } from "../config/preset-factory";
import { registerScripts } from "./passives/framework";
import { simulateScenario } from "./simulator";

const corePath = new URL("../../public/data/core.json", import.meta.url);

const seen: { target: number; lost: number; self: number }[] = [];
let adderProbe = 0;
registerScripts({
  name: "__AtkDmgAdderProbe",
  summary: "test probe (flat adder)",
  coinMods() {
    return adderProbe ? { atkDmgAdder: adderProbe } : undefined;
  },
});
registerScripts({
  name: "__HpRatioProbe",
  summary: "test probe",
  coinMods(c) {
    seen.push({ target: c.targetHpRatio(), lost: c.targetLostHpRatio(), self: c.selfHpRatio() });
  },
});

describe.skipIf(!existsSync(corePath))("target / self HP ratio context", () => {
  const core = JSON.parse(readFileSync(corePath, "utf8")) as CoreData;
  const id = core.identities.find((i) => i.id === 11101);
  // Attach the probe to every coin-carrying skill of the identity (as a skill-level script → coinMods per coin).
  const skills = Object.fromEntries(
    Object.entries(core.skills).map(([k, s]) => [k, s && Math.trunc(s.id / 100) === 11101 ? { ...s, abilityScripts: [...(s.abilityScripts ?? []), { scriptName: "__HpRatioProbe" }, { scriptName: "__AtkDmgAdderProbe" }] } : s]),
  ) as typeof core.skills;
  const simData = { identities: core.identities, skills, buffs: core.buffs };

  const run = (target: Record<string, unknown>, battle: Record<string, unknown> = {}) => {
    const p = createPresetForIdentity(id!, core.skills, core.manifest.dataVersion, "hp");
    const sc = (p.scenario ?? {}) as Record<string, unknown>;
    p.scenario = { ...sc, target: { ...((sc.target ?? {}) as Record<string, unknown>), ...target }, battle: { ...((sc.battle ?? {}) as Record<string, unknown>), ...battle } } as typeof p.scenario;
    seen.length = 0;
    const res = simulateScenario(simData, p, { coinMode: "allHeads" });
    return { res, seen: [...seen] };
  };

  it.skipIf(!id)("defaults: target 100%, self 100%, fixed", () => {
    const { seen: s } = run({});
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((x) => x.target === 1 && x.lost === 0 && x.self === 1)).toBe(true);
  });

  it.skipIf(!id)("uses scenario starting ratios and keeps them fixed by default", () => {
    const { seen: s } = run({ hpRatio: 0.4 }, { lostHpPct: 30 });
    expect(s.every((x) => Math.abs(x.target - 0.4) < 1e-9 && Math.abs(x.lost - 0.6) < 1e-9 && Math.abs(x.self - 0.7) < 1e-9)).toBe(true);
  });

  it.skipIf(!id)("tracks dealt damage when hpTracking is on (clamped at 0)", () => {
    const { seen: s } = run({ hpRatio: 0.8, maxHp: 200, hpTracking: true });
    expect(s[0]!.target).toBeCloseTo(0.8);
    for (let i = 1; i < s.length; i++) expect(s[i]!.target).toBeLessThanOrEqual(s[i - 1]!.target);
    expect(s[s.length - 1]!.target).toBeLessThan(0.8);
    expect(s.every((x) => x.target >= 0)).toBe(true);
  });

  it.skipIf(!id)("AttackDmgUpByRatio20IfHpRatioNotLessThan50 follows the target HP ratio", () => {
    const full = run({ hpRatio: 1 }).res.totals.total;
    const low = run({ hpRatio: 0.4 }).res.totals.total;
    expect(full).toBeGreaterThan(low);
  });

  it.skipIf(!id)("atkDmgAdder adds flat damage per coin, scaled by (1 + max(0, resist/level terms))", () => {
    const base = run({});
    adderProbe = 10;
    const withAdder = run({});
    adderProbe = 0;
    const coins = (r: typeof base.res) => r.events.filter((e) => e.kind === "coin");
    const a = coins(base.res);
    const b = coins(withAdder.res);
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) {
      const bd = b[i]!.breakdown!;
      const expected = Math.floor(bd.effectivePower * bd.staticMultiplier * bd.dynamicMultiplier + 10 * bd.adderMultiplier + 1e-7);
      expect(bd.resolvedDamage).toBe(Math.max(expected, bd.minGuaranteeDamage));
      expect(b[i]!.damage!).toBeGreaterThanOrEqual(a[i]!.damage! + 10);
    }
  });
});
