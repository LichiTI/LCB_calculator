/*
 * Battle situation inputs (scenario.battle).
 * Ranking: primary = self speed / target speed (most scripts read these); secondary = target count, lost HP;
 * tertiary = allies list. No primary action — values apply live. Uses existing .group / .grid2 / .field tokens.
 */
import type { Preset } from "../config/preset-types";

const SIN_KEYS: [string, string][] = [
  ["CRIMSON", "暴怒"], ["SCARLET", "色欲"], ["AMBER", "怠惰"], ["SHAMROCK", "暴食"], ["AZURE", "忧郁"], ["INDIGO", "傲慢"], ["VIOLET", "嫉妒"],
];

interface BattleScenario {
  selfSpeed?: number;
  targetSpeed?: number;
  targetCount?: number;
  countSubTargets?: boolean;
  countAllyDamage?: boolean;
  lostHpPct?: number;
  allies?: string[];
  resonance?: Record<string, number>;
  perfectResonance?: number;
}

export function BattleContextGroup({
  preset,
  setPreset,
  identitySpeed,
}: {
  preset: Preset;
  setPreset: (p: Preset) => void;
  identitySpeed?: { min: number; max: number } | null;
}) {
  const sc = (preset.scenario ?? {}) as Record<string, unknown>;
  const b = (sc.battle ?? {}) as BattleScenario;
  const patch = (next: Partial<BattleScenario>) => {
    const merged: BattleScenario = { ...b, ...next };
    for (const k of Object.keys(merged) as (keyof BattleScenario)[]) if (merged[k] === undefined) delete merged[k];
    setPreset({ ...preset, scenario: { ...sc, battle: merged } });
  };
  const numOrUndef = (v: string, lo: number, hi: number) => (v.trim() === "" ? undefined : Math.max(lo, Math.min(hi, Math.trunc(Number(v) || 0))));

  return (
    <div className="group">
      <div className="group-title">战斗情境</div>
      <div className="grid2">
        <label className="field" title="按速度判断的技能效果（比目标快 N、速度不低于 N）读取此值">
          <span>自身速度</span>
          <input
            type="number"
            min={1}
            max={99}
            placeholder={identitySpeed ? `默认 ${identitySpeed.max}` : "默认最高"}
            value={b.selfSpeed ?? ""}
            onChange={(e) => patch({ selfSpeed: numOrUndef(e.target.value, 1, 99) })}
          />
        </label>
        <label className="field">
          <span>目标速度</span>
          <input
            type="number"
            min={1}
            max={99}
            placeholder="默认 3"
            value={b.targetSpeed ?? ""}
            onChange={(e) => patch({ targetSpeed: numOrUndef(e.target.value, 1, 99) })}
          />
        </label>
        <label className="field" title="场上存活敌方数量；技能命中 min(攻击容量, 目标数量) 名。“目标越少伤害越高”一类效果读取此值">
          <span>目标数量</span>
          <input
            type="number"
            min={1}
            max={10}
            value={b.targetCount ?? 1}
            onChange={(e) => patch({ targetCount: numOrUndef(e.target.value, 1, 10) })}
          />
        </label>
        <label className="field">
          <span>已损失体力 %</span>
          <input
            type="number"
            min={0}
            max={99}
            value={b.lostHpPct ?? 0}
            onChange={(e) => patch({ lostHpPct: numOrUndef(e.target.value, 0, 99) })}
          />
        </label>
      </div>
      <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 }} title="副目标视为与主目标相同；结果分别显示主目标与全部目标伤害">
        <input type="checkbox" checked={b.countSubTargets === true} onChange={(e) => patch({ countSubTargets: e.target.checked || undefined })} />
        <span>统计副目标伤害</span>
      </label>
      <div className="muted small" style={{ marginTop: 8 }}>罪孽共鸣数（按共鸣触发的被动读取；留空 = 0）</div>
      <div className="grid2" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
        {SIN_KEYS.map(([k, label]) => (
          <label key={k} className="field">
            <span>{label}</span>
            <input
              type="number"
              min={0}
              max={10}
              value={b.resonance?.[k] ?? ""}
              onChange={(e) => {
                const v = numOrUndef(e.target.value, 0, 10);
                const next = { ...(b.resonance ?? {}) };
                if (v === undefined || v === 0) delete next[k];
                else next[k] = v;
                patch({ resonance: Object.keys(next).length ? next : undefined });
              }}
            />
          </label>
        ))}
        <label className="field" title="完全共鸣（同罪孽连续）的最长长度">
          <span>完全共鸣</span>
          <input
            type="number"
            min={0}
            max={10}
            value={b.perfectResonance ?? ""}
            onChange={(e) => patch({ perfectResonance: numOrUndef(e.target.value, 0, 10) || undefined })}
          />
        </label>
      </div>
      <label className="field" style={{ marginTop: 8 }} title="填写在场队友的罪人名或人格 ID，用逗号分隔；依赖队友在场的被动据此触发">
        <span>在场队友</span>
        <input
          type="text"
          placeholder="例如 辛克莱, 10315"
          value={(b.allies ?? []).join(", ")}
          onChange={(e) => {
            const list = e.target.value.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
            patch({ allies: list.length ? list : undefined });
          }}
        />
      </label>
      <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 }} title="联合/援护攻击需在上方填写队友人格 ID；友方伤害单独统计，勾选后计入总伤">
        <input type="checkbox" checked={b.countAllyDamage === true} onChange={(e) => patch({ countAllyDamage: e.target.checked || undefined })} />
        <span>计入友方伤害</span>
      </label>
    </div>
  );
}
