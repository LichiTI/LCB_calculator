import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CoreData } from "../data/game-data";
import { baseEntryFor, createPresetForIdentity } from "../config/preset-factory";
import { simulateScenario } from "./simulator";
import type { Preset } from "../config/preset-types";

const corePath = new URL("../../public/data/core.json", import.meta.url);

type Ev = {
  turn: number; skillId?: number; kind: string; coinIndex?: number; message?: string;
  status?: { statusId: string; before: { potency: number; count: number }; after: { potency: number; count: number }; reason?: string };
};

/** Ammo cancellation (cancelCoin / rest) and reload modelling for 10110 / 10414 / 10514 / 10711. */
describe.skipIf(!existsSync(corePath))("ammo reloads", () => {
  const core = JSON.parse(readFileSync(corePath, "utf8")) as CoreData;
  const data = { identities: core.identities, skills: core.skills, buffs: core.buffs };
  const preset = (id: number) => createPresetForIdentity(core.identities.find((i) => i.id === id)!, core.skills, core.manifest.dataVersion, "t");
  const run = (p: Preset) => (simulateScenario(data, p, { coinMode: "allHeads" }) as unknown as { events: Ev[] }).events;
  const cancels = (ev: Ev[], turn?: number) => ev.filter((e) => e.kind === "note" && /未发动/.test(e.message ?? "") && (turn == null || e.turn === turn));
  /** Repeat the default 6-turn schedule to 12 turns. */
  const twelve = (p: Preset): Preset => ({
    ...p,
    simulation: { ...p.simulation, turnCount: 12, actionSchedule: [...p.simulation.actionSchedule!, ...p.simulation.actionSchedule!.map((a) => ({ ...a, turn: a.turn + 6 }))] },
  });

  it("10110: lacking BulletLament cancels the rest of S3 and ReloadLament refills 20 (SP≥0 → 6 Living / 14 Departed)", () => {
    const ev = run(preset(10110));
    const t6 = cancels(ev, 6).filter((e) => e.skillId === 1011003);
    expect(t6.map((e) => e.coinIndex)).toEqual([1, 2, 3]);
    expect(ev.some((e) => e.kind === "coin" && e.turn === 6 && e.skillId === 1011003 && (e.coinIndex ?? 0) >= 1)).toBe(false);
    const reload = ev.filter((e) => e.kind === "status" && e.status?.statusId === "BulletLament" && e.turn === 6).at(-1)!;
    expect(reload.status!.after).toMatchObject({ potency: 6, count: 14 });
  });

  it("10414: BulletGodok is fully reloaded (6) after an attack that empties it", () => {
    const ev = run(preset(10414));
    expect(ev.some((e) => e.kind === "status" && e.turn === 4 && e.status?.statusId === "BulletGodok" && e.status.after.potency === 6)).toBe(true);
    expect(cancels(ev, 5)).toHaveLength(0);
  });

  it("10514: a manual Defense action (1051404) reloads spores so S3's buckshot coin fires", () => {
    const base = preset(10514);
    const def = baseEntryFor(core.skills["1051404"]!, "def", 0);
    const sched = base.simulation.actionSchedule!.map((a) => (a.turn === 5 ? { ...a, entryId: "def" } : a));
    const p: Preset = { ...base, skillGroups: { ...base.skillGroups, base: [...base.skillGroups.base, def] }, simulation: { ...base.simulation, actionSchedule: sched } };
    const ev = run(p);
    expect(ev.some((e) => e.kind === "status" && e.turn === 5 && e.status?.statusId === "MeursaultSporeBulletShort" && e.status.after.potency === 6)).toBe(true);
    expect(cancels(ev, 6)).toHaveLength(0);
    // default rotation (no defense): the buckshot coin is cancelled and ReloadOnEA1051403 reloads at skill end
    const ev0 = run(base);
    expect(cancels(ev0, 6).map((e) => e.coinIndex)).toEqual([3]);
    expect(ev0.some((e) => e.kind === "status" && e.turn === 6 && e.status?.statusId === "MeursaultSporeBulletLong" && e.status.after.potency === 10)).toBe(true);
  });

  it("10711: 1071105 spends the Atelier Logic round; with all ammo gone it retreats and returns fully reloaded", () => {
    const ev = run(twelve(preset(10711)));
    expect(ev.some((e) => e.kind === "status" && e.status?.statusId === "Bullet_LogicAtelier" && e.status.after.potency === 0)).toBe(true);
    expect(ev.some((e) => e.kind === "status" && e.turn === 6 && e.status?.statusId === "Bullet" && e.status.after.potency === 10)).toBe(true);
    expect(cancels(ev, 7)).toHaveLength(0);
  });
});
