/**
 * Project terminology for status families.
 * DOT = the five negative sin statuses. Breath / Charge share buffClass "SinBuff" in game data
 * but are resources/buffs, not DOT.
 */
export const DOT_IDS = ["Combustion", "Laceration", "Vibration", "Burst", "Sinking"] as const;
export type DotId = (typeof DOT_IDS)[number];

export const RESOURCE_SIN_IDS = ["Breath", "Charge"] as const;
export type ResourceSinId = (typeof RESOURCE_SIN_IDS)[number];

export function isDotId(id: string): id is DotId {
  return (DOT_IDS as readonly string[]).includes(id);
}

/**
 * How a raw buffData {stack, turn} maps to the calculator's {potency, count}.
 * Evidence (docs/phase-a-report.md §4.1):
 *   - SinBuff (DOT, Breath, Charge): stack = potency (强度), turn = count (层数).
 *   - VolatileBuff (e.g. DefenseDown): text calls `stack` "层" -> count; there is no potency.
 * Other classes are not yet verified and must be treated as "unknown" by callers.
 */
export type AmountSemantics = "potencyAndCount" | "countOnlyFromStack" | "unknown";

export function amountSemantics(buffClass: string | undefined): AmountSemantics {
  switch (buffClass) {
    case "SinBuff":
    case "ChargeSinBuff":
      return "potencyAndCount";
    case "VolatileBuff":
      return "countOnlyFromStack";
    default:
      return "unknown";
  }
}
