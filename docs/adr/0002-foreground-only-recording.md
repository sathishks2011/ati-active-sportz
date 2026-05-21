# Foreground-only recording

A Session requires the app to remain foreground for its entire duration. If the user locks the screen or switches apps, the Session ends gracefully — Active Segments captured up to that point are merged into a (possibly partial) Session Recording, and the user receives a notification that the Session ended early. The app does not attempt to keep recording in the background.

Reason: iOS invalidates the AVCaptureSession when the app is backgrounded — this is an OS-enforced constraint, not a configurable behavior. We could ship Android-first with a foreground service for background recording, but most US parents are on iPhone, so iOS-compatible behavior defines the product's baseline UX. A unified rule across platforms (`Session = app foreground`) is easier to communicate to users than divergent platform behavior. The `idea.md` "Prevent OS killing" framing was misleading; this ADR replaces it.

Consequences: the Session-setup UI must communicate the rule explicitly. The screen stays on (via `idleTimerDisabled`) for the duration of the Session, which has battery and thermal implications — see future power-budget ADRs. Parents are advised to keep the phone plugged in for matches longer than ~60 minutes.
