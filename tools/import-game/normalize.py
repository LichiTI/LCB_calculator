"""Build uptie-IV normalized identity data from data/raw/static-data.

Uptie resolution rules (evidence in docs/phase-a-report.md):
  * skillData[]: sort by gaksungLevel, keep levels <= 4, apply as field-level overrides in
    ascending order. An empty list does NOT override an earlier non-empty list
    (1061602 / 1061604: level-4 coinList == [] while text keeps 2 / 1 coins).
  * battlePassiveList / supporterPassiveList / initBuffList: every level entry is a full
    snapshot -> take the entry with the highest level <= 4 (no accumulation).
  * minSpeedList / maxSpeedList: index = uptie - 1.

Outputs: data/normalized/{identities,skills,passives,buffs}.json,
         data/reports/normalize-report.json, data/reports/effect-scripts.json
"""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path

from common import NORMALIZED_DIR, RAW_DIR, REPORTS_DIR, read_json_lenient, write_json

UPTIE = 4
STATIC = RAW_DIR / "static-data"
SKILL_CHANGE_PREFIXES = ("ChangeSkill", "SkillChange")
SLOT_BY_TIER = {1: "S1", 2: "S2", 3: "S3"}


def load_lists(group: str) -> list[tuple[str, dict]]:
    """Return (file, record) for every record in static-data/<group>/*.json, file order stable."""
    out = []
    for path in sorted((STATIC / group).glob("*.json")):
        data = read_json_lenient(path)
        records = data.get("list", []) if isinstance(data, dict) else data
        for rec in records:
            if isinstance(rec, dict):
                out.append((path.name, rec))
    return out


def index_by(records, key, report_dups: list, group: str) -> dict:
    idx: dict = {}
    for file, rec in records:
        k = rec.get(key)
        if k is None:
            continue
        if k in idx:
            same = json.dumps(idx[k][1], sort_keys=True) == json.dumps(rec, sort_keys=True)
            report_dups.append({"group": group, "id": k, "files": [idx[k][0], file], "identical": same})
            continue  # keep first; duplicates are reported, never merged silently
        idx[k] = (file, rec)
    return idx


def resolve_levels(levels: list[dict], uptie: int = UPTIE):
    """Field-level cascade of skillData entries up to `uptie`."""
    ordered = sorted(levels, key=lambda d: d.get("gaksungLevel", 1))
    merged: dict = {}
    source: dict = {}
    used = []
    for entry in ordered:
        lv = entry.get("gaksungLevel", 1)
        if lv > uptie:
            continue
        used.append(lv)
        for field, value in entry.items():
            if field == "gaksungLevel":
                continue
            if isinstance(value, list) and not value and field in merged:
                continue  # empty list = inherit
            merged[field] = value
            source[field] = lv
    return merged, source, used


def snapshot_at(entries: list[dict], uptie: int = UPTIE):
    eligible = [e for e in entries or [] if e.get("level", 1) <= uptie]
    return max(eligible, key=lambda e: e["level"]) if eligible else None


def iter_scripts(skill_eff: dict):
    for s in skill_eff.get("abilityScriptList", []) or []:
        yield "skill", None, s
    for i, coin in enumerate(skill_eff.get("coinList", []) or []):
        for s in coin.get("abilityScriptList", []) or []:
            yield "coin", i, s


