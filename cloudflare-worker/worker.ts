import { checkIslandContentPolicy } from "../src/content_policy";
import { SCULPTOR_SYSTEM_PROMPT } from "../src/sculptor_prompt";
import { sanitizePlainText } from "../src/text_sanitize";
import { normalizeFactualDescription } from "../src/town_planner";
import { autoRepairBlueprintOverlaps } from "../src/voxel_audit";
import { normalizeAndGroundBlueprint } from "../src/voxel_dsl";

export interface WorkerEnv {
  GEMINI_API_KEY?: string;
  ALLOWED_ORIGINS?: string;
  GEMINI_SCULPT_MODEL?: string;
  GEMINI_MINIGAME_MODEL?: string;
}

const DEFAULT_SCULPT_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
] as const;

const DEFAULT_MINIGAME_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
] as const;

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

async function callGeminiRest(opts: {
  model: string;
  apiKey: string;
  systemPrompt: string;
  userParts: Record<string, unknown>[];
  temperature?: number;
  maxOutputTokens: number;
  thinkingBudget?: number;
  timeoutMs: number;
}): Promise<
  | { ok: true; rawText: string; blockReason: string | null }
  | { ok: false; httpStatus?: number; reason: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`;
    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: opts.maxOutputTokens,
      responseMimeType: "application/json",
    };
    if (typeof opts.temperature === "number") {
      generationConfig.temperature = opts.temperature;
    }
    if (typeof opts.thinkingBudget === "number" && opts.thinkingBudget >= 0) {
      generationConfig.thinkingConfig = {
        thinkingBudget: opts.thinkingBudget,
      };
    }

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
        generationConfig,
      }),
    });

    clearTimeout(timer);

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      return {
        ok: false,
        httpStatus: res.status,
        reason: `HTTP ${res.status}: ${redactKey(errBody.slice(0, 160), opts.apiKey)}`,
      };
    }

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
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      reason: controller.signal.aborted
        ? `Timeout(${opts.timeoutMs}ms)`
        : redactKey(err, opts.apiKey).slice(0, 140),
    };
  }
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
      ? `Extract the main foreground subject from this image guided by the user's description below and sculpt an ultra-detailed 3D micro-voxel miniature with rich parts and colors.\n<untrusted_user_description>\n${promptText}\n</untrusted_user_description>`
      : `Carefully inspect this uploaded image, isolate the main foreground object/creature/vehicle/building, and sculpt an ultra-detailed, faithful 3D micro-voxel miniature of it with animated parts.`
    : `Sculpt an ultra-detailed, iconic 3D micro-voxel miniature of the subject described below. Include rich surface greebles, harmonious custom palette, emissive details, and lifelike animated parts.\n<untrusted_user_description>\n${promptText}\n</untrusted_user_description>`;

  const userParts: Record<string, unknown>[] = [];
  if (imageBase64 && imageMimeType) {
    userParts.push({ inlineData: { mimeType: imageMimeType, data: imageBase64 } });
  }
  userParts.push({ text: userDirective });

  const models = parseModelOrder(env.GEMINI_SCULPT_MODEL, DEFAULT_SCULPT_MODELS);
  let lastError = "Model generation failed.";

  for (const model of models) {
    const res = await callGeminiRest({
      model,
      apiKey,
      systemPrompt: SCULPTOR_SYSTEM_PROMPT,
      userParts,
      temperature: 0.42,
      maxOutputTokens: 24_576,
      thinkingBudget: 512,
      timeoutMs: 32_000,
    });

    if (!res.ok) {
      lastError = res.reason;
      if (/API_KEY_INVALID|API key not valid|invalid api key/i.test(res.reason)) {
        return jsonResponse(request, env, 502, {
          ok: false,
          error: "Worker GEMINI_API_KEY secret is invalid — check your Gemini API key.",
        });
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
        lastError = "Missing ops in blueprint";
        continue;
      }

      const draft = normalizeAndGroundBlueprint(json, promptText || "Meadow Creation", {
        skipAutoRepair: true,
        contextText: promptText,
      });
      if (draft.stats.voxels < 25) {
        lastError = "Sculpted voxel count too small";
        continue;
      }

      const repaired = autoRepairBlueprintOverlaps(draft).blueprint;
      const finalBp = {
        ...repaired,
        description: normalizeFactualDescription(repaired.description),
      };
      const extractedSubject =
        sanitizePlainText(json.extractedSubject, 100, true) || finalBp.name;

      const outputBlocked = quickSafetyPrecheck(
        `${finalBp.name} ${finalBp.description} ${extractedSubject}`,
      );
      if (outputBlocked) {
        return jsonResponse(request, env, 422, { ok: false, unsafe: true, error: outputBlocked });
      }

      return jsonResponse(request, env, 200, {
        ok: true,
        blueprint: finalBp,
        extractedSubject,
        modelUsed: model,
      });
    } catch (err) {
      lastError = redactKey(err, apiKey).slice(0, 120);
    }
  }

  return jsonResponse(request, env, 502, {
    ok: false,
    error: "Could not sculpt that right now — please try again.",
    detail: lastError,
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
