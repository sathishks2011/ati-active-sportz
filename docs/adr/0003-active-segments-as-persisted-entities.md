---
status: superseded by ADR-0007
---

# Active Segments as named persisted entities

**Note (superseded by ADR-0007):** After adopting the continuous Master Recording + post-capture splice architecture (ADR-0007), Active Segments are represented as metadata-only spans pointing into a single continuous Master Recording, not as separate on-disk files. The principle of "Active Segments are first-class entities with metadata" survives in the new model; only the representation changed.

---

## Original decision (historical)

Each contiguous stretch of detected active play is persisted as a discrete on-disk file with its own metadata row (start/end timestamps, motion score, audio score). The user-facing Session Recording is built by merging these Active Segments at Stop time. We do not write straight to a single monolithic file at capture time.

Reason: the alternative ("Model X" — write all captured frames into one file as a stream, with no segment identity) is simpler at the storage layer but throws away two affordances we expect to need: (1) Phase 2 highlight extraction would have to re-derive segment boundaries by re-running detection against an already-processed flat video, which is wasteful and lossy; (2) crash semantics are worse — a single in-progress file in an unknown state vs. a clean set of already-closed Segment files plus one lost in-flight Segment (see ADR-0005). The storage cost (briefly ~2× while both Segments and the merged Session Recording exist) is acceptable for MVP; segment cleanup can be added in Phase 2 when storage actually becomes a pain point.

The trade-off was real — Model X was a credible default that the `idea.md` partly suggests in places ("merge clips into one final video"). The decision is hard to reverse because storage layout and the local DB schema both depend on it.
