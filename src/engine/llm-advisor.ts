/**
 * LLM Advisor Engine:
 *   1. Packages the selected identity's complete Uptie 4 metadata (skills, variant skills,
 *      coins, C# abilityScripts, passives, referenced core.buffs definitions, and E.G.O passives)
 *      into a structured dossier.
 *   2. Provides the built-in Limbus Company Theorycrafter System Prompt (editable by user) +
 *      user custom prompt.
 *   3. Supports the Big Three LLM API formats:
 *        - OpenAI Compatible (`openai`: /chat/completions)
 *        - Google Gemini (`gemini`: /v1beta/models/{model}:generateContent)
 *        - Anthropic Claude (`claude`: /v1/messages)
 *   4. Parses the LLM's structured JSON block (`excelCases`, `externalBuffs`, `schedule`) so the
 *      deterministic calculator engine can immediately compute and apply the exact numbers.
 */
import type { CoreData, NamedText, SkillText, TextResolver } from "../data/game-data";
import type { Preset } from "../config/preset-types";
import { doesSkillConsumeCharge, newExternalBuff, readExternalBuffs, type ExternalBuff } from "../config/external-buffs";
import { analyzeSkillBonusCap } from "./bonus-tier";
import { evaluateSkillCase, type SkillCaseRow } from "../ui/QuickSkillSheet";
import { stripRichTags } from "../ui/RichText";

export type LlmProvider = "openai" | "gemini" | "claude";

export interface LlmConfig {
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
}

const STORAGE_KEY = "lcalc.llmConfig.v2";
const LEGACY_STORAGE_KEY = "lcalc.llmConfig.v1";
export const DEFAULT_TEMPERATURE = 1;

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o",
  temperature: DEFAULT_TEMPERATURE,
};

/** Claude accepts 0–1, OpenAI / Gemini accept 0–2. */
export function clampTemperature(provider: LlmProvider, t: number): number {
  const max = provider === "claude" ? 1 : 2;
  return Math.min(max, Math.max(0, Number.isFinite(t) ? t : DEFAULT_TEMPERATURE));
}

export const PROVIDER_DEFAULTS: Record<LlmProvider, { label: string; baseUrl: string; modelPlaceholder: string }> = {
  openai: {
    label: "OpenAI 兼容 (OpenAI / DeepSeek / 硅基流动 / OpenRouter)",
    baseUrl: "https://api.openai.com/v1",
    modelPlaceholder: "gpt-4o / deepseek-reasoner / claude-3-7-sonnet",
  },
  gemini: {
    label: "Google Gemini (官方或反代)",
    baseUrl: "https://generativelanguage.googleapis.com",
    modelPlaceholder: "gemini-2.5-pro / gemini-2.0-flash",
  },
  claude: {
    label: "Anthropic Claude (官方或反代)",
    baseUrl: "https://api.anthropic.com",
    modelPlaceholder: "claude-3-7-sonnet-latest / claude-sonnet-4-20250514",
  },
};

export function loadLlmConfig(): LlmConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // v1 stored temperature 0.2 by default; migrate key / endpoint / model but reset temperature to 1.
    const legacy = raw ? null : localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw && !legacy) return DEFAULT_LLM_CONFIG;
    const p = JSON.parse((raw ?? legacy)!) as Partial<LlmConfig>;
    if (legacy) delete p.temperature;
    return {
      provider: p.provider === "gemini" || p.provider === "claude" ? p.provider : "openai",
      baseUrl: typeof p.baseUrl === "string" && p.baseUrl.trim() ? p.baseUrl.trim() : DEFAULT_LLM_CONFIG.baseUrl,
      apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
      model: typeof p.model === "string" && p.model.trim() ? p.model.trim() : DEFAULT_LLM_CONFIG.model,
      temperature: typeof p.temperature === "number" ? p.temperature : DEFAULT_TEMPERATURE,
    };
  } catch {
    return DEFAULT_LLM_CONFIG;
  }
}

export function saveLlmConfig(cfg: LlmConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    // ignore storage errors
  }
}

