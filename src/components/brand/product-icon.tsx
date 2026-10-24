import { useId, type CSSProperties } from "react";
import { productIconSvg } from "@/lib/brand/product-icons";
import type { ProductKey } from "@/lib/products";
import { cn } from "@/lib/utils";

/**
 * A Deskzo product's icon (src/lib/brand/product-icons.ts) — for Deskzo's own surfaces: the website, signup.
 * Sized by its box: `className="h-10 w-10"`. Decorative unless given a `title`, as it almost always sits
 * beside the product's name.
 *
 * The SVG is the builder's own markup, so the website and the files at /brand/<file> are one drawing; its
 * ids are this instance's, as two icons on a page must not share theirs.
 */
export function ProductIcon({ product, className, style, title }: { product: ProductKey; className?: string; style?: CSSProperties; title?: string }) {
  const id = `pi${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <span
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={cn("inline-block h-10 w-10 shrink-0 [&>svg]:block", className)}
      style={style}
      dangerouslySetInnerHTML={{ __html: productIconSvg(product, { idPrefix: `${id}-` }) }}
    />
  );
}
