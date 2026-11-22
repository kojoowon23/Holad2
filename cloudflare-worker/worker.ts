import { checkIslandContentPolicy } from "../src/content_policy";
import { SCULPTOR_SYSTEM_PROMPT } from "../src/sculptor_prompt";
import { sanitizePlainText } from "../src/text_sanitize";

export interface WorkerEnv {
  GEMINI_API_KEY?: string;
  ALLOWED_ORIGINS?: string;
  GEMINI_SCULPT_MODEL?: string;
  GEMINI_MINIGAME_MODEL?: string;
}

const DEFAULT_SCULPT_MODELS = [
  "hydrogen-l",
  "gemini-4-hydrogen",
  "gemini-4-argon",
  "gemini-3.8-flash",
  "gemini-3.1-pro-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-3.1-flash-lite",
] as const;

const DEFAULT_MINIGAME_MODELS = [
  "gemini-3.1-flash-lite",
  "gemini-3.8-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
] as const;

const HYDROGEN_OR_MODERN_RE = /^(?:hydrogen|gemini-(?:[0-9.]+-hydrogen|4|3\.8))(?:$|[-_.])/i;
const OMIT_TEMP_MODEL_RE = /^gemini-(?:4|3\.8)(?:$|[-_.])/i;

const BLOCKED_PATTERNS = [
  /\b(nazi|swastika|hitler|kkk|child\s*porn|csam|rape|suicide\s*bomb|beheading|pornography|genitalia)\b/i,
];

function quickSafetyPrecheck(text: string): string | null {
  for (const re of BLOCKED_PATTERNS) {
    if (re.test(text)) {
      return "Let's keep our shared meadow welcoming and family-friendly — please try creating something else.";
    }
  }
  const policy = checkIslandContentPolicy(text);
  if (!policy.allowed) {
    return policy.reason;
  }
  return null;
}

function redactKey(input: unknown, apiKey: string): string {
  const raw = input instanceof Error ? input.message : String(input ?? "");
  if (!apiKey) return raw;
  return raw.split(apiKey).join("[REDACTED]");
}

function isAllowedCorsOrigin(origin: string, env: WorkerEnv): boolean {
  if (!origin) return false;
  const configured = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (configured.length === 0) {
    return true;
  }
  if (configured.includes("*")) return true;
  if (configured.includes(origin)) return true;

  try {
    const parsed = new URL(origin);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function buildCorsHeaders(request: Request, env: WorkerEnv): Record<string, string> {
  const origin = request.headers.get("origin") || "";
  const allowOrigin =
    origin && isAllowedCorsOrigin(origin, env) ? origin : env.ALLOWED_ORIGINS ? "" : "*";

  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-meadow-client",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (allowOrigin) {
    headers["Access-Control-Allow-Origin"] = allowOrigin;
  }
  return headers;
}

function jsonResponse(
  request: Request,
  env: WorkerEnv,
  status: number,
  body: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...buildCorsHeaders(request, env),
    },
  });
}