export const DEFAULT_SYSTEM_PROMPT = `你是一位精通《边狱公司》(Limbus Company) 伤害公式与排轴机制的数值精算师。
用户会以 JSON 形式提供解包元数据，你只能依据这些数据推理，不要凭记忆臆测数据里没有的效果：
- mainIdentity：要计算的主人格（技能、守备/反击、变体技能、硬币脚本 scripts、战斗被动、支援被动）。
- teammates：用户手动附带的队友人格完整数据（可能为空）。队友提供的 Buff 只能从其技能 / 被动描述与脚本中推出。
- referencedBuffDefinitions：上述技能与被动引用到的所有状态定义（name / desc / abilities / maxStack 等）。
- extraBuffDefinitions：用户额外指定要考虑的状态定义（可能为空）。
- currentExternalBuffs：用户已在计算器中手动填写的数值加成词条（攻等 / 威力 / 增伤 / 易损等）。
若用户的问题提到了数据中不存在的状态或队友，请明确指出“元数据中未提供该内容”，并说明需要用户附带什么数据，而不是自行编造数值。

## 一、核心伤害公式
- 第一乘区 = (25 + |Δ| + Δ) / (25 + |Δ|) + 物理抗性修正 + 罪孽抗性修正 + (暴击 ? 0.2 : 0)。
  Δ = 我方攻击等级 − 敌方防御等级；同级时 Δ = 技能 skillLevelCorrection + 各类攻击等级加成 − 敌方防御等级加成。
  抗性修正：抗性 R ≥ 1 时为 R − 1；0 ≤ R < 1 时为 (R − 1) × 0.5。
- 第二乘区 = 1 + 技能条件增伤 + 被动 / 队友增伤 + 敌方受伤增加（易损等）。同一乘区内为加算。
- 单枚硬币伤害 = 第一乘区 × 该硬币结算时的技能威力 × 该硬币的第二乘区（游戏内逐币向下取整）。
  硬币威力按顺序累加；重复使用（Reuse / 重投）的硬币继续累加威力并单独结算一次。若脚本写明按该硬币最终伤害追加 X% 伤害，则该币额外 × (1 + X%)。

## 二、推理要点
1. 逐条阅读每个技能的 desc 与 scripts、每个被动与状态的 desc / abilities，列出该人格的资源（层数 / 强度）、启动条件与强化形态。
2. 检查守备 / 反击技能是否给予关键状态，或在特定状态下变身为其他技能，并注意次数限制。若替换一技能（一般 3 张）能加快启动或带来变身，请比较替换前后。
3. 标准牌库为 6 个技能（S1×3、S2×2、S3×1，S1 可以替换为守备 / 反击）。若核心循环不是 6 回合（例如 4 回合），请按两者的最小公倍数排轴（如 12 回合 = 2 副牌），再把各情况出现次数按比例折算回 6 技能一轮（12 动时每次出现记权重 0.5）。
4. 注意状态的回合衰减、技能中途施加的状态只影响之后的硬币（前段与尾币乘区不同时分段计算），以及“本回合及下回合”类状态能否被下一回合的技能吃到。
5. 带条件的加成要严格核对条件，例如只对消耗某资源的技能生效（元数据中每个技能标注了 consumesCharge）。
6. 严格按用户消息开头【计算场景】指定的回合数与开局资源计算，不要擅自换成别的场景；没有指定场景时，同时给出「开局白板」与「完全启动后稳定循环」两种情况。
7. 「首尾一致的稳态循环」指：循环开始时的资源状态 = 循环结束时的资源状态。先推出这个稳态，再按它计算，而不是假设所有资源都已经叠满。
8. 描述里的 [英文ID] 是状态 / 关键词，其定义在 referencedBuffDefinitions 中。带随机或概率的效果（随机武器、概率触发、随机目标等）按期望值计算并写明概率假设；影响较大时另列最好 / 最坏情况。

## 三、输出格式
第一部分：用中文说明机制解读、所用加成及其数据来源、最佳出招顺序（每回合做什么、状态如何流转）、各技能各情况的算式。
第二部分：回复末尾必须附一个 \`\`\`json 代码块，供计算器读取验算，格式如下（schedule 中的技能项 ID 只能使用 mainIdentity.scheduleEntryIds 列出的值，数组长度等于场景回合数，6 或 12；12 回合时 excelCases 中每次出现的 weight 记 0.5）：
\`\`\`json
{
  "title": "方案简短标题",
  "externalBuffs": [
    {
      "name": "加成名称（使用元数据中的状态名）",
      "source": "team",
      "offenseLevel": 0,
      "basePower": 0,
      "coinPower": 0,
      "finalPower": 0,
      "dmgPct": 0,
      "takeDmgPct": 0,
      "onlyConsumesCharge": false,
      "slot": null,
      "sin": null,
      "atk": null
    }
  ],
  "schedule": ["s1", "s2", "s1", "s3", "s1", "s2"],
  "excelCases": [
    {
      "slotLabel": "S1",
      "caseName": "情况说明",
      "basePower": 4,
      "coinScale": 4,
      "operator": "ADD",
      "coinCount": 2,
      "rerollCount": 0,
      "levelDelta": 0,
      "resistOffset": 0,
      "isCrit": false,
      "dmgBonusPct": 0,
      "tailDmgBonusPct": null,
      "rerollExtraRatioPct": 0,
      "weight": 1
    }
  ]
}
\`\`\``;

