# 阶段 A 报告：数据勘察与提取

日期：2026-10-30。数据版本：构建 `s20261029_fEm3iOclvbv1ktrTHSTt`，Unity `6000.3.12f1`，Addressables `2.9.1`。
复现方式：`python tools/import-game/run_all.py`。两次运行的输出摘要一致：normalized `f2c6697f99a82389`，reports `9cd375be819a8518`。

## 1. 结论（准入条件）

| 条件 | 状态 |
| --- | --- |
| 至少一个人格可以从真实数值追溯到正式中文 | ✅ 10105 全链路已核对，见 §6 |
| 不使用虚构字段 | ✅ 标准化字段保留原始字段名，额外字段只做重命名或推导，并记录来源阶段 |
| 导入可以复现 | ✅ 输出确定，输入不变时哈希稳定 |
| 192 个人格可浏览（数据层面） | ✅ 中文缺 2 个（最新人格，回退英文） |
| 可以计算伤害 | ❌ 尚未进入阶段 C；效果脚本全部是 `displayOnly` |

## 2. 数据来源（已核实）

- 当前目录是 `persistentDataPath/com.unity.addressables/catalog_S1.bin`（二进制，2026-10-29）。`catalog_S1.json`（2026-05-21）已过时，**不使用**。
- 静态数据在 `static_s1_0_assets_all_79d2cba7d185752a5f5b0edf8d83e661.bundle`，共 2197 个 TextAsset，**明文 JSON，没有加密**。
- 缓存映射规则：`<Unity缓存>/<任意哈希>/<bundle 名里的 32 位哈希>/__data`。bundle 头里的版本被抹掉了，需要从 `globalgamemanagers` 读取 Unity 版本，再交给 UnityPy。
- 翻译按游戏自带的 `Localize/RemoteLocalizeFileList.json` 分类、按顺序加载；不在清单里的文件不加载，只报告（例如 `Skills_Ego_Personality-nextupdate-notinclude.json`）。

## 3. 四破解析规则与证据

### 3.1 技能 `skillData[]`：逐字段级联覆盖

规则：按 `gaksungLevel` 升序取所有 ≤4 的项，后面的项覆盖前面的同名字段；**空数组不覆盖**。

证据：
- 887 个人格技能中，第一项总是包含全部核心字段，后续项只覆盖部分字段（`coinList` 1079 次、`abilityScriptList` 1057 次、`defaultValue` 511 次……）。
- 1010501 的 level 3 只有 `defaultValue: 3`。如果不级联，这一阶段就没有硬币，不可能成立。中文文本只有 1/2/4 三个版本，正好说明 level 3 只改数值、不改描述。
- 空数组：1061602 和 1061604 在 level 4 的 `coinList` 是 `[]`，但 level 4 文本仍然分别有 2 枚、1 枚硬币。
- 用文本硬币数做交叉检验：“空数组沿用”吻合 872/883（英文），“空数组覆盖”吻合 870/883。剩下 4 个不一致都是**文本省略了末尾没有描述的硬币**，所以硬币数以数据为准，文本只能当下限。

置信度：高。“空数组沿用”只有 2 个直接例证，阶段 C 需要在游戏内抽查一次。

### 3.2 被动、开局状态：取最高阶段的完整快照

规则：在 `battlePassiveList`、`supporterPassiveList`、`initBuffList` 中，取 level ≤4 里最高的那一项，**整体替换，不累加**。

证据：10109 的 L2 是 `[1010902, 1010901]`，L4 是 `[1010902, 1010911]`，后一阶段把前一阶段的被动完整重列了一遍；被动 1010911 自带 `CheckAwakenLevel4`。

### 3.3 速度

`minSpeedList[3]` 和 `maxSpeedList[3]`，所有人格的列表长度都是 4。

### 3.4 文本

`levelList` 每一项都是完整快照，取 level ≤4 的最高项。

## 4. 数据要点（实现时必须遵守）

