interface FlockClientConfig {
    apiKey: string;
    /** Additional keys; apiKey may also be comma-separated. Enables rotation. */
    apiKeys?: string[];
    baseURL?: string;
    timeout?: number;
    maxRetries?: number;
    retryDelay?: number;
}
interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string | ContentPart[];
}
type ContentPart = TextPart | ImageUrlPart;
interface TextPart {
    type: "text";
    text: string;
}
interface ImageUrlPart {
    type: "image_url";
    image_url: {
        url: string;
    };
}
interface ChatCompletionRequest {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    stream?: boolean;
    stop?: string | string[];
    seed?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
}
interface ChatChoice {
    index: number;
    message: {
        role: string;
        content: string;
    };
    finish_reason: string | null;
    delta?: {
        content?: string;
    };
}
interface ChatCompletionResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: ChatChoice[];
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}
interface StreamChunk {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
        index: number;
        delta: {
            role?: string;
            content?: string;
        };
        finish_reason: string | null;
    }>;
}
interface EmbeddingRequest {
    model: string;
    input: string | string[];
    input_type?: "query" | "passage";
    encoding_format?: "float" | "base64";
    truncate?: "NONE" | "START" | "END";
}
interface EmbeddingData {
    object: "embedding";
    index: number;
    embedding: number[];
}
interface EmbeddingResponse {
    object: "list";
    data: EmbeddingData[];
    model: string;
    usage: {
        prompt_tokens: number;
        total_tokens: number;
    };
}
interface RerankRequest {
    model: string;
    query: string;
    passages: Array<{
        text: string;
    }>;
    truncate?: "NONE" | "END";
}
interface RerankResult {
    index: number;
    logit: number;
    text?: string;
}
interface RerankResponse {
    rankings: RerankResult[];
    usage: {
        prompt_tokens: number;
        total_tokens: number;
    };
}
interface NimError extends Error {
    status?: number;
    code?: string;
    retryable?: boolean;
}

declare class FlockClient {
    readonly apiKey: string;
    readonly apiKeys: string[];
    readonly baseURL: string;
    readonly timeout: number;
    readonly maxRetries: number;
    readonly retryDelay: number;
    private readonly pool;
    constructor(config: FlockClientConfig);
    request<T>(path: string, options?: RequestInit & {
        timeout?: number;
    }): Promise<T>;
    stream(path: string, body: Record<string, unknown>): AsyncGenerator<StreamChunk>;
    chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
    chatStream(request: Omit<ChatCompletionRequest, "stream">): AsyncGenerator<StreamChunk>;
    embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
    rerank(request: RerankRequest): Promise<RerankResponse>;
    listModels(): Promise<{
        data: {
            id: string;
        }[];
    }>;
    /**
     * Dead-model guard: true when the model is listed as available.
     * Mirrors the swarm client's cold-start/dead-model preflight so callers
     * can skip dead models before spending a request on them.
     */
    probeModel(model: string): Promise<boolean>;
}

/**
 * FlockKeyPool — multi-key rotation with 429/Retry-After tracking.
 *
 * Absorbed from the standalone super-ralph nimProxy integration so the
 * flock-client SDK carries the same resilience without a proxy in front:
 * keys are deduplicated on registration, rotation is round-robin over
 * keys whose rate limit has expired, and a 429 parks the offending key
 * for the server's Retry-After (default 60s) instead of burning retries
 * against it. Key values never appear in stats or error labels.
 */