/** Calculation scenarios: each one fixes the turn count and the opening resources. */
export interface LlmScenario {
  id: "cold6" | "steady6" | "full12" | "warm12" | "free";
  label: string;
  hint: string;
  turns: 6 | 12 | null;
  /** Bonus tier the calculator should use when verifying the returned schedule. */
  bonusTier: "none" | "full" | null;
  prompt: string;
}

export const LLM_SCENARIOS: LlmScenario[] = [
  {
    id: "cold6",
    label: "开局 6T",
    hint: "第一副牌，资源从 0 开始",
    turns: 6,
    bonusTier: "none",
    prompt:
      "【计算场景：开局 6T】从战斗第 1 回合开始，所有资源（层数 / 强度 / 计数）为 0，只保留人格自带的初始状态与开局被动给予的状态。只打第一副牌共 6 回合。目标：这 6 回合的总伤最大。逐回合写出出招与回合结束时的资源。schedule 输出 6 项。",
  },
  {
    id: "steady6",
    label: "稳态 6T",
    hint: "一副牌首尾一致的循环",
    turns: 6,
    bonusTier: "full",
    prompt:
      "【计算场景：稳态 6T】只讨论已经启动后的稳定循环，以一副牌 6 回合为一个循环，开局资源 = 这 6 回合结束时的资源（首尾一致）。先推出该稳态再计算 6 回合总伤。如果核心机制周期不是 6 回合、导致 6 回合内无法首尾一致，请明确指出，并建议改用 12T。schedule 输出 6 项。",
  },
  {
    id: "full12",
    label: "12T 全程",
    hint: "启动前 + 启动后两副牌",
    turns: 12,
    bonusTier: "none",
    prompt:
      "【计算场景：12T 全程】从第 1 回合资源为 0 开始，连续打两副牌共 12 回合，前 6 回合是启动期、后 6 回合是启动后。分别给出 T1–6 与 T7–12 的小计、12 回合总伤，以及折算到 6 技能一轮的值（总伤 ÷ 2）。schedule 输出 12 项。",
  },
  {
    id: "warm12",
    label: "启动后 12T",
    hint: "两副牌首尾一致的稳态",
    turns: 12,
    bonusTier: "full",
    prompt:
      "【计算场景：完全启动后 12T 稳态】只讨论完全启动后的稳态，以两副牌 12 回合为一个循环，开局资源 = 这 12 回合结束时的资源（首尾一致）。适用于机制周期为 4 回合等与 6 不整除的人格。给出 12 回合总伤与折算到 6 技能一轮的值（÷ 2）。schedule 输出 12 项。",
  },
  {
    id: "free",
    label: "自定义",
    hint: "只发送下面的补充要求",
    turns: null,
    bonusTier: null,
    prompt: "",
  },
];

export function composeUserPrompt(scenario: LlmScenario, extra: string): string {
  return [scenario.prompt, extra.trim()].filter(Boolean).join("\n\n");
}

export interface DossierOptions {
  /** Extra identities (teammates) whose full data should be attached. */
  extraIdentityIds?: number[];
  /** Extra buff / status ids whose definitions should be attached. */
  extraBuffIds?: string[];
}

