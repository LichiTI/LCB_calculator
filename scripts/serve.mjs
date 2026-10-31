// Zero-dependency static server for the built app (dist/). Usage: node scripts/serve.mjs [--port 5173] [--no-open]
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { exec } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "dist"));
const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
let port = portArg >= 0 ? Number(args[portArg + 1]) : Number(process.env.PORT ?? 5173);
const open = !args.includes("--no-open");

if (!existsSync(join(root, "index.html"))) {
  console.error("dist/index.html 不存在，请先运行「更新计算器.bat」或 npm run build");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
  let file = normalize(join(root, url));
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
  res.end(readFileSync(file));
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE" && port < 5200) {
    port += 1;
    server.listen(port, "127.0.0.1");
  } else {
    console.error(e);
    process.exit(1);
  }
});
server.on("listening", () => {
  const url = `http://localhost:${port}/`;
  console.log(`计算器已启动：${url}  （关闭此窗口即停止）`);
  if (open) exec(process.platform === "win32" ? `start "" "${url}"` : `xdg-open ${url}`);
});
server.listen(port, "127.0.0.1");
