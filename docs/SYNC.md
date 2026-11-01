# Cloud sync contract

Both apps keep songs on the device first and sync them to the Worker API. The server never
silently overwrites newer work: every project has a **server revision (`rev`)** and every save says
which revision it was based on.

## Rules for clients

1. Remember, per project, the `rev` the server last returned (from GET, a save, or a 409).
2. Send it as `baseRev` on every save. A project that has never reached the server uses `baseRev: 0`.
3. On `409 {code:'conflict', project}`, someone else saved first. Do **not** retry blindly. Keep both:
   save the local version as a separate "(conflict copy)" project or let the user choose, then adopt
   the server copy and its `rev`.
4. On `409 {code:'deleted'}`, the song was deleted on another device. Drop the local copy unless it
   has edits made after the delete; in that case keep it as a new copy with a new id.
5. On `409 {code:'id_taken'}` (CRP only), the id belongs to another account. Give the project a new id
   and save again with `baseRev: 0`.
6. `force: true` overwrites deliberately (the user picked "keep mine"). Use it only after a choice.
7. Pull (GET) when the app starts, when the tab becomes visible again, and when the device comes
   back online, not only on a timer.
8. Only bump a project's local "changed" time for real content edits, not for echoes of settings that
   came from the other app or for metadata bookkeeping.

Requests without `baseRev` keep the old last-write-wins behaviour so cached older builds still work.

## Chord Rider Pro: `/api/projects`

| Call | Body | Success | Conflicts |
|---|---|---|---|
| `GET /api/projects` | | `{projects:[{...data,id,name,createdAt,updatedAt,rev}], deleted:[{id,deletedAt}]}` | |
| `POST /api/projects` | `{project, baseRev?, force?}` | `{project:{...,rev}, rev}` | `409 conflict` (+`project`), `409 deleted` (+`deletedAt`), `409 id_taken` |
| `PATCH /api/projects/:id` | `{name, baseRev?, force?}` | `{rev}` | `409 conflict` |
| `DELETE /api/projects/:id` | | `{deletedAt}` (tombstone kept 180 days) | |

For CRP `rev === updatedAt` (server clock, strictly increasing per project).

## Song Rider Pro: `/api/srp/projects`

| Call | Body | Success | Conflicts |
|---|---|---|---|
| `GET /api/srp/projects` | | rows incl. `rev`, deleted rows have `deleted:true` | |
| `POST /api/srp/projects` | `{project, baseRev?, force?}` (`base_rev` also accepted) | `{project_id, updated_at, rev}` | `409 conflict` / `409 deleted` (+`project` row) |
| `DELETE /api/srp/projects/:id?baseRev=N[&force=1]` | | `{rev, deleted_at}` | `409 conflict` if edited elsewhere since `baseRev` |

For SRP, `updated_at` stays the client's content time (used for display and merge hints); `rev` is
the server revision used for conflict checks.

## Lyric dictation style

`POST /api/lyrics-dictation` accepts an optional `X-Dictation-Style` header:
`hiphop` (default), `worship`, `country`, `pop`, `rnb`, `general`. It changes the spelling hints
given to the speech model.