/** Build a comprehensive JSON dossier (main identity + optional teammates + optional extra buffs) for the LLM. */
export function buildIdentityDossier(core: CoreData, text: TextResolver, preset: Preset, opts: DossierOptions = {}): string {
  const idObj = core.identities.find((i) => i.id === preset.actor.identityId);
  if (!idObj) return JSON.stringify({ error: "未找到当前人格" });
  const referencedBuffIds = new Set<string>();

  const collect = (scripts: { buffData?: { buffKeyword?: string } }[] | undefined) => {
    for (const sc of scripts ?? []) if (sc.buffData?.buffKeyword) referencedBuffIds.add(sc.buffData.buffKeyword);
  };
  /** Keywords written as [BuffId] inside raw descriptions (weapons, prescripts, unlock stages…). */
  const isKnownKeyword = (id: string) => Boolean(core.buffs[id]) || Boolean(text.keywordInfo(id).name);
  const scanText = (raw: string | undefined | null) => {
    for (const m of (raw ?? "").matchAll(/\[([A-Za-z][A-Za-z0-9_]*)\]/g)) if (isKnownKeyword(m[1]!)) referencedBuffIds.add(m[1]!);
  };

  const formatSkill = (sid: number, countInDeck: number, role: string) => {
    const s = core.skills[String(sid)];
    if (!s) return null;
    const st = text.get("skills", sid).value as SkillText | undefined;
    const cap = analyzeSkillBonusCap(s);
    collect(s.abilityScripts);
    for (const c of s.coins) collect(c.abilityScriptList);
    scanText(st?.desc);
    for (const c of st?.coins ?? []) for (const d of c.descs ?? []) scanText(d);
    return {
      skillId: s.id,
      role,
      slot: s.slot,
      copiesIn6SkillDeck: countInDeck,
      name: stripRichTags(st?.name ?? String(s.id)),
      attributeType: s.attrs.attributeType,
      atkType: s.attrs.atkType,
      defType: s.attrs.defType,
      skillLevelCorrection: s.attrs.skillLevelCorrection ?? 0,
      basePower: s.basePower,
      coinCount: s.coinCount,
      coins: s.coins.map((c, idx) => ({
        coinIndex: idx + 1,
        operator: c.operatorType,
        scale: c.scale,
        desc: (st?.coins?.[idx]?.descs ?? []).map((d) => stripRichTags(d)),
        scripts: c.abilityScriptList ?? [],
      })),
      consumesCharge: doesSkillConsumeCharge(s),
      autoDetectedCaps: {
        coinPowerBonusCap: cap.coinPower,
        finalPowerBonusCap: cap.finalPower,
        dmgBonusCapPct: Math.round(cap.dmg * 100),
        critDmgBonusCapPct: Math.round(cap.critDmg * 100),
        rerollCoinIndex: cap.rerollCoinIndex != null ? cap.rerollCoinIndex + 1 : null,
        rerollCoinCount: cap.rerollCoinCount,
        rerollBonusDmgRatioPct: Math.round(cap.rerollBonusDmgRatio * 100),
      },
      desc: stripRichTags(st?.desc ?? ""),
      skillScripts: s.abilityScripts ?? [],
    };
  };

  const formatPassive = (pid: number, kind: string) => {
    const pv = text.get("passives", pid).value as NamedText | undefined;
    scanText(pv?.desc);
    return {
      passiveId: pid,
      kind,
      name: stripRichTags(pv?.name ?? String(pid)),
      sinCondition: core.passives[String(pid)]?.sinCondition ?? [],
      desc: stripRichTags(pv?.desc ?? ""),
    };
  };

  const buildIdentityBlock = (id: (typeof core.identities)[number]) => {
    const idText = text.get("personalities", id.id).value as NamedText | undefined;
    for (const b of id.initBuffs) referencedBuffIds.add(b.buff);
    return {
      id: id.id,
      title: stripRichTags((idText?.title ?? "").replace(/\n/g, " ")),
      name: stripRichTags(idText?.name ?? String(id.id)),
      rank: id.rank,
      speed: id.speed,
      associations: id.associations,
      skillKeywords: id.skillKeywords,
      initBuffs: id.initBuffs,
      skills: [
        ...id.skillPool.map((r) => formatSkill(r.skillId, r.count, r.count > 0 ? `攻击技能 (${r.count}张/轮)` : "特殊变体技能（由其他技能或状态转化）")),
        ...id.defenseSkillIds.map((d) => formatSkill(d, 0, "守备/反击技能")),
      ].filter(Boolean),
      battlePassives: id.battlePassiveIds.map((pid) => formatPassive(pid, "战斗被动")),
      supportPassives: id.supportPassiveIds.map((pid) => formatPassive(pid, "支援被动")),
    };
  };

  const main = buildIdentityBlock(idObj);
  const teammates = (opts.extraIdentityIds ?? [])
    .filter((tid) => tid !== idObj.id)
    .map((tid) => core.identities.find((i) => i.id === tid))
    .filter((x): x is (typeof core.identities)[number] => Boolean(x))
    .map(buildIdentityBlock);

  const describeBuff = (bid: string) => {
    const bDef = core.buffs[bid];
    const kw = text.keywordInfo(bid);
    return {
      name: stripRichTags(kw.name ?? bid),
      desc: stripRichTags(kw.desc ?? kw.buffDesc ?? ""),
      maxStack: (bDef as { maxStack?: number } | undefined)?.maxStack,
      maxTurn: bDef?.maxTurn,
      buffClass: bDef?.buffClass,
      abilities: bDef?.list ?? [],
    };
  };
  // Follow keywords mentioned inside keyword descriptions (e.g. weapon → its own status), 3 levels deep.
  for (let depth = 0; depth < 3; depth++) {
    const before = referencedBuffIds.size;
    for (const bid of [...referencedBuffIds]) {
      const kw = text.keywordInfo(bid);
      scanText(kw.desc ?? kw.buffDesc);
    }
    if (referencedBuffIds.size === before) break;
  }
  const referencedBuffDefinitions: Record<string, unknown> = {};
  for (const bid of referencedBuffIds) referencedBuffDefinitions[bid] = describeBuff(bid);
  const extraBuffDefinitions: Record<string, unknown> = {};
  for (const bid of opts.extraBuffIds ?? []) extraBuffDefinitions[bid] = describeBuff(bid);

  const sinnerEgoPassives = (core.egos ?? [])
    .filter((e) => e.characterId === idObj.characterId)
    .flatMap((e) => {
      const egoName = stripRichTags((text.get("egos", e.id).value as NamedText | undefined)?.name ?? String(e.id));
      return e.passiveIds.map((pid) => {
        const pv = text.get("passives", pid).value as NamedText | undefined;
        return { egoType: e.egoType, egoName, passiveName: stripRichTags(pv?.name ?? String(pid)), desc: stripRichTags(pv?.desc ?? "") };
      });
    });

  const dossier = {
    mainIdentity: {
      ...main,
      level: preset.actor.level ?? 65,
      targetDefenseLevel: ((preset.scenario as { target?: { defenseLevel?: number } } | undefined)?.target?.defenseLevel) ?? (preset.actor.level ?? 65),
      scheduleEntryIds: preset.skillGroups.base.map((e) => ({ entryId: e.entryId, skillId: e.skillId, usesPer6SkillDeck: e.usesPerCycle })),
      counterEntryHint: idObj.defenseSkillIds.some((d) => core.skills[String(d)]?.attrs.defType === "COUNTER")
        ? "schedule 中可使用 \"cnt\" 表示用反击替换一技能出招"
        : undefined,
    },
    teammates,
    currentExternalBuffs: readExternalBuffs(preset.actor.externalBuffs).filter((b) => b.enabled),
    referencedBuffDefinitions,
    extraBuffDefinitions,
    availableSameSinnerEgoPassives: sinnerEgoPassives,
  };

  return JSON.stringify(dossier, null, 2);
}

