import assert from "node:assert/strict";
import test from "node:test";

import { parseAnswerCommand } from "../src/answer-command.ts";

test("parses durable and sensitive answers", () => {
  assert.deepEqual(parseAnswerCommand(["run-1", "question-1", "Use", "Joey"]), {
    runId: "run-1",
    questionId: "question-1",
    answer: "Use Joey",
    sensitive: false,
  });
  assert.deepEqual(parseAnswerCommand(["run-1", "question-1", "--sensitive", "123456"]), {
    runId: "run-1",
    questionId: "question-1",
    answer: "123456",
    sensitive: true,
  });
});

test("rejects incomplete answers", () => {
  assert.throws(() => parseAnswerCommand(["run-1"]), /run ID and question ID/);
  assert.throws(() => parseAnswerCommand(["run-1", "question-1"]), /answer must contain/);
});
