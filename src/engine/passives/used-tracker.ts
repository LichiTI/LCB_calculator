import type { PassiveCtx } from "./framework";

/**
 * Exact consumption tracker (replaces "count decrease between hooks" approximations).
 * Returns the amount of `ids` (actor side) spent in the current / most recent skill use (ActionRecord.UsedBuffStack/Turn,
 * i.e. consume/lose/effect consumption only — gains in the same window no longer cancel it) that was not yet reported to
 * the caller under `key`. Call from onCoinHit / onSkillEnd (any number of times); calls outside a skill return 0.
 */
export function newlyConsumed(c: PassiveCtx, key: string, ids: readonly string[], kind: "turn" | "stack" = "turn"): number {
  const a = c.action;
  if (!a) return 0;
  let total = 0;
  for (const id of ids) total += kind === "turn" ? a.consumedTurn(id) : a.consumedStack(id);
  const k = `newlyConsumed:${key}`;
  const seen = (a.shared.get(k) as number | undefined) ?? 0;
  if (total <= seen) return 0;
  a.shared.set(k, total);
  return total - seen;
}

/**
 * "每累计消耗 per 层X时，X强度+1" (BeforeUseBuff / GetUsedBuffTurn(X) / _TURN_DEVIDE pattern), battle-wide.
 * Returns the potency to grant now (already marked as granted).
 */
export function usedPerThreshold(c: PassiveCtx, key: string, ids: readonly string[], per = 10): number {
  const d = newlyConsumed(c, key, ids, "turn");
  if (d <= 0) return 0;
  const used = (c.state.get(`${key}:used`) ?? 0) + d;
  c.state.set(`${key}:used`, used);
  const given = c.state.get(`${key}:given`) ?? 0;
  const n = Math.floor(used / per) - given;
  if (n > 0) c.state.set(`${key}:given`, given + n);
  return Math.max(0, n);
}
