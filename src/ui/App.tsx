import { useEffect, useMemo, useState } from "react";
import { loadCore, loadPacks, loadTextPack, makeIndex, TextResolver, type CoreData, type NamedText, type TextPack } from "../data/game-data";
import { PresetStore } from "../config/preset-store";
import { createPresetForIdentity } from "../config/preset-factory";
import { loadSettings, saveSettings, type AppSettings } from "../config/app-settings";
import type { Preset } from "../config/preset-types";
import { IdentityBrowser, IdentityCard } from "./IdentityPage";
import { SkillGroupEditor } from "./SkillGroupEditor";
import { ResultPage } from "./ResultPage";
import { SettingsDialog } from "./SettingsDialog";
import { PinnedCards, PinProvider } from "./RichText";

const FALLBACK = "en";
const PACK_LABEL: Record<string, string> = { "LLC_zh-CN": "LLC 汉化 (LLC_zh-CN)", ST: "ST 汉化", en: "English（官方）", kr: "한국어（官方）", jp: "日本語（官方）" };
/** Prefer a Chinese pack, then any non-official pack, then English. */
function pickDefaultPack(packs: string[]): string {
  return packs.find((p) => p === "LLC_zh-CN") ?? packs.find((p) => /zh|cn|chs|汉化|中文/i.test(p)) ?? packs.find((p) => !["en", "kr", "jp"].includes(p)) ?? "en";
}