type FlockKeyStats = {
    /** Opaque label ("key#1") — never the key value. */
    label: string;
    successCount: number;
    failureCount: number;
    rateLimitCount: number;
    rateLimitedUntil: number | null;
    isRateLimited: boolean;
    isAvailable: boolean;
    lastFailureReason: string | null;
};
declare class FlockKeyPool {
    private keys;
    private cursor;
    constructor(keys: string[]);
    get size(): number;
    private isLimited;
    /** Next available key (round-robin), or null when all are rate-limited. */
    nextAvailable(): string | null;
    recordSuccess(key: string): void;
    recordFailure(key: string, reason: string): void;
    recordRateLimit(key: string, retryAfterMs?: number): void;
    /** Earliest ms-epoch at which a rate-limited key becomes usable, or null. */
    earliestRetryAt(): number | null;
    getStats(): FlockKeyStats[];
}
/** Split a comma-separated key string into deduplicated keys. */
declare function splitKeys(raw: string | string[] | undefined): string[];
/** Parse a Retry-After header (seconds or HTTP date) into ms. */
declare function parseRetryAfterMs(value: string | null): number;

declare const Models: {
    readonly Chat: {
        readonly NEMOTRON_ULTRA: "nvidia/nemotron-3-ultra-550b-a55b";
        readonly NEMOTRON_SUPER: "nvidia/llama-3.3-nemotron-super-49b-v1.5";
        readonly NEMOTRON_NANO: "nvidia/llama-3.1-nemotron-nano-8b-v1";
        readonly NEMOTRON_NANO_OMNI: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
        readonly LLAMA_3_3_70B: "meta/llama-3.3-70b-instruct";
        readonly LLAMA_3_1_70B: "meta/llama-3.1-70b-instruct";
        readonly LLAMA_3_1_8B: "meta/llama-3.1-8b-instruct";
        readonly LLAMA_3_1_405B: "meta/llama-3.1-405b-instruct";
        readonly MISTRAL_LARGE: "mistralai/mistral-large-3-675b-instruct-2512";
        readonly MISTRAL_7B: "mistralai/mistral-7b-instruct-v0.3";
        readonly MIXTRAL_8X7B: "mistralai/mixtral-8x7b-instruct-v0.1";
        readonly MIXTRAL_8X22B: "mistralai/mixtral-8x22b-instruct-v0.1";
        readonly DEEPSEEK_V4_FLASH: "deepseek-ai/deepseek-v4-flash";
        readonly QWEN3_CODER: "qwen/qwen3-coder-480b-a35b-instruct";
        readonly QWEN2_5_72B: "qwen/qwen2.5-72b-instruct";
        readonly PHI_4: "microsoft/phi-4-multimodal-instruct";
        readonly GEMMA_2_27B: "google/gemma-2-27b-it";
        readonly PALMYRA_MED: "writer/palmyra-med-70b-32k";
        readonly PALMYRA_FIN: "writer/palmyra-fin-70b-32k";
        readonly CODESTRAL: "mistralai/codestral-22b-instruct-v0.1";
    };
    readonly Vision: {
        readonly LLAMA_3_2_90B: "meta/llama-3.2-90b-vision-instruct";
        readonly LLAMA_3_2_11B: "meta/llama-3.2-11b-vision-instruct";
        readonly PALIGEMMA: "google/paligemma";
        readonly PHI_4_MULTIMODAL: "microsoft/phi-4-multimodal-instruct";
        readonly NEMOTRON_NANO_VL: "nvidia/llama-3.1-nemotron-nano-vl-8b-v1";
        readonly COSMOS_REASON: "nvidia/cosmos-reason2-8b";
    };
    readonly Embeddings: {
        readonly NV_EMBEDQA_E5: "nvidia/nv-embedqa-e5-v5";
        readonly NV_EMBEDQA_MISTRAL: "nvidia/nv-embedqa-mistral-7b-v2";
        readonly NV_EMBED_CODE: "nvidia/nv-embedcode-7b-v1";
        readonly LLAMA_NEMOTRON_EMBED: "nvidia/llama-nemotron-embed-1b-v2";
        readonly LLAMA_NEMOTRON_EMBED_VL: "nvidia/llama-nemotron-embed-vl-1b-v2";
        readonly BGE_M3: "baai/bge-m3";
        readonly E5_LARGE: "intfloat/multilingual-e5-large-instruct";
    };
    readonly Rerank: {
        readonly RERANK_MISTRAL: "nvidia/rerank-qa-mistral-4b";
        readonly NEMOTRON_RERANK: "nvidia/nemotron-rerank-1b-v2";
    };
    readonly Speech: {
        readonly PARAKEET_CTC: "nvidia/parakeet-ctc-1.1b-asr";
        readonly PARAKEET_TDT: "nvidia/parakeet-tdt-1.1b-asr";
        readonly CANARY_1B: "nvidia/canary-1b-asr";
        readonly MAGPIE_TTS: "nvidia/magpie-tts-zeroshot";
        readonly FASTPITCH_HIFIGAN: "nvidia/fastpitch-hifigan-tts";
    };
    readonly Safety: {
        readonly NEMOGUARD_CONTENT: "nvidia/llama-3.1-nemoguard-8b-content-safety";
        readonly NEMOGUARD_TOPIC: "nvidia/llama-3.1-nemoguard-8b-topic-control";
        readonly NEMOTRON_CONTENT_SAFETY: "nvidia/nemotron-3.5-content-safety";
        readonly NEMOTRON_CONTENT_SAFETY_REASONING: "nvidia/nemotron-content-safety-reasoning-4b";
        readonly GLINER_PII: "nvidia/gliner-pii";
        readonly NEMOJAIL: "nvidia/nemojail-jailbreak-detect";
        readonly AEGIS: "nvidia/llama-3.1-aegis-defense-v1.0";
    };
    readonly Document: {
        readonly NEMORETRIEVER_PARSE: "nvidia/nemoretriever-parse";
        readonly NEMOTRON_OCR: "nvidia/nemotron-ocr-v1";
        readonly NEMOTRON_TABLE: "nvidia/nemotron-table-structure-v1";
        readonly NEMOTRON_PAGE_ELEMENTS: "nvidia/nemotron-page-elements-v3";
        readonly NEMOTRON_GRAPHIC: "nvidia/nemotron-graphic-elements-v1";
        readonly PADDLE_OCR: "nvidia/paddleocr";
        readonly DEPLOT: "google/deplot";
    };
    readonly Biology: {
        readonly ESMFOLD: "nvidia/esmfold";
        readonly ESM2_650M: "nvidia/esm2-650m";
        readonly MSA_SEARCH: "nvidia/msa-search";
        readonly GENMOL: "nvidia/genmol";
        readonly MOLMIM: "nvidia/molmim";
        readonly RFDIFFUSION: "nvidia/rfdiffusion";
        readonly BOLTZ2: "nvidia/Boltz-2";
    };
    readonly Video: {
        readonly COSMOS3_NANO: "nvidia/cosmos3-nano";
        readonly COSMOS_TRANSFER: "nvidia/cosmos-transfer1-7b";
        readonly COSMOS_PREDICT: "nvidia/cosmos-predict1-5b";
        readonly COSMOS_TRANSFER2: "nvidia/cosmos-transfer2.5-2b";
        readonly SYNTHETIC_VIDEO_DETECTOR: "nvidia/ai-synthetic-video-detector";
    };
    readonly Weather: {
        readonly FOURCASTNET: "nvidia/fourcastnet";
    };
    readonly Translation: {
        readonly RIVA_TRANSLATE: "nvidia/riva-translate-4b-instruct-v1.1";
    };
    readonly Audio: {
        readonly BACKGROUND_NOISE_REMOVAL: "nvidia/noise-cancellation";
        readonly STUDIO_VOICE: "nvidia/studio-voice";
        readonly ACTIVE_SPEAKER_DETECTION: "nvidia/active-speaker-detection";
    };
    readonly Code: {
        readonly QWEN3_CODER: "qwen/qwen3-coder-480b-a35b-instruct";
        readonly NV_EMBED_CODE: "nvidia/nv-embedcode-7b-v1";
        readonly CODESTRAL: "mistralai/codestral-22b-instruct-v0.1";
        readonly DEEPSEEK_V4_FLASH: "deepseek-ai/deepseek-v4-flash";
    };
};
type ChatModel = (typeof Models.Chat)[keyof typeof Models.Chat];
type VisionModel = (typeof Models.Vision)[keyof typeof Models.Vision];
type EmbeddingModel = (typeof Models.Embeddings)[keyof typeof Models.Embeddings];
type RerankModel = (typeof Models.Rerank)[keyof typeof Models.Rerank];
type SpeechModel = (typeof Models.Speech)[keyof typeof Models.Speech];
type SafetyModel = (typeof Models.Safety)[keyof typeof Models.Safety];
type DocumentModel = (typeof Models.Document)[keyof typeof Models.Document];
type BiologyModel = (typeof Models.Biology)[keyof typeof Models.Biology];

