import { describe, expect, it } from "vitest";
import exampleText from "../../fixtures/presets/calculator-presets.example.json?raw";
import { StatusAmount } from "./dot-types";
import {
  fillPerCoinDefaults,
  hasErrors,
  migratePreset,
  parsePreset,
  serializePreset,
  validatePreset,
  type GameDataIndex,
} from "./preset";
import { PresetStore, type StorageLike } from "./preset-store";
import type { Preset } from "./preset-types";

/** Values from data/normalized for identity 10105 (docs/phase-a-report.md §6). */
const fakeData: GameDataIndex = {
  dataVersion: "test-data",
  hasIdentity: (id) => id === 10105,
  coinCount: (id) => ({ 1010501: 2, 1010502: 1, 1010503: 3, 1010504: 1, 1020101: 2 } as Record<number, number>)[id],
  skillOwners: (id) => (String(id).startsWith("10105") ? [10105] : id === 1020101 ? [10201] : undefined),
  statusClass: (id) => ({ Combustion: "SinBuff", Laceration: "SinBuff", Vibration: "SinBuff", DefenseDown: "VolatileBuff", Paralysis: "NonvolatileBuff" } as Record<string, string>)[id],
};

const example = (): Preset => JSON.parse(exampleText) as Preset;
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe("preset example", () => {
  it("is valid with real coin counts (template info only)", () => {
    const issues = validatePreset(example(), fakeData);
    expect(hasErrors(issues)).toBe(false);
    expect(codes(issues)).toContain("template-only");
  });
});

describe("round trip", () => {
  it("export -> import loses nothing, including unknown fields", () => {
    const p = example() as Preset & Record<string, unknown>;
    p.customTopLevel = { keep: [1, 2, 3] };
    (p.skillGroups.base[0] as Record<string, unknown>).myNote = "x";
    const text = serializePreset(p);
    const r = parsePreset(text, fakeData);
    expect(r.preset).toEqual(p);
    expect(serializePreset(r.preset!)).toBe(text);
    expect(codes(r.issues)).toContain("unknown-field");
  });

  it("keeps 0 vs null and negative coin values", () => {
    const p = example();
    p.skillGroups.base[0]!.basePower = 0;
    p.skillGroups.base[1]!.basePower = null;
    p.skillGroups.base[0]!.coinPowerDeltas = [-3, 2];
    p.skillGroups.base[0]!.totalCoinPowerDelta = -1;
    const back = parsePreset(serializePreset(p), fakeData).preset!;
    expect(back.skillGroups.base[0]!.basePower).toBe(0);
    expect(back.skillGroups.base[1]!.basePower).toBeNull();
    expect(back.skillGroups.base[0]!.coinPowerDeltas).toEqual([-3, 2]);
    expect(back.skillGroups.base[0]!.totalCoinPowerDelta).toBe(-1);
  });

  it("StatusAmount instances serialize to plain objects and revive", () => {
    const p = example();
    p.skillGroups.base[0]!.coinDots = [{ Combustion: new StatusAmount(3, 1) }, { Laceration: new StatusAmount(0, 2) }];
    const back = parsePreset(serializePreset(p), fakeData).preset!;
    expect(back.skillGroups.base[0]!.coinDots![0]).toEqual({ Combustion: { potency: 3, count: 1 } });
    expect(StatusAmount.fromJSON(back.skillGroups.base[0]!.coinDots![1]!.Laceration)).toBeInstanceOf(StatusAmount);
  });
});

describe("per-coin arrays", () => {
  it("wrong length is an error and is not truncated or padded", () => {
    const p = example();
    p.skillGroups.base[0]!.coinPowerDeltas = [1];
    p.skillGroups.base[2]!.coinDots = [{}, {}, {}, {}];
    const issues = validatePreset(p, fakeData);
    expect(issues.filter((i) => i.code === "coin-length").map((i) => i.path)).toEqual([
      "/skillGroups/base/0/coinPowerDeltas",
      "/skillGroups/base/2/coinDots",
    ]);
    expect(p.skillGroups.base[0]!.coinPowerDeltas).toEqual([1]);
  });

  it("missing arrays are initialised with independent objects; wrong ones untouched", () => {
    const p = example();
    delete p.skillGroups.base[2]!.coinDots;
    delete p.skillGroups.base[2]!.coinPowerDeltas;
    p.skillGroups.base[0]!.coinDamageBonusPcts = [5];
    expect(codes(validatePreset(p, fakeData))).toContain("missing-per-coin");
    const { preset, filled } = fillPerCoinDefaults(p, fakeData);
    const dots = preset.skillGroups.base[2]!.coinDots!;
    expect(dots).toHaveLength(3);
    expect(dots[0]).not.toBe(dots[1]);
    dots[0]!.Combustion = { potency: 1, count: 1 };
    expect(dots[1]).toEqual({});
    expect(preset.skillGroups.base[2]!.coinPowerDeltas).toEqual([0, 0, 0]);
    expect(preset.skillGroups.base[0]!.coinDamageBonusPcts).toEqual([5]);
    expect(filled).toEqual(["/skillGroups/base/2/coinPowerDeltas", "/skillGroups/base/2/coinDots"]);
  });

  it("detects shared coinDots map objects", () => {
    const p = example();
    const shared = {};
    p.skillGroups.base[2]!.coinDots = [shared, shared, {}];
    expect(codes(validatePreset(p, fakeData))).toContain("shared-dot-map");
  });
});

