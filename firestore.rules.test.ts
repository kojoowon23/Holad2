// Security rule assertion matrix corresponding to security_spec.md ("Dirty Dozen").
// Intended for verification against the Firebase Rules Emulator when running security tests.

export interface SecurityTestCase {
  id: number;
  name: string;
  collection: "creations" | "presence";
  operation: "create" | "update" | "delete" | "list";
  authUid: string | null;
  emailVerified: boolean;
  docId: string;
  payload?: Record<string, unknown>;
  expected: "PERMISSION_DENIED";
}

export const DIRTY_DOZEN_CASES: SecurityTestCase[] = [
  {
    id: 1,
    name: "Unauthenticated create on creations",
    collection: "creations",
    operation: "create",
    authUid: null,
    emailVerified: false,
    docId: "c-unauth-1",
    payload: { id: "c-unauth-1", ownerId: "anon", visibility: "public" },
    expected: "PERMISSION_DENIED",
  },
  {
    id: 2,
    name: "Unverified email create on creations",
    collection: "creations",
    operation: "create",
    authUid: "user-1",
    emailVerified: false,
    docId: "c-unverified-2",
    payload: { id: "c-unverified-2", ownerId: "user-1", visibility: "public" },
    expected: "PERMISSION_DENIED",
  },
  {
    id: 3,
    name: "Identity spoofing ownerId mismatch",
    collection: "creations",
    operation: "create",
    authUid: "user-1",
    emailVerified: true,
    docId: "c-spoof-3",
    payload: { id: "c-spoof-3", ownerId: "victim-uid", visibility: "public" },
    expected: "PERMISSION_DENIED",
  },
  {
    id: 4,
    name: "Ghost shadow field injection",
    collection: "creations",
    operation: "create",
    authUid: "user-1",
    emailVerified: true,
    docId: "c-ghost-4",
    payload: { id: "c-ghost-4", ownerId: "user-1", visibility: "public", isAdmin: true },
    expected: "PERMISSION_DENIED",
  },
  {
    id: 5,
    name: "Invalid path ID poisoning",
    collection: "creations",
    operation: "create",
    authUid: "user-1",
    emailVerified: true,
    docId: "bad$id",
    payload: { id: "bad$id", ownerId: "user-1", visibility: "public" },
    expected: "PERMISSION_DENIED",
  },
  {
    id: 6,
    name: "Client-forged createdAt timestamp",
    collection: "creations",
    operation: "create",
    authUid: "user-1",
    emailVerified: true,
    docId: "c-time-6",
    payload: { id: "c-time-6", ownerId: "user-1", createdAt: "2020-01-01T00:00:00Z" },
    expected: "PERMISSION_DENIED",
  },
  {
    id: 7,
    name: "Oversized name string (> 64 chars)",
    collection: "creations",
    operation: "create",
    authUid: "user-1",
    emailVerified: true,
    docId: "c-size-7",
    payload: { id: "c-size-7", ownerId: "user-1", name: "x".repeat(65) },
    expected: "PERMISSION_DENIED",
  },
  {
    id: 8,
    name: "Out-of-bounds world coordinate",
    collection: "creations",
    operation: "create",
    authUid: "user-1",
    emailVerified: true,
    docId: "c-coord-8",
    payload: { id: "c-coord-8", ownerId: "user-1", x: 99999, z: 0 },
    expected: "PERMISSION_DENIED",
  },
  {
    id: 9,
    name: "Cross-user update on another creator's creation",
    collection: "creations",
    operation: "update",
    authUid: "user-2",
    emailVerified: true,
    docId: "c-owned-by-user-1",
    payload: { name: "Hijacked" },
    expected: "PERMISSION_DENIED",
  },
  {
    id: 10,
    name: "Immutable ownerId tamper during update",
    collection: "creations",
    operation: "update",
    authUid: "user-1",
    emailVerified: true,
    docId: "c-owned-by-user-1",
    payload: { ownerId: "user-2" },
    expected: "PERMISSION_DENIED",
  },
  {
    id: 11,
    name: "Cross-user presence overwrite",
    collection: "presence",
    operation: "create",
    authUid: "user-1",
    emailVerified: true,
    docId: "user-2",
    payload: { uid: "user-2", visibility: "public" },
    expected: "PERMISSION_DENIED",
  },
  {
    id: 12,
    name: "Invalid anim enum in presence",
    collection: "presence",
    operation: "update",
    authUid: "user-1",
    emailVerified: true,
    docId: "user-1",
    payload: { anim: "fly_hack" },
    expected: "PERMISSION_DENIED",
  },
];
