import type { RawApiAdapterDeps } from "@workflow/adapters";

/** Minimal structural view of the bits of @anthropic-ai/sdk we use (it is an optional dep). */
interface AnthropicLike {
  messages: {
    create(
      body: { model: string; max_tokens: number; messages: Array<{ role: "user"; content: string }> },
      opts: { signal: AbortSignal },
    ): Promise<{
      content: Array<{ type: string; text?: string }>;
      usage: { input_tokens: number; output_tokens: number };
    }>;
  };
}
type AnthropicCtor = new (opts: { apiKey: string }) => AnthropicLike;

const DEFAULT_MODEL = "claude-sonnet-4-6";

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Build a raw-api `complete` backed by @anthropic-ai/sdk, used as the no-CLI fallback
 * adapter. Returns undefined when no API key is set (so adapter selection can report a
 * clear error). The SDK is imported lazily so the CLI works without it installed.
 */
export function createAnthropicComplete(apiKey: string | undefined, model?: string): RawApiAdapterDeps["complete"] | undefined {
  if (!apiKey) return undefined;
  return async (req) => {
    const mod = (await import("@anthropic-ai/sdk").catch(() => null)) as { default?: AnthropicCtor } | null;
    const Ctor = mod?.default;
    if (!Ctor) throw new Error("@anthropic-ai/sdk is not installed");
    const client = new Ctor({ apiKey });
    const prompt = req.schema
      ? `${req.prompt}\n\nReturn ONLY JSON matching this schema:\n${JSON.stringify(req.schema)}`
      : req.prompt;
    const message = await client.messages.create(
      { model: model ?? DEFAULT_MODEL, max_tokens: 4096, messages: [{ role: "user", content: prompt }] },
      { signal: req.signal },
    );
    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    const usage = { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
    const data = req.schema ? safeParseJson(text) : undefined;
    return { text, ...(data !== undefined ? { data } : {}), usage };
  };
}
