/**
 * True PNG One-Pager Image Generator & Clipboard Copier ("一图流算式图片生成与复制").
 *
 * Renders a crisp 2x DPI image in the exact layout of community theorycraft cards
 * (like "黑宝轮伤860"), supporting both Light (community screenshot style with green
 * highlights) and Dark themes, and copies the PNG blob directly to system clipboard.
 */

export interface OnePagerSkillBlock {
  /** e.g. "二技能：6+8+8(+8)" */
  header: string;
  /** e.g. ["(37/31)*32*1.4=53.47(非倾听回合)", "(37/31)*(36*1.5+30*1.6)=121.74(第二回合)"] */
  lines: string[];
}

export interface OnePagerCardData {
  /** e.g. "黑宝轮伤 861.2" */
  title: string;
  /** e.g. "第一乘区：大衣+2，保存神域+2" */
  firstMultLine: string;
  /** e.g. "常驻增伤：倾听的刑罚10-20%，倾听的时刻怠惰10%，消耗充能的技能保存神域+20%" */
  dmgBonusLine: string;
  /** e.g. "前置条件：四破 Lv.65 · 保存强度≥6级 · 满正面理智45" */
  conditionLine?: string;
  skillBlocks: OnePagerSkillBlock[];
  /** e.g. "69.58*1.5+53.47*1.5+260.04*1.5+112.45*0.5+230.34=861.2" */
  wheelFormulaLine: string;
  /** e.g. "(技能顺序：反23反，反2反3，反2反2)" */
  scheduleLine: string;
}

function wrapTextLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (!text) return [];
  const out: string[] = [];
  let cur = "";
  for (const ch of text) {
    const test = cur + ch;
    if (ctx.measureText(test).width > maxWidth && cur.length > 0) {
      out.push(cur);
      cur = ch;
    } else {
      cur = test;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export async function renderOnePagerPng(
  data: OnePagerCardData,
  theme: "light" | "dark" = "light",
): Promise<{ dataUrl: string; blob: Blob }> {
  const scale = 2;
  const width = 620;
  const padX = 36;
  const padY = 36;
  const contentWidth = width - padX * 2;

  const fontStack = '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, sans-serif';
  const measureCanvas = document.createElement("canvas");
  const mctx = measureCanvas.getContext("2d")!;

  // Pre-wrap all sections to compute exact canvas height
  mctx.font = `bold 30px ${fontStack}`;
  const titleLines = wrapTextLines(mctx, data.title, contentWidth);

  mctx.font = `20px ${fontStack}`;
  const firstMultLines = wrapTextLines(mctx, data.firstMultLine, contentWidth);
  const dmgBonusLines = wrapTextLines(mctx, data.dmgBonusLine, contentWidth);
  const condLines = data.conditionLine ? wrapTextLines(mctx, data.conditionLine, contentWidth) : [];

  const wrappedBlocks = data.skillBlocks.map((b) => {
    mctx.font = `bold 21px ${fontStack}`;
    const hLines = wrapTextLines(mctx, b.header, contentWidth);
    mctx.font = `20px ${fontStack}`;
    const fLines = b.lines.flatMap((l) => wrapTextLines(mctx, l, contentWidth));
    return { hLines, fLines };
  });

  mctx.font = `20px ${fontStack}`;
  const wheelLines = wrapTextLines(mctx, data.wheelFormulaLine, contentWidth);
  const schedLines = wrapTextLines(mctx, data.scheduleLine, contentWidth);

  let totalHeight = padY * 2;
  totalHeight += titleLines.length * 42 + 16;
  totalHeight += firstMultLines.length * 32 + 6;
  totalHeight += dmgBonusLines.length * 32 + 6;
  if (condLines.length > 0) totalHeight += condLines.length * 30 + 6;
  totalHeight += 18; // gap before skills

  for (const wb of wrappedBlocks) {
    totalHeight += wb.hLines.length * 34 + 4;
    totalHeight += wb.fLines.length * 32 + 12;
  }

  totalHeight += 10;
  totalHeight += 34; // "轮伤："
  totalHeight += wheelLines.length * 32 + 8;
  totalHeight += schedLines.length * 32;

  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = totalHeight * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);

  const isLight = theme === "light";
  const bg = isLight ? "#ffffff" : "#14161c";
  const fg = isLight ? "#111318" : "#f2f4f8";
  const subFg = isLight ? "#222630" : "#d0d6e2";
  const accentBg = isLight ? "#dff5e3" : "rgba(212, 167, 74, 0.18)";
  const accentText = isLight ? "#111318" : "#f3c969";

  // Background
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, totalHeight);

  let y = padY;

  // Title
  ctx.font = `bold 30px ${fontStack}`;
  ctx.fillStyle = fg;
  ctx.textBaseline = "top";
  for (const line of titleLines) {
    ctx.fillText(line, padX, y);
    y += 42;
  }
  y += 16;

  // First multiplier line with subtle highlight pill on external buffs
  ctx.font = `20px ${fontStack}`;
  for (const line of firstMultLines) {
    ctx.fillStyle = accentBg;
    const w = Math.min(contentWidth, ctx.measureText(line).width + 10);
    ctx.fillRect(padX - 4, y - 2, w, 28);
    ctx.fillStyle = accentText;
    ctx.fillText(line, padX, y);
    y += 32;
  }
  y += 6;

  // Damage bonus line
  ctx.fillStyle = subFg;
  for (const line of dmgBonusLines) {
    ctx.fillText(line, padX, y);
    y += 32;
  }
  y += 6;

  if (condLines.length > 0) {
    ctx.font = `18px ${fontStack}`;
    ctx.fillStyle = isLight ? "#4b5563" : "#9ca3af";
    for (const line of condLines) {
      ctx.fillText(line, padX, y);
      y += 30;
    }
    y += 6;
  }

  y += 18;

  // Skill blocks
  for (const wb of wrappedBlocks) {
    ctx.font = `bold 21px ${fontStack}`;
    ctx.fillStyle = fg;
    for (const hl of wb.hLines) {
      ctx.fillText(hl, padX, y);
      y += 34;
    }
    y += 4;
    ctx.font = `20px ${fontStack}`;
    ctx.fillStyle = subFg;
    for (const fl of wb.fLines) {
      ctx.fillText(fl, padX, y);
      y += 32;
    }
    y += 12;
  }

  y += 10;
  ctx.font = `bold 21px ${fontStack}`;
  ctx.fillStyle = fg;
  ctx.fillText("轮伤：", padX, y);
  y += 34;

  ctx.font = `20px ${fontStack}`;
  ctx.fillStyle = fg;
  for (const wl of wheelLines) {
    ctx.fillText(wl, padX, y);
    y += 32;
  }
  y += 8;

  ctx.fillStyle = subFg;
  for (const sl of schedLines) {
    ctx.fillText(sl, padX, y);
    y += 32;
  }

  const dataUrl = canvas.toDataURL("image/png");
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Canvas toBlob failed"))), "image/png");
  });
  return { dataUrl, blob };
}

export async function copyPngBlobToClipboard(blob: Blob): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function downloadPngDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
