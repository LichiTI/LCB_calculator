/**
 * External buffs: effects provided outside the identity itself (support passives, teammate
 * buffs, E.G.O passives, custom). Stored in preset.actor.externalBuffs.
 *
 * Includes smart metadata matching (e.g. `onlyConsumesCharge` automatically checks whether a
 * skill in `core.skills` has a Charge-consuming script) and automatic parsing of game Buffs
 * and Passives from `core.buffs` / `core.passives` + localized descriptions.
 */
import type { AtkType, NormalizedBuff, NormalizedSkill, SinAttribute } from "./game-data";

export type ExternalBuffSource = "support" | "team" | "ego" | "custom";

export const SOURCE_LABEL: Record<ExternalBuffSource, string> = {
  support: "支援被动",
  team: "队友 Buff",
  ego: "E.G.O 被动",
  custom: "自定义",
};

export interface ExternalBuff {
  id: string;
  name: string;
  source: ExternalBuffSource;
  enabled: boolean;
  /** Base power (基础威力) */
  basePower: number;
  /** Coin power (硬币威力) on every coin */
  coinPower: number;
  /** Final power (最终威力) */
  finalPower: number;
  /** Offense level (攻击等级) */
  offenseLevel: number;
  /** Damage dealt +% */
  dmgPct: number;
  /** Target takes damage +% (e.g. 易损) */
  takeDmgPct: number;
  /** Optional filters: only apply when the skill matches. */
  sin?: SinAttribute | null;
  atk?: AtkType | null;
  slot?: string | null;
  /** Only apply to skills whose metadata consumes Charge / Special Charge count. */
  onlyConsumesCharge?: boolean;
  note?: string;
}

export function newExternalBuff(partial: Partial<ExternalBuff> & { name: string }): ExternalBuff {
  return {
    id: `xb-${Math.random().toString(36).slice(2, 9)}`,
    source: "custom",
    enabled: true,
    basePower: 0,
    coinPower: 0,
    finalPower: 0,
    offenseLevel: 0,
    dmgPct: 0,
    takeDmgPct: 0,
    sin: null,
    atk: null,
    slot: null,
    onlyConsumesCharge: false,
    ...partial,
  };
}

/** Check from real game skill metadata whether a skill consumes Charge (or Special Charge) count. */
export function doesSkillConsumeCharge(skill: NormalizedSkill | undefined): boolean {
  if (!skill) return false;
  const allScripts = [
    ...(skill.abilityScripts ?? []),
    ...skill.coins.flatMap((c) => c.abilityScriptList ?? []),
  ];
  for (const s of allScripts) {
    const n = s.scriptName;
    const kw = s.buffData?.buffKeyword ?? "";
    const isChargeKw = kw === "Charge" || kw.startsWith("Charge") || /Charge/i.test(n);
    if (!isChargeKw) continue;
    if (
      /UseBuff|UsingBuff|AndUse|UseTurn|Consume/i.test(n) ||
      n === "CoinScaleAdderOnUseViaUsingBuffAmount" ||
      n === "CoinScaleAdderBeforeRollCoinAndUseBuffTurnMax"
    ) {
      return true;
    }
  }
  return false;
}

/** Editable templates (common generic modifiers). */
export const EXTERNAL_BUFF_TEMPLATES: { label: string; make: () => ExternalBuff }[] = [
  { label: "伤害 +10%（伤害强化 1 层）", make: () => newExternalBuff({ name: "伤害强化", source: "team", dmgPct: 10 }) },
  { label: "攻击等级 +2", make: () => newExternalBuff({ name: "攻击等级提升", source: "team", offenseLevel: 2 }) },
  { label: "基础威力 +1", make: () => newExternalBuff({ name: "基础威力提升", source: "team", basePower: 1 }) },
  { label: "硬币威力 +1", make: () => newExternalBuff({ name: "硬币威力提升", source: "team", coinPower: 1 }) },
  { label: "最终威力 +1（强壮 1 层）", make: () => newExternalBuff({ name: "强壮", source: "team", finalPower: 1 }) },
  { label: "目标易损 +10%（易损 1 层）", make: () => newExternalBuff({ name: "易损", source: "team", takeDmgPct: 10 }) },
  {
    label: "消耗充能技能伤害 +20%（自动识别耗充能技能）",
    make: () => newExternalBuff({ name: "耗充能技能增伤", source: "team", dmgPct: 20, onlyConsumesCharge: true }),
  },
];

