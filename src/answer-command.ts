export interface AnswerCommand {
  runId: string;
  questionId: string;
  answer: string;
  sensitive: boolean;
}

export function parseAnswerCommand(args: readonly string[]): AnswerCommand {
  const [runId, questionId, ...remainder] = args;
  if (!runId || !questionId) throw new Error("answer requires a run ID and question ID");
  const sensitive = remainder[0] === "--sensitive";
  const answer = remainder
    .slice(sensitive ? 1 : 0)
    .join(" ")
    .trim();
  if (!answer || answer.length > 10_000) {
    throw new Error("answer must contain from 1 to 10000 characters");
  }
  return { runId, questionId, answer, sensitive };
}