function repairJsonCandidate(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  const len = input.length;

  for (let i = 0; i < len; i++) {
    const ch = input[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else out += `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
      out += ch;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === "/" && input[i + 1] === "/") {
      i += 2;
      while (i < len && input[i] !== "\n") i++;
      if (i < len) out += "\n";
      continue;
    }

    if (ch === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < len && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 1;
      continue;
    }

    if (ch === "+" && i + 1 < len && input[i + 1] >= "0" && input[i + 1] <= "9") {
      const prevNonWs = out.trimEnd().slice(-1);
      if (prevNonWs === ":" || prevNonWs === "[" || prevNonWs === ",") {
        continue;
      }
    }

    out += ch;
  }

  return out
    .replace(/\b(?:-?Infinity|NaN)\b/g, "0")
    .replace(/,\s*([}\]])/g, "$1");
}

function extractBalancedObjectSlices(text: string): string[] {
  const slices: string[] = [];
  const len = text.length;

  for (let start = 0; start < len; start++) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < len; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          slices.push(text.slice(start, i + 1));
          start = i;
          break;
        }
      }
    }
  }

  slices.sort((a, b) => b.length - a.length);
  return slices;
}

function extractJsonObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  const text = String(raw ?? "").trim();
  const stripped = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
  const firstStart = stripped.indexOf("{");
  const lastEnd = stripped.lastIndexOf("}");
  if (firstStart === -1 || lastEnd <= firstStart) {
    throw new Error("Model response did not contain a JSON object");
  }

  const candidates: string[] = [stripped.slice(firstStart, lastEnd + 1)];
  for (const balanced of extractBalancedObjectSlices(stripped)) {
    if (!candidates.includes(balanced)) {
      candidates.push(balanced);
    }
  }

  let lastErr: unknown = null;
  for (const slice of candidates) {
    try {
      const parsed = JSON.parse(slice);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (err) {
      lastErr = err;
    }
    try {
      const parsed = JSON.parse(repairJsonCandidate(slice));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("Failed to parse JSON object");
}

function parseModelOrder(configured: string | undefined, defaults: readonly string[]): string[] {
  const raw = [
    ...(configured
      ? configured
          .split(",")
          .map((m) => m.trim().replace(/^models\//, ""))
          .filter((m) => /^[a-zA-Z0-9._-]+$/.test(m))
      : []),
    ...defaults,
  ];
  return [...new Set(raw)];
}

async function discoverFallbackModels(
  apiKey: string,
  excludeModels: readonly string[],
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_500);
  try {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=250",
      {
        method: "GET",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "x-goog-api-key": apiKey,
        },
      },
    );
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      models?: { name?: string; supportedGenerationMethods?: string[] }[];
    };
    const skip = new Set(excludeModels);
    const out: string[] = [];
    for (const entry of data.models ?? []) {
      const id = String(entry?.name ?? "").trim().replace(/^models\//, "");
      if (!id || skip.has(id) || !/^[a-zA-Z0-9._-]+$/.test(id)) continue;
      const methods = entry?.supportedGenerationMethods;
      if (Array.isArray(methods) && methods.length > 0 && !methods.includes("generateContent")) {
        continue;
      }
      if (/(?:embedding|imagen|veo|lyria|aqa|tts|audio|image|robotics|computer-use|deep-research)/i.test(id)) {
        continue;
      }
      if (/^(?:gemini|hydrogen)/i.test(id)) {
        out.push(id);
      }
    }
    // Prefer flash / hydrogen text models first
    out.sort((a, b) => {
      const score = (m: string) =>
        /flash/i.test(m) ? 0 : /hydrogen/i.test(m) ? 1 : /pro/i.test(m) ? 2 : 3;
      return score(a) - score(b);
    });
    return out.slice(0, 5);
  } catch {
    clearTimeout(timer);
    return [];
  }
}

function consumeSseLine(
  rawLine: string,
  acc: { nonThought: string; all: string; blockReason: string | null; streamError: string | null },
): void {
  const line = rawLine.trim();
  if (!line.startsWith("data:")) return;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return;

  let ev: {
    error?: { code?: number; message?: string; status?: string };
    promptFeedback?: { blockReason?: string };
    candidates?: {
      content?: { parts?: { text?: string; thought?: boolean }[] };
    }[];
  };
  try {
    ev = JSON.parse(payload);
  } catch {
    return;
  }

  if (ev.error) {
    acc.streamError = `SSE ${ev.error.code ?? ""} ${ev.error.status ?? ""}: ${ev.error.message ?? "stream error"}`.trim();
    return;
  }
  if (ev.promptFeedback?.blockReason) {
    acc.blockReason = ev.promptFeedback.blockReason;
  }
  const parts = ev.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    if (typeof p.text === "string") {
      acc.all += p.text;
      if (!p.thought) acc.nonThought += p.text;
    }
  }
}

async function callGeminiSingleAttempt(opts: {
  model: string;
  apiKey: string;
  systemPrompt: string;
  userParts: Record<string, unknown>[];
  generationConfig: Record<string, unknown>;
  stream: boolean;
  firstByteTimeoutMs: number;
  totalTimeoutMs: number;
}): Promise<
  | { ok: true; rawText: string; blockReason: string | null }
  | { ok: false; httpStatus?: number; errorBody?: string; transportDropped?: boolean; reason: string }
> {
  const controller = new AbortController();
  let abortReason = `Timeout(${opts.totalTimeoutMs}ms)`;
  const totalTimer = setTimeout(() => {
    abortReason = `Timeout(${opts.totalTimeoutMs}ms)`;
    controller.abort();
  }, opts.totalTimeoutMs);

  let firstByteTimer: ReturnType<typeof setTimeout> | null = opts.stream
    ? setTimeout(() => {
        abortReason = `FirstByteTimeout(${opts.firstByteTimeoutMs}ms)`;
        controller.abort();
      }, opts.firstByteTimeoutMs)
    : null;

  const clearTimers = () => {
    clearTimeout(totalTimer);
    if (firstByteTimer !== null) {
      clearTimeout(firstByteTimer);
      firstByteTimer = null;
    }
  };

  let received200 = false;
  try {
    const action = opts.stream ? "streamGenerateContent?alt=sse" : "generateContent";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:${action}`;
    const res = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": opts.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.systemPrompt }] },
        contents: [{ role: "user", parts: opts.userParts }],
        generationConfig: opts.generationConfig,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      clearTimers();
      return {
        ok: false,
        httpStatus: res.status,
        errorBody: errBody,
        reason: `HTTP ${res.status}: ${redactKey(errBody.slice(0, 160), opts.apiKey)}`,
      };
    }

    received200 = true;

    if (!opts.stream) {
      clearTimers();
      const payload = (await res.json()) as {
        promptFeedback?: { blockReason?: string };
        candidates?: {
          content?: { parts?: { text?: string; thought?: boolean }[] };
        }[];
      };
      const parts = payload.candidates?.[0]?.content?.parts ?? [];
      let nonThought = "";
      let all = "";
      for (const p of parts) {
        if (typeof p.text === "string") {
          all += p.text;
          if (!p.thought) nonThought += p.text;
        }
      }
      return {
        ok: true,
        rawText: nonThought.trim() || all.trim(),
        blockReason: payload.promptFeedback?.blockReason ?? null,
      };
    }

    if (!res.body) {
      clearTimers();
      return { ok: false, transportDropped: true, reason: "Empty stream body" };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const acc = { nonThought: "", all: "", blockReason: null as string | null, streamError: null as string | null };
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (value && value.byteLength > 0) {
        if (firstByteTimer !== null) {
          clearTimeout(firstByteTimer);
          firstByteTimer = null;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          consumeSseLine(line, acc);
          if (acc.streamError) {
            await reader.cancel().catch(() => {});
            clearTimers();
            return { ok: false, reason: redactKey(acc.streamError, opts.apiKey).slice(0, 140) };
          }
        }
      }
      if (done) break;
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const line of buffer.split(/\r?\n/)) {
        consumeSseLine(line, acc);
      }
    }
    clearTimers();

    if (acc.streamError) {
      return { ok: false, reason: redactKey(acc.streamError, opts.apiKey).slice(0, 140) };
    }

    const rawText = acc.nonThought.trim() || acc.all.trim();
    if (!rawText && !acc.blockReason) {
      return { ok: false, transportDropped: true, reason: "Empty SSE text" };
    }

    return {
      ok: true,
      rawText,
      blockReason: acc.blockReason,
    };
  } catch (err) {
    clearTimers();
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      transportDropped: !aborted && received200,
      reason: aborted ? abortReason : redactKey(err, opts.apiKey).slice(0, 140),
    };
  }
}

