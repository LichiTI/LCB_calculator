/**
 * Preset validation, migration, defaults and deterministic serialization.
 * Rules (docs/开发交接计划.md §4):
 *  - 0 and null differ (basePower null = game value; 0 = explicit override).
 *  - Per-coin arrays must match the logical coin count; never truncated, padded or cycled.
 *    Only *missing* arrays may be initialised (zeros / independent empty maps).
 *  - Unknown IDs / fields are preserved and reported, never deleted.
 *  - Display language never enters the preset's computational content.
 */
import Ajv2020 from "ajv/dist/2020";
import schema from "./preset.schema.json";
import { StatusAmount, type DotMap } from "./dot-types";
import { amountSemantics } from "./status-terms";
import {
  CURRENT_SCHEMA_VERSION,
  PER_COIN_ARRAYS,
  type BaseSkillEntry,
  type FollowUpEntry,
  type Preset,
} from "./preset-types";

export type Severity = "error" | "warning" | "info";
export interface Issue {
  severity: Severity;
  code: string;
  path: string;
  message: string;
}

/** Minimal view of game data needed for semantic checks. */
export interface GameDataIndex {
  dataVersion?: string;
  hasIdentity(id: number): boolean;
  /** undefined = unknown skill */
  coinCount(skillId: number): number | undefined;
  skillOwners(skillId: number): number[] | undefined;
  /** undefined = unknown status id */
  statusClass(statusId: string): string | undefined;
}

const KNOWN_TOP_LEVEL = new Set([
  "schemaVersion", "presetId", "name", "templateOnly", "dataVersion", "rulesVersion", "notes",
  "presentation", "actor", "skillGroups", "scenario", "reporting", "simulation",
]);

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateStructure = ajv.compile(schema);

// ---------------------------------------------------------------- migration
type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;
/** MIGRATIONS[n] upgrades schemaVersion n -> n+1. None yet: version 1 is the first format. */
export const MIGRATIONS: Record<number, Migration> = {};

export function migratePreset(raw: unknown): { value: unknown; issues: Issue[] } {
  const issues: Issue[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { value: raw, issues: [err("not-object", "", "预设必须是 JSON 对象")] };
  }
  let obj = raw as Record<string, unknown>;
  let v = obj.schemaVersion;
  if (typeof v !== "number" || !Number.isInteger(v)) {
    return { value: raw, issues: [err("no-schema-version", "/schemaVersion", "缺少 schemaVersion，无法确定格式")] };
  }
  if (v > CURRENT_SCHEMA_VERSION) {
    return { value: raw, issues: [err("newer-format", "/schemaVersion", `格式版本 ${v} 高于本程序支持的 ${CURRENT_SCHEMA_VERSION}`)] };
  }
  while (v < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) {
      return { value: obj, issues: [err("no-migration", "/schemaVersion", `没有从版本 ${v} 升级的迁移函数`)] };
    }
    obj = step(structuredClone(obj));
    issues.push(info("migrated", "/schemaVersion", `已从版本 ${v} 迁移到 ${v + 1}`));
    v += 1;
  }
  return { value: obj, issues };
}

// ---------------------------------------------------------------- validation
export function validatePreset(value: unknown, data?: GameDataIndex): Issue[] {
  const issues: Issue[] = [];
  if (!validateStructure(value)) {
    for (const e of validateStructure.errors ?? []) {
      issues.push(err("schema", e.instancePath || "/", `${e.message ?? "结构错误"}${e.params ? " " + JSON.stringify(e.params) : ""}`));
    }
    return issues; // semantic checks assume a well-formed structure
  }
  const p = value as Preset;

  for (const k of Object.keys(p)) {
    if (!KNOWN_TOP_LEVEL.has(k)) issues.push(warn("unknown-field", `/${k}`, `未知字段 ${k}（已保留）`));
  }
  if (p.templateOnly) issues.push(info("template-only", "/templateOnly", "这是模板，尚未绑定数据与规则版本"));
  if (data?.dataVersion && p.dataVersion && p.dataVersion !== data.dataVersion) {
    issues.push(warn("data-version-mismatch", "/dataVersion", `预设基于 ${p.dataVersion}，当前数据为 ${data.dataVersion}，结果可能无法复现`));
  }

  // entry ids
  const entries: { e: BaseSkillEntry | FollowUpEntry; path: string }[] = [
    ...p.skillGroups.base.map((e, i) => ({ e, path: `/skillGroups/base/${i}` })),
    ...p.skillGroups.followUps.map((e, i) => ({ e, path: `/skillGroups/followUps/${i}` })),
  ];
  const ids = new Set<string>();
  for (const { e, path } of entries) {
    if (ids.has(e.entryId)) issues.push(err("duplicate-entry-id", `${path}/entryId`, `entryId 重复：${e.entryId}`));
    ids.add(e.entryId);
  }
  p.skillGroups.followUps.forEach((f, i) => {
    f.trigger.sourceEntryIds.forEach((sid, j) => {
      if (!ids.has(sid)) issues.push(err("dangling-entry-ref", `/skillGroups/followUps/${i}/trigger/sourceEntryIds/${j}`, `引用了不存在的技能项 ${sid}`));
    });
    if (f.allowTriggeringOtherFollowUps && f.maxChainDepth < 1) {
      issues.push(err("chain-depth", `/skillGroups/followUps/${i}/maxChainDepth`, "允许连锁追击时 maxChainDepth 至少为 1"));
    }
  });
  (p.simulation.actionSchedule ?? []).forEach((a, i) => {
    if (!ids.has(a.entryId)) issues.push(err("dangling-entry-ref", `/simulation/actionSchedule/${i}/entryId`, `行动表引用了不存在的技能项 ${a.entryId}`));
  });

  if (data && !data.hasIdentity(p.actor.identityId)) {
    issues.push(err("unknown-identity", "/actor/identityId", `未知人格 ${p.actor.identityId}（已保留）`));
  }

  for (const { e, path } of entries) {
    checkEntry(e, path, p.actor.identityId, data, issues);
  }
  return issues;
}

