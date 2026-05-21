# Active Sportz

A mobile app that automatically records youth sports gameplay, pausing during dead time, so parents end up with a clean continuous game video without manual intervention.

**MVP scope:** volleyball only, one phone filming one court per Session, on-device processing only, motion-based detection only.

**Explicitly deferred to Phase 2 or later** (the MVP does not model, detect, expose, or store any of these):
- Highlight reels / short-form scoring-moment compilations
- Player focus / per-player tagging / "which kid is this Session for"
- Scoring-moment detection / scoreboard OCR
- Audio detection (whistle, crowd spike) — see [ADR-0001](./docs/adr/0001-no-audio-in-mvp.md)
- Multi-court tracking / one app filming several courts simultaneously
- Multiple sports (basketball, tennis, pickleball, soccer, etc.)
- Venue / Camera Setup persistence across Sessions (Court ROI is per-Session in MVP)
- Sport-structure concepts (Match, Set, Rally, Timeout, Game End) as first-class entities — see [ADR-0004](./docs/adr/0004-coarse-active-segments.md)
- Camera-pose-change detection / re-ROI prompts mid-Session
- Cloud sync, accounts, sharing, social, live streaming
- Background recording — see [ADR-0002](./docs/adr/0002-foreground-only-recording.md)
- Smart zoom, auto-tracking, AI narration, AI editing

## Language

**Session**:
A user-defined recording window: starts when the user taps "Auto Record" and ends when *either* (a) the user taps "Stop" *or* (b) the OS interrupts the app (user locks screen, switches apps, takes a call). The app makes no assumption about sport structure (Match, Set, Rally) — those are not domain concepts the MVP tracks. Dead time within the Session is stripped automatically; the Session itself is bounded only by user intent or OS interruption.
_Avoid_: Match, Game, Recording (overloaded — "recording" is the verb).

**Master Recording**:
The single continuous video file captured by the camera for the *entire* duration of a Session. The hardware encoder runs without interruption from "Auto Record" tap through "Stop" tap — no pause, no restart, no per-segment file. The Master Recording contains *all* footage from the Session, including dead time, calibration, and any sideline activity. It is the underlying artifact from which the user-facing Session Recording is produced. Kept on disk with user-controlled retention (not auto-deleted on Session end).
_Avoid_: raw recording (overloaded), source file (too generic), continuous recording (describes the verb, not the artifact).

**Session Recording**:
The single user-facing artifact a Session produces — one continuous, dead-time-stripped video. Long-form (typically 15–60 minutes of retained footage), not a short reel. Built by **splicing** the Master Recording per the Session's Active Segment timestamps (typically via FFmpeg `-c copy`).
_Avoid_: highlight, highlight reel, clip compilation, montage (these imply short-form scoring-moments-only output, which is out of MVP scope).

**Active Segment**:
A metadata-only entity describing one contiguous stretch the app classified as active play within a Session — start timestamp, end timestamp, and detection-signal scores (motion score, audio score). Active Segments **point into** the Master Recording; they are *not* separate files on disk. A typical Active Segment is **coarse**, bounded by long dead time (timeouts, between-set breaks, water breaks) and containing multiple rallies plus the short transitions between them. The Session Recording is produced by splicing the Master Recording along the Active Segment time spans, in order.
_Avoid_: Clip (overloaded), segment file (Active Segments are not files), Recording (overloaded — see Session Recording / Master Recording), **Rally** (a Rally is a sport-domain concept the MVP does not model — multiple Rallies live inside one Active Segment).

**Court ROI**:
A user-drawn rectangular region within the camera's field of view that defines where motion counts as active play. Set during Session setup before "Auto Record" can be tapped, fixed for the duration of the Session, not persisted between Sessions. Motion outside the Court ROI (crowd, adjacent courts, sideline traffic) is ignored.
_Avoid_: court boundary (an actual line on the floor — different thing), region of interest (generic CV term — be specific to this context).

**Warm-up**:
The opening phase of every Session (~15 seconds by default) during which the motion detector is establishing a baseline of "what idle looks like" in the current Court ROI, lighting, and gym conditions. The Master Recording captures frames during Warm-up (the encoder is always running), but **no Active Segments are emitted in the metadata during this window** — so any footage from Warm-up is automatically excluded from the final Session Recording. Users can override Warm-up with a "Skip Calibration" option that falls back to a fixed-threshold detection mode. The corresponding Session State during this phase is **Calibrating**.
_Avoid_: calibration (overloaded — calibration is what the Warm-up *does*, but Warm-up is the named phase), baseline period (less user-friendly).

