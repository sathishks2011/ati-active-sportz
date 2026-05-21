---
status: superseded by ADR-0007
---

# Per-Segment durability with silent recovery

**Note (superseded by ADR-0007):** The durability model shifted from per-Active-Segment files to a continuous Master Recording with incremental metadata writes. Recovery semantics under the new architecture are defined in ADR-0007. The "silent recovery, no user prompt" principle survives; only the underlying file model changed.

---

## Original decision (historical)

State durability granularity is the Active Segment, not the frame and not the Session. Each Segment is finalized (hardware-encoded, flushed to disk, indexed in the local DB) when it closes — meaning once its trailing-hold window has elapsed without motion returning. The *currently capturing* Segment lives in memory + a temp file and is **not** durable; an OS-induced crash or interruption loses it (~30s of footage at worst). On next launch after an interruption, the app silently finalizes any closed Segments from the interrupted Session, merges them into a (possibly partial) Session Recording, and adds it to the user's library — no recovery prompt, no user decision.

Reasoning across three sub-decisions:
- **Durability granularity:** per-frame is overkill (severe write amplification, complex); Session-level is unacceptable (one interruption loses everything). Per-Segment matches the natural finalization checkpoint and aligns with ADR-0003's storage model.
- **Silent vs. prompted recovery:** prompts are friction. Users want whatever the app could save — they will not "choose to discard" footage of their kid's match. If they don't want it, they can delete it from the library like any other Session.
- **In-progress Segment fate:** attempting to repair a half-written H.264 file is its own engineering project. A "Segment exists fully or not at all" contract is simpler to reason about, and the worst-case loss (~30s) is acceptable for MVP. ADR-0002 makes interruptions an expected lifecycle event, not an edge case, so this contract is exercised frequently and needs to be simple.

The decision is hard to reverse — it shapes the storage layout, the local DB schema, and the recovery UX. Surprising-without-context — a reader might assume there's a recovery prompt, or that the in-progress Segment is repaired. Real trade-off — all three sub-choices had credible alternatives.
