// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * Every API that speaks OpenAI's Chat Completions with function calling: OpenAI itself, xAI (Grok), Google Gemini's
 * OpenAI-compatible endpoint, Mistral, DeepSeek, Groq, OpenRouter (hundreds of models behind one key), and anything
 * self-hosted that offers the same API (Ollama, vLLM, LM Studio, a company gateway) with QUBI_PROVIDER=openai-compatible
 * and QUBI_API_URL.
 *
 * Models and their prices come from the operator (QUBI_MODELS), not from this file: they change too often to ship, and
 * the caps are only as good as the prices. "gpt-x:1.25/10/0.125" is a model with $1.25 per million input tokens, $10
 * output and, optionally, $0.125 for cached input; a local model is "llama3:0/0". With no priced model Qubi does not run.
 *
 * The review loop speaks the Claude Messages shape (providers/index.js); it is translated here both ways: tool_use
 * blocks become tool_calls, tool_result blocks become role "tool" messages, and the answer comes back as blocks.
 */
const PRESETS = {
  openai: { name: "OpenAI", url: "https://api.openai.com/v1", maxField: "max_completion_tokens", effort: true },
  xai: { name: "xAI (Grok)", url: "https://api.x.ai/v1" },
  gemini: { name: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai" },
  mistral: { name: "Mistral", url: "https://api.mistral.ai/v1" },
  deepseek: { name: "DeepSeek", url: "https://api.deepseek.com/v1" },
  groq: { name: "Groq", url: "https://api.groq.com/openai/v1" },
  openrouter: { name: "OpenRouter", url: "https://openrouter.ai/api/v1" },
  "openai-compatible": { name: "OpenAI-compatible API", url: "" },
};
export const OPENAI_PRESETS = Object.keys(PRESETS);

const n = (v) => (v === undefined || v === "" ? NaN : Number(v));
/** Pure. "id:in/out[/cached], …" into models with rates; the entries that do not parse are named in `bad`. */
export function parseModels(spec) {
  const models = [], bad = [];
  for (const part of String(spec ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([\w.:/@-]{1,100}):(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(part);
    const [inp, out, read] = m ? [n(m[2]), n(m[3]), n(m[4])] : [];
    if (!m || inp > 1000 || out > 1000) { bad.push(part.slice(0, 60)); continue; }
    models.push({ id: m[1], name: m[1], rates: { in: inp, out, read: Number.isFinite(read) ? read : inp, write: inp } });
  }
  return { models, bad };
}

const STOP = { stop: "end", tool_calls: "tool_use", function_call: "tool_use", length: "max_tokens", content_filter: "refusal" };

/** Pure. The Claude-shaped conversation as Chat Completions messages. */
export function toChat(system, messages) {
  const out = [{ role: "system", content: system }];
  for (const m of messages) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? [];
    if (m.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const calls = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // A user turn: its tool results first (each answers one call), then any text.
    for (const b of blocks.filter((x) => x.type === "tool_result")) {
      out.push({ role: "tool", tool_call_id: b.tool_use_id, content: `${b.is_error ? "Error: " : ""}${typeof b.content === "string" ? b.content : JSON.stringify(b.content)}` });
    }
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

/** Pure. A Chat Completions answer as the loop's shape. */
export function fromChat(data, model) {
  const choice = data?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const toolUses = (msg.tool_calls ?? []).filter((c) => c?.function?.name).map((c, i) => {
    let input = {};
    try { input = JSON.parse(c.function.arguments || "{}"); } catch { input = {}; }
    return { id: String(c.id || `call_${i}`), name: c.function.name, input };
  });
  const text = typeof msg.content === "string" ? msg.content : "";
  const content = [...(text ? [{ type: "text", text }] : []), ...toolUses.map((u) => ({ type: "tool_use", ...u }))];
  const u = data?.usage ?? {};
  const cached = Number(u.prompt_tokens_details?.cached_tokens ?? 0);
  return {
    content, text, toolUses,
    stop: msg.refusal ? "refusal" : toolUses.length ? "tool_use" : STOP[choice.finish_reason] ?? "end",
    usage: { input: Math.max(0, Number(u.prompt_tokens ?? 0) - cached), output: Number(u.completion_tokens ?? 0), cacheRead: cached, cacheWrite: 0 },
    model: data?.model ?? model,
  };
}

/**
 * The provider for one preset, from the operator's settings: { provider, apiUrl, models } (config.js qubi).
 * `problem` names what is missing; Qubi does not run while there is one.
 */
export function openaiProvider(id, q = {}) {
  const preset = PRESETS[id];
  const { models, bad } = parseModels(q.models);
  const url = (q.apiUrl || preset.url).replace(/\/+$/, "");
  const problem = !url ? "QUBI_API_URL (the API's address, for example http://localhost:11434/v1 for Ollama)"
    : bad.length ? `QUBI_MODELS (could not read: ${bad.join(", ")}; write id:input/output prices per million tokens)`
    : !models.length ? "QUBI_MODELS (the models to use with their prices, for example gpt-x:1.25/10)" : null;
  return {
    id, name: preset.name, models: models.length ? models : [{ id: "", name: "", rates: { in: 0, out: 0, read: 0, write: 0 } }],
    defaultModel: models[0]?.id ?? "", defaultHuntModel: models[1]?.id ?? models[0]?.id ?? "", problem,
    create({ key, fetchImpl = (...a) => fetch(...a) }) {
      return {
        async call({ model, system, messages, tools, maxTokens, toolsOff, effort }) {
          const body = {
            model, messages: toChat(system, messages), [preset.maxField ?? "max_tokens"]: maxTokens,
            tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
            ...(toolsOff ? { tool_choice: "none" } : {}),
            ...(preset.effort && effort ? { reasoning_effort: effort } : {}),
          };
          const res = await fetchImpl(`${url}/chat/completions`, {
            method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "user-agent": "track-for-git-qubi" }, body: JSON.stringify(body),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) { const e = new Error(String(data?.error?.message ?? data?.message ?? `HTTP ${res.status}`).slice(0, 200)); e.status = res.status; throw e; }
          return fromChat(data, model);
        },
      };
    },
  };
}
