import { useMemo, useState } from "react";
import type { CoreData, NamedText, SkillText, TextResolver } from "../data/game-data";
import type { AtkType, SinAttribute } from "../config/game-data";
import type { Preset } from "../config/preset-types";
import {
  EXTERNAL_BUFF_TEMPLATES,
  matchesSkill,
  newExternalBuff,
  parseSmartBuffs,
  readExternalBuffs,
  SOURCE_LABEL,
  type ExternalBuff,
  type ExternalBuffSource,
} from "../config/external-buffs";
import { DOT_IDS } from "../config/status-terms";
import { analyzeSkillBonusCap, type BonusTier } from "../engine/bonus-tier";
import { ColoredText } from "./RichText";
import { ATK_LABEL, SIN_LABEL, sinText } from "./labels";

/** Heuristic: guess default numeric values from a passive's description text so user gets a head start. */
function guessPassiveModifiers(desc: string): Partial<ExternalBuff> {
  const out: Partial<ExternalBuff> = {};
  const dmgMatch = /(?:\+|提高|增加\s*)(\d+)\s*%\s*(?:damage|伤害)|(?:damage|伤害量?)\s*(?:\+|提高|增加)?\s*\+?(\d+)\s*%/i.exec(desc);
  if (dmgMatch) out.dmgPct = Number(dmgMatch[1] ?? dmgMatch[2] ?? 0);
  const coinMatch = /(?:Coin Power|硬币威力)\s*\+(\d+)/i.exec(desc);
  if (coinMatch) out.coinPower = Number(coinMatch[1]);
  const finalMatch = /(?:Final Power|最终威力)\s*\+(\d+)/i.exec(desc);
  if (finalMatch) out.finalPower = Number(finalMatch[1]);
  const baseMatch = /(?:Base Power|基础威力)\s*\+(\d+)/i.exec(desc);
  if (baseMatch) out.basePower = Number(baseMatch[1]);
  const offMatch = /(?:Offense Level|攻击等级)\s*\+(\d+)/i.exec(desc);
  if (offMatch) out.offenseLevel = Number(offMatch[1]);
  return out;
}

const COMMUNITY_PRESETS = EXTERNAL_BUFF_TEMPLATES;

