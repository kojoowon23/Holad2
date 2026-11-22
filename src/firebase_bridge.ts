import type { User } from "firebase/auth";
import {
  getCurrentUser,
  onAuthChange,
  signInWithGoogle,
  signOutUser,
} from "./firebase_client";
import { createFirebaseMultiplayerClient } from "./firebase_multiplayer";
import {
  buildBrowserBaseWorld,
  buildPlacedCreationFromBlueprint,
  saveCreationToFirestore,
  subscribeFirebaseCreations,
} from "./firebase_world";
import { resolveWorldLiveFeeds } from "./live_feeds";
import { resolveAiProxyUrl } from "./runtime_config";
import type { WorldCreation, WorldStateSnapshot } from "./types";

export interface RuntimeBridgeMode {
  useFirebase: boolean;
  aiProxyUrl: string;
}

export async function detectRuntimeMode(): Promise<RuntimeBridgeMode> {
  const aiProxyUrl = resolveAiProxyUrl();
  if (typeof window !== "undefined") {
    (window as unknown as { __geminIslandAiProxyUrl?: string }).__geminIslandAiProxyUrl = aiProxyUrl;
  }
  if (aiProxyUrl) {
    return { useFirebase: true, aiProxyUrl };
  }

  try {
    const res = await fetch("/api/world", { method: "GET" });
    const ct = res.headers.get("content-type") || "";
    if (res.ok && ct.includes("application/json")) {
      return { useFirebase: false, aiProxyUrl: "" };
    }
  } catch {
    // No Node backend reachable; fall back to static Firebase mode
  }

  return { useFirebase: true, aiProxyUrl: "" };
}

export function initFirebaseModeBridge(opts: {
  aiProxyUrl: string;
  authBtn: HTMLButtonElement | null;
  authLabelEl: HTMLElement | null;
  onWorldSnapshot: (snapshot: WorldStateSnapshot) => void;
  onLiveFeeds: (feeds: Record<string, unknown>) => void;
  onToast: (msg: string) => void;
  mpCallbacks: Parameters<typeof createFirebaseMultiplayerClient>[0];
}) {
  const baseWorld = buildBrowserBaseWorld();
  let communityCreations: { creation: WorldCreation; ownerId: string }[] = [];
  let currentUser: User | null = getCurrentUser();

  const mpClient = createFirebaseMultiplayerClient(opts.mpCallbacks);

  function emitMergedSnapshot() {
    const byId = new Map(baseWorld.creations.map((c) => [c.id, c]));
    let myCreationId: string | null = null;
    for (const rec of communityCreations) {
      byId.set(rec.creation.id, rec.creation);
      if (currentUser && rec.ownerId === currentUser.uid) {
        myCreationId = rec.creation.id;
      }
    }
    const mergedCreations = [...byId.values()];
    const snapshot: WorldStateSnapshot = {
      ...baseWorld,
      creations: mergedCreations,
      myCreationId,
    };
    opts.onWorldSnapshot(snapshot);
    return snapshot;
  }

  function renderAuthButton(user: User | null) {
    if (!opts.authBtn) return;
    opts.authBtn.hidden = false;
    if (user) {
      const label = (user.displayName || user.email || "Signed in").split(" ")[0].slice(0, 14);
      if (opts.authLabelEl) opts.authLabelEl.textContent = label;
      opts.authBtn.title = `Signed in as ${user.email || label} (click to sign out)`;
      opts.authBtn.classList.add("is-signed-in");
    } else {
      if (opts.authLabelEl) opts.authLabelEl.textContent = "Sign in";
      opts.authBtn.title = "Sign in with Google to save creations & play multiplayer";
      opts.authBtn.classList.remove("is-signed-in");
    }
  }

  onAuthChange((user) => {
    currentUser = user;
    renderAuthButton(user);
    mpClient.setUser(user);
    emitMergedSnapshot();
  });

  opts.authBtn?.addEventListener("click", async () => {
    try {
      if (currentUser) {
        await signOutUser();
        opts.onToast("Signed out.");
      } else {
        await signInWithGoogle();
        opts.onToast("Signed in with Google!");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Sign-in cancelled.";
      if (!/popup-closed-by-user|cancelled/i.test(msg)) {
        opts.onToast("Could not complete Google sign-in.");
      }
    }
  });

  // Load initial seed world immediately, then subscribe to live Firestore community creations
  const initialSnap = emitMergedSnapshot();
  void resolveWorldLiveFeeds(initialSnap.creations)
    .then((feeds) => opts.onLiveFeeds(feeds))
    .catch(() => {});

  const unsubCreations = subscribeFirebaseCreations((records) => {
    communityCreations = records;
    const snap = emitMergedSnapshot();
    void resolveWorldLiveFeeds(snap.creations)
      .then((feeds) => opts.onLiveFeeds(feeds))
      .catch(() => {});
  });

  async function ensureSignedInUser(): Promise<User | null> {
    if (currentUser) return currentUser;
    try {
      const user = await signInWithGoogle();
      currentUser = user;
      return user;
    } catch {
      return null;
    }
  }

  async function buildAndSaveViaProxy(params: {
    prompt: string;
    imageDataUrl?: string | null;
    x: number | null;
    z: number | null;
  }): Promise<
    | { ok: true; creation: WorldCreation; world: WorldStateSnapshot }
    | { ok: false; error: string }
  > {
    if (!opts.aiProxyUrl) {
      return {
        ok: false,
        error:
          "AI 중계 서버(Cloudflare Worker) 주소(VITE_AI_PROXY_URL)가 아직 설정되지 않았습니다.",
      };
    }

    const user = await ensureSignedInUser();
    if (!user) {
      return {
        ok: false,
        error: "섬에 창작물을 저장하려면 Google 로그인이 필요합니다.",
      };
    }

    const res = await fetch(`${opts.aiProxyUrl}/api/build`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-meadow-client": "1",
      },
      body: JSON.stringify({
        prompt: params.prompt,
        imageDataUrl: params.imageDataUrl || undefined,
        x: params.x,
        z: params.z,
      }),
    });

    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      blueprint?: Record<string, unknown>;
    } | null;

    if (!res.ok || !data?.ok || !data.blueprint) {
      return {
        ok: false,
        error: data?.error || "Could not sculpt that right now — please try again.",
      };
    }

    const currentSnap = emitMergedSnapshot();
    const creation = buildPlacedCreationFromBlueprint({
      blueprintRaw: data.blueprint,
      prompt: params.prompt,
      reqX: params.x,
      reqZ: params.z,
      world: currentSnap,
    });

    await saveCreationToFirestore(creation, user);
    communityCreations = [...communityCreations, { creation, ownerId: user.uid }];
    const updatedSnap = emitMergedSnapshot();

    return { ok: true, creation, world: updatedSnap };
  }

  async function refreshFeeds() {
    const snap = emitMergedSnapshot();
    try {
      const feeds = await resolveWorldLiveFeeds(snap.creations);
      opts.onLiveFeeds(feeds);
    } catch {
      // Ignore transient feed fetch issues
    }
  }

  return {
    mpClient,
    buildAndSaveViaProxy,
    refreshFeeds,
    ensureSignedInUser,
    dispose() {
      unsubCreations();
      mpClient.dispose();
    },
  };
}