export function readExternalBuffs(raw: unknown): ExternalBuff[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((o) => {
      const n = (k: string) => (typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : 0);
      return {
        id: typeof o.id === "string" ? o.id : `xb-${Math.random().toString(36).slice(2, 9)}`,
        name: typeof o.name === "string" ? o.name : "未命名",
        source: (["support", "team", "ego", "custom"].includes(o.source as string) ? o.source : "custom") as ExternalBuffSource,
        enabled: o.enabled !== false,
        basePower: n("basePower"),
        coinPower: n("coinPower"),
        finalPower: n("finalPower"),
        offenseLevel: n("offenseLevel"),
        dmgPct: n("dmgPct"),
        takeDmgPct: n("takeDmgPct"),
        sin: (typeof o.sin === "string" ? o.sin : null) as SinAttribute | null,
        atk: (typeof o.atk === "string" ? o.atk : null) as AtkType | null,
        slot: typeof o.slot === "string" ? o.slot : null,
        onlyConsumesCharge: o.onlyConsumesCharge === true,
        note: typeof o.note === "string" ? o.note : undefined,
      };
    });
}

export function matchesSkill(
  b: ExternalBuff,
  sin: string | undefined,
  atk: string | undefined,
  slot: string | null | undefined,
  skill?: NormalizedSkill,
): boolean {
  if (!b.enabled) return false;
  if (b.sin && b.sin !== sin) return false;
  if (b.atk && b.atk !== atk) return false;
  if (b.slot && b.slot !== slot) return false;
  if (b.onlyConsumesCharge && skill && !doesSkillConsumeCharge(skill)) return false;
  return true;
}

const SIN_FROM_TEXT: [RegExp, SinAttribute][] = [
  [/暴怒|Wrath/i, "CRIMSON"],
  [/色欲|Lust/i, "SCARLET"],
  [/怠惰|Sloth/i, "AMBER"],
  [/暴食|Gluttony/i, "SHAMROCK"],
  [/忧郁|Gloom/i, "AZURE"],
  [/傲慢|Pride/i, "INDIGO"],
  [/嫉妒|Envy/i, "VIOLET"],
];

const ATK_FROM_TEXT: [RegExp, AtkType][] = [
  [/斩击|Slash/i, "SLASH"],
  [/突刺|穿刺|Pierce/i, "PENETRATE"],
  [/打击|Blunt/i, "HIT"],
];

function extractClauseModifiers(clause: string): Partial<ExternalBuff> {
  const out: Partial<ExternalBuff> = {};
  if (/消耗.*(?:充能|保存)|consume.*Charge/i.test(clause)) {
    out.onlyConsumesCharge = true;
  }
  if (/(?:一|1)\s*技能|Skill\s*1/i.test(clause)) out.slot = "S1";
  else if (/(?:二|2)\s*技能|Skill\s*2/i.test(clause)) out.slot = "S2";
  else if (/(?:三|3)\s*技能|Skill\s*3/i.test(clause)) out.slot = "S3";

  for (const [re, sin] of SIN_FROM_TEXT) {
    if (re.test(clause) && !/持有|共鸣/.test(clause)) {
      out.sin = sin;
      break;
    }
  }
  for (const [re, atk] of ATK_FROM_TEXT) {
    if (re.test(clause)) {
      out.atk = atk;
      break;
    }
  }

  // Prefer parentheses override like "+10%(属于黑派的友方人格的技能改为+20%)"
  const overrideDmg = /改为\s*\+(\d+)\s*%/.exec(clause);
  const allPct = [...clause.matchAll(/(?:伤害|damage)[^+%\n]{0,18}\+(\d+)\s*%|\+(\d+)\s*%\s*(?:伤害|damage)/gi)];
  if (overrideDmg) {
    const v = Number(overrideDmg[1]);
    if (/受到.*伤害/.test(clause)) out.takeDmgPct = v;
    else out.dmgPct = v;
  } else if (allPct.length > 0) {
    const m = allPct[allPct.length - 1]!;
    const v = Number(m[1] ?? m[2] ?? 0);
    if (/受到.*伤害/.test(clause) && !/目标受到/.test(clause)) out.takeDmgPct = v;
    else out.dmgPct = v;
  }

  const offCap = /攻击等级[^。\n]*?最多\s*\+(\d+)/.exec(clause) ?? /(?:攻击等级|Offense Level)\s*\+(\d+)/i.exec(clause);
  if (offCap) out.offenseLevel = Number(offCap[1]);

  const coinMatch = /(?:硬币威力|Coin Power)\s*\+(\d+)/i.exec(clause);
  if (coinMatch) out.coinPower = Number(coinMatch[1]);

  const finalMatch = /(?:最终威力|攻击威力|威力提升|Final Power)\s*\+(\d+)/i.exec(clause);
  if (finalMatch) out.finalPower = Number(finalMatch[1]);

  const baseMatch = /(?:基础威力|Base Power)\s*\+(\d+)/i.exec(clause);
  if (baseMatch) out.basePower = Number(baseMatch[1]);

  return out;
}

