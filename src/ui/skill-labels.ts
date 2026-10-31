import type { CoreData } from "../data/game-data";

export interface SkillRole {
  /** Full label shown in tables, e.g. "三技能" / "反击" / "反击→三技能". */
  label: string;
  /** Community short code used in schedule strings, e.g. "3" / "反" / "反(3)". */
  short: string;
  /** Raw data slot used for grouping (S1/S2/S3/...). */
  slot: string;
}

const SLOT_LABEL: Record<string, string> = { S1: "一技能", S2: "二技能", S3: "三技能" };
const SLOT_SHORT: Record<string, string> = { S1: "1", S2: "2", S3: "3" };

/**
 * Player-facing role of a skill. Defense skills carry slot "S1" in the raw data (e.g. 1061704),
 * so this must look at defType first; otherwise counters show up as "S1".
 */
export function skillRole(core: CoreData, skillId: number): SkillRole {
  const s = core.skills[String(skillId)];
  const slot = s?.slot ?? "?";
  const def = s?.attrs.defType;
  const hidden = (s?.abilityScripts ?? []).some((a) => a.scriptName === "HiddenSkill");
  if (def === "COUNTER" && hidden) {
    const up = SLOT_LABEL[slot] ?? slot;
    return { label: `反击→${up}`, short: `反(${SLOT_SHORT[slot] ?? slot})`, slot };
  }
  if (def === "COUNTER") return { label: "反击", short: "反", slot };
  if (def === "GUARD" || def === "EVADE") return { label: def === "GUARD" ? "守备" : "闪避", short: "守", slot };
  return { label: SLOT_LABEL[slot] ?? slot, short: SLOT_SHORT[slot] ?? slot, slot };
}
