# Sub-ADR Decisions Log

This file captures decisions whose rationale is worth preserving but which do not individually meet the ADR bar (the three criteria: hard to reverse, surprising without context, result of a real trade-off). Entries here are one-line rationales — if an entry later proves load-bearing enough to justify an ADR, promote it.

## Session boundaries
- **Decision:** Session = "user taps Auto Record" → "user taps Stop" (or OS interrupts). No sport-structure inference (Match, Set, Rally).
- **Why:** Real-world matches start/end messily; sport-structure detection is fragile. User intent is a clean, unambiguous boundary.
- **Alternatives considered:** Session = Match (would require detecting match end); Session = Set (forces multiple taps per match, breaks the zero-touch promise); Session = Tournament day (file too large, includes walking between courts).
- **Reversibility:** Easy. If we later need a Match concept for analytics, we can layer it *inside* a Session without redefining Session itself.

## Court ROI: per-Session, required, not persisted
- **Decision:** User draws the Court ROI every Session. ROI is required to start recording. We do not persist Venue/Camera-Setup memory between Sessions.
- **Shape:** Quadrilateral (four user-tapped corners), not a screen-aligned rectangle — per **[ADR-0010](./adr/0010-quadrilateral-court-roi.md)**. The "draw a box" UX from the original decision was superseded once informal testing showed that a screen-aligned rectangle either over-includes sideline traffic or under-includes court corners in any non-overhead camera view. Per-Session and not-persisted aspects of this entry are unchanged.
- **Why (per-Session, not persisted):** Persistence would require introducing a Venue concept and managing the case of "phone is positioned slightly differently than last week" — disproportionate complexity for MVP.
- **Alternatives considered:** Persistent Venue entity reused across Sessions (Phase 2 ergonomics improvement); optional ROI defaulting to full frame (rejected — too many false positives in any multi-court environment).
- **Reversibility:** Easy on the persistence axis. Phase 2 can add Venue persistence as a UX layer over the same underlying ROI. The shape change to a quadrilateral is harder to reverse — see ADR-0010's "Hard to reverse" note.

## Pinch-to-zoom at Setup; locked for the Session
- **Decision:** The Setup screen exposes pinch-to-zoom on the camera preview during Step 1a (frame the court). The chosen zoom factor is persisted onto the `sessions` row alongside the four-corner ROI. Both are frozen at the moment the user taps Auto Record. Mid-Session zoom is rejected.
- **Why:** Real parents won't always sit court-side or have a tripod close to the action. Some need to zoom in to frame the court properly, others want a wide angle from the bleachers. The detector contract must survive both. The polygon ROI is captured in screen-normalized coordinates of the *zoomed* preview, so freezing zoom at Auto Record keeps the ROI valid for the entire Session.
- **Alternatives considered:** No zoom UI (rejected — forces the user to physically reposition the phone, hostile to the "set it and forget it" promise); live zoom during the Session (rejected — would invalidate the ROI mid-Session, same rationale as "Camera-pose drift handled naively" below — pose tracking is its own ML problem and out of MVP scope).
- **Reversibility:** Easy. Zoom is a single Camera prop on VisionCamera; removing the gesture and persistence is a small revert.
- **Notes:** Mid-Session zoom failures are handled the same way as bumps — Session quality degrades, and restarting is the user's responsibility (consistent with "Camera-pose drift handled naively").

## Detection Mode names — Smart / Enhanced (UI), motion / players (internal)
- **Decision:** The two detection Modes from ADR-0009 are surfaced in Settings as **Smart** (motion-only baseline) and **Enhanced** (Smart + on-device player detection). The internal identifiers stored in MMKV, the DB, ADR signal-description text, and any code-level enum are `'motion'` and `'players'`. A `labelForMode` helper at the UI boundary maps internal → user-visible.
- **Helper text (pinned):**
  - Smart — "Triggers on sustained motion inside the court."
  - Enhanced — "Also requires players to be on the court — fewer false starts during warm-ups and timeouts."
- **Why two name registers:** marketing positioning (tier ladder Smart → Enhanced) wants room to move independently of the engineering reality (motion vs motion+ML). Keeping internal identifiers signal-honest means the code stays accurate regardless of how the UI lineup evolves; keeping UI labels positioning-led means we don't lock the product into the engineering vocabulary. The `labelForMode` helper is the one place that knows about both.
- **Default:** Mode defaults to `'motion'` ("Smart") until field-test data justifies flipping to `'players'` ("Enhanced") as the default.
- **Alternatives considered:** Use the internal names Motion / Players in the UI (rejected by the user as too engineering-toned for an app-store-grade product). Use marketing names internally as well (rejected — names like "Smart" carry no signal information and decay as the lineup grows). Shadow-mode both pipelines and skip the toggle entirely (rejected, see ADR-0009 "Considered alternatives").
- **Reversibility:** Trivial. Rename in `labelForMode` to change UI; internal names are stable.
- **Flag for future-you:** A tier ladder of `Smart → Enhanced → ?` does not extend cleanly when Mode #3 lands. At that point decide whether to add a third tier name (`Pro`?) or rebrand the lineup. Engineering identifiers (`'motion'` / `'players'` / future) stay accurate regardless.
- **2026-05-21 update — Mode #3 landed as Continuous.** Internal id `'continuous'`, UI label `Continuous`. Chosen as a descriptive name rather than fitting the marketing ladder because Continuous is a *bypass* (no detection at all), not a tier upgrade — slotting it as "Pro" would mislead users into thinking it adds intelligence on top of Enhanced. Helper text: "No detection. The Master Recording is saved directly as your video — no court ROI, no dead-time stripping. Use this for non-court captures or to validate the recorder." Marketing positioning may want to revisit this if/when a real Pro tier (e.g. multi-cam or cloud analytics) lands; for now the lineup is Smart / Enhanced / Continuous in the segmented control and Settings.

