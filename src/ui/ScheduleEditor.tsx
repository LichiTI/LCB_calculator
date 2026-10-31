/**
 * Manual schedule editor: one card per turn, each with 1 or 2 skill slots,
 * deck usage counter (3/2/1 per 6 skills), and quick-click sequence builder.
 */
import type { CoreData, TextResolver, SkillText } from "../data/game-data";
import type { Preset } from "../config/preset-types";
import { stripRichTags } from "./RichText";

export interface ScheduleAction {
  turn: number;
  order: number;
  entryId: string;
}

export function readSchedule(preset: Preset): ScheduleAction[] {
  const raw = preset.simulation.actionSchedule ?? [];
  return [...raw]
    .map((a) => ({ turn: Math.max(1, Math.trunc(a.turn)), order: Math.max(1, Math.trunc(a.order)), entryId: a.entryId }))
    .sort((a, b) => a.turn - b.turn || a.order - b.order);
}

function normalize(list: ScheduleAction[]): ScheduleAction[] {
  const byTurn = new Map<number, ScheduleAction[]>();
  for (const a of list) {
    const arr = byTurn.get(a.turn) ?? [];
    arr.push(a);
    byTurn.set(a.turn, arr);
  }
  const out: ScheduleAction[] = [];
  for (const turn of [...byTurn.keys()].sort((a, b) => a - b)) {
    byTurn.get(turn)!.forEach((a, i) => out.push({ ...a, order: i + 1 }));
  }
  return out;
}

