/** Script/status batch 02 — see data/il2cpp/dossiers/scripts-02.md */
import { blockSkillGains, noDamageAbility, noDamageScript, registerAbilities, registerScripts, type ScriptCtx } from "./framework";

// ------------------------------------------------------------------ BulletLament (葬仪师李箱 10110)
// BulletLament is a CountableBuff whose potency (生蝶) and count (亡蝶) are both bullets. Coins consume at use
// (OnUseConsumeThisCoin) and give 1 SinkingWhite potency per consumed 生蝶 / 1 count per consumed 亡蝶 (get_C_stack / get_C_turn).
// Consumption is shared across coins of one skill use, so it is kept in the per-action scratch (c.action.shared).

const LAMENT = "BulletLament";
const WHITE = "SinkingWhite";

interface LamentRec {
  start: number;
  coins: Map<number, { p: number; t: number }>;
}
const LAMENT_REC_KEY = "BulletLament:rec";

const lamentPoints = (c: ScriptCtx) => c.actor.getPotency(LAMENT) + c.actor.getCount(LAMENT);

/** Record for the current skill use (created on first access; c.action.shared is reset at skill start). */
function lamentRec(c: ScriptCtx, _allowReset: boolean): LamentRec {
  let r = c.action.shared.get(LAMENT_REC_KEY) as LamentRec | undefined;
  if (!r) {
    r = { start: lamentPoints(c), coins: new Map() };
    c.action.shared.set(LAMENT_REC_KEY, r);
  }
  return r;
}

/** Consume n bullets: game picks 生蝶/亡蝶 at random — approximated as 亡蝶(count) first, then 生蝶(potency). */
function consumeLament(c: ScriptCtx, n: number): { p: number; t: number } {
  const t = Math.min(c.actor.getCount(LAMENT), n);
  if (t > 0) c.actor.consumeCount(LAMENT, t);
  const p = Math.min(c.actor.getPotency(LAMENT), n - t);
  if (p > 0) c.lose("actor", LAMENT, p);
  return { p, t };
}

const LAMENT_MAX = 20; // PassiveAbility_1011002._RELOAD_AMOUNT / BulletLament maxStack
const LAMENT_RELOAD_KEY = "BulletLament:reload";
const RELOAD_APPROX = "装填时生蝶/亡蝶按理智概率的期望值分配(理智≥0：30%生蝶)；装填消耗的理智未计入";
/** Living (potency) share on reload / gain: SP ≥ 0 → 30%, else 70% (PassiveAbility_1011002._HIGH/_LOW_MP_PROB). */
const livingRatio = (c: ScriptCtx) => (c.actorSp >= 0 ? 0.3 : 0.7);

/** ReloadLament (PassiveAbility_1011002.BulletReload): lose all, gain 20 split by SP (≥1 each). Runs once per reserved reload. */
function endBehaviourReload(c: ScriptCtx): void {
  if (c.action.shared.get(LAMENT_RELOAD_KEY) !== 1) return;
  c.action.shared.set(LAMENT_RELOAD_KEY, 2);
  const p0 = c.actor.getPotency(LAMENT);
  const t0 = c.actor.getCount(LAMENT);
  if (p0 > 0) c.lose("actor", LAMENT, p0);
  if (t0 > 0) c.actor.consumeCount(LAMENT, t0);
  const p = Math.min(LAMENT_MAX - 1, Math.max(1, Math.round(LAMENT_MAX * livingRatio(c))));
  c.give("actor", LAMENT, p, LAMENT_MAX - p);
  c.note(`ReloadLament：生蝶 ${p} / 亡蝶 ${LAMENT_MAX - p}`);
}

function giveWhite(c: ScriptCtx): void {
  const r = lamentRec(c, false);
  const got = r.coins.get(c.ownerCoinIndex ?? c.coinIndex ?? -1);
  if (got && (got.p > 0 || got.t > 0)) c.give("target", WHITE, got.p, got.t);
}

// ------------------------------------------------------------------ 10111 Burst block helpers

