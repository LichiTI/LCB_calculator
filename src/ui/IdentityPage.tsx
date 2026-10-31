import { useMemo, useState, type CSSProperties } from "react";
import { passiveLogic, scriptImpact } from "../engine/logic-meta";
import { MODELLED_PASSIVES } from "../engine/simulator";
import type { CoreData, NamedText, SkillText, TextResolver } from "../data/game-data";
import type { NormalizedIdentity, NormalizedSkill } from "../config/game-data";
import { DOT_IDS, RESOURCE_SIN_IDS } from "../config/status-terms";
import { classifyCoinScripts, classifySkillScript, type EffectStatus } from "../engine/effects";
import { ColoredText, RichText, stripRichTags } from "./RichText";
import { ATK_LABEL, DEF_LABEL, SIN_LABEL, sinText } from "./labels";

function identityName(text: TextResolver, id: number) {
  const r = text.get("personalities", id);
  const v = r.value as NamedText | undefined;
  return { title: (v?.title ?? "").replace(/\n/g, " "), name: v?.name ?? String(id), missing: r.missing };
}

/** Sinner display names, derived from the selected pack (most common personality name per characterId). */
function useSinnerNames(core: CoreData, text: TextResolver) {
  return useMemo(() => {
    const counts = new Map<number, Map<string, number>>();
    for (const i of core.identities) {
      const n = (text.get("personalities", i.id).value as NamedText | undefined)?.name;
      if (!n) continue;
      const m = counts.get(i.characterId) ?? new Map();
      m.set(n, (m.get(n) ?? 0) + 1);
      counts.set(i.characterId, m);
    }
    const out = new Map<number, string>();
    for (const [c, m] of counts) out.set(c, [...m].sort((a, b) => b[1] - a[1])[0]![0]);
    return out;
  }, [core, text]);
}

