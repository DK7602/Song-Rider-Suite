# Chord Rider Pro v2.3.0 — SRP Workflow Stability Overhaul

This build hardens the CRP ↔ SRP workflow observed in the September 13 bug video.

- Link SRP no longer depends on Song Rider's large app initializer. The failsafe writes the link and chord sync directly to the same SRP project storage, then reloads SRP so the UI picks it up.
- Returning from Song Rider restores the exact CRP project that was active before navigation.
- Save recovers the stored active project ID if in-memory state was lost, preventing accidental duplicate projects.
- CRP snapshots itself before opening Song Rider, so chords/BPM/key passed to SRP are current.
- Existing SRP lyrics are preserved when CRP chords are synced.
- Obsolete update/fix text files are not included.
