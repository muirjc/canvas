const numberFormat = new Intl.NumberFormat();

export const formatTokens = (n: number) => numberFormat.format(n);

/** Estimated USD cost: two decimals, `<$0.01` for a tiny non-zero amount. */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.005) return '<$0.01';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(usd);
}
