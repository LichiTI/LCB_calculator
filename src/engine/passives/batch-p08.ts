/** Passive batch 08 — see data/il2cpp/dossiers/passives-08.md */
import { giveAdder, noDamagePassive, registerPassives, type PassiveCtx } from "./framework";
import { newlyConsumed } from "./used-tracker";

const isDefaultSkill = (c: PassiveCtx) => c.skill?.slot === "S1" || c.skill?.slot === "S2" || c.skill?.slot === "S3";

/** Track cumulative consumption of resource statuses (game: GetActivatedBuffSecondaryStack / GetUsedBuffTurn) by observing decreases. */
/** Battle-wide consumption total; `count` adds the exact amount spent in the current skill use (ActionRecord via newlyConsumed). */
const USED_IDS: Record<string, [string[], "turn" | "stack"]> = {
  fuel: [["FirePunchFuel", "FirePunchFuelOverheated"], "stack"],
  charge: [["Charge"], "turn"],
};
function trackUsed(c: PassiveCtx, key: string, _cur: number, count: boolean): number {
  let used = c.state.get(`${key}:used`) ?? 0;
  if (count) {
    const [ids, kind] = USED_IDS[key] ?? [[key], "turn"];
    used += newlyConsumed(c, key, ids, kind);
  }
  c.state.set(`${key}:used`, used);
  return used;
}

const fuelTotal = (c: PassiveCtx) => c.actor.getPotency("FirePunchFuel") + c.actor.getPotency("FirePunchFuelOverheated");
const chargeCount = (c: PassiveCtx) => c.actor.getCount("Charge");

