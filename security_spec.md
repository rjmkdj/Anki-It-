# Security Specification - Anki It!

## 1. Data Invariants
- A `FlashcardSet` must be owned by the authenticated user (`userId`).
- A `FlashcardSet` cannot have its `userId` or `createdAt` changed after creation.
- Sub-resources (`cards`, `sources`) are strictly owned by the parent `FlashcardSet`.
- Access to sub-resources is revoked immediately if the user no longer owns the parent `FlashcardSet`.
- All writes require a verified email (`request.auth.token.email_verified == true`).
- User profile (`users/{userId}`) access is strictly restricted to the user themselves.

## 2. The Dirty Dozen Payloads (Attack Vectors)
1. **Identity Spoofing**: Attempt to create a `FlashcardSet` with a `userId` that doesn't match `request.auth.uid`.
2. **Privilege Escalation**: Attempt to update a `FlashcardSet`'s `userId` to a different user.
3. **Resource Poisoning**: Injection of a 1MB string into the `title` field.
4. **ID Poisoning**: Creating a set with a 2KB junk string as the document ID.
5. **PII Leak**: An authenticated user trying to `get` another user's profile in the `users` collection.
6. **Query Scraping**: Attempting to `list` all `flashcard_sets` without a `userId` filter (should be blocked by rule-side enforcement).
7. **Orphaned Writes**: Attempting to write a `card` to a `setId` that the user does not own.
8. **Immutable Violation**: Attempting to change the `createdAt` timestamp of a set.
9. **State Shortcut**: Forcing a set status to 'completed' without proper content during update.
10. **Array Explosion**: Sending a `tags` array with 10,000 items.
11. **Type Confusion**: Sending a boolean for the `title` field.
12. **Unverified Account Action**: A user with `email_verified: false` attempting to create a set.

## 3. Test Cases (Summary)
The `firestore.rules.test.ts` (if implemented) would verify that all the above payloads return `PERMISSION_DENIED`.
