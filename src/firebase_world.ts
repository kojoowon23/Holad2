import type { User } from "firebase/auth";
import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
  type Timestamp,
} from "firebase/firestore";
import { filterWorldCollectionsByPolicy } from "./content_policy";
import { applyCuratedDistrictRelocations } from "./curated_district_relocations";
import { db, handleFirestoreError, OperationType } from "./firebase_client";
import { buildSeedWorld } from "./seed_world";
import { sanitizePlainText } from "./text_sanitize";
import {
  chooseSimCityPlot,
  computeIntelligentBuildingYaw,
  getIslandInlandMargin,
  normalizeFactualDescription,
} from "./town_planner";
import type {
  CreationBehavior,
  VoxelBlueprint,
  VoxelOp,
  WorldCreation,
  WorldStateSnapshot,
} from "./types";
import { autoRepairBlueprintOverlaps } from "./voxel_audit";
import { getCreationFootprintRadius, normalizeAndGroundBlueprint } from "./voxel_dsl";

const CREATIONS_COLLECTION = "creations";
const CITY_SIGN_POS: [number, number] = [0, 31];

function toMillis(ts: unknown, fallback = Date.now()): number {
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (ts && typeof ts === "object" && typeof (ts as Timestamp).toMillis === "function") {
    return (ts as Timestamp).toMillis();
  }
  return fallback;
}

function serializeOpsForFirestore(ops: VoxelOp[]): Record<string, unknown>[] {
  return ops.map((op) => {
    if (op.op === "voxels" && Array.isArray(op.list)) {
      return {
        op: "voxels",
        ...(op.mirrorX !== undefined ? { mirrorX: Boolean(op.mirrorX) } : {}),
        list: op.list.map((pt) => ({
          x: pt[0],
          y: pt[1],
          z: pt[2],
          color: pt[3],
          ...(pt[4] !== undefined ? { emit: pt[4] } : {}),
        })),
      };
    }
    return { ...op } as Record<string, unknown>;
  });
}

function deserializeOpsFromFirestore(rawOps: unknown): VoxelOp[] {
  if (!Array.isArray(rawOps)) return [];
  return rawOps.map((raw) => {
    const op = (raw && typeof raw === "object" ? { ...raw } : {}) as Record<string, unknown>;
    if (op.op === "voxels" && Array.isArray(op.list)) {
      return {
        op: "voxels",
        ...(op.mirrorX !== undefined ? { mirrorX: Boolean(op.mirrorX) } : {}),
        list: op.list.map((item) => {
          if (Array.isArray(item)) {
            return item as [number, number, number, string, number?];
          }
          const rec = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
          const tuple: [number, number, number, string, number?] = [
            Number(rec.x) || 0,
            Number(rec.y) || 0,
            Number(rec.z) || 0,
            typeof rec.color === "string" ? rec.color : "#888888",
          ];
          if (typeof rec.emit === "number" && Number.isFinite(rec.emit)) {
            tuple.push(rec.emit);
          }
          return tuple;
        }),
      } as VoxelOp;
    }
    return op as unknown as VoxelOp;
  });
}

function serializeBehaviorForFirestore(behavior: CreationBehavior): Record<string, unknown> {
  if (behavior.type === "vehicle_route") {
    return {
      ...behavior,
      waypoints: behavior.waypoints.map((pt) => ({ x: pt[0], z: pt[1] })),
    };
  }
  if (behavior.type === "wander") {
    return {
      ...behavior,
      ...(Array.isArray(behavior.targets)
        ? { targets: behavior.targets.map((pt) => ({ x: pt[0], z: pt[1] })) }
        : {}),
    };
  }
  if (behavior.type === "fly_circle") {
    return {
      ...behavior,
      ...(Array.isArray(behavior.waypoints)
        ? { waypoints: behavior.waypoints.map((pt) => ({ x: pt[0], y: pt[1], z: pt[2] })) }
        : {}),
    };
  }
  return { ...behavior } as Record<string, unknown>;
}

