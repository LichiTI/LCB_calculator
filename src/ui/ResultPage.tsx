import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { CoreData, NamedText, SkillText, TextResolver } from "../data/game-data";
import type { Preset } from "../config/preset-types";
import { hasErrors, validatePreset, type GameDataIndex } from "../config/preset";
import { PresetStore } from "../config/preset-store";
import { baseEntryFor, createPresetForIdentity, perCoinDefaults } from "../config/preset-factory";
import { amountSemantics, DOT_IDS } from "../config/status-terms";
import { simulateScenario, type CoinMode, type SimEvent } from "../engine/simulator";
import { optimizeSchedule, type OptimizeResult } from "../engine/optimizer";
import { BONUS_TIER_LABEL, inferRequiredStatusesForIdentity, type BonusTier } from "../engine/bonus-tier";
import type { AppSettings } from "../config/app-settings";
import { ExternalBuffsPanel, EgoDamagePanel } from "./ExternalBuffsPanel";
import { ManualScheduleEditor, readSchedule } from "./ScheduleEditor";
import { RotationDamageTable } from "./RotationDamageTable";
import { QuickSkillSheet, type SkillCaseRow } from "./QuickSkillSheet";
import { LlmAdvisorSection } from "./LlmAdvisorPanel";
import { IdealRotationSummary } from "./IdealRotationSummary";
import { SIN_LABEL } from "./labels";

const COMMON_STATUS_IDS = [
  ...DOT_IDS,
  "Breath",
  "Charge",
  "Enhancement",
  "Reduction",
  "AttackDmgUp",
  "AttackDmgDown",
  "Protection",
  "Vulnerable",
  "AttackUp",
  "AttackDown",
  "DefenseUp",
  "DefenseDown",
  "PlusCoinValueUp",
  "PlusCoinValueDown",
  "MinusCoinValueUp",
  "MinusCoinValueDown",
  "Paralysis",
  "SlashDamageUp",
  "PenetrateDamageUp",
  "HitDamageUp",
  "SlashTakeDamageUp",
  "PenetrateTakeDamageUp",
  "HitTakeDamageUp",
] as const;

type InitStatusItem = { id: string; potency: number; count: number };

function InitialStatusEditor({
  title,
  list,
  onChange,
  core,
  text,
}: {
  title: string;
  list: InitStatusItem[];
  onChange: (next: InitStatusItem[]) => void;
  core: CoreData;
  text: TextResolver;
}) {
  const [adding, setAdding] = useState("");
  return (
    <div className="status-list">
      <div className="field">
        <span>{title}</span>
      </div>
      {list.map((item, idx) => {
        const sem = amountSemantics(core.buffs[item.id]?.buffClass);
        return (
          <div key={`${item.id}-${idx}`} className="dot-row">
            <span className="tag" title={item.id}>
              {text.label(item.id) ?? item.id}
            </span>
            {sem !== "countOnlyFromStack" && (
              <label title="强度">
                强
                <input
                  type="number"
                  min={0}
                  value={item.potency}
                  onChange={(e) => {
                    const v = Math.max(0, Math.trunc(Number(e.target.value) || 0));
                    onChange(list.map((x, k) => (k === idx ? { ...x, potency: v } : x)));
                  }}
                />
              </label>
            )}
            <label title="层数">
              层
              <input
                type="number"
                min={0}
                value={sem === "countOnlyFromStack" ? item.potency || item.count : item.count}
                onChange={(e) => {
                  const v = Math.max(0, Math.trunc(Number(e.target.value) || 0));
                  onChange(
                    list.map((x, k) =>
                      k === idx ? (sem === "countOnlyFromStack" ? { ...x, potency: v, count: v } : { ...x, count: v }) : x,
                    ),
                  );
                }}
              />
            </label>
            <button className="link icon" onClick={() => onChange(list.filter((_, k) => k !== idx))} aria-label="移除状态">
              ×
            </button>
          </div>
        );
      })}
      <select
        className="full"
        value={adding}
        onChange={(e) => {
          const id = e.target.value;
          if (id) {
            onChange([...list, { id, potency: 1, count: 1 }]);
          }
          setAdding("");
        }}
      >
        <option value="">+ 添加初始状态…</option>
        {COMMON_STATUS_IDS.map((id) => (
          <option key={id} value={id}>
            {text.label(id) ?? id} ({id})
          </option>
        ))}
      </select>
    </div>
  );
}

const PHYS_KEYS = [
  { key: "slash", label: "斩击" },
  { key: "pierce", label: "穿刺" },
  { key: "blunt", label: "打击" },
] as const;

const SIN_KEYS = [
  { key: "wrath", label: "暴怒", color: SIN_LABEL.CRIMSON!.color },
  { key: "lust", label: "色欲", color: SIN_LABEL.SCARLET!.color },
  { key: "sloth", label: "怠惰", color: SIN_LABEL.AMBER!.color },
  { key: "gluttony", label: "暴食", color: SIN_LABEL.SHAMROCK!.color },
  { key: "gloom", label: "忧郁", color: SIN_LABEL.AZURE!.color },
  { key: "pride", label: "傲慢", color: SIN_LABEL.INDIGO!.color },
  { key: "envy", label: "嫉妒", color: SIN_LABEL.VIOLET!.color },
] as const;

const EVENT_KIND_LABEL: Record<SimEvent["kind"], string> = {
  useSkill: "释放",
  coin: "硬币",
  extraDamage: "追伤",
  dot: "DOT",
  status: "状态",
  roundEnd: "回合末",
  followUp: "追击",
  note: "备注",
};

function skillName(text: TextResolver, core: CoreData, id: number | null | undefined): string {
  if (id == null) return "—";
  const s = core.skills[String(id)];
  const t = text.get("skills", id).value as SkillText | undefined;
  return `${s?.slot ?? ""} ${t?.name ?? id}`.trim();
}