## Known limitation — handheld false-positive / static false-negative
- **Observation (2026-05-21 field test):** With the phone on a stand, a single person walking through the polygon often does *not* cross `START_THRESHOLD` (per-pixel mean diff is small when motion is localized inside a large polygon). With the phone in hand, micro-shake of the whole frame produces a global Y-diff that *does* cross threshold — so Capturing triggers from camera shake even with no actual gameplay motion. The detector cannot distinguish in-scene motion from ego-motion.
- **Why we're calling this a limitation, not a bug:** The fix requires reading the device IMU (gyro / accelerometer) to detect handheld motion and suppress the motion signal during shake, or to refuse Auto Record when the device isn't stable. Neither is in the current native bridge surface (no IMU dep yet). The 2026-05-21 threshold tuning (`START` 0.04 → 0.02, `END` 0.025 → 0.012) makes single-person stand-mode tests more likely to trigger, which is the right move for validation — but it also lowers the bar for handheld false positives. **This is an acknowledged trade-off, not a regression.**
- **Mitigation today:** User is expected to put the phone on a stand for any Session intended to produce a usable Session Recording (consistent with the "Camera-pose drift handled naively" entry below — MVP assumes a stable mount). The dev-only diagnostics HUD on the Recording screen shows the live motion score against thresholds so the user can see what's actually happening.
- **IMU guardrail (landed 2026-05-21).** Native CMDeviceMotion bridge in `ios/ActiveSportz/Splicer.swift` (with the `startMotionUpdates` / `getDeviceMotionMagnitude` / `stopMotionUpdates` exports). RecordingScreen polls user-acceleration magnitude at 5 Hz and applies hysteresis (stable < 0.025 g, unstable > 0.055 g) to decide whether the phone is moving. When unstable, `Segmenter.setDeviceUnstable(true)` is called and the open-confirm gate refuses to start new Active Segments; in-flight Segments keep closing normally on the trailing-hold so brief mid-rally pickups don't truncate real captures. A bottom-anchored amber banner ("Phone is moving — put it on a stand. Auto Record is paused…") surfaces the state. Continuous Mode skips the loop entirely (no detector to gate). Tuning the 0.025 / 0.055 g band may want iteration once we have more field data on what handheld-vs-stand magnitudes actually look like on a parent's phone in a real gym.
- **Future work:** the thresholds above are the obvious tuning surface. A stronger signal would track magnitude over a 1–2s window rather than per-tick, which would distinguish "I just picked up the phone for a second" from "I am walking around with the phone." Revisit if the band proves too jittery in practice.

## Camera-pose drift handled naively
- **Decision:** If the phone is bumped mid-Session, the app does nothing — the ROI remains in original coordinates and the Session quality degrades. Restart is the user's responsibility.
- **Why:** Camera-pose-change detection is its own ML problem. MVP assumes a stable tripod. If real users prove this is a frequent failure, revisit.
- **Reversibility:** Easy. Pose tracking can be added later.

## Output destination: Photos library + in-app, eager merge
- **Decision:** When the user taps Stop, the merge happens immediately (with a progress UI). The Session Recording is saved to both the device Photos library and an in-app "My Sessions" list.
- **Why:** Photos is where parents are trained to look for videos; in-app listing is where Phase 2 will surface per-Session metadata. Eager merge gives the user a clear "Done" moment.
- **Alternatives considered:** Lazy/background merge with notification (more state, more failure paths); app-private-only storage (high friction for sharing).
- **Reversibility:** Mild. Output destinations and merge timing can be changed without restructuring core capture/storage.

## Leading hold = 1.5s on Active Segment open
- **Decision:** A score crossing `START_THRESHOLD` no longer opens an Active Segment on its own. Score must stay above `START_THRESHOLD` for `OPEN_HOLD_MS` (1.5s, with dips into the hysteresis band between END and START tolerated) before the Segment opens. A drop below `END_THRESHOLD` during the wait resets to idle. The open-timestamp is still backdated to the moment motion *first* crossed (minus `START_BACKWARD_ADJUSTMENT_S`), so the leading hold doesn't shave 1.5s off the start of real rallies.
- **Why:** Before this, a single person walking through the Court ROI (coach, ball-retriever, parent crossing) instantly flipped Watching→Capturing and contributed an 8s tail of dead time to the Session Recording. Symmetric leading/trailing holds make the trigger contract "sustained motion → Segment" instead of "any motion → Segment."
- **Alternatives considered:** Higher `START_THRESHOLD` (rejected — also suppresses faint real motion at the far side of the court); stricter reset (any dip below START, not END, resets — rejected as too sensitive to per-frame noise in the early seconds of a real rally).
- **Reversibility:** Trivial — `OPEN_HOLD_MS` is a tuning parameter, and the state machine collapses to the previous behaviour by setting it to 0.
- **Notes:** This is the lightweight half of the fix; the heavier half (require detected players inside the ROI before opening) is a contract change tracked separately as ADR-0009.

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