export interface LlmAdvisorPlan {
  title?: string;
  externalBuffs?: Partial<ExternalBuff>[];
  schedule?: string[];
  excelCases?: Partial<SkillCaseRow>[];
}

export function extractLlmPlanFromResponse(text: string): {
  explanation: string;
  plan: LlmAdvisorPlan | null;
  evaluatedCases: { row: SkillCaseRow; floatDmg: number; flooredDmg: number; formula: string }[];
  totalWheelFloat: number;
  totalWheelFloored: number;
} {
  const jsonMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  let plan: LlmAdvisorPlan | null = null;
  if (jsonMatch?.[1]) {
    try {
      plan = JSON.parse(jsonMatch[1].trim()) as LlmAdvisorPlan;
    } catch {
      plan = null;
    }
  }
  const explanation = jsonMatch ? text.replace(jsonMatch[0], "").trim() : text.trim();
  const evaluatedCases: { row: SkillCaseRow; floatDmg: number; flooredDmg: number; formula: string }[] = [];
  let totalWheelFloat = 0;
  let totalWheelFloored = 0;

  if (plan?.excelCases && Array.isArray(plan.excelCases)) {
    plan.excelCases.forEach((c, idx) => {
      const row: SkillCaseRow = {
        id: `llm-case-${idx}`,
        slotLabel: String(c.slotLabel ?? `S${idx + 1}`),
        caseName: String(c.caseName ?? "推荐情况"),
        basePower: Number(c.basePower ?? 4),
        coinScale: Number(c.coinScale ?? 6),
        operator: c.operator === "SUB" ? "SUB" : "ADD",
        coinCount: Math.max(1, Number(c.coinCount ?? 2)),
        rerollCount: Math.max(0, Number(c.rerollCount ?? 0)),
        levelDelta: Number(c.levelDelta ?? 0),
        resistOffset: Number(c.resistOffset ?? 0),
        isCrit: c.isCrit === true,
        dmgBonusPct: Number(c.dmgBonusPct ?? 0),
        tailDmgBonusPct: c.tailDmgBonusPct != null ? Number(c.tailDmgBonusPct) : null,
        rerollExtraRatioPct: Number(c.rerollExtraRatioPct ?? 0),
        weight: typeof c.weight === "number" ? c.weight : 1,
      };
      const ev = evaluateSkillCase(row);
      evaluatedCases.push({
        row,
        floatDmg: ev.floatDamage,
        flooredDmg: ev.flooredDamage,
        formula: ev.formulaText,
      });
      totalWheelFloat += ev.floatDamage * row.weight;
      totalWheelFloored += ev.flooredDamage * row.weight;
    });
  }

  return {
    explanation,
    plan,
    evaluatedCases,
    totalWheelFloat: Math.round(totalWheelFloat * 100) / 100,
    totalWheelFloored: Math.round(totalWheelFloored * 100) / 100,
  };
}

