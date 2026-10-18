'use strict';

// src/keypool.ts
var DEFAULT_RETRY_AFTER_MS = 6e4;
var FlockKeyPool = class {
  constructor(keys) {
    this.keys = [];
    this.cursor = 0;
    const seen = /* @__PURE__ */ new Set();
    for (const raw of keys) {
      const key = raw.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      this.keys.push({
        key,
        successCount: 0,
        failureCount: 0,
        rateLimitCount: 0,
        rateLimitedUntil: null,
        lastFailureReason: null
      });
    }
  }
  get size() {
    return this.keys.length;
  }
  isLimited(state, now) {
    return state.rateLimitedUntil !== null && state.rateLimitedUntil > now;
  }
  /** Next available key (round-robin), or null when all are rate-limited. */
  nextAvailable() {
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.cursor + i) % this.keys.length;
      if (!this.isLimited(this.keys[idx], now)) {
        this.cursor = (idx + 1) % this.keys.length;
        return this.keys[idx].key;
      }
    }
    return null;
  }
  recordSuccess(key) {
    const s = this.keys.find((k) => k.key === key);
    if (!s) return;
    s.successCount++;
    s.rateLimitedUntil = null;
    s.lastFailureReason = null;
  }
  recordFailure(key, reason) {
    const s = this.keys.find((k) => k.key === key);
    if (!s) return;
    s.failureCount++;
    s.lastFailureReason = reason;
  }
  recordRateLimit(key, retryAfterMs) {
    const s = this.keys.find((k) => k.key === key);
    if (!s) return;
    s.rateLimitCount++;
    s.lastFailureReason = "Rate limited (429)";
    s.rateLimitedUntil = Date.now() + (retryAfterMs ?? DEFAULT_RETRY_AFTER_MS);
  }
  /** Earliest ms-epoch at which a rate-limited key becomes usable, or null. */
  earliestRetryAt() {
    const times = this.keys.map((k) => k.rateLimitedUntil).filter((t) => t !== null);
    return times.length ? Math.min(...times) : null;
  }
  getStats() {
    const now = Date.now();
    return this.keys.map((s, i) => {
      const limited = this.isLimited(s, now);
      return {
        label: "key#" + (i + 1),
        successCount: s.successCount,
        failureCount: s.failureCount,
        rateLimitCount: s.rateLimitCount,
        rateLimitedUntil: s.rateLimitedUntil,
        isRateLimited: limited,
        isAvailable: !limited,
        lastFailureReason: s.lastFailureReason
      };
    });
  }
};
function splitKeys(raw) {
  const list = Array.isArray(raw) ? raw : raw ? raw.split(",") : [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const k of list) {
    const key = k.trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}
function parseRetryAfterMs(value) {
  if (!value) return DEFAULT_RETRY_AFTER_MS;
  const secs = Number(value.trim());
  if (Number.isFinite(secs) && secs >= 0) return secs * 1e3;
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return DEFAULT_RETRY_AFTER_MS;
}

// src/client.ts
var DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";
var DEFAULT_TIMEOUT = 6e4;
var DEFAULT_MAX_RETRIES = 3;
var DEFAULT_RETRY_DELAY = 1e3;
var RETRYABLE_STATUS_CODES = /* @__PURE__ */ new Set([429, 500, 502, 503, 504]);
var FlockClient = class {
  constructor(config) {
    const keys = splitKeys(config.apiKeys ?? config.apiKey);
    if (keys.length === 0) {
      throw new Error(
        "FlockClient requires an apiKey. Get yours free at https://build.nvidia.com"
      );
    }
    this.apiKeys = keys;
    this.apiKey = keys[0];
    this.pool = new FlockKeyPool(keys);
    this.baseURL = (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelay = config.retryDelay ?? DEFAULT_RETRY_DELAY;
  }
  async request(path, options = {}) {
    const url = path.startsWith("http") ? path : `${this.baseURL}${path}`;
    const { timeout = this.timeout, ...fetchOptions } = options;
    let lastError = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let key = this.pool.nextAvailable();
      if (key === null) {
        const waitUntil = this.pool.earliestRetryAt();
        const waitMs = waitUntil === null ? this.retryDelay : Math.max(0, waitUntil - Date.now());
        await sleep(waitMs);
        key = this.pool.nextAvailable();
      }
      if (key === null) {
        throw lastError ?? createError("All API keys are rate limited", 429, true);
      }
      const activeKey = key;
      const rotated = attempt > 0 && this.apiKeys.length > 1;
      if (attempt > 0 && !rotated) {
        const delay = this.retryDelay * Math.pow(2, attempt - 1);
        await sleep(delay);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(url, {
          ...fetchOptions,
          headers: {
            Authorization: `Bearer ${activeKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            ...fetchOptions.headers
          },
          signal: fetchOptions.signal ?? controller.signal
        });
        clearTimeout(timer);
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          const error = createError(
            `NIM API error ${response.status}: ${body}`,
            response.status,
            RETRYABLE_STATUS_CODES.has(response.status)
          );
          if (response.status === 429) {
            this.pool.recordRateLimit(activeKey, parseRetryAfterMs(response.headers.get("retry-after")));
          } else {
            this.pool.recordFailure(activeKey, `HTTP ${response.status}`);
          }
          if (error.retryable && attempt < this.maxRetries) {
            lastError = error;
            continue;
          }
          throw error;
        }
        this.pool.recordSuccess(activeKey);
        return response.json();
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof Error && err.name === "AbortError") {
          throw createError(`Request timed out after ${timeout}ms`, 408, true);
        }
        const nimErr = err;
        if (nimErr.retryable && attempt < this.maxRetries) {
          lastError = nimErr;
          continue;
        }
        throw err;
      }
    }
    throw lastError ?? createError("Max retries exceeded", 0, false);
  }
  async *stream(path, body) {
    const url = `${this.baseURL}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const streamKey = this.pool.nextAvailable() ?? this.apiKey;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${streamKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw createError(`NIM API error ${response.status}: ${text}`, response.status, false);
    }
    if (!response.body) throw createError("No response body for streaming", 0, false);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;
          if (trimmed.startsWith("data: ")) {
            try {
              yield JSON.parse(trimmed.slice(6));
            } catch {
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  async chat(request) {
    return this.request("/chat/completions", {
      method: "POST",
      body: JSON.stringify(request)
    });
  }
  async *chatStream(request) {
    yield* this.stream("/chat/completions", request);
  }
  async embed(request) {
    return this.request("/embeddings", {
      method: "POST",
      body: JSON.stringify(request)
    });
  }
  async rerank(request) {
    return this.request("/ranking", {
      method: "POST",
      body: JSON.stringify(request)
    });
  }
  async listModels() {
    return this.request("/models", { method: "GET" });
  }
  /**
   * Dead-model guard: true when the model is listed as available.
   * Mirrors the swarm client's cold-start/dead-model preflight so callers
   * can skip dead models before spending a request on them.
   */
  async probeModel(model) {
    try {
      const catalog = await this.listModels();
      return catalog.data.some((m) => m.id === model);
    } catch {
      return false;
    }
  }
};
function createError(message, status, retryable) {
  const err = new Error(message);
  err.status = status;
  err.retryable = retryable;
  return err;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/models.ts
var Models = {
  Chat: {
    NEMOTRON_ULTRA: "nvidia/nemotron-3-ultra-550b-a55b",
    NEMOTRON_SUPER: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    NEMOTRON_NANO: "nvidia/llama-3.1-nemotron-nano-8b-v1",
    NEMOTRON_NANO_OMNI: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    LLAMA_3_3_70B: "meta/llama-3.3-70b-instruct",
    LLAMA_3_1_70B: "meta/llama-3.1-70b-instruct",
    LLAMA_3_1_8B: "meta/llama-3.1-8b-instruct",
    LLAMA_3_1_405B: "meta/llama-3.1-405b-instruct",
    MISTRAL_LARGE: "mistralai/mistral-large-3-675b-instruct-2512",
    MISTRAL_7B: "mistralai/mistral-7b-instruct-v0.3",
    MIXTRAL_8X7B: "mistralai/mixtral-8x7b-instruct-v0.1",
    MIXTRAL_8X22B: "mistralai/mixtral-8x22b-instruct-v0.1",
    DEEPSEEK_V4_FLASH: "deepseek-ai/deepseek-v4-flash",
    QWEN3_CODER: "qwen/qwen3-coder-480b-a35b-instruct",
    QWEN2_5_72B: "qwen/qwen2.5-72b-instruct",
    PHI_4: "microsoft/phi-4-multimodal-instruct",
    GEMMA_2_27B: "google/gemma-2-27b-it",
    PALMYRA_MED: "writer/palmyra-med-70b-32k",
    PALMYRA_FIN: "writer/palmyra-fin-70b-32k",
    CODESTRAL: "mistralai/codestral-22b-instruct-v0.1"
  },
  Vision: {
    LLAMA_3_2_90B: "meta/llama-3.2-90b-vision-instruct",
    LLAMA_3_2_11B: "meta/llama-3.2-11b-vision-instruct",
    PALIGEMMA: "google/paligemma",
    PHI_4_MULTIMODAL: "microsoft/phi-4-multimodal-instruct",
    NEMOTRON_NANO_VL: "nvidia/llama-3.1-nemotron-nano-vl-8b-v1",
    COSMOS_REASON: "nvidia/cosmos-reason2-8b"
  },
  Embeddings: {
    NV_EMBEDQA_E5: "nvidia/nv-embedqa-e5-v5",
    NV_EMBEDQA_MISTRAL: "nvidia/nv-embedqa-mistral-7b-v2",
    NV_EMBED_CODE: "nvidia/nv-embedcode-7b-v1",
    LLAMA_NEMOTRON_EMBED: "nvidia/llama-nemotron-embed-1b-v2",
    LLAMA_NEMOTRON_EMBED_VL: "nvidia/llama-nemotron-embed-vl-1b-v2",
    BGE_M3: "baai/bge-m3",
    E5_LARGE: "intfloat/multilingual-e5-large-instruct"
  },
  Rerank: {
    RERANK_MISTRAL: "nvidia/rerank-qa-mistral-4b",
    NEMOTRON_RERANK: "nvidia/nemotron-rerank-1b-v2"
  },
  Speech: {
    PARAKEET_CTC: "nvidia/parakeet-ctc-1.1b-asr",
    PARAKEET_TDT: "nvidia/parakeet-tdt-1.1b-asr",
    CANARY_1B: "nvidia/canary-1b-asr",
    MAGPIE_TTS: "nvidia/magpie-tts-zeroshot",
    FASTPITCH_HIFIGAN: "nvidia/fastpitch-hifigan-tts"
  },
  Safety: {
    NEMOGUARD_CONTENT: "nvidia/llama-3.1-nemoguard-8b-content-safety",
    NEMOGUARD_TOPIC: "nvidia/llama-3.1-nemoguard-8b-topic-control",
    NEMOTRON_CONTENT_SAFETY: "nvidia/nemotron-3.5-content-safety",
    NEMOTRON_CONTENT_SAFETY_REASONING: "nvidia/nemotron-content-safety-reasoning-4b",
    GLINER_PII: "nvidia/gliner-pii",
    NEMOJAIL: "nvidia/nemojail-jailbreak-detect",
    AEGIS: "nvidia/llama-3.1-aegis-defense-v1.0"
  },
  Document: {
    NEMORETRIEVER_PARSE: "nvidia/nemoretriever-parse",
    NEMOTRON_OCR: "nvidia/nemotron-ocr-v1",
    NEMOTRON_TABLE: "nvidia/nemotron-table-structure-v1",
    NEMOTRON_PAGE_ELEMENTS: "nvidia/nemotron-page-elements-v3",
    NEMOTRON_GRAPHIC: "nvidia/nemotron-graphic-elements-v1",
    PADDLE_OCR: "nvidia/paddleocr",
    DEPLOT: "google/deplot"
  },
  Biology: {
    ESMFOLD: "nvidia/esmfold",
    ESM2_650M: "nvidia/esm2-650m",
    MSA_SEARCH: "nvidia/msa-search",
    GENMOL: "nvidia/genmol",
    MOLMIM: "nvidia/molmim",
    RFDIFFUSION: "nvidia/rfdiffusion",
    BOLTZ2: "nvidia/Boltz-2"
  },
  Video: {
    COSMOS3_NANO: "nvidia/cosmos3-nano",
    COSMOS_TRANSFER: "nvidia/cosmos-transfer1-7b",
    COSMOS_PREDICT: "nvidia/cosmos-predict1-5b",
    COSMOS_TRANSFER2: "nvidia/cosmos-transfer2.5-2b",
    SYNTHETIC_VIDEO_DETECTOR: "nvidia/ai-synthetic-video-detector"
  },
  Weather: {
    FOURCASTNET: "nvidia/fourcastnet"
  },
  Translation: {
    RIVA_TRANSLATE: "nvidia/riva-translate-4b-instruct-v1.1"
  },
  Audio: {
    BACKGROUND_NOISE_REMOVAL: "nvidia/noise-cancellation",
    STUDIO_VOICE: "nvidia/studio-voice",
    ACTIVE_SPEAKER_DETECTION: "nvidia/active-speaker-detection"
  },
  Code: {
    QWEN3_CODER: "qwen/qwen3-coder-480b-a35b-instruct",
    NV_EMBED_CODE: "nvidia/nv-embedcode-7b-v1",
    CODESTRAL: "mistralai/codestral-22b-instruct-v0.1",
    DEEPSEEK_V4_FLASH: "deepseek-ai/deepseek-v4-flash"
  }
};

// src/endpoints/chat.ts
var ChatEndpoint = class {
  constructor(client) {
    this.client = client;
  }
  async complete(messages, options = {}) {
    const { system, ...rest } = options;
    const allMessages = system ? [{ role: "system", content: system }, ...messages] : messages;
    return this.client.chat({
      model: rest.model ?? Models.Chat.LLAMA_3_1_70B,
      messages: allMessages,
      temperature: rest.temperature ?? 0.2,
      top_p: rest.top_p ?? 0.7,
      max_tokens: rest.max_tokens ?? 1024,
      stop: rest.stop,
      seed: rest.seed
    });
  }
  async ask(prompt, options = {}) {
    const response = await this.complete(
      [{ role: "user", content: prompt }],
      options
    );
    return response.choices[0]?.message.content ?? "";
  }
  async *stream(messages, options = {}) {
    const { system, ...rest } = options;
    const allMessages = system ? [{ role: "system", content: system }, ...messages] : messages;
    yield* this.client.chatStream({
      model: rest.model ?? Models.Chat.LLAMA_3_1_70B,
      messages: allMessages,
      temperature: rest.temperature ?? 0.2,
      top_p: rest.top_p ?? 0.7,
      max_tokens: rest.max_tokens ?? 1024,
      stop: rest.stop,
      seed: rest.seed
    });
  }
  async *streamText(prompt, options = {}) {
    for await (const chunk of this.stream(
      [{ role: "user", content: prompt }],
      options
    )) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) yield content;
    }
  }
  async reason(prompt, options = {}) {
    return this.ask(prompt, {
      model: Models.Chat.NEMOTRON_ULTRA,
      temperature: 0.6,
      top_p: 0.95,
      max_tokens: 4096,
      ...options
    });
  }
  async summarize(text, options = {}) {
    return this.ask(
      `Summarize the following content clearly and concisely:

${text}`,
      {
        model: Models.Chat.LLAMA_3_1_70B,
        temperature: 0.1,
        max_tokens: 512,
        ...options
      }
    );
  }
  async extract(text, schema, options = {}) {
    const prompt = `Extract the following fields from the text and return as valid JSON only (no markdown, no explanation):

Schema: ${schema}

Text:
${text}`;
    const raw = await this.ask(prompt, {
      model: Models.Chat.LLAMA_3_1_70B,
      temperature: 0.1,
      max_tokens: 1024,
      ...options
    });
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Model did not return valid JSON");
    return JSON.parse(jsonMatch[0]);
  }
  async classify(text, labels, options = {}) {
    const prompt = `Classify the following text into exactly one of these categories: ${labels.join(", ")}.
Return only the category name, nothing else.

Text: ${text}`;
    const result = await this.ask(prompt, {
      model: Models.Chat.LLAMA_3_1_8B,
      temperature: 0.1,
      max_tokens: 50,
      ...options
    });
    return result.trim();
  }
  async translate(text, targetLanguage, options = {}) {
    return this.ask(
      `Translate the following text to ${targetLanguage}. Return only the translation, no explanation:

${text}`,
      { model: Models.Chat.MISTRAL_7B, temperature: 0.1, max_tokens: 2048, ...options }
    );
  }
};

// src/endpoints/vision.ts
function toDataUrl(imageBuffer, mimeType = "image/jpeg") {
  return `data:${mimeType};base64,${imageBuffer.toString("base64")}`;
}
var VisionEndpoint = class {
  constructor(client) {
    this.client = client;
  }
  async analyze(imageUrl, prompt, options = {}) {
    const messages = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageUrl } },
          { type: "text", text: prompt }
        ]
      }
    ];
    const response = await this.client.chat({
      model: options.model ?? Models.Vision.LLAMA_3_2_90B,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.max_tokens ?? 1024
    });
    return response.choices[0]?.message.content ?? "";
  }
  async analyzeBuffer(imageBuffer, prompt, options = {}) {
    const dataUrl = toDataUrl(imageBuffer, options.mimeType ?? "image/jpeg");
    return this.analyze(dataUrl, prompt, options);
  }
  async caption(imageUrl, options = {}) {
    return this.analyze(
      imageUrl,
      "Describe this image in detail. What do you see?",
      options
    );
  }
  async ocr(imageUrl, options = {}) {
    return this.analyze(
      imageUrl,
      "Extract all text visible in this image. Return only the extracted text, preserving layout where possible.",
      options
    );
  }
  async readChart(imageUrl, options = {}) {
    return this.analyze(
      imageUrl,
      "This is a chart or graph. Extract all data points, labels, axis values, and describe the trend or insight the chart shows. Return as structured text.",
      { model: Models.Document.DEPLOT, ...options }
    );
  }
  async detectObjects(imageUrl, options = {}) {
    return this.analyze(
      imageUrl,
      "List all objects, people, and elements visible in this image with their approximate positions.",
      options
    );
  }
  async answer(imageUrl, question, options = {}) {
    return this.analyze(imageUrl, question, options);
  }
  async compareImages(imageUrl1, imageUrl2, prompt = "Compare these two images and describe the differences.", options = {}) {
    const messages = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageUrl1 } },
          { type: "image_url", image_url: { url: imageUrl2 } },
          { type: "text", text: prompt }
        ]
      }
    ];
    const response = await this.client.chat({
      model: options.model ?? Models.Vision.LLAMA_3_2_90B,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.max_tokens ?? 1024
    });
    return response.choices[0]?.message.content ?? "";
  }
};