function deserializeBehaviorFromFirestore(raw: unknown): CreationBehavior {
  const rec = (raw && typeof raw === "object" ? { ...raw } : {}) as Record<string, unknown>;
  if (rec.type === "vehicle_route") {
    const waypointsRaw = Array.isArray(rec.waypoints) ? rec.waypoints : [];
    return {
      ...(rec as unknown as Extract<CreationBehavior, { type: "vehicle_route" }>),
      waypoints: waypointsRaw.map((pt) =>
        Array.isArray(pt)
          ? [Number(pt[0]) || 0, Number(pt[1]) || 0]
          : [Number((pt as Record<string, unknown>)?.x) || 0, Number((pt as Record<string, unknown>)?.z) || 0],
      ),
    };
  }
  if (rec.type === "wander") {
    const targetsRaw = Array.isArray(rec.targets) ? rec.targets : undefined;
    return {
      ...(rec as unknown as Extract<CreationBehavior, { type: "wander" }>),
      ...(targetsRaw
        ? {
            targets: targetsRaw.map((pt) =>
              Array.isArray(pt)
                ? [Number(pt[0]) || 0, Number(pt[1]) || 0]
                : [Number((pt as Record<string, unknown>)?.x) || 0, Number((pt as Record<string, unknown>)?.z) || 0],
            ),
          }
        : {}),
    };
  }
  if (rec.type === "fly_circle") {
    const wpRaw = Array.isArray(rec.waypoints) ? rec.waypoints : undefined;
    return {
      ...(rec as unknown as Extract<CreationBehavior, { type: "fly_circle" }>),
      ...(wpRaw
        ? {
            waypoints: wpRaw.map((pt) =>
              Array.isArray(pt)
                ? [Number(pt[0]) || 0, Number(pt[1]) || 0, Number(pt[2]) || 0]
                : [
                    Number((pt as Record<string, unknown>)?.x) || 0,
                    Number((pt as Record<string, unknown>)?.y) || 0,
                    Number((pt as Record<string, unknown>)?.z) || 0,
                  ],
            ),
          }
        : {}),
    };
  }
  if (rec.type === "water_float") {
    return rec as unknown as Extract<CreationBehavior, { type: "water_float" }>;
  }
  return {
    type: "landmark",
    facingYaw: typeof rec.facingYaw === "number" ? rec.facingYaw : 0,
    activity: typeof rec.activity === "string" ? rec.activity : "Placed on GeminIsland",
    statusLine: typeof rec.statusLine === "string" ? rec.statusLine : "Placed on GeminIsland",
  };
}

export function buildBrowserBaseWorld(): Omit<WorldStateSnapshot, "myCreationId"> {
  const seed = buildSeedWorld();
  applyCuratedDistrictRelocations({
    creations: seed.creations,
    paths: seed.paths,
    props: seed.props,
    terrainZones: seed.terrainZones,
    villagers: seed.villagers,
  });
  const filtered = filterWorldCollectionsByPolicy({
    creations: seed.creations,
    paths: seed.paths,
    props: seed.props,
  });
  return {
    ...seed,
    creations: filtered.creations,
    paths: filtered.paths,
    props: filtered.props,
  };
}

function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax;
  const vz = bz - az;
  const wx = px - ax;
  const wz = pz - az;
  const len2 = vx * vx + vz * vz;
  if (len2 < 0.001) return Math.hypot(px - ax, pz - az);
  const t = Math.max(0, Math.min(1, (wx * vx + wz * vz) / len2));
  return Math.hypot(px - (ax + t * vx), pz - (az + t * vz));
}

function isBrowserSpotClear(
  x: number,
  z: number,
  category: WorldCreation["category"],
  newRadius: number,
  world: Omit<WorldStateSnapshot, "myCreationId">,
  tightInfill = false,
): boolean {
  const coastalPad = tightInfill ? 1.8 : 2.6;
  if (getIslandInlandMargin(x, z) < newRadius + coastalPad) return false;
  const signPad = tightInfill ? 2.15 : 2.8;
  if (Math.hypot(x - CITY_SIGN_POS[0], z - CITY_SIGN_POS[1]) < newRadius + signPad) return false;

  const neighborPad = tightInfill ? 0.72 : 1.8;
  for (const c of world.creations) {
    if (c.category === "aircraft" || c.behavior.type === "fly_circle") continue;
    if (c.category === "watercraft" || c.behavior.type === "water_float") continue;
    const otherR = getCreationFootprintRadius(
      c.scaleClass,
      c.blueprint?.stats?.footprintX ?? 14,
      c.blueprint?.stats?.footprintZ ?? 14,
    );
    if (Math.hypot(x - c.x, z - c.z) < newRadius + otherR + neighborPad) return false;
  }

  if (category !== "watercraft") {
    const pondPad = tightInfill ? 0.85 : 1.4;
    for (const pr of world.props) {
      if (
        pr.kind === "pond" &&
        Math.hypot(x - pr.x, z - pr.z) < (pr.radius ?? 6.5) + newRadius + pondPad
      ) {
        return false;
      }
    }
  }

  if (category === "building" || category === "prop") {
    const roadClear = newRadius + (tightInfill ? 2.12 : 2.6);
    for (const p of world.paths) {
      if (p.kind !== "road") continue;
      for (let i = 0; i < p.points.length; i++) {
        const a = p.points[i];
        const b = p.points[(i + 1) % p.points.length];
        if (!p.closed && i === p.points.length - 1) break;
        if (distToSegment(x, z, a[0], a[1], b[0], b[1]) < roadClear) return false;
      }
    }
  }
  return true;
}

