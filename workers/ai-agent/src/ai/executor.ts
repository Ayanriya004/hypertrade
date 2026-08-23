/**
 * LLM caller — multi-provider registry.
 *
 * V1 model catalog (house API keys, one env var per provider on the WORKER
 * service only — the backend never holds model keys):
 *   gemini   → gemini-3.7-flash      (GEMINI_API_KEY)
 *              Legacy 3.6 / 3.5 agent configs are routed onto 3.7.
 *   xai      → grok-4.5              (XAI_API_KEY)
 *              Legacy grok-4.3 agent configs are routed onto 4.5.
 *   openai   → gpt-5.6-terra         (OPENAI_API_KEY)
 *              Explicit terra id — bare `gpt-5.6` routes to Sol ($$$).
 *              Legacy gpt-5.4 agent configs are routed onto terra.
 *   deepseek → deepseek-v4-flash     (DEEPSEEK_API_KEY)
 *              API id is `deepseek-v4-flash` (version DeepSeek-V4-Flash-0731).
 *              Legacy deepseek-v4-pro agent configs are routed onto flash.
 *   claude   → claude-opus-5         (ANTHROPIC_API_KEY; UI still "Soon" while account locked)
 *
 * All providers except Anthropic speak the OpenAI chat-completions dialect
 * (Gemini via its OpenAI-compat endpoint). Anthropic uses /v1/messages.
 *
 * Per-agent model keys (`model_keys_ciphertext`) still take precedence when
 * present — house keys are the default. No BYOK model UI (global CoinGlass +
 * house models).
 */
import type { AgentModelChoice } from '../types.js';

interface ProviderSpec {
  /** OpenAI-compatible chat-completions base, or 'anthropic' special shape. */
  kind: 'openai-compat' | 'anthropic';
  baseUrl: string;
  envVar: string;
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  openai: { kind: 'openai-compat', baseUrl: 'https://api.openai.com/v1', envVar: 'OPENAI_API_KEY' },
  xai: { kind: 'openai-compat', baseUrl: 'https://api.x.ai/v1', envVar: 'XAI_API_KEY' },
  deepseek: { kind: 'openai-compat', baseUrl: 'https://api.deepseek.com/v1', envVar: 'DEEPSEEK_API_KEY' },
  gemini: {
    kind: 'openai-compat',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envVar: 'GEMINI_API_KEY',
  },
  claude: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', envVar: 'ANTHROPIC_API_KEY' },
};

/** Map UI / legacy catalog ids onto the wire name each provider expects. */
function resolveApiModel(provider: string, model: string): string {
  if (provider === 'openai') {
    const key = model.trim();
    // Never use bare `gpt-5.6` — OpenAI routes that alias to Sol ($5/$30).
    const aliases: Record<string, string> = {
      'gpt-5.6-terra': 'gpt-5.6-terra',
      'gpt-5.6-Terra': 'gpt-5.6-terra',
      // House default moved 5.4 → Terra; keep old agent configs working.
      'gpt-5.4': 'gpt-5.6-terra',
      'gpt-5.4-mini': 'gpt-5.6-terra',
    };
    return aliases[key] ?? 'gpt-5.6-terra';
  }
  if (provider === 'deepseek') {
    const key = model.trim();
    // Wire name is always the catalog slug. Version label Flash-0731 is not
    // a separate API model id — see https://api-docs.deepseek.com/quick_start/pricing
    const aliases: Record<string, string> = {
      'DeepSeek-V4-Flash': 'deepseek-v4-flash',
      'DeepSeek-V4-Flash-0731': 'deepseek-v4-flash',
      'deepseek-v4-flash': 'deepseek-v4-flash',
      // House default moved Pro → Flash; keep old agent configs working.
      'DeepSeek-V4-Pro': 'deepseek-v4-flash',
      'deepseek-v4-pro': 'deepseek-v4-flash',
    };
    return aliases[key] ?? 'deepseek-v4-flash';
  }
  if (provider === 'gemini') {
    // House default is 3.7; route legacy 3.6 / 3.5 agent configs onto 3.7.
    const key = model.trim();
    const aliases: Record<string, string> = {
      'gemini-3.7-flash': 'gemini-3.7-flash',
      'gemini-3.6-flash': 'gemini-3.7-flash',
      'gemini-3.5-flash': 'gemini-3.7-flash',
      'gemini-3.5-flash-preview': 'gemini-3.7-flash',
    };
    return aliases[key] ?? 'gemini-3.7-flash';
  }
  if (provider === 'xai') {
    const key = model.trim();
    const aliases: Record<string, string> = {
      'grok-4.5': 'grok-4.5',
      // House default moved 4.3 → 4.5; keep old agent configs working.
      'grok-4.3': 'grok-4.5',
    };
    return aliases[key] ?? 'grok-4.5';
  }
  return model;
}

/**
 * Some models reject non-default `temperature` (Claude Opus 4/5 omit it;
 * OpenAI gpt-5.6-terra only accepts the default 1 — sending 0.5 → 400).
 */