// src/endpoints/embeddings.ts
var EmbeddingsEndpoint = class {
  constructor(client) {
    this.client = client;
  }
  async embed(text, options = {}) {
    const response = await this.client.embed({
      model: options.model ?? Models.Embeddings.NV_EMBEDQA_E5,
      input: text,
      input_type: options.input_type ?? "query",
      truncate: options.truncate ?? "END"
    });
    return response.data[0]?.embedding ?? [];
  }
  async embedMany(texts, options = {}) {
    const response = await this.client.embed({
      model: options.model ?? Models.Embeddings.NV_EMBEDQA_E5,
      input: texts,
      input_type: options.input_type ?? "passage",
      truncate: options.truncate ?? "END"
    });
    return response.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
  async embedCode(code, options = {}) {
    return this.embed(code, {
      model: Models.Embeddings.NV_EMBED_CODE,
      input_type: "passage",
      ...options
    });
  }
  async embedQuery(query, options = {}) {
    return this.embed(query, {
      input_type: "query",
      ...options
    });
  }
  async rerank(query, passages, options = {}) {
    const response = await this.client.rerank({
      model: options.model ?? Models.Rerank.RERANK_MISTRAL,
      query,
      passages: passages.map((text) => ({ text })),
      truncate: options.truncate ?? "END"
    });
    return response.rankings.map((r) => ({
      text: passages[r.index] ?? "",
      score: r.logit,
      index: r.index
    }));
  }
  cosineSimilarity(a, b) {
    if (a.length !== b.length) throw new Error("Vectors must have equal length");
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
  async findMostSimilar(query, candidates, options = {}) {
    const [queryVec, candidateVecs] = await Promise.all([
      this.embedQuery(query, options),
      this.embedMany(candidates, { ...options, input_type: "passage" })
    ]);
    return candidates.map((text, i) => ({
      text,
      score: this.cosineSimilarity(queryVec, candidateVecs[i]),
      index: i
    })).sort((a, b) => b.score - a.score);
  }
};

// src/endpoints/safety.ts
var SafetyEndpoint = class {
  constructor(client) {
    this.client = client;
  }
  async checkContent(text, options = {}) {
    const response = await this.client.chat({
      model: options.model ?? Models.Safety.NEMOGUARD_CONTENT,
      messages: [{ role: "user", content: text }],
      max_tokens: 200,
      temperature: 0.1
    });
    const raw = response.choices[0]?.message.content ?? "";
    const safe = raw.toLowerCase().includes("safe") && !raw.toLowerCase().includes("unsafe");
    return {
      safe,
      violated: safe ? [] : ["content_policy"],
      scores: { safety: safe ? 1 : 0 },
      explanation: raw
    };
  }
  async checkMessages(messages, options = {}) {
    const last = messages[messages.length - 1]?.content;
    const text = typeof last === "string" ? last : JSON.stringify(last);
    return this.checkContent(text, options);
  }
  async detectPII(text, options = {}) {
    const response = await this.client.request(
      "/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: options.model ?? Models.Safety.GLINER_PII,
          messages: [{ role: "user", content: text }],
          max_tokens: 512,
          temperature: 0
        })
      }
    );
    const raw = response?.choices?.[0]?.message.content ?? "[]";
    let entities = [];
    try {
      entities = JSON.parse(raw);
    } catch {
      entities = [];
    }
    let anonymized = text;
    for (const entity of [...entities].sort((a, b) => b.start - a.start)) {
      anonymized = anonymized.slice(0, entity.start) + `[${entity.label}]` + anonymized.slice(entity.end);
    }
    return { entities, anonymized, hasPII: entities.length > 0 };
  }
  async anonymize(text) {
    const result = await this.detectPII(text);
    return result.anonymized;
  }
  async detectJailbreak(prompt, options = {}) {
    const response = await this.client.chat({
      model: options.model ?? Models.Safety.NEMOJAIL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
      temperature: 0
    });
    const raw = response.choices[0]?.message.content?.toLowerCase() ?? "";
    const isJailbreak = raw.includes("jailbreak") || raw.includes("injection");
    return {
      isJailbreak,
      confidence: isJailbreak ? 0.9 : 0.1,
      explanation: response.choices[0]?.message.content
    };
  }
  async enforceTopicPolicy(message, allowedTopics, options = {}) {
    const system = `You are a topic guard. Only allow messages related to: ${allowedTopics.join(", ")}. Respond with JSON: {"allowed": boolean, "reason": string}`;
    const response = await this.client.chat({
      model: options.model ?? Models.Safety.NEMOGUARD_TOPIC,
      messages: [
        { role: "system", content: system },
        { role: "user", content: message }
      ],
      max_tokens: 100,
      temperature: 0
    });
    try {
      const raw = response.choices[0]?.message.content ?? "{}";
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { allowed: false, reason: "Could not parse policy response" };
    } catch {
      return { allowed: false, reason: "Policy check failed" };
    }
  }
  async isSafe(text) {
    const result = await this.checkContent(text);
    return result.safe;
  }
};

