// One-stop updater: pull code -> install deps -> extract game data / rebuild translations -> build dist/.
// Usage: node scripts/update.mjs [--mode all|text|code|data] [--no-pull]
//   all  : git pull + full game extraction (game update) + translations + build   (default)
//   data : full game extraction + translations + build (no git pull)
//   text : only rebuild translation packs (after a translation update) + build
//   code : git pull + npm install + build with existing data
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const modeIdx = args.indexOf("--mode");
const MENU = { 1: "all", 2: "text", 3: "code", 4: "data" };
let mode = modeIdx >= 0 ? args[modeIdx + 1] : args.includes("--menu") ? null : "all";
if (MENU[mode]) mode = MENU[mode];
if (mode == null) mode = await askMenu();
const noPull = args.includes("--no-pull") || mode === "data" || mode === "text";
const isWin = process.platform === "win32";

async function askMenu() {
  console.log(`============================================================
  Limbus 四破轮伤计算器 - 更新
============================================================
  1. 全部更新（推荐：游戏更新后用）
       拉取最新计算器代码 + 重新提取游戏数据 + 重建汉化 + 构建
  2. 只更新汉化（汉化包更新 / 换了汉化后用，最快）
  3. 只更新计算器代码（GitHub 有新版本时用）
  4. 只重新提取游戏数据（不联网）
============================================================`);
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question("请输入序号后回车 [默认 1]: ")).trim() || "1";
  rl.close();
  if (!MENU[ans]) {
    console.error(`无效的序号：${ans}`);
    process.exit(1);
  }
  return MENU[ans];
}

const q = (code) => (isWin ? `"${code}"` : code);
const step = (n, msg) => console.log(`\n[${n}] ${msg}`);
const fail = (msg) => {
  console.error(`\n[错误] ${msg}`);
  process.exit(1);
};
// On Windows npm/npx/pnpm are .cmd shims and need a shell; pass one pre-quoted command line.
function spawn(cmd, cmdArgs, opts) {
  if (!isWin) return spawnSync(cmd, cmdArgs, opts);
  const line = [cmd, ...cmdArgs].map((a) => (/^[\w.:\\/=@+-]+$/.test(a) || a.startsWith('"') ? a : `"${a}"`)).join(" ");
  return spawnSync(line, { ...opts, shell: true });
}
function run(cmd, cmdArgs, opts = {}) {
  return spawn(cmd, cmdArgs, { cwd: root, stdio: "inherit", ...opts }).status === 0;
}
function capture(cmd, cmdArgs) {
  const r = spawn(cmd, cmdArgs, { cwd: root, encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "").trim() : null;
}

if (!["all", "text", "code", "data"].includes(mode)) fail(`未知模式 ${mode}（可选 all / data / text / code）`);
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 20 || (maj === 20 && min < 19)) fail(`Node.js 版本过低（${process.versions.node}），请安装 Node.js 22 LTS 或更新版本`);

// 1. code
if (!noPull) {
  step("代码", "检查 GitHub 更新");
  if (!existsSync(join(root, ".git"))) console.log("  不是 git 仓库（可能是直接下载的压缩包），跳过拉取。");
  else if (capture("git", ["--version"]) == null) console.log("  未安装 git，跳过拉取。");
  else {
    const dirty = capture("git", ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty) console.log("  本地有未提交的改动，为避免覆盖，跳过拉取。改动文件：\n" + dirty);
    else if (!run("git", ["pull", "--ff-only"])) console.log("  git pull 失败（网络或分支分叉），继续使用当前代码。");
  }
}

