// The home's words for an amount: one money and one plural, so the panel, the
// model's notices and the review message say a price or a count alike.

/** "$1.33". */
export const money = (n: number): string => `$${n.toFixed(2)}`;

/** "1 finding", "3 findings". */
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
