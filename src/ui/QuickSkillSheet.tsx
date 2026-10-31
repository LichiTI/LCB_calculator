/**
 * Excel-style Multi-Case Skill Worksheet & Standalone Single-Skill Quick Calculator.
 *
 * Solves two core player workflows without relying on black-box turn simulation:
 *   1. "三技能情况A / 三技能情况B": Any skill can have multiple rows representing different
 *      combat situations (e.g., Normal vs Enhanced Form, With 1-Turn Fragile vs Without,
 *      Early coins +10% vs Reroll coin +20%), with editable 0.5-step per-wheel weights.
 *   2. "无元数据单技能快速计算": Pure manual row entry for new/unreleased/custom skills
 *      where no game metadata is needed.
 */
import { useEffect, useMemo, useState } from "react";
import type { CoreData, NamedText, SkillText, TextResolver } from "../data/game-data";
import type { Preset } from "../config/preset-types";
import { matchesSkill, readExternalBuffs } from "../config/external-buffs";
import { analyzeSkillBonusCap, type BonusTier } from "../engine/bonus-tier";

export interface SkillCaseRow {
  id: string;
  slotLabel: string;
  caseName: string;
  basePower: number;
  coinScale: number;
  operator: "ADD" | "SUB";
  coinCount: number;
  /** Number of extra reuses of the last coin (0 = no reroll, 1 = +1 coin like 10617 S2/S3). */
  rerollCount: number;
  /** Offense level minus Defense level (e.g. +6 -> 37/31). */
  levelDelta: number;
  /** Extra static multiplier offset from resistance change (e.g. +0.1 for +0.1 Sloth resist down). */
  resistOffset: number;
  /** Whether this cast is a Critical Hit (+0.2 in Multiplier Group 1). */
  isCrit: boolean;
  /** Dynamic damage bonus % on normal coins (e.g. 80 means ×1.80). */
  dmgBonusPct: number;
  /** Optional dynamic damage bonus % on the last/rerolled coin when mid-skill debuffs apply (null = same as dmgBonusPct). */
  tailDmgBonusPct: number | null;
  /** Optional extra ratio damage % on the rerolled coin (e.g. 30 means ×1.30 on the reroll hit). */
  rerollExtraRatioPct: number;
  /** Weight in a 6-skill wheel (supports 0, 0.5, 1, 1.5, 2, 3...). */
  weight: number;
}

interface EvaluatedCase {
  coinPowers: { power: number; isReroll: boolean }[];
  coinExpr: string;
  rollSum: number;
  numer: number;
  denom: number;
  staticMult: number;
  fracText: string;
  segmentedExpr: string;
  floatDamage: number;
  flooredDamage: number;
  formulaText: string;
}

const fmt2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const trimNum = (n: number) => Number(n.toFixed(2));

