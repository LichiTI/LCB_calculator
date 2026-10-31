import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CoreData } from "../data/game-data";
import { createPresetForIdentity } from "../config/preset-factory";
import { simulateScenario } from "./simulator";
import { registerScripts } from "./passives";

const corePath = new URL("../../public/data/core.json", import.meta.url);

/** Engine coin controls: AffectNextCoin (c.nextCoin) and pre-toss cancellation (beforeCoin + c.cancelCoin). */
describe.skipIf(!existsSync(corePath))("coin controls (nextCoin / cancelCoin)", () => {
  const core = JSON.parse(readFileSync(corePath, "utf8")) as CoreData;
  const data = { identities: core.identities, skills: core.skills, buffs: core.buffs };
  const idn = core.identities.find((i) => i.id === 10701)!;
  const SKILL = 1070103; // coin 0: 1070103_1 (heads hit → next coin power +2), coin 1: VibrationExplosionOnSucceedAttack
  type Ev = { turn: number; skillId?: number; kind: string; coinIndex?: number; power?: number; damage?: number; message?: string };

  const run = (disabled: string[] = []) => {
    const base = createPresetForIdentity(idn, core.skills, core.manifest.dataVersion, "t");
    const r = simulateScenario(data, { ...base, actor: { ...base.actor, disabledEffectIds: disabled } }, { coinMode: "allHeads" });
    return { total: r.totals.total, events: (r as unknown as { events: Ev[] }).events };
  };
  /** Coin events of the first use of SKILL. */
  const firstUse = (events: Ev[]) => {
    const t = events.find((e) => e.kind === "coin" && e.skillId === SKILL)!.turn;
    return events.filter((e) => e.kind === "coin" && e.skillId === SKILL && e.turn === t);
  };

  it("1070103_1 raises the following coin's power by exactly 2", () => {
    const on = firstUse(run().events);
    const off = firstUse(run(["1070103_1"]).events);
    expect(on[0]!.power).toBe(off[0]!.power);
    expect(on[1]!.power! - off[1]!.power!).toBe(2);
  });

  it("nextCoin: repeated calls from one script overwrite; addFinalPower applies to the next coin only", () => {
    const off = firstUse(run(["1070103_1"]).events);
    registerScripts({
      name: "1070103_1",
      summary: "test",
      onCoinHit(c) {
        c.nextCoin.addFinalPower(5);
        c.nextCoin.addFinalPower(5);
      },
    });
    const on = firstUse(run().events);
    expect(on[0]!.power).toBe(off[0]!.power);
    expect(on[1]!.power! - off[1]!.power!).toBe(5);
  });

  it("cancelCoin in beforeCoin skips the coin (no roll, damage or on-hit) and the rest of the skill continues", () => {
    const off = run(["1070103_1"]);
    let hits = 0;
    registerScripts({
      name: "1070103_1",
      summary: "test",
      beforeCoin(c) {
        c.cancelCoin("测试取消");
      },
      onCoinHit() {
        hits++;
      },
    });
    const on = run();
    const coins = on.events.filter((e) => e.kind === "coin" && e.skillId === SKILL);
    expect(coins.length).toBeGreaterThan(0);
    expect(coins.every((e) => e.coinIndex !== 0)).toBe(true);
    expect(hits).toBe(0);
    expect(on.events.some((e) => e.kind === "note" && e.skillId === SKILL && /硬币 1未发动：测试取消/.test(e.message ?? ""))).toBe(true);
    expect(on.total).toBeLessThan(off.total);
  });
});