// 2. node deps
// Release-package mode: the zip ships a prebuilt dist/ (app only, no game data) and no node_modules,
// so users only need Node + Python. Skip dependency install and the vite build; just refresh dist/data.
const prebuilt = existsSync(join(root, "dist", "index.html")) && !existsSync(join(root, "node_modules")) && existsSync(join(root, "RELEASE_PACKAGE"));
if (prebuilt) console.log("\n[依赖] 发布包模式：网页已预先构建，跳过 Node 依赖安装。");
else {
step("依赖", "检查 Node 依赖");
// The project is locked with pnpm (pnpm-lock.yaml); use a global pnpm if present, otherwise run it through npx.
const lockFile = join(root, "pnpm-lock.yaml");
const pkgHash = createHash("sha256")
  .update(readFileSync(join(root, "package.json")))
  .update(existsSync(lockFile) ? readFileSync(lockFile) : "")
  .digest("hex");
const stamp = join(root, "node_modules", ".lcalc-package-hash");
if (!existsSync(join(root, "node_modules", ".pnpm")) || !existsSync(stamp) || readFileSync(stamp, "utf8") !== pkgHash) {
  const pnpm = capture("pnpm", ["--version"]) != null ? ["pnpm", []] : ["npx", ["--yes", "pnpm@9"]];
  console.log(`  使用 ${pnpm[0]} ${pnpm[1].join(" ")} 安装依赖（首次约 1 分钟）`);
  if (!run(pnpm[0], [...pnpm[1], "install", "--frozen-lockfile"])) fail("依赖安装失败，请检查网络（国内可先执行 npm config set registry https://registry.npmmirror.com）");
  writeFileSync(stamp, pkgHash);
} else console.log("  依赖已是最新。");
}

// 3. game data / translations
const haveNormalized = existsSync(join(root, "data", "normalized", "identities.json"));
const needFull = mode === "all" || mode === "data" || !haveNormalized;
const needText = needFull || mode === "text";
if (needText) {
  step("Python", "检查 Python 环境");
  const candidates = isWin ? [["py", ["-3"]], ["python", []], ["python3", []]] : [["python3", []], ["python", []]];
  let py = null;
  for (const [cmd, pre] of candidates) {
    const v = capture(cmd, [...pre, "-c", q("import sys;print(str(sys.version_info[0])+'.'+str(sys.version_info[1]))")]);
    if (v && /^3\.(1\d|[2-9]\d)$/.test(v)) {
      py = [cmd, pre];
      console.log(`  使用 ${cmd} ${pre.join(" ")}（Python ${v}）`);
      break;
    }
  }
  if (!py) fail("找不到 Python 3.10+。请从 https://www.python.org 安装，并勾选「Add python.exe to PATH」");
  const [pyCmd, pyPre] = py;
  if (capture(pyCmd, [...pyPre, "-c", q("import UnityPy, jsonschema")]) == null) {
    console.log("  安装 Python 依赖 UnityPy / jsonschema ...");
    if (!run(pyCmd, [...pyPre, "-m", "pip", "install", "-q", "--disable-pip-version-check", "-r", "tools/import-game/requirements.txt"])) fail("pip 安装失败");
  }
  const env = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
  if (needFull) {
    step("游戏数据", "从本机游戏提取数据（需要游戏至少启动过一次，约 1–3 分钟）");
    if (!run(pyCmd, [...pyPre, "run_all.py"], { cwd: join(root, "tools", "import-game"), env })) fail("游戏数据提取失败，请看上方报错（常见原因：游戏目录没找到 / 游戏更新后还没启动过）");
  } else {
    step("汉化", "重新读取 LimbusCompany_Data/Lang 下的所有翻译包");
    if (!run(pyCmd, [...pyPre, "build_text.py"], { cwd: join(root, "tools", "import-game"), env })) fail("汉化文本构建失败");
  }
}

// 4. build
step("构建", prebuilt ? "打包游戏数据到 dist/data" : "打包网页到 dist/");
if (!run("node", ["scripts/build-data.mjs"])) fail("数据打包失败");
if (prebuilt) {
  const { cpSync, rmSync } = await import("node:fs");
  rmSync(join(root, "dist", "data"), { recursive: true, force: true });
  cpSync(join(root, "public", "data"), join(root, "dist", "data"), { recursive: true });
} else if (!run("npx", ["vite", "build", "--logLevel", "warn"])) fail("网页构建失败");
console.log("\n完成！双击「启动计算器.bat」即可使用。");