/**
 * Smart parser: given a game Buff (`core.buffs[id]`) or Passive description and stack count,
 * returns 1 or more `ExternalBuff` rows with accurate values AND scope filters
 * (`onlyConsumesCharge`, `slot`, `sin`, `atk`).
 */
export function parseSmartBuffs({
  name,
  desc,
  source,
  buffDef,
  stacks = 1,
}: {
  name: string;
  desc: string;
  source: ExternalBuffSource;
  buffDef?: NormalizedBuff;
  stacks?: number;
}): ExternalBuff[] {
  const cleanDesc = desc.replace(/<[^>]+>/g, "");
  const sCount = Math.max(1, Math.trunc(stacks));

  // 1. Check structured buffDef.list first if it has standard numeric abilities
  if (buffDef?.list && buffDef.list.length > 0) {
    const fromDef: Partial<ExternalBuff> = {};
    let matchedDef = false;
    for (const item of buffDef.list) {
      const ab = item.ability;
      const val = typeof item.value === "number" ? item.value : 0;
      const itemRec = item as Record<string, unknown>;
      if (typeof itemRec.attribute === "string") fromDef.sin = itemRec.attribute as SinAttribute;
      if (typeof itemRec.atk === "string") fromDef.atk = itemRec.atk as AtkType;

      if (ab === "AtkDamageMultiplierByStack" || ab === "DefaultAtkSkillAtkDamageMultiplierByStack" || ab === "CriticalAtkDamageMultiplierByStack") {
        fromDef.dmgPct = (fromDef.dmgPct ?? 0) + Math.round(sCount * val * 100);
        matchedDef = true;
      } else if (ab === "AtkDamageMultiplier") {
        fromDef.dmgPct = (fromDef.dmgPct ?? 0) + Math.round(val * 100);
        matchedDef = true;
      } else if (ab === "TakeAtkDamageMultiplierByStack" || ab === "TakeAtkDmgMultiplierWarinessHonglu") {
        fromDef.takeDmgPct = (fromDef.takeDmgPct ?? 0) + Math.round(sCount * val * 100);
        matchedDef = true;
      } else if (ab === "TakeAtkDamageMultiplier") {
        fromDef.takeDmgPct = (fromDef.takeDmgPct ?? 0) + Math.round(val * 100);
        matchedDef = true;
      } else if (ab === "AtkSkillPowerResultAdderAsStack" || ab === "SkillPowerResultAdderAsStack") {
        fromDef.finalPower = (fromDef.finalPower ?? 0) + sCount * Math.round(val);
        matchedDef = true;
      } else if (ab === "SkillPowerResultAdder") {
        fromDef.finalPower = (fromDef.finalPower ?? 0) + Math.round(val);
        matchedDef = true;
      } else if (ab === "BasePowerAdder") {
        fromDef.basePower = (fromDef.basePower ?? 0) + Math.round(val);
        matchedDef = true;
      } else if (ab === "GiveBuffTimeToListenHonglu") {
        fromDef.basePower = (fromDef.basePower ?? 0) + 1;
        fromDef.dmgPct = (fromDef.dmgPct ?? 0) + 10;
        fromDef.sin = "AMBER";
        matchedDef = true;
      } else if (ab === "CoinScaleAdderByStack" || ab === "PlusCoinScaleAdderByStack") {
        fromDef.coinPower = (fromDef.coinPower ?? 0) + sCount * Math.round(val);
        matchedDef = true;
      } else if (ab === "AtkAdderByStack") {
        fromDef.offenseLevel = (fromDef.offenseLevel ?? 0) + Math.round(sCount * val);
        matchedDef = true;
      } else if (ab === "AtkAdder") {
        fromDef.offenseLevel = (fromDef.offenseLevel ?? 0) + Math.round(val);
        matchedDef = true;
      } else if (ab === "AtkAdderPerStack" && val > 0) {
        fromDef.offenseLevel = (fromDef.offenseLevel ?? 0) + Math.trunc(sCount / Math.round(val));
        matchedDef = true;
      }
    }
    if (matchedDef) {
      return [
        newExternalBuff({
          name: sCount > 1 ? `${name} (${sCount}层)` : name,
          source,
          note: cleanDesc,
          ...fromDef,
        }),
      ];
    }
  }

  // 2. For complex field/aura buffs or passives (like 保存神域 OathField or E.G.O passives),
  // split clauses if one part is unconditional (e.g. 攻击等级+2) and another part is conditional on 消耗充能.
  const lines = cleanDesc.split(/[；。\n·•]+/).map((s) => s.trim()).filter(Boolean);
  const unconditional: Partial<ExternalBuff> = {};
  const chargeConditional: Partial<ExternalBuff> = { onlyConsumesCharge: true };
  let hasUncond = false;
  let hasChargeCond = false;

  for (const line of lines) {
    const m = extractClauseModifiers(line);
    const hasAnyVal =
      (m.offenseLevel ?? 0) !== 0 ||
      (m.basePower ?? 0) !== 0 ||
      (m.coinPower ?? 0) !== 0 ||
      (m.finalPower ?? 0) !== 0 ||
      (m.dmgPct ?? 0) !== 0 ||
      (m.takeDmgPct ?? 0) !== 0;
    if (!hasAnyVal) continue;

    if (m.onlyConsumesCharge) {
      hasChargeCond = true;
      if (m.offenseLevel) chargeConditional.offenseLevel = m.offenseLevel;
      if (m.basePower) chargeConditional.basePower = m.basePower;
      if (m.coinPower) chargeConditional.coinPower = m.coinPower;
      if (m.finalPower) chargeConditional.finalPower = m.finalPower;
      if (m.dmgPct) chargeConditional.dmgPct = m.dmgPct;
      if (m.takeDmgPct) chargeConditional.takeDmgPct = m.takeDmgPct;
      if (m.slot) chargeConditional.slot = m.slot;
      if (m.sin) chargeConditional.sin = m.sin;
      if (m.atk) chargeConditional.atk = m.atk;
    } else {
      hasUncond = true;
      if (m.offenseLevel) unconditional.offenseLevel = m.offenseLevel;
      if (m.basePower) unconditional.basePower = m.basePower;
      if (m.coinPower) unconditional.coinPower = m.coinPower;
      if (m.finalPower) unconditional.finalPower = m.finalPower;
      if (m.dmgPct) unconditional.dmgPct = m.dmgPct;
      if (m.takeDmgPct) unconditional.takeDmgPct = m.takeDmgPct;
      if (m.slot) unconditional.slot = m.slot;
      if (m.sin) unconditional.sin = m.sin;
      if (m.atk) unconditional.atk = m.atk;
    }
  }

  const results: ExternalBuff[] = [];
  if (hasUncond) {
    results.push(
      newExternalBuff({
        name: hasChargeCond ? `${name} (常驻)` : name,
        source,
        note: cleanDesc,
        ...unconditional,
      }),
    );
  }
  if (hasChargeCond) {
    results.push(
      newExternalBuff({
        name: `${name} (耗充能技能)`,
        source,
        note: cleanDesc,
        ...chargeConditional,
      }),
    );
  }
  if (results.length === 0) {
    const fallback = extractClauseModifiers(cleanDesc);
    results.push(
      newExternalBuff({
        name,
        source,
        note: cleanDesc,
        ...fallback,
      }),
    );
  }
  return results;
}
