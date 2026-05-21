# Tech stack: React Native + VisionCamera V5 + fast-tflite + FFmpeg, iOS-first

The MVP is built in React Native with TypeScript at the application layer, using `react-native-vision-camera` V5 (Nitro Modules) for camera capture and Frame Processors, `react-native-fast-tflite` (with CoreML GPU delegate) for any on-device inference, and `react-native-ffmpeg` (or equivalent) for the post-capture splice step that produces the Session Recording from the Master Recording. The MVP ships iOS-first; Android is explicitly Phase 2.

Reason: the developer's existing fluency is React Native — no prior Swift, Kotlin, or Flutter experience. The original `idea.md` plan recommended Flutter; an earlier review (now reversed) recommended pure native iOS. Both ignored a recent ecosystem shift: VisionCamera V5's Nitro-Modules architecture runs Frame Processors on a dedicated worklet runtime via JSI, with zero per-frame JS-bridge overhead. Combined with `react-native-fast-tflite`'s CoreML delegate (which targets the Apple Neural Engine), this gives us near-native performance for the perf-critical capture + inference path *without* writing custom native modules. The stack collapses the previously load-bearing "learn Swift + AVFoundation" effort to a much smaller "learn VisionCamera Frame Processors" effort, which preserves the developer's velocity at the validation phase that matters most.

iOS-first (not iOS + Android day one) is a deliberate scope decision: iPhone dominates the US youth-sports-parent demographic at the validation wedge; iOS's camera + ML + encoding stack is materially better-documented and less device-fragmented; and adding Android later via VisionCamera + fast-tflite is *additive* to the same TypeScript codebase rather than a rewrite. The "Android when?" question is answered: "after iOS validates the product."

Considered alternatives:
- **Pure native iOS (Swift + AVFoundation):** rejected — high learning cost for the developer, slow time to first parent feedback. Would have been the right call before VisionCamera V5 closed the perf gap.
- **Flutter + native modules** (the `idea.md` recommendation): rejected — Flutter's camera advantage over VisionCamera V5 has eroded; the only differentiator left is Dart vs. TypeScript, which loses on the developer's existing fluency.
- **Kotlin Multiplatform:** rejected — would require learning Kotlin + SwiftUI + Compose + KMP simultaneously; the "shared business logic" gain doesn't justify the learning surface for an MVP.
- **iOS + Android native (day one):** rejected — doubles the work before any product validation has happened.

Hard to reverse (rewriting the app in Flutter or pure native after MVP = months of work); surprising (an earlier ADR review explicitly *recommended pure native* before learning of VisionCamera V5's capabilities — a future engineer reading "why is the camera path in JS?" deserves an answer); real trade-off (four credible alternatives were considered).