interface ChatOptions {
    model?: string;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    stop?: string | string[];
    seed?: number;
    system?: string;
}
declare class ChatEndpoint {
    private client;
    constructor(client: FlockClient);
    complete(messages: ChatMessage[], options?: ChatOptions): Promise<ChatCompletionResponse>;
    ask(prompt: string, options?: ChatOptions): Promise<string>;
    stream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<StreamChunk>;
    streamText(prompt: string, options?: ChatOptions): AsyncGenerator<string>;
    reason(prompt: string, options?: ChatOptions): Promise<string>;
    summarize(text: string, options?: ChatOptions): Promise<string>;
    extract<T = Record<string, unknown>>(text: string, schema: string, options?: ChatOptions): Promise<T>;
    classify(text: string, labels: string[], options?: ChatOptions): Promise<string>;
    translate(text: string, targetLanguage: string, options?: ChatOptions): Promise<string>;
}

interface VisionOptions {
    model?: string;
    temperature?: number;
    max_tokens?: number;
}
declare class VisionEndpoint {
    private client;
    constructor(client: FlockClient);
    analyze(imageUrl: string, prompt: string, options?: VisionOptions): Promise<string>;
    analyzeBuffer(imageBuffer: Buffer, prompt: string, options?: VisionOptions & {
        mimeType?: string;
    }): Promise<string>;
    caption(imageUrl: string, options?: VisionOptions): Promise<string>;
    ocr(imageUrl: string, options?: VisionOptions): Promise<string>;
    readChart(imageUrl: string, options?: VisionOptions): Promise<string>;
    detectObjects(imageUrl: string, options?: VisionOptions): Promise<string>;
    answer(imageUrl: string, question: string, options?: VisionOptions): Promise<string>;
    compareImages(imageUrl1: string, imageUrl2: string, prompt?: string, options?: VisionOptions): Promise<string>;
}