async function callGeminiRest(opts: {
  model: string;
  apiKey: string;
  systemPrompt: string;
  userParts: Record<string, unknown>[];
  temperature?: number;
  maxOutputTokens: number;
  thinkingBudget?: number;
  timeoutMs: number;
  firstByteTimeoutMs?: number;
  useStream?: boolean;
}): Promise<
  | { ok: true; rawText: string; blockReason: string | null }
  | { ok: false; httpStatus?: number; reason: string }
> {
  const isModernOrHydrogen = HYDROGEN_OR_MODERN_RE.test(opts.model);
  let thinkingMode: "native" | "budget" | "none" = isModernOrHydrogen
    ? "native"
    : /^gemini-2\.5|^gemini-3/i.test(opts.model) &&
        typeof opts.thinkingBudget === "number" &&
        opts.thinkingBudget > 0
      ? "budget"
      : "none";
  let temperature = OMIT_TEMP_MODEL_RE.test(opts.model) ? undefined : opts.temperature;
  let maxOutputTokens = opts.maxOutputTokens;
  let useJsonMime = true;
  const stream = Boolean(opts.useStream);
  const firstByteMs = opts.firstByteTimeoutMs ?? Math.min(18_000, opts.timeoutMs);

  const buildGenCfg = (): Record<string, unknown> => {
    const cfg: Record<string, unknown> = {
      maxOutputTokens,
      ...(useJsonMime ? { responseMimeType: "application/json" } : {}),
    };
    if (typeof temperature === "number") cfg.temperature = temperature;
    if (thinkingMode === "native") cfg.thinkingConfig = { includeThoughts: true };
    else if (thinkingMode === "budget") cfg.thinkingConfig = { thinkingBudget: opts.thinkingBudget };
    return cfg;
  };

  let res = await callGeminiSingleAttempt({
    model: opts.model,
    apiKey: opts.apiKey,
    systemPrompt: opts.systemPrompt,
    userParts: opts.userParts,
    generationConfig: buildGenCfg(),
    stream,
    firstByteTimeoutMs: firstByteMs,
    totalTimeoutMs: opts.timeoutMs,
  });

  for (let compatPass = 0; compatPass < 3 && !res.ok && res.httpStatus === 400 && res.errorBody; compatPass++) {
    const errBody = res.errorBody;
    let adjusted = false;
    if (thinkingMode !== "none" && /thinking|thought/i.test(errBody)) {
      thinkingMode = "none";
      adjusted = true;
    } else if (temperature !== undefined && /temperature|sampling/i.test(errBody)) {
      temperature = undefined;
      adjusted = true;
    } else if (maxOutputTokens > 16_384 && /max_?output_?tokens|output.*token|token.*limit/i.test(errBody)) {
      maxOutputTokens = 16_384;
      adjusted = true;
    } else if (useJsonMime && /mime|json/i.test(errBody)) {
      useJsonMime = false;
      adjusted = true;
    }
    if (!adjusted) break;
    res = await callGeminiSingleAttempt({
      model: opts.model,
      apiKey: opts.apiKey,
      systemPrompt: opts.systemPrompt,
      userParts: opts.userParts,
      generationConfig: buildGenCfg(),
      stream,
      firstByteTimeoutMs: firstByteMs,
      totalTimeoutMs: opts.timeoutMs,
    });
  }

  if (!res.ok && stream && res.transportDropped) {
    res = await callGeminiSingleAttempt({
      model: opts.model,
      apiKey: opts.apiKey,
      systemPrompt: opts.systemPrompt,
      userParts: opts.userParts,
      generationConfig: buildGenCfg(),
      stream: false,
      firstByteTimeoutMs: opts.timeoutMs,
      totalTimeoutMs: Math.min(45_000, opts.timeoutMs),
    });
  }

  if (!res.ok) {
    return { ok: false, httpStatus: res.httpStatus, reason: res.reason };
  }
  return res;
}

