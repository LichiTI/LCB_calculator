import { useMemo, useState } from "react";
import type { CoreData, NamedText, TextResolver } from "../data/game-data";
import type { Preset } from "../config/preset-types";
import type { ExternalBuff } from "../config/external-buffs";
import {
  buildIdentityDossier,
  callLlmAdvisor,
  convertPlanBuffs,
  DEFAULT_SYSTEM_PROMPT,
  LLM_SCENARIOS,
  composeUserPrompt,
  type LlmScenario,
  extractLlmPlanFromResponse,
  loadLlmConfig,
  PROVIDER_DEFAULTS,
  saveLlmConfig,
  type LlmConfig,
  type LlmProvider,
} from "../engine/llm-advisor";
import type { SkillCaseRow } from "./QuickSkillSheet";

export function LlmAdvisorSection({
  core,
  text,
  preset,
  onApplyPlan,
}: {
  core: CoreData;
  text: TextResolver;
  preset: Preset;
  onApplyPlan: (patch: {
    externalBuffs?: ExternalBuff[];
    schedule?: string[];
    excelCases?: SkillCaseRow[];
    bonusTier?: "none" | "full";
  }) => void;
}) {
  const [scenarioId, setScenarioId] = useState<LlmScenario["id"]>(() => {
    const v = localStorage.getItem("lcalc.llmScenario");
    return LLM_SCENARIOS.some((x) => x.id === v) ? (v as LlmScenario["id"]) : "full12";
  });
  const scenario = LLM_SCENARIOS.find((x) => x.id === scenarioId) ?? LLM_SCENARIOS[0]!;
  const chooseScenario = (id: LlmScenario["id"]) => {
    setScenarioId(id);
    localStorage.setItem("lcalc.llmScenario", id);
  };
  const [cfg, setCfg] = useState<LlmConfig>(() => loadLlmConfig());
  const [showCfg, setShowCfg] = useState(() => !loadLlmConfig().apiKey);
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [userPrompt, setUserPrompt] = useState(
    "请分析该人格的启动机制与强化形态、守备/反击是否值得替换一技能，并结合我附带的队友与状态数据，给出最佳出招顺序与各技能分情况轮伤算式。",
  );
  const [extraIdentityIds, setExtraIdentityIds] = useState<number[]>([]);
  const [extraBuffIds, setExtraBuffIds] = useState<string[]>([]);
  const [idQuery, setIdQuery] = useState("");
  const [buffQuery, setBuffQuery] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawResponse, setRawResponse] = useState("");
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [pastingManual, setPastingManual] = useState(false);

  const dossierJson = useMemo(
    () => buildIdentityDossier(core, text, preset, { extraIdentityIds, extraBuffIds }),
    [core, text, preset, extraIdentityIds, extraBuffIds],
  );

  const identityLabel = (id: number) => {
    const v = text.get("personalities", id).value as NamedText | undefined;
    const title = (v?.title ?? "").replace(/\n/g, " ").trim();
    return `${title ? `${title} ` : ""}${v?.name ?? id}`;
  };
  const buffLabel = (bid: string) => text.keywordInfo(bid).name ?? bid;

  const idMatches = useMemo(() => {
    const q = idQuery.trim().toLowerCase();
    if (!q) return [];
    return core.identities
      .filter((i) => i.id !== preset.actor.identityId && !extraIdentityIds.includes(i.id))
      .filter((i) => String(i.id).includes(q) || identityLabel(i.id).toLowerCase().includes(q))
      .slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idQuery, core.identities, preset.actor.identityId, extraIdentityIds, text]);

  const buffMatches = useMemo(() => {
    const q = buffQuery.trim().toLowerCase();
    if (!q) return [];
    return Object.keys(core.buffs)
      .filter((bid) => !extraBuffIds.includes(bid))
      .filter((bid) => bid.toLowerCase().includes(q) || buffLabel(bid).toLowerCase().includes(q))
      .slice(0, 10);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffQuery, core.buffs, extraBuffIds, text]);
  const parsed = useMemo(() => (rawResponse.trim() ? extractLlmPlanFromResponse(rawResponse) : null), [rawResponse]);

  const updateCfg = (patch: Partial<LlmConfig>) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    saveLlmConfig(next);
  };

  const changeProvider = (p: LlmProvider) => {
    const def = PROVIDER_DEFAULTS[p];
    updateCfg({
      provider: p,
      baseUrl: def.baseUrl,
      model: def.modelPlaceholder.split("/")[0]!.trim(),
    });
  };

  const runAdvisor = async () => {
    if (!cfg.apiKey.trim()) {
      setShowCfg(true);
      setError("请先在下方填写 API Key（或者点击「复制完整提示词+元数据」去网页版 AI 提问后再粘贴结果）");
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const reply = await callLlmAdvisor({
        config: cfg,
        systemPrompt,
        userPrompt: composeUserPrompt(scenario, userPrompt),
        dossierJson,
      });
      setRawResponse(reply);
      const res = extractLlmPlanFromResponse(reply);
      if (res.plan) {
        onApplyPlan({
          externalBuffs: res.plan.externalBuffs ? convertPlanBuffs(res.plan.externalBuffs) : undefined,
          schedule: res.plan.schedule,
          excelCases: res.evaluatedCases.length > 0 ? res.evaluatedCases.map((c) => c.row) : undefined,
          bonusTier: scenario.bonusTier ?? undefined,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const copyFullPromptForWeb = async () => {
    const full = `${systemPrompt}\n\n---\n【用户补充要求】\n${composeUserPrompt(scenario, userPrompt)}\n\n【当前人格完整解包元数据 (JSON)】\n\`\`\`json\n${dossierJson}\n\`\`\``;
    try {
      await navigator.clipboard.writeText(full);
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 1800);
    } catch {
      setCopiedPrompt(false);
    }
  };

  return (
    <div style={{ marginTop: 10 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div className="small muted" style={{ flex: 1, minWidth: 260 }}>
          自动将该人格的**全量技能、守备/反击、变体大招、硬币脚本、战斗被动、特殊 Buff 定义与本罪人 E.G.O 被动**打包喂给 LLM，
          由 LLM 推演最佳排轴与分情况乘区，再交由本地计算器精确验算并自动填入上方 Excel 工作表与排轴器。
        </div>
        <div className="row-actions">
          <button type="button" onClick={() => setShowCfg((v) => !v)}>
            {showCfg ? "收起接口设置" : `⚙ 接口设置 (${cfg.provider.toUpperCase()} · ${cfg.model})`}
          </button>
          <button
            type="button"
            onClick={copyFullPromptForWeb}
            title="如果你不想填 API Key，可以一键复制包含系统提示词+该人格完整元数据的文本，粘贴到网页版 ChatGPT/Claude/DeepSeek/Gemini，再把它的回复粘贴回来"
          >
            {copiedPrompt ? "✓ 已复制完整提示词+元数据" : "📋 复制完整提示词 (网页版 AI 免 Key 用)"}
          </button>
          <button type="button" onClick={() => setPastingManual((v) => !v)}>
            {pastingManual ? "收起手动粘贴框" : "📥 粘贴外部 AI 回复"}
          </button>
          <button type="button" className="primary" onClick={runAdvisor} disabled={running}>
            {running ? "🤖 LLM 正在推演最佳排轴与乘区…" : "🚀 开始 LLM 智能精算"}
          </button>
        </div>
      </div>

      {/* API Configuration (OpenAI / Gemini / Claude Big Three) */}
      {showCfg && (
        <div className="support-picker" style={{ marginBottom: 12 }}>
          <div className="row" style={{ marginBottom: 8, alignItems: "center", justifyContent: "space-between" }}>
            <strong className="small">LLM 接口配置（保存在本地浏览器 localStorage，支持御三家标准格式）</strong>
            <div style={{ display: "flex", gap: 6 }}>
              {(["openai", "gemini", "claude"] as LlmProvider[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`chip ${cfg.provider === p ? "on" : ""}`}
                  onClick={() => changeProvider(p)}
                >
                  {p === "openai" ? "OpenAI 兼容" : p === "gemini" ? "Google Gemini" : "Anthropic Claude"}
                </button>
              ))}
            </div>
          </div>
          <div className="row" style={{ gap: "10px 14px" }}>
            <label className="field" style={{ flex: 2, minWidth: 220 }}>
              <span>Base URL（接口地址）</span>
              <input
                value={cfg.baseUrl}
                placeholder={PROVIDER_DEFAULTS[cfg.provider].baseUrl}
                onChange={(e) => updateCfg({ baseUrl: e.target.value })}
              />
            </label>
            <label className="field" style={{ flex: 2, minWidth: 220 }}>
              <span>API Key</span>
              <input
                type="password"
                value={cfg.apiKey}
                placeholder="sk-... / AIza..."
                onChange={(e) => updateCfg({ apiKey: e.target.value })}
              />
            </label>
            <label className="field" style={{ flex: 1, minWidth: 180 }}>
              <span>模型名称 (Model)</span>
              <input
                value={cfg.model}
                placeholder={PROVIDER_DEFAULTS[cfg.provider].modelPlaceholder}
                onChange={(e) => updateCfg({ model: e.target.value })}
              />
            </label>
            <label className="field" style={{ width: 90 }}>
              <span>温度 (Temp)</span>
              <input
                type="number"
                step={0.1}
                min={0}
                max={cfg.provider === "claude" ? 1 : 2}
                value={cfg.temperature}
                onChange={(e) => updateCfg({ temperature: Number(e.target.value) || 0 })}
              />
            </label>
          </div>
        </div>
      )}

      {/* Attach teammates / extra status definitions */}
      <div className="support-picker" style={{ marginBottom: 10 }}>
        <div className="small" style={{ marginBottom: 6 }}>
          <b>附带给 AI 的额外数据</b>
          <span className="muted">
            （AI 只知道你发给它的数据。提到哪位队友或哪个状态，就在这里把它加上，队友会附带全部技能、被动与引用到的状态定义）
          </span>
        </div>
        <div className="row" style={{ gap: "10px 14px", alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <input
              style={{ width: "100%" }}
              placeholder="搜索队友人格（名称 / 称号 / ID）"
              value={idQuery}
              onChange={(e) => setIdQuery(e.target.value)}
            />
            {idMatches.length > 0 && (
              <div className="chips" style={{ marginTop: 6 }}>
                {idMatches.map((i) => (
                  <button
                    key={i.id}
                    type="button"
                    className="chip"
                    onClick={() => {
                      setExtraIdentityIds((p) => [...p, i.id]);
                      setIdQuery("");
                    }}
                  >
                    + {identityLabel(i.id)} <span className="muted">#{i.id}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="chips" style={{ marginTop: 6 }}>
              {extraIdentityIds.length === 0 && <span className="muted small">未附带队友</span>}
              {extraIdentityIds.map((id) => (
                <button key={id} type="button" className="chip on" onClick={() => setExtraIdentityIds((p) => p.filter((x) => x !== id))} title="点击移除">
                  {identityLabel(id)} ×
                </button>
              ))}
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 260 }}>
            <input
              style={{ width: "100%" }}
              placeholder="搜索状态 / Buff（中文名或内部 ID）"
              value={buffQuery}
              onChange={(e) => setBuffQuery(e.target.value)}
            />
            {buffMatches.length > 0 && (
              <div className="chips" style={{ marginTop: 6 }}>
                {buffMatches.map((bid) => (
                  <button
                    key={bid}
                    type="button"
                    className="chip"
                    onClick={() => {
                      setExtraBuffIds((p) => [...p, bid]);
                      setBuffQuery("");
                    }}
                  >
                    + {buffLabel(bid)} <span className="muted">{bid}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="chips" style={{ marginTop: 6 }}>
              {extraBuffIds.length === 0 && <span className="muted small">未附带额外状态</span>}
              {extraBuffIds.map((bid) => (
                <button key={bid} type="button" className="chip on" onClick={() => setExtraBuffIds((p) => p.filter((x) => x !== bid))} title="点击移除">
                  {buffLabel(bid)} ×
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Scenario presets */}
      <div style={{ marginBottom: 10 }}>
        <div className="small" style={{ marginBottom: 6 }}>
          <b>计算场景</b>
          <span className="muted">（决定回合数和开局资源，会写在提问最前面；回填验算时开局 / 全程场景按真实叠层模拟，稳态场景按吃满加成模拟）</span>
        </div>
        <div className="chips">
          {LLM_SCENARIOS.map((x) => (
            <button key={x.id} type="button" className={`chip${x.id === scenarioId ? " on" : ""}`} onClick={() => chooseScenario(x.id)} title={x.prompt || x.hint}>
              {x.label} <span className="muted">· {x.hint}</span>
            </button>
          ))}
        </div>
        {scenario.prompt && <p className="small muted" style={{ margin: "6px 0 0" }}>{scenario.prompt}</p>}
      </div>

      {/* User Custom Prompt Input */}
      <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
        <label className="field">
          <span>
            <b>你的补充要求 / 提问提示词</b>（可直接告诉 AI 你的配队环境、想带什么队友拐/E.G.O、单槽还是双槽、是否把一技能换反击等）
          </span>
          <textarea
            rows={2}
            style={{ width: "100%", resize: "vertical" }}
            value={userPrompt}
            onChange={(e) => setUserPrompt(e.target.value)}
            placeholder="例如：一技能全换反击时，结合我附带的队友数据，按 12 回合排轴并折算 6 技能一轮，给出最佳顺序和分情况轮伤"
          />
        </label>

        <details className="disclosure" style={{ marginTop: 0, paddingTop: 6 }}>
          <summary className="small muted">
            <span>查看 / 自定义内置「精算师系统提示词 (System Prompt)」与自动打包的人格元数据 ({Math.round(dossierJson.length / 1024)} KB)</span>
          </summary>
          <div className="disclosure-body" style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="small muted">系统提示词（教 LLM 如何理解边狱公司第一/第二乘区、反击变身、12T 同调折算与分段易损）：</span>
              <button type="button" className="link small" onClick={() => setSystemPrompt(DEFAULT_SYSTEM_PROMPT)}>
                恢复默认内置提示词
              </button>
            </div>
            <textarea
              rows={6}
              style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: 12 }}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
            <div className="small muted">自动提取的当前人格元数据预览（将随请求自动发送给 LLM）：</div>
            <textarea
              rows={5}
              readOnly
              style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: 11, opacity: 0.85 }}
              value={dossierJson}
            />
          </div>
        </details>
      </div>

      {pastingManual && (
        <div className="support-picker" style={{ marginBottom: 10 }}>
          <div className="small muted" style={{ marginBottom: 6 }}>
            把网页版 AI 回复的完整内容（含 ```json 代码块）粘贴在下方，计算器会自动解析并算出伤害：
          </div>
          <textarea
            rows={5}
            style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: 12 }}
            value={rawResponse}
            onChange={(e) => setRawResponse(e.target.value)}
            placeholder="在此粘贴 AI 的回复内容…"
          />
        </div>
      )}

      {error && (
        <div className="callout err" style={{ marginBottom: 10 }}>
          <div className="callout-body">
            <b>LLM 请求提示</b>
            <div>{error}</div>
          </div>
        </div>
      )}

      {/* LLM Output & Auto-Verified Calculator Results */}
      {parsed && (
        <div className="support-picker" style={{ marginTop: 10 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div>
              <strong style={{ color: "var(--p-300)", fontSize: 15 }}>
                🤖 {parsed.plan?.title ?? "LLM 最佳排轴与轮伤精算报告"}
              </strong>
              {parsed.evaluatedCases.length > 0 && (
                <span className="tag gold" style={{ marginLeft: 8 }}>
                  计算器实算轮伤：{parsed.totalWheelFloat.toFixed(2)}（逐币取整 {parsed.totalWheelFloored}）
                </span>
              )}
            </div>
            {parsed.plan && (
              <button
                type="button"
                className="primary"
                onClick={() =>
                  onApplyPlan({
                    externalBuffs: parsed.plan?.externalBuffs ? convertPlanBuffs(parsed.plan.externalBuffs) : undefined,
                    schedule: parsed.plan?.schedule,
                    excelCases: parsed.evaluatedCases.length > 0 ? parsed.evaluatedCases.map((c) => c.row) : undefined,
                  })
                }
              >
                ⚡ 一键同步到上方 Excel 工作表 & 排轴器
              </button>
            )}
          </div>

          {parsed.evaluatedCases.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div className="small muted" style={{ marginBottom: 6 }}>
                本地计算器已对 LLM 推演的各技能情况进行精确验算：
              </div>
              <div className="community-lines">
                {parsed.evaluatedCases.map((c, i) => (
                  <div key={i} className="community-skill">
                    <div className="line1">
                      <b>
                        {c.row.slotLabel} · {c.row.caseName}
                      </b>
                      <code>{c.formula}</code>
                      <span className="tag">取整 {c.flooredDmg}</span>
                      <span className="muted small">
                        × 权重 {c.row.weight} = <b>{(c.floatDmg * c.row.weight).toFixed(2)}</b>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="rotation-summary" style={{ marginTop: 8 }}>
                <div>
                  <span className="muted">轮伤汇总：</span>
                  <code className="summary-line">
                    {parsed.evaluatedCases
                      .filter((c) => c.row.weight > 0)
                      .map((c) => `${c.floatDmg.toFixed(2)}${c.row.weight === 1 ? "" : `*${c.row.weight}`}`)
                      .join(" + ")}{" "}
                    = <b>{parsed.totalWheelFloat.toFixed(2)}</b>
                  </code>
                </div>
              </div>
            </div>
          )}

          {parsed.explanation && (
            <div
              style={{
                whiteSpace: "pre-wrap",
                lineHeight: 1.7,
                fontSize: 13,
                color: "var(--text-2)",
                padding: "10px 12px",
                background: "var(--surface)",
                borderRadius: "var(--radius)",
              }}
            >
              {parsed.explanation}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
