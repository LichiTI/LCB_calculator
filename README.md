# Limbus Company 四破轮伤 / DOT 计算器

本地运行的边狱公司（Limbus Company）**同步 IV（四破）** 人格 / E.G.O 轮伤计算器。数据直接从**你自己电脑上的游戏**里提取，文本跟着**你自己装的汉化**走，游戏和汉化更新后点一下就能同步。

- 逐硬币、逐回合模拟：攻防等级差、抗性、暴击、增伤乘区、尾币、追伤、重投都算进去
- DOT（烧伤 / 流血 / 震颤 / 破裂 / 沉沦）：施加、消耗、能不能不亏层
- 排轴穷举：6T 单槽、12T 单槽（2 副牌，再折算成 6 技能一轮）、6T 双槽
- 队友支援：外部攻等 / 增伤 Buff、黑派经理堂吉诃德的保存补给等
- 一图流导出（复制图片 / 文字），手机屏幕也能看
- 可选 LLM 精算（OpenAI 兼容 / Gemini / Claude，自己填 Key，只存在本机浏览器）

> 本项目**不包含任何游戏数据和汉化文本**。所有数据都在你本机构建，不会上传到任何地方。

---

## 快速开始（Windows）

### 1. 装好两个运行环境（只需一次）

| 软件 | 版本 | 下载 | 注意 |
| --- | --- | --- | --- |
| Node.js | 22 LTS 或更新 | https://nodejs.org/zh-cn | 一路下一步即可 |
| Python | 3.10 或更新 | https://www.python.org/downloads/ | 安装时**勾选 “Add python.exe to PATH”** |

Python 依赖（UnityPy、jsonschema）会在第一次运行时自动安装。

### 2. 下载计算器