// src/endpoints/biology.ts
var BIOLOGY_BASE_URL = "https://health.api.nvidia.com/v1";
var BiologyEndpoint = class {
  constructor(client) {
    this.client = client;
    this.bioUrl = BIOLOGY_BASE_URL;
  }
  async foldProtein(sequence) {
    const response = await this.client.request(`${this.bioUrl}/biology/deepmind/esmfold`, {
      method: "POST",
      body: JSON.stringify({ sequence })
    });
    return {
      pdb: response.pdbs?.[0] ?? "",
      mean_plddt: response.mean_plddt?.[0],
      model: "esmfold"
    };
  }
  async getProteinEmbedding(sequence) {
    const response = await this.client.request(`${this.bioUrl}/biology/nvidia/esm2-650m`, {
      method: "POST",
      body: JSON.stringify({ sequence })
    });
    const layers = Object.values(response.mean_representations ?? {});
    return layers[layers.length - 1] ?? [];
  }
  async generateMolecules(smiles, options = {}) {
    const response = await this.client.request(`${this.bioUrl}/biology/nvidia/genmol`, {
      method: "POST",
      body: JSON.stringify({
        smiles,
        num_molecules: options.numMolecules ?? 10,
        temperature: options.temperature ?? 1,
        iterations: options.iterations ?? 20
      })
    });
    return (response.molecules ?? []).map((m) => ({
      smiles: m.smiles,
      score: m.score
    }));
  }
  async optimizeMolecule(smiles, targetProperty = "qed", options = {}) {
    const response = await this.client.request(`${this.bioUrl}/biology/nvidia/molmim`, {
      method: "POST",
      body: JSON.stringify({
        smiles,
        property: targetProperty,
        num_molecules: options.numMolecules ?? 10,
        iterations: options.iterations ?? 100,
        temperature: options.temperature ?? 0.5
      })
    });
    return (response.optimized_molecules ?? []).map((m) => ({
      smiles: m.smiles,
      properties: {
        qed: m.qed,
        sa: m.sa,
        logp: m.logp,
        mw: m.mw
      }
    }));
  }
  async runMSA(sequence) {
    const response = await this.client.request(`${this.bioUrl}/biology/nvidia/msa-search`, {
      method: "POST",
      body: JSON.stringify({ sequence })
    });
    return {
      alignment: response.alignment ?? "",
      sequences: response.sequences ?? []
    };
  }
};