async function handleBuild(request: Request, env: WorkerEnv): Promise<Response> {
  const apiKey = (env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    return jsonResponse(request, env, 503, {
      ok: false,
      error: "GEMINI_API_KEY secret is not configured on the Cloudflare Worker.",
    });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse(request, env, 400, { ok: false, error: "Invalid JSON request body." });
  }

  const promptText = sanitizePlainText(body.prompt, 480, true);
  let imageBase64: string | undefined;
  let imageMimeType: string | undefined;

  if (typeof body.imageDataUrl === "string" && body.imageDataUrl.trim()) {
    const m = body.imageDataUrl.trim().match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!m) {
      return jsonResponse(request, env, 400, {
        ok: false,
        error: "Please upload a PNG, JPEG, or WebP image.",
      });
    }
    const cleanB64 = m[2].replace(/\s+/g, "");
    if (cleanB64.length > 4_500_000) {
      return jsonResponse(request, env, 413, {
        ok: false,
        error: "Image is too large — please pick one under 3 MB.",
      });
    }
    imageMimeType = m[1].toLowerCase();
    imageBase64 = cleanB64;
  }

  if (!promptText && !imageBase64) {
    return jsonResponse(request, env, 400, {
      ok: false,
      error: "Describe something or drop an image to sculpt.",
    });
  }

  if (promptText) {
    const blocked = quickSafetyPrecheck(promptText);
    if (blocked) {
      return jsonResponse(request, env, 422, { ok: false, unsafe: true, error: blocked });
    }
  }

  const userDirective = imageBase64
    ? promptText
      ? `Extract the main foreground subject from this image guided by the user's description below and sculpt an ultra-detailed 3D micro-voxel miniature with 26-48 layered ops, sculpted curves, rich color palette, surface greebles, and animated parts.\n<untrusted_user_description>\n${promptText}\n</untrusted_user_description>`
      : `Carefully inspect this uploaded image, isolate the main foreground object/creature/vehicle/building, and sculpt an ultra-detailed, faithful 3D micro-voxel miniature with 26-48 layered ops, rich custom color palette, surface details, and animated parts.`
    : `Sculpt an ultra-detailed, iconic 3D micro-voxel miniature of the subject described below. Use 26-48 layered ops (combining roundedBox, sphere, dome, cylinder, ring, cone, arch, hollowBox, line, clear/carve), harmonious custom hex colors, crisp trim/surface greebles, emissive accents, and lifelike animated parts.\n<untrusted_user_description>\n${promptText}\n</untrusted_user_description>`;

  const userParts: Record<string, unknown>[] = [];
  if (imageBase64 && imageMimeType) {
    userParts.push({ inlineData: { mimeType: imageMimeType, data: imageBase64 } });
  }
  userParts.push({ text: userDirective });

  const scoreBlueprintRichness = (bp: Record<string, unknown>): { opsCount: number; score: number } => {
    const ops = Array.isArray(bp.ops) ? bp.ops : [];
    const parts = Array.isArray(bp.parts) ? bp.parts : [];
    const shapes = new Set<string>();
    const colors = new Set<string>();
    let hasCarve = false;
    for (const op of ops) {
      if (op && typeof op === "object") {
        const rec = op as Record<string, unknown>;
        const shape = String(rec.op ?? "");
        if (shape) shapes.add(shape);
        if (typeof rec.color === "string" && rec.color) colors.add(rec.color.toLowerCase());
        if (rec.op === "clear" || rec.carve === true) hasCarve = true;
      }
    }
    const score =
      Math.min(ops.length, 52) * 2 +
      shapes.size * 5 +
      Math.min(colors.size, 12) * 2 +
      Math.min(parts.length, 4) * 6 +
      (hasCarve ? 6 : 0);
    return { opsCount: ops.length, score };
  };

  const tStart = Date.now();
  const models = parseModelOrder(env.GEMINI_SCULPT_MODEL, DEFAULT_SCULPT_MODELS);
  const attempts: string[] = [];
  let saw404 = false;
  let discoveredTried = false;

  interface SculptCandidate {
    blueprint: Record<string, unknown>;
    extractedSubject: string;
    modelUsed: string;
    opsCount: number;
    score: number;
  }

  let best: SculptCandidate | null = null;

  for (let idx = 0; idx < models.length; idx++) {
    const model = models[idx];
    const isLite = /flash-lite/i.test(model);
    const res = await callGeminiRest({
      model,
      apiKey,
      systemPrompt: SCULPTOR_SYSTEM_PROMPT,
      userParts,
      temperature: 0.42,
      maxOutputTokens: 32_768,
      thinkingBudget: 1024,
      useStream: true,
      firstByteTimeoutMs: isLite ? 12_000 : 18_000,
      timeoutMs: isLite ? 28_000 : 54_000,
    });

    if (!res.ok) {
      attempts.push(`${model}: ${res.reason}`);
      if (res.httpStatus === 404) saw404 = true;
      if (/API_KEY_INVALID|API key not valid|invalid api key/i.test(res.reason)) {
        return jsonResponse(request, env, 502, {
          ok: false,
          error: "Worker GEMINI_API_KEY secret is invalid — check your Gemini API key.",
        });
      }
      if (!discoveredTried && saw404 && idx === models.length - 1) {
        discoveredTried = true;
        const extra = await discoverFallbackModels(apiKey, models);
        models.push(...extra);
      }
      continue;
    }

    if (
      !res.rawText &&
      res.blockReason &&
      /^(SAFETY|PROHIBITED_CONTENT|BLOCKLIST|IMAGE_SAFETY)$/i.test(res.blockReason)
    ) {
      return jsonResponse(request, env, 422, {
        ok: false,
        unsafe: true,
        error: "That creation doesn't fit our family-friendly shared meadow — please try something else.",
      });
    }

    try {
      const json = extractJsonObject(res.rawText);
      if (json.safe === false) {
        const reason =
          sanitizePlainText(json.safeReason, 140, true) ||
          "That creation doesn't fit our family-friendly shared meadow — please try something else.";
        return jsonResponse(request, env, 422, { ok: false, unsafe: true, error: reason });
      }

      if (!Array.isArray(json.ops) || json.ops.length === 0) {
        attempts.push(`${model}: Missing ops in blueprint`);
        continue;
      }

      const name = sanitizePlainText(json.name, 64) || "Meadow Creation";
      const description = sanitizePlainText(json.description, 200);
      const extractedSubject = sanitizePlainText(json.extractedSubject, 100, true) || name;

      const outputBlocked = quickSafetyPrecheck(`${name} ${description} ${extractedSubject}`);
      if (outputBlocked) {
        return jsonResponse(request, env, 422, { ok: false, unsafe: true, error: outputBlocked });
      }

      const { opsCount, score } = scoreBlueprintRichness(json);
      const cand: SculptCandidate = {
        blueprint: json,
        extractedSubject,
        modelUsed: model,
        opsCount,
        score,
      };
      if (!best || cand.score > best.score) {
        best = cand;
      }

      // If this draft is sparse (< 18 ops) and we still have time budget, run a 1-pass detail upgrade
      if (opsCount < 18 && Date.now() - tStart < 34_000) {
        const refineParts: Record<string, unknown>[] = [];
        if (imageBase64 && imageMimeType) {
          refineParts.push({ inlineData: { mimeType: imageMimeType, data: imageBase64 } });
        }
        refineParts.push({
          text: `${userDirective}\n\nUPGRADE THIS SPARSE DRAFT (${opsCount} ops -> 26-44 ops):\nKeep the subject identity and orientation, replace simple boxes with expressive sculpted primitives (roundedBox, sphere, dome, arch, cylinder, ring, cone, hollowBox, line, clear/carve), add architectural/organic surface trim, finer proportions, emissive details, and >=1 voxel clearance on animated parts.\n\nDraft JSON:\n${JSON.stringify(json)}`,
        });

        const refined = await callGeminiRest({
          model,
          apiKey,
          systemPrompt: SCULPTOR_SYSTEM_PROMPT,
          userParts: refineParts,
          temperature: 0.35,
          maxOutputTokens: 36_864,
          thinkingBudget: 1280,
          useStream: true,
          firstByteTimeoutMs: 16_000,
          timeoutMs: 42_000,
        });

        if (refined.ok && refined.rawText) {
          try {
            const refJson = extractJsonObject(refined.rawText);
            if (refJson.safe !== false && Array.isArray(refJson.ops) && refJson.ops.length > 0) {
              const refName = sanitizePlainText(refJson.name, 64) || name;
              const refDesc = sanitizePlainText(refJson.description, 200);
              const refSubj = sanitizePlainText(refJson.extractedSubject, 100, true) || extractedSubject;
              if (!quickSafetyPrecheck(`${refName} ${refDesc} ${refSubj}`)) {
                const refRich = scoreBlueprintRichness(refJson);
                if (refRich.score >= best.score) {
                  best = {
                    blueprint: refJson,
                    extractedSubject: refSubj,
                    modelUsed: `${model}-refined`,
                    opsCount: refRich.opsCount,
                    score: refRich.score,
                  };
                }
              }
            }
          } catch {
            // Keep initial candidate if refinement JSON parse fails
          }
        }
      }

      return jsonResponse(request, env, 200, {
        ok: true,
        blueprint: best.blueprint,
        extractedSubject: best.extractedSubject,
        modelUsed: best.modelUsed,
      });
    } catch (err) {
      attempts.push(`${model}: ${redactKey(err, apiKey).slice(0, 100)}`);
    }
  }

  if (best) {
    return jsonResponse(request, env, 200, {
      ok: true,
      blueprint: best.blueprint,
      extractedSubject: best.extractedSubject,
      modelUsed: best.modelUsed,
    });
  }

  const summary = attempts.join(" | ") || "Model generation failed.";
  return jsonResponse(request, env, 502, {
    ok: false,
    error: `Could not sculpt right now (${summary.slice(0, 160)})`,
    detail: summary,
  });
}

