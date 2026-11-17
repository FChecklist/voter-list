// Canonical JSON (RFC 8785 style): sorted keys, no whitespace, safe integers only. See docs/design/LOG-FORMAT.md section 1.
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const ESC: Record<string, string> = { '"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
function str(s: string): string {
  let o = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const code = s.charCodeAt(i);
    if (ESC[c]) o += ESC[c];
    else if (code < 0x20) o += "\\u" + code.toString(16).padStart(4, "0");
    else o += c;
  }
  return o + '"';
}

export function canonical(v: unknown): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean": return v ? "true" : "false";
    case "string": return str(v);
    case "number":
      if (!Number.isSafeInteger(v)) throw new Error("canonical: only safe integers are allowed, got " + String(v));
      return String(v);
    case "object": {
      if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).sort(); // default sort = UTF-16 code unit order
      return "{" + keys.map((k) => {
        if (o[k] === undefined) throw new Error("canonical: undefined value at key " + k);
        return str(k) + ":" + canonical(o[k]);
      }).join(",") + "}";
    }
    default: throw new Error("canonical: unsupported type " + typeof v);
  }
}
