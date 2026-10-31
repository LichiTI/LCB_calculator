/** Build a fresh, fully-initialised preset for an identity (editor default). */
import type { NormalizedIdentity, NormalizedSkill } from "./game-data";
import type { DotMap } from "./dot-types";
import { CURRENT_SCHEMA_VERSION, type BaseSkillEntry, type ExtraDamageConfig, type FollowUpEntry, type Preset } from "./preset-types";

export const defaultExtraDamage = (): ExtraDamageConfig => ({
  fixedDamage: 0,
  ratioPct: 0,
  reference: "resolvedHitDamage",
  trigger: "afterEachLandedCoin",
  modifierPolicy: "fixed",
  canTriggerOnHit: false,
});

export function perCoinDefaults(coinCount: number) {
  return {
    coinPowerDeltas: Array.from({ length: coinCount }, () => 0),
    coinDamageBonusPcts: Array.from({ length: coinCount }, () => 0),
    coinDots: Array.from({ length: coinCount }, (): DotMap => ({})),
  };
}

export function baseEntryFor(skill: NormalizedSkill, entryId: string, usesPerCycle: number): BaseSkillEntry {
  return {
    entryId,
    skillId: skill.id,
    slot: skill.slot ?? undefined,
    usesPerCycle,
    basePower: null,
    totalCoinPowerDelta: 0,
    totalDamageBonusPct: 0,
    manualDamageBucket: "additionalPercent",
    totalExtraDamage: defaultExtraDamage(),
    ...perCoinDefaults(skill.coinCount),
  };
}

export function followUpEntryFor(skill: NormalizedSkill | null, entryId: string, sourceEntryIds: string[]): FollowUpEntry {
  return {
    entryId,
    enabled: true,
    origin: "manual",
    sourceEffectId: null,
    skillId: skill?.id ?? null,
    trigger: { event: "afterSkill", sourceEntryIds, chance: 1, maxPerSourceAction: 1 },
    targetSelector: "sameTarget",
    countsTowardBaseCycle: false,
    actionSlotCost: 0,
    resourceCosts: {},
    inheritBattleState: true,
    allowTriggeringOtherFollowUps: false,
    maxChainDepth: 1,
    basePower: null,
    totalCoinPowerDelta: 0,
    totalDamageBonusPct: 0,
    manualDamageBucket: "additionalPercent",
    totalExtraDamage: defaultExtraDamage(),
    ...perCoinDefaults(skill?.coinCount ?? 0),
  };
}

/** Default 6-action order (one action per turn; the UI shows this as an assumption). */
const DEFAULT_ORDER = ["S1", "S1", "S2", "S1", "S2", "S3"];

export interface PresetDefaults {
  level?: number;
  targetDefense?: number | null;
  sp?: number;
  simMode?: "staticCycle" | "orderedCycle" | "multiTurn";
  bonusTier?: "none" | "power" | "full";
  battlePassives?: "automatic" | "none";
}

export function createPresetForIdentity(identity: NormalizedIdentity, skills: Record<string, NormalizedSkill>,
                                        dataVersion: string, name: string, defaults: PresetDefaults = {}): Preset {
  const pool = identity.skillPool
    .filter((r) => r.count > 0)
    .map((r) => ({ ref: r, skill: skills[String(r.skillId)]! }))
    .filter((x) => x.skill)
    .sort((a, b) => a.skill.skillTier - b.skill.skillTier);
  const base = pool.map(({ ref, skill }, i) =>
    baseEntryFor(skill, (skill.slot ?? `skill${i + 1}`).toLowerCase(), ref.count));
  const bySlot = new Map(base.map((e) => [e.slot, e.entryId]));
  const schedule = DEFAULT_ORDER.map((slot, i) => ({ turn: i + 1, order: 1, entryId: bySlot.get(slot) ?? base[0]!.entryId }));
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    presetId: `id${identity.id}-${Date.now().toString(36)}`,
    name,
    dataVersion,
    rulesVersion: null,
    presentation: { translationPack: "LLC_zh-CN", selectableTranslationPacks: ["LLC_zh-CN", "ST"], fallbackLanguage: "en", showMissingTranslation: true },
    actor: {
      identityId: identity.id, uptie: 4, level: defaults.level ?? 65, initialSp: defaults.sp ?? 45, initialStatuses: [], initialResources: {},
      battlePassives: defaults.battlePassives ?? "automatic", supportPassiveIds: [], disabledEffectIds: [],
    },
    skillGroups: { base, followUps: [] },
    scenario: {
      target: {
        mode: "trainingDummy", hpMode: "unlimited", defenseLevel: defaults.targetDefense === undefined ? defaults.level ?? 65 : defaults.targetDefense, hasSp: false, initialSp: null,
        physicalResistances: { slash: 1, pierce: 1, blunt: 1 },
        sinResistances: { wrath: 1, lust: 1, sloth: 1, gluttony: 1, gloom: 1, pride: 1, envy: 1 },
        initialStatuses: [], shield: 0, staggerPolicy: "disabled",
      },
      teamContext: { deployedIdentityIds: [identity.id], supportIdentityIds: [], initialSinResources: {} },
      enemyActions: [],
      missingEnemyActionsPolicy: "reportIncompleteWhenRequired",
    },
    reporting: { separateDotDamage: true, dotBreakdownBy: ["statusId", "turn"], includeStatusApplications: true },
    simulation: {
      mode: defaults.simMode ?? "orderedCycle", initialStatePolicy: "byMode", turnCount: 6, actionSelection: "scripted",
      actionSchedule: schedule, clashMode: "unopposed", deckState: null, missingRequiredContextPolicy: "reportIncomplete",
      randomMode: "seededMonteCarlo", seed: 20261030, samples: 10000, dotWindow: "withinConfiguredTurns",
      reportRemainingStatuses: true, traceLevel: "perEvent", unknownEffectPolicy: "blockExactClaim",
      ...(defaults.bonusTier && defaults.bonusTier !== "none" ? { bonusTier: defaults.bonusTier } : {}),
    },
  };
}
