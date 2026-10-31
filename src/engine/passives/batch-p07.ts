/**
 * Passive batch 07 — see data/il2cpp/dossiers/passives-07.md
 *
 * Note: the game's OnBattleStart / OnBattleEnd are the per-turn "战斗开始时 / 战斗结束时" timings (combat phase of every
 * turn, e.g. 1101502 checks "本回合"), so they are mapped to onTurnStart / onRoundEnd here.
 */
import { giveAdder, noDamagePassive, registerPassives, type PassiveCtx } from "./framework";
import { newlyConsumed } from "./used-tracker";

const DEFAULT_SLOTS = ["S1", "S2", "S3"];
const isDefault = (c: PassiveCtx) => DEFAULT_SLOTS.includes(c.skill?.slot ?? "");
const isDefaultOrDef = (c: PassiveCtx) => isDefault(c) || c.skill?.slot === "DEF";

/**
 * Consumption tracker: exact amounts from the per-action record (ActionRecord.UsedBuffStack/Turn) via newlyConsumed.
 * `read` is kept for call-site compatibility (unused).
 */
const CONSUME_IDS: Record<string, [string[], "turn" | "stack"]> = {
  accel: [["AccelBullet"], "stack"],
  charge: [["Charge", "ChargeKhaki"], "turn"],
  fbp: [["FireBulletPropellant"], "stack"],
};
function consumed(c: PassiveCtx, key: string, _read: () => number): number {
  const [ids, kind] = CONSUME_IDS[key] ?? [[key], "turn"];
  return newlyConsumed(c, key, ids, kind);
}

/** "累计消耗10层充能 → 充能强度+1" (1091702 / 1111001 BeforeUseBuff: GetUsedBuffTurn(Charge)/10 − already given). */
function chargeOverflow(c: PassiveCtx) {
  const used = consumed(c, "charge", () => c.actor.getCount("Charge") + c.actor.getCount("ChargeKhaki"));
  if (used <= 0) return;
  const total = (c.state.get("chargeUsed") ?? 0) + used;
  c.state.set("chargeUsed", total);
  const given = c.state.get("chargeGiven") ?? 0;
  const add = Math.floor(total / 10) - given;
  if (add > 0) {
    c.state.set("chargeGiven", given + add);
    c.give("actor", "Charge", add, 0);
  }
}

const CONSUME_APPROX = "消耗量取自技能行动记录（技能外的消耗不计）";

