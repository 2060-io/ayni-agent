/** Rough token estimate (chars / 4) used for window budgets (MEM-RET-001). Provider tokenizers vary;
 * budgets are configuration with tunable defaults (architecture O5). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
