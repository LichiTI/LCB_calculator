/** UI-only labels (presentation constants; never used in calculations). */
export const SIN_LABEL: Record<string, { zh: string; color: string }> = {
  CRIMSON: { zh: "暴怒", color: "#d6403a" },
  SCARLET: { zh: "色欲", color: "#e8792e" },
  AMBER: { zh: "怠惰", color: "#e6c33e" },
  SHAMROCK: { zh: "暴食", color: "#8bc34a" },
  AZURE: { zh: "忧郁", color: "#3fa4e0" },
  INDIGO: { zh: "傲慢", color: "#4a5fc9" },
  VIOLET: { zh: "嫉妒", color: "#9b59b6" },
  NEUTRAL: { zh: "无", color: "#999" },
};

export const ATK_LABEL: Record<string, string> = { SLASH: "斩击", PENETRATE: "突刺", HIT: "打击", NONE: "—" };
export const DEF_LABEL: Record<string, string> = { ATTACK: "攻击", GUARD: "防御", EVADE: "闪避", COUNTER: "反击" };

export const sinText = (s?: string) => (s ? SIN_LABEL[s]?.zh ?? s : "—");
