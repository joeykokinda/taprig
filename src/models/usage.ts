export interface ModelCallUsage {
  inputTokens: number;
  outputTokens: number;
  /** USD at list price; 0 for subscription CLIs and unknown models. */
  costUsd: number;
}

export type RecordModelUsage = (usage: ModelCallUsage) => void;

// USD per million input and output tokens, from the Anthropic and OpenAI pricing pages (2026-11).
const listPrices: Array<[prefix: string, input: number, output: number]> = [
  ["claude-fable-5-1", 10, 50],
  ["claude-opus-5-5", 4, 20],
  ["claude-sonnet-5-5", 2, 10],
  ["claude-haiku-4-5", 1, 5],
  ["gpt-6-astra", 10, 50],
  ["gpt-6.1-sol", 2, 10],
  ["gpt-6.1-terra", 1, 5],
  ["gpt-6-luna", 0.1, 0.5],
];

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = listPrices.find(([prefix]) => model.startsWith(prefix));
  if (!price) return 0;
  return (inputTokens * price[1] + outputTokens * price[2]) / 1_000_000;
}
