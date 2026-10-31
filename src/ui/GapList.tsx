/**
 * Coverage status of a simulation, written for players:
 *  - one badge (精确 / 近似 / N 项影响伤害的效果未建模)
 *  - details grouped by impact; harmless items are collapsed
 */
import type { SimulationResult, Gap, GapImpact } from "../engine/simulator";
import type { NamedText, SkillText, TextResolver } from "../data/game-data";
import { stripRichTags } from "./RichText";

const GROUPS: { impact: GapImpact; title: string; hint: string; open: boolean }[] = [
  { impact: "damage", title: "影响伤害、尚未建模", hint: "这些效果会改变伤害，但计算器还没有实现，结果只包含已实现的部分。可以在技能组里用手动修正补上。", open: true },
  { impact: "approx", title: "近似假设", hint: "按下面的假设计算，与实战可能有出入。", open: false },
  { impact: "untriggered", title: "本场景不会触发", hint: "只在拼点胜负、击杀、受击、闪避等情况下生效，单方面出手的模拟中不会发生。", open: false },
  { impact: "none", title: "不影响伤害（已忽略）", hint: "根据游戏逻辑，这些效果只影响理智、回复、护盾、拼点威力、目标选择或演出。", open: false },
];

const KIND_LABEL: Record<Gap["kind"], string> = {
  effect: "技能效果",
  passive: "被动",
  status: "状态",
  scenario: "场景",
  skill: "技能",
  extraDamage: "追伤",
};

function gapTitle(g: Gap, text: TextResolver): string {
  if (g.kind === "effect" && g.skillId != null) {
    const st = text.get("skills", g.skillId).value as SkillText | undefined;
    const name = stripRichTags(st?.name ?? `技能 ${g.skillId}`);
    return `${name}${g.coinIndex != null ? ` · 硬币 ${g.coinIndex + 1}` : ""}`;
  }
  if (g.kind === "passive") {
    const pv = text.get("passives", Number(g.id)).value as NamedText | undefined;
    return stripRichTags(pv?.name ?? `被动 ${g.id}`);
  }
  if (g.kind === "status") {
    const kw = text.keywordInfo(g.id);
    return `${stripRichTags(kw.name ?? g.id)}${g.where ? `（${g.where}）` : ""}`;
  }
  return g.where ? `${g.id}（${g.where}）` : g.id;
}

export function QualityBadge({ result }: { result: SimulationResult }) {
  const damage = result.gaps.filter((g) => (g.impact ?? "damage") === "damage").length;
  const approx = result.gaps.filter((g) => g.impact === "approx").length;
  if (result.quality === "exact") return <span className="tag ok">✓ 精确：所有影响伤害的效果均已建模</span>;
  if (result.quality === "approx") return <span className="tag gold">≈ 近似：已建模，含 {approx} 项假设</span>;
  return <span className="tag err">⚠ {damage} 项影响伤害的效果未建模</span>;
}

export function GapList({ result, text }: { result: SimulationResult; text: TextResolver }) {
  if (!result.gaps.length) return null;
  return (
    <div className="gap-groups" style={{ marginTop: 16, display: "grid", gap: 8 }}>
      {GROUPS.map((grp) => {
        const items = result.gaps.filter((g) => (g.impact ?? "damage") === grp.impact);
        if (!items.length) return null;
        return (
          <details key={grp.impact} className={`disclosure gap-group gap-${grp.impact}`} open={grp.open}>
            <summary>
              <span>
                {grp.title} <span className="muted">（{items.length}）</span>
              </span>
            </summary>
            <div className="disclosure-body">
              <p className="small muted" style={{ margin: "0 0 8px" }}>{grp.hint}</p>
              <ul className="gap-list">
                {items.map((g, i) => (
                  <li key={i}>
                    <span className={`tag ${grp.impact === "damage" ? "warn" : ""}`}>{KIND_LABEL[g.kind]}</span>
                    <div>
                      <b>{gapTitle(g, text)}</b>
                      <span className="muted small"> · {g.reason ?? g.message}</span>
                      {g.kind === "effect" && <code className="small muted" style={{ marginLeft: 6 }}>{g.id}</code>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </details>
        );
      })}
    </div>
  );
}
