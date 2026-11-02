export interface ModelCallUsage {
  inputTokens: number;
  outputTokens: number;
}

export type RecordModelUsage = (usage: ModelCallUsage) => void;
