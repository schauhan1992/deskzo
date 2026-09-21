import { Prisma } from "@prisma/client";

/**
 * A Prisma row as React Server Components can actually serialise it: `Decimal` money columns become
 * plain numbers.
 *
 * Passing a raw Prisma row into a client component throws "Only plain objects can be passed to
 * Client Components ... Decimal objects are not supported", so any query whose result reaches a
 * client component runs through `toPlain` first. Dates survive — RSC serialises those natively.
 */
export type Plain<T> = T extends Prisma.Decimal
  ? number
  : T extends Date
    ? Date
    : T extends (infer U)[]
      ? Plain<U>[]
      : T extends object
        ? { [K in keyof T]: Plain<T[K]> }
        : T;

export function toPlain<T>(value: T): Plain<T> {
  if (value === null || value === undefined || typeof value !== "object") {
    return value as Plain<T>;
  }
  if (value instanceof Date) {
    return value as Plain<T>;
  }
  if (Prisma.Decimal.isDecimal(value)) {
    return (value as Prisma.Decimal).toNumber() as Plain<T>;
  }
  if (Array.isArray(value)) {
    return value.map(toPlain) as Plain<T>;
  }
  // Object.entries drops symbol-keyed properties, which also strips the `nodejs.util.inspect.custom`
  // symbol Prisma attaches — RSC rejects that too.
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = toPlain(val);
  }
  return out as Plain<T>;
}
