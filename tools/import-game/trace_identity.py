"""Trace one identity end-to-end: identity -> skills (uptie IV) -> coins -> effects -> passives -> buffs -> text.

Usage: python trace_identity.py 10105 [pack] [fallbackPack]
Output: data/reports/trace-<id>.md  (generated from local game data; not committed)
"""
from __future__ import annotations

import json
import re
import sys

from common import NORMALIZED_DIR, REPORTS_DIR

TAG_RE = re.compile(r"\[([A-Za-z0-9_]+)\]")


def load(name):
    return json.loads((NORMALIZED_DIR / name).read_text(encoding="utf-8"))


class Text:
    def __init__(self, pack: str, fallback: str):
        self.p = load(f"text/{pack}.json")
        self.f = load(f"text/{fallback}.json")
        self.pack, self.fallback = pack, fallback

    def get(self, cat, key):
        key = str(key)
        if key in self.p.get(cat, {}):
            return self.p[cat][key], None
        if key in self.f.get(cat, {}):
            return self.f[cat][key], f"缺译→{self.fallback}"
        return None, "无文本"

    def label(self, keyword: str) -> str:
        for cat in ("bufs", "keywords"):
            rec, _ = self.get(cat, keyword)
            if rec and rec.get("name"):
                return rec["name"]
        rec, _ = self.get("skillTags", keyword)
        return rec["name"] if rec else f"[{keyword}]"

    def render(self, s: str) -> str:
        return TAG_RE.sub(lambda m: f"{self.label(m.group(1))}", s or "").replace("\n", " / ")


def fmt_script(s: dict) -> str:
    parts = [f"`{s.get('scriptName')}`"]
    bd = s.get("buffData") or {}
    if bd:
        kv = ", ".join(f"{k}={v}" for k, v in bd.items() if v not in ("", None, 0) or k in ("stack", "turn"))
        parts.append(f"buffData{{{kv}}}")
    for k in ("value", "turnLimit"):
        if k in s:
            parts.append(f"{k}={s[k]}")
    return " ".join(parts)


def main() -> None:
    pid = int(sys.argv[1]) if len(sys.argv) > 1 else 10105
    pack = sys.argv[2] if len(sys.argv) > 2 else "LLC_zh-CN"
    fallback = sys.argv[3] if len(sys.argv) > 3 else "en"
    ident = next(i for i in load("identities.json") if i["id"] == pid)
    skills, passives, buffs = load("skills.json"), load("passives.json"), load("buffs.json")
    effects = json.loads((REPORTS_DIR / "effect-scripts.json").read_text(encoding="utf-8"))
    t = Text(pack, fallback)

    pt, pnote = t.get("personalities", pid)
    L = [f"# 追溯样本：{pid} {(pt or {}).get('title', '').replace(chr(10), ' ')} {(pt or {}).get('name', '')}",
         "", f"翻译包：`{pack}`（回退 `{fallback}`）{' — ' + pnote if pnote else ''}。同步阶段：IV。", "",
         "## 人格", "",
         f"- 来源：`{ident['provenance']['file']}`",
         f"- 罪人 characterId={ident['characterId']}，稀有度 rank={ident['rank']}，赛季 {ident.get('season')}，更新日期 {ident['updatedDate']}",
         f"- HP：base={ident['hp']['base']}，perLevel={ident['hp']['perLevel']}（等级换算公式待阶段 C 验证）",
         f"- 防御等级修正 defCorrection={ident['defCorrection']}；速度（四破）{ident['speed']['min']}–{ident['speed']['max']}",
         f"- 混乱阈值 {ident['staggerThresholdsPct']}%；物理抗性 {ident['atkResist']}",
         f"- 专属单位脚本 unitScriptId={ident['unitScriptId']}；开局状态 {ident['initBuffs']}", "",
         "## 技能（四破有效值）", ""]
    entries = [(r["skillId"], f"×{r['count']}") for r in ident["skillPool"]] + [(d, "防御") for d in ident["defenseSkillIds"]]
    for sid, tag in entries:
        s = skills[str(sid)]
        st, snote = t.get("skills", sid)
        a = s["attrs"]
        L += [f"### {sid} {(st or {}).get('name', '')}（{'DEF' if tag == '防御' else (s['slot'] or '-')} {tag}）{' — ' + snote if snote else ''}", "",
              f"- 来源 `{s['file']}`；数据阶段 {s['levelsAvailable']} → 合并 {s['levelsMerged']}；字段来源 {s['fieldSourceLevel']}",
              f"- 罪孽 {a.get('attributeType')}，攻击类型 {a.get('atkType')}，{a.get('defType')}，"
              f"等级修正 {a.get('skillLevelCorrection')}，目标数 {a.get('targetNum')}",
              f"- **基础威力 {s['basePower']}**，硬币 {s['coinCount']} 枚：" +
              " ".join(f"[{c['index']}] {'+' if c['operatorType'] == 'ADD' else c['operatorType']}{c['scale']}" for c in s["coins"]),
              ]
        for sc in s["abilityScripts"]:
            L.append(f"- 技能效果：{fmt_script(sc)}（{effects.get(sc['scriptName'], {}).get('status', '?')}）")
        for c in s["coins"]:
            for sc in c.get("abilityScriptList", []):
                L.append(f"- 硬币[{c['index']}] 效果：{fmt_script(sc)}（{effects.get(sc['scriptName'], {}).get('status', '?')}）")
        if st:
            L.append(f"- 文本（level {st['level']}，`{st['file']}`）：{t.render(st['desc']) or '（无技能描述）'}")
            for i, c in enumerate(st["coins"]):
                for d in c["descs"]:
                    L.append(f"  - 硬币[{i}] 文本：{t.render(d)}")
        L.append("")
    L += ["## 被动", ""]
    for kind, lst in (("战斗", ident["battlePassiveIds"]), ("支援", ident["supportPassiveIds"])):
        for x in lst:
            p = passives.get(str(x), {})
            ptxt, pn = t.get("passives", x)
            cond = p.get("sinCondition") or p.get("raw", {}).get("attributeResonanceCondition")
            L += [f"- {kind} {x} **{(ptxt or {}).get('name', '')}** — 条件 {cond}，{p.get('requireIDList')}"
                  f"{' — ' + pn if pn else ''}",
                  f"  - {t.render((ptxt or {}).get('desc', ''))}"]
    if ident.get("alternativePassives"):
        L.append(f"- ⚠ 备选被动来源（未验证）：{ident['alternativePassives']}")
    used = sorted({(sc.get("buffData") or {}).get("buffKeyword") for s in (skills[str(e[0])] for e in entries)
                   for sc in s["abilityScripts"] + [x for c in s["coins"] for x in c.get("abilityScriptList", [])]} - {None})
    L += ["", "## 涉及的状态", ""]
    for b in used:
        rec = buffs.get(b, {})
        bt, bn = t.get("bufs", b)
        kt, _ = t.get("keywords", b)
        L += [f"- `{b}` **{(bt or kt or {}).get('name', '')}** — {rec.get('buffClass')} / {rec.get('buffType')} / "
              f"能力 {[x.get('ability') for x in rec.get('list', [])]} / 来源 `{rec.get('file')}`{' — ' + bn if bn else ''}",
              f"  - 关键词说明：{t.render((kt or {}).get('desc', ''))}"]
    out = REPORTS_DIR / f"trace-{pid}.md"
    out.write_text("\n".join(L) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
