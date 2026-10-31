import { describe, expect, it } from "vitest";
import { parseRichText, richTextToPlain } from "./rich-text";

describe("parseRichText", () => {
  it("styles nest and close correctly", () => {
    const r = parseRichText('a<b>b<color=#ff6000>c</color></b><style="highlight">d</style>');
    expect(r.diagnostics).toEqual([]);
    expect(r.runs).toEqual([
      { kind: "text", text: "a", style: {} },
      { kind: "text", text: "b", style: { bold: true } },
      { kind: "text", text: "c", style: { bold: true, color: "#ff6000" } },
      { kind: "text", text: "d", style: { highlight: true } },
    ]);
  });

  it("tags close independently like TextMeshPro (game text is not strictly nested)", () => {
    const r = parseRichText("<color=#ff6000><mark color=#ff000040><b><u>x</color></mark></b></u>y");
    expect(r.diagnostics).toEqual([]);
    expect(r.runs).toEqual([
      { kind: "text", text: "x", style: { bold: true, underline: true, color: "#ff6000", mark: "#ff000040" } },
      { kind: "text", text: "y", style: {} },
    ]);
  });

  it("keywords, placeholders, newlines, sprites", () => {
    const r = parseRichText('[WhenUse] 施加{0}层[Combustion]\n<sprite name="Burst">x');
    expect(r.runs.map((x) => x.kind)).toEqual(["keyword", "text", "placeholder", "text", "keyword", "newline", "sprite", "text"]);
    expect(richTextToPlain("[Combustion]{1}", (id) => ({ Combustion: "烧伤" } as Record<string, string>)[id], [1, 3])).toBe("烧伤3");
  });

  it("literal angle-bracket names stay text without diagnostics", () => {
    const r = parseRichText("allies of <La Manchaland> and <Bloodfiend>");
    expect(richTextToPlain("allies of <La Manchaland> and <Bloodfiend>")).toBe("allies of <La Manchaland> and <Bloodfiend>");
    expect(r.diagnostics).toEqual([]);
  });

  it("noparse keeps content literal", () => {
    expect(richTextToPlain("<noparse><b>[X]</b></noparse>y")).toBe("<b>[X]</b>y");
  });

  it("never interprets HTML / script", () => {
    const r = parseRichText('<img src=x onerror=alert(1)><script>bad()</script>');
    expect(r.runs.every((x) => x.kind === "text")).toBe(true);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  it("rejects unsafe colors and reports unmatched tags", () => {
    const r = parseRichText("<color=red;background:url(x)>t</color></u>");
    expect(r.runs[0]).toEqual({ kind: "text", text: "t", style: {} });
    expect(r.diagnostics.join("|")).toMatch(/无效颜色.*未匹配/);
  });

  it("brackets that are not ids stay literal", () => {
    expect(richTextToPlain("[ 3 ] [命中时]")).toBe("[ 3 ] [命中时]");
  });
});
