/**
 * Game-logic metadata extracted from the game client (tools/il2cpp → generated/logic-meta.json):
 * for every skill / coin script, buff ability and passive, which battle hooks it overrides,
 * which game APIs it calls, and whether it can change one-sided damage at all.
 *
 * impact:
 *  - "damage"      → can change the damage numbers; if the calculator has no handler it is a real gap
 *  - "untriggered" → only reacts to clash wins/losses, kills, being hit, evading… (never happens in an unopposed simulation)
 *  - "none"        → only touches SP / HP recovery / shields / clash power / targeting / presentation
 */
import meta from "./generated/logic-meta.json";

export type LogicImpact = "damage" | "untriggered" | "none";

export interface LogicInfo {
  cls: string;
  base: string[];
  hooks: string[];
  calls: string[];
  keywords: string[];
  impact: LogicImpact;
  reason?: string;
  dependsOnAlly?: boolean;
}

interface LogicMeta {
  generatedFrom: string;
  scripts: Record<string, LogicInfo>;
  buffAbilities: Record<string, LogicInfo>;
  passives: Record<string, LogicInfo>;
}

const M = meta as unknown as LogicMeta;

export const LOGIC_META_VERSION = M.generatedFrom;

export function scriptLogic(name: string, scope: "skill" | "coin"): LogicInfo | undefined {
  return M.scripts[`${scope}:${name}`] ?? M.scripts[`${scope === "skill" ? "coin" : "skill"}:${name}`];
}

export function buffAbilityLogic(ability: string): LogicInfo | undefined {
  return M.buffAbilities[ability];
}

export function passiveLogic(id: number | string): LogicInfo | undefined {
  return M.passives[String(id)];
}

/** Unknown scripts default to "damage" (conservative). */
export function scriptImpact(name: string, scope: "skill" | "coin"): LogicImpact {
  return scriptLogic(name, scope)?.impact ?? "damage";
}

export function passiveImpact(id: number | string): LogicImpact {
  return passiveLogic(id)?.impact ?? "damage";
}

/** A status is harmless when every one of its abilities is harmless. */
export function buffImpact(abilities: string[]): LogicImpact {
  if (!abilities.length) return "none";
  let worst: LogicImpact = "none";
  for (const a of abilities) {
    const i = buffAbilityLogic(a)?.impact ?? "damage";
    if (i === "damage") return "damage";
    if (i === "untriggered") worst = "untriggered";
  }
  return worst;
}

export const IMPACT_LABEL: Record<LogicImpact | "approx", string> = {
  damage: "影响伤害",
  approx: "近似假设",
  untriggered: "本场景不触发",
  none: "不影响伤害",
};
