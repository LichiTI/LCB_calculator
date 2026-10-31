/**
 * Rotation damage table — the spreadsheet players keep in Excel:
 * one row per skill variant (三技能 · 听讲T1 / 三技能 · 听讲T2 …), each with the coin
 * expression, the level fraction, segmented multipliers and the damage, then a weighted sum.
 */
import { useMemo, useState } from "react";
import type { CoreData, TextResolver, SkillText } from "../data/game-data";
import type { Preset } from "../config/preset-types";
import { buildRotationTable, type VariantRow } from "../engine/rotation-table";
import type { SimulationResult } from "../engine/simulator";
import { ColoredText } from "./RichText";
import { skillRole } from "./skill-labels";

export function RotationDamageTable({
  core,
  text,
  preset,
  simResult,
}: {
  core: CoreData;
  text: TextResolver;
  preset: Preset;
  simResult: SimulationResult | null;
}) {
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [normalizeToSix, setNormalizeToSix] = useState(true);
  const [useFloatDmg, setUseFloatDmg] = useState(false);
  const [copied, setCopied] = useState(false);

  const slotOf = useMemo(() => (skillId: number) => core.skills[String(skillId)]?.slot ?? undefined, [core.skills]);

  const table = useMemo(
    () =>
      simResult
        ? buildRotationTable(simResult, slotOf, {
            weights,
            normalizeToSixSkills: normalizeToSix,
          })
        : null,
    [simResult, slotOf, weights, normalizeToSix],
  );

  if (!simResult || !table || table.variants.length === 0) return null;

  const skillTitle = (v: VariantRow) => {
    const t = text.get("skills", v.skillId).value as SkillText | undefined;
    return t?.name ?? String(v.skillId);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(table.textBlock);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const round2 = (n: number) => Math.round(n * 100) / 100;

  return (
    <div className="panel rotation-table">
      <div className="panel-head">
        <h3 style={{ marginBottom: 0 }}>
          轮伤精算表
          {table.actionCount !== 6 && normalizeToSix && (
            <span className="tag gold" style={{ marginLeft: 8 }}>
              已由 {table.actionCount} 动折算为 6 技能标准轮 (×{(6 / table.actionCount).toFixed(2)})
            </span>
          )}
        </h3>
        <div className="row-actions">
          {table.actionCount !== 6 && (
            <button
              type="button"
              className={`chip ${normalizeToSix ? "on" : ""}`}
              onClick={() => {
                setNormalizeToSix((v) => !v);
                setWeights({});
              }}
              title="当排轴为 12 动（双轮或双槽）时，开启后自动将各形态次数除以 2（如 3 次 → 1.5 次/轮，1 次 → 0.5 次/轮），方便与标准 6 技能一轮横向对比"
            >
              {normalizeToSix ? "✓ 折算 6 技能标准轮" : `按 ${table.actionCount} 动原始总伤`}
            </button>
          )}
          <button
            type="button"
            className={`chip ${useFloatDmg ? "on" : ""}`}
            onClick={() => setUseFloatDmg((v) => !v)}
            title="切换游戏内逐币向下取整伤害 vs 社区表格不取整精确小数伤害"
          >
            {useFloatDmg ? "口径：社区精确小数" : "口径：游戏逐币取整"}
          </button>
          <button type="button" onClick={copy}>
            {copied ? "已复制" : "复制为纯文本"}
          </button>
        </div>
      </div>

      <div className="table-scroll">
        <table className="data rotation">
          <thead>
            <tr>
              <th>技能 · 情境</th>
              <th>硬币展开（满正）</th>
              <th className="num">点数</th>
              <th className="num">第一乘区</th>
              <th className="num">第二乘区（分段增伤）</th>
              <th className="num">单次伤害</th>
              <th className="num" style={{ width: 78 }}>权重</th>
              <th className="num">合计</th>
            </tr>
          </thead>
          <tbody>
            {table.variants.map((v) => {
              const defaultW = round2(v.count * table.sixSkillScale);
              const w = weights[v.key] ?? defaultW;
              const unitDmg = useFloatDmg ? v.floatDamage : v.damage;
              return (
                <tr key={v.key}>
                  <td>
                    <div className="cell-main">
                      {skillRole(core, v.skillId).label} <ColoredText text={skillTitle(v)} />
                    </div>
                    <div className="cell-sub">T{v.turns.join(",")}{v.dynMultText !== "×1.00" ? ` · 增伤${v.dynMultText}` : ""}</div>
                  </td>
                  <td>
                    <code className="coin-expr">{v.coinExpr}</code>
                    {v.crit && <span className="tag gold" style={{ marginLeft: 6 }}>暴击</span>}
                    {v.extra > 0 && <span className="tag info" style={{ marginLeft: 6 }}>追伤 +{v.extra}</span>}
                    {v.dotHp > 0 && <span className="tag" style={{ marginLeft: 6 }}>DOT伤害 +{v.dotHp}</span>}
                  </td>
                  <td className="num">{v.rollSum}</td>
                  <td className="num">
                    <code>{v.fracText}</code>
                    <div className="cell-sub">
                      {(v.staticMult * 100).toFixed(1)}%
                      {v.crit ? ` · 暴击+${Math.round(v.critTerm * 100)}%` : ""}
                      {v.sinResTerm || v.atkResTerm ? ` · 抗性${((v.sinResTerm + v.atkResTerm) * 100).toFixed(0)}%` : ""}
                    </div>
                  </td>
                  <td className="num">
                    <div>{v.dynMultText}</div>
                    {v.dynMultText.includes("→") && <div className="cell-sub">{v.segmentedRollExpr}</div>}
                  </td>
                  <td className="num">
                    <b>{useFloatDmg ? v.floatDamage.toFixed(2) : v.damage}</b>
                    <div className="cell-sub">
                      {useFloatDmg ? `取整 ${v.damage}` : `精确 ${v.floatDamage.toFixed(2)}`}
                    </div>
                  </td>
                  <td className="num">
                    <input
                      type="number"
                      step={0.5}
                      min={0}
                      style={{ width: 64, textAlign: "right" }}
                      value={w}
                      aria-label="权重"
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        setWeights((prev) => ({ ...prev, [v.key]: Number.isFinite(n) ? Math.max(0, n) : defaultW }));
                      }}
                    />
                  </td>
                  <td className="num">
                    <b>{useFloatDmg ? (unitDmg * w).toFixed(2) : round2(unitDmg * w)}</b>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="rotation-summary">
        <div>
          <span className="muted">{useFloatDmg ? "社区小数直伤：" : "游戏取整直伤："}</span>
          <code className="summary-line">{useFloatDmg ? table.floatSummaryLine : table.summaryLine}</code>
          {table.totalDot > 0 && (
            <span className="muted small" style={{ marginLeft: 8 }}>
              + DOT {table.totalDot} = 轮伤{" "}
              <b>{useFloatDmg ? (table.totalFloatDirect + table.totalDot).toFixed(2) : table.total}</b>
            </span>
          )}
        </div>
        <div className="muted small">
          另一口径对照：{useFloatDmg ? `游戏逐币取整 = ${table.total}` : `社区不取整小数 = ${(table.totalFloatDirect + table.totalDot).toFixed(2)}`}
          {simResult.totals.dotSp > 0 ? ` · 沉沦扣 SP ${simResult.totals.dotSp}` : ""}
        </div>
      </div>

      {Object.keys(table.dotApplied).length > 0 && (
        <div className="rotation-dots">
          <span className="muted small">本轮施加状态（强度-层数）：</span>
          {Object.entries(table.dotApplied)
            .filter(([, v]) => v.potency > 0 || v.count > 0)
            .map(([id, v]) => (
              <span key={id} className="tag gold">
                {text.label(id) ?? id} {v.potency}-{v.count}
              </span>
            ))}
        </div>
      )}

      {simResult.dotBalance && simResult.dotBalance.length > 0 && (
        <div className="rotation-balance">
          <div className="section-title-inline">敌方 DOT 收支（能否不亏层）</div>
          <table className="data compact">
            <thead>
              <tr>
                <th>状态</th>
                <th className="num">初始</th>
                <th className="num">施加</th>
                <th className="num">消耗</th>
                <th className="num">净层数</th>
                <th className="num">结束</th>
                <th>结论</th>
              </tr>
            </thead>
            <tbody>
              {simResult.dotBalance.map((r) => {
                const net = r.countAdded - r.countConsumed;
                return (
                  <tr key={`${r.side}:${r.statusId}`}>
                    <td>
                      {text.label(r.statusId) ?? r.statusId}
                      <span className="muted small"> ({r.side === "target" ? "敌方" : "自身"})</span>
                    </td>
                    <td className="num">
                      {r.initialPotency}-{r.initialCount}
                    </td>
                    <td className="num">+{r.countAdded}</td>
                    <td className="num">−{r.countConsumed}</td>
                    <td className="num">{net >= 0 ? `+${net}` : net}</td>
                    <td className="num">
                      {r.finalPotency}-{r.finalCount}
                    </td>
                    <td>
                      {net > 0 ? (
                        <span className="tag ok">净增 +{net}</span>
                      ) : net === 0 ? (
                        <span className="tag info">刚好打平</span>
                      ) : r.finalCount > 0 ? (
                        <span className="tag warn">净减，剩 {r.finalCount}</span>
                      ) : (
                        <span className="tag err">会掉光</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