registerPassives(
  // PassiveAbility_1091603: OnUseCoinConsume(AccelBullet) → Breath +2 potency/+2 count per bullet;
  // OnRoundStart_After_RelatedSlotState: skill 1091607 (处置) in slot → TeachersPreyRodion on last-attacked enemy.
  {
    id: 1091603,
    summary: "每消耗1发加速弹，呼吸法强度+2、层数+2；使用“处置”(1091607)的回合对目标施加[TeachersPreyRodion]",
    approx: `${CONSUME_APPROX}；呼吸法在命中后发放（实际在消耗时）；子弹耗尽不取消攻击、仅视作施加烧伤/震颤未建模；猎物印记在技能开始时施加（实际回合开始）`,
    onTurnStart(c) {
      consumed(c, "accel", () => c.actor.getPotency("AccelBullet"));
    },
    skillMods(c) {
      const key = `prey:${c.turn}`;
      if (c.skill?.id === 1091607 && !c.state.get(key)) {
        c.state.set(key, 1);
        c.give("target", "TeachersPreyRodion", 1, 0);
      }
    },
    onCoinHit(c) {
      const d = consumed(c, "accel", () => c.actor.getPotency("AccelBullet"));
      if (d > 0) c.give("actor", "Breath", 2 * d, 2 * d);
    },
    onSkillEnd(c) {
      const d = consumed(c, "accel", () => c.actor.getPotency("AccelBullet"));
      if (d > 0) c.give("actor", "Breath", 2 * d, 2 * d);
    },
  },
  // PassiveAbility_1091604: no logic in class (effect lives on Spider-Nest Ryoshu).
  noDamagePassive(1091604, "阵亡时强化蜘蛛巢良秀"),
  // PassiveAbility_1091612 / 1091602: FutureEye stacks only drop by clashing / being attacked; ObsessionAndGreedRodion
  // requires disciple 10716 to be dead (CheckDiscipleAlreadyDead) — neither happens in an unopposed simulation.
  {
    id: 1091612,
    summary: "预知眼：拼点/受击相关效果，本模拟中不触发",
    approx: "未建模：拼点获得[LookingFutureRodion]、受击使用“预知”、预知眼耗尽后装填与技能转化、子辈希斯克利夫(10716)阵亡后获得[ObsessionAndGreedRodion]",
  },
  // PassiveAbility_1091701.CalcResultAdder: default skill (incl. defense) and Charge stack ≥ 2/3/5 → final power +1/+2/+3.
  {
    id: 1091701,
    summary: "充能强度≥2/3/5级时，基础技能最终威力+1/+2/+3",
    approx: "回合结束按充能层数获得护盾未建模（不影响输出）",
    skillMods(c) {
      if (!isDefaultOrDef(c)) return;
      const p = Math.max(c.actor.getPotency("Charge"), c.actor.getPotency("ChargeKhaki"));
      const v = p >= 5 ? 3 : p >= 3 ? 2 : p >= 2 ? 1 : 0;
      return v ? { finalPower: v } : undefined;
    },
  },
  // PassiveAbility_1091702.BeforeUseBuff: every 10 Charge counts used → Charge potency +1.
  {
    id: 1091702,
    summary: "累计消耗10层充能时充能强度+1",
    approx: `${CONSUME_APPROX}；友方攻击后追加“纸样制作/剪下”未建模`,
    onTurnStart(c) {
      consumed(c, "charge", () => c.actor.getCount("Charge") + c.actor.getCount("ChargeKhaki"));
    },
    onCoinHit: chargeOverflow,
    onSkillEnd: chargeOverflow,
  },
  // PassiveAbility_1100211.GetAttackDmgMultiplier: action == owner.GetLastAction() && coin == action.GetLastCoin() → +20%.
  {
    id: 1100211,
    summary: "连锁末尾技能的最后一枚硬币伤害+20%",
    approx: "假定本技能位于连锁末尾；友方获得呼吸法时50%概率获得呼吸法未建模",
    coinMods(c) {
      if (c.skill && c.coinIndex === c.skill.coinCount - 1) return { dmg: 0.2 };
    },
  },
  noDamagePassive(1100301, "战斗开始给两侧友方忍耐与守护"),
  // PassiveAbility_1100511.OnBattleStart: ≥5 N-Corp units → SystemAbility AttackDmgupByStackRatio(10) = +10% dmg.
  {
    id: 1100511,
    summary: "队伍中N公司狂信徒≥5名时，N公司狂信徒造成的伤害+10%（未启用）",
    approx: "无法判定队友是否属于N公司狂信徒，+10%伤害未计入；拼点胜利/击杀理智回复减少不影响输出",
  },
  // PassiveAbility_1100601.OnSucceedAttack: target has Burst → self Talisman +1.
  {
    id: 1100601,
    summary: "命中带有破裂的目标时获得1层符咒",
    onCoinHit(c) {
      if (c.target.getPotency("Burst") > 0 || c.target.getCount("Burst") > 0) c.give("actor", "Talisman", 1, 0);
    },
  },
  // PassiveAbility_1100701: GetGiveBuffStackAdder/TurnAdder(+1/+1) for Vibration given ON_SUCCESS_ATTACK, condition count ≥ 10.
  {
    id: 1100701,
    summary: "正面命中时自身震颤层数≥10，则硬币效果对敌方施加的震颤强度与层数额外+1",
    approx: "“命中时(ON_SUCCESS_ATTACK)施加”按本次技能中正面硬币结算期间技能脚本的施加近似",
    // GetGiveBuffStackAdder/TurnAdder: coin heads, own Vibration turn ≥ 10, timing ON_SUCCESS_ATTACK, buf Vibration, target ≠ self → +1/+1.
    coinMods(c) {
      c.state.set("heads", c.isHeads === false ? 0 : 1);
      giveAdder(c, "skill", {
        key: "1100701",
        buffId: "Vibration",
        amount: 1,
        side: "target",
        when: (ch) => c.state.get("heads") === 1 && c.actor.getCount("Vibration") >= 10 && !!ch.source && /^\d+:/.test(ch.source),
      });
    },
  },
  // PassiveAbility_1100811.OnBattleStart: all allies faster than all enemies → PenetrateDamageUp 1; base 1100801 speed only.
  {
    id: 1100811,
    summary: "战斗开始时若己方速度均高于敌方，获得1层穿刺伤害提升",
    approx: "仅比较自身与目标速度（队友速度未知）；呼吸法换最大速度不影响伤害",
    onTurnStart(c) {
      if (c.battle.selfSpeed > c.battle.targetSpeed) c.give("actor", "PenetrateDamageUp", 1, 0);
    },
  },
  // PassiveAbility_1100902: no logic in class (unstable E.G.O state machine handled elsewhere).
  {
    id: 1100902,
    summary: "不稳定E.G.O::蜡翼状态切换（需理智值）",
    approx: "理智值驱动的状态切换未建模；若场景给予[UnstableFeeling]，相关效果由状态本身与1100911处理",
  },
  // PassiveAbility_1100903: hidden; CheckAllyDawn gives/destroys an unresolved buff depending on Dawn-office allies.
  {
    id: 1100903,
    summary: "隐藏被动：黎明事务所队友相关状态（未建模）",
    approx: "CheckAllyDawn 给予/移除的状态 id 未能确定，未建模",
  },
  // PassiveAbility_1100911 / 1100901: Combustion give stack/turn +1 (6/turn); coin power +SP/20 (SP 45 → +3) while UnstableFeeling.
  {
    id: 1100911,
    summary: "施加烧伤强度与层数+1（每回合6次）；不稳定E.G.O状态下硬币威力+理智值/20",
    approx: "需要“修改施加状态数值”与“读取自身理智值”能力：烧伤+1/+1与硬币威力加成均未建模",
  },
  noDamagePassive(1101001, "战斗开始按震颤层数获得防御等级提升"),
  // PassiveAbility_1101201.OnEndAttack: default skill or counter → consume all target VendettaMark, gain equal VengeanceBookSinclair.
  {
    id: 1101211,
    summary: "基础攻击/反击技能攻击后消耗目标全部[VendettaMark]，获得等量[VengeanceBookSinclair]",
    approx: "友方受击施加（2+3层）未建模；自身受击施加仅在可选敌方行动模型下触发（每回合1次，5层按描述）",
    // PassiveAbility_1101201.OnTakeAttackDamage: GiveBuff_Giver(VendettaMark 931, _STACK_ON_ATTACKED_SELF) to the attacker,
    // _ABILITY_CNT_MAX_ON_ATTACKED_SELF = 1.
    onTakeAttack(c) {
      if (c.state.get(`hit:${c.turn}`)) return;
      c.state.set(`hit:${c.turn}`, 1);
      c.give("target", "VendettaMark", 5, 0);
    },
    onSkillEnd(c) {
      if (!isDefault(c) && c.skill?.defType !== "COUNTER") return;
      const m = c.target.getPotency("VendettaMark");
      if (m <= 0) return;
      c.lose("target", "VendettaMark", m);
      c.give("actor", "VengeanceBookSinclair", m, 0);
    },
  },
  // PassiveAbility_1101312.OnUseBuff: consumed FireBulletPropellant → next-turn AttackDmgUp = amount (max 3).
  {
    id: 1101312,
    summary: "消耗火药弹时下回合获得等量伤害提升(最多3层)",
    approx: `${CONSUME_APPROX}；子弹耗尽时不取消攻击但不施加烧伤未建模`,
    onTurnStart(c) {
      consumed(c, "fbp", () => c.actor.getPotency("FireBulletPropellant"));
    },
    onCoinHit(c) {
      giveFbp(c);
    },
    onSkillEnd(c) {
      giveFbp(c);
    },
  },
  // PassiveAbility_1101401: BeforeGiveAttackDamage/OnSucceedAttack (Burst ≥7, prob maxReso×15%, 4/turn → +1 Combustion);
  // OnBattleEnd: self has Combustion → next turn ChickenStance/CrimsonDamageUp/ShamrockDamageUp 1;
  // OnBattleStart: trunc(lostHp/20%) (max 3) → AttackUp + DefenseUp.
  {
    id: 1101401,
    summary: "每失去20%体力获得攻击/防御等级提升(最多3)；回合结束带烧伤则下回合获得鸡架势、暴怒/嫉妒伤害提升各1层",
    approx: "命中破裂≥7目标时按最大共鸣数×15%概率施加烧伤未建模（共鸣数未知）",
    onTurnStart(c) {
      const n = Math.min(3, Math.trunc(c.battle.lostHpPct / 20));
      if (n > 0) {
        c.give("actor", "AttackUp", n, 0);
        c.give("actor", "DefenseUp", n, 0);
      }
    },
    onRoundEnd(c) {
      if (c.actor.getPotency("Combustion") <= 0 && c.actor.getCount("Combustion") <= 0) return;
      c.give("actor", "ChickenStance", 1, 0, 1);
      c.give("actor", "CrimsonDamageUp", 1, 0, 1);
      c.give("actor", "ShamrockDamageUp", 1, 0, 1);
    },
  },
  // PassiveAbility_1101501: OnBattleStart Breath potency +min(4, pride/2+1); OnBattleEnd Breath ≥20 → +1 count.
  // OnSucceedAttack/OnEndAttack extra slash damage uses _ADDITIONAL_SLASH_DMG_RATIO which is 0 unless set externally → ignored.
  {
    id: 1101501,
    summary: "战斗开始时呼吸法强度+min(4, 傲慢共鸣/2+1)；战斗结束时呼吸法强度≥20则获得1层呼吸法",
    approx: "傲慢共鸣数取场景 battle.resonance.VIOLET（未声明按 0）",
    onTurnStart(c) {
      c.give("actor", "Breath", Math.min(4, Math.floor((c.battle.resonance?.VIOLET ?? 0) / 2) + 1), 0);
    },
    onRoundEnd(c) {
      if (c.actor.getPotency("Breath") >= 20) c.give("actor", "Breath", 0, 1);
    },
  },
  // PassiveAbility_1101502.OnRoundEnd: convert min(Breath−25, 15, LittleFingerID room) Breath potency → LittleFingerID.
  {
    id: 1101502,
    summary: "回合结束时将超过25级的呼吸法强度(最多15级)转化为[LittleFingerID]",
    approx: "未装备攻击技能时的理智回复与斩击威力提升不触发（模拟中总是攻击）",
    onRoundEnd(c) {
      const room = 20 - c.actor.getPotency("LittleFingerID");
      const amt = Math.min(c.actor.getPotency("Breath") - 25, 15, room);
      if (amt <= 0) return;
      c.give("actor", "LittleFingerID", amt, 0);
      c.lose("actor", "Breath", amt);
    },
  },
  {
    id: 1101602,
    summary: "触发流血时获得[ChargeRougeAlly]等红派资源（未建模）",
    approx: "流血触发事件、[BuffetSinclair]与[ChargeRougeAlly]的累计强度提升未建模；基础技能视作获得充能的技能未建模",
  },
  {
    id: 1101603,
    summary: "积累[HungrySinclair]后转化技能为“贪求”并变身（未建模）",
    approx: "需要技能转化/变身能力：[HungrySinclair]积累、[TransformSinclair]专属技能未建模",
  },
  noDamagePassive(1101611, "友方混乱时支援/不死效果"),
  {
    id: 1101614,
    summary: "红派支援与变身后追加技能（未建模）",
    approx: "需要追加技能/友方行动能力：“我来帮忙”“要求”、[BuffetThirst]、[DinnerField]等未建模",
  },
  // PassiveAbility_1110101: target SP < 0 → +10% dmg.
  {
    id: 1110101,
    summary: "目标理智值低于0时伤害+10%（目标理智取场景值）",
    coinMods(c) {
      if (c.targetSp !== undefined && c.targetSp < 0) return { dmg: 0.1 };
    },
  },
  // PassiveAbility_1110201: target HP ratio < _CONDITION (0.25) → +_ADDDMG (0.2) dmg.
  {
    id: 1110201,
    summary: "目标体力低于25%时伤害+20%",
    coinMods(c) {
      return c.targetHpRatio() < 0.25 ? { dmg: 0.2 } : undefined;
    },
  },
  noDamagePassive(1110301, "下回合自身与两侧友方获得迅捷"),
  // PassiveAbility_1110401: target resist Weak/Fatal for this skill → +10% dmg.
  {
    id: 1110401,
    summary: "以“脆弱/致命”抗性攻击时伤害+10%",
    // GetAttackDmgMultiplier: CheckCondition(GetAtkResistLevelByType(skill atk)) || CheckCondition(GetAttributeResistLevelByType(skill sin))
    coinMods(c) {
      const s = c.skill;
      const lv = [
        s?.sin && s.sin !== "NEUTRAL" ? c.targetResistLevel?.({ sin: s.sin as import("../../config/game-data").SinAttribute }) : undefined,
        s?.atkType ? c.targetResistLevel?.({ atkType: s.atkType as import("../../config/game-data").AtkType }) : undefined,
      ];
      if (lv.some((l) => l === "WEAK" || l === "VULNERABLE")) return { dmg: 0.1 };
    },
  },
  // PassiveAbility_1110501.OnGiveBsGaugeUp: vibration burst → Sloth damage = 30% of stagger shift (max 20).
  {
    id: 1110501,
    summary: "震颤引爆时追加混乱阈值前移量30%的怠惰伤害（最多20）",
    approx: "前移量按 震颤强度%×目标最大体力（向下取整）换算；未设置目标最大体力时按上限20计算（同 VEOnSAGiveCrimsonDmgByBgUpRatio30WithLimit20）",
    onVibrationExplosion(c, ev) {
      if (ev.side !== "target") return;
      const maxHp = c.targetMaxHp();
      const amt = maxHp == null ? 20 : Math.min(Math.floor(Math.floor((ev.potency * maxHp) / 100) * 0.3), 20);
      if (amt > 0) c.extraDamage(amt, "震颤引爆附加怠惰伤害（阈值前移×30%，上限20）", { sin: "AMBER" });
    },
  },
  // PassiveAbility_1110711 (DEVIDE=1) / 1110701.BeforeAttack: target defense reduced ≥4 → Breath potency += target Combustion (20/turn).
  {
    id: 1110711,
    summary: "目标防御等级降低≥4时，攻击前呼吸法强度+目标烧伤强度(每回合最多20)",
    approx: "防御等级降低量按目标[DefenseDown]层数估算",
    skillMods(c) {
      if (c.target.getPotency("DefenseDown") < 4) return;
      const key = `breath:${c.turn}`;
      const used = c.state.get(key) ?? 0;
      const amt = Math.min(c.target.getPotency("Combustion"), 20 - used);
      if (amt <= 0) return;
      c.state.set(key, used + amt);
      c.give("actor", "Breath", amt, 0);
    },
  },
  // PassiveAbility_1110811 / 1110801.GetAttackDmgMultiplier: clash vs SP<0 (+20%, clash only) and target EchoOfMansion (+30%).
  {
    id: 1110811,
    summary: "对带有[EchoOfMansion]的目标伤害+30%",
    approx: "与理智值<0目标拼点时的拼点威力+1/伤害+20%、拼点胜利回复理智/攻击提升为拼点效果未建模",
    coinMods(c) {
      if (c.target.get("EchoOfMansion")) return { dmg: 0.3 };
    },
  },
  noDamagePassive(1110902, "仅视作施加流血的人格（关键词归类）"),
  {
    id: 1110911,
    summary: "战斗开始时使负面状态最少的2名敌人随机一种异常状态强度+2（未建模）",
    approx: "随机选择烧伤/流血/震颤/破裂/沉沦，结果不确定，未建模",
  },
  // PassiveAbility_1111001: BeforeUseBuff/CheckAbility → Charge potency +1 per 10 used; ParryingResultUp is clash-only.
  {
    id: 1111001,
    summary: "累计消耗10层充能时充能强度+1",
    approx: `${CONSUME_APPROX}；W公司队友获得拼点威力提升为拼点效果`,
    onTurnStart(c) {
      consumed(c, "charge", () => c.actor.getCount("Charge") + c.actor.getCount("ChargeKhaki"));
    },
    onCoinHit: chargeOverflow,
    onSkillEnd: chargeOverflow,
  },
);

function giveFbp(c: PassiveCtx) {
  const d = consumed(c, "fbp", () => c.actor.getPotency("FireBulletPropellant"));
  if (d <= 0) return;
  const key = `fbp:${c.turn}`;
  const used = c.state.get(key) ?? 0;
  const amt = Math.min(d, 3 - used);
  if (amt <= 0) return;
  c.state.set(key, used + amt);
  c.give("actor", "AttackDmgUp", amt, 0, 1);
}
