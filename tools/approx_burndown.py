"""Group damage-gaps.json approxRanking entries by root cause → data/reports/approx-burndown.md (+ .json).

Usage: python tools/approx_burndown.py [--before data/reports/_approx_before.json]
Rules are first-match keyword rules on the approx reason (manual overrides in OVERRIDE).
"""
import json, re, sys, collections

sys.stdout.reconfigure(encoding="utf-8")
GAPS = "data/reports/damage-gaps.json"

# (key, title, status, api/owner, regex on reason)
# status: resolvable = new API available & not in another agent's scope; other-agent = API exists but owned by A70x;
#         inherent = scenario model limitation (no clash/kill/enemy action/SP dynamics); engine = engine capability missing;
#         research = ISIL/parameter uncertainty; nodmg = approximated part does not affect output.
RULES = [
    ("vibExplosion", "震颤引爆事件", "resolvable", "onVibrationExplosion（被动/状态能力）", r"震颤引爆|震颤爆发|VibrationExplosion|混乱阈值前移"),
    ("giveAdder", "修改施加的状态数值", "resolvable", "interceptStatus / giveAdder / blockSkillGains", r"修改施加|施加状态数值|施加的状态量|GetGiveBuff|仅对本次施加已包含的维度|溢出钩子"),
    ("consume", "状态消耗事件（按层数下降推断）", "resolvable", "c.action.consumedStack/Turn、onStatusChange", r"层数下降|消耗事件|充能消耗钩子|消耗量通过观察|按回合内充能层数减少|累计消耗.*未建模|累计消耗量"),
    ("targetSp", "目标理智值", "resolvable", "c.targetSp（场景 target.initialSp）", r"目标理智|目标的理智|理智值<0目标|目标无理智|目标.*理智值"),
    ("ammo", "弹药/装填（A705）", "other-agent", "A705 reloads", r"装填|弹药|子弹|生蝶|亡蝶|孢子弹|BulletLament"),
    ("coinAdd", "追加硬币 / 超级硬币（A702）", "other-agent", "coins.add / makeSuper（A702 coins）", r"追加硬币|添加硬币|额外的两枚硬币|SuperCoin|超级硬币|不可摧毁硬币"),
    ("insert", "追加/插入行动（A706）", "other-agent", "queueAction（A706 inserted/follow-up actions）", r"追加技能|插入|追击|追加攻击|追加使用|额外攻击|联合攻击|支援攻击|必然杀|重复使用"),
    ("replace", "技能替换/转化（A703）", "other-agent", "replaceSkill / beforeUse（A703）", r"技能转化|技能替换|技能强化\(替换\)|升级技能|转化为“|变身|专属技能|强化2、3技能"),
    ("multi", "多目标（A707）", "other-agent", "attackWeight / hitTargetCount / allTargets（A707）", r"多目标|攻击容量|目标数|全体目标|主要目标|横扫|RandomEnemy|单目标"),
    ("stagger", "目标混乱", "resolvable", "targetStaggered / onTargetStagger（opt-in 混乱模型）", r"混乱(?!解除)|Break"),
    ("resonance", "罪孽共鸣数", "resolvable", "battle.resonance / perfectResonance（场景声明）", r"共鸣"),
    ("ally", "队友/友方（A706）", "other-agent", "allyPresent / A706 allies", r"队友|友方|同事务所|黑派|剑契|学徒"),
    ("clash", "拼点（无拼点模型）", "inherent", "—", r"拼点"),
    ("kill", "击杀/阵亡", "inherent", "—", r"击杀|阵亡|不死"),
    ("enemyAct", "受击/敌方行动", "inherent", "—", r"受击|目标不攻击|受到攻击|受伤|反击|守备技能|被攻击|自身受到的伤害"),
    ("random", "随机（确定性近似，A704 MC）", "other-agent", "A704 Monte Carlo", r"随机|概率|期望|轮换|轮流"),
    ("selfSp", "自身理智值动态", "engine", "仅 actorSp 常量", r"理智"),
    ("shield", "护盾", "engine", "—", r"护盾"),
    ("timing", "回合/战斗开始时机", "resolvable", "ability onRoundStart / onBattleStart / onSkillStart", r"预约下回合|回合开始|战斗开始时|战斗结束时机|结算顺序|结算前|命中时检查"),
    ("hp", "体力/最大体力", "nodmg", "targetMaxHp / selfHpRatio（场景）", r"体力"),
    ("research", "参数/类未解析（ISIL 研究）", "research", "ISIL", r"类未解析|按描述|推断|取自描述|取整|Util\.Round|ISIL|参数含义|未确定|常量"),
    ("nodmg", "不影响输出的部分", "nodmg", "—", r"不影响|速度|敏捷|迅捷|防御|E\.G\.O|嘲讽|挑衅|恢复|回复"),
]
OVERRIDE = {
    "passive:1031504": "insert",  # “审判！”(1031505) insertion — left for A706
    "effect:CriticalDmgUpByRatioIfTargetBreak40": "stagger",
    "effect:AttackDmgUpByRatio10IfBreak": "stagger",
}


def classify(eid, reason):
    if eid in OVERRIDE:
        return OVERRIDE[eid]
    for key, _t, _s, _a, rx in RULES:
        if re.search(rx, reason):
            return key
    return "misc"


