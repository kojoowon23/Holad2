import type { User } from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Timestamp,
} from "firebase/firestore";
import { db, handleFirestoreError, OperationType } from "./firebase_client";
import { sanitizePlainText } from "./text_sanitize";

const PRESENCE_COLLECTION = "presence";
const POSE_WRITE_INTERVAL_MS = 650;
const HEARTBEAT_MS = 18_000;
const STALE_PEER_MS = 65_000;

export interface FirebaseMultiplayerOptions {
  getLocalPose?: () => Record<string, unknown> | undefined;
  getLocalProfile?: () => Record<string, unknown> | undefined;
  onWelcome?: (msg: { selfId: string | null; onlineCount: number; players: unknown[] }) => void;
  onPeerJoin?: (player: Record<string, unknown>, msg: { onlineCount: number }) => void;
  onPeerPose?: (poseMsg: Record<string, unknown>) => void;
  onPeerProfile?: (profileMsg: Record<string, unknown>) => void;
  onPeerEmote?: (emoteMsg: Record<string, unknown>) => void;
  onPeerLeave?: (id: string, msg: { onlineCount: number }) => void;
  onOnlineCountChange?: (count: number) => void;
}

function toMillis(ts: unknown): number {
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (ts && typeof ts === "object" && typeof (ts as Timestamp).toMillis === "function") {
    return (ts as Timestamp).toMillis();
  }
  return 0;
}

function clampRound(val: unknown, min: number, max: number, scale: number, fallback = 0): number {
  if (typeof val !== "number" || !Number.isFinite(val)) return fallback;
  const clamped = Math.max(min, Math.min(max, val));
  const rounded = Math.round(clamped * scale) / scale;
  return rounded === 0 ? 0 : rounded;
}

function normalizePose(raw: Record<string, unknown> | undefined) {
  const src = raw && typeof raw === "object" ? raw : {};
  const validAnims = new Set(["idle", "walk", "run", "jump", "ride", "sit", "wave"]);
  const anim = typeof src.anim === "string" && validAnims.has(src.anim) ? src.anim : "idle";
  return {
    mode: src.mode === "aerial" ? "aerial" : "walk",
    x: clampRound(src.x, -240, 240, 1000, 0),
    y: clampRound(src.y, -20, 600, 1000, 0),
    z: clampRound(src.z, -240, 240, 1000, 0),
    yaw: clampRound(src.yaw, -6.29, 6.29, 1000, 0),
    pitch: clampRound(src.pitch, -1.6, 1.6, 1000, 0),
    vx: clampRound(src.vx, -25, 25, 100, 0),
    vz: clampRound(src.vz, -25, 25, 100, 0),
    anim,
    ride: typeof src.ride === "string" && src.ride.trim() ? src.ride.trim().slice(0, 48) : null,
    seat:
      typeof src.seat === "number" && Number.isFinite(src.seat)
        ? Math.max(0, Math.min(3, Math.trunc(src.seat)))
        : 0,
    room: typeof src.room === "string" && src.room.trim() ? src.room.trim().slice(0, 48) : null,
  };
}

function normalizeProfile(raw: Record<string, unknown> | undefined, fallbackName = "Explorer") {
  const src = raw && typeof raw === "object" ? raw : {};
  const rawApp =
    src.appearance && typeof src.appearance === "object" ? (src.appearance as Record<string, unknown>) : src;
  const name = sanitizePlainText(src.name ?? rawApp.name ?? fallbackName, 24) || fallbackName;
  const keys = [
    "skin",
    "hairStyle",
    "hairColor",
    "hatStyle",
    "hatColor",
    "eyeStyle",
    "accessory",
    "accessoryColor",
    "topStyle",
    "topColor",
    "bottomStyle",
    "bottomColor",
    "shoeColor",
  ];
  const appearance: Record<string, string> = {};
  for (const k of keys) {
    if (typeof rawApp[k] === "string" && rawApp[k].trim()) {
      appearance[k] = rawApp[k].trim().slice(0, 24);
    }
  }
  return { name, appearance };
}

