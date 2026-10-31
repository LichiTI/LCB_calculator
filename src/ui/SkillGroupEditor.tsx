import { useMemo, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import type { CoreData, NamedText, SkillText, TextResolver } from "../data/game-data";
import type { NormalizedIdentity, NormalizedSkill } from "../config/game-data";
import type { BaseSkillEntry, FollowUpEntry, Preset } from "../config/preset-types";
import { fillPerCoinDefaults, hasErrors, serializePreset, validatePreset, type GameDataIndex, type Issue } from "../config/preset";
import { PresetStore } from "../config/preset-store";
import { baseEntryFor, createPresetForIdentity, followUpEntryFor, perCoinDefaults } from "../config/preset-factory";
import { amountSemantics, DOT_IDS } from "../config/status-terms";
import { ATK_LABEL, SIN_LABEL, sinText } from "./labels";

type Entry = BaseSkillEntry | FollowUpEntry;

function skillLabel(text: TextResolver, s: NormalizedSkill | undefined, id: number | null) {
  if (!s) return id == null ? "（未选择）" : `未知技能 ${id}`;
  const t = text.get("skills", s.id).value as SkillText | undefined;
  return `${s.slot ?? ""} ${t?.name ?? s.id}`.trim();
}

function NumberField({
  label,
  value,
  onChange,
  step = 1,
  nullable,
  title,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  step?: number;
  nullable?: boolean;
  title?: string;
}) {
  return (
    <label className="field" title={title}>
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={value ?? ""}
        placeholder={nullable ? "游戏值" : "0"}
        onChange={(e) => {
          if (e.target.value === "") onChange(nullable ? null : 0);
          else onChange(step === 1 ? Math.trunc(Number(e.target.value)) : Number(e.target.value));
        }}
      />
    </label>
  );
}

function DotCell({
  map,
  onChange,
  core,
  text,
}: {
  map: Record<string, { potency: number; count: number } | undefined>;
  onChange: (m: Record<string, { potency: number; count: number }>) => void;
  core: CoreData;
  text: TextResolver;
}) {
  const [adding, setAdding] = useState("");
  const entries = Object.entries(map).filter(([, v]) => v) as [string, { potency: number; count: number }][];
  const set = (id: string, v: { potency: number; count: number } | null) => {
    const next: Record<string, { potency: number; count: number }> = {};
    for (const [k, val] of entries) if (k !== id) next[k] = val;
    if (v) next[id] = v;
    onChange(next);
  };
  return (
    <div className="dot-cell">
      {entries.map(([id, v]) => {
        const sem = amountSemantics(core.buffs[id]?.buffClass);
        return (
          <div key={id} className="dot-row">
            <span className="tag" title={id}>
              {text.label(id) ?? id}
            </span>
            <label title="强度">
              强
              <input
                type="number"
                min={0}
                value={v.potency}
                disabled={sem === "countOnlyFromStack"}
                onChange={(e) => set(id, { ...v, potency: Math.max(0, Math.trunc(Number(e.target.value) || 0)) })}
              />
            </label>
            <label title="层数">
              层
              <input
                type="number"
                min={0}
                value={v.count}
                onChange={(e) => set(id, { ...v, count: Math.max(0, Math.trunc(Number(e.target.value) || 0)) })}
              />
            </label>
            <button className="link icon" onClick={() => set(id, null)} aria-label="移除该 DOT">
              ×
            </button>
          </div>
        );
      })}
      <select
        value={adding}
        onChange={(e) => {
          const id = e.target.value;
          if (id && !map[id]) set(id, { potency: 1, count: 1 });
          setAdding("");
        }}
      >
        <option value="">+ DOT</option>
        {DOT_IDS.filter((d) => !map[d]).map((d) => (
          <option key={d} value={d}>
            {text.label(d) ?? d}
          </option>
        ))}
      </select>
    </div>
  );
}

function EntryEditor({
  entry,
  update,
  remove,
  core,
  text,
  identity,
  isFollowUp,
  baseIds,
}: {
  entry: Entry;
  update: (e: Entry) => void;
  remove?: () => void;
  core: CoreData;
  text: TextResolver;
  identity: NormalizedIdentity;
  isFollowUp: boolean;
  baseIds: string[];
}) {
  const skill = entry.skillId != null ? core.skills[String(entry.skillId)] : undefined;
  const set = <K extends keyof Entry>(k: K, v: Entry[K]) => update({ ...entry, [k]: v } as Entry);
  const n = skill?.coinCount ?? 0;
  const lenOk = (a?: unknown[]) => a === undefined || a.length === n;
  const identitySkills = [...identity.skillPool.map((r) => r.skillId), ...identity.defenseSkillIds]
    .map((id) => core.skills[String(id)])
    .filter(Boolean) as NormalizedSkill[];
  const egoSkills = (core.egos ?? [])
    .filter((ego) => ego.characterId === identity.characterId)
    .flatMap((ego) => {
      const egoName = (text.get("egos", ego.id).value as NamedText | undefined)?.name ?? `E.G.O #${ego.id}`;
      return [
        ego.awakeningSkillId ? { egoType: ego.egoType, egoName, kind: "觉醒", skill: core.skills[String(ego.awakeningSkillId)] } : null,
        ego.corrosionSkillId ? { egoType: ego.egoType, egoName, kind: "侵蚀", skill: core.skills[String(ego.corrosionSkillId)] } : null,
      ].filter((x): x is { egoType: string; egoName: string; kind: string; skill: NormalizedSkill } => Boolean(x?.skill));
    });

  const changeSkill = (id: number | null) => {
    const s = id != null ? core.skills[String(id)] : undefined;
    update({ ...entry, skillId: id as number, slot: s?.slot ?? undefined, ...perCoinDefaults(s?.coinCount ?? 0) } as Entry);
  };
  const setCoin = (key: "coinPowerDeltas" | "coinDamageBonusPcts", i: number, v: number) => {
    const arr = [...(entry[key] ?? Array.from({ length: n }, () => 0))];
    arr[i] = v;
    set(key, arr);
  };

  const sinColor = skill?.attrs.attributeType ? SIN_LABEL[skill.attrs.attributeType]?.color : undefined;
  const hasExtraDamage = entry.totalExtraDamage.fixedDamage !== 0 || entry.totalExtraDamage.ratioPct !== 0;

  return (
    <div
      className={`entry ${isFollowUp && !(entry as FollowUpEntry).enabled ? "disabled" : ""}`}
      style={{ "--sin": sinColor } as CSSProperties}
    >
      <div className="entry-head">
        <code className="entry-id">{entry.entryId}</code>
        {skill?.attrs.attributeType && (
          <span className="sin" style={{ background: sinColor ?? "#888" }}>
            {sinText(skill.attrs.attributeType)}
          </span>
        )}
        <select
          className="skill-select"
          value={entry.skillId ?? ""}
          onChange={(e) => changeSkill(e.target.value === "" ? null : Number(e.target.value))}
          aria-label="选择技能"
        >
          {isFollowUp && <option value="">（未选择技能）</option>}
          <optgroup label="人格本体技能">
            {identitySkills.map((s) => (
              <option key={s.id} value={s.id}>
                {skillLabel(text, s, s.id)}
              </option>
            ))}
          </optgroup>
          {egoSkills.length > 0 && (
            <optgroup label="同罪人 E.G.O 技能（四破）">
              {egoSkills.map((es) => (
                <option key={es.skill.id} value={es.skill.id}>
                  [{es.egoType}·{es.kind}] {es.egoName} (#{es.skill.id})
                </option>
              ))}
            </optgroup>
          )}
          {entry.skillId != null && !skill && <option value={entry.skillId}>未知技能 {entry.skillId}</option>}
        </select>
        {skill && (
          <span className="muted small">
            {ATK_LABEL[skill.attrs.atkType as string] ?? skill.attrs.atkType} · 基础 {skill.basePower} · {skill.coinCount} 币
          </span>
        )}
        <span className="spacer" />
        {!isFollowUp && (
          <div className="field inline" title="一轮（6 个技能槽）中使用该技能的次数">
            <span>每轮次数</span>
            <div className="stepper">
              <button
                type="button"
                onClick={() => set("usesPerCycle" as keyof Entry, Math.max(0, (entry as BaseSkillEntry).usesPerCycle - 1) as never)}
                aria-label="减少次数"
              >
                −
              </button>
              <input
                type="number"
                min={0}
                value={(entry as BaseSkillEntry).usesPerCycle}
                onChange={(e) => set("usesPerCycle" as keyof Entry, Math.max(0, Math.trunc(Number(e.target.value) || 0)) as never)}
              />
              <button
                type="button"
                onClick={() => set("usesPerCycle" as keyof Entry, ((entry as BaseSkillEntry).usesPerCycle + 1) as never)}
                aria-label="增加次数"
              >
                +
              </button>
            </div>
          </div>
        )}
        {isFollowUp && (
          <label className="field inline">
            <input
              type="checkbox"
              checked={(entry as FollowUpEntry).enabled}
              onChange={(e) => set("enabled" as keyof Entry, e.target.checked as never)}
            />
            <span>启用追击</span>
          </label>
        )}
        {remove && (
          <button className="link danger" onClick={remove}>
            删除
          </button>
        )}
      </div>

      {isFollowUp && (
        <div className="entry-mods">
          <div className="field">
            <span>触发源（点击切换）</span>
            <div className="chips" style={{ marginBottom: 0 }}>
              {baseIds.map((b) => {
                const active = (entry as FollowUpEntry).trigger.sourceEntryIds.includes(b);
                return (
                  <button
                    key={b}
                    type="button"
                    className={`chip ${active ? "on" : ""}`}
                    onClick={() => {
                      const cur = (entry as FollowUpEntry).trigger.sourceEntryIds;
                      const next = active ? cur.filter((x) => x !== b) : [...cur, b];
                      set("trigger" as keyof Entry, { ...(entry as FollowUpEntry).trigger, sourceEntryIds: next } as never);
                    }}
                  >
                    {b}
                  </button>
                );
              })}
            </div>
          </div>
          <label className="field">
            <span>触发时点</span>
            <select
              value={(entry as FollowUpEntry).trigger.event}
              onChange={(e) =>
                set("trigger" as keyof Entry, { ...(entry as FollowUpEntry).trigger, event: e.target.value } as never)
              }
            >
              <option value="afterSkill">技能结束后</option>
              <option value="afterEachLandedCoin">每枚硬币命中后</option>
              <option value="onWinDuel">拼点胜利时</option>
            </select>
          </label>
          <NumberField
            label="触发概率 (0-1)"
            step={0.05}
            value={(entry as FollowUpEntry).trigger.chance}
            onChange={(v) =>
              set("trigger" as keyof Entry, {
                ...(entry as FollowUpEntry).trigger,
                chance: Math.min(1, Math.max(0, v ?? 0)),
              } as never)
            }
          />
          <NumberField
            label="连锁上限"
            value={(entry as FollowUpEntry).maxChainDepth}
            onChange={(v) => set("maxChainDepth" as keyof Entry, Math.max(0, Math.min(8, v ?? 0)) as never)}
          />
        </div>
      )}

      <div className="entry-mods">
        <NumberField
          label={`基础威力${skill ? ` (默认 ${skill.basePower})` : ""}`}
          nullable
          value={entry.basePower}
          onChange={(v) => set("basePower", v)}
          title={`留空 = 游戏值${skill ? `（${skill.basePower}）` : ""}；0 也是有效覆盖`}
        />
        <NumberField
          label="总硬币变动值 ±"
          value={entry.totalCoinPowerDelta}
          onChange={(v) => set("totalCoinPowerDelta", v ?? 0)}
          title="加到该技能的每一枚硬币变动值上"
        />
        <NumberField
          label="总伤害加成 %"
          step={0.1}
          value={entry.totalDamageBonusPct}
          onChange={(v) => set("totalDamageBonusPct", v ?? 0)}
          title="加到该技能的动态伤害乘区（百分比，如 30 表示 +30%）"
        />
      </div>

      <details className="disclosure" open={hasExtraDamage}>
        <summary>
          <span>额外追伤设置（可选）</span>
          {hasExtraDamage && (
            <span className="tag gold badge">
              固定 {entry.totalExtraDamage.fixedDamage} / 比例 {entry.totalExtraDamage.ratioPct}%
            </span>
          )}
        </summary>
        <div className="disclosure-body entry-mods" style={{ marginTop: 0 }}>
          <NumberField
            label="追伤 固定值"
            step={0.1}
            value={entry.totalExtraDamage.fixedDamage}
            onChange={(v) => set("totalExtraDamage", { ...entry.totalExtraDamage, fixedDamage: v ?? 0 })}
          />
          <NumberField
            label="追伤 比例 %"
            step={0.1}
            value={entry.totalExtraDamage.ratioPct}
            onChange={(v) => set("totalExtraDamage", { ...entry.totalExtraDamage, ratioPct: v ?? 0 })}
          />
          <label className="field">
            <span>追伤基数</span>
            <select
              value={entry.totalExtraDamage.reference}
              onChange={(e) =>
                set("totalExtraDamage", { ...entry.totalExtraDamage, reference: e.target.value as "resolvedHitDamage" })
              }
            >
              <option value="resolvedHitDamage">命中结算伤害</option>
              <option value="actualHpLost">实际扣血</option>
            </select>
          </label>
          <label className="field">
            <span>追伤触发时点</span>
            <select
              value={entry.totalExtraDamage.trigger}
              onChange={(e) => set("totalExtraDamage", { ...entry.totalExtraDamage, trigger: e.target.value as "afterSkill" })}
            >
              <option value="afterEachLandedCoin">每枚命中硬币</option>
              <option value="afterSkill">技能完成一次</option>
            </select>
          </label>
        </div>
      </details>

      {skill && (
        <div style={{ marginTop: 12 }}>
          <table className="coins">
            <thead>
              <tr>
                <th>硬币</th>
                <th>游戏值</th>
                <th>独立变动值</th>
                <th>独立增伤 %</th>
                <th>DOT（手动追加，命中后）</th>
              </tr>
            </thead>
            <tbody>
              {skill.coins.map((c, i) => (
                <tr key={i}>
                  <td>
                    <span className="coin-idx" style={{ display: "inline-block", marginTop: 0 }}>
                      {i + 1}
                    </span>
                  </td>
                  <td className="num" style={{ textAlign: "left" }}>
                    <span className="coin-pill">
                      {c.operatorType === "ADD" ? "+" : c.operatorType === "SUB" ? "−" : c.operatorType}
                      {c.scale}
                    </span>
                    {entry.totalCoinPowerDelta !== 0 || (entry.coinPowerDeltas?.[i] ?? 0) !== 0 ? (
                      <span className="muted small">
                        {" "}
                        手动 {entry.totalCoinPowerDelta + (entry.coinPowerDeltas?.[i] ?? 0) >= 0 ? "+" : ""}
                        {entry.totalCoinPowerDelta + (entry.coinPowerDeltas?.[i] ?? 0)}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <input
                      type="number"
                      value={entry.coinPowerDeltas?.[i] ?? 0}
                      onChange={(e) => setCoin("coinPowerDeltas", i, Math.trunc(Number(e.target.value) || 0))}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step={0.1}
                      value={entry.coinDamageBonusPcts?.[i] ?? 0}
                      onChange={(e) => setCoin("coinDamageBonusPcts", i, Number(e.target.value) || 0)}
                    />
                  </td>
                  <td>
                    <DotCell
                      map={entry.coinDots?.[i] ?? {}}
                      core={core}
                      text={text}
                      onChange={(m) => {
                        const arr = (entry.coinDots ?? Array.from({ length: n }, () => ({}))).map((x) => ({ ...x }));
                        arr[i] = m;
                        set("coinDots", arr);
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(!lenOk(entry.coinPowerDeltas) || !lenOk(entry.coinDamageBonusPcts) || !lenOk(entry.coinDots)) && (
        <div className="callout err" style={{ marginTop: 8 }}>
          <div className="callout-body">逐硬币数组长度与硬币数 {n} 不一致（导入数据），不会自动修正，请检查</div>
        </div>
      )}
    </div>
  );
}

function IssueList({ issues }: { issues: Issue[] }) {
  if (!issues.length) {
    return (
      <div className="callout ok">
        <div className="callout-body">
          <b>配置有效</b>
          <span className="small">所有字段与硬币数组长度通过校验，可直接进入计算。</span>
        </div>
      </div>
    );
  }
  return (
    <ul className="issues">
      {issues.map((i, k) => (
        <li key={k} className={i.severity}>
          <span className={`tag ${i.severity === "error" ? "err" : i.severity === "warning" ? "warn" : ""}`}>
            {i.severity === "error" ? "错误" : i.severity === "warning" ? "警告" : "提示"}
          </span>
          <div>
            <code>{i.path}</code> {i.message}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function SkillGroupEditor({
  core,
  text,
  index,
  identity,
  store,
  preset,
  setPreset,
  onGoResult,
  onGoIdentity,
}: {
  core: CoreData;
  text: TextResolver;
  index: GameDataIndex;
  identity: NormalizedIdentity | null;
  store: PresetStore;
  preset: Preset | null;
  setPreset: Dispatch<SetStateAction<Preset | null>>;
  onGoResult?: () => void;
  onGoIdentity?: () => void;
}) {
  const [importIssues, setImportIssues] = useState<Issue[]>([]);
  const [savedNotice, setSavedNotice] = useState(false);
  const [, bump] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const issues = useMemo(() => (preset ? validatePreset(preset, index) : []), [preset, index]);
  const filteredIssues = useMemo(() => issues.filter((i) => i.code !== "template-only"), [issues]);
  const presetIdentity = preset ? core.identities.find((i) => i.id === preset.actor.identityId) ?? null : null;

  const newFromIdentity = () => {
    if (!identity) return;
    const v = text.get("personalities", identity.id).value as NamedText | undefined;
    const name = v?.name ?? String(identity.id);
    const title = (v?.title ?? "").replace(/\n/g, " ").trim();
    const label = title ? `${title} ${name}` : name;
    setPreset(createPresetForIdentity(identity, core.skills, core.manifest.dataVersion, `${label} 四破配置`));
    setImportIssues([]);
  };

  const save = () => {
    if (!preset) return;
    store.save(preset);
    bump((x) => x + 1);
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 1600);
  };

  const download = () => {
    if (!preset) return;
    const blob = new Blob([serializePreset(preset)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${preset.presetId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const onImport = async (f: File) => {
    const r = store.importText(await f.text());
    setImportIssues(r.issues);
    if (r.preset) {
      setPreset(fillPerCoinDefaults(r.preset, index).preset);
      bump((x) => x + 1);
    }
  };

  const updateBase = (i: number, e: Entry) =>
    setPreset(
      (p) =>
        p && {
          ...p,
          skillGroups: { ...p.skillGroups, base: p.skillGroups.base.map((x, k) => (k === i ? (e as BaseSkillEntry) : x)) },
        },
    );
  const updateFollow = (i: number, e: Entry) =>
    setPreset(
      (p) =>
        p && {
          ...p,
          skillGroups: {
            ...p.skillGroups,
            followUps: p.skillGroups.followUps.map((x, k) => (k === i ? (e as FollowUpEntry) : x)),
          },
        },
    );

  const savedList = store.list();
  const totalUses = preset ? preset.skillGroups.base.reduce((s, b) => s + (b.usesPerCycle || 0), 0) : 0;

  return (
    <div className="editor">
      <div className="page-toolbar">
        <button onClick={newFromIdentity} disabled={!identity}>
          按当前人格新建
        </button>
        <select
          value=""
          onChange={(e) => {
            const r = store.get(e.target.value);
            if (r.preset) setPreset(r.preset);
            setImportIssues(r.issues.filter((i) => i.severity !== "info"));
          }}
          aria-label="打开已保存预设"
        >
          <option value="">打开已保存 ({savedList.length})…</option>
          {savedList.map((p) => (
            <option key={p.presetId} value={p.presetId}>
              {p.name}
            </option>
          ))}
        </select>
        <button onClick={() => fileRef.current?.click()}>导入 JSON</button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onImport(f);
            e.target.value = "";
          }}
        />
        {preset && (
          <>
            <span className="toolbar-sep" />
            <input
              className="name"
              value={preset.name}
              onChange={(e) => setPreset({ ...preset, name: e.target.value })}
              aria-label="预设名称"
            />
            <button onClick={save}>保存</button>
            {savedNotice && <span className="tag ok">已保存 ✓</span>}
            <button
              onClick={() => {
                const c = store.duplicate(preset.presetId, `${preset.name} 副本`);
                if (c) setPreset(c);
                else {
                  store.save(preset);
                  setPreset(store.duplicate(preset.presetId, `${preset.name} 副本`));
                }
              }}
            >
              复制
            </button>
            <button onClick={download}>导出 JSON</button>
            {savedList.some((p) => p.presetId === preset.presetId) && (
              <button
                className="link danger"
                onClick={() => {
                  store.remove(preset.presetId);
                  setPreset(null);
                }}
              >
                删除
              </button>
            )}
          </>
        )}
      </div>

      {importIssues.length > 0 && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <h3>导入报告</h3>
          <IssueList issues={importIssues} />
        </div>
      )}

      {!preset && (
        <div className="empty card">
          <div className="empty-icon">⚙</div>
          <h2>尚未加载技能组预设</h2>
          <p>
            可基于当前选中的人格
            {identity
              ? `（#${identity.id} ${(text.get("personalities", identity.id).value as NamedText | undefined)?.name ?? ""}）`
              : ""}{" "}
            一键生成默认六技能轮转（S1×3 / S2×2 / S3×1），或导入已有 JSON 配置文件。
          </p>
          <div className="actions">
            <button className="primary" onClick={newFromIdentity} disabled={!identity}>
              按当前人格新建预设
            </button>
            {onGoIdentity && <button onClick={onGoIdentity}>前往选择人格</button>}
            <button onClick={() => fileRef.current?.click()}>导入 JSON 文件</button>
          </div>
        </div>
      )}

      {preset && presetIdentity === null && (
        <div className="callout err">
          <div className="callout-body">
            <b>预设引用的人格 #{preset.actor.identityId} 不在当前数据中</b>
            配置内容已完整保留，可导出备份或重新选择人格。
          </div>
        </div>
      )}

      {preset && presetIdentity && (
        <div className="editor-layout">
          <div>
            <div className="section-title" style={{ marginTop: 0 }}>
              <span>基础技能区</span>
              <span className="hint">
                （当前一轮共 {totalUses} 次技能释放{totalUses !== 6 ? " · 标准一轮为 6 次" : " · 标准 3/2/1 配比"}）
              </span>
            </div>
            {preset.skillGroups.base.map((e, i) => (
              <EntryEditor
                key={e.entryId}
                entry={e}
                update={(x) => updateBase(i, x)}
                core={core}
                text={text}
                identity={presetIdentity}
                isFollowUp={false}
                baseIds={[]}
                remove={() =>
                  setPreset({
                    ...preset,
                    skillGroups: { ...preset.skillGroups, base: preset.skillGroups.base.filter((_, k) => k !== i) },
                    simulation: {
                      ...preset.simulation,
                      actionSchedule: (preset.simulation.actionSchedule ?? []).filter((a) => a.entryId !== e.entryId),
                    },
                  })
                }
              />
            ))}
            <div className="add-row">
              <button
                className="add"
                onClick={() => {
                  const s = core.skills[String(presetIdentity.skillPool[0]!.skillId)]!;
                  const id = uniqueEntryId(preset, "extra");
                  setPreset({
                    ...preset,
                    skillGroups: { ...preset.skillGroups, base: [...preset.skillGroups.base, baseEntryFor(s, id, 1)] },
                  });
                }}
              >
                + 基础技能项（如变体技能 / 反击 / 额外槽位）
              </button>
            </div>

            <div className="section-title">
              <span>追击区</span>
              <span className="hint">（不占用六技能槽次数；默认禁止无限连锁）</span>
            </div>
            {preset.skillGroups.followUps.map((e, i) => (
              <EntryEditor
                key={e.entryId}
                entry={e}
                update={(x) => updateFollow(i, x)}
                core={core}
                text={text}
                identity={presetIdentity}
                isFollowUp
                baseIds={preset.skillGroups.base.map((b) => b.entryId)}
                remove={() =>
                  setPreset({
                    ...preset,
                    skillGroups: {
                      ...preset.skillGroups,
                      followUps: preset.skillGroups.followUps.filter((_, k) => k !== i),
                    },
                  })
                }
              />
            ))}
            <div className="add-row">
              <button
                className="add"
                onClick={() => {
                  const id = uniqueEntryId(preset, "follow");
                  const src = preset.skillGroups.base.at(-1)?.entryId;
                  setPreset({
                    ...preset,
                    skillGroups: {
                      ...preset.skillGroups,
                      followUps: [...preset.skillGroups.followUps, followUpEntryFor(null, id, src ? [src] : [])],
                    },
                  });
                }}
              >
                + 追击项（如技能联动追击）
              </button>
            </div>
          </div>

          <aside className="editor-side">
            <div className="panel">
              <h3>
                校验与流转
                {hasErrors(filteredIssues) && <span className="tag err">存在错误</span>}
              </h3>
              <IssueList issues={filteredIssues} />
              <div className="side-cta" style={{ marginTop: 16 }}>
                {onGoResult && (
                  <button className="primary" onClick={onGoResult} disabled={hasErrors(filteredIssues)}>
                    前往场景与结果计算 →
                  </button>
                )}
                <button onClick={save}>{savedNotice ? "已保存到本地 ✓" : "保存预设到本地"}</button>
              </div>
            </div>
            <div className="panel small muted">
              <h3 style={{ color: "var(--text-2)", fontSize: "var(--t-sm)" }}>当前预设信息</h3>
              <div>人格 ID：#{preset.actor.identityId}</div>
              <div>基础技能项：{preset.skillGroups.base.length} 项（共 {totalUses} 次）</div>
              <div>追击项：{preset.skillGroups.followUps.length} 项</div>
              <div>数据版本：{preset.dataVersion ?? "未绑定"}</div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function uniqueEntryId(p: Preset, base: string) {
  const ids = new Set([...p.skillGroups.base, ...p.skillGroups.followUps].map((e) => e.entryId));
  let i = 1;
  while (ids.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}