export function evaluateSkillCase(row: SkillCaseRow): EvaluatedCase {
  const denom = Math.abs(row.levelDelta) + 25;
  const numer = denom + row.levelDelta;
  const critOffset = row.isCrit ? 0.2 : 0;
  const extraStatic = row.resistOffset + critOffset;
  const staticMult = Math.max(0, numer / denom + extraStatic);
  const fracText =
    Math.abs(extraStatic) > 1e-4
      ? `(${numer}/${denom}${extraStatic > 0 ? `+${trimNum(extraStatic)}` : trimNum(extraStatic)})`
      : `(${numer}/${denom})`;

  const coinPowers: { power: number; isReroll: boolean }[] = [];
  let cur = Math.max(0, row.basePower);
  const nCoins = Math.max(1, Math.min(12, Math.trunc(row.coinCount)));
  const nRerolls = Math.max(0, Math.min(5, Math.trunc(row.rerollCount)));

  for (let i = 0; i < nCoins; i++) {
    cur = row.operator === "SUB" ? Math.max(0, cur - row.coinScale) : cur + row.coinScale;
    coinPowers.push({ power: cur, isReroll: false });
  }
  for (let r = 0; r < nRerolls; r++) {
    cur = row.operator === "SUB" ? Math.max(0, cur - row.coinScale) : cur + row.coinScale;
    coinPowers.push({ power: cur, isReroll: true });
  }

  const rollSum = coinPowers.reduce((s, c) => s + c.power, 0);
  const scaleSign = row.operator === "SUB" ? "−" : "+";
  const coinExpr =
    `${row.basePower}` +
    Array.from({ length: nCoins }, () => `${scaleSign}${row.coinScale}`).join("") +
    (nRerolls > 0 ? `(${Array.from({ length: nRerolls }, () => `${scaleSign}${row.coinScale}`).join("")})` : "");

  const mainDyn = Math.max(0, 1 + row.dmgBonusPct / 100);
  const tailDyn = row.tailDmgBonusPct != null ? Math.max(0, 1 + row.tailDmgBonusPct / 100) : mainDyn;
  const rerollRatio = Math.max(0, row.rerollExtraRatioPct / 100);

  let floatDamage = 0;
  let flooredDamage = 0;
  let mainRollSum = 0;
  let tailRollSum = 0;

  coinPowers.forEach((c, idx) => {
    const isTail = idx === coinPowers.length - 1 && (row.tailDmgBonusPct != null || (c.isReroll && rerollRatio > 0));
    const dyn = idx === coinPowers.length - 1 ? tailDyn : mainDyn;
    if (isTail) tailRollSum += c.power;
    else mainRollSum += c.power;

    const rawHit = c.power * staticMult * dyn;
    const flHit = Math.max(1, Math.floor(rawHit));
    floatDamage += rawHit;
    flooredDamage += flHit;

    if (c.isReroll && rerollRatio > 0) {
      floatDamage += rawHit * rerollRatio;
      flooredDamage += Math.floor(flHit * rerollRatio);
    }
  });

  let segmentedExpr = "";
  if (tailRollSum === 0) {
    segmentedExpr = `${rollSum}×${trimNum(mainDyn)}`;
  } else {
    const tailRatioStr = rerollRatio > 0 && nRerolls > 0 ? `×${trimNum(1 + rerollRatio)}` : "";
    segmentedExpr = `(${mainRollSum}×${trimNum(mainDyn)} + ${tailRollSum}×${trimNum(tailDyn)}${tailRatioStr})`;
  }

  const formulaText = `${fracText}×${segmentedExpr} = ${floatDamage.toFixed(2)}`;

  return {
    coinPowers,
    coinExpr,
    rollSum,
    numer,
    denom,
    staticMult,
    fracText,
    segmentedExpr,
    floatDamage,
    flooredDamage,
    formulaText,
  };
}