interface EmbedOptions {
    model?: string;
    input_type?: "query" | "passage";
    truncate?: "NONE" | "START" | "END";
}
interface RerankOptions {
    model?: string;
    truncate?: "NONE" | "END";
}
declare class EmbeddingsEndpoint {
    private client;
    constructor(client: FlockClient);
    embed(text: string, options?: EmbedOptions): Promise<number[]>;
    embedMany(texts: string[], options?: EmbedOptions): Promise<number[][]>;
    embedCode(code: string, options?: EmbedOptions): Promise<number[]>;
    embedQuery(query: string, options?: EmbedOptions): Promise<number[]>;
    rerank(query: string, passages: string[], options?: RerankOptions): Promise<Array<{
        text: string;
        score: number;
        index: number;
    }>>;
    cosineSimilarity(a: number[], b: number[]): number;
    findMostSimilar(query: string, candidates: string[], options?: EmbedOptions): Promise<{
        text: string;
        score: number;
        index: number;
    }[]>;
}

interface SafetyOptions {
    model?: string;
    threshold?: number;
}
interface PIIEntity {
    text: string;
    label: string;
    start: number;
    end: number;
    score: number;
}
interface PIIResult {
    entities: PIIEntity[];
    anonymized: string;
    hasPII: boolean;
}
interface SafetyResult {
    safe: boolean;
    violated: string[];
    scores: Record<string, number>;
    explanation?: string;
}
interface JailbreakResult {
    isJailbreak: boolean;
    confidence: number;
    explanation?: string;
}
declare class SafetyEndpoint {
    private client;
    constructor(client: FlockClient);
    checkContent(text: string, options?: SafetyOptions): Promise<SafetyResult>;
    checkMessages(messages: ChatMessage[], options?: SafetyOptions): Promise<SafetyResult>;
    detectPII(text: string, options?: SafetyOptions): Promise<PIIResult>;
    anonymize(text: string): Promise<string>;
    detectJailbreak(prompt: string, options?: SafetyOptions): Promise<JailbreakResult>;
    enforceTopicPolicy(message: string, allowedTopics: string[], options?: SafetyOptions): Promise<{
        allowed: boolean;
        reason?: string;
    }>;
    isSafe(text: string): Promise<boolean>;
}

