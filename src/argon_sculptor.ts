import { checkIslandContentPolicy } from "./content_policy";
import {
  buildGeminiModelCascade,
  callGeminiWithFallbacks,
  DEFAULT_HYDROGEN_MODELS,
  extractJsonObject,
  type GeminiAttemptRecord,
  type GeminiCallMode,
} from "./gemini_models";
import { redactSecrets, safeLogError, safeLogWarn, sanitizePlainText } from "./security";
import type { VoxelBlueprint } from "./types";
import {
  auditBlueprintOverlaps,
  autoRepairBlueprintOverlaps,
  formatAuditFeedbackForArgon,
} from "./voxel_audit";
import { type CriticReviewResult, reviewBlueprintWithCritic } from "./voxel_critic";
import { normalizeAndGroundBlueprint } from "./voxel_dsl";
import { normalizeFactualDescription } from "./town_planner";
import { SCULPTOR_SYSTEM_PROMPT } from "./sculptor_prompt";

export { buildGeminiModelCascade, extractJsonObject };

export interface SculptRequest {
  prompt?: string;
  imageBase64?: string;
  imageMimeType?: string;
  initialCriticHint?: string;
  initialCriticRenderPngBase64?: string;
  overrideModels?: readonly string[];
  onPhase?: (phase: "reviewing" | "refining", round1Ms: number) => void;
}

export interface SculptTelemetry {
  round1Ms: number;
  totalMs: number;
  hadRefinementPass: boolean;
  usedFallback: boolean;
  criticAttempts?: number;
  criticScore?: number;
  criticApproved?: boolean;
  attempts?: GeminiAttemptRecord[];
}

export type SculptResult =
  | {
      ok: true;
      blueprint: VoxelBlueprint;
      extractedSubject: string;
      modelUsed: string;
      telemetry: SculptTelemetry;
    }
  | { ok: false; unsafe?: boolean; retryable?: boolean; error: string; errorDetail?: string };

const BLOCKED_PATTERNS = [
  /\b(nazi|swastika|hitler|kkk|child\s*porn|csam|rape|suicide\s*bomb|beheading|pornography|genitalia)\b/i,
];

