/**
 * Passive batch 06 — see data/il2cpp/dossiers/passives-06.md
 *
 * Note: game OnBattleStart ("战斗开始时") fires at the start of every combat phase, so per-turn "战斗开始时" effects are
 * mapped to onTurnStart; onBattleStart is used only for "首次登场" / once-per-battle effects.
 * Buff "stack" (GiveBuff stack arg) maps to potency, "turn" to count.
 */
import { noDamagePassive, registerPassives, type PassiveCtx } from "./framework";

const isDefaultAtk = (c: PassiveCtx) => ["S1", "S2", "S3"].includes(c.skill?.slot ?? "");
const isDefaultInclDef = (c: PassiveCtx) => ["S1", "S2", "S3", "DEF"].includes(c.skill?.slot ?? "");
const countAllies = (c: PassiveCtx, ids: string[]) => ids.filter((id) => c.allyPresent(id)).length;
const has = (side: PassiveCtx["actor"], id: string) => side.getPotency(id) > 0 || side.getCount(id) > 0;

// Association member identity ids (core.json identities[].associations)
const BLACK_CLOUD = ["10403", "10602", "10712", "10902", "11208"]; // excl. self 10811
const BLADE_LINEAGE = ["10103", "10208", "10308", "10508", "11002", "11102"]; // excl. self 10815
const RING_STUDENT = ["10109", "10515", "11109"];

