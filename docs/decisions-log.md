# Sub-ADR Decisions Log

This file captures decisions whose rationale is worth preserving but which do not individually meet the ADR bar (the three criteria: hard to reverse, surprising without context, result of a real trade-off). Entries here are one-line rationales — if an entry later proves load-bearing enough to justify an ADR, promote it.

## Session boundaries
- **Decision:** Session = "user taps Auto Record" → "user taps Stop" (or OS interrupts). No sport-structure inference (Match, Set, Rally).
- **Why:** Real-world matches start/end messily; sport-structure detection is fragile. User intent is a clean, unambiguous boundary.
- **Alternatives considered:** Session = Match (would require detecting match end); Session = Set (forces multiple taps per match, breaks the zero-touch promise); Session = Tournament day (file too large, includes walking between courts).
- **Reversibility:** Easy. If we later need a Match concept for analytics, we can layer it *inside* a Session without redefining Session itself.

## Court ROI: per-Session, required, not persisted
- **Decision:** User draws the Court ROI rectangle every Session. ROI is required to start recording. We do not persist Venue/Camera-Setup memory between Sessions.
- **Why:** "Draw the box" is a one-tap-and-drag, cheap friction. Persistence would require introducing a Venue concept and managing the case of "phone is positioned slightly differently than last week" — disproportionate complexity for MVP.
- **Alternatives considered:** Persistent Venue entity reused across Sessions (Phase 2 ergonomics improvement); optional ROI defaulting to full frame (rejected — too many false positives in any multi-court environment).
- **Reversibility:** Easy. Phase 2 can add Venue persistence as a UX layer over the same underlying ROI.

## Camera-pose drift handled naively
- **Decision:** If the phone is bumped mid-Session, the app does nothing — the ROI remains in original coordinates and the Session quality degrades. Restart is the user's responsibility.
- **Why:** Camera-pose-change detection is its own ML problem. MVP assumes a stable tripod. If real users prove this is a frequent failure, revisit.
- **Reversibility:** Easy. Pose tracking can be added later.

## Output destination: Photos library + in-app, eager merge
- **Decision:** When the user taps Stop, the merge happens immediately (with a progress UI). The Session Recording is saved to both the device Photos library and an in-app "My Sessions" list.
- **Why:** Photos is where parents are trained to look for videos; in-app listing is where Phase 2 will surface per-Session metadata. Eager merge gives the user a clear "Done" moment.
- **Alternatives considered:** Lazy/background merge with notification (more state, more failure paths); app-private-only storage (high friction for sharing).
- **Reversibility:** Mild. Output destinations and merge timing can be changed without restructuring core capture/storage.

## Trailing hold = 8s (pre-roll obsolete under ADR-0007)
- **Decision:** An Active Segment's metadata end-timestamp is held open for 8 seconds *after* motion drops below threshold before being committed. If motion returns within that 8s window, the Segment stays open; otherwise it closes. There is **no explicit pre-roll** because the Master Recording (ADR-0007) always contains the lead-in footage — every Active Segment's start-timestamp can point at the actual rally beginning rather than the moment motion crossed the threshold (a small backward adjustment, ~2s, applied at metadata-write time).
- **Why:** 8s is shorter than `idea.md`'s suggested 15s — chosen so long between-rally walks (10–15s) *do* close the Segment, supporting our "coarse but not too coarse" granularity goal (ADR-0004). Pre-roll as an in-memory ring buffer is obsolete because the underlying Master Recording always has the prior frames available; we adjust the start-timestamp backward in metadata rather than buffering frames in RAM.
- **Reversibility:** Trivial — both the trailing-hold value and the start-timestamp backward-adjustment are tuning parameters and will be revisited with real-world data.

## Setup screen design direction (M0 verdict)
- **Decision:** Variant **B — Guided wizard** (two-step: instruction panel + drag in Step 1, live-preview confirmation with the area outside the ROI dimmed in Step 2).
- **Why:** Less-experienced parents (the target user) need explicit guidance on what to do; Step 2's dim-outside-ROI preview makes the "what gets ignored" cost of a misframed court visible *before* recording starts. The extra tap of friction is the right trade for confidence in a once-per-match setup.
- **Alternatives considered:** A (free-draw immersive) was faster but assumed gesture literacy; C (handle-based preset) was forgiving on precision but didn't explain what the rectangle was *for*.
- **Reversibility:** Easy — Setup screen is a single self-contained screen rebuilt in M2.

## Recording screen design direction (M0 verdict)
- **Decision:** Variant **B — Smart-film chip**. Top compact state-pill, top-right vertical motion bars (animated, color-graduated cool → warm → hot to mirror intensity), translucent ROI fill only during `Capturing`, bottom-right FAB for start/stop with action color carrying the state.
- **Why:** B keeps chrome out of the play view while still giving a quick read of state + motion intensity. The animated motion bars proved more legible/satisfying on-device than C's histogram strip. The translucent-ROI-on-Capturing tells the user "this moment is being kept" without text.
- **Alternatives considered:** C (heads-up overlay) was initially chosen for sovereign-camera reading; switched to B after the on-device animation+color treatment of the motion indicator made it the clearer signal. A (driver dashboard) sacrificed too much preview to the bottom strip.
- **Reversibility:** Easy — Recording screen is rebuilt in M2.

## Design tokens v0 (M0.5)
- **Decision:** Centralized `colors`, `spacing` (4-pt grid), `radii`, `typography`, `motion`, and `colorForState` / `softColorForState` helpers in `app/src/design/tokens.ts`. Dark-themed; per-state palette pinned: Setup = neutral gray, Calibrating = amber (informational), Watching = calm blue, Capturing = warm orange (also the Stop action color — same warm tone reinforces "active = recording"), Stopping = gray, Done = green (also the Start action color — closes the loop to a non-running state).
- **Why:** Camera-first UI reads better on dark; mapping each Session State to one signature color (matched to the action color when semantically related) makes the screen self-explanatory at a glance. Tokens consolidate the ad-hoc hexes the prototype accumulated and become the single source of truth M2 builds on.
- **Reversibility:** Tokens are tuning parameters — values can change without restructuring code. The *shape* of the API (colors / spacing / radii / typography / motion) is the durable contract.
- **Notes:** `tokens.ts` is the one M0-era artifact that survives M2's `prototypes/` deletion.