**方式 A（推荐，方便以后更新）**：装好 [Git](https://git-scm.com/download/win) 后，在任意文件夹里运行

```bat
git clone https://github.com/<作者>/limbus-uptie4-calculator.git
```

**方式 B**：在 GitHub 页面点 `Code → Download ZIP`，解压到任意位置。

> 推荐直接放在游戏目录里，例如 `…\steamapps\common\Limbus Company\calculator`，这样不用配置任何路径。放在别处也可以，程序会自动从 Steam 库里找游戏。

### 3. 双击 `启动计算器.bat`

- 第一次运行会自动：安装依赖 → 从游戏提取数据 → 读取汉化 → 构建网页，大约 2–5 分钟。
- 之后每次双击都是秒开，浏览器会自动打开 `http://localhost:5173`。
- 用完关掉黑色窗口就行。

**前提：游戏至少启动过一次**（游戏数据在启动时才会下载到本机缓存）。

---

## 更新

双击 `更新计算器.bat`，按提示选：

| 选项 | 什么时候用 | 做了什么 |
| --- | --- | --- |
| 1. 全部更新 | **游戏更新后**（新人格、数值调整） | 拉取最新计算器代码 + 重新提取游戏数据 + 重建汉化 + 构建 |
| 2. 只更新汉化 | **汉化包更新 / 换了汉化**之后 | 重新读取 `LimbusCompany_Data/Lang` 下所有汉化，最快 |
| 3. 只更新计算器代码 | GitHub 上有新版本时 | `git pull` + 更新依赖 + 构建（不碰游戏数据） |
| 4. 只重新提取游戏数据 | 不想联网时 | 同 1，但不拉取代码 |

- 游戏更新后请**先进一次游戏**，等它下载完资源，再运行更新。
- 用 ZIP 下载的版本没法自动拉代码，重新下载 ZIP 覆盖即可。`local.config.json` 和你在网页里保存的配置不会丢：配置存在浏览器里，可在网页里导出备份。
- 也可以在命令行直接用：`更新计算器.bat 2`，或 `node scripts/update.mjs --mode text`。

---

## 汉化

计算器会**自动扫描** `游戏目录\LimbusCompany_Data\Lang\` 下的每个汉化文件夹，也就是游戏自己加载汉化的位置。只要汉化能在游戏里用，计算器就能读到。网页右上角可以切换。

- 官方英 / 日 / 韩文本总会一起打包。缺译的条目自动回退英文，并有标记。
- 默认优先选 `LLC_zh-CN`，没有的话选名字里带 zh / cn / 汉化 / 中文 的包。
- 名字以 `_` 或 `.` 开头的文件夹、json 少于 100 个的文件夹（备份、工作目录）会被跳过。
- 与官方语言重名的文件夹（如 `Lang\jp`）会显示为 `Lang_jp`。

### 汉化不在游戏目录里？

复制 `local.config.example.json` 为 `local.config.json`，在 `extraTranslationPacks` 里加上：

```json
{
  "gameRoot": "auto",
  "translationPacks": "auto",
  "extraTranslationPacks": {
    "我的汉化": "D:/汉化/MyPack"
  },
  "excludeDirNames": ["__pycache__"]
}
```

然后运行 `更新计算器.bat` → `2`。

| 字段 | 说明 |
| --- | --- |
| `gameRoot` | `"auto"`：依次尝试环境变量 `LIMBUS_GAME_ROOT`、计算器的上一级目录、各个 Steam 库。也可以直接写路径 |
| `translationPacks` | `"auto"` 自动扫描；或写成 `{ "名字": "相对游戏目录或绝对路径" }`，只读取指定的包 |
| `extraTranslationPacks` | 额外的汉化包，可放在任何位置 |
| `excludeDirNames` | 扫描时跳过的文件夹名 |

路径里可以用 `%USERPROFILE%` 这类环境变量。

---

## 常见问题

**找不到游戏目录**：在 `local.config.json` 里把 `gameRoot` 写成游戏路径，例如 `"E:/SteamLibrary/steamapps/common/Limbus Company"`。

**提取失败 / 新人格没出现**：游戏更新后先进一次游戏，再运行 `更新计算器.bat` → `1`。

**npm install 很慢或失败**：国内网络可以先运行 `npm config set registry https://registry.npmmirror.com`。

**端口被占用**：会自动换到 5174、5175……，以窗口里显示的地址为准。

**能不能直接双击 `dist/index.html`？** 不行，浏览器禁止本地网页读取数据文件。请用 `启动计算器.bat`，它会开一个只有本机能访问的小服务器。

**算出来和游戏里不一样**：结果页会标出「未建模 / 待手动补偿」的效果，可以用手动修正补上。欢迎在 GitHub Issues 里附截图和人格 ID 反馈。

---

## 开发者

```bat
npm install
npm run dev        :: 打包 public/data 后启动开发服务器
npm test           :: 单元测试 + 真实数据测试 + 界面冒烟测试
npm run typecheck
npm run build      :: 输出到 dist/
python tools\import-game\run_all.py   :: 完整重新提取游戏数据
python tools\import-game\build_text.py :: 只重建汉化文本
```

| 目录 | 内容 |
| --- | --- |
| `tools/import-game/` | 只读的游戏数据提取：Unity 资源包 → `data/raw` → 四破解析 → `data/normalized` |
| `scripts/build-data.mjs` | 把 `data/normalized` 打包成网页用的 `public/data` |
| `scripts/update.mjs` / `serve.mjs` | 一键更新 / 零依赖静态服务器（两个 bat 调用的就是它们） |
| `src/engine/` | 计算引擎：公式、状态、效果脚本、模拟器、排轴穷举、轮伤表、LLM 打包 |
| `src/ui/` | React 界面 |
| `docs/` | 规格与数据勘察报告（[开发交接计划](docs/开发交接计划.md)、[阶段 A 报告](docs/phase-a-report.md)） |

约定：

- 游戏目录、汉化目录、缓存都只读，所有生成的内容只写进本目录。
- `data/raw`、`data/normalized`、`public/data`、`dist` 都是本机产物，**不入库**（含游戏版权内容）。

## 许可协议

本仓库的原创代码与文档采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)（署名-非商业性使用-相同方式共享 4.0 国际）许可，全文见 [LICENSE](LICENSE)。

- **署名**：转载、修改或再发布时需注明原作者 LichiTI 及仓库地址 <https://github.com/LichiTI/LCB_calculator>，并说明是否做了修改。
- **非商业性使用**：不得用于商业目的（例如收费分发、付费功能、商业广告变现）。
- **相同方式共享**：基于本项目修改后再发布，须使用相同协议。

本协议只覆盖本仓库的原创内容；Limbus Company 的名称、游戏数据、图像与文本归 Project Moon 所有，不在授权范围内。第三方依赖遵循各自的许可证。

## 免责声明

非官方粉丝工具，与 Project Moon 无关。Limbus Company 及相关素材版权归 Project Moon 所有。本仓库只包含计算器代码，不分发游戏文件、游戏数据或汉化文本。
