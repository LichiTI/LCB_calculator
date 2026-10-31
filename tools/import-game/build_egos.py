"""Extract and normalize all E.G.O records, E.G.O Awakening/Corrosion skills, and E.G.O passives at Threadspin IV."""
from __future__ import annotations

import json
from collections import defaultdict
from common import NORMALIZED_DIR, RAW_DIR, read_json_lenient, write_json
from normalize import index_by, load_lists, resolve_levels

UPTIE = 4


def main() -> None:
    dups: list = []
    egos_raw = index_by(load_lists("ego"), "id", dups, "ego")
    skills_raw = index_by(load_lists("skill"), "id", dups, "skill")
    passives_raw = index_by(load_lists("passive"), "id", dups, "passive")
    identities = json.loads((NORMALIZED_DIR / "identities.json").read_text(encoding="utf-8"))

    # Map characterId -> list of identity IDs so E.G.O skills are valid for any identity of the same Sinner
    char_identities: dict[int, list[int]] = defaultdict(list)
    for ident in identities:
        cid = ident.get("characterId")
        if cid is not None:
            char_identities[cid].append(ident["id"])

    egos_out = []
    ego_skills: dict[str, dict] = {}
    ego_passives: dict[str, dict] = {}

    for eid in sorted(egos_raw):
        file, e = egos_raw[eid]
        cid = e.get("characterId")
        owners = sorted(char_identities.get(cid, []))

        raw_pids = list(e.get("passiveList", []) or []) + list(e.get("awakeningPassiveList", []) or [])
        passive_ids = []
        for pid in raw_pids:
            if pid not in passives_raw:
                continue
            pfile, prec = passives_raw[pid]
            reqs = prec.get("requireIDList", []) or []
            if "CheckAwakenLevel5" in reqs:
                continue
            passive_ids.append(pid)
            ego_passives[str(pid)] = {
                "id": pid,
                "file": f"passive/{pfile}",
                "owners": owners,
                "requireIDList": reqs,
                "sinCondition": (prec.get("attributeResonanceCondition") or prec.get("attributeStockCondition") or []),
            }

        awaken_sid = e.get("awakeningSkillId")
        corrosion_sid = e.get("corrosionSkillId")

        for sid, slot_label in ((awaken_sid, "EGO觉醒"), (corrosion_sid, "EGO侵蚀")):
            if not sid or sid not in skills_raw:
                continue
            sfile, srec = skills_raw[sid]
            eff, src, used = resolve_levels(srec.get("skillData", []), UPTIE)
            if not used:
                continue
            coins = [{"index": i, **c} for i, c in enumerate(eff.pop("coinList", []) or [])]
            scripts = eff.pop("abilityScriptList", []) or []
            ego_skills[str(sid)] = {
                "id": sid,
                "file": f"skill/{sfile}",
                "skillType": srec.get("skillType"),
                "skillTier": srec.get("skillTier", 3),
                "slot": slot_label,
                "requireIDList": srec.get("requireIDList", []),
                "owners": owners,
                "discoveredVia": [f"ego:{eid}"],
                "levelsAvailable": sorted(d.get("gaksungLevel", 1) for d in srec.get("skillData", [])),
                "levelsMerged": used,
                "fieldSourceLevel": src,
                "basePower": eff.get("defaultValue", 0),
                "coinCount": len(coins),
                "attrs": eff,
                "abilityScripts": scripts,
                "coins": coins,
            }

        egos_out.append({
            "id": eid,
            "file": f"ego/{file}",
            "characterId": cid,
            "egoType": e.get("egoType", "ZAYIN"),
            "season": e.get("season", 0),
            "requirements": [
                {"attributeType": r.get("attributeType"), "num": r.get("num", 0)}
                for r in (e.get("requirementList") or [])
            ],
            "passiveIds": passive_ids,
            "awakeningSkillId": awaken_sid if awaken_sid and str(awaken_sid) in ego_skills else None,
            "corrosionSkillId": corrosion_sid if corrosion_sid and str(corrosion_sid) in ego_skills else None,
        })

    write_json(NORMALIZED_DIR / "egos.json", {
        "egos": egos_out,
        "skills": ego_skills,
        "passives": ego_passives,
    })
    print(f"egos: {len(egos_out)} E.G.O, {len(ego_skills)} E.G.O skills, {len(ego_passives)} E.G.O passives")


if __name__ == "__main__":
    main()
