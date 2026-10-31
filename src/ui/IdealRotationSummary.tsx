/**
 * 理想轮伤一图流 — the one place that answers "what is the ideal wheel damage, in what order,
 * under which conditions", built straight from the simulated rotation.
 *
 * Constraint brief (refactoring-ui, Workflow B):
 *   Primary   : the wheel damage number (one big figure) + the one primary action "复制一图流图片".
 *   Secondary : skill order (turn chips) and the per-skill formula list.
 *   Tertiary  : conditions / assumptions, precision toggle, download / text copy.
 *   Tokens    : existing styles.css tokens only (--surface, --text-1/2/3, --accent, --p-*, --s-*, --t-*).
 */
import { useMemo, useState } from "react";
import type { CoreData, NamedText, SkillText, TextResolver } from "../data/game-data";
import type { Preset } from "../config/preset-types";
import { readExternalBuffs, type ExternalBuff } from "../config/external-buffs";
import { buildRotationTable, type VariantRow } from "../engine/rotation-table";
import type { SimulationResult } from "../engine/simulator";
import { BONUS_TIER_LABEL, type BonusTier } from "../engine/bonus-tier";
import { skillRole } from "./skill-labels";
import { copyPngBlobToClipboard, downloadPngDataUrl, renderOnePagerPng, type OnePagerCardData } from "./one-pager-image";

const r2 = (n: number) => Math.round(n * 100) / 100;
const fmtW = (w: number) => (Number.isInteger(w) ? String(w) : String(r2(w)));

function buffEffectText(b: ExternalBuff): string {
  const parts: string[] = [];
  if (b.offenseLevel) parts.push(`攻等${b.offenseLevel > 0 ? "+" : ""}${b.offenseLevel}`);
  if (b.basePower) parts.push(`基础威力${b.basePower > 0 ? "+" : ""}${b.basePower}`);
  if (b.coinPower) parts.push(`币威${b.coinPower > 0 ? "+" : ""}${b.coinPower}`);
  if (b.finalPower) parts.push(`最终威力${b.finalPower > 0 ? "+" : ""}${b.finalPower}`);
  if (b.dmgPct) parts.push(`增伤${b.dmgPct > 0 ? "+" : ""}${b.dmgPct}%`);
  if (b.takeDmgPct) parts.push(`易损${b.takeDmgPct > 0 ? "+" : ""}${b.takeDmgPct}%`);
  const scope: string[] = [];
  if (b.onlyConsumesCharge) scope.push("仅耗充能技能");
  if (b.slot) scope.push(`仅${b.slot}`);
  return `${parts.join("、") || "无数值"}${scope.length ? `（${scope.join("，")}）` : ""}`;
}