export function QuickSkillSheet({
  core,
  text,
  preset,
  bonusTier,
  injectedRows,
}: {
  core: CoreData;
  text: TextResolver;
  preset: Preset;
  bonusTier: BonusTier;
  injectedRows?: SkillCaseRow[] | null;
}) {
  const [rows, setRows] = useState<SkillCaseRow[]>([]);
  const [copied, setCopied] = useState(false);
  const [singleSkillInput, setSingleSkillInput] = useState<SkillCaseRow>({
    id: "quick-single",
    slotLabel: "单技能",
    caseName: "无元数据手算",
    basePower: 5,
    coinScale: 7,
    operator: "ADD",
    coinCount: 3,
    rerollCount: 1,
    levelDelta: 7,
    resistOffset: 0,
    isCrit: false,
    dmgBonusPct: 80,
    tailDmgBonusPct: null,
    rerollExtraRatioPct: 30,
    weight: 1,
  });

  const extBuffs = useMemo(
    () => readExternalBuffs(preset.actor.externalBuffs).filter((b) => b.enabled),
    [preset.actor.externalBuffs],
  );
  const actorLv = preset.actor.level ?? 65;
  const targetObj = ((preset.scenario as { target?: Record<string, unknown> } | undefined)?.target ?? {});
  const defLv = typeof targetObj.defenseLevel === "number" ? targetObj.defenseLevel : actorLv;

  // Build default Excel rows from the current identity's preset skills whenever identity or external buffs change
  const buildDefaultRows = (): SkillCaseRow[] => {
    const idObj = core.identities.find((i) => i.id === preset.actor.identityId);
    const isPoise = Boolean(idObj?.skillKeywords.includes("Breath")) || preset.actor.forceFullCrit === true;
    const out: SkillCaseRow[] = [];

    for (const entry of preset.skillGroups.base) {
      if (entry.skillId == null) continue;
      const skill = core.skills[String(entry.skillId)];
      if (!skill || skill.coins.length === 0) continue;
      const cap = analyzeSkillBonusCap(skill);
      const ext = extBuffs.filter((b) => matchesSkill(b, skill.attrs.attributeType, skill.attrs.atkType, skill.slot, skill));
      const extSum = (k: "basePower" | "coinPower" | "finalPower" | "offenseLevel" | "dmgPct" | "takeDmgPct") =>
        ext.reduce((s, b) => s + b[k], 0);

      const lvlCorr = Number(skill.attrs.skillLevelCorrection ?? 0);
      const delta = actorLv + lvlCorr + extSum("offenseLevel") - defLv;
      const rawBase = (entry.basePower ?? skill.basePower) + extSum("basePower") + extSum("finalPower") + (bonusTier !== "none" ? cap.finalPower : 0);
      const rawScale = Math.max(0, (skill.coins[0]?.scale ?? 0) + entry.totalCoinPowerDelta + extSum("coinPower") + (bonusTier !== "none" ? cap.coinPower : 0));
      const op = skill.coins[0]?.operatorType === "SUB" ? "SUB" : "ADD";
      const critBonusPct = isPoise && bonusTier === "full" ? Math.round((cap.critDmg + (cap.coinCritDmg[0] ?? 0)) * 100) : 0;
      const dmgPct =
        entry.totalDamageBonusPct +
        extSum("dmgPct") +
        extSum("takeDmgPct") +
        (bonusTier === "full" ? Math.round(cap.dmg * 100) : 0) +
        critBonusPct;
      const t = text.get("skills", skill.id).value as SkillText | undefined;

      out.push({
        id: `${entry.entryId}-default`,
        slotLabel: skill.slot ?? entry.entryId.toUpperCase(),
        caseName: `${t?.name ?? skill.id}${bonusTier === "full" ? " (吃满)" : ""}`,
        basePower: rawBase,
        coinScale: rawScale,
        operator: op,
        coinCount: skill.coins.length,
        rerollCount: bonusTier === "full" && cap.rerollCoinIndex != null ? Math.max(1, cap.rerollCoinCount) : 0,
        levelDelta: delta,
        resistOffset: 0,
        isCrit: isPoise && (bonusTier === "full" || preset.actor.forceFullCrit === true),
        dmgBonusPct: dmgPct,
        tailDmgBonusPct: null,
        rerollExtraRatioPct: bonusTier === "full" ? Math.round(cap.rerollBonusDmgRatio * 100) : 0,
        weight: entry.usesPerCycle,
      });
    }
    return out;
  };

  useEffect(() => {
    setRows(buildDefaultRows());
  }, [preset.actor.identityId, preset.actor.level, preset.actor.forceFullCrit, preset.actor.externalBuffs, preset.skillGroups.base, bonusTier, defLv]);

  useEffect(() => {
    if (injectedRows && injectedRows.length > 0) {
      setRows(injectedRows);
    }
  }, [injectedRows]);

  // Extract a quick reference of self-buffs and 1-turn target debuffs mentioned in this identity's skills
  const identityBuffHints = useMemo(() => {
    const idObj = core.identities.find((i) => i.id === preset.actor.identityId);
    if (!idObj) return [];
    const sids = [...idObj.skillPool.map((r) => r.skillId), ...idObj.defenseSkillIds];
    const hints: { skillSlot: string; buffName: string; target: string; round: string }[] = [];
    const seen = new Set<string>();
    for (const sid of sids) {
      const s = core.skills[String(sid)];
      if (!s) continue;
      const all = [...(s.abilityScripts ?? []), ...s.coins.flatMap((c) => c.abilityScriptList ?? [])];
      for (const sc of all) {
        const bd = sc.buffData;
        if (!bd?.buffKeyword || sc.scriptName === "KeywordForUI") continue;
        if (!sc.scriptName.startsWith("GiveBuff")) continue;
        const bName = text.label(bd.buffKeyword) ?? bd.buffKeyword;
        const tgt = (bd.target || bd.buffOwner || "Target") === "Self" ? "自身" : "敌方";
        const rd = bd.activeRound === 1 ? "下回合" : sc.scriptName.includes("ThisAndNextTurn") ? "本回合及下回合" : "本回合";
        const key = `${s.slot}:${bName}:${tgt}:${rd}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hints.push({ skillSlot: s.slot ?? `#${sid}`, buffName: bName, target: tgt, round: rd });
      }
    }
    return hints;
  }, [core, preset.actor.identityId, text]);

  const updateRow = (idx: number, patch: Partial<SkillCaseRow>) => {
    setRows((prev) => prev.map((r, k) => (k === idx ? { ...r, ...patch } : r)));
  };

  const duplicateRow = (idx: number) => {
    const src = rows[idx];
    if (!src) return;
    const copy: SkillCaseRow = {
      ...src,
      id: `${src.id}-case-${Date.now()}`,
      caseName: `${src.caseName} · 情况2`,
      weight: 0.5,
    };
    const next = [...rows];
    next.splice(idx + 1, 0, copy);
    setRows(next);
  };

  const removeRow = (idx: number) => {
    setRows((prev) => prev.filter((_, k) => k !== idx));
  };

  const evaluatedRows = useMemo(() => rows.map((r) => ({ row: r, eval: evaluateSkillCase(r) })), [rows]);
  const totalFloat = evaluatedRows.reduce((s, x) => s + x.eval.floatDamage * x.row.weight, 0);
  const totalFloored = evaluatedRows.reduce((s, x) => s + x.eval.flooredDamage * x.row.weight, 0);

  const singleEval = useMemo(() => evaluateSkillCase(singleSkillInput), [singleSkillInput]);

  const copySheetText = async () => {
    const lines: string[] = [];
    const idText = text.get("personalities", preset.actor.identityId).value as NamedText | undefined;
    lines.push(`${idText?.name ?? preset.actor.identityId} 轮伤 ${totalFloat.toFixed(1)}（取整 ${Math.round(totalFloored)}）`);
    for (const { row, eval: ev } of evaluatedRows) {
      lines.push(`${row.slotLabel}（${row.caseName}）：${ev.coinExpr}`);
      lines.push(`${ev.formulaText}${row.weight !== 1 ? `  [权重 ×${row.weight}]` : ""}`);
    }
    const sumTerms = evaluatedRows
      .filter((x) => x.row.weight > 0)
      .map((x) => `${x.eval.floatDamage.toFixed(2)}${x.row.weight === 1 ? "" : `*${x.row.weight}`}`);
    lines.push(`轮伤：${sumTerms.join(" + ")} = ${totalFloat.toFixed(2)}`);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3 style={{ marginBottom: 2 }}>Excel 多情况轮伤工作表（支持同技能分情况对比）</h3>
          <div className="muted small">
            点技能行右侧「+ 分情况」即可并列对比「常态 vs 强化形态」「吃到 1 回合易损 vs 未吃到」「前段 10% vs 尾币 20%」，并按权重（支持 0.5）加权算轮伤。
          </div>
        </div>
        <div className="row-actions">
          <button
            type="button"
            onClick={() =>
              setRows((prev) => [
                ...prev,
                {
                  id: `custom-${Date.now()}`,
                  slotLabel: "自定义",
                  caseName: "手填情况",
                  basePower: 4,
                  coinScale: 6,
                  operator: "ADD",
                  coinCount: 3,
                  rerollCount: 0,
                  levelDelta: 4,
                  resistOffset: 0,
                  isCrit: false,
                  dmgBonusPct: 30,
                  tailDmgBonusPct: null,
                  rerollExtraRatioPct: 0,
                  weight: 1,
                },
              ])
            }
          >
            + 新增手填行
          </button>
          <button type="button" onClick={() => setRows(buildDefaultRows())}>
            重置为当前预设
          </button>
          <button type="button" className="primary" onClick={copySheetText}>
            {copied ? "✓ 已复制算式文本" : "复制算式文本"}
          </button>
        </div>
      </div>

      {identityBuffHints.length > 0 && (
        <div className="passive-quick-bar" style={{ marginBottom: 10 }}>
          <span className="muted small">本角色技能施加的状态/易损速查（可据此分情况填增伤或抗性）：</span>
          {identityBuffHints.slice(0, 10).map((h, i) => (
            <span key={i} className="tag" title={`${h.skillSlot} 对${h.target}施加（${h.round}）`}>
              {h.skillSlot} → {h.target}:{h.buffName} ({h.round})
            </span>
          ))}
        </div>
      )}

      <div className="table-scroll">
        <table className="data compact rotation" style={{ minWidth: 0 }}>
          <thead>
            <tr>
              <th style={{ width: 48 }}>技能</th>
              <th style={{ width: 120 }}>情况（可改名）</th>
              <th className="num" title="基础威力">基础</th>
              <th className="num" title="硬币威力">币威</th>
              <th className="num" title="硬币枚数">币数</th>
              <th className="num" title="尾币重投次数">重投</th>
              <th className="num" title="攻防等级差 Δ">攻防Δ</th>
              <th className="num" title="抗性修正（如怠惰抗性降低 +0.1 填 0.1）">抗性±</th>
              <th style={{ width: 36 }} title="暴击 (+0.2)">暴</th>
              <th className="num" title="前段硬币增伤+易损总百分比（如 +80% 填 80）">增伤%</th>
              <th className="num" title="尾币/重投币若在中途挂上易损后享受更高增伤，可单独填写（留空则同左）">尾币%</th>
              <th className="num" title="重投币命中时额外追伤比例%（如 30%）">追伤%</th>
              <th>自动推导算式</th>
              <th className="num">单发</th>
              <th className="num" style={{ width: 54 }}>权重</th>
              <th style={{ width: 72 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {evaluatedRows.map(({ row, eval: ev }, idx) => (
              <tr key={row.id}>
                <td>
                  <input
                    style={{ width: 44, padding: "2px 4px" }}
                    value={row.slotLabel}
                    onChange={(e) => updateRow(idx, { slotLabel: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    style={{ width: "100%", minWidth: 96, padding: "2px 6px" }}
                    value={row.caseName}
                    onChange={(e) => updateRow(idx, { caseName: e.target.value })}
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    style={{ width: 42, padding: "2px 4px" }}
                    value={row.basePower}
                    onChange={(e) => updateRow(idx, { basePower: Number(e.target.value) || 0 })}
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    style={{ width: 42, padding: "2px 4px" }}
                    value={row.coinScale}
                    onChange={(e) => updateRow(idx, { coinScale: Number(e.target.value) || 0 })}
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    min={1}
                    max={10}
                    style={{ width: 38, padding: "2px 4px" }}
                    value={row.coinCount}
                    onChange={(e) => updateRow(idx, { coinCount: Math.max(1, Number(e.target.value) || 1) })}
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    min={0}
                    max={5}
                    style={{ width: 38, padding: "2px 4px" }}
                    value={row.rerollCount}
                    onChange={(e) => updateRow(idx, { rerollCount: Math.max(0, Number(e.target.value) || 0) })}
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    style={{ width: 44, padding: "2px 4px" }}
                    value={row.levelDelta}
                    onChange={(e) => updateRow(idx, { levelDelta: Number(e.target.value) || 0 })}
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    step={0.1}
                    style={{ width: 44, padding: "2px 4px" }}
                    value={row.resistOffset}
                    onChange={(e) => updateRow(idx, { resistOffset: Number(e.target.value) || 0 })}
                  />
                </td>
                <td style={{ textAlign: "center" }}>
                  <input
                    type="checkbox"
                    checked={row.isCrit}
                    onChange={(e) => updateRow(idx, { isCrit: e.target.checked })}
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    step={5}
                    style={{ width: 48, padding: "2px 4px" }}
                    value={row.dmgBonusPct}
                    onChange={(e) => updateRow(idx, { dmgBonusPct: Number(e.target.value) || 0 })}
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    step={5}
                    placeholder="同左"
                    style={{ width: 48, padding: "2px 4px" }}
                    value={row.tailDmgBonusPct ?? ""}
                    onChange={(e) =>
                      updateRow(idx, {
                        tailDmgBonusPct: e.target.value === "" ? null : Number(e.target.value) || 0,
                      })
                    }
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    step={5}
                    style={{ width: 44, padding: "2px 4px" }}
                    value={row.rerollExtraRatioPct}
                    onChange={(e) => updateRow(idx, { rerollExtraRatioPct: Number(e.target.value) || 0 })}
                  />
                </td>
                <td>
                  <div>
                    <code className="coin-expr">{ev.coinExpr}</code>{" "}
                    <span className="muted small">({ev.rollSum}点)</span>
                  </div>
                  <div className="cell-sub">
                    <code>{ev.formulaText}</code>
                  </div>
                </td>
                <td className="num">
                  <b>{ev.floatDamage.toFixed(2)}</b>
                  <div className="cell-sub">取整 {ev.flooredDamage}</div>
                </td>
                <td className="num">
                  <input
                    type="number"
                    step={0.5}
                    min={0}
                    style={{ width: 48, padding: "2px 4px", textAlign: "right" }}
                    value={row.weight}
                    onChange={(e) => updateRow(idx, { weight: Math.max(0, Number(e.target.value) || 0) })}
                  />
                </td>
                <td>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button
                      type="button"
                      className="link small"
                      onClick={() => duplicateRow(idx)}
                      title="复制该技能并新增一种情况（例如对比吃到易损 vs 没吃到易损）"
                    >
                      +分情况
                    </button>
                    <button
                      type="button"
                      className="slot-del"
                      onClick={() => removeRow(idx)}
                      aria-label="删除该情况行"
                    >
                      ×
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rotation-summary">
        <div>
          <span className="muted">Excel 加权轮伤：</span>
          <code className="summary-line">
            {evaluatedRows
              .filter((x) => x.row.weight > 0)
              .map((x) => `${x.eval.floatDamage.toFixed(2)}${x.row.weight === 1 ? "" : `×${x.row.weight}`}`)
              .join(" + ")}{" "}
            = <b>{totalFloat.toFixed(2)}</b>
          </code>
          <span className="muted small" style={{ marginLeft: 10 }}>
            （游戏逐币向下取整口径：<b>{Math.round(totalFloored * 100) / 100}</b>）
          </span>
        </div>
        <div className="muted small">
          权重合计：{evaluatedRows.reduce((s, x) => s + x.row.weight, 0)} 个技能/轮
        </div>
      </div>

      {/* Standalone Quick Single-Skill Calculator (for no-metadata / quick check) */}
      <details className="disclosure" style={{ marginTop: 14 }}>
        <summary style={{ fontWeight: 600, color: "var(--text-1)" }}>
          <span>⚡ 独立单技能快速计算器（无元数据纯手算 / 新人格 PV 速算）</span>
          <span className="muted small" style={{ marginLeft: 8, fontWeight: 400 }}>
            当前结果：{singleEval.formulaText}（取整 {singleEval.flooredDamage}）
          </span>
        </summary>
        <div className="disclosure-body">
          <div className="row" style={{ gap: "10px 14px" }}>
            <label className="field">
              <span>基础威力</span>
              <input
                type="number"
                style={{ width: 72 }}
                value={singleSkillInput.basePower}
                onChange={(e) => setSingleSkillInput((p) => ({ ...p, basePower: Number(e.target.value) || 0 }))}
              />
            </label>
            <label className="field">
              <span>硬币变动</span>
              <input
                type="number"
                style={{ width: 72 }}
                value={singleSkillInput.coinScale}
                onChange={(e) => setSingleSkillInput((p) => ({ ...p, coinScale: Number(e.target.value) || 0 }))}
              />
            </label>
            <label className="field">
              <span>硬币类型</span>
              <select
                value={singleSkillInput.operator}
                onChange={(e) => setSingleSkillInput((p) => ({ ...p, operator: e.target.value as "ADD" | "SUB" }))}
              >
                <option value="ADD">加算 (+)</option>
                <option value="SUB">减算 (−)</option>
              </select>
            </label>
            <label className="field">
              <span>硬币枚数</span>
              <input
                type="number"
                min={1}
                max={10}
                style={{ width: 68 }}
                value={singleSkillInput.coinCount}
                onChange={(e) => setSingleSkillInput((p) => ({ ...p, coinCount: Math.max(1, Number(e.target.value) || 1) }))}
              />
            </label>
            <label className="field">
              <span>尾币重投次数</span>
              <input
                type="number"
                min={0}
                max={5}
                style={{ width: 68 }}
                value={singleSkillInput.rerollCount}
                onChange={(e) => setSingleSkillInput((p) => ({ ...p, rerollCount: Math.max(0, Number(e.target.value) || 0) }))}
              />
            </label>
            <label className="field">
              <span>攻防等级差 Δ</span>
              <input
                type="number"
                style={{ width: 72 }}
                value={singleSkillInput.levelDelta}
                onChange={(e) => setSingleSkillInput((p) => ({ ...p, levelDelta: Number(e.target.value) || 0 }))}
              />
            </label>
            <label className="field">
              <span>抗性修正 ±</span>
              <input
                type="number"
                step={0.1}
                style={{ width: 72 }}
                value={singleSkillInput.resistOffset}
                onChange={(e) => setSingleSkillInput((p) => ({ ...p, resistOffset: Number(e.target.value) || 0 }))}
              />
            </label>
            <label className="field">
              <span>增伤+易损 %</span>
              <input
                type="number"
                step={5}
                style={{ width: 78 }}
                value={singleSkillInput.dmgBonusPct}
                onChange={(e) => setSingleSkillInput((p) => ({ ...p, dmgBonusPct: Number(e.target.value) || 0 }))}
              />
            </label>
            <label className="field">
              <span>尾币单独增伤 %</span>
              <input
                type="number"
                step={5}
                placeholder="同左"
                style={{ width: 78 }}
                value={singleSkillInput.tailDmgBonusPct ?? ""}
                onChange={(e) =>
                  setSingleSkillInput((p) => ({
                    ...p,
                    tailDmgBonusPct: e.target.value === "" ? null : Number(e.target.value) || 0,
                  }))
                }
              />
            </label>
            <label className="field">
              <span>重投追伤 %</span>
              <input
                type="number"
                step={5}
                style={{ width: 72 }}
                value={singleSkillInput.rerollExtraRatioPct}
                onChange={(e) => setSingleSkillInput((p) => ({ ...p, rerollExtraRatioPct: Number(e.target.value) || 0 }))}
              />
            </label>
            <label className="field inline" style={{ alignSelf: "center", marginTop: 14 }}>
              <input
                type="checkbox"
                checked={singleSkillInput.isCrit}
                onChange={(e) => setSingleSkillInput((p) => ({ ...p, isCrit: e.target.checked }))}
              />
              <span>暴击 (+0.2)</span>
            </label>
          </div>
          <div className="community-skill" style={{ marginTop: 10 }}>
            <div className="line1">
              <b>硬币展开：</b>
              <code className="hl">{singleEval.coinExpr}</code>
              <span>→</span>
              <code>{singleEval.coinPowers.map((c) => `${c.power}${c.isReroll ? "(重投)" : ""}`).join(" + ")}</code>
              <span>=</span>
              <b>满正总点数 {singleEval.rollSum}</b>
            </div>
            <div className="line2">
              <b>完整算式：</b>
              <code className="hl" style={{ fontSize: 15 }}>
                {singleEval.formulaText}
              </code>
              <span className="tag gold">游戏逐币取整：{singleEval.flooredDamage}</span>
              <button
                type="button"
                className="link small"
                onClick={() =>
                  setRows((prev) => [
                    ...prev,
                    { ...singleSkillInput, id: `from-single-${Date.now()}` },
                  ])
                }
              >
                + 加入上方轮伤工作表
              </button>
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}