**Session State**:
The single canonical enum describing what the app is currently doing within a Session lifecycle. Used in the UI, in logs, in support conversations, and in code. The states are:
- **Setup** — pre-recording configuration; the user is drawing the Court ROI and "Auto Record" has not been tapped.
- **Calibrating** — Warm-up is in progress; the Master Recording is being captured, but no Active Segments will be emitted from this window.
- **Watching** — the Session is running and the detector is monitoring, but no Active Segment is currently open (motion-in-ROI is below threshold). The Master Recording is still being captured. *This is the natural state during dead time.* User-facing meaning: "this moment will be **stripped** from the Session Recording."
- **Capturing** — an Active Segment is open in metadata. The Master Recording is being captured (as always). User-facing meaning: "this moment **will be in** the Session Recording."
- **Stopping** — the user has tapped Stop (or the OS interrupted); the splice from Master Recording → Session Recording is in progress.
- **Done** — the Session is finalized; the Session Recording is in Photos and the in-app library. The Master Recording is retained on device per user-controlled retention settings.
_Avoid_: **Paused** (too easy to misread as "user paused it" — Watching is the correct name; also the Master Recording is never paused), plain **Recording** (too vague — the Master is always being recorded; use Capturing only for the Active-Segment-open state), **Idle** (collides with "no Session running at all").

## How a Session becomes a Session Recording

A Session is **one tap of "Auto Record" → one tap of "Stop"**, with the phone recording **continuously** in between. We do not stitch multiple Record/Stop presses together into a single output. For a full volleyball match the user taps Record once at the start, props the phone on a tripod, walks away, and taps Stop once at the end.

Inside that single continuous recording the camera captures **everything** — rallies, timeouts, water breaks, walking around, the whole match. The job of the app is to **detect which time ranges contained actual play** and **emit a Session Recording that contains only those ranges**, splicing them back-to-back. The continuous original (Master Recording) is retained on device per ADR-0007; the dead-time-stripped output (Session Recording) is what the user sees in their Photos library.

### Concrete example

```
A single Session = one continuous Master Recording, one continuous tape
─────────────────────────────────────────────────────────────────────────
0:00     0:30           1:30   1:55           3:15   3:40     ⋯   match end
  └ idle ─┘└── rally ────┘└idle─┘└──── rally ──┘└idle─┘└─ rally ─┘
                            ↓
            Frame Processor watches motion in the Court ROI;
            when motion > threshold an Active Segment opens;
            when motion drops for ~8s it closes (decisions-log).
                            ↓
   Active Segments (metadata):  [0:30–1:30], [1:55–3:15], [3:40–match end]
                            ↓
   Splicer concatenates only those ranges from the Master Recording.
                            ↓
   Session Recording = 0:30–1:30 + 1:55–3:15 + 3:40–end (no idle)
```

The Session Recording is **not** a highlight reel. It's the same continuous gameplay, with the dull bits cut out — long-form (typically 15–60 minutes), not short.

### "New Session" means a different match, not "more footage for the same one"

Tapping Stop and then tapping Auto Record again starts a **completely independent** Session — separate Master, separate Active Segments, separate Session Recording, separate Photos entry. There is no concept of "combine two Sessions into one." If you stopped mid-match by accident, that's an early-end Session per ADR-0002's interruption model; the next tap starts a fresh Session.

This is a deliberate scope decision (see [decisions-log.md](./docs/decisions-log.md) — "Session boundaries"). Multi-tape stitching adds state, encoder spin-up cost, and ambiguity about what counts as "the match," none of which the MVP needs.

## Building this in stages — what each milestone proves

The whole pipeline above is divided across milestones in `/Users/sathishksoman/.claude/plans/let-s-start-the-implementation-cozy-river.md`. Each milestone proves one slice of the stack so we don't try to debug everything at once:

| Milestone | Proves |
|---|---|
| **M0 / M0.5** | UI direction (Setup-B, Recording-B) and the design tokens. |
| **M1** | The splice mechanism — given a Master file and a hardcoded list of time ranges, AVFoundation (`AVMutableComposition` + `AVAssetExportPresetPassthrough`) can produce the Session Recording on-device fast enough that the user isn't stuck waiting at the end of a match. **Detection is not part of M1 — segments are hardcoded.** |
| **M2** | Production Setup + Recording screens built on the M0-B winners and the M0.5 tokens, wired into the (still hardcoded) M1 splice. |
| **M3** | Motion detection on a VisionCamera Frame Processor — real Active Segments derived from motion inside the Court ROI replace the hardcode. Fixed-threshold first. |
| **M4** | Warm-up adaptive baseline + Skip Calibration fallback (ADR-0006), so detection works across gyms / lighting without hand-tuning. |
| **M5** | Persistence (`op-sqlite`) + silent crash recovery + Master retention UI (ADR-0007). |
| **M6** | Interruption handling (ADR-0002) — phone lock / app switch / call ends the Session gracefully. |
| **M7** | Polish: progress UX, error states, 90-min thermal/battery test, one real-match validation. |

If at any milestone the demo feels like "it doesn't really *do* anything yet," that's almost always because it's proving one layer of the stack in isolation. The user-visible magic (parent records a match, gets a clean gameplay-only video, no taps) lands at M3, with M5 making it crash-safe and M6/M7 making it ship-ready.

## Flagged ambiguities

_None yet._