/** SkillAbility_10111baseNoGiveBuff.OnStartTurn_BeforeLog: target Burst potency ≥ stack && count ≥ turn → block this skill's Burst. */
function burstBlocked(c: ScriptCtx): boolean {
  const bd = c.script.buffData ?? {};
  const kw = bd.buffKeyword ?? "Burst";
  const on = c.target.getPotency(kw) >= (bd.stack ?? 15) && c.target.getCount(kw) >= (bd.turn ?? 3);
  // BattleActionModel.BlockGivingBuff: this skill's own gives of the keyword are dropped until the skill ends.
  if (on) blockSkillGains(c, kw);
  return on;
}

// ------------------------------------------------------------------ scripts

registerScripts(
  // CoinAbility_DamageMultiplierPerConsumeBulletLament: dmg = total BulletLament consumed by this skill × mul × 0.01 (_RATIO)
  {
    name: /^DamageMultiplierPerConsumeBulletLament_mul(\d+)$/,
    summary: "本技能每消耗1点生蝶·亡蝶，本硬币伤害+mul%",
    approx: "消耗总量按技能开始时的生蝶·亡蝶点数计（本技能最终消耗全部）",
    coinMods(c) {
      const mul = Number(/_mul(\d+)$/.exec(c.script.scriptName)?.[1] ?? 0);
      const total = lamentRec(c, false).start;
      return total > 0 ? { dmg: total * mul * 0.01 } : undefined;
    },
  },
  // CoinAbility_ESolemnLamentAdditionalAzureDmg: OnSucceedAttack → HP damage = target SinkingWhite (stack+turn) × N × 0.01, Azure resist applied
  {
    name: /^ESolemnLamentAdditionalAzureDmg(\d+)$/,
    summary: "命中时造成相当于目标生蝶·亡蝶(沉沦白)点数之和的忧郁伤害",
    onCoinHit(c) {
      const ratio = Number(/(\d+)$/.exec(c.script.scriptName)?.[1] ?? 100) * 0.01;
      const amount = Math.floor((c.target.getPotency(WHITE) + c.target.getCount(WHITE)) * ratio);
      if (amount > 0) c.extraDamage(amount, `沉沦白点数 ${amount} 的忧郁伤害`, { sin: "AZURE" });
    },
  },
  noDamageScript("ESolemnLamentBlankSinking", "施加0层沉沦（仅用于触发“施加沉沦”事件）"),
  // CoinAbility_GiveSinkingWhitePerConsumedBulletLamentToHitedTarget with [necessary:BulletLament:::BulletLamentN]: consume N at use
  {
    name: /^GiveSinkingWhitePerConsumedBulletLamentToHitedTarget\[necessary:BulletLament:::BulletLament(\d+)\]$/,
    summary: "使用时消耗N点生蝶·亡蝶；命中时按消耗点数施加沉沦白；点数不足时硬币不发动",
    approx: "生蝶/亡蝶随机消耗按先亡蝶后生蝶",
    beforeCoin(c) {
      const idx = c.ownerCoinIndex ?? c.coinIndex ?? 0;
      if ((c.action.shared.get(LAMENT_REC_KEY) as LamentRec | undefined)?.coins.has(idx)) return; // already paid (reuse)
      const need = Number(/BulletLament(\d+)\]$/.exec(c.script.scriptName)?.[1] ?? 1);
      if (lamentPoints(c) < need) {
        // PassiveAbility_1011002.OnCanceledByLackOfBuffsAtStartCoin: DisableCoin for the rest + ReloadLament at OnEndBehaviour.
        c.action.shared.set(LAMENT_RELOAD_KEY, 1);
        c.cancelCoin(`生蝶·亡蝶不足 ${need} 点，取消后续硬币并装填`, { rest: true });
      }
    },
    onSkillEnd: endBehaviourReload,
    coinMods(c) {
      const r = lamentRec(c, true);
      const idx = c.ownerCoinIndex ?? c.coinIndex ?? 0;
      if (r.coins.has(idx)) return;
      const need = Number(/BulletLament(\d+)\]$/.exec(c.script.scriptName)?.[1] ?? 1);
      if (lamentPoints(c) < need) {
        r.coins.set(idx, { p: 0, t: 0 });
        c.note(`生蝶·亡蝶不足 ${need} 点（游戏中取消攻击，未建模）`);
        return;
      }
      r.coins.set(idx, consumeLament(c, need));
    },
    onCoinHit: giveWhite,
  },
  // Plain variant (consumption by ConsumeAllBulletLamentWithoutNecessary on the same coin): SinkingWhite per bullets consumed by that coin.
  {
    name: "GiveSinkingWhitePerConsumedBulletLamentToHitedTarget",
    summary: "命中时按本硬币消耗的生蝶·亡蝶点数施加沉沦白（配合“消耗全部”）",
    approx: "若消耗已由其他脚本完成，消耗量=技能开始点数-前序硬币消耗，并全部按亡蝶(层数)计",
    coinMods(c) {
      const r = lamentRec(c, false);
      const idx = c.ownerCoinIndex ?? c.coinIndex ?? 0;
      if (r.coins.has(idx)) return;
      let prev = 0;
      for (const v of r.coins.values()) prev += v.p + v.t;
      const total = Math.max(0, r.start - prev);
      const own = consumeLament(c, lamentPoints(c)); // consume-all if not already done
      r.coins.set(idx, { p: own.p, t: Math.max(own.t, total - own.p) });
    },
    onCoinHit: giveWhite,
  },
  // SkillAbility_ReserveReloadBulletLament.OnStartBehaviour → PassiveAbility_1011002.ReserveBulletReload; ReloadLament at OnEndBehaviour.
  {
    name: "ReserveReloadBulletLament",
    summary: "技能结束时装填生蝶·亡蝶(ReloadLament：清空后获得20点)",
    approx: RELOAD_APPROX,
    skillMods(c) {
      c.action.shared.set(LAMENT_RELOAD_KEY, 1);
    },
    onSkillEnd: endBehaviourReload,
  },
  // SkillAbility_TacticalReloadBulletLamentOnBattleStart (守备技能 1011004, desc "[StartBattle] [ReloadLament]"): reserve → reload at end.
  {
    name: "TacticalReloadBulletLamentOnBattleStart",
    summary: "使用本守备技能时装填生蝶·亡蝶(ReloadLament：清空后获得20点)",
    approx: RELOAD_APPROX,
    skillMods(c) {
      c.action.shared.set(LAMENT_RELOAD_KEY, 1);
    },
    onSkillEnd: endBehaviourReload,
  },
  // SkillAbility_SkillPowerAdderSelfForBulletLament.GetPowerAdder: min(round(trunc((stack+turn)/bd.stack) × bd.value), bd.limit)
  {
    name: "SkillPowerAdderSelfForBulletLament",
    summary: "自身每带有5点生蝶·亡蝶，基础威力+1(最多+4)",
    // timing audit: GetSkillPowerAdder → GetPowerAdder on every coin → per-coin base power
    coinMods(c) {
      const bd = c.script.buffData ?? {};
      const pts = lamentPoints(c);
      if (pts <= 0) return;
      const add = Math.min(Math.round(Math.trunc(pts / (bd.stack || 5)) * (bd.value ?? 1)), bd.limit ?? 4);
      return add > 0 ? { basePower: add } : undefined;
    },
  },
  // ---- 10111
  {
    name: "10111baseNoGiveBuff",
    summary: "目标破裂强度≥15且层数≥3时，本技能不再增加破裂",
    approx: "嘲讽值不计",
    skillMods(c) {
      burstBlocked(c);
    },
  },
  {
    name: "10111baseNoGiveBuffSkillPowerAdder",
    summary: "目标破裂强度≥15且层数≥3时，本技能不再施加破裂，改为基础威力+value",
    approx: "嘲讽值不计",
    skillMods(c) {
      const b = burstBlocked(c);
      // GetSkillPowerAdder: blocked → BuffReferenceData.IntegerValue
      return b ? { basePower: c.script.buffData?.value ?? 0 } : undefined;
    },
  },
  // SkillAbility_AttackDmgUpByRatioByLostHpRatioSelf.CalculateDmgMul: lost HP ratio × value (value per 1%)
  {
    name: "AttackDmgUpByRatioByLostHpRatioSelf",
    summary: "自身每失去1%体力，本技能伤害+value",
    coinMods(c) {
      const v = c.script.value ?? 0;
      const d = c.battle.lostHpPct * v;
      return d > 0 ? { dmg: d } : undefined;
    },
  },
  {
    name: "SkillPowerAdder10111_1_3",
    summary: "每有1个指定自身为目标的技能，基础威力+1(最多+3)",
    approx: "无敌方指定自身的技能（目标不行动），按0计",
  },
  noDamageScript("SkillPowerResultAdderOnLoseDuel10111_1_3", "拼点失败时最终威力加成"),
  noDamageScript("SkillPowerResultAdderOnLoseDuel10111_2_6", "拼点失败时最终威力加成"),
  noDamageScript("SpecificBuffStackAndTurnAdderOnLoseDuel", "拼点失败时施加量加成"),
  // ---- 10112
  // CoinAbility_GiveAdditionalBuffStackAttributeDmgOnSuccessAttackWithLimit.GetDamage: min(round(target stack × bd.value), limit), attribute resist applied
  {
    name: /^GiveAdditionalBuffStackAttributeDmgOnSuccessAttackWithLimit(\d+)_([A-Z]+)$/,
    summary: "命中时造成相当于目标指定状态强度的属性伤害(有上限)",
    onCoinHit(c) {
      const m = /WithLimit(\d+)_([A-Z]+)$/.exec(c.script.scriptName);
      const limit = Number(m?.[1] ?? 0);
      const bd = c.script.buffData ?? {};
      const kw = bd.buffKeyword ?? "Combustion";
      const side = bd.buffOwner === "Self" ? c.actor : c.target;
      const amount = Math.min(Math.round(side.getPotency(kw) * (bd.value ?? 1)), limit);
      if (amount > 0) c.extraDamage(amount, `${kw}强度 → ${m?.[2] ?? ""}属性伤害 ${amount}`, { sin: m?.[2] as import("../../config/game-data").SinAttribute | undefined });
    },
  },
  // SkillAbility_GiveBuffOnSucceedAttackIfHasStack: target keyword stack ≥ N (from name) → GiveBuff(buffData)
  {
    name: "GiveBuffOnSucceedAttackIfHasStack_Combustion6",
    summary: "命中时若目标烧伤强度≥6，按buffData施加烧伤",
    approx: "多目标(RandomEnemy2)按单一目标处理",
    onCoinHit(c) {
      const bd = c.script.buffData ?? {};
      if (c.target.getPotency("Combustion") < 6) return;
      const side = bd.target === "Self" ? "actor" : "target";
      const ar = bd.activeRound === 1 ? 1 : 0;
      if ((bd.stack ?? 0) > 0 || (bd.turn ?? 0) > 0) c.give(side, bd.buffKeyword ?? "Combustion", bd.stack ?? 0, bd.turn ?? 0, ar);
    },
  },
  // CoinAbility_LoseBuffOnSucceedAttack → CoinAbility_BasicBuff.LoseBuff(stack, turn)
  {
    name: "LoseBuffOnSucceedAttack",
    summary: "命中时使目标的指定状态强度/层数减少",
    onCoinHit(c) {
      const bd = c.script.buffData ?? {};
      const kw = bd.buffKeyword;
      if (!kw) return;
      const side = bd.target === "Self" ? "actor" : "target";
      if ((bd.stack ?? 0) > 0) c.lose(side, kw, bd.stack!);
      if ((bd.turn ?? 0) > 0) c[side].consumeCount(kw, bd.turn!, false);
    },
  },
  noDamageScript("MpHealOnKill10112_1_15_1", "技能结束为友方恢复理智"),
  // ---- 10113 (调整目标射击)
  noDamageScript("1011303Target", "目标指定（优先体力最低/友方）"),
  {
    name: "AttackDmgUpByPrevDmg1011303_100",
    summary: "按第一枚硬币对主要目标造成的伤害比例(以目标体力上限为基准)提高本硬币伤害(最多+100%)",
    approx: "未设置目标最大体力时不计入；伤害比例按第一枚硬币实际体力伤害÷目标最大体力",
    // CoinAbility_AttackDmgUpByPrevDmg1011303: min(GetPrevCoinDmgRatio × jsonValue, <N> × 0.01)
    coinMods(c) {
      const max = c.targetMaxHp();
      const prev = Number(c.action.shared.get("1011303:prevCoinDmg") ?? 0);
      if (!max || prev <= 0) return;
      const cap = Number(/_(\d+)$/.exec(c.script.scriptName)?.[1] ?? 100) * 0.01;
      return { dmg: Math.min((prev / max) * (c.script.value ?? 1), cap) };
    },
  },
  // CoinAbility_AttackDmgUpFailed1011303: prev coin did not kill an ally (always here) → min(BoseProjektil × value, limit%)
  {
    name: "AttackDmgUpFailed1011303",
    summary: "第一枚硬币未击杀友方时，自身每层BoseProjektil本硬币伤害+20%(最多+140%)",
    coinMods(c) {
      const bd = c.script.buffData ?? {};
      const s = c.actor.getPotency(bd.buffKeyword ?? "BoseProjektil");
      if (s < (bd.stack ?? 1)) return;
      let d = s * (bd.value ?? 0);
      if ((bd.limit ?? 0) > 0) d = Math.min(d, bd.limit! * 0.01);
      return d > 0 ? { dmg: d } : undefined;
    },
  },
  noDamageScript("AttackDmgUpKilled1011303", "需第一枚硬币击杀友方单位"),
  noDamageScript("CanDealOnlyMainTarget", "仅对主要目标造成伤害（单目标）"),
  noDamageScript("CanDealOnlyMainTarget1011303", "仅对主要目标造成伤害（单目标）"),
  noDamageScript("CanDealOnlySubTarget1011303", "仅对次要目标造成伤害（主要目标为敌方时仍命中）"),
  // CheckMainTarget1011303 (coin 1): records this coin's damage on the main target for ICheckPrevCoin1011303.GetPrevCoinDmgRatio.
  {
    name: "CheckMainTarget1011303",
    summary: "记录主要目标/伤害比例（不影响本次伤害）",
    onCoinHit(c) {
      c.action.shared.set("1011303:prevCoinDmg", Number(c.action.shared.get("1011303:prevCoinDmg") ?? 0) + (c.lastHitDamage ?? 0));
    },
  },
  noDamageScript("CheckMainTargetAllyDeadPrevCoin1011303", "检查第一枚硬币是否击杀友方"),
  // GiveBuffFailed1011303: prev coin did not kill an ally → GiveBuff(buffData) on hit
  {
    name: "GiveBuffFailed1011303",
    summary: "第一枚硬币未击杀友方时，命中使目标增加流血强度",
    onCoinHit(c) {
      const bd = c.script.buffData ?? {};
      const side = bd.target === "Self" ? "actor" : "target";
      if ((bd.stack ?? 0) > 0 || (bd.turn ?? 0) > 0) c.give(side, bd.buffKeyword ?? "Laceration", bd.stack ?? 0, bd.turn ?? 0, bd.activeRound === 1 ? 1 : 0);
    },
  },
  noDamageScript("GiveBuffKilled1011303", "需第一枚硬币击杀友方单位"),
  // SkillAbility_GiveBuffOnUseByDuplicateStack (stack -1): give Breath = min(BoseProjektil stack, limit) at use
  {
    name: "GiveBuffOnUseByDuplicateStack_BoseProjektil",
    summary: "使用时自身每带有1层BoseProjektil，增加1级呼吸法强度(最多7级)",
    skillMods(c) {
      const bd = c.script.buffData ?? {};
      let n = c.actor.getPotency("BoseProjektil");
      if ((bd.limit ?? 0) > 0) n = Math.min(n, bd.limit!);
      if (n > 0) c.give(bd.target === "Target" ? "target" : "actor", bd.buffKeyword ?? "Breath", n, bd.turn ?? 0);
    },
  },
);

// ------------------------------------------------------------------ status abilities

registerAbilities(
  noDamageAbility("CheckCountableExtendedBulletBaseLament", "生蝶·亡蝶装填(按理智概率分配强度/层数)"),
);
