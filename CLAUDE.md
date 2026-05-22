# Active Sportz

Mobile app that auto-records youth volleyball, stripping dead time so parents get a clean continuous game video without manual intervention. MVP: volleyball only, one phone per court, on-device, iOS-first.

## Read before working

Domain language and architectural decisions are pinned in docs — **do not re-derive them from memory or the code**:

- `CONTEXT.md` — domain glossary (Session, Master Recording, Session Recording, Active Segment, Court ROI, Detection Mode, Warm-up, Session State) and MVP scope / Phase-2 deferrals. **Authoritative for terminology.**
- `docs/adr/0001..0010-*.md` — ten ADRs. Read `0007` (continuous Master), `0008` (tech stack), `0009` (Detection Mode / player-presence gate), and `0010` (quadrilateral Court ROI) first for current architecture. ADRs `0003` and `0005` are marked *superseded by 0007*.
- `docs/decisions-log.md` — sub-ADR-bar decisions with one-line rationale.
- `idea.md` — original brainstorming, partly superseded. Context only, not authoritative.

## Tech stack

React Native + TypeScript, `react-native-vision-camera` V5 (Nitro), `react-native-fast-tflite` (CoreML delegate), `react-native-ffmpeg` for splice. iOS-first; Android is Phase 2. See ADR-0008 for the why.

## Conventions

- Use the glossary terms from `CONTEXT.md` exactly — they appear in code, UI, and logs. Avoid the listed _Avoid_ synonyms (Rally, Clip, Paused, raw recording, etc.).
- New architectural decisions: if it's hard to reverse, surprising without context, or the result of a real trade-off → new ADR. Otherwise → append to `docs/decisions-log.md`.