function omitTemperature(provider: string, model: string): boolean {
  if (provider === 'claude' && /opus-[45]/i.test(model)) return true;
  if (provider === 'openai' && /gpt-5\.6|gpt-5\.4/i.test(model)) return true;
  return false;
}

/** Map UI / legacy Claude ids onto the Anthropic wire name. */
function resolveClaudeModel(model: string): string {
  const key = model.trim();
  const aliases: Record<string, string> = {
    'claude-opus-5': 'claude-opus-5',
    'claude-opus-4-8': 'claude-opus-5',
    'claude-opus-4.8': 'claude-opus-5',
  };
  return aliases[key] ?? (key.startsWith('claude-') ? key : 'claude-opus-5');
}

/** House key from the worker env; empty string when not configured. */
export function houseKeyForProvider(provider: string): string {
  const spec = PROVIDERS[provider];
  if (!spec) return '';
  return process.env[spec.envVar]?.trim() ?? '';
}

/** Asset-class agnostic — the user prompt already states crypto vs HIP-3 equity
 * (and which data layers to prioritize). A "crypto AI" system line fights that. */
const SYSTEM_MESSAGE =
  'You are an elite trading AI for perpetual futures. Follow the user prompt for asset class (crypto vs tokenized equity/HIP-3), which data layers to prioritize, and the required JSON decision schema.';

export interface LlmCallResult {
  content: string;
  provider: string;
  model: string;
  latencyMs: number;
}

/** Timeout aborts, network hiccups and 429/5xx are worth one retry. */
function isTransientLlmError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err);
  return (
    /aborted|abort|timeout|fetch failed|network|ECONNRESET|ETIMEDOUT|socket/i.test(msg) ||
    /API (429|5\d\d)/.test(msg)
  );
}

export async function callModel(args: {
  choice: AgentModelChoice;
  apiKey: string;
  prompt: string;
  systemMessage?: string;
  temperature?: number;
  timeoutMs?: number;
}): Promise<LlmCallResult> {
  // One retry on transient failures (slow provider hitting the 120s abort,
  // 429/5xx, network resets) — a single hiccup shouldn't cost the whole
  // hourly decision slot.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await callModelOnce(args);
    } catch (err) {
      lastErr = err;
      if (attempt === 0 && isTransientLlmError(err)) {
        console.warn(
          `[llm] ${args.choice.provider}/${args.choice.model} transient failure — retrying once:`,
          err instanceof Error ? err.message : err,
        );
        await new Promise((r) => setTimeout(r, 2_000));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function callModelOnce(args: {
  choice: AgentModelChoice;
  apiKey: string;
  prompt: string;
  systemMessage?: string;
  temperature?: number;
  timeoutMs?: number;
}): Promise<LlmCallResult> {
  const spec = PROVIDERS[args.choice.provider];
  if (!spec) throw new Error(`Unsupported model provider: ${args.choice.provider}`);
  if (!args.apiKey) throw new Error(`No API key available for provider "${args.choice.provider}"`);

  const apiModel =
    args.choice.provider === 'claude'
      ? resolveClaudeModel(args.choice.model)
      : resolveApiModel(args.choice.provider, args.choice.model);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 120_000);
  try {
    let content: string | undefined;

    if (spec.kind === 'anthropic') {
      const body: Record<string, unknown> = {
        model: apiModel,
        max_tokens: 4096,
        system: args.systemMessage ?? SYSTEM_MESSAGE,
        messages: [{ role: 'user', content: args.prompt }],
        // Opus 5 enables adaptive thinking by default — disable for compact JSON.
        thinking: { type: 'disabled' },
      };
      if (!omitTemperature(args.choice.provider, apiModel)) {
        body.temperature = args.temperature ?? 0.5;
      }
      const res = await fetch(`${spec.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': args.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`claude API ${res.status}: ${detail.slice(0, 300)}`);
      }
      const data = (await res.json()) as { content?: { type: string; text?: string }[] };
      content = data.content?.find((b) => b.type === 'text')?.text;
    } else {
      const body: Record<string, unknown> = {
        model: apiModel,
        messages: [
          { role: 'system', content: args.systemMessage ?? SYSTEM_MESSAGE },
          { role: 'user', content: args.prompt },
        ],
      };
      if (!omitTemperature(args.choice.provider, apiModel)) {
        body.temperature = args.temperature ?? 0.5;
      }
      // DeepSeek V4 defaults to thinking mode (CoT in reasoning_content).
      // Trading decisions need compact JSON in `content` — disable CoT for
      // latency/cost; flash still has 1M context / 384K max output.
      if (args.choice.provider === 'deepseek') {
        body.thinking = { type: 'disabled' };
      }
      const res = await fetch(`${spec.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${args.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`${args.choice.provider} API ${res.status}: ${detail.slice(0, 300)}`);
      }
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      content = data.choices?.[0]?.message?.content ?? undefined;
    }

    if (!content) throw new Error(`Empty response from ${args.choice.provider}/${apiModel}`);
    return {
      content,
      provider: args.choice.provider,
      model: args.choice.model,
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Strip markdown fences and parse the first JSON object in a model reply. */
export function parseJsonReply<T>(content: string): T {
  const cleaned = content.replace(/```json/gi, '```').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in model reply');
  }
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}