function validateMinigameBody(raw: Record<string, unknown>):
  | {
      ok: true;
      game: "tic_tac_toe" | "connect_four";
      board?: number[];
      grid?: number[][];
      creationName: string;
      validMoves: number[];
    }
  | { ok: false; error: string } {
  const game = raw.game;
  const creationName = sanitizePlainText(raw.creationName, 64);

  if (game === "tic_tac_toe") {
    if (!Array.isArray(raw.board) || raw.board.length !== 9) {
      return { ok: false, error: "Invalid tic_tac_toe board." };
    }
    const board: number[] = [];
    const validMoves: number[] = [];
    for (let i = 0; i < 9; i++) {
      const v = Number(raw.board[i]);
      if (v !== 0 && v !== 1 && v !== 2) {
        return { ok: false, error: "Invalid cell value in tic_tac_toe board." };
      }
      board.push(v);
      if (v === 0) validMoves.push(i);
    }
    if (validMoves.length === 0) return { ok: false, error: "No legal moves remaining." };
    return { ok: true, game: "tic_tac_toe", board, creationName, validMoves };
  }

  if (game === "connect_four") {
    if (!Array.isArray(raw.grid) || raw.grid.length !== 7) {
      return { ok: false, error: "Invalid connect_four grid." };
    }
    const grid: number[][] = [];
    const validMoves: number[] = [];
    for (let c = 0; c < 7; c++) {
      const colRaw = raw.grid[c];
      if (!Array.isArray(colRaw) || colRaw.length !== 6) {
        return { ok: false, error: "Invalid column in connect_four grid." };
      }
      const col: number[] = [];
      for (let r = 0; r < 6; r++) {
        const v = Number(colRaw[r]);
        if (v !== 0 && v !== 1 && v !== 2) {
          return { ok: false, error: "Invalid disc value in connect_four grid." };
        }
        col.push(v);
      }
      grid.push(col);
      if (col.indexOf(0) !== -1) validMoves.push(c);
    }
    if (validMoves.length === 0) return { ok: false, error: "No legal columns remaining." };
    return { ok: true, game: "connect_four", grid, creationName, validMoves };
  }

  return { ok: false, error: "Unsupported minigame kind." };
}

