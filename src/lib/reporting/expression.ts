/**
 * Calculated fields: a little arithmetic over a chart's metrics (Reporting & Analytics, owner 23 Oct 2026).
 *
 * `{received} / {net}` is "collection rate"; `({net} - {tax}) / {count}` an average net invoice. Numbers, metric
 * references in braces, + − × ÷ and brackets — nothing else. Parsed here into a tree and evaluated by walking it:
 * never `eval`, never `Function`, so an expression somebody typed can only ever be arithmetic.
 *
 * Evaluated after aggregation, on each bucket's totals — a ratio of sums, not a sum of ratios, which is the
 * only collection rate that means anything. A division by nothing, or a reference with no figure, is no figure
 * (null) rather than zero or infinity.
 *
 * Pure: the builder checks an expression as it is typed, and the server checks it again before saving or running.
 */

export type Expr =
  | { t: "num"; v: number }
  | { t: "ref"; key: string }
  | { t: "neg"; e: Expr }
  | { t: "bin"; op: "+" | "-" | "*" | "/"; a: Expr; b: Expr };

type Token = { t: "num"; v: number } | { t: "ref"; key: string } | { t: "op"; v: "+" | "-" | "*" | "/" } | { t: "(" } | { t: ")" };

const MAX_TOKENS = 120;
const MAX_DEPTH = 24;

class ExpressionError extends Error {}

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === "{") {
      const end = text.indexOf("}", i);
      if (end < 0) throw new ExpressionError("A field reference isn't closed — add the }.");
      const key = text.slice(i + 1, end).trim();
      if (!/^[\w:.-]{1,120}$/.test(key)) throw new ExpressionError("That field reference isn't one this report has.");
      out.push({ t: "ref", key });
      i = end + 1;
    } else if (/[0-9.]/.test(c)) {
      const m = /^(\d+(\.\d+)?|\.\d+)/.exec(text.slice(i));
      if (!m) throw new ExpressionError(`“${c}” isn't a number.`);
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
    } else if (c === "+" || c === "-" || c === "*" || c === "/") {
      out.push({ t: "op", v: c });
      i += 1;
    } else if (c === "×") {
      out.push({ t: "op", v: "*" });
      i += 1;
    } else if (c === "÷") {
      out.push({ t: "op", v: "/" });
      i += 1;
    } else if (c === "−") {
      out.push({ t: "op", v: "-" });
      i += 1;
    } else if (c === "(") {
      out.push({ t: "(" });
      i += 1;
    } else if (c === ")") {
      out.push({ t: ")" });
      i += 1;
    } else {
      throw new ExpressionError(`“${c}” can't be used in a calculation — only numbers, fields, + − × ÷ and brackets.`);
    }
    if (out.length > MAX_TOKENS) throw new ExpressionError("That calculation is too long.");
  }
  return out;
}

function parseTokens(tokens: Token[]): Expr {
  let at = 0;
  const peek = () => tokens[at];
  const expr = (depth: number): Expr => {
    if (depth > MAX_DEPTH) throw new ExpressionError("That calculation nests too deeply.");
    let left = term(depth);
    for (let tk = peek(); tk && tk.t === "op" && (tk.v === "+" || tk.v === "-"); tk = peek()) {
      at += 1;
      left = { t: "bin", op: tk.v, a: left, b: term(depth) };
    }
    return left;
  };
  const term = (depth: number): Expr => {
    let left = factor(depth);
    for (let tk = peek(); tk && tk.t === "op" && (tk.v === "*" || tk.v === "/"); tk = peek()) {
      at += 1;
      left = { t: "bin", op: tk.v, a: left, b: factor(depth) };
    }
    return left;
  };
  const factor = (depth: number): Expr => {
    const tk = peek();
    if (!tk) throw new ExpressionError("The calculation ends too soon.");
    if (tk.t === "op" && tk.v === "-") {
      at += 1;
      return { t: "neg", e: factor(depth + 1) };
    }
    if (tk.t === "num" || tk.t === "ref") {
      at += 1;
      return tk;
    }
    if (tk.t === "(") {
      at += 1;
      const inner = expr(depth + 1);
      if (peek()?.t !== ")") throw new ExpressionError("A bracket isn't closed.");
      at += 1;
      return inner;
    }
    throw new ExpressionError(tk.t === ")" ? "There's a closing bracket with nothing before it." : "Two operators are next to each other.");
  };
  if (tokens.length === 0) throw new ExpressionError("Write the calculation.");
  const tree = expr(0);
  if (at < tokens.length) throw new ExpressionError("Something after the calculation doesn't belong — check for a missing operator.");
  return tree;
}

/** The fields an expression refers to, in order of first appearance. */
export function refsOf(e: Expr, out: string[] = []): string[] {
  if (e.t === "ref") {
    if (!out.includes(e.key)) out.push(e.key);
  } else if (e.t === "neg") refsOf(e.e, out);
  else if (e.t === "bin") {
    refsOf(e.a, out);
    refsOf(e.b, out);
  }
  return out;
}

/**
 * An expression checked against the metrics it may use: parsed, every reference one of them, at least one
 * reference (a calculated field that is a constant is a number, not a field).
 */
export function parseExpression(text: string, known: ReadonlySet<string>): { ok: true; expr: Expr; refs: string[] } | { ok: false; error: string } {
  try {
    const expr = parseTokens(tokenize(text));
    const refs = refsOf(expr);
    if (refs.length === 0) return { ok: false, error: "Use at least one field in the calculation." };
    const unknown = refs.find((r) => !known.has(r));
    if (unknown) return { ok: false, error: `{${unknown}} isn't a metric this report has.` };
    return { ok: true, expr, refs };
  } catch (err) {
    if (err instanceof ExpressionError) return { ok: false, error: err.message };
    throw err;
  }
}

/** The figure an expression comes to over one bucket's totals; null where any part has none, or it divides by nothing. */
export function evaluate(e: Expr, values: Readonly<Record<string, number | null>>): number | null {
  switch (e.t) {
    case "num":
      return e.v;
    case "ref": {
      const v = values[e.key];
      return v === undefined || v === null || !Number.isFinite(v) ? null : v;
    }
    case "neg": {
      const v = evaluate(e.e, values);
      return v === null ? null : -v;
    }
    case "bin": {
      const a = evaluate(e.a, values);
      const b = evaluate(e.b, values);
      if (a === null || b === null) return null;
      if (e.op === "+") return a + b;
      if (e.op === "-") return a - b;
      if (e.op === "*") return a * b;
      if (Math.abs(b) < 1e-12) return null;
      return a / b;
    }
  }
}

/** An expression as people read it: `{received} / {net}` → `[Amount received] / [Invoiced]`. */
export function expressionText(text: string, labelOf: (key: string) => string | undefined): string {
  return text.replace(/\{([\w:.-]+)\}/g, (whole, key: string) => {
    const label = labelOf(key);
    return label ? `[${label}]` : whole;
  });
}
