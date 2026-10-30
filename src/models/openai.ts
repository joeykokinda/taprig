import type { OpenAiProviderConfig } from "./config.ts";

export interface StructuredModelRequest {
  model: string;
  system: string;
  input: string;
  schemaName: string;
  schema: Record<string, unknown>;
  reasoningEffort?: "low" | "medium" | "high";
}

export interface StructuredModelResponse {
  value: unknown;
  inputTokens?: number;
  outputTokens?: number;
}

export class OpenAiResponsesProvider {
  readonly config: OpenAiProviderConfig;
  readonly environment: NodeJS.ProcessEnv;
  readonly request: typeof fetch;

  constructor(
    config: OpenAiProviderConfig,
    environment: NodeJS.ProcessEnv = process.env,
    request: typeof fetch = fetch,
  ) {
    this.config = config;
    this.environment = environment;
    this.request = request;
  }

  async structured(request: StructuredModelRequest): Promise<StructuredModelResponse> {
    const apiKey = this.environment[this.config.apiKeyEnv];
    if (!apiKey) throw new Error(`${this.config.apiKeyEnv} is not configured`);
    const response = await this.request(`${this.config.baseUrl.replace(/\/$/u, "")}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        input: [
          { role: "system", content: request.system },
          { role: "user", content: request.input },
        ],
        ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort } } : {}),
        text: {
          format: {
            type: "json_schema",
            name: request.schemaName,
            schema: request.schema,
            strict: true,
          },
        },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`OpenAI Responses API returned HTTP ${response.status}`);
    const body = (await response.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ type?: string; text?: string; refusal?: string }> }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text =
      body.output_text ??
      body.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")
        ?.text;
    if (!text) throw new Error("OpenAI response contained no structured output text");
    return {
      value: JSON.parse(text),
      ...(body.usage?.input_tokens !== undefined ? { inputTokens: body.usage.input_tokens } : {}),
      ...(body.usage?.output_tokens !== undefined
        ? { outputTokens: body.usage.output_tokens }
        : {}),
    };
  }
}
