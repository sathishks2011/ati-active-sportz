# No audio detection in MVP

The `idea.md` plan proposed motion + audio as peer detection pipelines (whistle and crowd-spike detection feeding the Event Decision Engine). We're deferring audio to Phase 2 and shipping motion-only.

Reason: target environments are multi-court tournaments where whistles and crowd spikes from adjacent courts are entangled in the same audio stream as the court being filmed. A single tripod-mounted phone mic can't separate them, so audio is a noisy multi-source signal that doesn't cleanly correlate with the recorded court. Motion-in-Court-ROI, by contrast, *is* spatially isolated to one court by construction. Volleyball dead time also produces a natural collapse in motion-in-ROI, so audio is not load-bearing for the basic active/inactive transition.

Audio remains an architecturally welcome addition: the Event Decision Engine is designed to accept new signal sources without restructuring. It will be added in Phase 2 only if motion-only field testing reveals failure modes that audio specifically resolves.
