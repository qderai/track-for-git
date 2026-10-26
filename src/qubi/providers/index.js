// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * The model providers Qubi can use, with the operator's own key (QUBI_PROVIDER, QUBI_API_KEY):
 *   anthropic          the Claude API, through the official SDK, with its models and prices built in (anthropic.js);
 *   openai, xai, gemini, mistral, deepseek, groq, openrouter, openai-compatible
 *                      every API that speaks OpenAI's Chat Completions, with the models and prices the operator names
 *                      in QUBI_MODELS (openai.js).
 * Adding another API is one file that answers the same shape, and one line in providerOf:
 *
 *   id, name                      "anthropic", "Claude API"
 *   models                        [{ id, name, rates: { in, out, read, write, longAbove?, long? } }] (USD per million tokens)
 *   defaultModel, defaultHuntModel
 *   problem                       optional: what is missing before it can run
 *   create({ key, fetchImpl, baseUrl }) → { call(req) }   (baseUrl: QUBI_API_URL, for a gateway; "" is the provider's own)
 *
 * call(req) takes { model, system, messages, tools, maxTokens, toolsOff, effort } with messages and tools in the
 * Claude Messages API's shape (content blocks; tool_use / tool_result), and answers
 *   { content, text, toolUses: [{ id, name, input }], stop: "end" | "tool_use" | "max_tokens" | "refusal" | "pause",
 *     usage: { input, output, cacheRead, cacheWrite }, model }
 * where `content` is what goes back into the conversation as the assistant's turn, unchanged. A provider for another
 * API translates both ways inside its own file; the review loop (review.js) never changes.
 */
import anthropic from "./anthropic.js";
import { OPENAI_PRESETS, openaiProvider } from "./openai.js";

export const PROVIDER_IDS = ["anthropic", ...OPENAI_PRESETS];

/**
 * The provider for Qubi's settings (config.js qubi: provider, apiUrl, models), or null when the name is unknown.
 * A provider with a `problem` (a setting it needs is missing) does not run.
 */
export function providerOf(name, q = {}) {
  const id = String(name || "anthropic").toLowerCase();
  if (id === "anthropic") return anthropic;
  return OPENAI_PRESETS.includes(id) ? openaiProvider(id, q) : null;
}

/** Pure. A model's rates, the long-prompt card when the prompt is past its threshold. Unknown models: the dearest. */
export function ratesOf(provider, model, promptTokens = 0) {
  const known = provider.models.find((m) => m.id === model)?.rates;
  const r = known ?? provider.models.reduce((a, m) => (m.rates.out > a.out ? m.rates : a), provider.models[0].rates);
  return r.long && promptTokens > (r.longAbove ?? Infinity) ? { ...r, ...r.long } : r;
}

/** Pure. What one answer cost, from its usage (priced at the dearer of the asked and the served model). */
export function priceOf(provider, model, usage, served) {
  const prompt = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
  const cost = (r) => ((usage?.input ?? 0) * r.in + (usage?.cacheWrite ?? 0) * r.write + (usage?.cacheRead ?? 0) * r.read + (usage?.output ?? 0) * r.out) / 1e6;
  const a = cost(ratesOf(provider, model, prompt));
  return served && served !== model ? Math.max(a, cost(ratesOf(provider, served, prompt))) : a;
}

/**
 * Pure. The most output a call may ask for so the run stays inside its cap: the prompt priced pessimistically (what was
 * sent before at the cache-read rate, the new part at the cache-write rate), the rest of the budget buys output.
 * 0 when not even `floor` tokens fit.
 */
export function outputRoom(provider, model, budgetLeft, cachedTokens, newTokens, floor = 2048, ceiling = 16_000) {
  const r = ratesOf(provider, model, cachedTokens + newTokens);
  const promptCost = (cachedTokens * r.read + newTokens * r.write) / 1e6;
  const room = Math.floor(((budgetLeft - promptCost) / r.out) * 1e6 + 1e-6);
  return room < floor ? 0 : Math.min(room, ceiling);
}