// src/endpoints/speech.ts
var AUDIO_BASE_URL = "https://integrate.api.nvidia.com/v1";
var SpeechEndpoint = class {
  constructor(client) {
    this.client = client;
  }
  async transcribe(audioData, options = {}) {
    const formData = new FormData();
    if (typeof audioData === "string") {
      formData.append("file", audioData);
    } else if (Buffer.isBuffer(audioData)) {
      formData.append(
        "file",
        new Blob([audioData], { type: "audio/wav" }),
        "audio.wav"
      );
    } else {
      formData.append("file", audioData, "audio.wav");
    }
    formData.append("model", options.model ?? Models.Speech.PARAKEET_CTC);
    if (options.language) formData.append("language", options.language);
    if (options.task) formData.append("task", options.task);
    const response = await fetch(`${AUDIO_BASE_URL}/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.client.apiKey}`
      },
      body: formData
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`ASR error ${response.status}: ${text}`);
    }
    return response.json();
  }
  async transcribeMultilingual(audioData, options = {}) {
    return this.transcribe(audioData, {
      model: Models.Speech.CANARY_1B,
      ...options
    });
  }
  async synthesize(text, options = {}) {
    const response = await fetch(`${AUDIO_BASE_URL}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.client.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: options.model ?? Models.Speech.MAGPIE_TTS,
        input: text,
        voice: options.voice ?? "default",
        response_format: "wav",
        sample_rate: options.sample_rate ?? 22050
      })
    });
    if (!response.ok) {
      const text2 = await response.text().catch(() => "");
      throw new Error(`TTS error ${response.status}: ${text2}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
  async zeroShotClone(text, referenceAudioUrl, options = {}) {
    return this.synthesize(text, {
      model: Models.Speech.MAGPIE_TTS,
      voice: referenceAudioUrl,
      ...options
    });
  }
};

// src/endpoints/document.ts
var DocumentEndpoint = class {
  constructor(client) {
    this.client = client;
  }
  async parse(pdfBase64, options = {}) {
    const response = await this.client.request("/retrieval/nvidia/nemoretriever-parse/v1/infer", {
      method: "POST",
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Extract all text, tables, and image descriptions from this document."
              },
              {
                type: "media_url",
                media_url: {
                  url: `data:application/pdf;base64,${pdfBase64}`
                }
              }
            ]
          }
        ],
        model: options.model ?? Models.Document.NEMORETRIEVER_PARSE
      })
    });
    const pages = response.pages ?? [];
    const full_text = pages.map((p) => p.text).join("\n\n");
    return {
      pages: pages.map((p) => ({
        page_number: p.page_number,
        text: p.text,
        tables: (p.tables ?? []).map((t) => ({ rows: t.rows })),
        images: (p.images ?? []).map((img) => ({ caption: img.caption }))
      })),
      full_text: full_text || (response.content ?? "")
    };
  }
  async ocr(imageBase64, mimeType = "image/jpeg") {
    const response = await this.client.chat({
      model: Models.Document.NEMOTRON_OCR,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${imageBase64}`
              }
            },
            {
              type: "text",
              text: "Extract all text from this image. Return only the text, preserving the original layout."
            }
          ]
        }
      ],
      temperature: 0,
      max_tokens: 2048
    });
    return {
      text: response.choices[0]?.message.content ?? ""
    };
  }
  async extractTable(imageBase64, mimeType = "image/jpeg") {
    const response = await this.client.chat({
      model: Models.Document.NEMOTRON_TABLE,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${imageBase64}`
              }
            },
            {
              type: "text",
              text: 'Extract the table from this image and return it as JSON with format: {"headers": [...], "rows": [[...]]}. Return only the JSON.'
            }
          ]
        }
      ],
      temperature: 0,
      max_tokens: 2048
    });
    const raw = response.choices[0]?.message.content ?? "{}";
    const match = raw.match(/\{[\s\S]*\}/);
    try {
      return match ? JSON.parse(match[0]) : { headers: [], rows: [] };
    } catch {
      return { headers: [], rows: [] };
    }
  }
  async chartToData(imageBase64) {
    const response = await this.client.chat({
      model: Models.Document.DEPLOT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
            },
            {
              type: "text",
              text: "Generate underlying data table of the figure below:"
            }
          ]
        }
      ],
      temperature: 0,
      max_tokens: 1024
    });
    return response.choices[0]?.message.content ?? "";
  }
};

