import { useWatch } from "react-hook-form";
import { orderFigures, type FigureItem } from "@/lib/orders/punch-figures";
import type { PunchForm } from "./types";

/**
 * The order's figures from the price fields alone — quantity, sale price, the distributor's and the
 * deal price. Subscribed to just those, so typing in an expense or a note does not re-render the
 * section that only needs a total.
 */
export function usePriceFigures(control: PunchForm["control"], item: FigureItem | null | undefined) {
  const [quantity, unitPrice, quotedPurchasePrice, dealPrice] = useWatch({
    control,
    name: ["quantity", "unitPrice", "quotedPurchasePrice", "dealPrice"],
  });
  return orderFigures({ quantity, unitPrice, quotedPurchasePrice, dealPrice }, item);
}

/** Every figure, the expenses and rebates included — for the summary and the rebate rows. */
export function useOrderFigures(control: PunchForm["control"], item: FigureItem | null | undefined) {
  const [quantity, unitPrice, quotedPurchasePrice, dealPrice, expenses, rebates] = useWatch({
    control,
    name: ["quantity", "unitPrice", "quotedPurchasePrice", "dealPrice", "expenses", "rebates"],
  });
  return orderFigures({ quantity, unitPrice, quotedPurchasePrice, dealPrice, expenses, rebates }, item);
}