interface ProteinFoldResult {
    pdb: string;
    mean_plddt?: number;
    model: string;
}
interface MoleculeGenerationOptions {
    numMolecules?: number;
    temperature?: number;
    iterations?: number;
    property?: "qed" | "sa" | "logp";
}
interface MoleculeResult {
    smiles: string;
    score?: number;
    properties?: {
        qed?: number;
        sa?: number;
        logp?: number;
        mw?: number;
    };
}
interface MSAResult {
    alignment: string;
    sequences: string[];
}
declare class BiologyEndpoint {
    private client;
    private bioUrl;
    constructor(client: FlockClient);
    foldProtein(sequence: string): Promise<ProteinFoldResult>;
    getProteinEmbedding(sequence: string): Promise<number[]>;
    generateMolecules(smiles: string, options?: MoleculeGenerationOptions): Promise<MoleculeResult[]>;
    optimizeMolecule(smiles: string, targetProperty?: "qed" | "sa" | "logp", options?: MoleculeGenerationOptions): Promise<MoleculeResult[]>;
    runMSA(sequence: string): Promise<MSAResult>;
}

interface TranscribeOptions {
    model?: string;
    language?: string;
    task?: "transcribe" | "translate";
}
interface TranscribeResult {
    text: string;
    segments?: Array<{
        start: number;
        end: number;
        text: string;
    }>;
    language?: string;
}
interface TTSOptions {
    model?: string;
    voice?: string;
    language?: string;
    sample_rate?: number;
}
declare class SpeechEndpoint {
    private client;
    constructor(client: FlockClient);
    transcribe(audioData: Buffer | Blob | string, options?: TranscribeOptions): Promise<TranscribeResult>;
    transcribeMultilingual(audioData: Buffer | Blob, options?: TranscribeOptions): Promise<TranscribeResult>;
    synthesize(text: string, options?: TTSOptions): Promise<Buffer>;
    zeroShotClone(text: string, referenceAudioUrl: string, options?: TTSOptions): Promise<Buffer>;
}

interface DocumentParseOptions {
    model?: string;
    mode?: "basic" | "advanced";
}
interface ParsedDocument {
    pages: Array<{
        page_number: number;
        text: string;
        tables: Array<{
            rows: string[][];
            headers?: string[];
        }>;
        images: Array<{
            caption?: string;
            bbox?: number[];
        }>;
    }>;
    full_text: string;
    metadata?: Record<string, unknown>;
}
interface OCRResult {
    text: string;
    confidence?: number;
    blocks?: Array<{
        text: string;
        bbox: number[];
        confidence: number;
    }>;
}
declare class DocumentEndpoint {
    private client;
    constructor(client: FlockClient);
    parse(pdfBase64: string, options?: DocumentParseOptions): Promise<ParsedDocument>;
    ocr(imageBase64: string, mimeType?: string): Promise<OCRResult>;
    extractTable(imageBase64: string, mimeType?: string): Promise<{
        headers: string[];
        rows: string[][];
    }>;
    chartToData(imageBase64: string): Promise<string>;
}