// src/endpoints/translation.ts
var SUPPORTED_LANGUAGES = {
  ENGLISH: "en",
  SPANISH: "es",
  FRENCH: "fr",
  GERMAN: "de",
  ITALIAN: "it",
  PORTUGUESE: "pt",
  RUSSIAN: "ru",
  CHINESE: "zh",
  JAPANESE: "ja",
  KOREAN: "ko",
  ARABIC: "ar",
  HINDI: "hi",
  DUTCH: "nl",
  POLISH: "pl",
  TURKISH: "tr",
  VIETNAMESE: "vi",
  INDONESIAN: "id",
  THAI: "th",
  SWEDISH: "sv",
  NORWEGIAN: "no"
};
var TranslationEndpoint = class {
  constructor(client) {
    this.client = client;
  }
  async translate(text, targetLanguage, options = {}) {
    const sourceHint = options.source_language ? ` from ${options.source_language}` : "";
    const prompt = `Translate the following text${sourceHint} to ${targetLanguage}. Return only the translated text with no explanation:

${text}`;
    const response = await this.client.chat({
      model: options.model ?? Models.Translation.RIVA_TRANSLATE,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: text.length * 3
    });
    return {
      translated_text: response.choices[0]?.message.content ?? "",
      source_language: options.source_language,
      target_language: targetLanguage,
      model: options.model ?? Models.Translation.RIVA_TRANSLATE
    };
  }
  async translateBatch(texts, targetLanguage, options = {}) {
    return Promise.all(texts.map((t) => this.translate(t, targetLanguage, options)));
  }
  async detectLanguage(text) {
    const response = await this.client.chat({
      model: Models.Chat.LLAMA_3_1_8B,
      messages: [
        {
          role: "user",
          content: `Detect the language of this text. Return only the ISO 639-1 language code (e.g., "en", "es", "fr") with no other output:

${text}`
        }
      ],
      temperature: 0,
      max_tokens: 10
    });
    return response.choices[0]?.message.content?.trim() ?? "unknown";
  }
  async translateToMany(text, targetLanguages, options = {}) {
    const results = await Promise.all(
      targetLanguages.map(async (lang) => {
        const result = await this.translate(text, lang, options);
        return [lang, result.translated_text];
      })
    );
    return Object.fromEntries(results);
  }
};

