/**
 * Normalized game data (uptie IV) produced by tools/import-game/normalize.py.
 * Field names inside `attrs`, coin entries and ability scripts are kept verbatim from
 * static-data so nothing is lost; convenience fields are added alongside.
 * JSON Schemas: data/normalized/schema/*.schema.json (keep both in sync).
 */

export type SinAttribute =
  | "CRIMSON" | "SCARLET" | "AMBER" | "SHAMROCK" | "AZURE" | "INDIGO" | "VIOLET" | "NEUTRAL";
export type AtkType = "SLASH" | "PENETRATE" | "HIT";

/** Raw buff payload on an ability script. stack = potency (强度), turn = count (层数). */
export interface BuffData {
  buffKeyword?: string;
  target?: string;
  buffOwner?: string;
  stack?: number;
  turn?: number;
  activeRound?: number;
  value?: number;
  limit?: number;
  [extra: string]: unknown;
}

export interface AbilityScript {
  scriptName: string;
  buffData?: BuffData;
  value?: number;
  turnLimit?: number;
  conditionalData?: unknown;
  [extra: string]: unknown;
}

export interface Coin {
  /** Logical coin index; matches coinPowerDeltas[i] / coinDamageBonusPcts[i] / coinDots[i]. */
  index: number;
  operatorType: "ADD" | "SUB" | string;
  scale: number;
  abilityScriptList?: AbilityScript[];
  [extra: string]: unknown;
}

export interface NormalizedSkill {
  id: number;
  file: string;
  skillType: string;
  skillTier: number;
  slot: "S1" | "S2" | "S3" | null;
  requireIDList: unknown[];
  owners: number[];
  /** "attributeList" | "defenseSkillIDList" | "<ChangeSkillScript><-<sourceSkillId>" */
  discoveredVia: string[];
  levelsAvailable: number[];
  levelsMerged: number[];
  /** Which gaksungLevel supplied each effective field (audit trail). */
  fieldSourceLevel: Record<string, number>;
  basePower: number;
  coinCount: number;
  /** Remaining effective skillData fields (attributeType, atkType, defType, skillLevelCorrection, ...). */
  attrs: Record<string, unknown> & {
    attributeType?: SinAttribute;
    atkType?: AtkType;
    defType?: string;
    skillLevelCorrection?: number;
    defaultValue?: number;
    targetNum?: number;
    mpUsage?: number;
  };
  abilityScripts: AbilityScript[];
  coins: Coin[];
}

export interface IdentitySkillRef {
  skillId: number;
  /** Copies in the deck. 0 = only reachable through a skill-change effect. */
  count: number;
}

export interface NormalizedIdentity {
  id: number;
  characterId: number;
  rank: number;
  season?: number;
  updatedDate: number;
  appearance: string;
  uptie: 4;
  unitKeywords: string[];
  associations: string[];
  skillKeywords: string[];
  uniqueAttribute: SinAttribute;
  /** Max HP at level L is derived by the engine from base/perLevel (formula to be verified). */
  hp: { base: number; perLevel: number };
  defCorrection: number;
  speed: { min: number; max: number };
  staggerThresholdsPct: number[];
  atkResist: Partial<Record<AtkType, number>>;
  skillPool: IdentitySkillRef[];
  defenseSkillIds: number[];
  panicSkillOnErosion?: number;
  battlePassiveIds: number[];
  supportPassiveIds: number[];
  alternativePassives: null | { battle: number[]; support: number[]; field: string };
  initBuffs: { buff: string; stack?: number; turn?: number }[];
  unitScriptId: string | number | null;
  walpurgisType: string | null;
  isPlusCoinUnit: boolean | null;
  mentalConditionInfo: unknown;
  provenance: Record<string, unknown>;
}

export interface NormalizedPassive {
  id: number;
  file: string;
  owners: number[];
  sinCondition: { type: SinAttribute; value: number }[];
  requireIDList: string[];
  raw: Record<string, unknown>;
}

export interface NormalizedBuff {
  id: string;
  file: string;
  buffClass?: string;
  buffType?: "Positive" | "Negative" | "Neutral";
  attributeType?: SinAttribute;
  maxStack?: number;
  maxTurn?: number;
  stackLimitPerTurn?: number;
  canBeDespelled?: boolean;
  list?: { ability: string; value?: number; [k: string]: unknown }[];
  categoryKeywordList?: string[];
  /** Base keywords this unique variant counts as (e.g. ChargeNoirAlly -> ["Charge"]). */
  subIdList?: string[];
  [extra: string]: unknown;
}

export interface NormalizedEgo {
  id: number;
  file: string;
  characterId: number;
  egoType: "ZAYIN" | "TETH" | "HE" | "WAW" | "ALEPH" | string;
  season: number;
  requirements: { attributeType: SinAttribute; num: number }[];
  passiveIds: number[];
  awakeningSkillId: number | null;
  corrosionSkillId: number | null;
}

/** Localized text index per translation pack (tools/import-game/build_text.py). */
export interface LocalizedSkillText {
  name?: string;
  desc?: string;
  /** Text coin list may omit trailing coins without descriptions; never infer coin count from it. */
  coins: { descs: string[] }[];
  level: number;
  file: string;
}
