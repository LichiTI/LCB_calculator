/**
 * Shared helpers for skill replacement (BattleActionModel.ChangeSkill) used by ScriptHandler.beforeUse.
 * Game pattern (SkillAbility_SpecialSkill<id>, <id>_special_skill, SkillChangeSpecialTo<id>, ChangeToSpecialSkillOnBeforeTurn<id>):
 * OnBeforeTurn → CheckCondition (GetSingleUnit(buffOwner) stack ≥ bd.stack [&& turn ≥ bd.turn]) → ChangeSkill(_SPECIAL_SKILL_ID).
 */
import type { StatusContainer } from "../status";
import type { PassiveCtx, ScriptCtx } from "./framework";

/** AbilityBase.GetSingleUnit(buffOwner): "Target"/"*Target" → main target, otherwise the actor. */
export const replaceOwner = (c: PassiveCtx, owner?: string): StatusContainer => (owner && /Target$/.test(owner) ? c.target : c.actor);

/**
 * buffData check (stack ≥ bd.stack, turn ≥ bd.turn, status present) on buffOwner, then c.replaceSkill(id).
 * Returns true when the replacement was accepted.
 */
export function replaceIfBuff(
  c: ScriptCtx,
  id: number,
  opts: { keyword?: string; stack?: number; turn?: number; owner?: string; reason?: string } = {},
): boolean {
  const bd = c.script.buffData;
  const kw = opts.keyword ?? bd?.buffKeyword;
  if (!kw) return false;
  const o = replaceOwner(c, opts.owner ?? bd?.buffOwner);
  if (!o.get(kw)) return false;
  if (o.getPotency(kw) < (opts.stack ?? bd?.stack ?? 1)) return false;
  if (o.getCount(kw) < (opts.turn ?? bd?.turn ?? 0)) return false;
  return c.replaceSkill?.(id, opts.reason ?? `${kw}≥${opts.stack ?? bd?.stack ?? 1}`) ?? false;
}