export function ManualScheduleEditor({
  core,
  text,
  preset,
  onChange,
}: {
  core: CoreData;
  text: TextResolver;
  preset: Preset;
  onChange: (next: ScheduleAction[], turnCount: number) => void;
}) {
  const schedule = readSchedule(preset);
  const entries = preset.skillGroups.base.filter((e) => e.skillId != null);
  const maxTurn = Math.max(preset.simulation.turnCount ?? 6, ...schedule.map((a) => a.turn), 1);

  const commit = (next: ScheduleAction[], turns = maxTurn) => onChange(normalize(next), turns);

  const nameOf = (entryId: string) => {
    const entry = preset.skillGroups.base.find((e) => e.entryId === entryId);
    if (!entry) return entryId;
    const t = text.get("skills", entry.skillId).value as SkillText | undefined;
    const slot = core.skills[String(entry.skillId)]?.slot;
    return `${slot ?? entryId.toUpperCase()}${t?.name ? ` · ${stripRichTags(t.name)}` : ""}`;
  };

  const shortOf = (entryId: string) => {
    const entry = preset.skillGroups.base.find((e) => e.entryId === entryId);
    if (!entry) return entryId.toUpperCase();
    const slot = core.skills[String(entry.skillId)]?.slot;
    return slot ?? entryId.toUpperCase();
  };

  const setSlot = (turn: number, index: number, entryId: string) => {
    const ofTurn = schedule.filter((a) => a.turn === turn);
    const others = schedule.filter((a) => a.turn !== turn);
    ofTurn[index] = { turn, order: index + 1, entryId };
    commit([...others, ...ofTurn]);
  };

  const addSlot = (turn: number) => {
    const fallback = entries[0]?.entryId ?? schedule[schedule.length - 1]?.entryId;
    if (!fallback) return;
    commit([...schedule, { turn, order: 99, entryId: fallback }]);
  };

  const removeSlot = (turn: number, index: number) => {
    const ofTurn = schedule.filter((a) => a.turn === turn);
    ofTurn.splice(index, 1);
    commit([...schedule.filter((a) => a.turn !== turn), ...ofTurn]);
  };

  const fillDefault = (targetTurns = maxTurn, slotsPerTurn = 1) => {
    if (!entries.length) return;
    const deck: string[] = [];
    for (const e of entries) {
      const n = Math.max(1, Math.round(e.usesPerCycle));
      for (let i = 0; i < n; i++) deck.push(e.entryId);
    }
    const next: ScheduleAction[] = [];
    let cursor = 0;
    for (let t = 1; t <= targetTurns; t++) {
      for (let s = 1; s <= slotsPerTurn; s++) {
        const eid = deck[cursor % Math.max(1, deck.length)]!;
        cursor++;
        next.push({ turn: t, order: s, entryId: eid });
      }
    }
    commit(next, targetTurns);
  };

  // Append a skill to the first turn that currently has fewer than 1 action (or append a new turn)
  const quickAppend = (entryId: string) => {
    for (let t = 1; t <= maxTurn; t++) {
      const ofTurn = schedule.filter((a) => a.turn === t);
      if (ofTurn.length === 0) {
        commit([...schedule, { turn: t, order: 1, entryId }], maxTurn);
        return;
      }
    }
    commit([...schedule, { turn: maxTurn + 1, order: 1, entryId }], maxTurn + 1);
  };

  // Count how many times each entry is used vs expected deck copies
  const deckMultiplier = Math.max(1, Math.round(schedule.length / 6));

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>手动排轴（逐回合状态模拟）</h3>
        <div className="row-actions">
          <button
            type="button"
            className={`chip ${maxTurn === 6 && schedule.length === 6 ? "on" : ""}`}
            onClick={() => fillDefault(6, 1)}
            title="标准 1 副牌库：6 回合单槽（共 6 个动作）"
          >
            6T 单槽（1副牌）
          </button>
          <button
            type="button"
            className={`chip ${maxTurn === 12 && schedule.length === 12 ? "on" : ""}`}
            onClick={() => fillDefault(12, 1)}
            title="适合 4T 状态循环与 6 技能牌库错位的人格（例如 2T 准备 + 2T 强化 = 4T 一轮，取最小公倍数 12T = 2 副牌，再折算 ÷2）"
          >
            12T 单槽（2副牌同调）
          </button>
          <button
            type="button"
            className={`chip ${maxTurn === 6 && schedule.length === 12 ? "on" : ""}`}
            onClick={() => fillDefault(6, 2)}
            title="6 回合双槽（每回合 2 个动作，共 12 个动作 = 2 副牌）"
          >
            6T 双槽（12动）
          </button>
          <button type="button" onClick={() => commit([], maxTurn)}>
            清空动作
          </button>
          <button type="button" onClick={() => commit(schedule, maxTurn + 1)}>
            +1 回合
          </button>
          {maxTurn > 1 && (
            <button type="button" onClick={() => commit(schedule.filter((a) => a.turn < maxTurn), maxTurn - 1)}>
              −1 回合
            </button>
          )}
        </div>
      </div>

      {/* Deck quota bar & quick append */}
      {entries.length > 0 && (
        <div className="schedule-deck-bar">
          <span className="muted small">牌库计数（点按钮可依次往空回合填入）：</span>
          {entries.map((e) => {
            const used = schedule.filter((a) => a.entryId === e.entryId).length;
            const expected = e.usesPerCycle * deckMultiplier;
            const match = used === expected;
            return (
              <button
                key={e.entryId}
                type="button"
                className={`chip ${match ? "on" : ""}`}
                onClick={() => quickAppend(e.entryId)}
                title={`点击将 ${nameOf(e.entryId)} 填入下一个空回合`}
              >
                + {shortOf(e.entryId)}（已排 {used}/{expected}）
              </button>
            );
          })}
          <span className="muted small" style={{ marginLeft: "auto" }}>
            当前序列：
            <code>
              {Array.from({ length: maxTurn }, (_, k) => {
                const slots = schedule.filter((a) => a.turn === k + 1);
                return slots.length ? slots.map((s) => shortOf(s.entryId)).join("+") : "空";
              }).join(" → ")}
            </code>
          </span>
        </div>
      )}

      <div className="schedule-grid">
        {Array.from({ length: maxTurn }, (_, k) => k + 1).map((turn) => {
          const slots = schedule.filter((a) => a.turn === turn);
          return (
            <div key={turn} className="schedule-turn">
              <div className="schedule-turn-head">
                <strong>T{turn}</strong>
                {entries.length > 0 && (
                  <button type="button" className="link small" onClick={() => addSlot(turn)}>
                    + 加槽位
                  </button>
                )}
              </div>
              <div className="schedule-slots">
                {slots.length === 0 && <div className="muted small">（未安排动作）</div>}
                {slots.map((a, i) => (
                  <div key={`${turn}-${i}`} className="schedule-slot">
                    <select
                      value={a.entryId}
                      onChange={(e) => setSlot(turn, i, e.target.value)}
                      aria-label={`T${turn} 第 ${i + 1} 个动作`}
                    >
                      {entries.map((e) => (
                        <option key={e.entryId} value={e.entryId}>
                          {nameOf(e.entryId)}
                        </option>
                      ))}
                      {!entries.some((e) => e.entryId === a.entryId) && <option value={a.entryId}>{a.entryId}</option>}
                    </select>
                    <button
                      type="button"
                      className="slot-del"
                      onClick={() => removeSlot(turn, i)}
                      aria-label="删除该动作"
                      title="移除该动作"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