export function createFirebaseMultiplayerClient(options: FirebaseMultiplayerOptions = {}) {
  let currentUser: User | null = null;
  let disposed = false;
  let docExistsInDb: boolean | null = null;
  let lastWriteAt = 0;
  let lastPoseSig = "";
  let lastEmoteKind: string | null = null;
  let lastEmoteAt = 0;
  let onlineCount = 1;
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let unsubPresence: (() => void) | null = null;

  const knownPeers = new Map<string, { emoteAt: number; name: string; appearanceSig: string }>();

  function emitOnlineCount(count: number) {
    const clean = Math.max(1, count);
    if (clean !== onlineCount) {
      onlineCount = clean;
      options.onOnlineCountChange?.(onlineCount);
    }
  }

  function startPresenceListener() {
    if (unsubPresence) return;
    const q = query(
      collection(db, PRESENCE_COLLECTION),
      where("visibility", "==", "public"),
      limit(30),
    );
    unsubPresence = onSnapshot(
      q,
      (snapshot) => {
        const now = Date.now();
        const selfUid = currentUser?.uid ?? null;
        const activeIds = new Set<string>();
        const initialPlayers: Record<string, unknown>[] = [];
        let activeCount = 0;

        snapshot.forEach((docSnap) => {
          const d = docSnap.data() as Record<string, unknown>;
          const uid = typeof d.uid === "string" ? d.uid : docSnap.id;
          const updatedAt = toMillis(d.updatedAt);
          if (updatedAt > 0 && now - updatedAt > STALE_PEER_MS) {
            return;
          }
          activeCount += 1;
          if (selfUid && uid === selfUid) return;
          activeIds.add(uid);

          const playerObj: Record<string, unknown> = {
            id: uid,
            name: typeof d.name === "string" ? d.name : "Explorer",
            appearance: d.appearance && typeof d.appearance === "object" ? d.appearance : {},
            mode: d.mode === "aerial" ? "aerial" : "walk",
            x: typeof d.x === "number" ? d.x : 0,
            y: typeof d.y === "number" ? d.y : 0,
            z: typeof d.z === "number" ? d.z : 0,
            yaw: typeof d.yaw === "number" ? d.yaw : 0,
            pitch: typeof d.pitch === "number" ? d.pitch : 0,
            vx: typeof d.vx === "number" ? d.vx : 0,
            vz: typeof d.vz === "number" ? d.vz : 0,
            anim: typeof d.anim === "string" ? d.anim : "idle",
            ride: typeof d.ride === "string" ? d.ride : null,
            seat: typeof d.seat === "number" ? d.seat : 0,
            room: typeof d.room === "string" ? d.room : null,
          };

          const prev = knownPeers.get(uid);
          const appSig = JSON.stringify(playerObj.appearance);
          const emoteAt = typeof d.emoteAt === "number" ? d.emoteAt : 0;
          const emoteKind = typeof d.emote === "string" ? d.emote : null;

          if (!prev) {
            knownPeers.set(uid, {
              emoteAt,
              name: String(playerObj.name),
              appearanceSig: appSig,
            });
            initialPlayers.push(playerObj);
            options.onPeerJoin?.(playerObj, { onlineCount: Math.max(1, activeCount) });
          } else {
            options.onPeerPose?.(playerObj);
            if (prev.name !== playerObj.name || prev.appearanceSig !== appSig) {
              prev.name = String(playerObj.name);
              prev.appearanceSig = appSig;
              options.onPeerProfile?.({
                id: uid,
                name: playerObj.name,
                appearance: playerObj.appearance,
              });
            }
            if (emoteKind && emoteAt > prev.emoteAt && now - emoteAt < 10_000) {
              prev.emoteAt = emoteAt;
              options.onPeerEmote?.({ id: uid, kind: emoteKind });
            }
          }
        });

        for (const [peerId] of [...knownPeers.entries()]) {
          if (!activeIds.has(peerId)) {
            knownPeers.delete(peerId);
            options.onPeerLeave?.(peerId, { onlineCount: Math.max(1, activeCount) });
          }
        }

        emitOnlineCount(Math.max(1, activeCount));
        if (initialPlayers.length > 0 && selfUid) {
          options.onWelcome?.({
            selfId: selfUid,
            onlineCount: Math.max(1, activeCount),
            players: initialPlayers,
          });
        }
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, PRESENCE_COLLECTION);
      },
    );
  }

  async function writePresence(force = false) {
    if (disposed || !currentUser || !currentUser.emailVerified) return;
    const now = Date.now();
    const pose = normalizePose(options.getLocalPose?.());
    const profile = normalizeProfile(
      options.getLocalProfile?.(),
      currentUser.displayName?.slice(0, 24) || "Explorer",
    );
    const sig = JSON.stringify({ pose, profile, lastEmoteAt });

    if (!force && docExistsInDb === true) {
      const elapsed = now - lastWriteAt;
      if (sig === lastPoseSig && elapsed < HEARTBEAT_MS) return;
      if (sig !== lastPoseSig && elapsed < POSE_WRITE_INTERVAL_MS) return;
    }

    lastWriteAt = now;
    lastPoseSig = sig;

    const uid = currentUser.uid;
    const ref = doc(db, PRESENCE_COLLECTION, uid);
    const mutableFields = {
      name: profile.name,
      appearance: profile.appearance,
      ...pose,
      emote: lastEmoteKind,
      emoteAt: lastEmoteAt,
      updatedAt: serverTimestamp(),
    };

    try {
      if (docExistsInDb === null) {
        const snap = await getDoc(ref);
        docExistsInDb = snap.exists();
      }
      if (docExistsInDb) {
        try {
          await updateDoc(ref, mutableFields);
        } catch (updErr) {
          const code = (updErr as { code?: string })?.code;
          if (code === "not-found") {
            docExistsInDb = false;
            await setDoc(ref, {
              uid,
              visibility: "public",
              ...mutableFields,
              createdAt: serverTimestamp(),
            });
            docExistsInDb = true;
          } else {
            throw updErr;
          }
        }
      } else {
        await setDoc(ref, {
          uid,
          visibility: "public",
          ...mutableFields,
          createdAt: serverTimestamp(),
        });
        docExistsInDb = true;
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `${PRESENCE_COLLECTION}/${uid}`);
    }
  }

  async function removeOwnPresence(uid: string) {
    try {
      await deleteDoc(doc(db, PRESENCE_COLLECTION, uid));
      if (currentUser?.uid === uid) {
        docExistsInDb = false;
      }
    } catch {
      // Ignore cleanup permission/offline errors on page unload
    }
  }

  function setUser(user: User | null) {
    const prevUid = currentUser?.uid ?? null;
    if (prevUid && (!user || user.uid !== prevUid)) {
      docExistsInDb = null;
      void removeOwnPresence(prevUid);
    } else if (!prevUid && user) {
      docExistsInDb = null;
    }
    currentUser = user;
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
    if (user && user.emailVerified && !disposed) {
      void writePresence(true);
      syncTimer = setInterval(() => {
        void writePresence(false);
      }, POSE_WRITE_INTERVAL_MS);
    }
  }

  startPresenceListener();

  const onUnload = () => {
    if (currentUser) {
      void removeOwnPresence(currentUser.uid);
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", onUnload);
    window.addEventListener("beforeunload", onUnload);
  }

  return {
    setUser,
    sendProfile(_profile?: Record<string, unknown>) {
      void writePresence(true);
      return true;
    },
    sendEmote(kind: string) {
      if (kind !== "wave" && kind !== "jump" && kind !== "cheer") return false;
      lastEmoteKind = kind;
      lastEmoteAt = Date.now();
      void writePresence(true);
      return true;
    },
    forcePoseSync() {
      void writePresence(true);
      return true;
    },
    getSelfId: () => currentUser?.uid ?? null,
    getOnlineCount: () => onlineCount,
    getTransport: () => "firestore",
    isConnected: () => Boolean(currentUser),
    dispose() {
      if (disposed) return;
      disposed = true;
      if (syncTimer) clearInterval(syncTimer);
      unsubPresence?.();
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", onUnload);
        window.removeEventListener("beforeunload", onUnload);
      }
      if (currentUser) {
        void removeOwnPresence(currentUser.uid);
      }
    },
  };
}
