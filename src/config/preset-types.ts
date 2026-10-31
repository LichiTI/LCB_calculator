/** TypeScript view of src/config/preset.schema.json (schemaVersion 1). Keep both in sync. */
import type { DotMap } from "./dot-types";

export const CURRENT_SCHEMA_VERSION = 1 as const;

export interface ExtraDamageConfig {
  /** HP. */
  fixedDamage: number;
  /** Percent: 20 means 20%. */
  ratioPct: number;
  reference: "resolvedHitDamage" | "actualHpLost";
  trigger: "afterEachLandedCoin" | "afterSkill";
  modifierPolicy: "fixed" | "sinResistance" | "reuseRule";
  canTriggerOnHit: boolean;
}

export interface SkillModifiers {
  /** null = use the game's effective base power; a number (including 0) overrides it. */
  basePower: number | null;
  /** Added once to every coin's power delta, then per-coin deltas are added. */
  totalCoinPowerDelta: number;
  /** Percent (20 = 20%) in the manual damage bucket. */
  totalDamageBonusPct: number;
  manualDamageBucket?: string;
  totalExtraDamage: ExtraDamageConfig;
  /** Index i = logical coin i. Saved presets must match the coin count exactly. */
  coinPowerDeltas?: number[];
  coinDamageBonusPcts?: number[];
  /** Manual extra DOT/status applications per coin: status ID -> { potency, count }. */
  coinDots?: DotMap[];
}

export interface BaseSkillEntry extends SkillModifiers {
  entryId: string;
  skillId: number;
  slot?: string;
  displayNameHint?: string;
  usesPerCycle: number;
  [extra: string]: unknown;
}

export interface FollowUpEntry extends SkillModifiers {
  entryId: string;
  enabled: boolean;
  origin?: "manual" | "automatic";
  sourceEffectId?: string | null;
  skillId: number | null;
  trigger: { event: string; sourceEntryIds: string[]; chance: number; maxPerSourceAction: number };
  targetSelector?: string;
  countsTowardBaseCycle?: boolean;
  actionSlotCost?: number;
  resourceCosts?: Record<string, number>;
  inheritBattleState?: boolean;
  allowTriggeringOtherFollowUps?: boolean;
  maxChainDepth: number;
  [extra: string]: unknown;
}

export interface Preset {
  schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  presetId: string;
  name: string;
  templateOnly?: boolean;
  dataVersion: string | null;
  rulesVersion: string | null;
  notes?: string[];
  presentation?: {
    translationPack?: string;
    selectableTranslationPacks?: string[];
    fallbackLanguage?: string;
    showMissingTranslation?: boolean;
  };
  actor: {
    identityId: number;
    uptie: 4;
    level: number | null;
    initialSp?: number | null;
    initialStatuses?: unknown[];
    initialResources?: Record<string, unknown>;
    battlePassives?: "automatic" | "none";
    supportPassiveIds?: number[];
    disabledEffectIds?: string[];
    [extra: string]: unknown;
  };
  skillGroups: { base: BaseSkillEntry[]; followUps: FollowUpEntry[] };
  scenario: Record<string, unknown>;
  reporting?: {
    separateDotDamage?: boolean;
    dotBreakdownBy?: ("statusId" | "turn" | "source")[];
    includeStatusApplications?: boolean;
  };
  simulation: {
    mode: "staticCycle" | "orderedCycle" | "multiTurn";
    initialStatePolicy?: "byMode" | "resetEachAction" | "carryOver";
    turnCount?: number;
    seed?: number;
    samples?: number;
    actionSchedule?: { turn: number; order: number; entryId: string }[];
    [extra: string]: unknown;
  };
  [extra: string]: unknown;
}

export const PER_COIN_ARRAYS = ["coinPowerDeltas", "coinDamageBonusPcts", "coinDots"] as const;
export type PerCoinArrayKey = (typeof PER_COIN_ARRAYS)[number];