interface TranslateOptions {
    model?: string;
    source_language?: string;
}
interface TranslateResult {
    translated_text: string;
    source_language?: string;
    target_language: string;
    model: string;
}
declare const SUPPORTED_LANGUAGES: {
    readonly ENGLISH: "en";
    readonly SPANISH: "es";
    readonly FRENCH: "fr";
    readonly GERMAN: "de";
    readonly ITALIAN: "it";
    readonly PORTUGUESE: "pt";
    readonly RUSSIAN: "ru";
    readonly CHINESE: "zh";
    readonly JAPANESE: "ja";
    readonly KOREAN: "ko";
    readonly ARABIC: "ar";
    readonly HINDI: "hi";
    readonly DUTCH: "nl";
    readonly POLISH: "pl";
    readonly TURKISH: "tr";
    readonly VIETNAMESE: "vi";
    readonly INDONESIAN: "id";
    readonly THAI: "th";
    readonly SWEDISH: "sv";
    readonly NORWEGIAN: "no";
};
declare class TranslationEndpoint {
    private client;
    constructor(client: FlockClient);
    translate(text: string, targetLanguage: string, options?: TranslateOptions): Promise<TranslateResult>;
    translateBatch(texts: string[], targetLanguage: string, options?: TranslateOptions): Promise<TranslateResult[]>;
    detectLanguage(text: string): Promise<string>;
    translateToMany(text: string, targetLanguages: string[], options?: TranslateOptions): Promise<Record<string, string>>;
}

declare class Flock {
    readonly chat: ChatEndpoint;
    readonly vision: VisionEndpoint;
    readonly embeddings: EmbeddingsEndpoint;
    readonly safety: SafetyEndpoint;
    readonly biology: BiologyEndpoint;
    readonly speech: SpeechEndpoint;
    readonly document: DocumentEndpoint;
    readonly translation: TranslationEndpoint;
    private _client;
    constructor(config: FlockClientConfig | string);
    get client(): FlockClient;
}
declare function createFlockClient(config: FlockClientConfig | string): Flock;
/** @deprecated Use Flock instead. */
declare const Nim: typeof Flock;
/** @deprecated Use FlockClient instead. */
declare const NimClient: typeof FlockClient;
/** @deprecated Use createFlockClient instead. */
declare const createNimClient: typeof createFlockClient;

export { BiologyEndpoint, type BiologyModel, type ChatCompletionRequest, type ChatCompletionResponse, ChatEndpoint, type ChatMessage, type ChatModel, type ChatOptions, DocumentEndpoint, type DocumentModel, type DocumentParseOptions, type EmbedOptions, type EmbeddingModel, type EmbeddingRequest, type EmbeddingResponse, EmbeddingsEndpoint, Flock, FlockClient, type FlockClientConfig, FlockKeyPool, type FlockKeyStats, type JailbreakResult, Models, type MoleculeGenerationOptions, type MoleculeResult, Nim, NimClient, type NimError, type OCRResult, type PIIEntity, type PIIResult, type ParsedDocument, type ProteinFoldResult, type RerankModel, type RerankOptions, type RerankRequest, type RerankResponse, SUPPORTED_LANGUAGES, SafetyEndpoint, type SafetyModel, type SafetyOptions, type SafetyResult, SpeechEndpoint, type SpeechModel, type StreamChunk, type TTSOptions, type TranscribeOptions, type TranscribeResult, type TranslateOptions, type TranslateResult, TranslationEndpoint, VisionEndpoint, type VisionModel, type VisionOptions, createFlockClient, createNimClient, parseRetryAfterMs, splitKeys };
