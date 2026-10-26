// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * Anthropic's Claude API, through the official SDK. The key is the operator's (QUBI_API_KEY, or ANTHROPIC_API_KEY);
 * it is passed to the SDK and nowhere else.
 *
 * - Automatic prompt caching (top-level cache_control): the system prompt, the tools and the conversation so far are
 *   read from the cache on every later turn of a run, at a tenth of the price.
 * - Thinking stays on (the current models cannot switch it off); `effort` sets how much. Thinking blocks go back into
 *   the conversation unchanged, as the API asks.
 * - On the models that support it, a request a safety classifier declines is answered by another Claude model inside
 *   the same call (`fallbacks: "default"`); a security review can look like the thing it is looking for.
 * - No forced tool choice: the last turn of a run asks for the result with tool_choice "none".
 */
import Anthropic from "@anthropic-ai/sdk";

// USD per million tokens (cached 2026-10-06): input, output, cache read, cache write (1.25 × input, five minutes).
const rates = (input, output, read, extra = {}) => ({ in: input, out: output, read, write: input * 1.25, ...extra });
const MODELS = [
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", rates: rates(0.1, 0.5, 0.01, { longAbove: 100_000, long: { in: 0.5, out: 2.5, read: 0.05, write: 0.625 } }) },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", rates: rates(2, 10, 0.2) },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", rates: rates(4, 20, 0.2) },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", rates: rates(10, 50, 0.25) },
];
// The models that take the server-side fallback (Haiku has none).
const FALLBACK = new Set(["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]);

const STOP = { end_turn: "end", stop_sequence: "end", tool_use: "tool_use", max_tokens: "max_tokens", refusal: "refusal", pause_turn: "pause" };

export default {
  id: "anthropic",
  name: "Claude API",
  models: MODELS,
  defaultModel: "claude-haiku-5-5",
  defaultHuntModel: "claude-sonnet-5-5",
  create({ key, fetchImpl, baseUrl }) {
    // The address and the credential are set here, never read from the process's environment (ANTHROPIC_BASE_URL,
    // ANTHROPIC_AUTH_TOKEN): the operator's key goes to the API it was made for, or to QUBI_API_URL when set.
    const client = new Anthropic({ apiKey: key, authToken: null, baseURL: baseUrl || "https://api.anthropic.com", maxRetries: 0, timeout: 5 * 60_000, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
    return {
      async call({ model, system, messages, tools, maxTokens, toolsOff, effort }) {
        const body = {
          model, max_tokens: maxTokens, system, tools, messages,
          cache_control: { type: "ephemeral" },
          ...(toolsOff ? { tool_choice: { type: "none" } } : {}),
          ...(effort ? { output_config: { effort } } : {}),
        };
        const res = FALLBACK.has(model)
          ? await client.beta.messages.create({ ...body, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
          : await client.messages.create(body);
        const content = res.content ?? [];
        return {
          content,
          text: content.filter((b) => b.type === "text").map((b) => b.text).join("\n"),
          toolUses: content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input })),
          stop: STOP[res.stop_reason] ?? "end",
          usage: { input: res.usage?.input_tokens ?? 0, output: res.usage?.output_tokens ?? 0, cacheRead: res.usage?.cache_read_input_tokens ?? 0, cacheWrite: res.usage?.cache_creation_input_tokens ?? 0 },
          model: res.model ?? model,
        };
      },
    };
  },
};
