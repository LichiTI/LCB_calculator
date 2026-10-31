import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CoreData } from "../data/game-data";
import { createPresetForIdentity } from "../config/preset-factory";
import { createActionRecord } from "./action-record";
import { registerScripts } from "./passives";
import { simulateScenario } from "./simulator";
import { StatusContainer, triggerLacerationOnAttackCoinToss } from "./status";

describe("per-action consumption record", () => {
  it("accumulates per owner/status and resets", () => {
    const r = createActionRecord();
    r.add("actor", "Charge", 0, 3);
    r.add("actor", "Charge", 0, 2);
    r.add("target", "Charge", 4, 0);
    r.shared.set("k", 1);
    expect(r.consumedTurn("Charge")).toBe(5);
    expect(r.consumedStack("Charge", "target")).toBe(4);
    expect(r.consumedStack("Charge")).toBe(0);
    r.reset();
    expect(r.consumedTurn("Charge")).toBe(0);
    expect(r.shared.size).toBe(0);
  });

  it("StatusContainer reports active spends only", () => {
    const s = new StatusContainer();
    const r = createActionRecord();
    s.consumeListener = (id, st, t) => r.add("actor", id, st, t);
    s.apply("Charge", 1, 10);
    s.consumeCount("Charge", 4);
    s.consumeCount("Charge", 1, false); // passive decay: not recorded
    s.apply("Breath", 5, 3);
    s.losePotency("Breath", 2);
    s.apply("Laceration", 3, 3);
    triggerLacerationOnAttackCoinToss(s, 1, "test"); // DOT trigger: not a skill spend
    expect(r.consumedTurn("Charge")).toBe(4);
    expect(r.consumedStack("Breath")).toBe(2);
    expect(r.consumedTurn("Laceration")).toBe(0);
  });
});

const corePath = new URL("../../public/data/core.json", import.meta.url);

describe.skipIf(!existsSync(corePath))("ScriptCtx.action in the simulator", () => {
  const core = JSON.parse(readFileSync(corePath, "utf8")) as CoreData;
  const id = core.identities.find((i) => i.id === 11211);
  const SKILL = 1121103;

  it.skipIf(!id || !core.skills[String(SKILL)])("sees fuel spent by another script of the same skill use", () => {
    const skills = structuredClone(core.skills);
    const sk = skills[String(SKILL)] as unknown as { abilityScripts?: { scriptName: string }[] };
    sk.abilityScripts = [...(sk.abilityScripts ?? []), { scriptName: "__TestProbeActionRecord" }];
    const seen: { fuel: number; sharedClean: boolean }[] = [];
    registerScripts({
      name: "__TestProbeActionRecord",
      summary: "test probe",
      skillMods(c) {
        seen.push({ fuel: -1, sharedClean: !c.action.shared.has("probe") });
        c.action.shared.set("probe", true);
      },
      onSkillEnd(c) {
        seen.push({ fuel: c.action.consumedStack("FirePunchFuel") + c.action.consumedStack("FirePunchFuelOverheated"), sharedClean: c.action.shared.get("probe") === true });
      },
    });
    const p = createPresetForIdentity(id!, skills, core.manifest.dataVersion, "gregor");
    simulateScenario({ identities: core.identities, skills, buffs: core.buffs }, p, { coinMode: "allHeads" });
    const starts = seen.filter((x) => x.fuel === -1);
    const ends = seen.filter((x) => x.fuel >= 0);
    expect(starts.length).toBeGreaterThan(0);
    expect(starts.every((x) => x.sharedClean)).toBe(true);
    expect(ends.every((x) => x.sharedClean)).toBe(true);
    expect(ends.some((x) => x.fuel > 0)).toBe(true);
  });
});