async function handleMinigameMove(request: Request, env: WorkerEnv): Promise<Response> {
  const apiKey = (env.GEMINI_API_KEY || "").trim();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse(request, env, 400, { ok: false, error: "Invalid JSON body." });
  }

  const parsed = validateMinigameBody(body);
  if (!parsed.ok) {
    return jsonResponse(request, env, 400, { ok: false, error: parsed.error });
  }

  const t0 = Date.now();
  const fallbackMove =
    parsed.validMoves[Math.floor(parsed.validMoves.length / 2)] ?? parsed.validMoves[0];

  if (!apiKey) {
    return jsonResponse(request, env, 200, {
      ok: true,
      move: fallbackMove,
      quip: "",
      modelUsed: "fallback-legal",
      latencyMs: 1,
    });
  }

  let systemPrompt = "";
  let userPrompt = "";
  if (parsed.game === "tic_tac_toe" && parsed.board) {
    const sym = (i: number) => (parsed.board![i] === 1 ? "X" : parsed.board![i] === 2 ? "O" : String(i));
    const ascii = [
      ` ${sym(0)} | ${sym(1)} | ${sym(2)} `,
      `---+---+---`,
      ` ${sym(3)} | ${sym(4)} | ${sym(5)} `,
      `---+---+---`,
      ` ${sym(6)} | ${sym(7)} | ${sym(8)} `,
    ].join("\n");
    systemPrompt = [
      "You are Gemini Flash-Lite, playing Naughts & Crosses (Tic-Tac-Toe) at a park game table.",
      "You play 'O'. Human plays 'X'. Win if possible, block human 2-in-a-row, else play best center/corner.",
      'Return ONLY JSON: {"move": <integer 0..8>, "quip": "<friendly 2-6 word remark>"}.',
    ].join("\n");
    userPrompt = `${parsed.creationName ? `Table: ${parsed.creationName}\n` : ""}Board:\n${ascii}\nLegal moves: [${parsed.validMoves.join(", ")}]`;
  } else if (parsed.grid) {
    const rowsAscii: string[] = [];
    for (let r = 5; r >= 0; r--) {
      const cells: string[] = [];
      for (let c = 0; c < 7; c++) {
        const v = parsed.grid[c][r];
        cells.push(v === 1 ? "X" : v === 2 ? "O" : ".");
      }
      rowsAscii.push(`r${r} | ${cells.join(" ")} |`);
    }
    rowsAscii.push("   +---------------+");
    rowsAscii.push("col  0 1 2 3 4 5 6");
    systemPrompt = [
      "You are Gemini Flash-Lite, playing 7x6 Connect Four.",
      "You play 'O'. Human plays 'X'. Win immediately if possible, block threats, prefer center columns.",
      'Return ONLY JSON: {"move": <integer 0..6>, "quip": "<friendly 2-6 word remark>"}.',
    ].join("\n");
    userPrompt = `${parsed.creationName ? `Table: ${parsed.creationName}\n` : ""}${rowsAscii.join("\n")}\nLegal columns: [${parsed.validMoves.join(", ")}]`;
  }

  const validSet = new Set(parsed.validMoves);
  const models = parseModelOrder(env.GEMINI_MINIGAME_MODEL, DEFAULT_MINIGAME_MODELS);

  for (const model of models) {
    const res = await callGeminiRest({
      model,
      apiKey,
      systemPrompt,
      userParts: [{ text: userPrompt }],
      temperature: 0.3,
      maxOutputTokens: 128,
      thinkingBudget: 0,
      timeoutMs: 4_500,
    });
    if (!res.ok) continue;
    try {
      const obj = extractJsonObject(res.rawText);
      const move = Math.trunc(Number(obj.move));
      if (validSet.has(move)) {
        return jsonResponse(request, env, 200, {
          ok: true,
          move,
          quip: sanitizePlainText(obj.quip, 56),
          modelUsed: model,
          latencyMs: Math.max(1, Date.now() - t0),
        });
      }
    } catch {
      // try next model
    }
  }

  return jsonResponse(request, env, 200, {
    ok: true,
    move: fallbackMove,
    quip: "",
    modelUsed: "fallback-legal",
    latencyMs: Math.max(1, Date.now() - t0),
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(request, env),
      });
    }

    const origin = request.headers.get("origin") || "";
    if (origin && !isAllowedCorsOrigin(origin, env)) {
      return jsonResponse(request, env, 403, { ok: false, error: "Origin not allowed." });
    }

    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/api/health")) {
      return jsonResponse(request, env, 200, {
        ok: true,
        service: "geminisland-ai-proxy",
        hasKey: Boolean((env.GEMINI_API_KEY || "").trim()),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/build") {
      return handleBuild(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/minigame-move") {
      return handleMinigameMove(request, env);
    }

    return jsonResponse(request, env, 404, { ok: false, error: "Not found" });
  },
};
