/**
 * F10's calculator (owner, 22 Oct 2026): + − × ÷, brackets, and % as "per cent of" — 1,000 × 18% is 180. Commas in
 * Indian figures (1,00,000) are read past. Parsed here, never evaluated as code, so whatever is typed is only
 * ever arithmetic. Pure; check:shortcuts holds it to its sums.
 */

export type CalcResult = { ok: true; value: number } | { ok: false; error: string };

type Token = { kind: "num"; value: number } | { kind: "op"; value: string };

function tokens(input: string): Token[] | string {
  const out: Token[] = [];
  const text = input.replace(/[,\s]/g, "").replace(/[x×]/gi, "*").replace(/÷/g, "/").replace(/−/g, "-");
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < text.length && /[0-9.]/.test(text[j]!)) j += 1;
      const raw = text.slice(i, j);
      if ((raw.match(/\./g) ?? []).length > 1) return `"${raw}" isn't a number.`;
      out.push({ kind: "num", value: Number(raw) });
      i = j;
    } else if ("+-*/%()".includes(ch)) {
      out.push({ kind: "op", value: ch });
      i += 1;
    } else {
      return `"${ch}" isn't something the calculator does.`;
    }
  }
  return out;
}

/** Works out an expression, or says what's wrong with it. */
export function calculate(input: string): CalcResult {
  const list = tokens(input);
  if (typeof list === "string") return { ok: false, error: list };
  if (list.length === 0) return { ok: false, error: "Type a sum." };
  let at = 0;
  const peek = () => list[at];
  const take = () => list[at++];

  // expression := term (("+" | "-") term)*  ;  term := factor (("*" | "/") factor)*  ;  factor := unary "%"*
  function expression(): number {
    let value = term();
    for (let t = peek(); t?.kind === "op" && (t.value === "+" || t.value === "-"); t = peek()) {
      take();
      const right = term();
      value = t.value === "+" ? value + right : value - right;
    }
    return value;
  }
  function term(): number {
    let value = factor();
    for (let t = peek(); t?.kind === "op" && (t.value === "*" || t.value === "/"); t = peek()) {
      take();
      const right = factor();
      if (t.value === "/" && right === 0) throw new Error("Can't divide by nothing.");
      value = t.value === "*" ? value * right : value / right;
    }
    return value;
  }
  function factor(): number {
    let value = unary();
    while (peek()?.kind === "op" && peek()!.value === "%") {
      take();
      value = value / 100;
    }
    return value;
  }
  function unary(): number {
    const t = take();
    if (!t) throw new Error("The sum stops short.");
    if (t.kind === "num") return t.value;
    if (t.value === "-") return -unary();
    if (t.value === "+") return unary();
    if (t.value === "(") {
      const value = expression();
      const close = take();
      if (close?.kind !== "op" || close.value !== ")") throw new Error("A bracket isn't closed.");
      return value;
    }
    throw new Error(`"${t.value}" is in the wrong place.`);
  }

  try {
    const value = expression();
    if (at < list.length) return { ok: false, error: `"${(list[at] as Token).value}" is in the wrong place.` };
    if (!Number.isFinite(value)) return { ok: false, error: "That's too big to work out." };
    // Ten decimals is past anything money needs, and it drops floating point's 0.1 + 0.2 tail.
    return { ok: true, value: Math.round(value * 1e10) / 1e10 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "That sum doesn't work out." };
  }
}

/** A result as the calculator shows it: Indian grouping, up to six decimals. */
export function formatCalc(value: number): string {
  return value.toLocaleString("en-IN", { maximumFractionDigits: 6 });
}
