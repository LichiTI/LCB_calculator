import { describe, expect, it } from "vitest";
import { StatusContainer, STATUS_SOURCE_NEXT_ROUND } from "./status";

describe("StatusContainer status interceptors", () => {
  it("behaves exactly as before without hooks", () => {
    const a = new StatusContainer();
    const b = new StatusContainer();
    for (const s of [a, b]) {
      s.apply("Burst", 3, 2);
      s.consumeCount("Burst", 1);
      s.apply("Vulnerable", 2, 0);
    }
    b.addStatusInterceptor(() => undefined);
    b.apply("Burst", 2, 1);
    a.apply("Burst", 2, 1);
    expect(b.get("Burst")).toEqual(a.get("Burst"));
    expect(b.get("Vulnerable")).toEqual(a.get("Vulnerable"));
  });

  it("blocks gains of one status, from any caller, but not losses", () => {
    const s = new StatusContainer();
    s.apply("Burst", 5, 3);
    s.addStatusInterceptor((ch) => (ch.buffId === "Burst" && ch.delta > 0 ? 0 : undefined), { scope: "skill" });
    s.apply("Burst", 4, 2, 0, "anything");
    s.apply("Vibration", 2, 1);
    expect(s.getPotency("Burst")).toBe(5);
    expect(s.getCount("Burst")).toBe(3);
    expect(s.getPotency("Vibration")).toBe(2);
    s.consumeCount("Burst", 1);
    expect(s.getCount("Burst")).toBe(2);
    s.clearStatusInterceptors("skill");
    s.apply("Burst", 1, 0);
    expect(s.getPotency("Burst")).toBe(6);
  });

  it("modifies deltas (halving) and can block count loss", () => {
    const s = new StatusContainer();
    s.addStatusInterceptor((ch) => (ch.kind === "stack" && ch.delta > 0 ? Math.floor(ch.delta / 2) : undefined));
    s.apply("Laceration", 7, 2);
    expect(s.getPotency("Laceration")).toBe(3);
    s.addStatusInterceptor((ch) => (ch.kind === "turn" && ch.delta < 0 && ch.buffId === "Laceration" ? 0 : undefined));
    s.consumeCount("Laceration", 1);
    expect(s.getCount("Laceration")).toBe(2);
    // a filter can't flip a gain into a loss
    s.addStatusInterceptor((ch) => (ch.buffId === "Sinking" ? -5 : undefined));
    s.apply("Sinking", 3, 1);
    expect(s.get("Sinking")).toBeUndefined();
  });

  it("replaceWith applies the replacement instead", () => {
    const s = new StatusContainer();
    s.addStatusInterceptor((ch) => (ch.buffId === "Burst" && ch.kind === "stack" ? { replaceWith: { buffId: "DefenseDown", stack: 2 } } : undefined));
    s.apply("Burst", 3, 0);
    expect(s.get("Burst")).toBeUndefined();
    expect(s.getPotency("DefenseDown")).toBe(2);
  });

  it("whileStatus-style alive(), key de-duplication, turn scope cleared at round end", () => {
    const s = new StatusContainer();
    s.apply("Combustion", 1, 1);
    let calls = 0;
    const blockSinking = () => {
      calls++;
      return 0;
    };
    s.addStatusInterceptor(blockSinking, { key: "k", alive: () => s.get("Combustion") !== undefined });
    s.addStatusInterceptor(blockSinking, { key: "k", alive: () => s.get("Combustion") !== undefined });
    s.apply("Sinking", 2, 1);
    expect(s.get("Sinking")).toBeUndefined();
    expect(calls).toBe(2); // one entry (stack + turn), not two
    s.destroy("Combustion");
    s.apply("Sinking", 2, 1);
    expect(s.getPotency("Sinking")).toBe(2);

    const t = new StatusContainer();
    t.addStatusInterceptor((ch) => (ch.buffId === "Vulnerable" ? 0 : undefined), { scope: "turn" });
    t.apply("Vulnerable", 1, 0, 1); // queued for next round: blocked at give time
    t.apply("Protection", 1, 0, 1);
    t.onRoundEndDecay();
    expect(t.get("Vulnerable")).toBeUndefined();
    expect(t.getPotency("Protection")).toBe(1);
    t.apply("Vulnerable", 1, 0);
    expect(t.getPotency("Vulnerable")).toBe(1);
  });

  it("next-round activation bypasses interceptors; observers see effective changes", () => {
    const s = new StatusContainer();
    s.apply("Protection", 2, 0, 1);
    const seen: string[] = [];
    s.addStatusInterceptor((ch) => (ch.source === STATUS_SOURCE_NEXT_ROUND ? 0 : undefined));
    s.addStatusObserver((ev) => seen.push(`${ev.buffId}:${ev.before.potency}->${ev.after.potency}:${ev.source ?? ""}`));
    s.onRoundEndDecay();
    expect(s.getPotency("Protection")).toBe(2);
    s.apply("Burst", 1, 1, 0, "x");
    expect(seen).toEqual([`Protection:0->2:${STATUS_SOURCE_NEXT_ROUND}`, "Burst:0->1:x"]);
  });
});
