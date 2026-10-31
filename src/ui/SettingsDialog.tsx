import { useState } from "react";
import { DEFAULT_SETTINGS, type AppSettings } from "../config/app-settings";
import { BONUS_TIER_LABEL, type BonusTier } from "../engine/bonus-tier";

export function SettingsDialog({
  settings,
  onSave,
  onClose,
}: {
  settings: AppSettings;
  onSave: (s: AppSettings) => void;
  onClose: () => void;
}) {
  const [s, setS] = useState<AppSettings>(settings);
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => setS((p) => ({ ...p, [k]: v }));
  const int = (v: string, fb: number) => (v === "" || Number.isNaN(Number(v)) ? fb : Math.trunc(Number(v)));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="设置" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>设置</h2>
          <button className="link icon" onClick={onClose} aria-label="关闭设置">
            ×
          </button>
        </div>

        <div className="modal-body">
          <section>
            <div className="group-title">界面模式</div>
            <div className="mode-cards">
              <button type="button" className={`mode-card ${s.uiMode === "simple" ? "on" : ""}`} onClick={() => set("uiMode", "simple")}>
                <strong>简易模式</strong>
                <span>默认按「吃满该人格全部技能加成」计算，只需填等级、抗性与外部加成；隐藏逐币修正和事件日志。</span>
              </button>
              <button type="button" className={`mode-card ${s.uiMode === "advanced" ? "on" : ""}`} onClick={() => set("uiMode", "advanced")}>
                <strong>高级模式</strong>
                <span>显示全部参数：逐币修正、DOT 叠加、初始状态、计算模式、Monte Carlo 与逐事件日志。</span>
              </button>
            </div>
          </section>

          <section>
            <div className="group-title">新建预设的默认参数</div>
            <div className="settings-grid">
              <label className="field">
                <span>人格等级</span>
                <input type="number" min={1} max={100} value={s.defaultLevel} onChange={(e) => set("defaultLevel", Math.max(1, int(e.target.value, 65)))} />
              </label>
              <label className="field">
                <span>目标防御等级（留空 = 同人格等级）</span>
                <input
                  type="number"
                  min={1}
                  max={150}
                  value={s.defaultTargetDefense ?? ""}
                  placeholder="同人格等级"
                  onChange={(e) => set("defaultTargetDefense", e.target.value === "" ? null : Math.max(1, int(e.target.value, 65)))}
                />
              </label>
              <label className="field">
                <span>初始理智 (SP)</span>
                <input type="number" min={-45} max={45} value={s.defaultSp} onChange={(e) => set("defaultSp", Math.max(-45, Math.min(45, int(e.target.value, 45))))} />
              </label>
              <label className="field">
                <span>加成档位</span>
                <select value={s.defaultBonusTier} onChange={(e) => set("defaultBonusTier", e.target.value as BonusTier)}>
                  {(Object.keys(BONUS_TIER_LABEL) as BonusTier[]).map((k) => (
                    <option key={k} value={k}>
                      {BONUS_TIER_LABEL[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>硬币模式</span>
                <select value={s.defaultCoinMode} onChange={(e) => set("defaultCoinMode", e.target.value as AppSettings["defaultCoinMode"])}>
                  <option value="allHeads">全部正面</option>
                  <option value="allTails">全部反面</option>
                  <option value="monteCarlo">Monte Carlo 期望</option>
                </select>
              </label>
              <label className="field">
                <span>计算模式</span>
                <select value={s.defaultSimMode} onChange={(e) => set("defaultSimMode", e.target.value as AppSettings["defaultSimMode"])}>
                  <option value="orderedCycle">连续 6 回合（保留状态）</option>
                  <option value="staticCycle">静态 3/2/1 加权（每次重置）</option>
                  <option value="multiTurn">多回合（按行动表）</option>
                </select>
              </label>
              <label className="field">
                <span>排轴默认槽位</span>
                <select value={s.defaultSlots} onChange={(e) => set("defaultSlots", Number(e.target.value) as 1 | 2)}>
                  <option value={1}>单槽（每回合 1 技能）</option>
                  <option value={2}>双槽（每回合 2 技能）</option>
                </select>
              </label>
              <label className="field">
                <span>战斗被动</span>
                <select value={s.defaultBattlePassives} onChange={(e) => set("defaultBattlePassives", e.target.value as AppSettings["defaultBattlePassives"])}>
                  <option value="automatic">开启（提示未建模被动）</option>
                  <option value="none">关闭（自行手动补偿）</option>
                </select>
              </label>
            </div>
            <p className="small muted" style={{ marginTop: 8 }}>
              默认参数只影响之后新建的预设；已保存预设的内容不会被修改。
            </p>
          </section>
        </div>

        <div className="modal-foot">
          <button className="link" onClick={() => setS({ ...DEFAULT_SETTINGS })}>
            恢复默认
          </button>
          <span className="grow" />
          <button onClick={onClose}>取消</button>
          <button
            className="primary"
            onClick={() => {
              onSave(s);
              onClose();
            }}
          >
            保存设置
          </button>
        </div>
      </div>
    </div>
  );
}