function checkEntry(e: BaseSkillEntry | FollowUpEntry, path: string, identityId: number,
                    data: GameDataIndex | undefined, issues: Issue[]): void {
  const coins = e.skillId == null || !data ? undefined : data.coinCount(e.skillId);
  if (data && e.skillId != null) {
    if (coins === undefined) {
      issues.push(err("unknown-skill", `${path}/skillId`, `未知技能 ${e.skillId}（已保留）`));
    } else {
      const owners = data.skillOwners(e.skillId) ?? [];
      if (!owners.includes(identityId)) {
        issues.push(warn("foreign-skill", `${path}/skillId`, `技能 ${e.skillId} 不属于人格 ${identityId}`));
      }
    }
  }
  for (const key of PER_COIN_ARRAYS) {
    const arr = e[key] as unknown[] | undefined;
    if (arr === undefined) {
      if (coins !== undefined) issues.push(info("missing-per-coin", `${path}/${key}`, `${key} 缺省，将按 ${coins} 枚硬币初始化`));
      continue;
    }
    if (coins !== undefined && arr.length !== coins) {
      issues.push(err("coin-length", `${path}/${key}`, `${key} 长度 ${arr.length} ≠ 硬币数 ${coins}（不会自动截断或补齐）`));
    }
  }
  const dots = e.coinDots ?? [];
  const seen = new Set<object>();
  dots.forEach((map, i) => {
    if (seen.has(map)) issues.push(err("shared-dot-map", `${path}/coinDots/${i}`, "多枚硬币共享同一个映射对象"));
    seen.add(map);
    for (const [statusId, amount] of Object.entries(map)) {
      const at = `${path}/coinDots/${i}/${statusId}`;
      try {
        StatusAmount.fromJSON(amount);
      } catch (ex) {
        issues.push(err("bad-amount", at, String((ex as Error).message)));
        continue;
      }
      if (!data) continue;
      const cls = data.statusClass(statusId);
      if (cls === undefined) {
        issues.push(err("unknown-status", at, `未知状态 ${statusId}（已保留）`));
        continue;
      }
      const sem = amountSemantics(cls);
      if (sem === "countOnlyFromStack" && amount!.potency > 0) {
        issues.push(warn("no-potency", at, `${statusId}（${cls}）只有层数，强度 ${amount!.potency} 不会生效`));
      } else if (sem === "unknown") {
        issues.push(info("unverified-semantics", at, `${statusId}（${cls}）的强度/层数含义尚未验证`));
      }
    }
  });
}

// ---------------------------------------------------------------- defaults
/** Initialise *missing* per-coin arrays. Wrong-length arrays are left untouched (they are errors). */
export function fillPerCoinDefaults(preset: Preset, data: GameDataIndex): { preset: Preset; filled: string[] } {
  const next = structuredClone(preset);
  const filled: string[] = [];
  const visit = (e: BaseSkillEntry | FollowUpEntry, path: string) => {
    if (e.skillId == null) return;
    const n = data.coinCount(e.skillId);
    if (n === undefined) return;
    if (e.coinPowerDeltas === undefined) { e.coinPowerDeltas = Array.from({ length: n }, () => 0); filled.push(`${path}/coinPowerDeltas`); }
    if (e.coinDamageBonusPcts === undefined) { e.coinDamageBonusPcts = Array.from({ length: n }, () => 0); filled.push(`${path}/coinDamageBonusPcts`); }
    if (e.coinDots === undefined) { e.coinDots = Array.from({ length: n }, (): DotMap => ({})); filled.push(`${path}/coinDots`); }
  };
  next.skillGroups.base.forEach((e, i) => visit(e, `/skillGroups/base/${i}`));
  next.skillGroups.followUps.forEach((e, i) => visit(e, `/skillGroups/followUps/${i}`));
  return { preset: next, filled };
}

// ---------------------------------------------------------------- (de)serialization
export function serializePreset(p: Preset): string {
  return JSON.stringify(p, null, 2) + "\n";
}

export function parsePreset(text: string, data?: GameDataIndex): { preset: Preset | null; raw: unknown; issues: Issue[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (ex) {
    return { preset: null, raw: undefined, issues: [err("json", "", `JSON 解析失败：${(ex as Error).message}`)] };
  }
  const mig = migratePreset(raw);
  if (mig.issues.some((i) => i.severity === "error")) return { preset: null, raw, issues: mig.issues };
  const issues = [...mig.issues, ...validatePreset(mig.value, data)];
  const structural = issues.some((i) => i.code === "schema");
  // Semantic errors (unknown IDs, lengths) keep the preset so nothing is lost; the UI blocks calculation.
  return { preset: structural ? null : (mig.value as Preset), raw, issues };
}

export function duplicatePreset(p: Preset, presetId: string, name: string): Preset {
  return { ...structuredClone(p), presetId, name };
}

export const hasErrors = (issues: Issue[]) => issues.some((i) => i.severity === "error");

function err(code: string, path: string, message: string): Issue { return { severity: "error", code, path, message }; }
function warn(code: string, path: string, message: string): Issue { return { severity: "warning", code, path, message }; }
function info(code: string, path: string, message: string): Issue { return { severity: "info", code, path, message }; }