registerPassives(
  noDamagePassive(1081011, "战斗开始按震颤层数获得守备等级提升（防御姿态时翻倍）"),
  {
    // PassiveAbility_1081102.OnDieOtherUnit: needs Black Cloud allies to die
    id: 1081102,
    summary: "黑云会友方阵亡时获得斩击威力提升/临战（模拟中无友方阵亡，不触发）",
    approx: "友方阵亡触发的 SlashResultUp / EngageToBattle 未建模",
  },
  {
    // PassiveAbility_1081101.OnBattleStart: alive BLACK_CLOUD units (incl. self) >= 2 → BlackCloudBlade ×1 (810)
    id: 1081111,
    summary: "黑云会队友在场时，每回合战斗开始获得1层黑云刀",
    approx: "仪表盘两侧/色欲共鸣给予友方黑云的效果不影响自身，未建模",
    onTurnStart(c) {
      if (countAllies(c, BLACK_CLOUD) >= 1) c.give("actor", "BlackCloudBlade", 1, 0);
    },
  },
  noDamagePassive(1081201, "击杀时获得呼吸法、拼点威力与拼点胜利相关破裂加成（无拼点/击杀）"),
  noDamagePassive(1081202, "撤退/重返战斗相关效果"),
  {
    // PassiveAbility_1081301.GetAttackDmgMultiplier: +10% if target IsLowMorale || IsPanic
    id: 1081301,
    summary: "对士气低落/恐慌的敌人伤害+10%（目标精神状态不可读，按未满足）",
    approx: "目标士气低落/恐慌状态未建模；反面命中回复理智不影响伤害",
  },
  {
    // PassiveAbility_1081302.OnRoundStart_After_Event: no HanafudaCombo(1286) → GiveBuff_Self(combo, 0, 3)
    id: 1081302,
    summary: "回合开始若无花札连击则获得0级3层花札连击",
    approx: "组札随机获得/罪孽属性匹配增加连击强度、震颤引爆、E.G.O资源、“光斩”追加技能均未建模",
    onTurnStart(c) {
      if (!has(c.actor, "HanafudaCombo")) c.give("actor", "HanafudaCombo", 0, 3);
    },
  },
  noDamagePassive(1081402, "视作施加烧伤/流血的人格（仅标签）"),
  {
    // PassiveAbility_1081401/1081411: Resentment on being attacked, HeatingWire by Envy resonance (only SP recovery)
    id: 1081411,
    summary: "被攻击获得怨恨→强化纹身；嫉妒共鸣获得热丝（模拟中未触发）",
    approx: "被攻击获得怨恨/消耗怨恨获得强化纹身、复仇之书、共鸣条件均未建模",
  },
  {
    // PassiveAbility_1081501.OnBattleStart: AengduNewArmIshmael ×1 (1811); OnEndTurn: floor(Breath/3) WindBlade (1813), ≤2 times/turn
    id: 1081501,
    summary: "每回合战斗开始获得鬼怪之臂；技能结束时每3级呼吸法强度获得1层风刃(每次最多5层，每回合2次)",
    approx: "友方低体力时获得的支援守护、给剑契组友方回复理智未建模",
    onTurnStart(c) {
      c.give("actor", "AengduNewArmIshmael", 1, 0);
    },
    onSkillEnd(c) {
      const key = `wb:${c.turn}`;
      const used = c.state.get(key) ?? 0;
      if (used >= 2) return;
      const n = Math.min(5, Math.floor(c.actor.getPotency("Breath") / 3));
      if (n <= 0) return;
      c.state.set(key, used + 1);
      c.give("actor", "WindBladeIshmael", n, 0);
    },
  },
  {
    // PassiveAbility_1081502.OnRoundStart_After_Event (_first): BladelineagePride = min(other Blade Lineage allies, 3)
    id: 1081502,
    summary: "首次登场时每有1名其他剑契组友方获得1层剑契之傲（最多3层）",
    approx: "剑契组友方阵亡≥3/5名后的故乡剑术与额外呼吸法未建模",
    onBattleStart(c) {
      const n = Math.min(3, countAllies(c, BLADE_LINEAGE));
      if (n > 0) c.give("actor", "BladelineagePride", n, 0);
    },
  },
  {
    id: 1081513,
    summary: "风刃≥15层时基础攻击技能结束后追加“相战清潾火”",
    approx: "追加技能（1081506）与守备反击“骨断”未建模",
  },
  noDamagePassive(1081601, "拼点威力+2与羽化状态回复体力"),
  {
    id: 1081602,
    summary: "累计消耗充能(胭脂)提升强度、茧化免死与护盾",
    approx: "按累计消耗量提升 ChargeRougeAlly 强度、茧化/羽化状态切换未建模",
  },
  {
    // PassiveAbility_1090101.OnSucceedAttack: Util.Prob(0.5) → GiveBuff_Giver(Laceration, 1)
    id: 1090101,
    summary: "攻击命中时50%概率使目标流血强度+1（按每2次命中触发1次计）",
    approx: "50%概率以确定性交替（期望值）近似",
    onCoinHit(c) {
      const n = (c.state.get("hits") ?? 0) + 1;
      c.state.set("hits", n);
      if (n % 2 === 0) c.give("target", "Laceration", 1, 0);
    },
  },
  noDamagePassive(1090201, "呼吸法≥5时反击改用3技能"),
  {
    id: 1090301,
    summary: "对本回合使用守备技能的目标伤害+10%（目标不使用守备技能，不触发）",
    approx: "目标守备技能使用情况未建模",
  },
  noDamagePassive(1090401, "敌方阵亡/击杀时获得增益"),
  {
    id: 1090501,
    summary: "震颤引爆时消耗3充能提高混乱阈值前移量，并于下回合获得迅捷与打击伤害强化",
    // 不影响输出：混乱阈值前移+40%仅影响混乱阈值
    // OnGiveBsGaugeUp(onExplosion): Charge turn ≥ 3 → UseBuffTurn(Charge, 3); then (always) Agility 1 + HitDamageUp 1 next round.
    onVibrationExplosion(c, ev) {
      if (ev.side !== "target") return;
      if (c.actor.getCount("Charge") >= 3) c.consume("actor", "Charge", 3);
      c.give("actor", "Agility", 1, 0, 1);
      c.give("actor", "HitDamageUp", 1, 0, 1);
    },
  },
  {
    id: 1090701,
    summary: "按本回合受到的伤害下回合获得打击伤害强化",
    approx: "自身受到的伤害量不可读，未建模",
  },
  {
    // PassiveAbility_1090801.GetAttackDmgMultiplier: floor(target Combustion potency / 6) × 10%, max 30%
    id: 1090811,
    summary: "目标每6级烧伤强度伤害+10%（最多+30%）",
    approx: "战斗开始按暴怒完全共鸣数给友方（可能含自身）暴怒伤害提升/强壮未建模",
    coinMods(c) {
      const dmg = Math.min(0.3, Math.floor(c.target.getPotency("Combustion") / 6) * 0.1);
      if (dmg > 0) return { dmg };
    },
  },
  noDamagePassive(1090901, "低体力回复、对时停目标拼点威力与受伤减免"),
  noDamagePassive(1091011, "护盾与撤退时给友方增益"),
  {
    id: 1091102,
    summary: "按全体单位受到的流血伤害获得血宴",
    approx: "流血伤害统计与血宴获得未建模",
  },
  noDamagePassive(1091111, "受到流血伤害获得荆棘、基础技能伤害吸血"),
  {
    // PassiveAbility_1091201.GetAttackDmgMultiplier: +5% if self SnakeStance(940), +5% if target BurstPoison(939)
    id: 1091201,
    summary: "自身带有蛇之架势伤害+5%，目标带有破裂毒伤害+5%",
    coinMods(c) {
      let dmg = 0;
      if (has(c.actor, "SnakeStance")) dmg += 0.05;
      if (has(c.target, "BurstPoison")) dmg += 0.05;
      if (dmg > 0) return { dmg };
    },
  },
  noDamagePassive(1091303, "理智值下限保护"),
  {
    // PassiveAbility_1091304.OnAttackConfirmed (default attack skill, per coin):
    //  PenetratingSword(1080): use 1 (last coin of the last default attack: all) → target Sinking potency +amount
    //  SwordCutwithTear(1081) ≥3 on last coin: use all → Sinking 3/3 and that coin dmg +50%
    id: 1091304,
    summary: "基础攻击技能每枚硬币命中前消耗1层贯穿之剑使目标沉沦强度+1（最后一枚消耗全部）；含泪斩剑3层时最后一枚硬币消耗全部，沉沦+3/3且伤害+50%",
    approx: "“本回合最后一个技能”按每个基础攻击技能近似；含泪斩剑自身增伤在消耗前已计入本硬币；回合末理智恢复未建模",
    coinMods(c) {
      if (!isDefaultAtk(c) || !c.skill) return;
      const last = c.coinIndex === c.skill.coinCount - 1;
      const ps = c.actor.getPotency("PenetratingSword");
      if (ps > 0) {
        const amt = last ? ps : 1;
        c.lose("actor", "PenetratingSword", amt);
        c.give("target", "Sinking", amt, 0);
      }
      if (last) {
        const tear = c.actor.getPotency("SwordCutwithTear");
        if (tear >= 3) {
          c.lose("actor", "SwordCutwithTear", tear);
          c.give("target", "Sinking", 3, 3);
          return { dmg: 0.5 };
        }
      }
    },
  },
  {
    // PassiveAbility_1091311.OnBattleStart: DespairAlly + PenetratingSword ≥3 → AttackDmgUp 1; ≥5 → AttackDmgUp 2 + ResultEnhancement 1
    // (BlessingAlly branch gives Protection / ParryingResultUp — defensive only)
    id: 1091311,
    summary: "绝望状态下每回合战斗开始按贯穿之剑层数获得伤害强化（≥3层1层，5层2层+最终威力强化1层）",
    approx: "绝望状态基础技能伤害+(-理智/2)%（最多20%）需读取自身理智值，未建模；祝福状态减伤不影响输出",
    onTurnStart(c) {
      if (has(c.actor, "BlessingAlly") || !has(c.actor, "DespairAlly")) return;
      const ps = c.actor.getPotency("PenetratingSword");
      if (ps >= 5) {
        c.give("actor", "AttackDmgUp", 2, 0);
        c.give("actor", "ResultEnhancement", 1, 0);
      } else if (ps >= 3) c.give("actor", "AttackDmgUp", 1, 0);
    },
  },
  {
    // PassiveAbility_1091411.GetSkillPowerResultAdder: default skill && HP ratio < 0.35 → +1
    id: 1091411,
    summary: "现存体力低于35%时基础攻击技能最终威力+1",
    approx: "累计消耗充能提升充能强度、主要目标无沉沦时自身获得沉沦并使技能施加的沉沦强度翻倍未建模",
    skillMods(c) {
      if (isDefaultAtk(c) && 1 - c.battle.lostHpPct / 100 < 0.35) return { finalPower: 1 };
    },
  },
  {
    id: 1091501,
    summary: "施加的熊爪伤/鹰爪伤/大胆笔触层数额外+1",
    approx: "修改施加状态层数的能力缺失，未建模",
  },
  {
    // PassiveAbility_1091502.OnRoundStart_After_Event (once per battle): ThankyouDocentRodion = Ring apprentice count
    id: 1091502,
    summary: "环指学徒队友在场时获得相应层数的谢谢老师（每场1次）",
    approx: "给学徒队友的攻击/守备等级提升不影响自身；谢谢老师自身效果由状态系统处理",
    onTurnStart(c) {
      if (c.state.get("done")) return;
      c.state.set("done", 1);
      const n = countAllies(c, RING_STUDENT);
      if (n > 0) c.give("actor", "ThankyouDocentRodion", n, 0);
    },
  },
  {
    // PassiveAbility_1091503.OnBattleEnd: target has Bear(1696)+Eagle(1697)+Bold(1672) → IntenseColors(1673)
    //   1/2/3/4 by min(Bear, Eagle) ≥ 0/3/6/9; OnRoundEnd: FaubismWolfMask if S1alt(1091506) used ≥2, S3alt(1091505) ≥1 or applied ≥3 times
    id: 1091503,
    summary: "回合结束对同时带有熊爪伤/鹰爪伤/大胆笔触的目标下回合施加强烈色彩；满足条件获得野兽派狼面具",
    approx: "“批评”=1091506、“令你皮肤…”=1091505 按技能 id 推断",
    onSkillEnd(c) {
      const id = c.skill?.id;
      if (id === 1091506) c.state.set("cnt1", (c.state.get("cnt1") ?? 0) + 1);
      if (id === 1091505) c.state.set("cnt2", (c.state.get("cnt2") ?? 0) + 1);
    },
    onRoundEnd(c) {
      const t = c.target;
      if (has(t, "BearClawWoundAlly") && has(t, "EagleClawWoundAlly") && has(t, "BoldBrushstrokesRodion")) {
        const m = Math.min(t.getPotency("BearClawWoundAlly"), t.getPotency("EagleClawWoundAlly"));
        const stack = m >= 9 ? 4 : m >= 6 ? 3 : m >= 3 ? 2 : 1;
        c.give("target", "IntenseColorsRodion", stack, 0, 1);
        c.state.set("intense", (c.state.get("intense") ?? 0) + 1);
      }
      if (c.state.get("mask")) return;
      if ((c.state.get("cnt1") ?? 0) >= 2 || (c.state.get("cnt2") ?? 0) >= 1 || (c.state.get("intense") ?? 0) >= 3) {
        c.state.set("mask", 1);
        c.give("actor", "FaubismWolfMaskRodion", 1, 0);
      }
    },
  },
  {
    // PassiveAbility_1091601.CalcDmgMul: default skill (incl. DEF): floor(target Combustion/2) × 1%, max 15% (×3 if target has shield);
    //   CheckTier3Condition (S3 && AccelBullet > 0): coin power +1, dmg +25%
    id: 1091601,
    summary: "基础技能对目标每2级烧伤强度伤害+1%（最多15%）；加速弹≥1时3技能硬币威力+1、伤害+25%",
    approx: "目标护盾时改为每2级+3%（最多45%）未建模（目标护盾不可读）",
    coinMods(c) {
      if (!isDefaultInclDef(c)) return;
      let dmg = Math.min(0.15, Math.floor(c.target.getPotency("Combustion") / 2) * 0.01);
      let coinScale = 0;
      if (c.skill?.slot === "S3" && has(c.actor, "AccelBullet")) {
        dmg += 0.25;
        coinScale = 1;
      }
      return { dmg, coinScale };
    },
  },
);
