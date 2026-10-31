/** Named preset storage on top of a localStorage-like backend. */
import type { Preset } from "./preset-types";
import { duplicatePreset, parsePreset, serializePreset, type GameDataIndex, type Issue } from "./preset";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = "lcalc.presets.v1";

interface Stored { order: string[]; presets: Record<string, string> }

export class PresetStore {
  constructor(private storage: StorageLike, private data?: GameDataIndex) {}

  private load(): Stored {
    const text = this.storage.getItem(KEY);
    if (!text) return { order: [], presets: {} };
    try {
      return JSON.parse(text) as Stored;
    } catch {
      return { order: [], presets: {} };
    }
  }

  private persist(s: Stored) {
    this.storage.setItem(KEY, JSON.stringify(s));
  }

  list(): { presetId: string; name: string }[] {
    const s = this.load();
    return s.order.flatMap((id) => {
      const text = s.presets[id];
      if (!text) return [];
      try {
        const p = JSON.parse(text) as Preset;
        return [{ presetId: id, name: p.name }];
      } catch {
        return [{ presetId: id, name: `${id}（损坏）` }];
      }
    });
  }

  /** Stored text is kept verbatim so fields unknown to this version survive. */
  get(presetId: string): { preset: Preset | null; issues: Issue[] } {
    const text = this.load().presets[presetId];
    if (text === undefined) return { preset: null, issues: [] };
    const r = parsePreset(text, this.data);
    return { preset: r.preset, issues: r.issues };
  }

  save(p: Preset): void {
    const s = this.load();
    if (!s.order.includes(p.presetId)) s.order.push(p.presetId);
    s.presets[p.presetId] = serializePreset(p);
    this.persist(s);
  }

  remove(presetId: string): void {
    const s = this.load();
    s.order = s.order.filter((x) => x !== presetId);
    delete s.presets[presetId];
    this.persist(s);
  }

  duplicate(presetId: string, newName: string): Preset | null {
    const { preset } = this.get(presetId);
    if (!preset) return null;
    const copy = duplicatePreset(preset, uniqueId(preset.presetId, new Set(this.load().order)), newName);
    this.save(copy);
    return copy;
  }

  importText(text: string): { preset: Preset | null; issues: Issue[] } {
    const r = parsePreset(text, this.data);
    if (r.preset) {
      const existing = new Set(this.load().order);
      if (existing.has(r.preset.presetId)) r.preset.presetId = uniqueId(r.preset.presetId, existing);
      this.save(r.preset);
    }
    return { preset: r.preset, issues: r.issues };
  }

  exportText(presetId: string): string | null {
    return this.load().presets[presetId] ?? null;
  }
}

function uniqueId(base: string, taken: Set<string>): string {
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
