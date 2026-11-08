import type { OpenAiCompatibleProviderConfig, OpenAiProviderConfig } from "./config.ts";

export interface StructuredModelRequest {
  model: string;
  system: string;
  input: string;
  schemaName: string;
  schema: Record<string, unknown>;
  reasoningEffort?: "low" | "medium" | "high";
  /** PNG of the phone screen for surfaces the semantic tree cannot describe. */
  image?: Buffer;
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
          {
            role: "user",
            content: request.image
              ? [
                  { type: "input_text", text: request.input },
                  {
                    type: "input_image",
                    image_url: `data:image/png;base64,${request.image.toString("base64")}`,
                  },
                ]
              : request.input,
          },
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

/** Chat Completions with a JSON schema response format, which is what every compatible server speaks. */
export class OpenAiCompatibleProvider {
  readonly config: OpenAiCompatibleProviderConfig;
  readonly environment: NodeJS.ProcessEnv;
  readonly request: typeof fetch;

  constructor(
    config: OpenAiCompatibleProviderConfig,
    environment: NodeJS.ProcessEnv = process.env,
    request: typeof fetch = fetch,
  ) {
    this.config = config;
    this.environment = environment;
    this.request = request;
  }

  async structured(request: StructuredModelRequest): Promise<StructuredModelResponse> {
    const apiKey = this.config.apiKeyEnv ? this.environment[this.config.apiKeyEnv] : undefined;
    if (this.config.apiKeyEnv && !apiKey) {
      throw new Error(`${this.config.apiKeyEnv} is not configured`);
    }
    const response = await this.request(
      `${this.config.baseUrl.replace(/\/$/u, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        // Effort is left out: servers reject fields they do not know.
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: "system", content: request.system },
            {
              role: "user",
              content: request.image
                ? [
                    { type: "text", text: request.input },
                    {
                      type: "image_url",
                      image_url: {
                        url: `data:image/png;base64,${request.image.toString("base64")}`,
                      },
                    },
                  ]
                : request.input,
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: request.schemaName, schema: request.schema, strict: true },
          },
        }),
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!response.ok) {
      throw new Error(`${this.config.baseUrl} returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    // Some local models wrap JSON in a fence even when asked for a schema.
    const text = body.choices?.[0]?.message?.content?.replace(
      /^\s*```(?:json)?\s*|\s*```\s*$/gu,
      "",
    );
    if (!text) throw new Error("compatible server response contained no message content");
    return {
      value: JSON.parse(text),
      ...(body.usage?.prompt_tokens !== undefined ? { inputTokens: body.usage.prompt_tokens } : {}),
      ...(body.usage?.completion_tokens !== undefined
        ? { outputTokens: body.usage.completion_tokens }
        : {}),
    };
  }
}
