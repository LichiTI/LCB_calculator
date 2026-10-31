import { useMemo, useState } from "react";

/** Chinese labels for UNIT_KEYWORD values referenced by translated passives/scripts (others are shown raw). */
export const UNIT_KEYWORD_LABEL: Record<string, string> = {
  MACHINE_BOUND_ORGANISM: "机械融合生命体",
  BLOODFIEND: "血魔",
  BLOODBAG: "血袋",
  ON_THE_LAKE: "大湖生物",
  MACHINE: "机械",
  NONE_BLOOD: "无血",
  SMALL: "小型",
  REGULAR: "中型",
  LARGE: "大型",
  EXTRA_LARGE: "超大型",
  FIXER: "收尾人",
  BACK_STREET: "后巷",
  CLAN: "氏族",
  FINGER: "五指",
  INDEX_FINGER: "食指",
  MIDDLE_FINGER: "中指",
  RING_FINGER: "无名指",
  THUMB_FINGER: "拇指",
  LITTLE_FINGER: "小指",
  LA_MANCHA_LAND: "拉·曼却领",
  BLACK_BEAST: "黑兽",
  SPIDER_HOUSE: "蜘蛛巢",
  SEA_BORN: "海裔",
  ABNORMALITY_EROSION: "异想体侵蚀",
};

/** Keywords offered first (used by modelled effects). */
const PRIORITY = ["MACHINE_BOUND_ORGANISM", "BLOODFIEND", "BLOODBAG", "ON_THE_LAKE"];

export function unitKeywordLabel(k: string): string {
  const zh = UNIT_KEYWORD_LABEL[k];
  return zh ? `${zh}（${k}）` : k;
}

/**
 * Compact tag input for scenario target.unitKeywords. `known` = keywords present in game data (identity unitKeywords /
 * associations); free text is also accepted (upper-cased).
 */
export function UnitKeywordInput({ value, known, onChange }: { value: string[]; known: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const options = useMemo(() => {
    const all = new Set<string>([...PRIORITY, ...Object.keys(UNIT_KEYWORD_LABEL), ...known]);
    const rest = [...all].filter((k) => !PRIORITY.includes(k)).sort();
    return [...PRIORITY, ...rest].filter((k) => !value.includes(k));
  }, [known, value]);
  const add = (raw: string) => {
    const k = raw.trim().toUpperCase();
    if (!k || value.includes(k)) return;
    onChange([...value, k]);
    setDraft("");
  };
  return (
    <div className="field full" title="目标的单位关键词（如 <机械融合生命体>、<血魔>/<血袋>），用于“对带有某关键词的目标”类效果">
      <span>目标单位关键词</span>
      <div className="chips" style={{ marginBottom: 4 }}>
        {value.length === 0 && <span className="muted small">无</span>}
        {value.map((k) => (
          <button key={k} type="button" className="chip on" title="点击移除" onClick={() => onChange(value.filter((x) => x !== k))}>
            {unitKeywordLabel(k)} ×
          </button>
        ))}
      </div>
      <select
        aria-label="添加目标单位关键词"
        value=""
        onChange={(e) => {
          if (e.target.value) add(e.target.value);
        }}
      >
        <option value="">＋ 添加关键词…</option>
        {options.map((k) => (
          <option key={k} value={k}>
            {unitKeywordLabel(k)}
          </option>
        ))}
      </select>
      <input
        type="text"
        placeholder="或输入关键词后回车"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(draft);
          }
        }}
        style={{ marginTop: 4 }}
      />
    </div>
  );
}