registerPassives(
  noDamagePassive(1111102, "血宴：按全场流血伤害获得血宴（演出/资源，PassiveAbility_1111102 无逻辑）"),
  {
    // PassiveAbility_1111111 : 1111101.GetAttackDmgMultiplier — BloodDinner_Accumulation(618) 每层 +0.1%(上限30%)；
    // 目标带流血(39)时 +流血强度×0.5%(上限10%)。基类每层系数/上限的 getter 常量在 ISIL 中不可见，按描述取 0.001/0.3。
    id: 1111111,
    summary: "每10层血宴积累伤害+1%(最多30%)；目标每1级流血强度伤害+0.5%(最多10%)",
    approx: "拼点威力+1（对裂断人格）未建模；血宴积累每层系数按描述取值",
    coinMods(c) {
      const acc = Math.min(c.actor.getPotency("BloodDinner_Accumulation") * 0.001, 0.3);
      const lac = c.target.getPotency("Laceration");
      const add = lac > 0 ? Math.min(lac * 0.005, 0.1) : 0;
      return { dmg: acc + add };
    },
  },
  {
    // PassiveAbility_1111201.GetAttackDmgMultiplier: 自身有 LegStrength(920)、目标有 BurstAgility(923) → 层数×5%(上限15%)
    id: 1111201,
    summary: "自身有腿力且目标有爆发敏捷时，每层腿力伤害+5%(最多15%)",
    coinMods(c) {
      const leg = c.actor.getPotency("LegStrength");
      if (leg <= 0 || c.target.getPotency("BurstAgility") <= 0) return;
      return { dmg: Math.min(leg * 0.05, 0.15) };
    },
  },
  {
    // PassiveAbility_1111301.GetSkillPowerResultAdder: 带 TimeRentalTwoPersonality(529) → 最终威力+1
    id: 1111301,
    summary: "带有时间租赁人格时技能最终威力+1",
    approx: "体力10%~20%时回合结束回复体力与解除混乱未建模",
    skillMods(c) {
      if (c.actor.get("TimeRentalTwoPersonality")) return { finalPower: 1 };
    },
  },
  {
    // PassiveAbility_1111401: OnBattleStart GiveBuff_Self(TheUdjatOutis,2)；GetAttackDmgMultiplier: Protection(17)层数×5%(上限15%)
    id: 1111401,
    summary: "战斗开始获得2层荷鲁斯之眼；每层守护伤害+5%(最多15%)",
    onBattleStart(c) {
      c.gain("TheUdjatOutis", 2);
    },
    coinMods(c) {
      const p = c.actor.getPotency("Protection");
      if (p > 0) return { dmg: Math.min(p * 0.05, 0.15) };
    },
  },
  {
    // PassiveAbility_1111412/1111402.OnSucceedAttack: 带 TheUdjatOutis(1328)，基础技能命中 → 目标 SheutFracture(1329)
    // GetStackOnSA = max(1, 消耗的 LCA_Bullet 数)，每回合最多15层
    id: 1111412,
    summary: "带有荷鲁斯之眼时基础技能命中施加1层碎裂(每回合最多15层)",
    approx: "消耗LCA弹药时按弹药数额外施加未建模（引擎无弹药消耗信息）；基础技能每回合获得守护上限5层的限制、回合开始因恐慌类型获得荷鲁斯之眼未建模",
    onCoinHit(c) {
      if (!isDefaultSkill(c) || c.actor.getPotency("TheUdjatOutis") <= 0) return;
      const key = `sheut:${c.turn}`;
      const used = c.state.get(key) ?? 0;
      if (used >= 15) return;
      c.state.set(key, used + 1);
      c.give("target", "SheutFracture", 1, 0);
    },
  },
  {
    id: 1111501,
    summary: "复仇账簿：按嫉妒共鸣与受击获得怨恨，回合结束施加复仇账簿",
    approx: "未建模：战斗开始按嫉妒共鸣数获得怨恨(最多7层，引擎无共鸣数)、受击/友方受击获得怨恨、复仇账簿施加与强化纹身",
  },
  noDamagePassive(1111502, "视作施加烧伤/流血的人格（仅关键词判定）"),
  {
    // PassiveAbility_1111504.OnSucceedAttack: 子辈以实玛利(10814)同场时，命中获得1层 DaughterEducationSpiderOutis(1771)，每回合1次
    id: 1111504,
    summary: "子辈以实玛利(#10814)在场时，技能命中获得1层孩子的教育(每回合1次)",
    approx: "拼点胜利获得层数（模拟无拼点）与给以实玛利的效果未建模",
    onCoinHit(c) {
      if (!c.allyPresent("10814")) return;
      const key = `edu:${c.turn}`;
      if (c.state.get(key)) return;
      c.state.set(key, 1);
      c.gain("DaughterEducationSpiderOutis", 1);
    },
  },
  noDamagePassive(1111505, "阵亡后给蜘蛛巢良秀的效果"),
  noDamagePassive(1111506, "友方拼点失败时插入特殊技能/击杀中指友方的奖励（模拟中不触发）"),
  {
    id: 1111513,
    summary: "首次登场获得剑一阶段与1层技能计数",
    approx: "未建模：计数归零后追加使用“拆开包装吧”、怨恨15层时转化技能、体力≤50%获得父辈斗志、混乱解除等（需技能插入/转化能力）",
    onBattleStart(c) {
      // desc: 首次登场获得 MiddleFatherSwordOneOutis 并获得1层 CountSkillMidOutis
      if (!c.actor.get("MiddleFatherSwordOneOutis")) c.gain("MiddleFatherSwordOneOutis", 1);
      if (!c.actor.get("CountSkillMidOutis")) c.gain("CountSkillMidOutis", 1);
    },
  },
  {
    // PassiveAbility_1120201.OnSucceedAttack: coin index([coin+0x50]) >= 2 → GiveBuff_Giver(Combustion, stack 1)
    id: 1120201,
    summary: "技能第3枚及之后的硬币命中时，目标烧伤强度+1",
    onCoinHit(c) {
      if ((c.coinIndex ?? 0) >= 2) c.give("target", "Combustion", 1, 0);
    },
  },
  {
    // PassiveAbility_1120501.GetGiveBuffStackAdder: 施加 Burst(41) 时若目标有 Vibration(40) → 强度+1
    id: 1120501,
    summary: "对带有震颤的目标施加破裂强度时额外+1",
    onBattleStart(c) {
      giveAdder(c, "persistent", {
        key: "1120501",
        buffId: "Burst",
        amount: 1,
        kinds: ["stack"],
        side: "target",
        // own skill/engine gives only (status abilities of other units carry their own source tags)
        when: (ch) => (ch.source === undefined || /^\d+:/.test(ch.source)) && c.target.getPotency("Vibration") > 0,
      });
    },
  },
  noDamagePassive(1120601, "战斗开始条件获得防御等级提升"),
  {
    // PassiveAbility_1120702.OnSucceedAttack: 目标有流血(39)且正面命中 → 获得1层 Unjust_Enrichment(322, 上限4)
    // 之后若硬币消耗弹药(有弹药)/或弹药耗尽时暴击 → 消耗全部层数，额外造成 finalDmg×(0.25|0.05)×层数 的固定伤害
    id: 1120702,
    summary: "正面命中带流血的目标获得1层不义之财(最多4层)",
    approx: "消耗弹药硬币命中时按不义之财追加本硬币伤害25%/层（弹药耗尽后暴击5%/层）未建模：引擎无弹药/消耗弹药硬币信息",
    onCoinHit(c) {
      if (c.isHeads === false || c.target.getPotency("Laceration") <= 0) return;
      if (c.actor.getPotency("Unjust_Enrichment") < 4) c.gain("Unjust_Enrichment", 1);
    },
  },
  {
    // PassiveAbility_1120911/1120901.GetAttackDmgMultiplier: 目标沉沦强度×2%(上限40%)（getter 常量不可见，按描述）
    id: 1120911,
    summary: "目标每1级沉沦强度伤害+2%(最多40%)",
    approx: "战斗开始按理智值变化获得伤害提升/易损未建模（无理智值模拟）",
    coinMods(c) {
      const s = c.target.getPotency("Sinking");
      if (s > 0) return { dmg: Math.min(s * 0.02, 0.4) };
    },
  },
  noDamagePassive(1121002, "血宴：按全场流血伤害获得血宴（演出/资源）"),
  noDamagePassive(1121011, "回合结束为友方回复理智/不死判定"),
  {
    // PassiveAbility_1121101.CalculateDmgMul: 本场消耗燃料(SecondaryStack of 911)×0.2%(上限40%)；
    // 目标烧伤强度+层数 ≥30（或主要目标为血魔/血袋）→ ×0.3%(上限60%)
    id: 1121101,
    summary: "本场每消耗1层燃料伤害+0.2%(最多40%)；目标烧伤强度+层数≥30时改为+0.3%(最多60%)",
    approx: "血魔/血袋单位判定、击杀/混乱时扩散烧伤未建模",
    onBattleStart(c) {
      trackUsed(c, "fuel", fuelTotal(c), false);
    },
    onTurnStart(c) {
      trackUsed(c, "fuel", fuelTotal(c), false);
    },
    coinMods(c) {
      const used = trackUsed(c, "fuel", fuelTotal(c), true);
      if (used <= 0) return;
      const reinforced = c.target.getPotency("Combustion") + c.target.getCount("Combustion") >= 30;
      return { dmg: reinforced ? Math.min(used * 0.003, 0.6) : Math.min(used * 0.002, 0.4) };
    },
    onSkillEnd(c) {
      trackUsed(c, "fuel", fuelTotal(c), true);
    },
  },
  {
    // PassiveAbility_1121102 无逻辑（关卡开始状态由关卡数据给予）；若模拟开始时没有燃料则补 100 层
    id: 1121102,
    summary: "关卡开始带有100层燃料（若场景未设置）",
    approx: "燃料≤50层时转化为过热燃料由状态自身处理，未在此建模",
    onBattleStart(c) {
      if (fuelTotal(c) <= 0) c.gain("FirePunchFuel", 100);
    },
  },
  {
    // PassiveAbility_1121201.GetAttackDmgMultiplier: 目标有 BurstPoison(939) → SnakeStance(940)层数×5%(上限15%)
    // OnGiveBuffTrigger: 触发后目标不再有 BurstPoison → 下回合 PenetrateDamageUp(53) 1层（_ACTIVE_CNT_MAX 2）
    id: 1121201,
    summary: "目标有爆发毒素时每层蛇势伤害+5%(最多15%)；使爆发毒素降至0时下回合获得1层穿刺伤害提升(最多2次)",
    approx: "爆发毒素清零通过命中前后观察判定",
    coinMods(c) {
      const has = c.target.getPotency("BurstPoison") > 0;
      c.state.set("hadPoison", has ? 1 : 0);
      const s = c.actor.getPotency("SnakeStance");
      if (has && s > 0) return { dmg: Math.min(s * 0.05, 0.15) };
    },
    onCoinHit(c) {
      if (!c.state.get("hadPoison") || c.target.getPotency("BurstPoison") > 0) return;
      c.state.set("hadPoison", 0);
      const n = c.state.get("pen") ?? 0;
      if (n >= 2) return;
      c.state.set("pen", n + 1);
      c.give("actor", "PenetrateDamageUp", 1, 0, 1);
    },
  },
  noDamagePassive(1121302, "“慈悲”每回合使用次数限制"),
  noDamagePassive(1121311, "速度差施加缴械(仅削弱目标)、击杀获得穿刺威力提升、友方攻击后追击“慈悲”（模拟中不触发）"),
  {
    // PassiveAbility_1121402.OnRoundStart_After_Event: GiveBuff_Self(LanternGregBigBird(1566), 1)
    id: 1121402,
    summary: "回合开始获得1层目灯",
    approx: "获得敏捷改为拼点威力提升（拼点专属）与速度锁定未建模",
    onTurnStart(c) {
      c.gain("LanternGregBigBird", 1);
    },
  },
  noDamagePassive(1121403, "按E.G.O装备友方获得防御等级提升；友方阵亡奖励（模拟中不触发）"),
  {
    id: 1121411,
    summary: "战斗开始每有2点忧郁共鸣获得1层目灯（最多3层，共鸣取场景 battle.resonance）",
    // 不影响输出：理智回复/友方顺从效果
    // OnBattleStart: GetAttributeResonance(AZURE) ≥ 6 → 3, else floor(n/2) → GiveBuff_Self(LanternGregBigBird)
    onTurnStart(c) {
      const n = Math.min(3, Math.floor((c.battle.resonance?.AZURE ?? 0) / 2));
      if (n > 0) c.give("actor", "LanternGregBigBird", n, 0);
    },
  },
  {
    // PassiveAbility_1121502.BeforeUseBuff/CheckAbility: 累计消耗 Charge 层数(GetUsedBuffTurn)/10 → 每份 +1 强度
    id: 1121502,
    summary: "本场每累计消耗10层充能，充能强度+1",
    // 不影响输出：充能强度≥3时速度+1、力场转化、不死判定
    onBattleStart(c) {
      trackUsed(c, "charge", chargeCount(c), false);
    },
    onTurnStart(c) {
      trackUsed(c, "charge", chargeCount(c), false);
    },
    coinMods(c) {
      check1121502(c);
    },
    onSkillEnd(c) {
      check1121502(c);
    },
  },
  {
    id: 1121503,
    summary: "交流放电支援：E.G.O装备友方≥3时全体获得攻击等级提升",
    approx: "引擎无法判断友方是否身着E.G.O装备，攻击等级提升未建模；以护盾/体力代替充能消耗未建模",
  },
  {
    // PassiveAbility_1121511/1121501.OnBattleStart: 首次 GiveBuff_Self(Charge, 10层)，每场1次
    id: 1121511,
    summary: "战斗开始获得10层充能(每场1次)",
    approx: "按忧郁/嫉妒共鸣给予友方或自身充能（引擎无共鸣数）、战斗结束转移溢出充能未建模",
    onBattleStart(c) {
      c.give("actor", "Charge", 0, 10);
    },
  },
  noDamagePassive(1121602, "受到烧伤伤害减少/不死判定"),
  {
    id: 1121603,
    summary: "黎明事务所：按黎明事务所人格数获得黎明队伍",
    approx: "需同事务所队友，黎明队伍/辛克莱相关状态未建模",
  },
  {
    // PassiveAbility_1121611.OnSucceedAttack: 带 DawnLight(1855) 时基础技能命中 → 自身 StigmaWorkshopHandStep1(1852) +2
    // 基类 1121601: 黎明辛克莱在场时，基础技能“额外添加的硬币”命中触发烧伤（min(强度,10)，每回合20）
    id: 1121611,
    summary: "带有晨光(DawnLight)时基础技能命中获得2层烙印工坊之手",
    approx: "黎明辛克莱在场时额外硬币命中触发烧伤（需“能力追加硬币”标记）未建模；联合攻击：声明黎明队友时假设其每回合用基础技能攻击一次，自身插入 1121607",
    // PassiveAbility_DawnAdditionalAttack: a DAWN ally ending an attack with a default skill → owner cuts in its additional attack.
    onTurnStart(c) {
      if ((c.allyIdentities?.() ?? []).some((a) => a.associations.includes("DAWN"))) {
        c.queueAction?.(1121607, { label: "黎明联合攻击", key: "dawnJoint" });
      }
    },
    onCoinHit(c) {
      if (isDefaultSkill(c) && c.actor.getPotency("DawnLight") > 0) c.gain("StigmaWorkshopHandStep1", 2);
    },
  },
);

function check1121502(c: PassiveCtx): void {
  const used = trackUsed(c, "charge", chargeCount(c), true);
  const given = c.state.get("given") ?? 0;
  const due = Math.floor(used / 10) - given;
  if (due <= 0) return;
  c.state.set("given", given + due);
  c.give("actor", "Charge", due, 0);
  // the give itself doesn't change count, so baseline stays valid
}