def main() -> None:
    dups: list = []
    personalities = index_by(load_lists("personality"), "id", dups, "personality")
    p_passives = index_by(load_lists("personality-passive"), "personalityID", dups, "personality-passive")
    skills_raw = index_by(load_lists("skill"), "id", dups, "skill")
    passives_raw = index_by(load_lists("passive"), "id", dups, "passive")
    buffs_raw = index_by(load_lists("buff"), "id", dups, "buff")

    problems: list = []
    identities = []
    skill_owner: dict[int, set] = defaultdict(set)
    skill_via: dict[int, set] = defaultdict(set)
    passive_owner: dict[int, set] = defaultdict(set)

    for pid in sorted(personalities):
        file, p = personalities[pid]
        pool = [{"skillId": a["skillId"], "count": a["number"]} for a in p.get("attributeList", [])]
        defense = list(p.get("defenseSkillIDList", []))
        for sid in [x["skillId"] for x in pool] + defense:
            skill_owner[sid].add(pid)
            skill_via[sid].add("attributeList" if sid not in defense else "defenseSkillIDList")

        # passives
        battle, support, psrc = [], [], None
        if pid in p_passives:
            pp = p_passives[pid][1]
            b = snapshot_at(pp.get("battlePassiveList"))
            s = snapshot_at(pp.get("supporterPassiveList"))
            battle = b["passiveIDList"] if b else []
            support = s["passiveIDList"] if s else []
            psrc = {"file": p_passives[pid][0], "battleLevel": b and b["level"], "supportLevel": s and s["level"]}
        alt_passives = None
        if "passiveSet" in p or "supporterPassiveSet" in p:
            set_b = p.get("passiveSet", {}).get("passiveIdList", [])
            set_s = p.get("supporterPassiveSet", {}).get("passiveIdList", [])
            if psrc is None:
                battle, support = set_b, set_s
                psrc = {"file": file, "field": "passiveSet/supporterPassiveSet"}
            elif sorted(set_b) != sorted(battle) or sorted(set_s) != sorted(support):
                # personality-passive is level-aware and therefore preferred; keep the
                # alternative visible until verified in game.
                alt_passives = {"battle": set_b, "support": set_s, "field": "passiveSet"}
                problems.append({"type": "passive-source-conflict", "identity": pid,
                                 "personalityPassive": {"battle": battle, "support": support},
                                 "passiveSet": {"battle": set_b, "support": set_s},
                                 "chosen": "personality-passive", "status": "unverified"})
        if psrc is None:
            problems.append({"type": "no-passive-record", "identity": pid})
        for x in battle + support + ((alt_passives or {}).get("battle", []) + (alt_passives or {}).get("support", [])):
            passive_owner[x].add(pid)

        def at_uptie(lst):
            if not lst:
                return None
            if len(lst) < UPTIE:
                problems.append({"type": "speed-list-short", "identity": pid, "len": len(lst)})
                return lst[-1]
            return lst[UPTIE - 1]

        init = snapshot_at(p.get("initBuffList"))
        identities.append({
            "id": pid,
            "characterId": p.get("characterId"),
            "rank": p.get("rank"),
            "season": p.get("season"),
            "updatedDate": p.get("updatedDate"),
            "appearance": p.get("appearance"),
            "uptie": UPTIE,
            "unitKeywords": p.get("unitKeywordList", []),
            "associations": p.get("associationList", []),
            "skillKeywords": p.get("skillKeywordList", []),
            "uniqueAttribute": p.get("uniqueAttribute"),
            "hp": {"base": p["hp"]["defaultStat"], "perLevel": p["hp"]["incrementByLevel"]},
            "defCorrection": p.get("defCorrection"),
            "speed": {"min": at_uptie(p.get("minSpeedList")), "max": at_uptie(p.get("maxSpeedList"))},
            "staggerThresholdsPct": p.get("breakSection", {}).get("sectionList", []),
            "atkResist": {r["type"]: r["value"] for r in p.get("resistInfo", {}).get("atkResistList", [])},
            "skillPool": pool,
            "defenseSkillIds": defense,
            "panicSkillOnErosion": p.get("panicSkillOnErosion"),
            "battlePassiveIds": battle,
            "supportPassiveIds": support,
            "alternativePassives": alt_passives,
            "initBuffs": init["list"] if init else [],
            "unitScriptId": p.get("unitScriptID"),
            "walpurgisType": p.get("walpurgisType"),
            "isPlusCoinUnit": p.get("isPlusCoinUnit"),
            "mentalConditionInfo": p.get("mentalConditionInfo"),
            "provenance": {"file": f"personality/{file}", "passives": psrc,
                           "initBuffLevel": init and init.get("level")},
        })

    # --- skills: resolve identity skills + transitive ChangeSkill targets
    skills_out: dict[str, dict] = {}
    queue = sorted(skill_owner)
    seen = set()
    effect_usage: dict[str, dict] = {}
    while queue:
        sid = queue.pop(0)
        if sid in seen:
            continue
        seen.add(sid)
        if sid not in skills_raw:
            problems.append({"type": "dangling-skill", "skillId": sid, "owners": sorted(skill_owner[sid])})
            continue
        file, rec = skills_raw[sid]
        eff, src, used = resolve_levels(rec["skillData"])
        if not used:
            problems.append({"type": "no-skill-level-le-4", "skillId": sid})
            continue
        coins = [{"index": i, **c} for i, c in enumerate(eff.pop("coinList", []) or [])]
        scripts = eff.pop("abilityScriptList", []) or []
        skills_out[str(sid)] = {
            "id": sid, "file": f"skill/{file}", "skillType": rec.get("skillType"), "skillTier": rec.get("skillTier"),
            "slot": SLOT_BY_TIER.get(rec.get("skillTier")), "requireIDList": rec.get("requireIDList", []),
            "owners": sorted(skill_owner[sid]), "discoveredVia": sorted(skill_via[sid]),
            "levelsAvailable": sorted(d.get("gaksungLevel", 1) for d in rec["skillData"]),
            "levelsMerged": used, "fieldSourceLevel": src,
            "basePower": eff.get("defaultValue"), "coinCount": len(coins),
            "attrs": eff, "abilityScripts": scripts, "coins": coins,
        }
        merged_view = {"abilityScriptList": scripts, "coinList": coins}
        for scope, coin_idx, s in iter_scripts(merged_view):
            name = s.get("scriptName")
            u = effect_usage.setdefault(name, {"uses": 0, "skills": set(), "identities": set(), "scopes": set(),
                                               "buffKeywords": set()})
            u["uses"] += 1
            u["skills"].add(sid)
            u["identities"].update(skill_owner[sid])
            u["scopes"].add(scope)
            if (s.get("buffData") or {}).get("buffKeyword"):
                u["buffKeywords"].add(s["buffData"]["buffKeyword"])
            v = s.get("value")
            if name and name.startswith(SKILL_CHANGE_PREFIXES) and isinstance(v, int) and v in skills_raw:
                for owner in skill_owner[sid]:
                    skill_owner[v].add(owner)
                skill_via[v].add(f"{name}<-{sid}")
                if v not in seen:
                    queue.append(v)

    # owners / discovery reasons may grow after a skill was first resolved -> backfill
    for k, s in skills_out.items():
        s["owners"] = sorted(skill_owner[s["id"]])
        s["discoveredVia"] = sorted(skill_via[s["id"]])

    # --- passives & buffs
    passives_out = {}
    for pid in sorted(passive_owner):
        if pid not in passives_raw:
            problems.append({"type": "dangling-passive", "passiveId": pid, "owners": sorted(passive_owner[pid])})
            continue
        file, rec = passives_raw[pid]
        passives_out[str(pid)] = {"id": pid, "file": f"passive/{file}", "owners": sorted(passive_owner[pid]),
                                  "sinCondition": rec.get("attributeStockCondition", []),
                                  "requireIDList": rec.get("requireIDList", []), "raw": rec}
    buffs_out = {k: {"id": k, "file": f"buff/{f}", **{kk: vv for kk, vv in r.items() if kk != "id"}}
                 for k, (f, r) in sorted(buffs_raw.items())}

    referenced_buffs = set()
    for s in skills_out.values():
        for _, _, sc in iter_scripts({"abilityScriptList": s["abilityScripts"], "coinList": s["coins"]}):
            kw = (sc.get("buffData") or {}).get("buffKeyword")
            if kw:
                referenced_buffs.add(kw)
    for ident in identities:
        referenced_buffs.update(b.get("buff") for b in ident["initBuffs"] if b.get("buff"))
    missing_buffs = sorted(b for b in referenced_buffs if b not in buffs_raw)

    for pid in sorted(set(p_passives) - set(personalities)):
        problems.append({"type": "personality-passive-without-personality", "personalityId": pid})

    write_json(NORMALIZED_DIR / "identities.json", identities)
    write_json(NORMALIZED_DIR / "skills.json", skills_out)
    write_json(NORMALIZED_DIR / "passives.json", passives_out)
    write_json(NORMALIZED_DIR / "buffs.json", buffs_out)
    effects = {k: {"uses": v["uses"], "skillCount": len(v["skills"]), "identityCount": len(v["identities"]),
                   "scopes": sorted(v["scopes"]), "buffKeywords": sorted(v["buffKeywords"]),
                   "sampleSkills": sorted(v["skills"])[:5], "status": "displayOnly"}
               for k, v in sorted(effect_usage.items(), key=lambda kv: (-kv[1]["uses"], kv[0]))}
    write_json(REPORTS_DIR / "effect-scripts.json", effects, sort_keys=False)
    report = {
        "uptie": UPTIE,
        "counts": {"identities": len(identities), "skills": len(skills_out), "passives": len(passives_out),
                   "buffsAll": len(buffs_out), "buffsReferenced": len(referenced_buffs),
                   "distinctEffectScripts": len(effects)},
        "variantSkills": sorted(int(k) for k, s in skills_out.items()
                                if any("<-" in v for v in s["discoveredVia"])),
        "levelPatterns": Counter(",".join(map(str, s["levelsAvailable"])) for s in skills_out.values()).most_common(),
        "duplicates": dups,
        "missingBuffs": missing_buffs,
        "problems": problems,
        "identitiesWithUnitScript": [i["id"] for i in identities if i["unitScriptId"] is not None],
        "updatedDateMax": max(i["updatedDate"] or 0 for i in identities),
    }
    write_json(REPORTS_DIR / "normalize-report.json", report, sort_keys=False)
    print(json.dumps(report["counts"], ensure_ascii=False))
    print("problems:", Counter(p["type"] for p in problems))
    print("duplicates:", Counter((d["group"], d["identical"]) for d in dups))
    print("missing buffs:", len(missing_buffs), missing_buffs[:10])
    print("variant skills:", report["variantSkills"])


if __name__ == "__main__":
    main()
