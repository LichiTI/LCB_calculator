/**
 * Passive batch 04 — see data/il2cpp/dossiers/passives-04.md
 *
 * Note on timing: game PassiveAbility.OnBattleStart runs at every turn's combat start (e.g. 1061111 "Breath ≥ 20 → +1 Breath",
 * 1060611 "Charge ≥ 5 → next-turn Haste" only make sense per turn), so conditional OnBattleStart effects are mapped to onTurnStart.
 * Once-per-stage effects (OnStageStart / first-appearance flags / OnAddUnit) use onBattleStart.
 */
import { isOwnSkillSource, noDamagePassive, registerPassives, type PassiveCtx } from "./framework";

const isDefault = (c: PassiveCtx) => c.skill?.slot === "S1" || c.skill?.slot === "S2" || c.skill?.slot === "S3";
const isAttack = (c: PassiveCtx) => !!c.skill && c.skill.coinCount > 0 && !!c.skill.atkType && c.skill.atkType !== "NONE";
const coinKey = (c: PassiveCtx) => `${c.skill?.id}:${c.coinIndex}`;

/** PassiveAbility_1051101.OnRoundEnd: Breath potency / 3 → next-turn Agility (max 2). Shared by 1061601 (1061611). */
function breathToAgility(c: PassiveCtx) {
  const n = Math.min(Math.floor(c.actor.getPotency("Breath") / 3), 2);
  if (n > 0) c.give("actor", "Agility", n, 0, 1);
}

// ---------------------------------------------------------------- 10512 (Lei Heng Meursault) bullets
// Coins with UseBullet[optional:BulletPropellantAlly:1] (core.json skills of 10512). The engine does not consume bullets,
// so 1051202 consumes them on hit (special bullets when the default ones are gone).
const BULLET_COINS = new Set(["1051201:1", "1051202:1", "1051202:2", "1051203:0", "1051203:1", "1051203:2", "1051205:2", "1051205:3", "1051205:4"]);
// Bullet coins that give Combustion: "s" = gives potency (stack>0), "t" = gives count (turn>0).
const BULLET_BURN: Record<string, "s" | "t"> = {
  "1051201:1": "s",
  "1051202:1": "s",
  "1051202:2": "t",
  "1051203:0": "s",
  "1051203:1": "t",
  "1051205:2": "s",
  "1051205:3": "t",
};
const ALLY_BULLET = "BulletPropellantAlly";
const SPECIAL_BULLET = "BulletPropellantSpecialAlly";

// ---------------------------------------------------------------- 10609 / 10604 / 10612 / 10515 coin tables (core.json)
const VIBRATION_EXPLOSION_COINS = new Set(["1060902:2", "1060903:1"]);
const BURN_COINS_10604 = new Set(["1060401:1", "1060402:0", "1060402:1", "1060403:0"]);
const SINKING_STACK_COINS_10612 = new Set(["1061201:1", "1061202:0", "1061202:1", "1061202:2", "1061203:0"]);
const CLAW_COINS_10515 = new Set(["1051503:2"]);

