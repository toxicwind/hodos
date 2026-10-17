/**
 * astmatrix-ts — extended provider registry (9Router-derived).
 * Port of herd/internal/astmatrix/registry.go (Go) to Bun/TypeScript.
 *
 * Hand-maintained (NOT generated): providers beyond the core Tack catalog.
 * Only entries with a non-empty baseUrl and format "openai" are promoted
 * to the routing matrix at init time.
 */

export interface ModelEntry {
  id: string;
  name: string;
}

export interface ProviderDef {
  id: string;
  priority: number;
  category: string;
  noAuth: boolean;
  baseUrl: string;
  format: string;
  models: ModelEntry[];
}

/** provider ID -> API key env var override. */
export const keyEnvOverride: Record<string, string> = {
  "alicode": "ALICODE_API_KEY",
  "alicode-intl": "ALICODE_INTL_API_KEY",
  "blackbox": "BLACKBOX_API_KEY",
  "byteplus": "BYTEPLUS_API_KEY",
  "cerebras": "CEREBRAS_API_KEY",
  "chutes": "CHUTES_API_KEY",
  "cohere": "COHERE_API_KEY",
  "featherless": "FEATHERLESS_API_KEY",
  "fireworks": "FIREWORKS_API_KEY",
  "github": "GITHUB_TOKEN",
  "groq": "GROQ_API_KEY",
  "hyperbolic": "HYPERBOLIC_API_KEY",
  "iflow": "IFLOW_API_KEY",
  "mimo-free": "",
  "mistral": "MISTRAL_API_KEY",
  "nebius": "NEBIUS_API_KEY",
  "nvidia": "NVIDIA_API_KEY",
  "openai": "OPENAI_API_KEY",
  "opencode": "",
  "opencode-go": "OPENCODE_API_KEY",
  "openrouter": "OPENROUTER_API_KEY",
  "perplexity": "PERPLEXITY_API_KEY",
  "siliconflow": "SILICONFLOW_API_KEY",
  "together": "TOGETHER_API_KEY",
  "venice": "VENICE_API_KEY",
  "volcengine-ark": "VOLCENGINE_API_KEY",
  "xai": "XAI_API_KEY",
};

