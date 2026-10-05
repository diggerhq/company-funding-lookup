// Minimal, dependency-free XML reader for EDGAR Form D documents (the agent
// bundler only accepts modules inside the agent directory). Produces plain
// objects: element -> child object or trimmed text; repeated or listed names
// become arrays. Attributes are ignored; comments, PIs, DOCTYPE skipped;
// CDATA and the five XML entities plus numeric references are decoded.

export class XmlError extends Error {}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (t: string) =>
  t.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()],
  );

export function parseXml(xml: string, arrayNames: Set<string>): Record<string, unknown> {
  let i = 0;
  const n = xml.length;
  if (n > 5_000_000) throw new XmlError("document too large");

  const skipMisc = () => {
    for (;;) {
      while (i < n && /\s/.test(xml[i])) i++;
      if (xml.startsWith("<?", i)) {
        const e = xml.indexOf("?>", i);
        if (e < 0) throw new XmlError("unterminated processing instruction");
        i = e + 2;
      } else if (xml.startsWith("<!--", i)) {
        const e = xml.indexOf("-->", i);
        if (e < 0) throw new XmlError("unterminated comment");
        i = e + 3;
      } else if (xml.startsWith("<!DOCTYPE", i)) {
        const e = xml.indexOf(">", i);
        if (e < 0) throw new XmlError("unterminated doctype");
        i = e + 1;
      } else return;
    }
  };

  const readName = () => {
    const m = /^[A-Za-z_][\w.:-]*/.exec(xml.slice(i, i + 200));
    if (!m) throw new XmlError(`expected element name at ${i}`);
    i += m[0].length;
    return m[0].includes(":") ? m[0].split(":").pop()! : m[0];
  };

  const element = (depth: number): [string, unknown] => {
    if (depth > 64) throw new XmlError("nesting too deep");
    if (xml[i] !== "<") throw new XmlError(`expected < at ${i}`);
    i++;
    const name = readName();
    const close = xml.indexOf(">", i);
    if (close < 0) throw new XmlError("unterminated start tag");
    const selfClosing = xml[close - 1] === "/";
    i = close + 1;
    if (selfClosing) return [name, ""];
    const children: Record<string, unknown> = {};
    let text = "";
    let hasChildren = false;
    for (;;) {
      if (i >= n) throw new XmlError(`unterminated element ${name}`);
      if (xml.startsWith("</", i)) {
        i += 2;
        const endName = readName();
        if (endName !== name) throw new XmlError(`mismatched </${endName}> for <${name}>`);
        const gt = xml.indexOf(">", i);
        i = gt + 1;
        break;
      }
      if (xml.startsWith("<!--", i)) {
        const e = xml.indexOf("-->", i);
        if (e < 0) throw new XmlError("unterminated comment");
        i = e + 3;
        continue;
      }
      if (xml.startsWith("<![CDATA[", i)) {
        const e = xml.indexOf("]]>", i);
        if (e < 0) throw new XmlError("unterminated CDATA");
        text += xml.slice(i + 9, e);
        i = e + 3;
        continue;
      }
      if (xml[i] === "<") {
        const [k, v] = element(depth + 1);
        hasChildren = true;
        if (k in children) {
          const cur = children[k];
          children[k] = Array.isArray(cur) ? [...cur, v] : [cur, v];
        } else children[k] = arrayNames.has(k) ? [v] : v;
        continue;
      }
      const next = xml.indexOf("<", i);
      text += decode(xml.slice(i, next < 0 ? n : next));
      i = next < 0 ? n : next;
    }
    return [name, hasChildren ? children : text.trim()];
  };

  skipMisc();
  const [root, value] = element(0);
  skipMisc();
  if (i < n) throw new XmlError("content after root element");
  return { [root]: value };
}
