/**
 * Dawn Office Faust (10216).
 * Sources: PassiveAbility_1021601 (OnSucceedAttack: if the check unit 11009 [Dawn Office Sinclair identity] is alive and the attacking skill is a
 * default skill and the coin was rerolled → ForceToActivateSinBuffEffect(Combustion, min(target Burn potency, _ADDITIONAL_DMG_LIMIT)),
 * capped per round by _ADDITIONAL_DMG_ROUND_LIMIT), PassiveAbility_1021611 (base 1021601 + OnBattleStart: Firstlight × 3 Cello Case
 * via SystemAbility_CheckStackStigmaWorkshopCelloCase), PassiveAbility_1021602 (only Burn damage taken / immortality), 1021603 (UI only).
 */
import { noDamagePassive, registerPassives, type PassiveCtx } from "./framework";

const CELLO = "StigmaWorkshopCelloCaseOne";
const JOINT_APPROX = "黎明事务所联合攻击：声明黎明队友（人格ID）时假设其每回合用基础技能攻击一次，自身插入 1021607（不声明则不触发）";

// PassiveAbility_DawnAdditionalAttack: a DAWN ally ending an attack with a default skill → the owner cuts in its additional attack.
function dawnJoint(c: PassiveCtx) {
  if ((c.allyIdentities?.() ?? []).some((a) => a.associations.includes("DAWN"))) {
    c.queueAction?.(1021607, { label: "黎明联合攻击", key: "dawnJoint" });
  }
}

function sinclairBurn(limit: number, roundLimit: number) {
  return (c: PassiveCtx) => {
    if (!c.isRerolled || !c.allyPresent("11009")) return;
    const key = `burn:${c.turn}`;
    const used = c.state.get(key) ?? 0;
    const amount = Math.min(c.target.getPotency("Combustion"), limit, Math.max(0, roundLimit - used));
    if (amount <= 0) return;
    c.state.set(key, used + amount);
    c.extraDamage(amount, `黎明辛克莱(#11009)在场：重投硬币命中触发烧伤效果 ${amount}`);
  };
}

registerPassives(
  {
    id: 1021601,
    summary: "黎明辛克莱(#11009)在场时，重投的硬币命中额外触发烧伤效果（目标烧伤强度，单次上限 10，每回合 20）",
    approx: JOINT_APPROX,
    onTurnStart: dawnJoint,
    onCoinHit: sinclairBurn(10, 20),
  },
  {
    id: 1021611,
    summary: "战斗开始按初光层数×3 获得大提琴盒；黎明辛克莱(#11009)在场时重投硬币命中额外触发烧伤效果（单次上限 10，每回合 20）",
    approx: JOINT_APPROX,
    // Game OnBattleStart fires at the combat phase of every turn → onTurnStart.
    onTurnStart(c) {
      const fl = c.actor.getPotency("Firstlight");
      if (fl > 0) c.gain(CELLO, fl * 3);
      dawnJoint(c);
    },
    onCoinHit: sinclairBurn(10, 20),
  },
  noDamagePassive(1021602, "自身受到的烧伤伤害调整与不死判定"),
  noDamagePassive(1021603, "仅界面显示"),
);