export const RegistryProviders: Record<string, ProviderDef> = {
  "alicode": {
    id: "alicode", priority: 20, category: "apikey", noAuth: false,
    baseUrl: "https://coding.dashscope.aliyuncs.com/v1", format: "openai",
    models: [{ id: "qwen3.5-plus", name: "Qwen3.5 Plus" }, { id: "kimi-k2.5", name: "Kimi K2.5" }, { id: "glm-5", name: "GLM 5" }],
  },
  "alicode-intl": {
    id: "alicode-intl", priority: 10, category: "apikey", noAuth: false,
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", format: "openai",
    models: [{ id: "qwen3.5-plus", name: "Qwen3.5 Plus" }, { id: "kimi-k2.5", name: "Kimi K2.5" }],
  },
  "anthropic": {
    id: "anthropic", priority: 30, category: "apikey", noAuth: false,
    baseUrl: "https://api.anthropic.com/v1", format: "claude",
    models: [{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" }],
  },
  "blackbox": {
    id: "blackbox", priority: 50, category: "apikey", noAuth: false,
    baseUrl: "https://api.blackbox.ai/v1", format: "openai",
    models: [{ id: "claude-fable-5", name: "Claude Fable 5" }, { id: "gpt-5.5", name: "GPT-5.5" }],
  },
  "byteplus": {
    id: "byteplus", priority: 70, category: "freeTier", noAuth: false,
    baseUrl: "https://ark.ap-southeast.bytepluses.com/api/coding/v3", format: "openai",
    models: [{ id: "seed-2-0-pro-260328", name: "Seed 2.0 Pro" }],
  },
  "cerebras": {
    id: "cerebras", priority: 60, category: "apikey", noAuth: false,
    baseUrl: "https://api.cerebras.ai/v1", format: "openai",
    models: [{ id: "llama-3.3-70b", name: "Llama 3.3 70B" }],
  },
  "chutes": {
    id: "chutes", priority: 70, category: "apikey", noAuth: false,
    baseUrl: "https://llm.chutes.ai/v1", format: "openai",
    models: [],
  },
  "cohere": {
    id: "cohere", priority: 90, category: "apikey", noAuth: false,
    baseUrl: "https://api.cohere.ai/v1", format: "openai",
    models: [{ id: "command-r-plus-08-2024", name: "Command R+" }],
  },
  "featherless": {
    id: "featherless", priority: 65, category: "apikey", noAuth: false,
    baseUrl: "https://api.featherless.ai/v1", format: "openai",
    models: [{ id: "deepseek-ai/DeepSeek-V4-Pro", name: "DeepSeek V4 Pro" }],
  },
  "fireworks": {
    id: "fireworks", priority: 50, category: "apikey", noAuth: false,
    baseUrl: "https://api.fireworks.ai/inference/v1", format: "openai",
    models: [{ id: "accounts/fireworks/models/deepseek-v3p1", name: "DeepSeek V3.1" }],
  },
  "github": {
    id: "github", priority: 40, category: "oauth", noAuth: false,
    baseUrl: "https://api.githubcopilot.com", format: "openai",
    models: [{ id: "gpt-5.2", name: "GPT-5.2" }, { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" }],
  },
  "groq": {
    id: "groq", priority: 60, category: "apikey", noAuth: false,
    baseUrl: "https://api.groq.com/openai/v1", format: "openai",
    models: [{ id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B" }],
  },
  "hyperbolic": {
    id: "hyperbolic", priority: 160, category: "apikey", noAuth: false,
    baseUrl: "https://api.hyperbolic.xyz/v1", format: "openai",
    models: [{ id: "Qwen/QwQ-32B", name: "QwQ 32B" }],
  },
  "iflow": {
    id: "iflow", priority: 110, category: "oauth", noAuth: false,
    baseUrl: "https://apis.iflow.cn/v1", format: "openai",
    models: [{ id: "qwen3-coder-plus", name: "Qwen3 Coder Plus" }],
  },
  "mimo-free": {
    id: "mimo-free", priority: 50, category: "free", noAuth: true,
    baseUrl: "https://api.xiaomimimo.com/api/free-ai/openai", format: "openai",
    models: [{ id: "mimo-auto", name: "MiMo Auto" }],
  },
  "mistral": {
    id: "mistral", priority: 80, category: "apikey", noAuth: false,
    baseUrl: "https://api.mistral.ai/v1", format: "openai",
    models: [{ id: "mistral-large-latest", name: "Mistral Large 3" }, { id: "codestral-latest", name: "Codestral" }],
  },
  "nebius": {
    id: "nebius", priority: 70, category: "apikey", noAuth: false,
    baseUrl: "https://api.studio.nebius.ai/v1", format: "openai",
    models: [{ id: "meta-llama/Llama-3.3-70B-Instruct", name: "Llama 3.3 70B" }],
  },
  "nvidia": {
    id: "nvidia", priority: 20, category: "freeTier", noAuth: false,
    baseUrl: "https://integrate.api.nvidia.com/v1", format: "openai",
    models: [{ id: "nvidia/nemotron-3-super-120b-a12b", name: "Nemotron 3 Super" }, { id: "deepseek-ai/deepseek-v4-pro", name: "DeepSeek V4 Pro" }],
  },
  "openai": {
    id: "openai", priority: 30, category: "apikey", noAuth: false,
    baseUrl: "https://api.openai.com/v1", format: "openai",
    models: [{ id: "gpt-5.4", name: "GPT-5.4" }, { id: "o3", name: "O3" }, { id: "o4-mini", name: "O4 Mini" }],
  },
  "opencode": {
    id: "opencode", priority: 40, category: "free", noAuth: true,
    baseUrl: "https://opencode.ai", format: "openai",
    models: [],
  },
  "opencode-go": {
    id: "opencode-go", priority: 210, category: "apikey", noAuth: false,
    baseUrl: "https://opencode.ai/zen/go/v1", format: "openai",
    models: [{ id: "glm-5.2", name: "GLM 5.2" }, { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" }],
  },
  "openrouter": {
    id: "openrouter", priority: 10, category: "freeTier", noAuth: false,
    baseUrl: "https://openrouter.ai/api/v1", format: "openai",
    models: [{ id: "tencent/hy3:free", name: "Hy3 Free" }, { id: "poolside/laguna-m.1:free", name: "Laguna M.1 Free" }, { id: "qwen/qwen3-coder:free", name: "Qwen3 Coder Free" }, { id: "meta-llama/llama-3.3-70b-instruct:free", name: "Llama 3.3 70B Free" }],
  },
  "perplexity": {
    id: "perplexity", priority: 180, category: "apikey", noAuth: false,
    baseUrl: "https://api.perplexity.ai", format: "openai",
    models: [{ id: "sonar-pro", name: "Sonar Pro" }],
  },
  "siliconflow": {
    id: "siliconflow", priority: 250, category: "apikey", noAuth: false,
    baseUrl: "https://api.siliconflow.com/v1", format: "openai",
    models: [{ id: "deepseek-ai/DeepSeek-V4-Pro", name: "DeepSeek V4 Pro" }],
  },
  "together": {
    id: "together", priority: 60, category: "apikey", noAuth: false,
    baseUrl: "https://api.together.xyz/v1", format: "openai",
    models: [{ id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", name: "Llama 3.3 70B Turbo" }],
  },
  "venice": {
    id: "venice", priority: 115, category: "apikey", noAuth: false,
    baseUrl: "https://api.venice.ai/api/v1", format: "openai",
    models: [{ id: "llama-3.3-70b", name: "Llama 3.3 70B" }],
  },
  "volcengine-ark": {
    id: "volcengine-ark", priority: 270, category: "apikey", noAuth: false,
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", format: "openai",
    models: [{ id: "DeepSeek-V4-Flash", name: "DeepSeek V4 Flash" }],
  },
  "xai": {
    id: "xai", priority: 280, category: "oauth", noAuth: false,
    baseUrl: "https://api.x.ai/v1", format: "openai",
    models: [{ id: "grok-4", name: "Grok 4" }, { id: "grok-3", name: "Grok 3" }],
  },
};

/** Env var name for a provider ID (override map, else ID upper-snaked + _API_KEY). */
export function keyEnvFor(id: string): string {
  const v = keyEnvOverride[id];
  if (v !== undefined) return v;
  return id.replace(/-/g, "_").replace(/[a-z]/g, (c) => c.toUpperCase()) + "_API_KEY";
}