export function ResultPage({
  core,
  text,
  index,
  store,
  selectedIdentityId,
  preset,
  setPreset,
  settings,
  onGoEditor,
  onGoIdentity,
}: {
  core: CoreData;
  text: TextResolver;
  index: GameDataIndex;
  store: PresetStore;
  selectedIdentityId: number | null;
  preset: Preset | null;
  setPreset: Dispatch<SetStateAction<Preset | null>>;
  settings?: AppSettings;
  onGoEditor?: () => void;
  onGoIdentity?: () => void;
}) {
  const simple = (settings?.uiMode ?? "simple") === "simple";
  const presetDefaults = settings
    ? {
        level: settings.defaultLevel,
        targetDefense: settings.defaultTargetDefense,
        sp: settings.defaultSp,
        simMode: settings.defaultSimMode,
        bonusTier: settings.defaultBonusTier,
        battlePassives: settings.defaultBattlePassives,
      }
    : {};
  const savedList = store.list();

  // Auto-initialize preset if none is loaded yet so opening Result tab directly works immediately
  useEffect(() => {
    if (preset) return;
    if (savedList.length > 0) {
      const loaded = store.get(savedList[0]!.presetId).preset;
      if (loaded) {
        setPreset(loaded);
        return;
      }
    }
    const idObj =
      (selectedIdentityId != null ? core.identities.find((i) => i.id === selectedIdentityId) : null) ??
      core.identities[0] ??
      null;
    if (!idObj) return;
    const v = text.get("personalities", idObj.id).value as NamedText | undefined;
    const name = v?.name ?? String(idObj.id);
    const title = (v?.title ?? "").replace(/\n/g, " ").trim();
    setPreset(createPresetForIdentity(idObj, core.skills, core.manifest.dataVersion, `${title ? `${title} ` : ""}${name} 四破配置`, presetDefaults));
  }, [preset, savedList, selectedIdentityId, core, text, store, setPreset]);

  const [coinMode, setCoinMode] = useState<CoinMode>(settings?.defaultCoinMode ?? "allHeads");
  const [seed, setSeed] = useState<number>(20261030);
  const [samples, setSamples] = useState<number>(500);
  const [logFilter, setLogFilter] = useState<"all" | "coin" | "dot" | "status" | "round">("all");
  const [optSlots, setOptSlots] = useState<1 | 2>(settings?.defaultSlots ?? 1);
  const [optTurns, setOptTurns] = useState<6 | 12>(6);
  const [optResult, setOptResult] = useState<OptimizeResult | null>(null);
  const [optRunning, setOptRunning] = useState(false);
  const [optMode, setOptMode] = useState<"math" | "llm">("llm");
  const [llmInjectedRows, setLlmInjectedRows] = useState<SkillCaseRow[] | null>(null);

  const bonusTier: BonusTier = (() => {
    const t = (preset?.simulation as Record<string, unknown> | undefined)?.bonusTier;
    return t === "power" || t === "full" ? t : "none";
  })();
  const setBonusTier = (t: BonusTier) => {
    if (!preset) return;
    const sim = { ...preset.simulation } as Preset["simulation"];
    if (t === "none") delete (sim as Record<string, unknown>).bonusTier;
    else (sim as Record<string, unknown>).bonusTier = t;
    setPreset({ ...preset, simulation: sim });
    setOptResult(null);
  };

  const runOptimizer = () => {
    if (!preset) return;
    setOptRunning(true);
    setOptResult(null);
    setTimeout(() => {
      const r = optimizeSchedule({ identities: core.identities, skills: core.skills, buffs: core.buffs }, preset, {
        slots: optSlots,
        turns: optTurns,
        coinMode: coinMode === "monteCarlo" ? "allHeads" : coinMode,
      });
      setOptResult(r);
      setOptRunning(false);
    }, 20);
  };

  const applyBestSchedule = () => {
    if (!preset || !optResult?.best) return;
    const schedule = optResult.best.turns.flatMap((ids, t) => ids.map((entryId, k) => ({ turn: t + 1, order: k + 1, entryId })));
    setPreset({ ...preset, simulation: { ...preset.simulation, mode: "orderedCycle", turnCount: optResult.turns, actionSchedule: schedule } });
  };

  const issues = useMemo(() => (preset ? validatePreset(preset, index) : []), [preset, index]);
  const blocked = hasErrors(issues);

  const simResult = useMemo(() => {
    if (!preset || blocked) return null;
    return simulateScenario(
      { identities: core.identities, skills: core.skills, buffs: core.buffs },
      preset,
      { coinMode, seed, samples },
    );
  }, [core, preset, blocked, coinMode, seed, samples]);

  const setTargetField = (patch: Record<string, unknown>) => {
    if (!preset) return;
    const sc = (preset.scenario ?? {}) as Record<string, unknown>;
    const curTarget = (sc.target ?? {}) as Record<string, unknown>;
    setPreset({
      ...preset,
      scenario: {
        ...sc,
        target: { ...curTarget, ...patch },
      },
    });
  };

  const applyAllResistances = (val: number) => {
    setTargetField({
      physicalResistances: { slash: val, pierce: val, blunt: val },
      sinResistances: { wrath: val, lust: val, sloth: val, gluttony: val, gloom: val, pride: val, envy: val },
    });
  };

  const targetObj = (preset?.scenario as { target?: Record<string, unknown> } | undefined)?.target ?? {};
  const physRes = (targetObj.physicalResistances as Record<string, number> | undefined) ?? { slash: 1, pierce: 1, blunt: 1 };
  const sinRes = (targetObj.sinResistances as Record<string, number> | undefined) ?? {
    wrath: 1,
    lust: 1,
    sloth: 1,
    gluttony: 1,
    gloom: 1,
    pride: 1,
    envy: 1,
  };
  const actorInitStatuses = (Array.isArray(preset?.actor.initialStatuses) ? preset!.actor.initialStatuses : []) as InitStatusItem[];
  const targetInitStatuses = (Array.isArray(targetObj.initialStatuses) ? targetObj.initialStatuses : []) as InitStatusItem[];
  const enemyActions = Array.isArray((preset?.scenario as { enemyActions?: unknown } | undefined)?.enemyActions)
    ? (preset!.scenario as { enemyActions: { turn: number; coinCount: number }[] }).enemyActions
    : [];
  const t1EnemyCoins = enemyActions.find((a) => a.turn === 1)?.coinCount ?? 0;

  const filteredEvents = useMemo(() => {
    if (!simResult) return [];
    return simResult.events.filter((ev) => {
      if (logFilter === "all") return true;
      if (logFilter === "coin") return ev.kind === "coin" || ev.kind === "extraDamage" || ev.kind === "useSkill";
      if (logFilter === "dot") return ev.kind === "dot";
      if (logFilter === "status") return ev.kind === "status";
      if (logFilter === "round") return ev.kind === "roundEnd" || ev.kind === "useSkill";
      return true;
    });
  }, [simResult, logFilter]);

  return (
    <div className="editor">
      <div className="page-toolbar">
        <label className="field inline">
          <span>当前预设</span>
          <select
            value={preset?.presetId ?? ""}
            onChange={(e) => {
              const r = store.get(e.target.value);
              if (r.preset) setPreset(r.preset);
            }}
          >
            {preset && !savedList.some((s) => s.presetId === preset.presetId) && (
              <option value={preset.presetId}>{preset.name}（当前内存中）</option>
            )}
            {savedList.map((p) => (
              <option key={p.presetId} value={p.presetId}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {selectedIdentityId != null && preset?.actor.identityId !== selectedIdentityId && (
          <button
            onClick={() => {
              const idObj = core.identities.find((i) => i.id === selectedIdentityId);
              if (!idObj) return;
              const v = text.get("personalities", idObj.id).value as NamedText | undefined;
              const name = v?.name ?? String(idObj.id);
              const title = (v?.title ?? "").replace(/\n/g, " ").trim();
              setPreset(
                createPresetForIdentity(idObj, core.skills, core.manifest.dataVersion, `${title ? `${title} ` : ""}${name} 四破配置`, presetDefaults),
              );
            }}
          >
            切换为当前选中人格 (#{selectedIdentityId})
          </button>
        )}
        {onGoEditor && <button onClick={onGoEditor}>← 调整技能组 / 手动修正</button>}
        <span className="grow" />
        {preset && (
          <label className="field inline">
            <span>加成档位</span>
            <select value={bonusTier} onChange={(e) => setBonusTier(e.target.value as BonusTier)}>
              {(Object.keys(BONUS_TIER_LABEL) as BonusTier[]).map((k) => (
                <option key={k} value={k}>
                  {BONUS_TIER_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
        )}
        {preset && !simple && (
          <>
            <label className="field inline">
              <span>计算模式</span>
              <select
                value={preset.simulation.mode}
                onChange={(e) =>
                  setPreset({
                    ...preset,
                    simulation: {
                      ...preset.simulation,
                      mode: e.target.value as Preset["simulation"]["mode"],
                    },
                  })
                }
              >
                <option value="staticCycle">静态轮转对比（每次重置状态）</option>
                <option value="orderedCycle">连续一轮（保留状态，含回合结束）</option>
                <option value="multiTurn">多回合模拟（按行动表）</option>
              </select>
            </label>
            <label className="field inline">
              <span>硬币模式</span>
              <select value={coinMode} onChange={(e) => setCoinMode(e.target.value as CoinMode)}>
                <option value="allHeads">全部正面（场景假设）</option>
                <option value="allTails">全部反面（场景假设）</option>
                <option value="monteCarlo">Monte Carlo 确定性抽样</option>
              </select>
            </label>
            {coinMode === "monteCarlo" && (
              <>
                <label className="field inline">
                  <span>种子</span>
                  <input type="number" value={seed} onChange={(e) => setSeed(Math.trunc(Number(e.target.value) || 0))} />
                </label>
                <label className="field inline">
                  <span>样本数</span>
                  <input
                    type="number"
                    min={1}
                    max={10000}
                    value={samples}
                    onChange={(e) => setSamples(Math.max(1, Math.min(10000, Math.trunc(Number(e.target.value) || 1))))}
                  />
                </label>
              </>
            )}
          </>
        )}
      </div>

      {!preset && (
        <div className="empty card">
          <div className="empty-icon">◈</div>
          <h2>请先选择或创建人格预设</h2>
          <p>在「人格资料」或「技能组配置」中选择一个人格即可开始模拟。</p>
          <div className="actions">
            {onGoIdentity && (
              <button className="primary" onClick={onGoIdentity}>
                前往人格资料
              </button>
            )}
          </div>
        </div>
      )}

      {preset && (
        <div className="result-layout">
          {/* Left column: Scenario & Target configuration */}
          <aside className="panel scenario">
            <h3>场景与目标参数</h3>

            <div className="group">
              <div className="group-title">双方基础与理智</div>
              <div className="grid2">
                <label className="field">
                  <span>人格等级</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={preset.actor.level ?? 60}
                    onChange={(e) =>
                      setPreset({ ...preset, actor: { ...preset.actor, level: Math.max(1, Math.trunc(Number(e.target.value) || 60)) } })
                    }
                  />
                </label>
                <label className="field">
                  <span>目标防御等级</span>
                  <input
                    type="number"
                    min={1}
                    max={150}
                    value={typeof targetObj.defenseLevel === "number" ? targetObj.defenseLevel : (preset.actor.level ?? 60)}
                    onChange={(e) => setTargetField({ defenseLevel: Math.max(0, Math.trunc(Number(e.target.value) || 0)) })}
                  />
                </label>
                <label className="field">
                  <span>初始理智 (SP)</span>
                  <input
                    type="number"
                    min={-45}
                    max={45}
                    value={preset.actor.initialSp ?? 0}
                    onChange={(e) =>
                      setPreset({
                        ...preset,
                        actor: { ...preset.actor, initialSp: Math.max(-45, Math.min(45, Math.trunc(Number(e.target.value) || 0))) },
                      })
                    }
                  />
                </label>
                <label className="field" title="用于结算目标身上的流血（敌方每投掷一枚攻击硬币触发一次流血）">
                  <span>T1 敌方攻击硬币数</span>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    value={t1EnemyCoins}
                    onChange={(e) => {
                      const cnt = Math.max(0, Math.trunc(Number(e.target.value) || 0));
                      const sc = (preset.scenario ?? {}) as Record<string, unknown>;
                      const rest = enemyActions.filter((a) => a.turn !== 1);
                      setPreset({
                        ...preset,
                        scenario: {
                          ...sc,
                          enemyActions: cnt > 0 ? [...rest, { turn: 1, coinCount: cnt }] : rest,
                        },
                      });
                    }}
                  />
                </label>
              </div>
              <div className="chips" style={{ marginTop: 8, marginBottom: 0 }}>
                <span className="muted small" style={{ alignSelf: "center" }}>
                  理智快捷：
                </span>
                {[-45, 0, 20, 45].map((sp) => (
                  <button
                    key={sp}
                    type="button"
                    className={`chip ${(preset.actor.initialSp ?? 0) === sp ? "on" : ""}`}
                    onClick={() => setPreset({ ...preset, actor: { ...preset.actor, initialSp: sp } })}
                  >
                    {sp > 0 ? `+${sp}` : sp}
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, flexWrap: "wrap", gap: 8 }}>
                <label className="field inline">
                  <input
                    type="checkbox"
                    checked={targetObj.hasSp === true}
                    onChange={(e) => setTargetField({ hasSp: e.target.checked })}
                  />
                  <span>目标有理智（沉沦扣 SP 而非 HP）</span>
                </label>
                <label
                  className="field inline"
                  title="呼吸法队的常见场景：呼吸强度 ≥ 20（暴击率 100%）且每枚硬币都按暴击结算，会触发各硬币的暴击额外加伤"
                >
                  <input
                    type="checkbox"
                    checked={preset.actor.forceFullCrit === true}
                    onChange={(e) =>
                      setPreset({ ...preset, actor: { ...preset.actor, forceFullCrit: e.target.checked } })
                    }
                  />
                  <span>按全暴击结算（呼吸法满暴）</span>
                </label>
              </div>
              {!simple && (
              <label className="field full" style={{ marginTop: 10 }}>
                <span>战斗被动策略</span>
                <select
                  value={preset.actor.battlePassives ?? "none"}
                  onChange={(e) =>
                    setPreset({ ...preset, actor: { ...preset.actor, battlePassives: e.target.value as "automatic" | "none" } })
                  }
                >
                  <option value="none">关闭（手动修正补偿）</option>
                  <option value="automatic">开启（检测未建模被动缺口）</option>
                </select>
              </label>
              )}
            </div>

            <div className="group">
              <div className="group-title">
                <span>目标抗性</span>
              </div>
              <div className="chips">
                <button type="button" className="chip" onClick={() => applyAllResistances(1)}>
                  全普通 ×1.0
                </button>
                <button type="button" className="chip" onClick={() => applyAllResistances(2)}>
                  全致命 ×2.0
                </button>
                <button type="button" className="chip" onClick={() => applyAllResistances(1.5)}>
                  全弱点 ×1.5
                </button>
                <button type="button" className="chip" onClick={() => applyAllResistances(0.5)}>
                  全耐性 ×0.5
                </button>
              </div>
              <div className="small muted" style={{ marginBottom: 6 }}>
                物理抗性
              </div>
              <div className="res-grid" style={{ marginBottom: 12 }}>
                {PHYS_KEYS.map(({ key, label }) => (
                  <label key={key} className="field">
                    <span>{label}</span>
                    <input
                      type="number"
                      step={0.1}
                      value={physRes[key] ?? 1}
                      onChange={(e) =>
                        setTargetField({
                          physicalResistances: { ...physRes, [key]: Number(e.target.value) || 0 },
                        })
                      }
                    />
                  </label>
                ))}
              </div>
              <div className="small muted" style={{ marginBottom: 6 }}>
                罪孽抗性
              </div>
              <div className="res-grid">
                {SIN_KEYS.map(({ key, label, color }) => (
                  <label key={key} className="field">
                    <span>
                      <i className="swatch" style={{ background: color }} />
                      {label}
                    </span>
                    <input
                      type="number"
                      step={0.1}
                      value={sinRes[key] ?? 1}
                      onChange={(e) =>
                        setTargetField({
                          sinResistances: { ...sinRes, [key]: Number(e.target.value) || 0 },
                        })
                      }
                    />
                  </label>
                ))}
              </div>
            </div>

            <div className="group">
              <div className="group-title">
                敌方初始 DOT / 自身资源
                {(() => {
                  const inf = inferRequiredStatusesForIdentity(core, preset.actor.identityId);
                  return inf.summaryNotes.length > 0 ? <span className="tag gold" style={{ marginLeft: 6 }}>需要吃满</span> : null;
                })()}
              </div>
              {(() => {
                const inf = inferRequiredStatusesForIdentity(core, preset.actor.identityId);
                const applyInferred = () => {
                  const nextTarget = targetInitStatuses.filter((x) => !(inf.targetStatuses[x.id]));
                  const merged: InitStatusItem[] = [...nextTarget];
                  for (const [id, v] of Object.entries(inf.targetStatuses)) {
                    merged.push({ id, potency: v.potency, count: v.count });
                  }
                  setTargetField({ initialStatuses: merged });
                  const nextActor = actorInitStatuses.filter((x) => !inf.actorStatuses[x.id]);
                  const mergedActor: InitStatusItem[] = [...nextActor];
                  for (const [id, v] of Object.entries(inf.actorStatuses)) {
                    mergedActor.push({ id, potency: v.potency, count: v.count });
                  }
                  setPreset({
                    ...preset,
                    actor: { ...preset.actor, initialStatuses: mergedActor },
                    scenario: { ...(preset.scenario ?? {}), target: { ...targetObj, initialStatuses: merged } },
                  });
                  setOptResult(null);
                };
                return (
                  <>
                    <div className="row" style={{ marginBottom: 10 }}>
                      <div className="field inline" style={{ flex: 1, minWidth: 200 }}>
                        <span className="muted small">
                          {inf.summaryNotes.length > 0
                            ? inf.summaryNotes.join("；")
                            : "当前人格没有依赖敌方状态的条件效果，默认无 DOT 即可"}
                        </span>
                      </div>
                      <button type="button" onClick={applyInferred} disabled={!inf.summaryNotes.length}>
                        一键填入吃满所需
                      </button>
                    </div>
                    <InitialStatusEditor
                      title="目标初始状态（含 DOT 强度 / 层数）"
                      list={targetInitStatuses}
                      onChange={(next) => setTargetField({ initialStatuses: next })}
                      core={core}
                      text={text}
                    />
                    <div style={{ height: 8 }} />
                    <InitialStatusEditor
                      title="自身初始状态（呼吸法 / 充能 / 叠层）"
                      list={actorInitStatuses}
                      onChange={(next) => setPreset({ ...preset, actor: { ...preset.actor, initialStatuses: next } })}
                      core={core}
                      text={text}
                    />
                  </>
                );
              })()}
            </div>

            {(!simple || t1EnemyCoins > 0) && (
            <div className="group">
              <div className="group-title">其他场景参数</div>
              <div className="row">
                <label className="field inline">
                  <input
                    type="checkbox"
                    checked={t1EnemyCoins > 0}
                    onChange={(e) => {
                      const sc = (preset.scenario ?? {}) as Record<string, unknown>;
                      const cur = Array.isArray(sc.enemyActions) ? (sc.enemyActions as { turn: number; coinCount: number }[]) : [];
                      const rest = cur.filter((a) => a.turn !== 1);
                      setPreset({
                        ...preset,
                        scenario: { ...sc, enemyActions: e.target.checked ? [...rest, { turn: 1, coinCount: 1 }] : rest },
                      });
                    }}
                  />
                  <span>敌方每回合攻击 1 币（触发自身流血 / 援护防御）</span>
                </label>
              </div>
            </div>
            )}
          </aside>

          {/* Right column: Simulation Results */}
          <div>
            {blocked && (
              <div className="callout err" style={{ marginBottom: 16 }}>
                <div className="callout-body">
                  <b>预设校验存在错误，计算已阻止</b>
                  请返回「技能组配置」修正标红项后再试。
                </div>
              </div>
            )}

            {simResult && (
              <>
                <IdealRotationSummary core={core} text={text} preset={preset} simResult={simResult} bonusTier={bonusTier} />

                <div className={`hero-result ${simResult.exact ? "" : "inexact"}`}>
                  <div className="hero-top">
                    <div>
                      <h3>结果总览 · 模拟全程总伤（按排轴逐回合，未折算 6 技能轮）</h3>
                      <div className="big-number">
                        {simResult.totals.total}
                        <small>HP</small>
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      {simResult.exact ? (
                        <span className="tag ok">✓ 已完全建模（精确结论）</span>
                      ) : (
                        <span className="tag err">⚠ 含未建模缺口（共 {simResult.gaps.length} 项，不可宣称为精确总伤）</span>
                      )}
                      <div className="muted small" style={{ marginTop: 6 }}>
                        规则版本：{simResult.rulesVersion}
                      </div>
                    </div>
                  </div>

                  <div className="metric-row">
                    <div className="metric">
                      <div className="k">直伤 (Direct)</div>
                      <div className="v">{simResult.totals.direct}</div>
                      <div className="bar">
                        <i
                          style={{
                            width: `${simResult.totals.total > 0 ? Math.min(100, (simResult.totals.direct / simResult.totals.total) * 100) : 0}%`,
                          }}
                        />
                      </div>
                    </div>
                    <div className="metric">
                      <div className="k">追伤 (Extra)</div>
                      <div className="v">{simResult.totals.extra}</div>
                      <div className="bar">
                        <i
                          style={{
                            width: `${simResult.totals.total > 0 ? Math.min(100, (simResult.totals.extra / simResult.totals.total) * 100) : 0}%`,
                            background: "var(--p-300)",
                          }}
                        />
                      </div>
                    </div>
                    <div className="metric">
                      <div className="k">DOT / 状态 HP 伤害</div>
                      <div className="v">{simResult.totals.dotHp}</div>
                      <div className="bar">
                        <i
                          style={{
                            width: `${simResult.totals.total > 0 ? Math.min(100, (simResult.totals.dotHp / simResult.totals.total) * 100) : 0}%`,
                            background: "var(--err-400)",
                          }}
                        />
                      </div>
                    </div>
                    <div className="metric">
                      <div className="k">沉沦 SP 伤害</div>
                      <div className="v">{simResult.totals.dotSp}</div>
                    </div>
                    <div className="metric">
                      <div className="k">震颤引爆混乱阈值前移</div>
                      <div className="v">{simResult.totals.staggerShift}</div>
                    </div>
                  </div>

                  {simResult.monteCarlo && (
                    <div className="mc-line">
                      Monte Carlo 抽样（{simResult.monteCarlo.samples} 样本）：期望总伤{" "}
                      <b>{simResult.monteCarlo.mean.toFixed(2)}</b> ± {simResult.monteCarlo.stderr.toFixed(2)}（观测区间{" "}
                      <b>{simResult.monteCarlo.observedMin}</b> – <b>{simResult.monteCarlo.observedMax}</b>；期望直伤{" "}
                      {simResult.monteCarlo.meanDirect.toFixed(2)}，期望 DOT {simResult.monteCarlo.meanDot.toFixed(2)}）
                    </div>
                  )}
                </div>

                {simResult.gaps.length > 0 && (
                  <div className="callout warn" style={{ marginTop: 16 }}>
                    <div className="callout-body">
                      <b style={{ marginBottom: 6 }}>未覆盖效果 / 场景缺口（阻断精确结论，可通过技能组手动修正补偿）</b>
                      <ul className="gap-list">
                        {simResult.gaps.map((g, i) => (
                          <li key={i}>
                            <span className="tag warn">{g.kind}</span>
                            <div>
                              <code>{g.id}</code> {g.where ? <span className="muted">({g.where})</span> : null} {g.message}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}


                <ExternalBuffsPanel
                  core={core}
                  text={text}
                  preset={preset}
                  onChange={(next) => {
                    setPreset({ ...preset, actor: { ...preset.actor, externalBuffs: next } });
                    setOptResult(null);
                  }}
                />

                <ManualScheduleEditor
                  core={core}
                  text={text}
                  preset={preset}
                  onChange={(next, turnCount) => {
                    setPreset({
                      ...preset,
                      simulation: { ...preset.simulation, mode: "orderedCycle", turnCount, actionSchedule: next },
                    });
                    setOptResult(null);
                  }}
                />
                {readSchedule(preset).length === 0 && (
                  <div className="callout warn" style={{ marginTop: 12 }}>
                    <div className="callout-body">
                      <b>行动表为空</b>
                      点上方「6T 单槽」或直接在回合格子里选技能，轮伤表就会逐回合列出每次出招的算式。
                    </div>
                  </div>
                )}



                <div className="panel">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <h3 style={{ marginBottom: 0 }}>排轴与最佳方案推演</h3>
                      <div className="mode-switch">
                        <button
                          type="button"
                          className={`chip ${optMode === "llm" ? "on" : ""}`}
                          onClick={() => setOptMode("llm")}
                        >
                          🤖 LLM 智能思考精算
                        </button>
                        <button
                          type="button"
                          className={`chip ${optMode === "math" ? "on" : ""}`}
                          onClick={() => setOptMode("math")}
                        >
                          🧮 普通数学穷举 (6T / 12T)
                        </button>
                      </div>
                    </div>
                    {optMode === "math" && (
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      {(() => {
                        const idObj = core.identities.find((i) => i.id === preset.actor.identityId);
                        const cntId = idObj?.defenseSkillIds.find((d) => core.skills[String(d)]?.attrs.defType === "COUNTER");
                        const s1Id = idObj?.skillPool.find((r) => r.count === 3)?.skillId;
                        if (!cntId || !s1Id) return null;
                        const isCounterNow = preset.skillGroups.base[0]?.skillId === cntId;
                        return (
                          <button
                            type="button"
                            className={`chip ${isCounterNow ? "on" : ""}`}
                            onClick={() => {
                              const targetSid = isCounterNow ? s1Id : cntId;
                              const targetSkill = core.skills[String(targetSid)]!;
                              const oldEntryId = preset.skillGroups.base[0]?.entryId ?? "s1";
                              const newEntryId = isCounterNow ? "s1" : "cnt";
                              const nextBase = preset.skillGroups.base.map((b, idx) =>
                                idx === 0
                                  ? {
                                      ...b,
                                      entryId: newEntryId,
                                      skillId: targetSid,
                                      slot: targetSkill.slot ?? undefined,
                                      ...perCoinDefaults(targetSkill.coinCount),
                                    }
                                  : b,
                              );
                              const nextSchedule = (preset.simulation.actionSchedule ?? []).map((a) =>
                                a.entryId === oldEntryId ? { ...a, entryId: newEntryId } : a,
                              );
                              setPreset({
                                ...preset,
                                skillGroups: { ...preset.skillGroups, base: nextBase },
                                simulation: { ...preset.simulation, actionSchedule: nextSchedule },
                              });
                              setOptResult(null);
                            }}
                          >
                            {isCounterNow ? "✓ 已将一技能换为反击（点击恢复 S1）" : "⇄ 一技能全换反击（CNT×3 + S2×2 + S3×1）"}
                          </button>
                        );
                      })()}
                      <button
                        type="button"
                        className={`chip ${optSlots === 1 && optTurns === 6 ? "on" : ""}`}
                        onClick={() => {
                          setOptSlots(1);
                          setOptTurns(6);
                          setOptResult(null);
                        }}
                      >
                        6T 单槽（1副牌 · 60种）
                      </button>
                      <button
                        type="button"
                        className={`chip ${optSlots === 1 && optTurns === 12 ? "on" : ""}`}
                        onClick={() => {
                          setOptSlots(1);
                          setOptTurns(12);
                          setOptResult(null);
                        }}
                        title="连续穷举 2 副牌（60 × 60 = 3,600 种合法发牌顺序），适合 4 回合周期与 6 技能牌库同调，并自动折算回 6 技能标准轮伤"
                      >
                        12T 单槽（2副牌同调 · 3600种）
                      </button>
                      <button
                        type="button"
                        className={`chip ${optSlots === 2 ? "on" : ""}`}
                        onClick={() => {
                          setOptSlots(2);
                          setOptTurns(6);
                          setOptResult(null);
                        }}
                      >
                        6T 双槽（12动作 · 13860种）
                      </button>
                      <button type="button" className="primary" onClick={runOptimizer} disabled={optRunning}>
                        {optRunning ? "穷举中…" : "开始穷举"}
                      </button>
                    </div>
                    )}
                  </div>

                  {optMode === "llm" ? (
                    <LlmAdvisorSection
                      core={core}
                      text={text}
                      preset={preset}
                      onApplyPlan={({ externalBuffs, schedule, excelCases, bonusTier }) => {
                        if (excelCases && excelCases.length > 0) {
                          setLlmInjectedRows(excelCases);
                        }
                        let nextPreset = { ...preset };
                        if (externalBuffs && externalBuffs.length > 0) {
                          nextPreset = {
                            ...nextPreset,
                            actor: { ...nextPreset.actor, externalBuffs },
                          };
                        }
                        if (schedule && schedule.length > 0) {
                          // If LLM scheduled "cnt", ensure base[0] is switched to counter if available
                          const idObj = core.identities.find((i) => i.id === nextPreset.actor.identityId);
                          const cntId = idObj?.defenseSkillIds.find((d) => core.skills[String(d)]?.attrs.defType === "COUNTER");
                          let nextBase = nextPreset.skillGroups.base;
                          if (schedule.includes("cnt") && cntId && nextBase[0] && nextBase[0].entryId !== "cnt") {
                            const cntSkill = core.skills[String(cntId)]!;
                            nextBase = nextBase.map((b, i) =>
                              i === 0 ? { ...b, entryId: "cnt", skillId: cntId, slot: cntSkill.slot ?? undefined, ...perCoinDefaults(cntSkill.coinCount) } : b,
                            );
                          }
                          const mappedSchedule = schedule.map((eid, idx) => ({
                            turn: idx + 1,
                            order: 1,
                            entryId: eid,
                          }));
                          nextPreset = {
                            ...nextPreset,
                            skillGroups: { ...nextPreset.skillGroups, base: nextBase },
                            simulation: {
                              ...nextPreset.simulation,
                              mode: "orderedCycle",
                              turnCount: mappedSchedule.length,
                              actionSchedule: mappedSchedule,
                            },
                          };
                        }
                        if (bonusTier) {
                          nextPreset = { ...nextPreset, simulation: { ...nextPreset.simulation, bonusTier } };
                        }
                        setPreset(nextPreset);
                      }}
                    />
                  ) : (
                    <>
                      <p className="small muted" style={{ margin: "0 0 10px" }}>
                        支持「6T 单槽（1副牌 60种）」「12T 单槽（2副牌同调 3,600种，自动折算 6 技能标准轮伤）」「6T 双槽（12动作 13,860种）」。
                        想比较「用反击替换一技能」：点右上角「一技能全换反击」后再点「开始穷举」。
                      </p>
                      {optResult && optResult.best && (
                        <>
                          <div className="opt-summary">
                            <div>
                              <div className="k">最佳 6 技能轮伤</div>
                              <div className="v" style={{ color: "var(--p-300)" }}>{optResult.best.wheelTotal}</div>
                            </div>
                            <div>
                              <div className="k">最佳原始总伤 ({optResult.turns}T)</div>
                              <div className="v">{optResult.best.total}</div>
                            </div>
                            <div>
                              <div className="k">最差顺序总伤</div>
                              <div className="v muted">{optResult.worst?.total ?? "—"}</div>
                            </div>
                            <div>
                              <div className="k">顺序差距</div>
                              <div className="v">+{optResult.best.total - (optResult.worst?.total ?? optResult.best.total)}</div>
                            </div>
                            <div>
                              <div className="k">已穷举方案数</div>
                              <div className="v">{optResult.evaluated}{optResult.truncated ? "+（已截断）" : ""}</div>
                            </div>
                            <button type="button" className="primary" onClick={applyBestSchedule}>
                              应用最佳排轴到当前预设
                            </button>
                          </div>
                          <div className="table-scroll" style={{ marginTop: 10 }}>
                            <table className="data">
                              <thead>
                                <tr>
                                  <th className="num" style={{ width: 42 }}>#</th>
                                  {Array.from({ length: optResult.turns }, (_, idx) => idx + 1).map((t) => (
                                    <th key={t}>T{t}</th>
                                  ))}
                                  <th className="num">直伤</th>
                                  <th className="num">DOT</th>
                                  <th className="num">{optResult.turns}T总伤</th>
                                  <th className="num">折算6技能轮伤</th>
                                </tr>
                              </thead>
                              <tbody>
                                {optResult.top.map((c, i) => (
                                  <tr key={i}>
                                    <td className="num muted">{i + 1}</td>
                                    {c.turns.map((ids, t) => (
                                      <td key={t}>
                                        {ids.map((id, k) => (
                                          <span key={id + t + k} className="tag" style={{ marginRight: 2 }}>
                                            {id === "cnt" ? "反" : id.toUpperCase()}
                                          </span>
                                        ))}
                                      </td>
                                    ))}
                                    <td className="num">{c.direct}</td>
                                    <td className="num">{c.dotHp}</td>
                                    <td className="num">{c.total}</td>
                                    <td className="num"><b style={{ color: "var(--p-300)" }}>{c.wheelTotal}</b></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          {!optResult.best.exact && (
                            <div className="small muted" style={{ marginTop: 8 }}>
                              ⚠ 该人格存在未建模效果（见上方缺口列表），排名仅反映已建模部分。
                            </div>
                          )}
                        </>
                      )}
                    </>
                  )}
                </div>

                <details className="disclosure advanced-block">
                  <summary>详细算表：逐出招精算表 / Excel 多情况工作表 / E.G.O 伤害</summary>
                  <div className="disclosure-body">
                <div style={{ marginTop: 16 }}>
                  <RotationDamageTable core={core} text={text} preset={preset} simResult={simResult} />
                </div>
                <div style={{ marginTop: 16 }}>
                  <QuickSkillSheet
                    core={core}
                    text={text}
                    preset={preset}
                    bonusTier={bonusTier}
                    injectedRows={llmInjectedRows}
                  />
                </div>
                <EgoDamagePanel
                  core={core}
                  text={text}
                  preset={preset}
                  bonusTier={bonusTier}
                  onAddSkillToPreset={(skillId) => {
                    const s = core.skills[String(skillId)];
                    if (!s) return;
                    const existingIds = new Set(preset.skillGroups.base.map((b) => b.entryId));
                    let k = 1;
                    while (existingIds.has(`ego${k}`)) k++;
                    const entryId = `ego${k}`;
                    const nextBase = [...preset.skillGroups.base, baseEntryFor(s, entryId, 1)];
                    const nextSchedule = [
                      ...(preset.simulation.actionSchedule ?? []),
                      { turn: (preset.simulation.actionSchedule?.length ?? 0) + 1, order: 1, entryId },
                    ];
                    setPreset({
                      ...preset,
                      skillGroups: { ...preset.skillGroups, base: nextBase },
                      simulation: { ...preset.simulation, turnCount: Math.max(preset.simulation.turnCount ?? 6, nextSchedule.length), actionSchedule: nextSchedule },
                    });
                    setOptResult(null);
                  }}
                />
                  </div>
                </details>

                <details className="disclosure advanced-block">
                  <summary>引擎明细：逐技能项拆分 / DOT 分项 / 残留状态 / 结算日志</summary>
                  <div className="disclosure-body">
                <div className="panel" style={{ marginTop: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
                    <h3 style={{ marginBottom: 0 }}>各技能项伤害明细</h3>
                    <div className="legend">
                      <span>
                        <i style={{ background: "var(--p-500)" }} />
                        直伤
                      </span>
                      <span>
                        <i style={{ background: "var(--p-300)" }} />
                        追伤
                      </span>
                      <span>
                        <i style={{ background: "var(--err-400)" }} />
                        DOT
                      </span>
                    </div>
                  </div>
                  <table className="data">
                    <thead>
                      <tr>
                        <th>项 ID</th>
                        <th>技能</th>
                        <th className="num">次数</th>
                        <th className="num">直伤</th>
                        <th className="num">追伤</th>
                        <th className="num">触发 DOT (HP)</th>
                        <th className="num">小计</th>
                        <th style={{ width: 120 }}>占比构成</th>
                      </tr>
                    </thead>
                    <tbody>
                      {simResult.perEntry.map((row) => {
                        const denom = Math.max(1, simResult.totals.total);
                        return (
                          <tr key={row.entryId}>
                            <td>
                              <code>{row.entryId}</code>
                            </td>
                            <td>{skillName(text, core, row.skillId)}</td>
                            <td className="num">{row.uses}</td>
                            <td className="num">{row.direct}</td>
                            <td className="num">{row.extra}</td>
                            <td className="num">{row.dotHp}</td>
                            <td className="num">
                              <b>{row.total}</b>
                            </td>
                            <td>
                              <div className="share-bar" title={`占总伤 ${((row.total / denom) * 100).toFixed(1)}%`}>
                                <i className="d" style={{ width: `${(row.direct / denom) * 100}%` }} />
                                <i className="x" style={{ width: `${(row.extra / denom) * 100}%` }} />
                                <i className="t" style={{ width: `${(row.dotHp / denom) * 100}%` }} />
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={2}>合计</td>
                        <td className="num">{simResult.perEntry.reduce((s, r) => s + r.uses, 0)}</td>
                        <td className="num">{simResult.totals.direct}</td>
                        <td className="num">{simResult.totals.extra}</td>
                        <td className="num">{simResult.totals.dotHp}</td>
                        <td className="num">{simResult.totals.total}</td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {simResult.dotBreakdown.length > 0 && (
                  <div className="panel">
                    <h3>DOT 与特殊状态触发分项</h3>
                    <table className="data">
                      <thead>
                        <tr>
                          <th>回合</th>
                          <th>状态</th>
                          <th className="num">触发次数</th>
                          <th className="num">HP 伤害</th>
                          <th className="num">SP 伤害</th>
                          <th className="num">混乱阈值前移</th>
                        </tr>
                      </thead>
                      <tbody>
                        {simResult.dotBreakdown.map((d, i) => (
                          <tr key={i}>
                            <td>T{d.turn}</td>
                            <td>
                              {text.label(d.statusId) ?? d.statusId} <code>{d.statusId}</code>
                            </td>
                            <td className="num">{d.triggers}</td>
                            <td className="num">
                              <b>{d.hpDamage}</b>
                            </td>
                            <td className="num">{d.spDamage}</td>
                            <td className="num">{d.staggerShift}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {simResult.remainingStatuses.length > 0 && (
                  <div className="panel">
                    <h3>模拟结束残留状态（不提前折算为伤害）</h3>
                    <div className="row">
                      {simResult.remainingStatuses.map((s, i) => (
                        <span key={i} className={`tag ${s.side === "actor" ? "info" : "gold"}`}>
                          [{s.side === "actor" ? "自身" : "目标"}] {text.label(s.id) ?? s.id}: 强度 {s.potency} / 层数 {s.count}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {!simple && (
                <div className="panel">
                  <h3>关键假设与逐事件结算日志（共 {simResult.events.length} 条）</h3>
                  <ul className="assumptions">
                    {simResult.assumptions.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                  <div className="log-filter">
                    {(
                      [
                        ["all", `全部 (${simResult.events.length})`],
                        ["coin", "技能 / 硬币伤害"],
                        ["dot", "DOT 触发"],
                        ["status", "状态施加与消耗"],
                        ["round", "回合边界"],
                      ] as const
                    ).map(([k, label]) => (
                      <button
                        key={k}
                        type="button"
                        className={`chip ${logFilter === k ? "on" : ""}`}
                        onClick={() => setLogFilter(k)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="log-scroll">
                    <table className="data">
                      <thead>
                        <tr>
                          <th style={{ width: 56 }}>回合</th>
                          <th style={{ width: 72 }}>技能项</th>
                          <th style={{ width: 76 }}>类型</th>
                          <th>结算详情</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredEvents.map((ev, i) => (
                          <tr key={i}>
                            <td className="muted">T{ev.turn}</td>
                            <td>
                              <code>{ev.entryId ?? "—"}</code>
                            </td>
                            <td>
                              <span className={`ev-kind ${ev.kind}`}>{EVENT_KIND_LABEL[ev.kind] ?? ev.kind}</span>
                            </td>
                            <td className="small">
                              {ev.kind === "coin" && ev.breakdown ? (
                                <>
                                  硬币 {(ev.coinIndex ?? 0) + 1} [{ev.heads ? "正面" : "反面"}
                                  {ev.critical ? " · 暴击" : ""}] 最终威力 <b>{ev.power}</b>（币值 {ev.coinScale}）× 静态乘区{" "}
                                  {ev.breakdown.staticMultiplier.toFixed(3)} × 动态乘区{" "}
                                  {ev.breakdown.dynamicMultiplier.toFixed(3)} → <b>{ev.damage}</b> HP 伤害
                                </>
                              ) : ev.kind === "dot" && ev.dot ? (
                                <>
                                  <b>{text.label(ev.dot.statusId) ?? ev.dot.statusId}</b> ({ev.dot.trigger})：强度{" "}
                                  {ev.dot.potencyAtTrigger}，层数 {ev.dot.countBefore} → {ev.dot.countAfter}，造成{" "}
                                  <b>{ev.dot.hpDamage}</b> HP 伤害
                                  {ev.dot.spDamage > 0 ? `，${ev.dot.spDamage} SP 伤害` : ""}
                                  {ev.dot.staggerShift > 0 ? `，混乱阈值前移 ${ev.dot.staggerShift}` : ""}
                                </>
                              ) : ev.kind === "status" && ev.status ? (
                                <>
                                  [{ev.status.target === "actor" ? "自身" : "目标"}]{" "}
                                  <b>{text.label(ev.status.statusId) ?? ev.status.statusId}</b>：({ev.status.before.potency},{" "}
                                  {ev.status.before.count}) → ({ev.status.after.potency}, {ev.status.after.count}){" "}
                                  <span className="muted">[{ev.status.reason}]</span>
                                </>
                              ) : (
                                ev.message
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                )}
                  </div>
                </details>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
