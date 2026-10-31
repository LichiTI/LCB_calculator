import { createContext, useContext, useState, type CSSProperties, type ReactNode } from "react";
import { parseRichText, type Run, type RunStyle } from "../text/rich-text";
import type { TextResolver } from "../data/game-data";

// ---------------------------------------------------------------- pinned keyword cards
interface PinCtx { pinned: string[]; toggle(id: string): void; close(id: string): void }
const PinContext = createContext<PinCtx>({ pinned: [], toggle: () => {}, close: () => {} });
export const usePins = () => useContext(PinContext);

export function PinProvider({ children }: { children: ReactNode }) {
  const [pinned, setPinned] = useState<string[]>([]);
  const toggle = (id: string) => setPinned((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const close = (id: string) => setPinned((p) => p.filter((x) => x !== id));
  return <PinContext.Provider value={{ pinned, toggle, close }}>{children}</PinContext.Provider>;
}

export function KeywordCard({ id, text, onClose }: { id: string; text: TextResolver; onClose?: () => void }) {
  const info = text.keywordInfo(id);
  return (
    <div className="kw-card">
      <div className="kw-card-head">
        <strong>{info.name ?? id}</strong>
        <code className="muted">{id}</code>
        {info.missing && <span className="tag warn">缺译</span>}
        {onClose && <button className="link" onClick={onClose} aria-label="关闭">×</button>}
      </div>
      {info.desc && <RichText text={info.desc} resolver={text} nested />}
      {info.buffDesc && info.buffDesc !== info.desc && (
        <div className="kw-card-sub"><span className="muted">状态说明：</span><RichText text={info.buffDesc} resolver={text} nested /></div>
      )}
      {!info.desc && !info.buffDesc && <div className="muted">无说明文本</div>}
    </div>
  );
}

export function PinnedCards({ text }: { text: TextResolver }) {
  const { pinned, close } = usePins();
  if (!pinned.length) return null;
  return (
    <aside className="pinned">
      {pinned.map((id) => <KeywordCard key={id} id={id} text={text} onClose={() => close(id)} />)}
    </aside>
  );
}

// ---------------------------------------------------------------- rich text
function styleOf(s: RunStyle): CSSProperties {
  return {
    fontWeight: s.bold ? 700 : undefined,
    fontStyle: s.italic ? "italic" : undefined,
    textDecoration: [s.underline && "underline", s.strike && "line-through"].filter(Boolean).join(" ") || undefined,
    color: s.color,
    background: s.mark,
  };
}

function Keyword({ id, raw, resolver, nested, label: labelOverride }: {
  id: string; raw: string; resolver: TextResolver; nested?: boolean; label?: string;
}) {
  const { toggle, pinned } = usePins();
  const [hover, setHover] = useState(false);
  const label = labelOverride ?? resolver.label(id);
  if (!label) return <span title="未解析的关键词">{raw}</span>;
  return (
    <span className="kw-wrap" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button type="button" className={`kw ${pinned.includes(id) ? "pinned-kw" : ""}`}
              onClick={(e) => { e.stopPropagation(); toggle(id); }}>
        {label}
      </button>
      {hover && !nested && <span className="kw-pop"><KeywordCard id={id} text={resolver} /></span>}
    </span>
  );
}

/** Plain text with display-only links for flattened keyword names ("震颤 "). */
function LinkedText({ text, resolver, nested }: { text: string; resolver: TextResolver; nested?: boolean }) {
  const pat = resolver.inlineNamePattern();
  if (!pat) return <>{text}</>;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(pat.re)) {
    const id = pat.idOf(m[1]!);
    if (!id) continue;
    if (m.index! > last) parts.push(text.slice(last, m.index));
    parts.push(<Keyword key={m.index} id={id} raw={m[1]!} label={m[1]!} resolver={resolver} nested={nested} />);
    last = m.index! + m[0].length;
  }
  if (!parts.length) return <>{text}</>;
  parts.push(text.slice(last));
  return <>{parts}</>;
}

/** Strip Unity/TMP rich-text tags (<color=...>, <b>, <style=...>, etc.) for plain-text contexts like <option>. */
export function stripRichTags(text: string | undefined): string {
  if (!text) return "";
  return text.replace(/<\/?[a-zA-Z][^>]*>/g, "");
}

/** Lightweight inline renderer for names/titles that preserves <color=#...>, <b>, <i>, etc. without interactive buttons. */
export function ColoredText({ text }: { text: string | undefined }) {
  if (!text) return null;
  if (!text.includes("<")) return <>{text}</>;
  const { runs } = parseRichText(text);
  return (
    <>
      {runs.map((r: Run, i) => {
        if (r.kind === "newline") return <span key={i}> </span>;
        if (r.kind === "text") return <span key={i} style={styleOf(r.style)}>{r.text}</span>;
        if (r.kind === "keyword") return <span key={i} style={styleOf(r.style)}>{r.raw}</span>;
        return null;
      })}
    </>
  );
}

export function RichText({ text, resolver, args, nested }: {
  text: string | undefined; resolver: TextResolver; args?: (string | number)[]; nested?: boolean;
}) {
  if (!text) return null;
  const { runs, diagnostics } = parseRichText(text);
  return (
    <span className="rich">
      {runs.map((r: Run, i) => {
        switch (r.kind) {
          case "newline": return <br key={i} />;
          case "text":
            if (r.style.link) {
              return <span key={i} style={styleOf(r.style)}><Keyword id={r.style.link} raw={r.text} label={r.text} resolver={resolver} nested={nested} /></span>;
            }
            return <span key={i} style={styleOf(r.style)} className={r.style.highlight ? "hl" : undefined}><LinkedText text={r.text} resolver={resolver} nested={nested} /></span>;
          case "keyword":
            return <span key={i} style={styleOf(r.style)}><Keyword id={r.id} raw={r.raw} resolver={resolver} nested={nested} /></span>;
          case "placeholder":
            return <span key={i} className="ph">{args?.[r.index] ?? r.raw}</span>;
          case "sprite":
            return <span key={i} className="sprite" title={r.name}>◆</span>;
        }
      })}
      {diagnostics.length > 0 && <span className="diag" title={diagnostics.join("\n")}>⚠</span>}
    </span>
  );
}
