/** Passive batch 01 — see data/il2cpp/dossiers/passives-01.md */
import { negativeBuffCount } from "../param-scripts";
import { noDamagePassive, registerPassives, type PassiveCtx } from "./framework";
import { usedPerThreshold } from "./used-tracker";

/** BeforeUseBuff(Charge): every 10 Charge count used this battle → Charge potency +1 (exact, per-action record). */
function grantUsedCharge(c: PassiveCtx): void {
  const n = usedPerThreshold(c, "chg", ["Charge"]);
  if (n > 0) c.give("actor", "Charge", n, 0);
}

const isDefault = (c: PassiveCtx) => ["S1", "S2", "S3"].includes(c.skill?.slot ?? "");

/** Per-turn counter helper: returns true and increments if used < max this turn. */
function takeTurn(c: PassiveCtx, key: string, max: number): boolean {
  const k = `${key}:${c.turn}`;
  const used = c.state.get(k) ?? 0;
  if (used >= max) return false;
  c.state.set(k, used + 1);
  return true;
}

registerPassives(
  // PassiveAbility_1010101.OnBattleStart: GetNextUnitsByPortrait(2) → AttackDmgUp 1 (allies after self only)
  noDamagePassive(1010101, "战斗开始使仪表盘后方2名友方获得1层伤害强化（不含自身）"),

  // PassiveAbility_1010311.GetCoinScaleAdder: min(Breath count(GetActivatedBuffTurn) / 5, 3); OnWinDuel → Breath 1 count
  {
    id: 1010311,
    summary: "每5层呼吸法（层数）硬币威力+1（最多+3）",
    approx: "拼点胜利获得呼吸法仅在可选敌方行动模型（拼点胜利）下触发",
    // OnWinDuel: GiveBuff_Self(Breath, count _TURN 1)
    onWinDuel(c) {
      c.give("actor", "Breath", 0, 1, 0);
    },
    coinMods(c) {
      const add = Math.min(Math.floor(c.actor.getCount("Breath") / 5), 3);
      return add > 0 ? { coinScale: add } : undefined;
    },
  },

  // PassiveAbility_1010401.GetAttackDmgMultiplier: action.GetAliveTargetUnitModelList().Count >= 2 → +0.3
  {
    id: 1010401,
    summary: "攻击目标数≥2时伤害+30%",
    approx: "攻击目标数 = min(攻击容量, 场景“目标数量”)",
    skillMods(c) {
      return (c.hitTargetCount?.() ?? c.battle.targetCount) >= 2 ? { dmg: 0.3 } : undefined;
    },
  },

  // PassiveAbility_1010501.OnGiveBsGaugeUp(onExplosion): floor(value/4) DefenseDown, max 5 per target per turn
  {
    id: 1010501,
    summary: "震颤引爆时每前移4点混乱阈值施加1层防御等级降低（每目标每回合≤5）",
    approx: "前移量按引爆时震颤强度计（引擎 staggerShift）；其他改变前移量的效果未计入",
    onVibrationExplosion(c, ev) {
      if (ev.side !== "target") return;
      const key = `dd:${c.turn}`;
      const n = Math.min(Math.floor(ev.potency / 4), 5 - (c.state.get(key) ?? 0));
      if (n <= 0) return;
      c.state.set(key, (c.state.get(key) ?? 0) + n);
      c.give("target", "DefenseDown", n, 0);
    },
  },

  // PassiveAbility_1010601/1010611: round end Agility (Charge count/5, max 3); on Charge use → ChargeForceField to lowest-HP ally
  noDamagePassive(1010611, "回合结束按充能层数获得迅捷；消耗充能时使最低体力友方获得充能力场"),

  // PassiveAbility_1010701.GetGiveBuffStackAdder: critical + buf==Laceration(39) → +2, _ACTIVATE_MAX 6 (decremented in RightAfterGiveBuffBySkill)
  {
    id: 1010701,
    summary: "暴击命中时若该硬币使目标流血强度增加，则额外+2（每回合最多6次）",
    approx: "以“硬币命中前后目标流血强度增加”判定本硬币施加了流血；仅覆盖命中时施加的流血",
    coinMods(c) {
      c.state.set("lacBefore", c.target.getPotency("Laceration"));
    },
    onCoinHit(c) {
      if (!c.isCritical) return;
      const before = c.state.get("lacBefore") ?? 0;
      if (c.target.getPotency("Laceration") <= before) return;
      if (!takeTurn(c, "lac", 6)) return;
      c.give("target", "Laceration", 2, 0);
    },
  },

  // PassiveAbility_1010801/1010811: on being attacked → Sinking to attacker
  noDamagePassive(1010811, "受到攻击时使攻击者增加沉沦强度"),

  // PassiveAbility_1010902: keyword classification only
  noDamagePassive(1010902, "仅改变人格关键词分类"),

  // PassiveAbility_1010901/1010911.OnSucceedAttack: target Laceration potency >= 4 (CONDITION_STACK) → SP heal 2 + min(neg count,3);
  // remainBuff (4/turn) and SP is max → AttackUp 2 (get__STACK) next round (_ACTIVE_ROUND 1)
  {
    id: 1010911,
    summary: "命中流血强度≥4的目标时（每回合≤4次），下回合获得2层攻击等级提升",
    approx: "理智值未追踪：假设恢复理智时理智已满（AttackUp 条件）；理智恢复本身不影响伤害",
    onCoinHit(c) {
      if (c.target.getPotency("Laceration") < 4) return;
      if (!takeTurn(c, "trig", 4)) return;
      c.give("actor", "AttackUp", 2, 0, 1);
    },
  },

  // PassiveAbility_1011002: BulletLament magazine (stack=生蝶 / turn=亡蝶), random consumption, reload on lack
  {
    id: 1011002,
    summary: "战斗开始带有生蝶/亡蝶各10点（弹药）",
    approx: "随机消耗生蝶/亡蝶、施加对应蝶未建模；弹药不足取消后续硬币并装填由 batch-s02 脚本实现（装填按理智概率期望值分配）",
    onBattleStart(c) {
      if (!c.actor.get("BulletLament")) c.give("actor", "BulletLament", 10, 10);
    },
  },

  // PassiveAbility_1011003 (hidden, EGO equipped & awaken>=2).OnSucceedAttack: default skill, once per skill → Vibration stack 2 (keyword 40)
  {
    id: 1011003,
    summary: "基础技能命中时对目标增加2级震颤强度（每技能1次）",
    approx: "隐藏被动：需装备对应E.G.O，此处假设已装备",
    skillMods(c) {
      c.state.set("used", 0);
    },
    onCoinHit(c) {
      if (!isDefault(c) || (c.state.get("used") ?? 0) >= 1) return;
      c.state.set("used", 1);
      c.give("target", "Vibration", 2, 0);
    },
  },

  // PassiveAbility_1011011: on kill → reload; on BulletLament gain → Agility 2 next turn
  noDamagePassive(1011011, "击杀时装填；获得弹药时下回合获得迅捷（击杀不发生，迅捷仅影响速度）"),

  // PassiveAbility_1011201/1011211.OnRoundEnd: SP heal for allies
  noDamagePassive(1011211, "回合结束为友方恢复理智值"),

  // PassiveAbility_1011301: kill ally → FellBulletPersonality; BoseProjektil refund for E.G.O
  noDamagePassive(1011301, "击杀友方获得凶弹人格；E.G.O 凶弹弹药返还"),
  // PassiveAbility_1011302.OnRoundEnd: carry BoseProjektil to next round (E.G.O resource)
  noDamagePassive(1011302, "回合结束保留魔弹层数至下回合（仅用于E.G.O）"),

  // PassiveAbility_1011402: effects on ally Hong Lu / Ishmael(10812): Breath, Enhancement, support attack by Ishmael.
  //   OnEndTurn: own skill 1011405 (_SUPPORTED_SKILL_ID) and Ishmael alive & CanSupportiveAttack → Ishmael cuts in her tier-3 skill
  //   (GetOriginalSkillByTier 3) on the main target, _SUPPORT_CNT_MAX 1.
  {
    id: 1011402,
    summary: "使用“1011405”后，以实玛利(#10812)在场时其以3技能援护攻击（每回合1次）",
    approx: "为鸿璐/以实玛利提供呼吸法/伤害强化（队友状态）未建模；援护攻击需在场队友填写 10812",
    onSkillEnd(c) {
      if (c.skill?.id !== 1011405 || !(c.allyIdentities?.() ?? []).some((a) => a.id === 10812)) return;
      c.allyAttack?.({ allyId: 10812, skillId: 1081203, key: "1011402", label: "援护攻击 " });
    },
  },

  // PassiveAbility_1011403.RightAfterGiveBuffBySkill: buf==BattlefieldHorse(1137), once per turn →
  // without SystemAbility_1011411: AttackUp 3 now + 3 next round; with it (triggered last turn): only next round
  {
    id: 1011403,
    summary: "技能给予战场之马时，本回合与下回合获得3层攻击等级提升（上回合已触发则仅下回合）",
    approx: "仅当技能使自身战场之马增加时可检测；仅给予其他友方时未建模",
    skillMods(c) {
      c.state.set("bh", c.actor.getPotency("BattlefieldHorse"));
    },
    onSkillEnd(c) {
      if (c.actor.getPotency("BattlefieldHorse") <= (c.state.get("bh") ?? 0)) return;
      if (c.state.get("lastTurn") === c.turn) return;
      const prev = c.state.get("lastTurn");
      c.state.set("lastTurn", c.turn);
      if (prev !== c.turn - 1) c.give("actor", "AttackUp", 3, 0);
      c.give("actor", "AttackUp", 3, 0, 1);
    },
  },

  // PassiveAbility_1011401.OnStartBehaviour: attack skill != 1011405, selfSpeed - targetSpeed >= 2, _stackThisTurn < 3 → BreakthroughHorse 1
  // PassiveAbility_1011411.GetDefenseAdder (shield/10 defense) is defensive only
  {
    id: 1011411,
    summary: "攻击开始时速度高于目标≥2则获得1层突破之马（每回合≤3层，黑风马蹄月斩除外）",
    approx: "拼点胜利获取未建模（无拼点）；引爆计数按本次行动累计（OnGiveBsGaugeUp 计数字段归属未解析）；护盾防御等级不影响输出",
    // OnGiveBsGaugeUp(onExplosion): skill != 1011405, explosion count + 1 ≥ _VE_CNT_CONDITION(2) → ActivateAbility (BreakthroughHorse 1, ≤3/turn).
    onVibrationExplosion(c, ev) {
      if (ev.side !== "target" || !c.action || c.skill?.id === 1011405) return;
      const n = ((c.action.shared.get("1011411:ve") as number | undefined) ?? 0) + 1;
      c.action.shared.set("1011411:ve", n);
      if (n < 2 || !takeTurn(c, "bh", 3)) return;
      c.give("actor", "BreakthroughHorse", 1, 0);
    },
    skillMods(c) {
      if (c.skill?.id === 1011405) return;
      if (c.battle.selfSpeed - c.battle.targetSpeed < 2) return;
      if (!takeTurn(c, "bh", 3)) return;
      c.give("actor", "BreakthroughHorse", 1, 0);
    },
  },

  // PassiveAbility_1011502 (IndexFingerMissionMainPassive): round start → IndexPrescriptTargetToEnemy on a random enemy, marks skills.
  // The buff's TakeDmgMulByIndexUnit (+10% damage taken from Index units) is not modelled by the status engine, so it is applied here.
  {
    id: 1011502,
    summary: "回合开始对目标施加神谕标记（受食指单位伤害+10%）",
    approx: "单目标场景下标记必定落在目标上；技能标记（行动槽）、解锁阶段与神谕指令判定未建模",
    onTurnStart(c) {
      if (!c.target.get("IndexPrescriptTargetToEnemy")) c.give("target", "IndexPrescriptTargetToEnemy", 1, 0);
    },
    skillMods(c) {
      return c.target.get("IndexPrescriptTargetToEnemy") ? { dmg: 0.1 } : undefined;
    },
  },

  // PassiveAbility_1011503 (IndexFingerMissionSubPassive): mission success → SP + BlessingOfIndexPrescriptAlly; fail → KarmaOfIndexAlly (self)
  {
    id: 1011503,
    summary: "神谕指令成功时获得祝福层数、失败时自身获得业障",
    approx: "神谕指令（IndexPrescript_Base_2nd）执行判定未建模；祝福层数请通过初始状态设置",
  },

  // PassiveAbility_1011504.OnAddUnit: BurningWoundYisangMask; OnRoundEnd convert after first stagger; ally 10314 gets SatisfyingEsteemNeeds
  {
    id: 1011504,
    summary: "首次登场获得灼伤之面（BurningWoundYisangMask）",
    approx: "首次混乱后的转化未触发；代行堂吉诃德(10314)的增益仅作用于友方",
    onBattleStart(c) {
      if (!c.actor.get("BurningWoundYisangMask") && !c.actor.get("BurningWoundYisang")) c.give("actor", "BurningWoundYisangMask", 1, 0);
    },
  },

  // PassiveAbility_1011506.OnStartTurn_BeforeLog: skill 1011505 (Furioso-Replica) → _upgradeSkillUsedCount++;
  // OnRoundEnd: used >= 1 && has Mask(1583) → DestroyBuff Mask, BurningWoundYisang(1584) 1.
  // OnRoundStart_After_Event: has 1584 && Furioso on dashboard (or upgrade candidate && StackYisangSpecialSkill >= 9) → BlackNightmareYisang
  {
    id: 1011506,
    summary: "首次使用Furioso-Replica的回合结束将灼伤之面转化为灼伤；之后回合开始获得黑色梦魇",
    approx: "每枚硬币随机武器特效、标记技能获得特殊技能层数未建模；仪表盘是否存在Furioso未知，以特殊技能层数≥9近似",
    skillMods(c) {
      if (c.skill?.id === 1011505) c.state.set("furioso", 1);
    },
    onRoundEnd(c) {
      if (!c.state.get("furioso") || c.state.get("converted") || !c.actor.get("BurningWoundYisangMask")) return;
      c.state.set("converted", 1);
      c.lose("actor", "BurningWoundYisangMask", 1);
      c.give("actor", "BurningWoundYisang", 1, 0);
    },
    onTurnStart(c) {
      if (c.actor.get("BurningWoundYisang") && c.actor.getPotency("StackYisangSpecialSkill") >= 9) c.give("actor", "BlackNightmareYisang", 1, 0);
    },
  },

  // PassiveAbility_1011501.CalcDmgMul: default skill; Blessing >= 9 → +0.2; else marked skill (SystemAbility) → min(0.02 × Blessing, 0.16)
  {
    id: 1011511,
    summary: "祝福层数为9时基础技能伤害+20%（被标记技能每层祝福+2%，最多16%）",
    approx: "技能标记未建模，祝福<9时的+2%/层未计入；超级硬币获得特殊技能层数、技能转化未建模",
    skillMods(c) {
      if (!isDefault(c)) return;
      return c.actor.getPotency("BlessingOfIndexPrescriptAlly") >= 9 ? { dmg: 0.2 } : undefined;
    },
  },

  // PassiveAbility_1011601.Calculate: (selfSpeed - targetSpeed) × Charge potency × 0.01, capped (Init, desc: 20%)
  {
    id: 1011601,
    summary: "速度高于目标时伤害+(速度差×充能强度)%（最多+20%）",
    approx: "回合结束按充能强度获得迅捷（改变速度）未反映到场景速度",
    skillMods(c) {
      const diff = c.battle.selfSpeed - c.battle.targetSpeed;
      const charge = c.actor.getPotency("Charge");
      if (diff <= 0 || charge <= 0) return;
      return { dmg: Math.min(diff * charge * 0.01, 0.2) };
    },
  },

  // PassiveAbility_1011602.BeforeUseBuff: every 10 Charge count used → Charge potency +1; ally hit → "次元斩" (1011601) cut-in
  {
    id: 1011602,
    summary: "累计消耗10层充能时充能强度+1；友方命中时消耗漂流次元发动次元斩",
    approx: "友方攻击触发的次元斩未建模（队友未模拟）",
    coinMods(c) {
      grantUsedCharge(c);
    },
    onCoinHit(c) {
      grantUsedCharge(c);
    },
    onSkillEnd(c) {
      grantUsedCharge(c);
    },
  },

  // PassiveAbility_1020101.GetAttackDmgMultiplier: target.GetNegativeBuffCount() > 0 → +0.1
  {
    id: 1020101,
    summary: "攻击带有负面状态的目标时伤害+10%",
    skillMods(c) {
      return negativeBuffCount(c.target) > 0 ? { dmg: 0.1 } : undefined;
    },
  },

  // PassiveAbility_1020211.OnEndAttack: self Charge turn 1 (stack 0); then random ally Charge turn 1
  {
    id: 1020211,
    summary: "攻击结束后自身获得1层充能",
    approx: "随机友方获得充能不影响本单位",
    onSkillEnd(c) {
      c.give("actor", "Charge", 0, 1);
    },
  },

  // PassiveAbility_1020301: round start Breath count >= 4 → Agility 2
  noDamagePassive(1020301, "回合开始呼吸法≥4层时获得迅捷（仅速度）"),
  // PassiveAbility_1020411: SP heal / AssemblePersonality for N Corp allies
  noDamagePassive(1020411, "战斗开始为友方恢复理智值并给予狂信"),
  // PassiveAbility_1020501/1020511: DefenseUp to adjacent allies
  noDamagePassive(1020511, "战斗开始使两侧友方获得防御等级提升"),

  // PassiveAbility_1020601.BeforeAttack: target resist (sin or physical) in {weak, fatal} → Breath potency += target Burst potency (20/turn)
  {
    id: 1020601,
    summary: "以脆弱/致命抗性攻击时，按目标破裂强度增加呼吸法强度（每回合≤20）",
    // _TARGET_RESIST_VALUE_LIST = {WEAK(致命), VULNERABLE(脆弱)}; checked on the skill's sin OR atk type.
    skillMods(c) {
      const s = c.skill;
      const lv = [
        s?.sin && s.sin !== "NEUTRAL" ? c.targetResistLevel?.({ sin: s.sin as import("../../config/game-data").SinAttribute }) : undefined,
        s?.atkType ? c.targetResistLevel?.({ atkType: s.atkType as import("../../config/game-data").AtkType }) : undefined,
      ];
      if (!lv.some((l) => l === "WEAK" || l === "VULNERABLE")) return;
      const key = `acc:${c.turn}`;
      const remain = 20 - (c.state.get(key) ?? 0);
      const n = Math.min(c.target.getPotency("Burst"), remain);
      if (n <= 0) return;
      c.state.set(key, 20 - remain + n);
      c.give("actor", "Breath", n, 0);
    },
  },

  // PassiveAbility_1020711: clash power down; OnVibrationExplosionOtherUnit → DefenseDown 2 (3/turn/enemy); SP < -25 at round end → Binding 2 + HitResultUp 1
  {
    id: 1020711,
    summary: "敌方被震颤引爆时施加2层防御等级降低（每回合每敌≤3次）",
    approx: "拼点威力降低仅拼点生效；理智<-25时的打击威力提升（理智未追踪）未建模",
    onVibrationExplosion(c, ev) {
      if (ev.side !== "target" || !takeTurn(c, "vibDD", 3)) return;
      c.give("target", "DefenseDown", 2, 0);
    },
  },

  // PassiveAbility_1020801/1020811.OnSucceedAttack: isCritical, remain (_ABILITY_COUNT_MAX 6) → target RedApricotBlossom(395) 1, or DefenseDown 1 at max(10)
  {
    id: 1020811,
    summary: "暴击命中时施加1层红杏花，目标已有10层时改为1层防御等级降低（最多6次）",
    approx: "计数重置时机在 ISIL 中不可见，按每回合6次处理",
    onCoinHit(c) {
      if (!c.isCritical || !takeTurn(c, "crit", 6)) return;
      if (c.target.getPotency("RedApricotBlossom") >= 10) c.give("target", "DefenseDown", 1, 0);
      else c.give("target", "RedApricotBlossom", 1, 0);
    },
  },

  // PassiveAbility_1020901/1020911.OnWinDuel: GiveBuff_Giver(Sinking potency _STACK 1, or _STACK_ALT 3 when the target has
  // EchoOfMansion), at most _ABILITY_COUNT_MAX (3) times (per turn assumed).
  {
    id: 1020911,
    summary: "拼点胜利时使目标沉沦强度+1（目标有[EchoOfMansion]时+3）",
    approx: "仅在可选敌方行动模型（拼点胜利）下触发；次数上限3按每回合计",
    onWinDuel(c) {
      const k = `n:${c.turn}`;
      const n = c.state.get(k) ?? 0;
      if (n >= 3) return;
      c.state.set(k, n + 1);
      c.give("target", "Sinking", c.target.get("EchoOfMansion") ? 3 : 1, 0);
    },
  },
);