1. **stack/turn 的含义取决于状态类别。** 对 DOT（烧伤、流血、震颤、破裂、沉沦，内部类别 `SinBuff`）：`stack` = 强度（potency），`turn` = 层数（count），例如 1010501 的“施加 3 层震颤”对应 `turn:3`。但对 `VolatileBuff`（例如 `DefenseDown`）：`stack:2, turn:0` 在文本里是“2 层”。手动 `coinDots → StatusAmount` 的映射必须按状态类别规则走，不能直接把 `stack` 当强度。
2. **变体技能**：12 个，由 `ChangeSkill*` / `SkillChange*` 脚本的 `value` 引用，同时出现在 `attributeList` 里且 `count: 0`。
3. **被动数据只有发动条件**（`attributeStockCondition` 持有条件 / `attributeResonanceCondition` 共鸣条件、`CheckAwakenLevelN`），效果完全写在程序里，按被动 ID 执行。
4. **`unitScriptID`**：59 个人格带专属单位脚本（弹药、充能等专属机制的入口），需要逐个实现处理器。
5. **术语**：**DOT** = `Combustion` 烧伤、`Laceration` 流血、`Vibration` 震颤、`Burst` 破裂、`Sinking` 沉沦。`Breath` 呼吸法、`Charge` 充能虽然同属 `SinBuff`，但归为资源/增益，不叫 DOT。攻击类型：`SLASH` 斩击、`PENETRATE` 突刺、`HIT` 打击。

## 5. 完整性报告摘要

| 项目 | 结果 | 详情文件 |
| --- | --- | --- |
| 人格 | 192 个（12 名罪人，rank 3/2/1 = 129/51/12），ID 不重复 | `data/reports/identity-list.json` |
| 技能 | 887 个（含 12 个变体），没有悬空引用 | `data/normalized/skills.json` |
| 被动 | 501 个，没有悬空引用；`passive.json` 有 3 个完全相同的重复 ID | `normalize-report.json` |
| 状态 | 引用 244 个，全部存在（状态表共 1861 个） | `buffs.json` |
| 悬空 | `personality-passive` 中的 400005 没有对应人格（非玩家单位，已忽略） | `normalize-report.json` |
| 被动来源冲突 | 10310：`personality-passive` L2 有 4 个被动，`passiveSet` 只有 3 个（缺 1031003）。**选用前者**，后者作为 `alternativePassives` 保留，**待游戏内验证** | `normalize-report.json` |
| 中文缺译 | 人格 10617、10717（2026-10-29 新人格）及其技能、被动，另有 7 个状态 → 回退英文并标记 | `text-coverage.json` |
| 游戏原文本就没有 | 11 个技能、7 个被动（英、韩、日同样缺），属于无文本项，不算缺译 | `text-coverage.json` |
| ST 冲突 | 6 处敌人技能（与人格无关） | `text-coverage.json` |
| 效果脚本 | 四破人格共用到 **1417 种**，其中 1197 种只被 1 个人格使用、532 种是按 ID 命名的专用脚本 | `effect-scripts.json` |

## 6. 样本追溯（10105 臼齿事务所 收尾人 李箱）

由 `trace_identity.py 10105` 生成，输出到 `data/reports/trace-10105.md`（本机生成，不入库）。核对要点：

- S1 1010501：基础威力 3（来自 L3），硬币 +4 ×2；L4 的 `CoinScaleAdderViaBuffCheck {turn:5, value:1}` ↔ “若自身震颤层数不低于 5 层，则硬币威力 +1”。
- S2 1010502：基础威力 4，硬币 +12；硬币效果 `VibrationExplosion…Turn2` ↔ “震颤引爆，并使目标震颤层数减少 2 层”。
- S3 1010503：基础威力 4，硬币 +3 ×3（只有 L3/L4 定义）；专用脚本 `1010503 {turn:10, value:2}` ↔ “消耗 10 层震颤，硬币威力 +2”。
- 被动 1010501（琥珀 ×3 持有，CheckAwakenLevel2）、支援被动 1010521（CheckAwakenLevel3），中文名称和描述都已关联。

## 7. 风险与下一阶段建议

1. **效果逻辑在程序里（最大风险）。** 1417 种脚本中只有参数化的家族（`GiveBuff*` 183 种/2363 次使用、`CoinScaleAdder*` 86 种……）能按“名称 + 参数”批量实现；532 种专用脚本和 59 个单位脚本必须对照 IL2CPP 代码。本机没有现成的 dump，阶段 C/D 需要对当前的 `GameAssembly.dll` + `global-metadata.dat` 运行 Il2CppDumper/Cpp2IL（元数据是否加密尚未检查）。
2. **伤害公式**（等级、攻防等级差、抗性、暴击、舍入）在静态数据中没有，需要从程序或独立参考案例验证（阶段 C）。
3. **HP 等级换算**：`hp.base + perLevel × level` 的确切形式和舍入待验证。
4. 游戏更新后重新运行 `run_all.py`。快照会记录目录哈希；变化时需要重新核对 §3 的规则统计。

建议：阶段 B（JSON 契约、资料卡、翻译切换）可以直接基于现有标准化数据开始；阶段 C 开始前先做 IL2CPP dump 的可行性检查。