export function buildPlacedCreationFromBlueprint(opts: {
  blueprintRaw: Record<string, unknown>;
  prompt: string;
  reqX: number | null;
  reqZ: number | null;
  world: Omit<WorldStateSnapshot, "myCreationId">;
}): WorldCreation {
  const normalized = normalizeAndGroundBlueprint(
    opts.blueprintRaw,
    sanitizePlainText(opts.prompt, 48, true) || "Island Creation",
    { contextText: opts.prompt },
  );
  const bp: VoxelBlueprint = autoRepairBlueprintOverlaps(normalized).blueprint;
  const description = normalizeFactualDescription(bp.description);
  const newRadius = getCreationFootprintRadius(
    bp.scaleClass,
    bp.stats.footprintX,
    bp.stats.footprintZ,
  );
  const hasExplicitReq =
    typeof opts.reqX === "number" &&
    Number.isFinite(opts.reqX) &&
    typeof opts.reqZ === "number" &&
    Number.isFinite(opts.reqZ);

  const [x, z] = chooseSimCityPlot({
    reqX: opts.reqX,
    reqZ: opts.reqZ,
    category: bp.category,
    scaleClass: bp.scaleClass,
    newRadius,
    contextText: `${bp.name} ${description} ${opts.prompt}`,
    world: opts.world,
    isSpotClear: (tx, tz) =>
      isBrowserSpotClear(tx, tz, bp.category, newRadius, opts.world, hasExplicitReq),
  });

  const rand = Math.random().toString(36).slice(2, 8);
  const id = `cr-${Date.now().toString(36)}-${rand}`;

  let behavior: CreationBehavior;
  if (bp.category === "aircraft") {
    behavior = {
      type: "fly_circle",
      speed: 4.6,
      altitude: 13.5,
      centerX: x,
      centerZ: z,
      radius: 18,
      statusLine: description || `Cruising above GeminIsland`,
    };
  } else if (bp.category === "watercraft") {
    const pond = opts.world.props.find((p) => p.kind === "pond");
    const px = pond?.x ?? x;
    const pz = pond?.z ?? z;
    behavior = {
      type: "water_float",
      speed: 1.8,
      pondX: px,
      pondZ: pz,
      radius: Math.max(2.5, (pond?.radius ?? 5.5) * 0.55),
      statusLine: description || `Drifting gently on the lagoon`,
    };
  } else if (bp.category === "creature") {
    behavior = {
      type: "wander",
      style: "walk",
      speed: 1.6,
      homeX: x,
      homeZ: z,
      radius: 12,
      statusLine: description || `Exploring the meadow paths`,
    };
  } else if (bp.category === "vehicle") {
    const loopPath = opts.world.paths.find((p) => p.kind === "road" && p.points.length >= 4);
    if (loopPath) {
      behavior = {
        type: "vehicle_route",
        speed: 4.2,
        waypoints: loopPath.points.slice(0, 24),
        stops: [],
        loopMode: "loop",
        statusLine: description || `Driving along the island loop`,
      };
    } else {
      behavior = {
        type: "landmark",
        facingYaw: 0,
        activity: "Parked on the meadow",
        statusLine: description || `Parked by the town loop`,
      };
    }
  } else {
    behavior = {
      type: "landmark",
      facingYaw: 0,
      activity: description || "Welcoming visitors",
      statusLine: description || `Open on GeminIsland`,
    };
  }

  const creation: WorldCreation = {
    id,
    name: sanitizePlainText(bp.name, 64) || "Island Creation",
    description: sanitizePlainText(description, 280),
    creatorPrompt: sanitizePlainText(opts.prompt, 240, true) || undefined,
    category: bp.category,
    scaleClass: bp.scaleClass,
    x: Number(x.toFixed(2)),
    z: Number(z.toFixed(2)),
    yaw: 0,
    blueprint: { ...bp, description },
    behavior,
    liveFeed: bp.liveFeed ?? null,
    integratedLevel: 1,
    createdAt: Date.now(),
  };

  const smartYaw = computeIntelligentBuildingYaw(creation, opts.world.paths) ?? 0;
  creation.yaw = Number(smartYaw.toFixed(3));
  if (creation.behavior.type === "landmark") {
    creation.behavior.facingYaw = creation.yaw;
  }

  return creation;
}