registerPassives(
  // PassiveAbility_1051102 (hidden): GetSkillPowerAdder +1 if continued concentrated-attack turns ≥ 2, GetCoinScaleAdder +1 if ≥ 3
  // (parry +1 at exactly 1 is clash-only).
  {
    id: 1051102,
    summary: "集中攻击-默尔索：目标层数≥2 时基础威力+1，≥3 时硬币威力+1",
    approx: "以目标[集中攻击-默尔索]层数近似“连续集中攻击回合数”；集中攻击仅在集中遭遇战生效，普通战斗中实际无效",
    skillMods(c) {
      const n = c.target.getPotency("ConcentratedAttackMeursault");
      return { basePower: n >= 2 ? 1 : 0, coinScale: n >= 3 ? 1 : 0 };
    },
  },
  // PassiveAbility_1051111 (base 1051101): OnRoundEnd Breath/3 → Agility next turn (max 2); OnSucceedAttack with a default skill →
  // GiveBuff_Giver(ConcentratedAttackMeursault) next turn if the target has no ready one. MP heal on kill/part break omitted.
  {
    id: 1051111,
    summary: "回合结束按呼吸法强度/3 下回合获得迅捷(最多2)；基础技能命中时下回合对目标施加集中攻击-默尔索",
    approx: "集中攻击仅在集中遭遇战生效；击杀/破坏部位回复理智未建模",
    onCoinHit(c) {
      if (!isDefault(c)) return;
      const key = `ca:${c.turn}`;
      if (c.state.get(key)) return;
      c.state.set(key, 1);
      c.give("target", "ConcentratedAttackMeursault", 1, 0, 1);
    },
    onRoundEnd: breathToAgility,
  },
  // PassiveAbility_1051202: bullet bookkeeping (BlockGivingBuff, BulletChangeAbility on round end, OnStartBehaviour BeastEyesAlly).
  {
    id: 1051202,
    summary: "虎标弹：消耗弹药的硬币命中时消耗1发；虎标弹耗尽后回合结束装填8发猛虎标弹并获得(心-)天退星；基础技能用尽猛虎标弹时下回合获得兽眼",
    approx:
      "首次装备守备技能/混乱触发换弹、攻击目标数+2 未建模；弹药按命中时消耗；空弹判定按两种弹药均为0（游戏内另有一字段条件未解析）",
    // BlockGivingBuff: coin consumes BulletPropellantAlly && keyword == Combustion && no bullet left → this coin's burn is not given.
    coinMods(c) {
      const empty = BULLET_COINS.has(coinKey(c)) && c.actor.getPotency(ALLY_BULLET) <= 0 && c.actor.getPotency(SPECIAL_BULLET) <= 0;
      c.state.set("emptyCoin", empty ? 1 : 0);
      if (!empty) return;
      const state = c.state;
      const skillId = c.skill?.id;
      c.interceptStatus?.(
        "skill",
        (ch) => (ch.buffId === "Combustion" && ch.delta > 0 && state.get("emptyCoin") === 1 && isOwnSkillSource(skillId, ch.source) ? 0 : undefined),
        { side: "both", key: "1051202:emptyBurn" },
      );
    },
    onCoinHit(c) {
      if (!BULLET_COINS.has(coinKey(c))) return;
      if (c.actor.getPotency(ALLY_BULLET) > 0) {
        c.lose("actor", ALLY_BULLET, 1);
        c.state.set("used", (c.state.get("used") ?? 0) + 1);
        c.state.set("hadAlly", 1);
      } else if (c.actor.getPotency(SPECIAL_BULLET) > 0) {
        c.lose("actor", SPECIAL_BULLET, 1);
        c.state.set("used", (c.state.get("used") ?? 0) + 1);
        if (c.actor.getPotency(SPECIAL_BULLET) <= 0 && isDefault(c)) c.give("actor", "BeastEyesAlly", 1, 0, 1);
      }
    },
    onRoundEnd(c) {
      // BulletChangeAbility: once per battle (_BULLET_CHANGE_ACTIVE_CNT_MAX 1) when the default bullets are used up.
      if (c.state.get("changed") || !c.state.get("hadAlly") || c.actor.getPotency(ALLY_BULLET) > 0) return;
      c.state.set("changed", 1);
      c.give("actor", SPECIAL_BULLET, 8, 0);
      // consumed ≥ _USED_BULLET_CONDITION (8) → HugeIrritationAlly instead of IrritationAlly
      c.give("actor", (c.state.get("used") ?? 0) >= 8 ? "HugeIrritationAlly" : "IrritationAlly", 1, 0);
    },
  },
  // PassiveAbility_1051211 (base 1051201): bullet coins with ammo left: coin power +1 / dmg +10% (default), +2 / +30% (special);
  // special: Combustion stack/turn adder +2 (GetGiveBuffStackAdder / GetGiveBuffTurnAdder, only if the coin already gives them).
  // DMG getters return xmm0 constants not visible in ISIL → values from desc.
  {
    id: 1051211,
    summary: "消耗弹药的硬币：虎标弹时硬币威力+1、伤害+10%；猛虎标弹时硬币威力+2、伤害+30%，且烧伤强度/层数额外+2",
    approx: "转化为[SuperCoin]未建模（模拟默认正面）；伤害倍率取自描述",
    coinMods(c) {
      const k = coinKey(c);
      c.state.set("special", 0);
      if (!BULLET_COINS.has(k)) return;
      if (c.actor.getPotency(ALLY_BULLET) > 0) return { coinScale: 1, dmg: 0.1 };
      if (c.actor.getPotency(SPECIAL_BULLET) > 0) {
        c.state.set("special", 1);
        return { coinScale: 2, dmg: 0.3 };
      }
    },
    onCoinHit(c) {
      if (!c.state.get("special")) return;
      const kind = BULLET_BURN[coinKey(c)];
      if (kind === "s") c.give("target", "Combustion", 2, 0);
      else if (kind === "t") c.give("target", "Combustion", 0, 2);
    },
  },
  noDamagePassive(1051302, "血宴：按全场流血伤害获得[BloodDinner]（由系统能力处理）"),
  // PassiveAbility_1051303.OnCompleteCommand: if unit 10911 (La Manchaland Princess Rodion) is alive, AddAbilityThisRound(377)
  // (PerfectParade: S3 dmg +15%, _DMG_MULTIPLIER 0.15). FocusOnActing part is provided by BloodArmorMeursault itself.
  {
    id: 1051303,
    summary: "拉·曼却领 公主 罗佳(#10911)在场时，3技能造成的伤害+15%",
    approx: "BloodArmor 满层时的混乱解除未建模",
    skillMods(c) {
      if (c.skill?.slot === "S3" && c.allyPresent("10911")) return { dmg: 0.15 };
    },
  },
  // PassiveAbility_1051311 (base 1051301): OnBattleStart BloodArmorMeursault ≥3 → AttackUp 2 + DefenseUp 2; ≥4 → Agility 2 next turn;
  // FocusOnActing → OnSucceedAttack gives ParadeConcentration (≤2 per turn). HP heal omitted.
  {
    id: 1051311,
    summary: "战斗开始时按[BloodArmorMeursault]层数获得攻击强化/防御强化(≥3)与迅捷(≥4)；带[FocusOnActing]时命中施加[ParadeConcentration](每回合2次)",
    approx: "[FocusOnActing]判定改为命中时检查（游戏于战斗开始时检查）；低体力回复未建模",
    onTurnStart(c) {
      const n = c.actor.getPotency("BloodArmorMeursault");
      if (n >= 3) {
        c.give("actor", "AttackUp", 2, 0);
        c.give("actor", "DefenseUp", 2, 0);
      }
      if (n >= 4) c.give("actor", "Agility", 2, 0, 1);
    },
    onCoinHit(c) {
      if (c.actor.getPotency("FocusOnActing") <= 0) return;
      const key = `pc:${c.turn}`;
      const used = c.state.get(key) ?? 0;
      if (used >= 2) return;
      c.state.set(key, used + 1);
      c.give("target", "ParadeConcentration", 1, 0);
    },
  },
  // PassiveAbility_1051402: spore bullet reload/convert/cancel system. Bee Spore itself comes from the skills' coin scripts.
  {
    id: 1051402,
    summary: "孢子弹：弹药装填/转换/取消硬币系统（由孢子弹硬币与 ReloadOn* 脚本实现，见 batch-s10；蜂孢子由技能硬币施加）",
    approx: "装填/转换消耗的理智未计入",
  },
  noDamagePassive(1051411, "击杀带蜂孢子目标时下回合蜂孢子翻倍并回收孢子弹（模拟中不发生击杀）"),
  // PassiveAbility_1051501: GetGiveBuffStackAdder BearClawWoundAlly +1 while FaubismMaskMeursault; every 4 claws → SP heal and
  // (if SP is max) HitDamageUp next turn — SP not tracked.
  {
    id: 1051501,
    summary: "带[FaubismMaskMeursault]时施加的[BearClawWoundAlly]额外+1层",
    approx: "每施加4层熊爪伤回复理智、理智满时下回合获得打击伤害提升未建模（引擎无理智值）",
    onCoinHit(c) {
      if (c.actor.getPotency("FaubismMaskMeursault") <= 0) return;
      if (isDefault(c) || CLAW_COINS_10515.has(coinKey(c))) c.give("target", "BearClawWoundAlly", 1, 0);
    },
  },
  // PassiveAbility_1051502: counts BearClawWoundAlly given (RightAfterAnyUnitGetAnyBuff); OnRoundEnd ≥10 → FaubismMaskMeursault.
  // The "default skill hit → 1 claw" part is not in the class ISIL (desc only).
  {
    id: 1051502,
    summary: "基础技能命中时施加1层[BearClawWoundAlly]；累计施加≥10层后回合结束获得[FaubismMaskMeursault]",
    approx: "施加熊爪伤的实现未在类代码中找到，按描述每次基础技能命中施加1层；累计层数仅统计本被动与3技能第3枚硬币",
    onCoinHit(c) {
      let n = 0;
      if (isDefault(c)) {
        c.give("target", "BearClawWoundAlly", 1, 0);
        n += 1;
      }
      if (CLAW_COINS_10515.has(coinKey(c))) n += 1;
      if (n && c.actor.getPotency("FaubismMaskMeursault") > 0) n *= 2; // 1051501 adder
      c.state.set("claws", (c.state.get("claws") ?? 0) + n);
    },
    onRoundEnd(c) {
      if ((c.state.get("claws") ?? 0) >= 10 && c.actor.getPotency("FaubismMaskMeursault") <= 0) c.give("actor", "FaubismMaskMeursault", 1, 0);
    },
  },
  // PassiveAbility_1060201.OnSucceedAttack: last coin of the unit's last action → GiveBuff_Giver(Laceration potency 3).
  {
    id: 1060201,
    summary: "连锁末尾技能的最后一枚硬币命中时使目标流血强度+3",
    approx: "假设每个技能都是本回合最后一个行动",
    onCoinHit(c) {
      if (c.skill && c.coinIndex === c.skill.coinCount - 1) c.give("target", "Laceration", 3, 0);
    },
  },
  noDamagePassive(1060301, "下回合开始按暴食共鸣数×2 回复理智"),
  // PassiveAbility_1060401.GetGiveBuffTurnAdder: Combustion from an attack skill → count +1 if MP ≥ 30.
  {
    id: 1060401,
    summary: "理智≥30 时攻击技能施加的烧伤层数+1",
    approx: "引擎无理智值，假设理智≥30；仅对数据中带烧伤施加的硬币生效",
    onCoinHit(c) {
      if (BURN_COINS_10604.has(coinKey(c))) c.give("target", "Combustion", 0, 1);
    },
  },
  noDamagePassive(1060501, "受击低体力时回复体力并获得安瓿"),
  noDamagePassive(1060611, "战斗开始时按充能层数下回合获得迅捷（仅速度）"),
  // PassiveAbility_1060901: OnGiveBsGaugeUp(onExplosion) counts explosions; OnRoundEnd AttackDmgUp min(count, 3) next turn.
  {
    id: 1060901,
    summary: "回合结束按本回合造成震颤引爆的次数，下回合获得等量伤害提升(最多3层)",
    onVibrationExplosion(c, ev) {
      if (ev.side === "target") c.state.set(`ve:${c.turn}`, (c.state.get(`ve:${c.turn}`) ?? 0) + 1);
    },
    onRoundEnd(c) {
      const n = Math.min(c.state.get(`ve:${c.turn}`) ?? 0, 3);
      if (n > 0) c.give("actor", "AttackDmgUp", n, 0, 1);
    },
  },
  // PassiveAbility_1061011 (base 1061001): dmg +10% if target is <血魔>/<血袋> or Burst ≥ 10 (CheckCondition);
  // skill start with own Laceration → on hit Burst potency +3, _MAX_COUNT 2 per turn.
  {
    id: 1061011,
    summary: "目标为<血魔>/<血袋>或破裂强度≥10 时伤害+10%；自身带流血时攻击命中使目标破裂强度+3(每回合2次)",
    approx: "+10% 取自描述",
    skillMods(c) {
      // CheckCondition: target UNIT_KEYWORD 34 BLOODFIEND / 33 BLOODBAG, or Burst ≥ 10
      if (c.target.getPotency("Burst") >= 10 || c.targetHasUnitKeyword?.("BLOODFIEND") || c.targetHasUnitKeyword?.("BLOODBAG")) return { dmg: 0.1 };
    },
    onCoinHit(c) {
      if (c.actor.getPotency("Laceration") <= 0) return;
      const key = `b:${c.turn}`;
      const used = c.state.get(key) ?? 0;
      if (used >= 2) return;
      c.state.set(key, used + 1);
      c.give("target", "Burst", 3, 0);
    },
  },
  noDamagePassive(1061101, "弹药耗尽时硬币不取消（引擎不消耗弹药）"),
  // PassiveAbility_1061111.OnBattleStart: Breath potency ≥ 20 → +1 Breath count.
  {
    id: 1061111,
    summary: "战斗开始时若呼吸法强度≥20，获得1层呼吸法",
    approx: "希斯克利夫撤退/待命时强化2、3技能（技能替换）未建模",
    onTurnStart(c) {
      if (c.actor.getPotency("Breath") >= 20) c.give("actor", "Breath", 0, 1);
    },
  },
  // PassiveAbility_1061211 (base 1061201): Charge ≥ 2: default-skill dmg +min(Charge×5%, 25%); Sinking stack adder
  // +min(floor(Charge/2), 2) when giving Sinking potency. Per-10-consumed Charge potency +1 is already done by StatusContainer.consumeCount.
  {
    id: 1061211,
    summary: "充能强度≥2 时基础攻击技能伤害+充能强度×5%(最多25%)，施加的沉沦强度额外+充能/2(最多2)",
    approx: "伤害倍率取自描述（ISIL 中为常量）；每消耗10层充能+1强度由引擎状态系统处理",
    skillMods(c) {
      const ch = c.actor.getPotency("Charge");
      if (ch >= 2 && isDefault(c)) return { dmg: Math.min(ch * 0.05, 0.25) };
    },
    onCoinHit(c) {
      const ch = c.actor.getPotency("Charge");
      if (ch < 2 || !isDefault(c) || !SINKING_STACK_COINS_10612.has(coinKey(c))) return;
      c.give("target", "Sinking", Math.min(Math.floor(ch / 2), 2), 0);
    },
  },
  // PassiveAbility_1061301.GetAttackDmgMultiplier: CondensedBlood stack × 0.03.
  {
    id: 1061301,
    summary: "自身每带有1层[CondensedBlood]，技能伤害+3%",
    approx: "不死触发获得凝血、E.G.O不死后每回合获得伤害提升、黑兽支援守护未建模",
    skillMods(c) {
      const n = c.actor.getPotency("CondensedBlood");
      if (n > 0) return { dmg: 0.03 * n };
    },
  },
  // PassiveAbility_1061302.GetAttackDmgMultiplier: min(HeishouComboCountHonglu × 0.05, 0.55).
  {
    id: 1061302,
    summary: "自身每带有1层[HeishouComboCountHonglu]，伤害+5%(最多55%)",
    approx: "队友登场指令攻击、黑兽阵亡回复等队伍效果未建模",
    skillMods(c) {
      const n = c.actor.getPotency("HeishouComboCountHonglu");
      if (n > 0) return { dmg: Math.min(0.05 * n, 0.55) };
    },
  },
  // PassiveAbility_RingFingerHongLuFaustNormalPassiveBase (1061404): first appearance ChargeBodyArt = RingFinger units × 2 (max 10);
  // OnEndTurn +5 if HP/shield damage dealt (+3 on kill); per 10 consumed +1 potency (engine), potency ≥ 2 → TibiaPersonality.
  {
    id: 1061404,
    summary: "首次登场按环指单位数×2 获得活体材料；技能造成伤害后获得5层活体材料；活体材料强度≥2 时获得[TibiaPersonality]",
    approx: "环指队友数无法判断，仅计自身；击杀额外+3未建模；每消耗10层+1强度由引擎状态系统处理",
    onBattleStart(c) {
      c.give("actor", "ChargeBodyArt", 0, 2);
    },
    onSkillEnd(c) {
      if (isAttack(c)) c.give("actor", "ChargeBodyArt", 0, 5);
      if (c.actor.getPotency("ChargeBodyArt") >= 2 && c.actor.getPotency("TibiaPersonality") <= 0) c.give("actor", "TibiaPersonality", 1, 0);
    },
  },
  // PassiveAbility_1061405: GoldenOpportunity (21 from initBuffs) −1 per ring-finger skill use; at 0 → replace a skill with 1061406.
  {
    id: 1061405,
    summary: "使用技能时[GoldenOpportunity]-1（每回合1次）；归零后转化技能",
    approx: "技能转化为“闭馆-装置艺术第1号”与环指队友使用技能的扣减未建模",
    onSkillEnd(c) {
      const key = `go:${c.turn}`;
      if (c.state.get(key)) return;
      c.state.set(key, 1);
      c.lose("actor", "GoldenOpportunity", 1);
    },
  },
  {
    id: 1061411,
    summary: "子辈浮士德3技能前插入支援攻击；施加负面状态的攻击后回复理智（理智满时下回合获得斩击伤害提升）",
    approx: "引擎无理智值，斩击伤害提升(需理智满)与支援攻击插入未建模",
  },
  // PassiveAbility_1061501: CalcAttackDmgMultiplierByBuff: speed diff × 2% (max 10%), ×2 (max 20%) if target has TiedRopeHonglu;
  // CalcAttackDmgMultiplierBySkill: +5% per ally with Slash Pride skill (max 30%) — ally skills unknown.
  {
    id: 1061501,
    summary: "速度高于目标时伤害+速度差×2%(最多10%)，目标带[TiedRopeHonglu]时翻倍(最多20%)",
    approx: "装备斩击傲慢技能的队友数加成(每名+5%，最多30%)未建模",
    skillMods(c) {
      const diff = c.battle.selfSpeed - c.battle.targetSpeed;
      if (diff <= 0) return;
      const tied = c.target.getPotency("TiedRopeHonglu") > 0;
      return { dmg: tied ? Math.min(diff * 0.04, 0.2) : Math.min(diff * 0.02, 0.1) };
    },
  },
  noDamagePassive(1061502, "目标带绑绳时获得[TiedWithRopeID]，集中遭遇战改变敌方目标"),
  // PassiveAbility_1061602.OnSucceedAttack: default skill hitting its main target without a ready DianxueHongLu → give 1 next turn.
  {
    id: 1061602,
    summary: "基础攻击技能命中主目标时，下回合对其施加1层[DianxueHongLu](每回合1次)",
    approx: "Cinq协会队友提供的[DuelSousTemoinsEast]未建模（无法判断队友所属）",
    onCoinHit(c) {
      if (!isDefault(c)) return;
      const key = `dx:${c.turn}`;
      if (c.state.get(key)) return;
      c.state.set(key, 1);
      c.give("target", "DianxueHongLu", 1, 0, 1);
    },
  },
  // PassiveAbility_Dianxue (1061603, hidden): target DianxueHongLu 1 → clash +1, 2 → base power +1, 3 → both.
  {
    id: 1061603,
    summary: "点穴-鸿璐：目标层数为2或3时基础威力+1",
    skillMods(c) {
      if (c.target.getPotency("DianxueHongLu") >= 2) return { basePower: 1 };
    },
  },
  // PassiveAbility_1061611 (base 1061601): crit dmg +min(target Combustion × 1%, 15% + 5% × DianxueHongLu); OnRoundEnd Breath/3 → Agility.
  {
    id: 1061611,
    summary: "暴击时伤害+目标烧伤强度%(上限15%，目标每层点穴上限+5%)；回合结束按呼吸法强度/3 下回合获得迅捷(最多2)",
    approx: "拼点胜利施加点穴未建模；上限15%取自描述",
    coinMods(c) {
      if (!c.isCritical) return;
      const cap = 0.15 + 0.05 * c.target.getPotency("DianxueHongLu");
      const v = Math.min(c.target.getPotency("Combustion") * 0.01, cap);
      if (v > 0) return { dmg: v };
    },
    onRoundEnd: breathToAgility,
  },
  // PassiveAbility_1070101.GetAttackDmgMultiplier: +10% vs targets with higher max HP.
  {
    id: 1070101,
    summary: "对体力上限高于自身的目标伤害+10%",
    approx: "未设置目标最大体力时假设目标体力上限更高；自身体力上限按 base+perLevel×等级 估算",
    skillMods(c) {
      const t = c.targetMaxHp();
      return t == null || t > c.selfMaxHp() ? { dmg: 0.1 } : undefined;
    },
  },
  // PassiveAbility_1070201: after taking attack damage this round (RoundDamageInfo.GetDamageSum > 0) dmg +10%.
  {
    id: 1070201,
    summary: "本回合受到攻击伤害后伤害+10%",
    approx: "模拟中目标不攻击，自身不受伤，故不触发",
  },
  // PassiveAbility_1070311.OnRoundStart_After_Event: Charge count += Wrath resonance; Charge count ≥ 5 → Agility 1 + Enhancement 1.
  {
    id: 1070311,
    summary: "回合开始时按暴怒共鸣数获得充能层数；充能层数≥5则获得1层迅捷与1层强壮（共鸣取场景 battle.resonance）",
    onTurnStart(c) {
      if (c.turn < 2) return;
      const res = c.battle.resonance?.CRIMSON ?? 0;
      if (res > 0) c.give("actor", "Charge", 0, res);
      if (c.actor.getCount("Charge") >= 5) {
        c.give("actor", "Agility", 1, 0);
        c.give("actor", "Enhancement", 1, 0);
      }
    },
  },
);