export function quickSafetyPrecheck(text: string): string | null {
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

export async function callGeminiArgon(opts: {
  apiKey: string;
  mode?: GeminiCallMode;
  hydrogenModel?: string;
  hydrogenModels?: string | readonly string[];
  primaryModel?: string;
  fallbackModel?: string;
  overrideModels?: readonly string[];
  systemPrompt: string;
  userText: string;
  imageBase64?: string;
  imageMimeType?: string;
  extraImages?: { mimeType: string; data: string }[];
  temperature?: number;
  thinkingBudget?: number;
  maxOutputTokens?: number;
  maxCascadeMs?: number;
  validateJson?: (json: Record<string, unknown>) => string | null;
}): Promise<{
  json: Record<string, unknown>;
  modelUsed: string;
  attempts: GeminiAttemptRecord[];
}> {
  return callGeminiWithFallbacks(opts);
}

export async function sculptWithArgon(
  req: SculptRequest,
  apiKey: string,
  primaryModel?: string,
  fallbackModel?: string,
  hydrogenModel?: string,
  hydrogenModels?: string | readonly string[],
): Promise<SculptResult> {
  const promptText = sanitizePlainText(req.prompt, 480, true);
  const hasImage = Boolean(req.imageBase64 && req.imageMimeType);

  if (!promptText && !hasImage) {
    return { ok: false, error: "Describe something or drop an image to sculpt." };
  }

  if (promptText) {
    const blocked = quickSafetyPrecheck(promptText);
    if (blocked) return { ok: false, unsafe: true, error: blocked };
  }

  const baseDirective = hasImage
    ? promptText
      ? `Extract the main foreground subject from this image guided by the user's description below and sculpt an ultra-detailed 3D micro-voxel miniature with rich parts and colors.\n<untrusted_user_description>\n${promptText}\n</untrusted_user_description>`
      : `Carefully inspect this uploaded image, isolate the main foreground object/creature/vehicle/building, and sculpt an ultra-detailed, faithful 3D micro-voxel miniature of it with animated parts.`
    : `Sculpt an ultra-detailed, iconic 3D micro-voxel miniature of the subject described below. Include rich surface greebles, harmonious custom palette, emissive details, and lifelike animated parts.\n<untrusted_user_description>\n${promptText}\n</untrusted_user_description>`;

  const userDirective = req.initialCriticHint
    ? `${baseDirective}\n\nIMPORTANT PRIOR 3D REVIEWER FEEDBACK TO FIX IMMEDIATELY:\n${req.initialCriticHint}`
    : baseDirective;

  const validateSculptBlueprintJson = (candidateJson: Record<string, unknown>): string | null => {
    if (candidateJson.safe === false) return null;
    if (!Array.isArray(candidateJson.ops) || candidateJson.ops.length === 0) {
      return "Missing or empty voxel ops array";
    }
    const draft = normalizeAndGroundBlueprint(candidateJson, promptText || "Meadow Creation", {
      skipAutoRepair: true,
      contextText: promptText,
    });
    if (draft.stats.voxels < 25) {
      return `Rasterized blueprint had only ${draft.stats.voxels} voxels (need >= 25)`;
    }
    return null;
  };

  const tStart = Date.now();
  const expectedPrimary = (hydrogenModel?.trim() || DEFAULT_HYDROGEN_MODELS[0]).replace(
    /^models\//,
    "",
  );
  let first: Awaited<ReturnType<typeof callGeminiArgon>> | null = null;
  let lastRound1Err: unknown = null;
  for (let pass = 0; pass < 2; pass++) {
    try {
      first = await callGeminiArgon({
        apiKey,
        mode: "sculpt",
        hydrogenModel,
        hydrogenModels,
        primaryModel,
        fallbackModel,
        overrideModels: req.overrideModels,
        systemPrompt: SCULPTOR_SYSTEM_PROMPT,
        userText: userDirective,
        imageBase64: req.imageBase64,
        imageMimeType: req.imageMimeType,
        ...(req.initialCriticRenderPngBase64
          ? { extraImages: [{ mimeType: "image/png", data: req.initialCriticRenderPngBase64 }] }
          : {}),
        temperature: 0.42,
        thinkingBudget: 1024,
        maxOutputTokens: 32_768,
        validateJson: validateSculptBlueprintJson,
      });
      break;
    } catch (err) {
      lastRound1Err = err;
      safeLogWarn("sculpt_round1_pass_failed", err, [apiKey]);
      if (pass === 0) {
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
  }

  if (!first) {
    safeLogError("sculpt_round1_deferred_retry", lastRound1Err, [apiKey]);
    const redactedErr = redactSecrets(lastRound1Err, [apiKey]);
    const isAuthFailure = /API_KEY_INVALID|API key not valid|invalid api key|key not found/i.test(
      redactedErr,
    );
    if (isAuthFailure) {
      return {
        ok: false,
        retryable: false,
        error: "Server GEMINI_API_KEY secret is invalid or not attached yet — check Settings > Secrets.",
        errorDetail: redactedErr,
      };
    }
    return {
      ok: false,
      retryable: true,
      error: "Still sculpting — retrying automatically…",
      errorDetail: redactedErr,
    };
  }

  const round1Ms = Math.max(1, Date.now() - tStart);
  const allAttempts: GeminiAttemptRecord[] = [...first.attempts];
  let usedFallback = first.modelUsed !== expectedPrimary;
  let hadRefinementPass = false;
  let lastModelUsed = first.modelUsed;

  if (first.json.safe === false) {
    const reason =
      sanitizePlainText(first.json.safeReason, 140, true) ||
      "That creation doesn't fit our family-friendly shared meadow — please try something else.";
    return { ok: false, unsafe: true, error: reason };
  }

  interface CandidateAttempt {
    bp: VoxelBlueprint;
    rawJson: Record<string, unknown>;
    rawVoxels: number;
    overlapCells: number;
    critic: CriticReviewResult | null;
    attemptNumber: number;
  }

  const evaluateDraft = async (
    rawJson: Record<string, unknown>,
    fallbackTitle: string,
    attemptNumber: number,
  ): Promise<CandidateAttempt> => {
    const rawDraft = normalizeAndGroundBlueprint(rawJson, fallbackTitle, {
      skipAutoRepair: true,
      contextText: promptText,
    });
    const draftAudit = auditBlueprintOverlaps(rawDraft);
    const repairedBp = autoRepairBlueprintOverlaps(rawDraft).blueprint;

    let critic: CriticReviewResult | null = null;
    try {
      critic = await reviewBlueprintWithCritic({
        blueprint: repairedBp,
        promptText,
        userImageBase64: req.imageBase64,
        userImageMimeType: req.imageMimeType,
        apiKey,
        hydrogenModel,
        hydrogenModels,
        primaryModel,
        fallbackModel,
        overrideModels: req.overrideModels,
      });
    } catch (err) {
      safeLogError("voxel_critic_review", err, [apiKey]);
    }

    return {
      bp: repairedBp,
      rawJson,
      rawVoxels: rawDraft.stats.voxels,
      overlapCells: draftAudit.overlapCells,
      critic,
      attemptNumber,
    };
  };

  try {
    req.onPhase?.("reviewing", round1Ms);
  } catch {
    // ignore phase listener errors
  }

  let current = await evaluateDraft(first.json, promptText || "Meadow Creation", 1);
  const candidates: CandidateAttempt[] = [current];

  const MAX_CRITIC_RETRIES = 2;
  const MAX_LOOP_BUDGET_MS = 78_000;

  for (let retry = 1; retry <= MAX_CRITIC_RETRIES; retry++) {
    const needsVolume = current.rawVoxels < 160;
    const needsCollision = current.overlapCells >= 42;
    const criticRejected = current.critic ? !current.critic.approved : false;

    if (!needsVolume && !needsCollision && !criticRejected) {
      break;
    }
    if (Date.now() - tStart > MAX_LOOP_BUDGET_MS) {
      break;
    }

    hadRefinementPass = true;
    try {
      req.onPhase?.("refining", round1Ms);
    } catch {
      // ignore phase listener errors
    }

    const notes: string[] = [];
    if (current.critic && !current.critic.approved) {
      notes.push(
        [
          `3D MODEL REVIEWER AGENT REJECTED YOUR DRAFT #${current.attemptNumber} (Score ${current.critic.score}/10):`,
          `- Visual & Cross-Section Diagnosis: ${current.critic.diagnosis}`,
          `- Mandatory 3D Rebuild Instructions: ${current.critic.rebuildInstructions}`,
          `Look carefully at the attached 4-panel 3D render of your rejected draft (Panel 1: Iso Front, Panel 2: Iso Back, Panel 3: Front/Side Elevations, Panel 4: Top-Down). Re-sculpt the 3D geometry cleanly so it unmistakably matches the user's prompt with proper orientation, concave/open-top carving where needed, and zero leftover CSG roof/arch artifacts!`,
        ].join("\n"),
      );
    }
    if (needsVolume) {
      notes.push(
        `Your previous draft only produced ${current.rawVoxels} voxels, which is too sparse. Expand the body volume using roundedBox/sphere/hollowBox/cylinder across [-12..12] so it has 600 to 3000 crisp micro-voxels and at least 1 animated part in \`parts\`.`,
      );
    }
    if (needsCollision) {
      const draftAudit = auditBlueprintOverlaps(
        normalizeAndGroundBlueprint(current.rawJson, current.bp.name, {
          skipAutoRepair: true,
          contextText: promptText,
        }),
      );
      notes.push(
        `VOXEL Z-FIGHTING / COLLISION DETECTED IN ANIMATED PARTS:\n${formatAuditFeedbackForArgon(draftAudit)}\nReposition the colliding part pivots or adjust the base roof/wall ops so every animated part spins/swings with >= 1 full voxel of clearance.`,
      );
    }

    let retryRes: Awaited<ReturnType<typeof callGeminiArgon>>;
    try {
      retryRes = await callGeminiArgon({
        apiKey,
        mode: "sculpt",
        hydrogenModel,
        hydrogenModels,
        primaryModel,
        fallbackModel,
        overrideModels: req.overrideModels,
        systemPrompt: SCULPTOR_SYSTEM_PROMPT,
        userText: `${baseDirective}\n\nIMPORTANT 3D REVIEWER & ORCHESTRATOR REBUILD DIRECTIVE (Attempt ${retry + 1}):\n${notes.join("\n\n")}\n\nPrevious rejected JSON (rewrite/fix ops & geometry completely where needed):\n${JSON.stringify(current.rawJson)}`,
        imageBase64: req.imageBase64,
        imageMimeType: req.imageMimeType,
        ...(current.critic?.contactSheetPngBase64
          ? { extraImages: [{ mimeType: "image/png", data: current.critic.contactSheetPngBase64 }] }
          : {}),
        temperature: 0.35,
        thinkingBudget: 1536,
        maxOutputTokens: 40_960,
        validateJson: validateSculptBlueprintJson,
      });
    } catch (retryErr) {
      // Never discard a valid Round-1 3D creation if a Round-2 refinement pass encounters an upstream outage
      safeLogWarn("sculpt_refinement_degraded_to_round1", retryErr, [apiKey]);
      break;
    }

    allAttempts.push(...retryRes.attempts);
    lastModelUsed = retryRes.modelUsed;
    if (retryRes.modelUsed !== expectedPrimary) {
      usedFallback = true;
    }
    if (retryRes.json.safe === false) {
      return { ok: false, unsafe: true, error: "Please try creating something family-friendly." };
    }

    try {
      req.onPhase?.("reviewing", round1Ms);
    } catch {
      // ignore
    }

    current = await evaluateDraft(retryRes.json, current.bp.name, retry + 1);
    candidates.push(current);
  }

  // Pick the strongest verified blueprint across attempts (approved first, then highest critic score, then voxel richness)
  const validCandidates = candidates.filter((c) => c.bp.stats.voxels >= 25);
  if (validCandidates.length === 0) {
    return {
      ok: false,
      retryable: true,
      error: "Still sculpting — retrying automatically…",
      errorDetail: "zero_voxel_candidates",
    };
  }

  validCandidates.sort((a, b) => {
    const aApp = a.critic?.approved ? 1 : 0;
    const bApp = b.critic?.approved ? 1 : 0;
    if (aApp !== bApp) return bApp - aApp;
    const aScore = a.critic?.score ?? 6;
    const bScore = b.critic?.score ?? 6;
    if (aScore !== bScore) return bScore - aScore;
    return b.attemptNumber - a.attemptNumber;
  });

  const winner = validCandidates[0];
  const bp: VoxelBlueprint = {
    ...winner.bp,
    description: normalizeFactualDescription(winner.bp.description),
    ...(winner.critic
      ? {
          criticReview: {
            approved: winner.critic.approved,
            score: winner.critic.score,
            attempts: candidates.length,
            summary: winner.critic.diagnosis,
            reviewedAt: Date.now(),
          },
        }
      : {}),
  };

  const extractedSubject =
    sanitizePlainText(winner.rawJson.extractedSubject ?? first.json.extractedSubject, 100, true) ||
    bp.name;

  const outputBlocked = quickSafetyPrecheck(`${bp.name} ${bp.description} ${extractedSubject}`);
  if (outputBlocked) {
    return { ok: false, unsafe: true, error: outputBlocked };
  }

  const totalMs = Math.max(round1Ms, Date.now() - tStart);

  return {
    ok: true,
    blueprint: bp,
    extractedSubject,
    modelUsed: lastModelUsed,
    telemetry: {
      round1Ms,
      totalMs,
      hadRefinementPass,
      usedFallback,
      criticAttempts: candidates.length,
      criticScore: winner.critic?.score,
      criticApproved: winner.critic?.approved,
      attempts: allAttempts,
    },
  };
}

export const sculptWithHydrogen = sculptWithArgon;