export async function saveCreationToFirestore(creation: WorldCreation, user: User): Promise<void> {
  const path = `${CREATIONS_COLLECTION}/${creation.id}`;
  const safeId = creation.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 128) || `cr-${Date.now()}`;
  const safeOwnerName = sanitizePlainText(user.displayName || "Explorer", 32) || "Explorer";

  const docData = {
    id: safeId,
    ownerId: user.uid,
    ownerName: safeOwnerName,
    visibility: "public",
    name: sanitizePlainText(creation.name, 64) || "Island Creation",
    description: sanitizePlainText(creation.description, 280),
    category: creation.category,
    scaleClass: creation.scaleClass,
    x: Math.max(-220, Math.min(220, Number(creation.x) || 0)),
    z: Math.max(-220, Math.min(220, Number(creation.z) || 0)),
    yaw: Math.max(-6.3, Math.min(6.3, Number(creation.yaw) || 0)),
    integratedLevel: Math.max(0, Math.min(10, Math.trunc(creation.integratedLevel || 1))),
    blueprint: {
      version: 1,
      name: sanitizePlainText(creation.blueprint.name, 64) || "Island Creation",
      description: sanitizePlainText(creation.blueprint.description, 280),
      category: creation.blueprint.category,
      scaleClass: creation.blueprint.scaleClass,
      palette: creation.blueprint.palette,
      ops: serializeOpsForFirestore(creation.blueprint.ops.slice(0, 120)),
      parts: (creation.blueprint.parts || []).map((pt) => ({
        ...pt,
        ops: serializeOpsForFirestore(pt.ops || []),
      })),
      ...(creation.blueprint.interaction ? { interaction: creation.blueprint.interaction } : {}),
      ...(creation.blueprint.liveFeed ? { liveFeed: creation.blueprint.liveFeed } : {}),
      stats: creation.blueprint.stats,
    },
    behavior: serializeBehaviorForFirestore(creation.behavior),
    ...(creation.liveFeed ? { liveFeed: creation.liveFeed } : {}),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(doc(db, CREATIONS_COLLECTION, safeId), docData);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export interface FirebaseCreationRecord {
  creation: WorldCreation;
  ownerId: string;
}

export function subscribeFirebaseCreations(
  onUpdate: (records: FirebaseCreationRecord[]) => void,
): () => void {
  const q = query(collection(db, CREATIONS_COLLECTION), where("visibility", "==", "public"));
  return onSnapshot(
    q,
    (snapshot) => {
      const records: FirebaseCreationRecord[] = [];
      snapshot.forEach((docSnap) => {
        const d = docSnap.data() as Record<string, unknown>;
        const rawBp = (d.blueprint && typeof d.blueprint === "object" ? d.blueprint : {}) as Record<
          string,
          unknown
        >;
        const deserializedBp = {
          ...rawBp,
          ops: deserializeOpsFromFirestore(rawBp.ops),
          parts: Array.isArray(rawBp.parts)
            ? rawBp.parts.map((pt) => {
                const pRec = (pt && typeof pt === "object" ? { ...pt } : {}) as Record<string, unknown>;
                return {
                  ...pRec,
                  ops: deserializeOpsFromFirestore(pRec.ops),
                };
              })
            : [],
        };
        const bp = normalizeAndGroundBlueprint(
          deserializedBp,
          typeof d.name === "string" ? d.name : "Island Creation",
          { skipAutoRepair: true },
        );
        const creation: WorldCreation = {
          id: typeof d.id === "string" ? d.id : docSnap.id,
          name: typeof d.name === "string" ? d.name : bp.name,
          description: typeof d.description === "string" ? d.description : bp.description,
          category: bp.category,
          scaleClass: bp.scaleClass,
          x: typeof d.x === "number" ? d.x : 0,
          z: typeof d.z === "number" ? d.z : 0,
          yaw: typeof d.yaw === "number" ? d.yaw : 0,
          blueprint: bp,
          behavior: deserializeBehaviorFromFirestore(d.behavior),
          liveFeed: (d.liveFeed as WorldCreation["liveFeed"]) ?? bp.liveFeed ?? null,
          integratedLevel: typeof d.integratedLevel === "number" ? d.integratedLevel : 1,
          createdAt: toMillis(d.createdAt),
        };
        records.push({
          creation,
          ownerId: typeof d.ownerId === "string" ? d.ownerId : "",
        });
      });
      records.sort((a, b) => a.creation.createdAt - b.creation.createdAt);
      onUpdate(records);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, CREATIONS_COLLECTION);
    },
  );
}
