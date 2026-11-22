# Firestore Security Specification (Phase 0)

## 1. Data Invariants
1. **Creator Ownership**: Every document in `/creations/{creationId}` MUST have `ownerId == request.auth.uid` on creation, `ownerId` is immutable on update, and only the owner can update or delete it.
2. **Presence Key Binding**: Every document in `/presence/{uid}` MUST have document ID `{uid} == request.auth.uid` and `uid == request.auth.uid`. One user cannot overwrite or delete another user's presence.
3. **Verified Identity for Writes**: All writes (`create`, `update`, `delete`) require `request.auth != null && request.auth.token.email_verified == true`.
4. **Public Visibility & Zero PII**: Both `/creations` and `/presence` contain zero PII (no emails, phones, addresses). Reads (`get`, `list`) enforce `resource.data.visibility == 'public'`.
5. **Strict Key & Size Bounds**: Every create validates exact required/allowed keys (`hasAll` + `hasOnly`), string `.size()` bounds, numeric coordinate bounds, valid IDs (`^[a-zA-Z0-9_\-]+$`), and server-provided timestamps (`request.time`).
6. **Immutability & Action-Scoped Updates**: `createdAt`, `id`, `ownerId`, and `uid` are immutable; updates enforce `affectedKeys().hasOnly(...)`.

## 2. The "Dirty Dozen" Attack Payloads (All Must Return PERMISSION_DENIED)
1. Unauthenticated write to `/creations/c-1` (`request.auth == null`).
2. Unverified email write to `/creations/c-2` (`email_verified == false`).
3. Identity spoofing on create: `/creations/c-3` with `ownerId: "victim-uid"` != `request.auth.uid`.
4. Ghost/shadow field injection on create: `/creations/c-4` with extra key `isAdmin: true`.
5. Poisoned document ID: `/creations/bad..id` or 200-char ID.
6. Client-forged timestamp on create: `createdAt` != `request.time`.
7. Oversized `name` (> 64 chars) or `description` (> 280 chars) on `/creations/c-5`.
8. Out-of-bounds coordinates (`x: 99999`) or invalid `category: "weapon"` on `/creations/c-6`.
9. Cross-user update: User B trying to update User A's `/creations/c-1`.
10. Blueprint overwrite / `ownerId` tampering during `/creations/c-1` update.
11. Cross-user presence hijack: User A writing to `/presence/user-b-uid`.
12. Ghost field or invalid animation injection in `/presence/{uid}` (`anim: "hack"`).