export function IdealRotationSummary({
  core,
  text,
  preset,
  simResult,
  bonusTier,
}: {
  core: CoreData;
  text: TextResolver;
  preset: Preset;
  simResult: SimulationResult | null;
  bonusTier: BonusTier;
}) {
  const [useFloat, setUseFloat] = useState(true);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const slotOf = useMemo(() => (id: number) => core.skills[String(id)]?.slot ?? undefined, [core.skills]);
  const table = useMemo(
    () => (simResult ? buildRotationTable(simResult, slotOf, { normalizeToSixSkills: true }) : null),
    [simResult, slotOf],
  );

  const identityName = useMemo(() => {
    const v = text.get("personalities", preset.actor.identityId).value as NamedText | undefined;
    const title = (v?.title ?? "").replace(/\n/g, " ").trim();
    return `${title ? `${title} ` : ""}${v?.name ?? preset.actor.identityId}`;
  }, [text, preset.actor.identityId]);

  const buffs = useMemo(() => readExternalBuffs(preset.actor.externalBuffs).filter((b) => b.enabled), [preset.actor.externalBuffs]);

  if (!simResult || !table || table.variants.length === 0) {
    return (
      <div className="ideal-card">
        <div className="ideal-empty">
          <b>还没有可计算的排轴</b>
          <span>在下方「手动排轴」点「按技能组填充」或直接在回合格里选技能，这里就会给出理想轮伤、出招顺序和成立条件。</span>
        </div>
      </div>
    );
  }

  const weightOf = (v: VariantRow) => r2(v.count * table.sixSkillScale);
  const unit = (v: VariantRow) => (useFloat ? v.floatDamage : v.damage);
  const wheelDirect = r2(table.variants.reduce((s, v) => s + unit(v) * weightOf(v), 0));
  const wheelTotal = r2(wheelDirect + table.totalDot);
  const otherTotal = r2((useFloat ? table.totalDirect : table.totalFloatDirect) + table.totalDot);

  const skillName = (id: number) => (text.get("skills", id).value as SkillText | undefined)?.name ?? `#${id}`;

  // Turn-by-turn order
  const byTurn = new Map<number, { label: string; short: string; enhanced: boolean }[]>();
  for (const row of table.rows) {
    if (row.coins.length === 0) continue;
    const role = skillRole(core, row.skillId);
    const enhanced = row.coins.some((c) => c.isRerolled);
    const list = byTurn.get(row.turn) ?? [];
    list.push({ label: role.label, short: role.short, enhanced });
    byTurn.set(row.turn, list);
  }
  const turns = [...byTurn.entries()].sort((a, b) => a[0] - b[0]);
  const shortSeq = turns.map(([, acts]) => acts.map((a) => a.short).join("+")).join("");
  const groupedShort = (() => {
    // community style: groups of 4 turns separated by "，"
    const chunks: string[] = [];
    for (let i = 0; i < turns.length; i += 4) {
      chunks.push(turns.slice(i, i + 4).map(([, acts]) => acts.map((a) => a.short).join("+")).join(""));
    }
    return chunks.join("，");
  })();

  const offenseBuffs = buffs.filter((b) => b.offenseLevel);
  const dmgBuffs = buffs.filter((b) => b.dmgPct || b.takeDmgPct || b.basePower || b.coinPower || b.finalPower);
  const tgt = ((preset.scenario as { target?: Record<string, unknown> } | undefined)?.target ?? {}) as Record<string, unknown>;
  const defLv = typeof tgt.defenseLevel === "number" ? tgt.defenseLevel : null;
  const lv = preset.actor.level ?? 65;

  const conditions: string[] = [
    `四破 Lv.${lv}，${simResult.coinMode === "allHeads" ? "硬币全正面" : simResult.coinMode === "allTails" ? "硬币全反面" : "期望值"}`,
    `目标防御等级 ${defLv ?? `${lv}（同级）`}，抗性按目标参数`,
    `开局状态：${BONUS_TIER_LABEL[bonusTier]}${bonusTier !== "none" && preset.actor.identityId === 10617 ? "（保存 6 级 / 20 层、精纺大衣 14 层，视为已暖机）" : ""}`,
  ];
  if (table.actionCount !== 6) {
    conditions.push(`共 ${table.actionCount} 个动作，已按 ×${r2(table.sixSkillScale)} 折算为标准 6 技能一轮（权重 = 出现次数 × ${r2(table.sixSkillScale)}）`);
  }
  if (!simResult.exact) conditions.push(`含 ${simResult.gaps.length} 项未建模效果，结果只计已建模部分`);

  const variantLine = (v: VariantRow) => {
    const role = skillRole(core, v.skillId);
    const turnsText = `T${v.turns.join(",")}`;
    return { role, turnsText, formula: `${v.fracText}×${v.segmentedRollExpr.replace(/ /g, "")}` };
  };

  const buildCardData = (): OnePagerCardData => ({
    title: `${identityName} 轮伤 ${wheelTotal}`,
    firstMultLine: `第一乘区：${offenseBuffs.length ? offenseBuffs.map((b) => `${b.name}${b.offenseLevel > 0 ? "+" : ""}${b.offenseLevel}`).join("，") : "无外部攻等"}`,
    dmgBonusLine: `常驻增伤：${dmgBuffs.length ? dmgBuffs.map((b) => `${b.name} ${buffEffectText(b)}`).join("，") : "无外部增伤"}`,
    conditionLine: conditions.join("；"),
    skillBlocks: table.variants.map((v) => {
      const { role, turnsText, formula } = variantLine(v);
      return {
        header: `${role.label}（${skillName(v.skillId)}）：${v.coinExpr}`,
        lines: [`${formula}=${r2(unit(v)).toFixed(2)}（${turnsText}${weightOf(v) !== 1 ? ` · 权重${fmtW(weightOf(v))}` : ""}）`],
      };
    }),
    wheelFormulaLine: `${table.variants.map((v) => `${r2(unit(v)).toFixed(2)}${weightOf(v) === 1 ? "" : `*${fmtW(weightOf(v))}`}`).join("+")}${table.totalDot ? `+DOT ${table.totalDot}` : ""}=${wheelTotal}`,
    scheduleLine: `（技能顺序：${groupedShort}）`,
  });

  const doRender = async (action: "copy" | "download" | "preview") => {
    setBusy(true);
    try {
      const { dataUrl, blob } = await renderOnePagerPng(buildCardData(), "light");
      if (action === "copy") {
        const ok = await copyPngBlobToClipboard(blob);
        if (ok) setFlash("已复制 PNG 图片，可直接粘贴到 QQ / 微信 / 群聊");
        else {
          downloadPngDataUrl(dataUrl, `${identityName}-轮伤${wheelTotal}.png`);
          setFlash("当前环境不支持写入图片剪贴板，已改为下载 PNG");
        }
      } else if (action === "download") {
        downloadPngDataUrl(dataUrl, `${identityName}-轮伤${wheelTotal}.png`);
        setFlash("已下载 PNG");
      } else {
        setPreview(dataUrl);
      }
    } catch (e) {
      setFlash(`生成图片失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setTimeout(() => setFlash(null), 2600);
    }
  };

  const copyText = async () => {
    const d = buildCardData();
    const lines = [d.title, d.firstMultLine, d.dmgBonusLine, d.conditionLine ?? "", ""];
    for (const b of d.skillBlocks) lines.push(b.header, ...b.lines);
    lines.push("", "轮伤：", d.wheelFormulaLine, d.scheduleLine);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setFlash("已复制文字版");
    } catch {
      setFlash("复制失败");
    }
    setTimeout(() => setFlash(null), 2000);
  };

  return (
    <div className="ideal-card">
      <div className="ideal-head">
        <div>
          <div className="ideal-eyebrow">理想轮伤 · 标准 6 技能一轮</div>
          <div className="ideal-number">
            {wheelTotal}
            <small>{useFloat ? "社区小数口径" : "游戏逐币取整"} · 另一口径 {otherTotal}</small>
          </div>
        </div>
        <div className="ideal-actions">
          <button type="button" className="primary" onClick={() => doRender("copy")} disabled={busy}>
            {busy ? "生成中…" : "复制一图流图片"}
          </button>
          <button type="button" onClick={() => doRender("preview")} disabled={busy}>预览</button>
          <button type="button" onClick={() => doRender("download")} disabled={busy}>下载 PNG</button>
          <button type="button" className="link" onClick={copyText}>复制文字</button>
        </div>
      </div>
      {flash && <div className="ideal-flash">{flash}</div>}

      <section className="ideal-section">
        <h4>出招顺序</h4>
        <div className="ideal-turns">
          {turns.map(([t, acts]) => (
            <div key={t} className={`ideal-turn ${acts.some((a) => a.enhanced) ? "enh" : ""}`}>
              <span className="t">T{t}</span>
              <span className="s">{acts.map((a) => a.label).join(" + ")}</span>
              {acts.some((a) => a.enhanced) && <span className="e">强化</span>}
            </div>
          ))}
        </div>
        <div className="ideal-sub">简写：{groupedShort || shortSeq}　·　金色描边 = 处于强化形态（硬币重投）</div>
      </section>

      <section className="ideal-section">
        <h4>各技能算式</h4>
        <ul className="ideal-formulas">
          {table.variants.map((v) => {
            const { role, turnsText, formula } = variantLine(v);
            const w = weightOf(v);
            return (
              <li key={v.key}>
                <div className="name">
                  <b>{role.label}</b> <span className="muted">{skillName(v.skillId)} · {turnsText}</span>
                </div>
                <code className="f">{formula} = <b>{r2(unit(v)).toFixed(2)}</b></code>
                <span className="w">×{fmtW(w)} = {r2(unit(v) * w).toFixed(2)}</span>
              </li>
            );
          })}
        </ul>
        <div className="ideal-sum">
          <code>
            {table.variants.map((v) => `${r2(unit(v)).toFixed(2)}${weightOf(v) === 1 ? "" : `×${fmtW(weightOf(v))}`}`).join(" + ")}
            {table.totalDot ? ` + DOT ${table.totalDot}` : ""} = <b>{wheelTotal}</b>
          </code>
          <button type="button" className="chip" onClick={() => setUseFloat((x) => !x)}>
            切换到{useFloat ? "游戏取整" : "社区小数"}
          </button>
        </div>
      </section>

      <section className="ideal-section">
        <h4>成立条件</h4>
        <ul className="ideal-conds">
          {conditions.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
          {buffs.length === 0 ? (
            <li>未加外部 Buff（队友 / 被动 / E.G.O 加成在下方「支援被动 / 队友 Buff」添加）</li>
          ) : (
            buffs.map((b) => (
              <li key={b.id}>
                <b>{b.name}</b>：{buffEffectText(b)}
              </li>
            ))
          )}
        </ul>
      </section>

      {preview && (
        <div className="ideal-preview" onClick={() => setPreview(null)} role="presentation">
          <img src={preview} alt="一图流预览" />
          <span className="muted small">点击任意处关闭</span>
        </div>
      )}
    </div>
  );
}
