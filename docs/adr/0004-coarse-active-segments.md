# Coarse Active Segments (multi-rally, not per-rally)

An Active Segment spans "a contiguous stretch of activity bounded by long dead time" — typically containing multiple volleyball rallies plus the short between-rally walks. We deliberately do *not* aim for one Segment per rally. The trailing-hold parameter (currently 8s) is the knob that defines "coarse" — tuning it toward zero would approach per-rally granularity.

Reason: per-rally (fine) segmentation would give Phase 2 highlight extraction better starting granularity, but requires a much more confident detector to avoid false mid-rally cuts. A false mid-rally cut is a far worse user-facing failure than over-including a between-rally walk inside a Segment. Coarse is also the natural output of the simple motion-only heuristic the MVP commits to (see ADR-0001), so picking coarse preserves MVP velocity. Phase 2 highlight extraction can re-segment *inside* the coarse Segments — which is cheap because the Segments are already isolated, indexed, and metadata-tagged (ADR-0003).

Surprising-without-context check: the closest competitor we identified (Balltime) appears to produce rally-fine segmentation as part of its post-processing analytics. A future engineer wondering "why are our Segments so big compared to Balltime's plays?" should find this ADR.
