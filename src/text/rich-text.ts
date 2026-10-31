/**
 * Controlled parser for game rich text (TextMeshPro subset). Never produces HTML strings.
 * Supported: <b> <i> <u> <s> <color=..> <mark ..> <style="highlight"> <link=".."> <sprite name="..">
 * <noparse>, [KeywordId], {n} placeholders. Anything else in angle brackets is literal text
 * (e.g. "<La Manchaland>" in English is a faction name, not a tag).
 */

export interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  mark?: string;
  highlight?: boolean;
  link?: string;
}

export type Run =
  | { kind: "text"; text: string; style: RunStyle }
  | { kind: "keyword"; id: string; raw: string; style: RunStyle }
  | { kind: "placeholder"; index: number; raw: string; style: RunStyle }
  | { kind: "sprite"; name: string; style: RunStyle }
  | { kind: "newline" };

export interface ParseResult {
  runs: Run[];
  diagnostics: string[];
}

type TagName = "b" | "i" | "u" | "s" | "color" | "mark" | "style" | "link";
const TAG_RE = /^<(\/?)(b|i|u|s|color|mark|style|link|sprite|noparse)(?:[=\s]([^>]*))?>/i;
const KEYWORD_RE = /^\[([A-Za-z][A-Za-z0-9_]*)\]/;
const PLACEHOLDER_RE = /^\{(\d+)\}/;
const COLOR_RE = /^#?([0-9a-f]{3,8})$|^[a-z]+$/i;

function unquote(v: string | undefined): string {
  return (v ?? "").trim().replace(/^["']|["']$/g, "");
}

function attr(v: string | undefined, name: string): string | undefined {
  const m = new RegExp(`${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i").exec(v ?? "");
  return m ? unquote(m[1]) : undefined;
}

function safeColor(v: string): string | undefined {
  const c = unquote(v);
  if (!COLOR_RE.test(c)) return undefined;
  return /^[0-9a-f]{3,8}$/i.test(c) ? `#${c}` : c;
}

export function parseRichText(input: string | null | undefined): ParseResult {
  const src = input ?? "";
  const runs: Run[] = [];
  const diagnostics: string[] = [];
  // TextMeshPro semantics: each tag kind has its own stack, closings need not be nested
  // (game text contains "<color><mark><b><u>..</color></mark></b></u>").
  const stacks: Record<TagName, (string | true)[]> = { b: [], i: [], u: [], s: [], color: [], mark: [], style: [], link: [] };
  const current = (): RunStyle => {
    const top = <T,>(a: T[]) => a[a.length - 1];
    const st: RunStyle = {};
    if (stacks.b.length) st.bold = true;
    if (stacks.i.length) st.italic = true;
    if (stacks.u.length) st.underline = true;
    if (stacks.s.length) st.strike = true;
    if (stacks.color.length) st.color = top(stacks.color) as string;
    if (stacks.mark.length) st.mark = top(stacks.mark) as string;
    if (stacks.style.length) st.highlight = true;
    if (stacks.link.length) st.link = top(stacks.link) as string;
    return st;
  };
  let buf = "";

  const flush = () => {
    if (buf) {
      runs.push({ kind: "text", text: buf, style: current() });
      buf = "";
    }
  };

  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const ch = src[i]!;
    if (ch === "\n") {
      flush();
      runs.push({ kind: "newline" });
      i++;
      continue;
    }
    if (ch === "<") {
      const m = TAG_RE.exec(rest);
      if (m) {
        const closing = m[1] === "/";
        const name = m[2]!.toLowerCase();
        const value = m[3];
        flush();
        if (name === "noparse" && !closing) {
          const end = src.toLowerCase().indexOf("</noparse>", i + m[0].length);
          const stop = end < 0 ? src.length : end;
          buf += src.slice(i + m[0].length, stop);
          i = end < 0 ? src.length : end + "</noparse>".length;
          continue;
        }
        if (name === "noparse") { i += m[0].length; continue; }
        if (name === "sprite") {
          const spriteName = attr(value, "name") ?? unquote(value);
          runs.push({ kind: "sprite", name: spriteName, style: current() });
          i += m[0].length;
          continue;
        }
        const tag = name as TagName;
        if (closing) {
          if (!stacks[tag].length) diagnostics.push(`未匹配的结束标签 </${tag}> @${i}`);
          else stacks[tag].pop();
        } else {
          switch (tag) {
            case "color": {
              const c = safeColor(value ?? "");
              if (c) stacks.color.push(c); else diagnostics.push(`无效颜色 ${value} @${i}`);
              break;
            }
            case "mark": {
              const c = safeColor(attr(value, "color") ?? value ?? "");
              if (c) stacks.mark.push(c); else diagnostics.push(`无效标记色 ${value} @${i}`);
              break;
            }
            case "style":
              if (unquote(value) === "highlight") stacks.style.push(true);
              else diagnostics.push(`未知 style ${value} @${i}`);
              break;
            case "link": stacks.link.push(unquote(value)); break;
            default: stacks[tag].push(true);
          }
        }
        i += m[0].length;
        continue;
      }
      // Literal angle-bracket text such as "<Bloodfiend>"; only flag markup-looking leftovers.
      const close = rest.indexOf(">");
      if (close > 0 && /^<\/?[a-z]+(=|\s+\w+=)/i.test(rest.slice(0, close + 1))) {
        diagnostics.push(`未知标签 ${rest.slice(0, close + 1)} @${i}`);
      }
      buf += ch;
      i++;
      continue;
    }
    if (ch === "[") {
      const m = KEYWORD_RE.exec(rest);
      if (m) {
        flush();
        runs.push({ kind: "keyword", id: m[1]!, raw: m[0], style: current() });
        i += m[0].length;
        continue;
      }
    }
    if (ch === "{") {
      const m = PLACEHOLDER_RE.exec(rest);
      if (m) {
        flush();
        runs.push({ kind: "placeholder", index: Number(m[1]), raw: m[0], style: current() });
        i += m[0].length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  const open = (Object.keys(stacks) as TagName[]).filter((k) => stacks[k].length);
  if (open.length) diagnostics.push(`未闭合标签 ${open.join(",")}`);
  return { runs, diagnostics };
}

/** Plain text (for search / tests). Keywords resolved through `label`, placeholders through `args`. */
export function richTextToPlain(input: string, label: (id: string) => string | undefined = () => undefined,
                                args: (string | number)[] = []): string {
  return parseRichText(input).runs.map((r) => {
    switch (r.kind) {
      case "text": return r.text;
      case "keyword": return label(r.id) ?? r.raw;
      case "placeholder": return args[r.index] !== undefined ? String(args[r.index]) : r.raw;
      case "sprite": return "";
      case "newline": return "\n";
    }
  }).join("");
}