export function ExternalBuffsPanel({
  core,
  text,
  preset,
  onChange,
}: {
  core: CoreData;
  text: TextResolver;
  preset: Preset;
  onChange: (next: ExternalBuff[]) => void;
}) {
  const buffs = useMemo(() => readExternalBuffs(preset.actor.externalBuffs), [preset.actor.externalBuffs]);
  const [supportSearch, setSupportSearch] = useState("");
  const [pickingSupport, setPickingSupport] = useState(false);
  const [egoSearch, setEgoSearch] = useState("");
  const [pickingEgo, setPickingEgo] = useState(false);
  const [buffSearch, setBuffSearch] = useState("");
  const [pickingGameBuff, setPickingGameBuff] = useState(false);
  const [buffStacks, setBuffStacks] = useState<Record<string, number>>({});

  const actorIdentity = useMemo(
    () => core.identities.find((i) => i.id === preset.actor.identityId) ?? null,
    [core.identities, preset.actor.identityId],
  );

  // Full Game Buff library (1,861 buffs from core.buffs + localized keywords)
  const gameBuffOptions = useMemo(() => {
    const q = buffSearch.trim().toLowerCase();
    const list: { id: string; name: string; desc: string; maxStack: number }[] = [];
    for (const [id, bDef] of Object.entries(core.buffs)) {
      const kwInfo = text.keywordInfo(id);
      const name = kwInfo.name ?? id;
      const desc = (kwInfo.desc ?? kwInfo.buffDesc ?? "").replace(/<[^>]+>/g, "");
      if (!q) {
        if (!/DamageUp|TakeDamageUp|Enhancement|Fragile|Vulnerable|Field|Noir|Listen|Wariness|Command|Protection|Agility/i.test(id)) {
          continue;
        }
      } else if (!`${id} ${name} ${desc}`.toLowerCase().includes(q)) {
        continue;
      }
      list.push({ id, name, desc, maxStack: bDef.maxStack ?? 99 });
      if (list.length >= 60) break;
    }
    return list;
  }, [core.buffs, text, buffSearch]);

  // E.G.O passives for the current Sinner (or all Sinners when searched)
  const egoPassiveOptions = useMemo(() => {
    const q = egoSearch.trim().toLowerCase();
    const list: { key: string; egoId: number; passiveId: number; egoType: string; egoName: string; pName: string; desc: string }[] = [];
    for (const ego of core.egos ?? []) {
      if (actorIdentity && ego.characterId !== actorIdentity.characterId) continue;
      const egoText = text.get("egos", ego.id).value as NamedText | undefined;
      const egoName = egoText?.name ?? `E.G.O #${ego.id}`;
      for (const pid of ego.passiveIds) {
        const pv = text.get("passives", pid).value as NamedText | undefined;
        const pName = pv?.name ?? `E.G.O 被动 #${pid}`;
        const desc = (pv?.desc ?? "").replace(/<[^>]+>/g, "");
        if (q && !`${ego.id} ${pid} ${ego.egoType} ${egoName} ${pName} ${desc}`.toLowerCase().includes(q)) continue;
        list.push({ key: `${ego.id}-${pid}`, egoId: ego.id, passiveId: pid, egoType: ego.egoType, egoName, pName, desc });
      }
    }
    return list;
  }, [core.egos, actorIdentity, text, egoSearch]);

  // All support passives from OTHER sinners (cannot equip same characterId's support passive)
  const supportOptions = useMemo(() => {
    const q = supportSearch.trim().toLowerCase();
    const list: { key: string; identityId: number; passiveId: number; who: string; pName: string; desc: string }[] = [];
    for (const idObj of core.identities) {
      if (actorIdentity && idObj.characterId === actorIdentity.characterId) continue;
      const pText = text.get("personalities", idObj.id).value as NamedText | undefined;
      const who = `${(pText?.title ?? "").replace(/\n/g, " ").trim()} ${pText?.name ?? idObj.id}`.trim();
      for (const pid of idObj.supportPassiveIds) {
        const pv = text.get("passives", pid).value as NamedText | undefined;
        const pName = pv?.name ?? `被动 #${pid}`;
        const desc = (pv?.desc ?? "").replace(/<[^>]+>/g, "");
        if (q && !`${idObj.id} ${pid} ${who} ${pName} ${desc}`.toLowerCase().includes(q)) continue;
        list.push({ key: `${idObj.id}-${pid}`, identityId: idObj.id, passiveId: pid, who, pName, desc });
      }
    }
    return list.slice(0, 60);
  }, [core.identities, actorIdentity, text, supportSearch]);

  const updateOne = (idx: number, patch: Partial<ExternalBuff>) => {
    onChange(buffs.map((b, k) => (k === idx ? { ...b, ...patch } : b)));
  };

  const removeOne = (idx: number) => {
    onChange(buffs.filter((_, k) => k !== idx));
  };

  return (
    <div className="panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <h3 style={{ marginBottom: 0 }}>
          支援被动 / 队友 Buff / E.G.O 与本体被动补偿
          {buffs.filter((b) => b.enabled).length > 0 && (
            <span className="tag gold">已启用 {buffs.filter((b) => b.enabled).length} 项</span>
          )}
        </h3>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <select
            value=""
            onChange={(e) => {
              const idx = Number(e.target.value);
              if (!Number.isNaN(idx) && COMMUNITY_PRESETS[idx]) {
                onChange([...buffs, COMMUNITY_PRESETS[idx]!.make()]);
              }
              e.target.value = "";
            }}
            aria-label="快捷添加常见加成"
          >
            <option value="">+ 快捷添加常见被动 / 队友拐 / E.G.O…</option>
            {COMMUNITY_PRESETS.map((t, i) => (
              <option key={i} value={i}>
                {t.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              setPickingGameBuff((v) => !v);
              setPickingEgo(false);
              setPickingSupport(false);
            }}
          >
            {pickingGameBuff ? "收起游戏 Buff 库" : "+ 🔍 从游戏全量 Buff 库选择"}
          </button>
          <button type="button" onClick={() => { setPickingEgo((v) => !v); setPickingSupport(false); setPickingGameBuff(false); }}>
            {pickingEgo ? "收起 E.G.O 被动库" : `+ 本罪人 E.G.O 被动 (${egoPassiveOptions.length})`}
          </button>
          <button type="button" onClick={() => { setPickingSupport((v) => !v); setPickingEgo(false); setPickingGameBuff(false); }}>
            {pickingSupport ? "收起支援被动库" : "+ 从游戏支援被动库选择"}
          </button>
          <button
            type="button"
            onClick={() => onChange([...buffs, newExternalBuff({ name: "自定义词条", source: "custom" })])}
          >
            + 空白词条
          </button>
        </div>
      </div>

      {/* Identity's own battle passives quick reference & one-click add */}
      {actorIdentity && actorIdentity.battlePassiveIds.length > 0 && (
        <div className="passive-quick-bar">
          <span className="muted small">本体战斗被动：</span>
          {actorIdentity && actorIdentity.battlePassiveIds.map((pid) => {
            const pv = text.get("passives", pid).value as NamedText | undefined;
            const pName = pv?.name ?? `#${pid}`;
            const rawDesc = (pv?.desc ?? "").replace(/<[^>]+>/g, "");
            const already = buffs.some((b) => b.name.startsWith(pName));
            return (
              <button
                key={pid}
                type="button"
                className={`chip ${already ? "on" : ""}`}
                title={`${rawDesc}\n（点击智能识别数值与触发条件并加入下方列表）`}
                onClick={() => {
                  if (already) return;
                  const parsed = parseSmartBuffs({ name: pName, desc: rawDesc, source: "custom" });
                  onChange([...buffs, ...parsed]);
                }}
              >
                + <ColoredText text={pName} />
              </button>
            );
          })}
        </div>
      )}

      {pickingGameBuff && (
        <div className="support-picker">
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <input
              style={{ flex: 1 }}
              placeholder="搜索全游戏 1,861 种 Buff（中文名或内部 ID，如：伤害强化 / 易损 / 强壮 / 充能…）"
              value={buffSearch}
              onChange={(e) => setBuffSearch(e.target.value)}
            />
            <span className="muted small">自动从游戏数据读取数值与限定条件（如仅耗充能技能）</span>
          </div>
          <div className="support-list">
            {gameBuffOptions.map((opt) => {
              const st = buffStacks[opt.id] ?? 1;
              return (
                <div key={opt.id} className="support-item">
                  <div>
                    <strong>
                      <ColoredText text={opt.name} />
                    </strong>{" "}
                    <code className="muted small">{opt.id}</code>
                    {opt.maxStack > 1 && <span className="tag" style={{ marginLeft: 6 }}>上限 {opt.maxStack} 层</span>}
                    <div className="small muted">{opt.desc || "（无描述文本，按底层 ability 数值解析）"}</div>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                    <label className="field inline" title="设置层数">
                      <span>层数</span>
                      <input
                        type="number"
                        min={1}
                        max={99}
                        style={{ width: 54 }}
                        value={st}
                        onChange={(e) =>
                          setBuffStacks((p) => ({ ...p, [opt.id]: Math.max(1, Number(e.target.value) || 1) }))
                        }
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        const parsed = parseSmartBuffs({
                          name: opt.name,
                          desc: opt.desc,
                          source: "team",
                          buffDef: core.buffs[opt.id],
                          stacks: st,
                        });
                        onChange([...buffs, ...parsed]);
                        setPickingGameBuff(false);
                      }}
                    >
                      智能解析并添加
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {pickingEgo && (
        <div className="support-picker">
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <input
              style={{ flex: 1 }}
              placeholder="搜索当前罪人的四破 E.G.O 被动（输入 E.G.O 名称、被动名或效果关键词）"
              value={egoSearch}
              onChange={(e) => setEgoSearch(e.target.value)}
            />
            <span className="muted small">共 {egoPassiveOptions.length} 个本罪人 E.G.O 被动</span>
          </div>
          <div className="support-list">
            {egoPassiveOptions.map((opt) => (
              <div key={opt.key} className="support-item">
                <div>
                  <span className="tag gold" style={{ marginRight: 6 }}>{opt.egoType}</span>
                  <strong>{opt.pName}</strong> <span className="muted small">（{opt.egoName}）</span>
                  <div className="small muted">{opt.desc}</div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const parsed = parseSmartBuffs({
                      name: `${opt.pName} (${opt.egoName})`,
                      desc: opt.desc,
                      source: "ego",
                    });
                    onChange([...buffs, ...parsed]);
                    setPickingEgo(false);
                  }}
                >
                  智能解析并添加
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {pickingSupport && (
        <div className="support-picker">
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <input
              style={{ flex: 1 }}
              placeholder="搜索其他罪人的支援被动（输入人格名、被动名或效果关键词，如 伤害 / 威力 / 充能）"
              value={supportSearch}
              onChange={(e) => setSupportSearch(e.target.value)}
            />
            <span className="muted small">已自动排除同罪人可装备冲突</span>
          </div>
          <div className="support-list">
            {supportOptions.map((opt) => (
              <div key={opt.key} className="support-item">
                <div>
                  <strong>{opt.pName}</strong> <span className="muted small">（{opt.who}）</span>
                  <div className="small muted">{opt.desc.slice(0, 140)}{opt.desc.length > 140 ? "…" : ""}</div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const parsed = parseSmartBuffs({
                      name: `${opt.pName} (${opt.who})`,
                      desc: opt.desc,
                      source: "support",
                    });
                    onChange([...buffs, ...parsed]);
                    setPickingSupport(false);
                  }}
                >
                  智能解析并添加
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {buffs.length === 0 ? (
        <div className="small muted">
          暂未添加外部或被动补偿词条。你可以点击上方本体战斗被动胶囊、选择游戏内支援被动，或像社区速算一样添加「悲鸣 基础威力+1 伤害+10%」「2针族 攻等+2」等词条。
        </div>
      ) : (
        <table className="data" style={{ marginTop: 6 }}>
          <thead>
            <tr>
              <th style={{ width: 42 }}>启用</th>
              <th style={{ width: 92 }}>来源</th>
              <th>词条名称</th>
              <th className="num">攻等 ±</th>
              <th className="num">基础威力 ±</th>
              <th className="num">硬币威力 ±</th>
              <th className="num">最终威力 ±</th>
              <th className="num">增伤 %</th>
              <th className="num">目标易损 %</th>
              <th>限定范围</th>
              <th style={{ width: 40 }} />
            </tr>
          </thead>
          <tbody>
            {buffs.map((b, idx) => (
              <tr key={b.id} style={{ opacity: b.enabled ? 1 : 0.5 }}>
                <td>
                  <input
                    type="checkbox"
                    checked={b.enabled}
                    onChange={(e) => updateOne(idx, { enabled: e.target.checked })}
                  />
                </td>
                <td>
                  <select
                    value={b.source}
                    onChange={(e) => updateOne(idx, { source: e.target.value as ExternalBuffSource })}
                  >
                    {(Object.keys(SOURCE_LABEL) as ExternalBuffSource[]).map((k) => (
                      <option key={k} value={k}>
                        {SOURCE_LABEL[k]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    style={{ width: "100%", minWidth: 130 }}
                    value={b.name}
                    title={b.note}
                    onChange={(e) => updateOne(idx, { name: e.target.value })}
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    style={{ width: 64 }}
                    value={b.offenseLevel}
                    onChange={(e) => updateOne(idx, { offenseLevel: Math.trunc(Number(e.target.value) || 0) })}
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    style={{ width: 64 }}
                    value={b.basePower}
                    onChange={(e) => updateOne(idx, { basePower: Math.trunc(Number(e.target.value) || 0) })}
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    style={{ width: 64 }}
                    value={b.coinPower}
                    onChange={(e) => updateOne(idx, { coinPower: Math.trunc(Number(e.target.value) || 0) })}
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    style={{ width: 64 }}
                    value={b.finalPower}
                    onChange={(e) => updateOne(idx, { finalPower: Math.trunc(Number(e.target.value) || 0) })}
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    step={1}
                    style={{ width: 68 }}
                    value={b.dmgPct}
                    onChange={(e) => updateOne(idx, { dmgPct: Number(e.target.value) || 0 })}
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    step={1}
                    style={{ width: 68 }}
                    value={b.takeDmgPct}
                    onChange={(e) => updateOne(idx, { takeDmgPct: Number(e.target.value) || 0 })}
                  />
                </td>
                <td>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                    <select value={b.slot ?? ""} onChange={(e) => updateOne(idx, { slot: e.target.value || null })} title="限定技能槽位">
                      <option value="">全技能</option>
                      <option value="S1">仅 S1</option>
                      <option value="S2">仅 S2</option>
                      <option value="S3">仅 S3</option>
                    </select>
                    <select value={b.atk ?? ""} onChange={(e) => updateOne(idx, { atk: (e.target.value || null) as AtkType | null })} title="限定攻击类型">
                      <option value="">全物理</option>
                      <option value="SLASH">仅斩击</option>
                      <option value="PENETRATE">仅突刺</option>
                      <option value="HIT">仅打击</option>
                    </select>
                    <select value={b.sin ?? ""} onChange={(e) => updateOne(idx, { sin: (e.target.value || null) as SinAttribute | null })} title="限定罪孽属性">
                      <option value="">全罪孽</option>
                      <option value="CRIMSON">仅暴怒</option>
                      <option value="SCARLET">仅色欲</option>
                      <option value="AMBER">仅怠惰</option>
                      <option value="SHAMROCK">仅暴食</option>
                      <option value="AZURE">仅忧郁</option>
                      <option value="INDIGO">仅傲慢</option>
                      <option value="VIOLET">仅嫉妒</option>
                    </select>
                    <label className="field inline" title="勾选后按游戏技能元数据自动判断：只对消耗充能/特殊充能层数的技能生效">
                      <input type="checkbox" checked={b.onlyConsumesCharge === true} onChange={(e) => updateOne(idx, { onlyConsumesCharge: e.target.checked })} />
                      <span>仅耗充能技能</span>
                    </label>
                  </div>
                </td>
                <td>
                  <button className="link danger icon" onClick={() => removeOne(idx)} aria-label="删除该词条">
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Community-style one-line formula breakdown card:
 * Shows each skill in the exact format players use on forums/sheets:
 *   一技能+2  3+4+4 -> 3+6+6 (点数 21)  (27/25)*21*1.10 = 24  DOT 0-0
 *   56*3 + 107*2 + 179*1 = 729
 *   技能组一轮 DOT 施加：流血 15-9 / 震颤 18-6 ...
 */
export function CommunityFormulaCard({
  core,
  text,
  preset,
  bonusTier,
}: {
  core: CoreData;
  text: TextResolver;
  preset: Preset;
  bonusTier: BonusTier;
}) {
  const extBuffs = useMemo(() => readExternalBuffs(preset.actor.externalBuffs).filter((b) => b.enabled), [preset.actor.externalBuffs]);
  const actorLv = preset.actor.level ?? 65;
  const targetObj = ((preset.scenario as { target?: Record<string, unknown> } | undefined)?.target ?? {});
  const defLv = typeof targetObj.defenseLevel === "number" ? targetObj.defenseLevel : actorLv;
  const physRes = (targetObj.physicalResistances as Record<string, number> | undefined) ?? {};
  const sinResMap = (targetObj.sinResistances as Record<string, number> | undefined) ?? {};
  const fRes = (r: number) => (r >= 1 ? r - 1 : r >= 0 ? (r - 1) * 0.5 : -0.5);
  const SIN_KEY: Record<string, string> = { CRIMSON: "wrath", SCARLET: "lust", AMBER: "sloth", SHAMROCK: "gluttony", AZURE: "gloom", INDIGO: "pride", VIOLET: "envy" };
  const ATK_KEY: Record<string, string> = { SLASH: "slash", PENETRATE: "pierce", HIT: "blunt" };

  const rows = useMemo(() => {
    const out: {
      entryId: string;
      slotLabel: string;
      skillName: string;
      uses: number;
      lvlCorr: number;
      delta: number;
      fracText: string;
      staticMult: number;
      rawCoinExpr: string;
      effCoinExpr: string;
      rollSum: number;
      dynMult: number;
      extraFixed: number;
      singleDmg: number;
      dots: Record<string, { potency: number; count: number }>;
    }[] = [];

    for (const entry of preset.skillGroups.base) {
      if (entry.skillId == null) continue;
      const skill = core.skills[String(entry.skillId)];
      if (!skill) continue;
      const cap = analyzeSkillBonusCap(skill);
      const ext = extBuffs.filter((b) => matchesSkill(b, skill.attrs.attributeType, skill.attrs.atkType, skill.slot));
      const extSum = (k: "basePower" | "coinPower" | "finalPower" | "offenseLevel" | "dmgPct" | "takeDmgPct") =>
        ext.reduce((s, b) => s + b[k], 0);

      const lvlCorr = Number(skill.attrs.skillLevelCorrection ?? 0);
      const offLv = actorLv + lvlCorr + extSum("offenseLevel");
      const delta = offLv - defLv;
      const denom = Math.abs(delta) + 25;
      const numer = denom + delta;
      const sinK = SIN_KEY[skill.attrs.attributeType ?? ""];
      const atkK = ATK_KEY[skill.attrs.atkType ?? ""];
      const resTerm = fRes(sinK ? sinResMap[sinK] ?? 1 : 1) + fRes(atkK ? physRes[atkK] ?? 1 : 1);
      const staticMult = Math.max(0, numer / denom + resTerm);

      const rawBase = entry.basePower ?? skill.basePower;
      const capCoin = bonusTier !== "none" ? cap.coinPower : 0;
      const capFinal = bonusTier !== "none" ? cap.finalPower : 0;
      const capDmg = bonusTier === "full" ? cap.dmg : 0;

      const effBase = rawBase + extSum("basePower") + capFinal + extSum("finalPower");
      const rawCoins = skill.coins.map((c) => `${c.operatorType === "SUB" ? "−" : "+"}${c.scale}`);
      const effCoins: string[] = [];
      let curPower = effBase;
      let rollSum = 0;

      // Also collect per-skill DOTs inflicted (from coin scripts + manual coinDots)
      const dots: Record<string, { potency: number; count: number }> = {};
      const addDot = (id: string, p: number, c: number) => {
        if (!DOT_IDS.includes(id as (typeof DOT_IDS)[number])) return;
        const prev = dots[id] ?? { potency: 0, count: 0 };
        dots[id] = { potency: prev.potency + p, count: prev.count + c };
      };

      const dynBase = 1 + (entry.totalDamageBonusPct + extSum("dmgPct") + extSum("takeDmgPct")) / 100 + capDmg;
      let exactSingleDmg = 0;
      let extraFixed = entry.totalExtraDamage.fixedDamage;

      skill.coins.forEach((c, i) => {
        const cDelta = entry.totalCoinPowerDelta + (entry.coinPowerDeltas?.[i] ?? 0) + capCoin + extSum("coinPower");
        const effScale = Math.max(0, c.scale + cDelta);
        const coinDyn = dynBase + ((entry.coinDamageBonusPcts?.[i] ?? 0) / 100) + (bonusTier === "full" ? cap.coinDmg[i] ?? 0 : 0);
        const passes = bonusTier === "full" && cap.rerollCoinIndex === i ? 2 : 1;
        for (let p = 0; p < passes; p++) {
          effCoins.push(`${c.operatorType === "SUB" ? "−" : "+"}${effScale}${p === 1 ? "(重投)" : ""}`);
          curPower = c.operatorType === "SUB" ? Math.max(0, curPower - effScale) : curPower + effScale;
          rollSum += curPower;
          const hitDmg = Math.max(1, Math.floor(curPower * staticMult * coinDyn));
          exactSingleDmg += hitDmg;
          if (p === 1 && cap.rerollBonusDmgRatio > 0) {
            const bonus = Math.floor(hitDmg * cap.rerollBonusDmgRatio);
            extraFixed += bonus;
            exactSingleDmg += bonus;
          }
          for (const sc of c.abilityScriptList ?? []) {
            if (sc.scriptName.startsWith("GiveBuffOnSucceedAttack") && sc.buffData?.buffKeyword && (sc.buffData.target || "Target") === "Target") {
              addDot(sc.buffData.buffKeyword, sc.buffData.stack ?? 0, sc.buffData.turn ?? 0);
            }
          }
        }
        const manualDot = entry.coinDots?.[i];
        if (manualDot) {
          for (const [did, amt] of Object.entries(manualDot)) {
            if (amt) addDot(did, amt.potency, amt.count);
          }
        }
      });

      exactSingleDmg += Math.floor(entry.totalExtraDamage.fixedDamage);

      const t = text.get("skills", skill.id).value as SkillText | undefined;
      out.push({
        entryId: entry.entryId,
        slotLabel: skill.slot ?? entry.entryId.toUpperCase(),
        skillName: t?.name ?? String(skill.id),
        uses: entry.usesPerCycle,
        lvlCorr,
        delta,
        fracText: `(${numer}/${denom}${resTerm ? ` ${resTerm > 0 ? "+" : "−"} ${Math.abs(resTerm).toFixed(2)}抗性` : ""})`,
        staticMult,
        rawCoinExpr: `${rawBase}${rawCoins.join("")}`,
        effCoinExpr: `${effBase}${effCoins.join("")}`,
        rollSum,
        dynMult: dynBase,
        extraFixed,
        singleDmg: exactSingleDmg,
        dots,
      });
    }
    return out;
  }, [preset.skillGroups.base, core.skills, extBuffs, actorLv, defLv, bonusTier, text]);

  // Aggregate 1-cycle DOT application across all base entries weighted by usesPerCycle
  const cycleDots = useMemo(() => {
    const map: Record<string, { potency: number; count: number }> = {};
    for (const r of rows) {
      if (r.uses <= 0) continue;
      for (const [id, v] of Object.entries(r.dots)) {
        const prev = map[id] ?? { potency: 0, count: 0 };
        map[id] = { potency: prev.potency + v.potency * r.uses, count: prev.count + v.count * r.uses };
      }
    }
    return Object.entries(map).filter(([, v]) => v.potency > 0 || v.count > 0);
  }, [rows]);

  const cycleTotal = rows.reduce((s, r) => s + r.singleDmg * r.uses, 0);

  return (
    <div className="panel community-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
        <h3 style={{ marginBottom: 0 }}>社区速算公式拆解（6 技能标准轮）</h3>
        <span className="muted small">
          格式：(攻防差静态分数) × 满正总点数 × 增伤倍率 = 单发伤害
        </span>
      </div>

      {extBuffs.length > 0 && (
        <div className="community-pre">
          {extBuffs.map((b) => (
            <div key={b.id}>
              · <b>{b.name}</b>：
              {[
                b.offenseLevel && `攻等 ${b.offenseLevel > 0 ? "+" : ""}${b.offenseLevel}`,
                b.basePower && `基础威力 ${b.basePower > 0 ? "+" : ""}${b.basePower}`,
                b.coinPower && `硬币威力 ${b.coinPower > 0 ? "+" : ""}${b.coinPower}`,
                b.finalPower && `最终威力 ${b.finalPower > 0 ? "+" : ""}${b.finalPower}`,
                b.dmgPct && `伤害 ${b.dmgPct > 0 ? "+" : ""}${b.dmgPct}%`,
                b.takeDmgPct && `易损 ${b.takeDmgPct > 0 ? "+" : ""}${b.takeDmgPct}%`,
              ]
                .filter(Boolean)
                .join("  ")}
            </div>
          ))}
        </div>
      )}

      <div className="community-lines">
        {rows.map((r) => {
          const dotStr = Object.entries(r.dots)
            .filter(([, v]) => v.potency > 0 || v.count > 0)
            .map(([id, v]) => `${text.label(id) ?? id} ${v.potency}-${v.count}`)
            .join(" ");
          return (
            <div key={r.entryId} className="community-skill">
              <div className="line1">
                <b>
                  {r.slotLabel} {r.skillName}
                </b>
                <span className="tag">
                  攻等 {r.lvlCorr >= 0 ? `+${r.lvlCorr}` : r.lvlCorr}（总 Δ={r.delta >= 0 ? `+${r.delta}` : r.delta}）
                </span>
                <code>{r.rawCoinExpr}</code>
                <span>→</span>
                <code className="hl">{r.effCoinExpr}</code>
                <span className="muted small">（满正总点数 {r.rollSum}）</span>
                {dotStr && <span className="tag gold">{dotStr}</span>}
              </div>
              <div className="line2">
                <code>
                  {r.fracText} × {r.rollSum} × {r.dynMult.toFixed(2)}
                  {r.extraFixed ? ` + ${r.extraFixed}` : ""} = <b>{r.singleDmg}</b>
                </code>
                <span className="muted small">× {r.uses} 次/轮 = {r.singleDmg * r.uses}</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="community-footer">
        <div>
          <span className="muted">单轮直伤汇总：</span>
          <code>
            {rows
              .filter((r) => r.uses > 0)
              .map((r) => `${r.singleDmg}×${r.uses}`)
              .join(" + ")}{" "}
            = <b>{cycleTotal}</b>
          </code>
        </div>
        {cycleDots.length > 0 && (
          <div>
            <span className="muted">技能组一轮 DOT 施加总量（强度-层数）：</span>
            {cycleDots.map(([id, v]) => (
              <span key={id} className="tag gold" style={{ marginLeft: 6 }}>
                {text.label(id) ?? id} {v.potency}-{v.count}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function EgoDamagePanel({
  core,
  text,
  preset,
  bonusTier,
  onAddSkillToPreset,
}: {
  core: CoreData;
  text: TextResolver;
  preset: Preset;
  bonusTier: BonusTier;
  onAddSkillToPreset?: (skillId: number) => void;
}) {
  const actorIdentity = useMemo(
    () => core.identities.find((i) => i.id === preset.actor.identityId) ?? null,
    [core.identities, preset.actor.identityId],
  );
  const extBuffs = useMemo(() => readExternalBuffs(preset.actor.externalBuffs).filter((b) => b.enabled), [preset.actor.externalBuffs]);
  const actorLv = preset.actor.level ?? 65;
  const targetObj = ((preset.scenario as { target?: Record<string, unknown> } | undefined)?.target ?? {});
  const defLv = typeof targetObj.defenseLevel === "number" ? targetObj.defenseLevel : actorLv;
  const physRes = (targetObj.physicalResistances as Record<string, number> | undefined) ?? {};
  const sinResMap = (targetObj.sinResistances as Record<string, number> | undefined) ?? {};
  const fRes = (r: number) => (r >= 1 ? r - 1 : r >= 0 ? (r - 1) * 0.5 : -0.5);
  const SIN_KEY: Record<string, string> = { CRIMSON: "wrath", SCARLET: "lust", AMBER: "sloth", SHAMROCK: "gluttony", AZURE: "gloom", INDIGO: "pride", VIOLET: "envy" };
  const ATK_KEY: Record<string, string> = { SLASH: "slash", PENETRATE: "pierce", HIT: "blunt" };

  const egoRows = useMemo(() => {
    if (!actorIdentity) return [];
    const list = (core.egos ?? []).filter((e) => e.characterId === actorIdentity.characterId);
    const out: {
      key: string;
      skillId: number;
      egoId: number;
      egoType: string;
      egoName: string;
      kind: "觉醒" | "侵蚀";
      sinAttr?: string;
      atkType?: string;
      targetNum: number;
      lvlCorr: number;
      delta: number;
      fracText: string;
      coinExpr: string;
      rollSum: number;
      dynMult: number;
      singleDmg: number;
      isMinusCoin: boolean;
      dotStr: string;
    }[] = [];

    for (const ego of list) {
      const egoText = text.get("egos", ego.id).value as NamedText | undefined;
      const egoName = egoText?.name ?? `E.G.O #${ego.id}`;
      for (const [sid, kind] of [
        [ego.awakeningSkillId, "觉醒"],
        [ego.corrosionSkillId, "侵蚀"],
      ] as const) {
        if (!sid) continue;
        const skill = core.skills[String(sid)];
        if (!skill) continue;
        const cap = analyzeSkillBonusCap(skill);
        const ext = extBuffs.filter((b) => matchesSkill(b, skill.attrs.attributeType, skill.attrs.atkType, skill.slot));
        const extSum = (k: "basePower" | "coinPower" | "finalPower" | "offenseLevel" | "dmgPct" | "takeDmgPct") =>
          ext.reduce((s, b) => s + b[k], 0);
        const lvlCorr = Number(skill.attrs.skillLevelCorrection ?? 0);
        const offLv = actorLv + lvlCorr + extSum("offenseLevel");
        const delta = offLv - defLv;
        const denom = Math.abs(delta) + 25;
        const numer = denom + delta;
        const sinK = SIN_KEY[skill.attrs.attributeType ?? ""];
        const atkK = ATK_KEY[skill.attrs.atkType ?? ""];
        const resTerm = fRes(sinK ? sinResMap[sinK] ?? 1 : 1) + fRes(atkK ? physRes[atkK] ?? 1 : 1);
        const staticMult = Math.max(0, numer / denom + resTerm);

        const isMinusCoin = skill.coins.some((c) => c.operatorType === "SUB");
        const capCoin = bonusTier !== "none" ? cap.coinPower : 0;
        const capFinal = bonusTier !== "none" ? cap.finalPower : 0;
        const capDmg = bonusTier === "full" ? cap.dmg : 0;
        const effBase = skill.basePower + extSum("basePower") + capFinal + extSum("finalPower");
        const dynBase = 1 + (extSum("dmgPct") + extSum("takeDmgPct")) / 100 + capDmg;

        let curPower = effBase;
        let rollSum = 0;
        let singleDmg = 0;
        const effCoins: string[] = [];
        const dots: Record<string, { potency: number; count: number }> = {};

        skill.coins.forEach((c, i) => {
          // For minus coin EGO (SUB), full power is all-tails (scale not subtracted), or if ADD, all-heads
          const effScale = Math.max(0, c.scale + capCoin + extSum("coinPower"));
          effCoins.push(`${c.operatorType === "SUB" ? "−" : "+"}${effScale}`);
          if (c.operatorType !== "SUB") curPower += effScale;
          rollSum += curPower;
          const coinDyn = dynBase + (bonusTier === "full" ? cap.coinDmg[i] ?? 0 : 0);
          singleDmg += Math.max(1, Math.floor(curPower * staticMult * coinDyn));
          for (const sc of c.abilityScriptList ?? []) {
            if (sc.scriptName.startsWith("GiveBuffOnSucceedAttack") && sc.buffData?.buffKeyword && (sc.buffData.target || "Target") === "Target") {
              const id = sc.buffData.buffKeyword;
              if (DOT_IDS.includes(id as (typeof DOT_IDS)[number])) {
                const prev = dots[id] ?? { potency: 0, count: 0 };
                dots[id] = { potency: prev.potency + (sc.buffData.stack ?? 0), count: prev.count + (sc.buffData.turn ?? 0) };
              }
            }
          }
        });

        const dotStr = Object.entries(dots)
          .filter(([, v]) => v.potency > 0 || v.count > 0)
          .map(([id, v]) => `${text.label(id) ?? id} ${v.potency}-${v.count}`)
          .join(" ");

        out.push({
          key: `${ego.id}-${kind}`,
          skillId: sid,
          egoId: ego.id,
          egoType: ego.egoType,
          egoName,
          kind,
          sinAttr: skill.attrs.attributeType,
          atkType: skill.attrs.atkType,
          targetNum: Number(skill.attrs.targetNum ?? 1),
          lvlCorr,
          delta,
          fracText: `(${numer}/${denom})`,
          coinExpr: `${effBase}${effCoins.join("")}`,
          rollSum,
          dynMult: dynBase,
          singleDmg,
          isMinusCoin,
          dotStr,
        });
      }
    }
    return out;
  }, [actorIdentity, core.egos, core.skills, extBuffs, actorLv, defLv, bonusTier, text, physRes, sinResMap]);

  if (!egoRows.length) return null;

  return (
    <div className="panel">
      <details className="disclosure" style={{ borderTop: "none", marginTop: 0, paddingTop: 0 }}>
        <summary style={{ fontSize: "var(--t-md)", fontWeight: 600, color: "var(--text-1)" }}>
          <span>本罪人 E.G.O 技能伤害速算（共 {egoRows.length} 个觉醒/侵蚀技能 · 四破）</span>
          <span className="muted small" style={{ fontWeight: 400 }}>
            （点击展开查看单发对单伤害，或一键加入当前技能组）
          </span>
        </summary>
        <div className="disclosure-body">
          <table className="data">
            <thead>
              <tr>
                <th>等级</th>
                <th>E.G.O 技能</th>
                <th>属性 / 容量</th>
                <th>攻等 / 面板</th>
                <th>速算公式</th>
                <th className="num">对单伤害</th>
                <th className="num">满广域总伤</th>
                <th style={{ width: 96 }} />
              </tr>
            </thead>
            <tbody>
              {egoRows.map((r) => (
                <tr key={r.key}>
                  <td>
                    <span className="tag gold">{r.egoType}</span>
                  </td>
                  <td>
                    <b>{r.egoName}</b>{" "}
                    <span className={`tag ${r.kind === "侵蚀" ? "err" : "info"}`}>{r.kind}</span>
                  </td>
                  <td>
                    {r.sinAttr && (
                      <span className="sin" style={{ background: SIN_LABEL[r.sinAttr]?.color ?? "#888", marginRight: 4 }}>
                        {sinText(r.sinAttr)}
                      </span>
                    )}
                    <span className="small muted">
                      {ATK_LABEL[r.atkType ?? ""] ?? r.atkType} · 容量 {r.targetNum}
                    </span>
                  </td>
                  <td>
                    <span className="small muted">
                      {r.lvlCorr >= 0 ? `+${r.lvlCorr}` : r.lvlCorr} (Δ={r.delta >= 0 ? `+${r.delta}` : r.delta}){" "}
                    </span>
                    <code>{r.coinExpr}</code>
                    {r.isMinusCoin && <span className="muted small"> (全反满威)</span>}
                  </td>
                  <td>
                    <code>
                      {r.fracText} × {r.rollSum} × {r.dynMult.toFixed(2)}
                    </code>
                    {r.dotStr && (
                      <span className="tag gold" style={{ marginLeft: 6 }}>
                        {r.dotStr}
                      </span>
                    )}
                  </td>
                  <td className="num">
                    <b>{r.singleDmg}</b>
                  </td>
                  <td className="num muted">{r.targetNum > 1 ? r.singleDmg * r.targetNum : "—"}</td>
                  <td className="num">
                    {onAddSkillToPreset && (
                      <button type="button" className="chip" onClick={() => onAddSkillToPreset(r.skillId)}>
                        + 加入技能组
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