STATUS_LABEL = {
    "resolvable": "可用新 API 解决",
    "other-agent": "API 已有，属其他 Agent 范围",
    "inherent": "场景模型固有（无拼点/无击杀/敌方不行动）",
    "engine": "引擎缺能力",
    "research": "需 ISIL 研究/参数不确定",
    "nodmg": "不影响输出",
}

# Fixed in the burn-down round (2026-10-31): handler → how.
FIXED = [
    ("passive:1010501 / 1020711 / 1011411 / 1060901 / 1090501 / 1110501", "onVibrationExplosion：引爆时防御等级降低/突破之马/引爆计数/消耗充能+迅捷+打击伤害强化/怠惰追加伤害"),
    ("passive:1011602 / 1021011 / 1070911 / 1071301 / 1091603 / 1091702 / 1101312 / 1111001 / 1121101 / 1121502", "消耗量改用 ActionRecord（used-tracker.ts newlyConsumed/usedPerThreshold），不再按层数下降推断"),
    ("status:GiveBuffStackAdderIfDefaultSkill / passive:1100701 / 1120501", "giveAdder（GetGiveBuffStackAdder/TurnAdder）"),
    ("status:*:GiveBuffOnRoundStart / GiveBuffOnRSPerStack", "状态能力 onRoundStart（第1回合由关卡开始被动给予的状态保留首枚硬币前补发）"),
    ("effect:1010103_1 / LCAOutisVEOnSA_AzureTakeDamageUp1 / passive:1110101", "c.targetSp（场景目标理智）"),
    ("effect:CriticalDmgUpByRatioIfTargetBreak40 / AttackDmgUpByRatio10IfBreak", "c.targetStaggered（可选混乱模型）"),
    ("passive:1030201 / 1070311 / 1080211 / 1101501 / 1121411、effect:LastCoinResultAdderOnBAViaMaxResonanceToLimit1031502_1_4", "battle.resonance（场景共鸣数，默认 0 → 默认结果不变）"),
]


def write_md(groups, meta, g, before):
    L = ["# approx 烧减表（approx burn-down）", ""]
    L.append(f"数据源：`data/reports/damage-gaps.json`（默认预设、全正面）。生成：`python tools/approx_burndown.py`。")
    if before:
        L.append(f"本轮：approx 条目 {before['approxCount']} → **{g['approxCount']}**；无 approx 人格 {before['noApproxGaps']} → {g['noApproxGaps']}（共 {g['total']}）。")
    L += ["", "## 按根因汇总", "", "| 根因 | 状态 | 可用 API / 负责方 | 条目 |", "|---|---|---|---|"]
    for k, rows in groups.items():
        if rows:
            t, s, a = meta[k]
            L.append(f"| {t} | {STATUS_LABEL[s]} | {a} | {len(rows)} |")
    L += ["", "## 本轮已修复", ""]
    for ids, how in FIXED:
        L.append(f"- {ids}：{how}")
    L += ["", "留待其他 Agent：", "- **“审判！”(1031505) 插入行动**（passive:1031504）：由 A706（插入/追加行动）实现后接入，本轮不动。",
          "- 多目标（A707）、替换技能（A703）、硬币增加/超级硬币（A702）、装填（A705）、随机（A704 MC）归对应 Agent。", ""]
    L += ["## 明细", ""]
    for k, rows in groups.items():
        if not rows:
            continue
        t, s, a = meta[k]
        L.append(f"### {t}（{STATUS_LABEL[s]}，{len(rows)}）")
        L.append("")
        for r in rows:
            L.append(f"- `{r['id']}` [{', '.join(map(str, r['identities']))}] — {r['reason']}")
        L.append("")
    open("data/reports/approx-burndown.md", "w", encoding="utf-8").write("\n".join(L))


def main():
    before = None
    if "--before" in sys.argv:
        before = json.load(open(sys.argv[sys.argv.index("--before") + 1], encoding="utf-8"))
    g = json.load(open(GAPS, encoding="utf-8"))
    per_id = collections.defaultdict(list)
    for p in g["perIdentity"]:
        for a in p.get("approxGaps", []):
            per_id[a].append(p["id"])
    groups = collections.OrderedDict((k, []) for k, *_ in RULES)
    groups["misc"] = []
    for r in g["approxRanking"]:
        groups[classify(r["id"], r["reason"])].append(r)
    meta = {k: (t, s, a) for k, t, s, a, _ in RULES}
    meta["misc"] = ("其他", "research", "—")
    out = {"approxCount": g.get("approxCount"), "noApproxGaps": g.get("noApproxGaps"), "groups": {}}
    for k, rows in groups.items():
        out["groups"][k] = [{"id": r["id"], "identities": per_id.get(r["id"], []), "reason": r["reason"]} for r in rows]
    json.dump(out, open("data/reports/approx-burndown.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    by_status = collections.Counter()
    for k, rows in groups.items():
        by_status[meta[k][1]] += len(rows)
    print("total", sum(len(v) for v in groups.values()), dict(by_status))
    write_md(out["groups"], meta, g, before)
    for k, rows in groups.items():
        print(f"{k:12} {meta[k][1]:12} {len(rows)}")


if __name__ == "__main__":
    main()