describe("coinDots semantics", () => {
  it("multiple statuses per coin, pure potency / pure count are valid", () => {
    const p = example();
    p.skillGroups.base[0]!.coinDots = [
      { Combustion: { potency: 3, count: 0 }, Laceration: { potency: 0, count: 2 } },
      { Vibration: { potency: 0, count: 0 } },
    ];
    expect(hasErrors(validatePreset(p, fakeData))).toBe(false);
  });

  it("rejects negative / fractional amounts", () => {
    const p = example();
    p.skillGroups.base[0]!.coinDots = [{ Combustion: { potency: -1, count: 1 } }, { Laceration: { potency: 1.5, count: 1 } }];
    expect(codes(validatePreset(p, fakeData)).filter((c) => c === "schema").length).toBeGreaterThan(0);
  });

  it("unknown status is preserved and reported; VolatileBuff potency warns", () => {
    const p = example();
    p.skillGroups.base[0]!.coinDots = [{ NotARealStatus: { potency: 1, count: 1 } }, { DefenseDown: { potency: 2, count: 1 } }];
    const r = parsePreset(serializePreset(p), fakeData);
    expect(codes(r.issues)).toEqual(expect.arrayContaining(["unknown-status", "no-potency"]));
    expect(r.preset!.skillGroups.base[0]!.coinDots![0]).toHaveProperty("NotARealStatus");
  });
});

describe("references", () => {
  it("unknown skill / identity preserved; foreign skill warned; dangling entry refs", () => {
    const p = example();
    p.skillGroups.base[0]!.skillId = 9999999;
    p.skillGroups.base[1]!.skillId = 1020101;
    p.simulation.actionSchedule!.push({ turn: 7, order: 1, entryId: "nope" });
    p.skillGroups.followUps[0]!.trigger.sourceEntryIds = ["ghost"];
    const issues = validatePreset(p, fakeData);
    expect(codes(issues)).toEqual(expect.arrayContaining(["unknown-skill", "foreign-skill", "dangling-entry-ref"]));
    expect(issues.filter((i) => i.code === "dangling-entry-ref")).toHaveLength(2);
  });

  it("data version mismatch is a reproducibility warning", () => {
    const p = example();
    p.dataVersion = "older";
    expect(codes(validatePreset(p, fakeData))).toContain("data-version-mismatch");
  });
});

describe("migration", () => {
  it("rejects missing or newer schemaVersion", () => {
    expect(codes(migratePreset({}).issues)).toEqual(["no-schema-version"]);
    expect(codes(migratePreset({ schemaVersion: 99 }).issues)).toEqual(["newer-format"]);
    expect(parsePreset("{not json").issues[0]!.code).toBe("json");
  });
});

describe("display language never changes computational content", () => {
  it("switching translation pack only touches presentation", () => {
    const p = example();
    const before = serializePreset({ ...p, presentation: undefined });
    const switched = { ...p, presentation: { ...p.presentation, translationPack: "ST" } };
    expect(serializePreset({ ...switched, presentation: undefined })).toBe(before);
  });
});

describe("PresetStore", () => {
  const mem = (): StorageLike => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
  };

  it("save / list / duplicate / import collision / export verbatim", () => {
    const store = new PresetStore(mem(), fakeData);
    const p = example();
    store.save(p);
    const copy = store.duplicate(p.presetId, "副本")!;
    expect(copy.presetId).toBe(`${p.presetId}-2`);
    const imported = store.importText(serializePreset(p));
    expect(imported.preset!.presetId).toBe(`${p.presetId}-3`);
    expect(store.list().map((x) => x.name)).toEqual([p.name, "副本", p.name]);
    expect(store.exportText(p.presetId)).toBe(serializePreset(p));
    store.remove(copy.presetId);
    expect(store.list()).toHaveLength(2);
  });

  it("imports presets with semantic errors without dropping content", () => {
    const store = new PresetStore(mem(), fakeData);
    const p = example();
    p.skillGroups.base[0]!.coinPowerDeltas = [1, 2, 3];
    const r = store.importText(serializePreset(p));
    expect(hasErrors(r.issues)).toBe(true);
    expect(r.preset!.skillGroups.base[0]!.coinPowerDeltas).toEqual([1, 2, 3]);
  });
});
