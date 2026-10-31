"""Identity list + effect coverage summary for the phase-A report.

Output: data/reports/identity-list.json; prints aggregate numbers used in docs/phase-a-report.md
"""
from __future__ import annotations

import json
import re
from collections import Counter

from common import NORMALIZED_DIR, REPORTS_DIR, write_json


def load(name):
    return json.loads((NORMALIZED_DIR / name).read_text(encoding="utf-8"))


def family(script: str) -> str:
    """Coarse family of an effect script, for planning handler work (not a rule)."""
    if re.fullmatch(r"\d+(_\w+)?", script) or re.search(r"\d{5,}", script):
        return "bespoke(id-named)"
    for prefix in ("GiveBuff", "CoinScaleAdder", "SkillPowerAdder", "SkillPowerResultAdder", "ParryingPowerResultAdder",
                   "AttackDmgUp", "VibrationExplosion", "ChangeSkill", "Reroll", "Discard", "AddTaunt", "Heal",
                   "Recover", "Consume", "Lose", "Burst", "Combustion", "Laceration", "Sinking", "Breath", "Charge"):
        if script.startswith(prefix):
            return prefix
    return "other"


def main() -> None:
    identities = load("identities.json")
    skills = load("skills.json")
    zh = load("text/LLC_zh-CN.json")
    en = load("text/en.json")
    effects = json.loads((REPORTS_DIR / "effect-scripts.json").read_text(encoding="utf-8"))
    rows = []
    for i in identities:
        sids = [r["skillId"] for r in i["skillPool"]] + i["defenseSkillIds"]
        scripts = set()
        for sid in sids:
            s = skills[str(sid)]
            for sc in s["abilityScripts"] + [x for c in s["coins"] for x in c.get("abilityScriptList", [])]:
                scripts.add(sc["scriptName"])
        z = zh["personalities"].get(str(i["id"]))
        e = en["personalities"].get(str(i["id"]))
        rows.append({"id": i["id"], "characterId": i["characterId"], "rank": i["rank"],
                     "updatedDate": i["updatedDate"],
                     "nameZh": z and f"{z.get('title', '').replace(chr(10), ' ')} {z.get('name', '')}".strip(),
                     "nameEn": e and f"{e.get('title', '').replace(chr(10), ' ')} {e.get('name', '')}".strip(),
                     "hasZhText": z is not None, "unitScriptId": i["unitScriptId"],
                     "skillKeywords": i["skillKeywords"], "distinctEffectScripts": len(scripts),
                     "verifiedEffectScripts": 0, "coverage": "displayOnly"})
    write_json(REPORTS_DIR / "identity-list.json", rows, sort_keys=False)

    fam = Counter()
    fam_uses = Counter()
    for name, v in effects.items():
        f = family(name)
        fam[f] += 1
        fam_uses[f] += v["uses"]
    single = sum(1 for v in effects.values() if v["identityCount"] == 1)
    print("identities", len(rows), "by rank", Counter(r["rank"] for r in rows),
          "latest", sorted(rows, key=lambda r: -r["updatedDate"])[:3])
    print("rows without zh text", [r["id"] for r in rows if not r["hasZhText"]])
    print("scripts", len(effects), "used by single identity", single)
    print("families (distinct, uses):", [(f, fam[f], fam_uses[f]) for f, _ in fam_uses.most_common()])
    kw = Counter(k for r in rows for k in r["skillKeywords"])
    print("skillKeywords", kw.most_common())


if __name__ == "__main__":
    main()