/** Call the configured LLM provider (OpenAI / Gemini / Claude). */
export async function callLlmAdvisor({
  config,
  systemPrompt,
  userPrompt,
  dossierJson,
}: {
  config: LlmConfig;
  systemPrompt: string;
  userPrompt: string;
  dossierJson: string;
}): Promise<string> {
  const fullUserContent = `${userPrompt.trim() ? `【用户补充要求】\n${userPrompt.trim()}\n\n` : ""}【当前人格完整解包元数据 (JSON)】\n\`\`\`json\n${dossierJson}\n\`\`\``;
  const base = config.baseUrl.replace(/\/+$/, "");

  if (config.provider === "openai") {
    const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        temperature: clampTemperature(config.provider, config.temperature),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: fullUserContent },
        ],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`OpenAI 接口返回 HTTP ${res.status}: ${errText.slice(0, 240)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string; reasoning_content?: string } }[] };
    const msg = data.choices?.[0]?.message;
    const content = msg?.content ?? "";
    if (!content) throw new Error("接口返回内容为空");
    return content;
  }

  if (config.provider === "gemini") {
    const modelPath = config.model.startsWith("models/") ? config.model : `models/${config.model}`;
    const url = `${base}/v1beta/${modelPath}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: fullUserContent }] }],
        generationConfig: { temperature: clampTemperature(config.provider, config.temperature) },
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Gemini 接口返回 HTTP ${res.status}: ${errText.slice(0, 240)}`);
    }
    const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    if (!text) throw new Error("Gemini 接口返回内容为空");
    return text;
  }

  // Claude (/v1/messages)
  const url = base.endsWith("/messages") ? base : `${base.endsWith("/v1") ? base : `${base}/v1`}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 4096,
      temperature: clampTemperature(config.provider, config.temperature),
      system: systemPrompt,
      messages: [{ role: "user", content: fullUserContent }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Claude 接口返回 HTTP ${res.status}: ${errText.slice(0, 240)}`);
  }
  const data = (await res.json()) as { content?: { type?: string; text?: string }[] };
  const text = (data.content ?? []).map((c) => c.text ?? "").join("");
  if (!text) throw new Error("Claude 接口返回内容为空");
  return text;
}

export function convertPlanBuffs(rawBuffs: Partial<ExternalBuff>[] | undefined): ExternalBuff[] {
  if (!Array.isArray(rawBuffs)) return [];
  return rawBuffs.map((b) =>
    newExternalBuff({
      name: String(b.name ?? "LLM 推荐加成"),
      source: b.source === "support" || b.source === "team" || b.source === "ego" ? b.source : "team",
      offenseLevel: Number(b.offenseLevel ?? 0),
      basePower: Number(b.basePower ?? 0),
      coinPower: Number(b.coinPower ?? 0),
      finalPower: Number(b.finalPower ?? 0),
      dmgPct: Number(b.dmgPct ?? 0),
      takeDmgPct: Number(b.takeDmgPct ?? 0),
      onlyConsumesCharge: b.onlyConsumesCharge === true,
      slot: typeof b.slot === "string" ? b.slot : null,
      sin: (typeof b.sin === "string" ? b.sin : null) as ExternalBuff["sin"],
      atk: (typeof b.atk === "string" ? b.atk : null) as ExternalBuff["atk"],
    }),
  );
}
