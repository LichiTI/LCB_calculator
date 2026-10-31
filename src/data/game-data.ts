/** Browser-side access to public/data (built by scripts/build-data.mjs). */
import type { GameDataIndex } from "../config/preset";
import type { NormalizedBuff, NormalizedEgo, NormalizedIdentity, NormalizedPassive, NormalizedSkill } from "../config/game-data";

export interface CoreData {
  manifest: { dataVersion: string; build: string; catalogHash: string | null; uptie: 4 };
  identities: NormalizedIdentity[];
  egos?: NormalizedEgo[];
  skills: Record<string, NormalizedSkill>;
  passives: Record<string, NormalizedPassive>;
  buffs: Record<string, NormalizedBuff>;
}

export interface SkillText { name?: string; desc?: string; level: number; coins: { descs: string[] }[]; file: string }
export interface NamedText { name?: string; title?: string; nameWithTitle?: string; desc?: string; summary?: string; _file?: string }

export interface TextPack {
  personalities: Record<string, NamedText>;
  egos?: Record<string, NamedText>;
  skills: Record<string, SkillText>;
  passives: Record<string, NamedText>;
  bufs: Record<string, NamedText>;
  buffAbilities: Record<string, NamedText>;
  keywords: Record<string, NamedText>;
  skillTags: Record<string, NamedText>;
}

export type TextCategory = keyof TextPack;

const cache = new Map<string, Promise<unknown>>();
function fetchJson<T>(path: string): Promise<T> {
  if (!cache.has(path)) {
    cache.set(path, fetch(path).then((r) => {
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}（请先运行 pnpm data）`);
      return r.json();
    }));
  }
  return cache.get(path) as Promise<T>;
}

export const loadCore = () => fetchJson<CoreData>("data/core.json");
export const loadPacks = () => fetchJson<string[]>("data/packs.json");
export const loadTextPack = (pack: string) => fetchJson<TextPack>(`data/text/${pack}.json`);

export function makeIndex(core: CoreData): GameDataIndex {
  const ids = new Set(core.identities.map((i) => i.id));
  return {
    dataVersion: core.manifest.dataVersion,
    hasIdentity: (id) => ids.has(id),
    coinCount: (sid) => core.skills[String(sid)]?.coinCount,
    skillOwners: (sid) => core.skills[String(sid)]?.owners,
    statusClass: (id) => core.buffs[id]?.buffClass ?? (core.buffs[id] ? "unknown" : undefined),
  };
}

/** Text lookup with explicit fallback marking. Display only — never feeds calculations. */
export class TextResolver {
  private nameRe: RegExp | null | undefined;
  private nameToId = new Map<string, string>();

  constructor(public readonly pack: string, private primary: TextPack, private fallback: TextPack | null,
              public readonly fallbackName: string) {}

  /**
   * Display-only linking for packs that flattened "[Id]" tokens into plain names.
   * LLC_zh-CN leaves the artefact "<name><space>" (e.g. "震颤 "), so only that form is matched,
   * and only for names that map to exactly one status/keyword id.
   */
  inlineNamePattern(): { re: RegExp; idOf: (name: string) => string | undefined } | null {
    if (this.nameRe === undefined) {
      const owners = new Map<string, Set<string>>();
      for (const cat of ["bufs", "keywords"] as const) {
        for (const [id, rec] of Object.entries(this.primary[cat])) {
          const n = rec.name?.trim();
          if (n && n.length >= 2 && !/[\s\[\]<>]/.test(n)) (owners.get(n) ?? owners.set(n, new Set()).get(n)!).add(id);
        }
      }
      for (const [n, ids] of owners) if (ids.size === 1) this.nameToId.set(n, [...ids][0]!);
      const names = [...this.nameToId.keys()].sort((a, b) => b.length - a.length)
        .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      this.nameRe = names.length ? new RegExp(`(${names.join("|")}) `, "g") : null;
    }
    return this.nameRe ? { re: this.nameRe, idOf: (n) => this.nameToId.get(n) } : null;
  }

  get<C extends TextCategory>(cat: C, id: string | number): { value: NonNullable<TextPack[C]>[string] | undefined; missing: boolean; fromFallback: boolean } {
    const key = String(id);
    const p = this.primary[cat]?.[key] as NonNullable<TextPack[C]>[string] | undefined;
    if (p) return { value: p, missing: false, fromFallback: false };
    const f = this.fallback?.[cat]?.[key] as NonNullable<TextPack[C]>[string] | undefined;
    return { value: f, missing: true, fromFallback: !!f };
  }

  /** Display name for a status / keyword / skill tag id. */
  label(id: string): string | undefined {
    for (const cat of ["bufs", "keywords", "skillTags"] as const) {
      const v = this.get(cat, id).value as NamedText | undefined;
      if (v?.name) return v.name;
    }
    return undefined;
  }

  keywordInfo(id: string): { name?: string; desc?: string; buffDesc?: string; missing: boolean } {
    const kw = this.get("keywords", id);
    const bf = this.get("bufs", id);
    const k = kw.value as NamedText | undefined;
    const b = bf.value as NamedText | undefined;
    return {
      name: k?.name ?? b?.name ?? (this.get("skillTags", id).value as NamedText | undefined)?.name,
      desc: k?.desc,
      buffDesc: b?.desc,
      missing: (kw.missing && bf.missing) || kw.fromFallback || bf.fromFallback,
    };
  }
}