export function App() {
  const [core, setCore] = useState<CoreData | null>(null);
  const [packs, setPacks] = useState<string[]>([]);
  const [pack, setPack] = useState(() => localStorage.getItem("lcalc.pack") ?? "LLC_zh-CN");
  const [texts, setTexts] = useState<{ primary: TextPack; fallback: TextPack } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"identity" | "editor" | "result">(() => {
    const q = new URLSearchParams(location.search).get("tab");
    return q === "identity" || q === "editor" || q === "result" ? q : "identity";
  });
  const [selected, setSelected] = useState<number | null>(null);
  const [preset, setPreset] = useState<Preset | null>(null);
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);

  const updateSettings = (next: AppSettings) => {
    setSettings(next);
    saveSettings(next);
  };

  useEffect(() => {
    Promise.all([loadCore(), loadPacks()])
      .then(([c, p]) => {
        setCore(c);
        setPacks(p);
        setPack((cur) => (p.includes(cur) ? cur : pickDefaultPack(p)));
        if (c.identities[0]) setSelected((prev) => prev ?? c.identities[0]!.id);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!packs.includes(pack)) return; // wait for packs.json / fallback selection
    localStorage.setItem("lcalc.pack", pack);
    Promise.all([loadTextPack(pack), loadTextPack(FALLBACK)])
      .then(([primary, fallback]) => setTexts({ primary, fallback }))
      .catch((e) => setError(String(e)));
  }, [pack, packs]);

  const index = useMemo(() => (core ? makeIndex(core) : null), [core]);
  const store = useMemo(() => (index ? new PresetStore(localStorage, index) : null), [index]);
  const text = useMemo(
    () => (texts ? new TextResolver(pack, texts.primary, pack === FALLBACK ? null : texts.fallback, FALLBACK) : null),
    [texts, pack],
  );

  if (error) return <div className="fatal">数据加载失败：{error}</div>;
  if (!core || !text || !index || !store) return <div className="loading">加载四破数据…</div>;
  const identity = selected != null ? core.identities.find((i) => i.id === selected) ?? null : null;

  const presetDefaults = {
    level: settings.defaultLevel,
    targetDefense: settings.defaultTargetDefense,
    sp: settings.defaultSp,
    simMode: settings.defaultSimMode,
    bonusTier: settings.defaultBonusTier,
    battlePassives: settings.defaultBattlePassives,
  };

  const createFromIdentity = (targetTab: "editor" | "result") => {
    if (!identity) return;
    const name = (text.get("personalities", identity.id).value as NamedText | undefined)?.name ?? String(identity.id);
    const title = ((text.get("personalities", identity.id).value as NamedText | undefined)?.title ?? "").replace(/\n/g, " ").trim();
    const label = title ? `${title} ${name}` : name;
    setPreset(createPresetForIdentity(identity, core.skills, core.manifest.dataVersion, `${label} 四破配置`, presetDefaults));
    setTab(targetTab);
  };

  return (
    <PinProvider>
      <header className="app-header">
        <div className="brand">
          <h1>四破轮伤 / DOT 计算器</h1>
          <span>Limbus Company · 默认 Lv.{settings.defaultLevel}</span>
        </div>
        <nav className="steps" aria-label="主导航">
          <button className={tab === "identity" ? "on" : ""} onClick={() => setTab("identity")}>
            <span className="step-no" aria-hidden="true">1</span>
            <span>人格资料</span>
          </button>
          <button className={tab === "editor" ? "on" : ""} onClick={() => setTab("editor")}>
            <span className="step-no" aria-hidden="true">2</span>
            <span>技能组配置</span>
          </button>
          <button className={tab === "result" ? "on" : ""} onClick={() => setTab("result")}>
            <span className="step-no" aria-hidden="true">3</span>
            <span>场景与结果</span>
          </button>
        </nav>
        <div className="header-right">
          <div className="mode-switch" role="group" aria-label="界面模式切换">
            <button
              type="button"
              className={`chip ${settings.uiMode === "simple" ? "on" : ""}`}
              onClick={() => updateSettings({ ...settings, uiMode: "simple" })}
              title="简易模式：默认吃满该人格技能加成，提供社区一行式速算拆解与 6T 最佳排轴"
            >
              简易模式
            </button>
            <button
              type="button"
              className={`chip ${settings.uiMode === "advanced" ? "on" : ""}`}
              onClick={() => updateSettings({ ...settings, uiMode: "advanced" })}
              title="高级模式：显示全部逐币修正、初始状态与逐事件结算日志"
            >
              高级模式
            </button>
          </div>
          {preset && (
            <div className="current-preset" title={`当前预设：${preset.name} (#${preset.actor.identityId})`}>
              <span>当前预设</span>
              <strong>{preset.name}</strong>
            </div>
          )}
          <label className="pack">
            <span>翻译</span>
            <select value={pack} onChange={(e) => setPack(e.target.value)}>
              {packs.map((p) => (
                <option key={p} value={p}>
                  {PACK_LABEL[p] ?? p}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => setShowSettings(true)}>
            ⚙ 设置
          </button>
          <span className="data-ver" title="数据版本">
            {core.manifest.dataVersion}
          </span>
        </div>
      </header>
      <main>
        {tab === "identity" && (
          <div className="split">
            <IdentityBrowser core={core} text={text} selected={selected} onSelect={setSelected} />
            <section className="detail">
              {identity ? (
                <IdentityCard
                  key={identity.id}
                  identity={identity}
                  core={core}
                  text={text}
                  onEditPreset={() => createFromIdentity("editor")}
                  onQuickCalculate={() => createFromIdentity("result")}
                />
              ) : (
                <div className="empty">
                  <div className="empty-icon">◈</div>
                  <h2>选择左侧人格查看四破资料</h2>
                  <p>可按罪人或状态关键词过滤；点击描述中的状态词可固定说明卡。</p>
                </div>
              )}
            </section>
          </div>
        )}
        {tab === "editor" && (
          <SkillGroupEditor
            core={core}
            text={text}
            index={index}
            identity={identity}
            store={store}
            preset={preset}
            setPreset={setPreset}
            onGoResult={() => setTab("result")}
            onGoIdentity={() => setTab("identity")}
          />
        )}
        {tab === "result" && (
          <ResultPage
            core={core}
            text={text}
            index={index}
            store={store}
            selectedIdentityId={selected}
            preset={preset}
            setPreset={setPreset}
            settings={settings}
            onGoEditor={() => setTab("editor")}
            onGoIdentity={() => setTab("identity")}
          />
        )}
      </main>
      {showSettings && <SettingsDialog settings={settings} onSave={updateSettings} onClose={() => setShowSettings(false)} />}
      <PinnedCards text={text} />
    </PinProvider>
  );
}