// src/index.ts
var Flock = class {
  constructor(config) {
    const resolvedConfig = typeof config === "string" ? { apiKey: config } : config;
    this._client = new FlockClient(resolvedConfig);
    this.chat = new ChatEndpoint(this._client);
    this.vision = new VisionEndpoint(this._client);
    this.embeddings = new EmbeddingsEndpoint(this._client);
    this.safety = new SafetyEndpoint(this._client);
    this.biology = new BiologyEndpoint(this._client);
    this.speech = new SpeechEndpoint(this._client);
    this.document = new DocumentEndpoint(this._client);
    this.translation = new TranslationEndpoint(this._client);
  }
  get client() {
    return this._client;
  }
};
function createFlockClient(config) {
  return new Flock(config);
}
var Nim = Flock;
var NimClient = FlockClient;
var createNimClient = createFlockClient;

exports.BiologyEndpoint = BiologyEndpoint;
exports.ChatEndpoint = ChatEndpoint;
exports.DocumentEndpoint = DocumentEndpoint;
exports.EmbeddingsEndpoint = EmbeddingsEndpoint;
exports.Flock = Flock;
exports.FlockClient = FlockClient;
exports.FlockKeyPool = FlockKeyPool;
exports.Models = Models;
exports.Nim = Nim;
exports.NimClient = NimClient;
exports.SUPPORTED_LANGUAGES = SUPPORTED_LANGUAGES;
exports.SafetyEndpoint = SafetyEndpoint;
exports.SpeechEndpoint = SpeechEndpoint;
exports.TranslationEndpoint = TranslationEndpoint;
exports.VisionEndpoint = VisionEndpoint;
exports.createFlockClient = createFlockClient;
exports.createNimClient = createNimClient;
exports.parseRetryAfterMs = parseRetryAfterMs;
exports.splitKeys = splitKeys;
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map