export function IdentityBrowser({
  core,
  text,
  selected,
  onSelect,
}: {
  core: CoreData;
  text: TextResolver;
  selected: number | null;
  onSelect: (id: number) => void;
}) {
  const [q, setQ] = useState("");
  const [sinner, setSinner] = useState(0);
  const [kw, setKw] = useState("");
  const sinners = useSinnerNames(core, text);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return core.identities
      .filter((i) => !sinner || i.characterId === sinner)
      .filter((i) => !kw || i.skillKeywords.includes(kw))
      .filter((i) => {
        if (!needle) return true;
        const n = identityName(text, i.id);
        return `${i.id} ${stripRichTags(n.title)} ${stripRichTags(n.name)}`.toLowerCase().includes(needle);
      })
      .sort((a, b) => a.characterId - b.characterId || a.id - b.id);
  }, [core, text, q, sinner, kw]);

  return (
    <div className="browser">
      <div className="filters">
        <input placeholder="搜索名称 / ID" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={sinner} onChange={(e) => setSinner(Number(e.target.value))} aria-label="罪人筛选">
          <option value={0}>全部罪人</option>
          {[...sinners]
            .sort((a, b) => a[0] - b[0])
            .map(([c, n]) => (
              <option key={c} value={c}>
                {n}
              </option>
            ))}
        </select>
        <select value={kw} onChange={(e) => setKw(e.target.value)} aria-label="关键词筛选">
          <option value="">全部关键词</option>
          <optgroup label="DOT">
            {DOT_IDS.map((d) => (
              <option key={d} value={d}>
                {text.label(d) ?? d}
              </option>
            ))}
          </optgroup>
          <optgroup label="资源">
            {RESOURCE_SIN_IDS.map((d) => (
              <option key={d} value={d}>
                {text.label(d) ?? d}
              </option>
            ))}
          </optgroup>
        </select>
      </div>
      <div className="list-count">
        {list.length} 个人格
        {(q || sinner || kw) && (
          <>
            {" · "}
            <button
              className="link accent"
              onClick={() => {
                setQ("");
                setSinner(0);
                setKw("");
              }}
            >
              清空筛选
            </button>
          </>
        )}
      </div>
      <ul className="id-list">
        {list.map((i) => {
          const n = identityName(text, i.id);
          return (
            <li key={i.id} className={selected === i.id ? "active" : ""} onClick={() => onSelect(i.id)}>
              <span className="rank">{"0".repeat(i.rank)}</span>
              <span className="id-main">
                <span className="id-title">
                  <ColoredText text={n.title || `#${i.id}`} />
                </span>
                <strong>
                  <ColoredText text={n.name} />
                </strong>
              </span>
              {n.missing ? <span className="tag warn">缺译</span> : <span className="muted small">#{i.id}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SinChip({ attr }: { attr?: string }) {
  const s = attr ? SIN_LABEL[attr] : undefined;
  return (
    <span className="sin" style={{ background: s?.color ?? "#888" }}>
      {sinText(attr)}
    </span>
  );
}

function PassiveBadge({ pid }: { pid: number }) {
  if (MODELLED_PASSIVES.has(pid)) return <span className="tag ok">已建模</span>;
  const info = passiveLogic(pid);
  if (info?.impact === "none") return <span className="tag" title={info.reason}>不影响伤害</span>;
  if (info?.impact === "untriggered") return <span className="tag" title={info.reason}>单方面出手不触发</span>;
  return <span className="tag warn" title={info?.dependsOnAlly ? "部分效果依赖队友在场" : undefined}>未建模{info?.dependsOnAlly ? "（含队友联动）" : ""}</span>;
}

type ScriptStatus = EffectStatus | "none" | "untriggered";

function StatusBadge({ status }: { status: ScriptStatus }) {
  if (status === "verified") return <span className="tag ok">已建模</span>;
  if (status === "cosmetic") return <span className="tag">仅演出</span>;
  if (status === "none") return <span className="tag" title="根据游戏逻辑，只影响理智 / 回复 / 护盾 / 拼点威力 / 目标选择">不影响伤害</span>;
  if (status === "untriggered") return <span className="tag" title="只在拼点胜负、击杀、受击等情况下触发">单方面出手不触发</span>;
  return <span className="tag warn">未建模</span>;
}

/** Unverified scripts that cannot change damage are shown as harmless instead of "未建模". */
function withImpact(status: EffectStatus, name: string, scope: "skill" | "coin"): ScriptStatus {
  if (status !== "unverified") return status;
  const i = scriptImpact(name, scope);
  return i === "damage" ? "unverified" : i;
}

export function SkillCard({ skill, text, tag }: { skill: NormalizedSkill; text: TextResolver; tag: string }) {
  const r = text.get("skills", skill.id);
  const t = r.value as SkillText | undefined;
  const sinColor = skill.attrs.attributeType ? SIN_LABEL[skill.attrs.attributeType]?.color : undefined;

  const scripts = useMemo(() => {
    const skillRows = skill.abilityScripts.map((s) => ({
      where: "技能效果",
      scriptName: s.scriptName,
      status: withImpact(classifySkillScript(s), s.scriptName, "skill"),
    }));
    const coinRows = skill.coins.flatMap((c) =>
      classifyCoinScripts(c.abilityScriptList ?? [], skill.id, c.index).map((o) => ({
        where: `硬币 ${c.index + 1}`,
        scriptName: o.scriptName,
        status: withImpact(o.status, o.scriptName, "coin"),
      })),
    );
    return [...skillRows, ...coinRows];
  }, [skill]);

  const verifiedCount = scripts.filter((s) => s.status === "verified").length;
  const unverifiedCount = scripts.filter((s) => s.status === "unverified").length;
  const lvlCorr = Number(skill.attrs.skillLevelCorrection ?? 0);

  return (
    <div className="skill-card" style={{ "--sin": sinColor } as CSSProperties}>
      <div className="skill-head">
        <SinChip attr={skill.attrs.attributeType} />
        <strong>
          <ColoredText text={t?.name ?? `技能 ${skill.id}`} />
        </strong>
        <span className="tag gold">{tag}</span>
        {r.missing && <span className="tag warn">{r.fromFallback ? `缺译→${text.fallbackName}` : "无文本"}</span>}
        <span className="meta">
          {scripts.length > 0 &&
            (unverifiedCount === 0 ? (
              <span className="tag ok" title="所有影响伤害的效果均已建模">
                效果已全覆盖 ({verifiedCount}/{scripts.length})
              </span>
            ) : (
              <span className="tag warn" title="含未自动建模的效果脚本，计算时会在缺口列表中提示">
                含 {unverifiedCount} 项影响伤害的效果未建模
              </span>
            ))}
          <span className="muted small">#{skill.id}</span>
        </span>
      </div>
      <div className="skill-stats">
        <span>
          {ATK_LABEL[skill.attrs.atkType as string] ?? skill.attrs.atkType} ·{" "}
          {DEF_LABEL[skill.attrs.defType as string] ?? skill.attrs.defType}
        </span>
        <span>
          基础威力 <b>{skill.basePower}</b>
        </span>
        <span>
          硬币{" "}
          <span className="coins-inline">
            {skill.coins.map((c) => (
              <span key={c.index} className="coin-pill">
                {c.operatorType === "ADD" ? "+" : c.operatorType === "SUB" ? "−" : c.operatorType}
                {c.scale}
              </span>
            ))}
          </span>
        </span>
        <span>
          攻击等级 <b>{lvlCorr >= 0 ? `+${lvlCorr}` : lvlCorr}</b>
        </span>
        {Number(skill.attrs.targetNum ?? 1) > 1 && (
          <span>
            攻击容量 <b>{String(skill.attrs.targetNum)}</b>
          </span>
        )}
      </div>
      {t?.desc && (
        <div className="skill-desc">
          <RichText text={t.desc} resolver={text} />
        </div>
      )}
      {skill.coins.map((c) => {
        const descs = t?.coins[c.index]?.descs ?? [];
        if (!descs.length) return null;
        return (
          <div key={c.index} className="coin-desc">
            <span className="coin-idx">{c.index + 1}</span>
            <div>
              {descs.map((d, j) => (
                <div key={j}>
                  <RichText text={d} resolver={text} />
                </div>
              ))}
            </div>
          </div>
        );
      })}
      <details className="disclosure">
        <summary>
          <span>数据与效果脚本 ({scripts.length})</span>
        </summary>
        <div className="disclosure-body raw small">
          <div>
            突破阶段 {skill.levelsAvailable.join("/")} → 四破合并 {skill.levelsMerged.join("/")} · 来源 <code>{skill.file}</code>
          </div>
          {scripts.length === 0 && <div>无附加效果脚本（纯基础数值技能）</div>}
          {scripts.map((s, i) => (
            <div key={i} className="script">
              <span>{s.where}</span>
              <code>{s.scriptName}</code>
              <StatusBadge status={s.status} />
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function PassiveBlock({ ids, kind, core, text }: { ids: number[]; kind: string; core: CoreData; text: TextResolver }) {
  return (
    <>
      {ids.map((pid) => {
        const p = core.passives[String(pid)];
        const r = text.get("passives", pid);
        const v = r.value as NamedText | undefined;
        const cond = p?.sinCondition ?? [];
        return (
          <div key={pid} className="passive">
            <div className="skill-head">
              <span className="tag">{kind}</span>
              <strong>
                <ColoredText text={v?.name ?? String(pid)} />
              </strong>
              {cond.map((c, i) => (
                <span key={i} className="sin" style={{ background: SIN_LABEL[c.type]?.color }}>
                  {sinText(c.type)}×{c.value} 持有
                </span>
              ))}
              {r.missing && <span className="tag warn">{r.fromFallback ? "缺译" : "无文本"}</span>}
              <span className="meta">
                <PassiveBadge pid={pid} />
                <span className="muted small">#{pid}</span>
              </span>
            </div>
            <div className="skill-desc">
              <RichText text={v?.desc} resolver={text} />
            </div>
          </div>
        );
      })}
    </>
  );
}

export function IdentityCard({
  identity,
  core,
  text,
  onEditPreset,
  onQuickCalculate,
}: {
  identity: NormalizedIdentity;
  core: CoreData;
  text: TextResolver;
  onEditPreset?: () => void;
  onQuickCalculate?: () => void;
}) {
  const n = identityName(text, identity.id);
  const [level, setLevel] = useState<number>(65);
  const entries: { skill: NormalizedSkill; tag: string }[] = [
    ...identity.skillPool.map((r) => ({
      skill: core.skills[String(r.skillId)]!,
      tag: r.count > 0 ? `${core.skills[String(r.skillId)]?.slot ?? ""} ×${r.count}` : "变体（替换出现）",
    })),
    ...identity.defenseSkillIds.map((d) => ({ skill: core.skills[String(d)]!, tag: "防御" })),
  ].filter((e) => e.skill);
  const res = identity.atkResist;
  const estHp = Math.round(identity.hp.base + identity.hp.perLevel * level);

  return (
    <div className="identity-card">
      <div className="identity-hero">
        <div>
          <div className="title">
            <span className="rank">{"0".repeat(identity.rank)}</span> · <ColoredText text={n.title || "基础人格"} /> · #{identity.id}
          </div>
          <h2>
            <span>
              <ColoredText text={n.name} />
            </span>
            <span className="tag gold">同步阶段 IV</span>
            {identity.unitScriptId != null && <span className="tag info">专属机制 #{String(identity.unitScriptId)}</span>}
          </h2>
        </div>
        {(onQuickCalculate || onEditPreset) && (
          <div className="cta">
            {onEditPreset && <button onClick={onEditPreset}>配置技能组</button>}
            {onQuickCalculate && (
              <button className="primary" onClick={onQuickCalculate}>
                立即计算轮伤 →
              </button>
            )}
          </div>
        )}
      </div>

      <div className="stat-grid">
        <div className="stat">
          <div className="k">参考等级</div>
          <div className="v">
            <input
              type="number"
              min={1}
              max={100}
              value={level}
              onChange={(e) => setLevel(Math.max(1, Math.min(100, Number(e.target.value) || 65)))}
              aria-label="等级"
            />
          </div>
        </div>
        <div className="stat">
          <div className="k">体力 (HP)</div>
          <div className="v">
            {estHp} <small>({identity.hp.base}+{identity.hp.perLevel}/级)</small>
          </div>
        </div>
        <div className="stat">
          <div className="k">速度范围</div>
          <div className="v">
            {identity.speed.min} – {identity.speed.max}
          </div>
        </div>
        <div className="stat">
          <div className="k">防御等级修正</div>
          <div className="v">
            {identity.defCorrection >= 0 ? `+${identity.defCorrection}` : identity.defCorrection} <small>(Lv.{level + identity.defCorrection})</small>
          </div>
        </div>
        <div className="stat">
          <div className="k">混乱阈值</div>
          <div className="v">{identity.staggerThresholdsPct.join("% / ")}%</div>
        </div>
        <div className="stat">
          <div className="k">物理抗性 (斩/突/打)</div>
          <div className="v">
            {res.SLASH} / {res.PENETRATE} / {res.HIT}
          </div>
        </div>
      </div>

      {identity.initBuffs.length > 0 && (
        <div className="init-buffs">
          <span>开局固有状态：</span>
          {identity.initBuffs.map((b, i) => (
            <span key={i} className="tag">
              {text.label(b.buff) ?? b.buff}
              {b.stack ? ` 强度 ${b.stack}` : ""}
              {b.turn ? ` 层数 ${b.turn}` : ""}
            </span>
          ))}
        </div>
      )}

      <div className="section-title">
        <span>技能面板</span>
        <span className="hint">（已按四破 gaksungLevel ≤ 4 合并）</span>
      </div>
      {entries.map((e) => (
        <SkillCard key={e.skill.id} skill={e.skill} text={text} tag={e.tag} />
      ))}

      <div className="section-title">
        <span>被动技能</span>
      </div>
      <PassiveBlock ids={identity.battlePassiveIds} kind="战斗" core={core} text={text} />
      <PassiveBlock ids={identity.supportPassiveIds} kind="支援" core={core} text={text} />
      {identity.alternativePassives && (
        <div className="callout warn" style={{ marginTop: 12 }}>
          <div className="callout-body">
            <b>被动数据来源存在分歧</b>
            备用被动 ID：{identity.alternativePassives.battle.join(", ")}（待游戏内四破面板核对）
          </div>
        </div>
      )}

      {(() => {
        const sinnerEgos = (core.egos ?? []).filter((e) => e.characterId === identity.characterId);
        if (!sinnerEgos.length) return null;
        return (
          <>
            <div className="section-title">
              <span>同罪人可用 E.G.O（共 {sinnerEgos.length} 个 · 解析阶段 IV）</span>
            </div>
            {sinnerEgos.map((ego) => {
              const egoText = text.get("egos", ego.id).value as NamedText | undefined;
              const awaken = ego.awakeningSkillId ? core.skills[String(ego.awakeningSkillId)] : undefined;
              const corrosion = ego.corrosionSkillId ? core.skills[String(ego.corrosionSkillId)] : undefined;
              return (
                <div key={ego.id} className="panel" style={{ padding: "12px 16px" }}>
                  <details className="disclosure" style={{ borderTop: "none", marginTop: 0, paddingTop: 0 }}>
                    <summary style={{ fontWeight: 600, color: "var(--text-1)" }}>
                      <span className="tag gold">{ego.egoType}</span>
                      <span>
                        <ColoredText text={egoText?.name ?? `E.G.O #${ego.id}`} />
                      </span>
                      <span className="muted small" style={{ marginLeft: 8, fontWeight: 400 }}>
                        消耗：
                        {ego.requirements.map((r, i) => (
                          <span key={i} className="sin" style={{ background: SIN_LABEL[r.attributeType]?.color ?? "#888", marginLeft: 4 }}>
                            {sinText(r.attributeType)}×{r.num}
                          </span>
                        ))}
                      </span>
                    </summary>
                    <div className="disclosure-body">
                      {awaken && <SkillCard skill={awaken} text={text} tag={`${ego.egoType} · E.G.O 觉醒`} />}
                      {corrosion && <SkillCard skill={corrosion} text={text} tag={`${ego.egoType} · E.G.O 侵蚀`} />}
                      {ego.passiveIds.length > 0 && <PassiveBlock ids={ego.passiveIds} kind="E.G.O 被动" core={core} text={text} />}
                    </div>
                  </details>
                </div>
              );
            })}
          </>
        );
      })()}
    </div>
  );
}
