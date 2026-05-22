/**
 * Done screen — shown once the Session Recording is in Photos and the
 * Session State has settled to `Done`.
 *
 * For M2 this surfaces the same observability fields M1 logged (Master /
 * Session durations, splice wall-clock + ratio, Photos id) so we can keep
 * watching the splice budget while the real screens take shape. M7 will
 * trim this to a parent-friendly success card and move the diagnostics
 * behind a developer toggle.
 *
 * "New Session" calls `reset()` on the session store, which returns us to
 * the Setup screen with a fresh, ROI-less state — per decisions-log the
 * Court ROI is *not* persisted across Sessions.
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import {
  useSessionStore,
  type ActiveSegmentRecord,
  type DoneInfo,
} from '../state/sessionMachine';
import { colors, radii, spacing, typography } from '../design/tokens';

function summarizeSegments(segments: ActiveSegmentRecord[]): string {
  if (segments.length === 0) return '(none)';
  return segments
    .map(
      s =>
        `${s.startSeconds.toFixed(1)}–${s.endSeconds.toFixed(1)}s (peak ${s.peakScore.toFixed(3)})`,
    )
    .join(', ');
}

export function DoneScreen() {
  const doneInfo = useSessionStore(s => s.doneInfo);
  const error = useSessionStore(s => s.error);
  const reset = useSessionStore(s => s.reset);

  // Three landing states for Done:
  //   1. Clean success — doneInfo with sessionUri set, no recoveryNote.
  //      "Saved to Photos".
  //   2. Recovered Session — doneInfo present, *either* recoveryNote
  //      set or sessionUri null. The Master Recording was preserved
  //      even though something went wrong (recorder error / splice
  //      failure / no motion). Title makes that obvious.
  //   3. Hard error — no doneInfo, just `error`. Master file was
  //      missing or never created. Render the message we have.
  const isRecovered =
    doneInfo != null &&
    (doneInfo.recoveryNote != null || doneInfo.sessionUri == null);
  const title =
    doneInfo == null
      ? 'Finished with an error'
      : isRecovered
        ? 'Master preserved'
        : 'Saved to Photos';

  return (
    <View style={styles.root}>
      <View style={styles.panel}>
        <Text style={styles.eyebrow}>Session</Text>
        <Text style={styles.title}>{title}</Text>
        {doneInfo?.recoveryNote && (
          <Text style={styles.recoveryText}>{doneInfo.recoveryNote}</Text>
        )}
        {error && <Text style={styles.errorText}>{error}</Text>}
        {doneInfo && <DoneStats info={doneInfo} />}
        <Pressable
          style={styles.primaryBtn}
          onPress={reset}
          accessibilityRole="button"
          accessibilityLabel="Start a new session">
          <Text style={styles.primaryBtnText}>NEW SESSION</Text>
        </Pressable>
      </View>
    </View>
  );
}

function DoneStats({ info }: { info: DoneInfo }) {
  const ratio = info.spliceMs / Math.max(1, info.masterDurationS * 1000);
  return (
    <ScrollView style={styles.stats}>
      <Row k="Master duration" v={`${info.masterDurationS.toFixed(2)} s`} />
      <Row
        k="Session duration"
        v={`${(info.outputDurationMs / 1000).toFixed(2)} s`}
      />
      <Row k="Splice wall-clock" v={`${info.spliceMs.toFixed(0)} ms`} />
      <Row k="Splice / Master" v={`${ratio.toFixed(3)}×`} />
      <Row
        k="Detection mode"
        v={info.usedFixedThreshold ? 'fixed-threshold (Skip Warm-up)' : 'adaptive baseline'}
      />
      <Row k="Active Segments" v={summarizeSegments(info.segments)} mono />
      <Row k="Session in Photos" v={info.sessionPhotosId ?? '(none)'} mono />
      {info.masterPhotosId && (
        <Row k="Master in Photos (dev)" v={info.masterPhotosId} mono />
      )}
      <Row k="Master URI" v={info.masterUri} mono small />
      <Row k="Session URI" v={info.sessionUri ?? '(none — Master only)'} mono small />
    </ScrollView>
  );
}

function Row({
  k,
  v,
  mono,
  small,
}: {
  k: string;
  v: string;
  mono?: boolean;
  small?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowKey}>{k}</Text>
      <Text
        style={[
          styles.rowVal,
          mono && styles.rowValMono,
          small && styles.rowValSmall,
        ]}
        numberOfLines={small ? 2 : undefined}>
        {v}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: spacing.base,
    justifyContent: 'center',
  },
  panel: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  eyebrow: {
    ...typography.caption,
    color: colors.stateSoft.done,
  },
  title: { ...typography.heading, color: colors.text },
  errorText: {
    ...typography.body,
    color: colors.stateSoft.capturing,
    fontSize: 13,
  },
  recoveryText: {
    ...typography.body,
    color: colors.stateSoft.calibrating,
    fontSize: 13,
    lineHeight: 18,
    backgroundColor: colors.surfaceSubtle,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  stats: { maxHeight: 320 },
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  rowKey: {
    ...typography.caption,
    color: colors.textSubtle,
    width: 140,
  },
  rowVal: {
    ...typography.body,
    color: colors.text,
    flex: 1,
    fontSize: 12,
  },
  rowValMono: { fontFamily: 'Menlo' },
  rowValSmall: { fontSize: 10 },
  primaryBtn: {
    alignSelf: 'center',
    backgroundColor: colors.actionStart,
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.md + 2,
    borderRadius: radii.pill,
    minWidth: 180,
    alignItems: 'center',
  },
  primaryBtnText: {
    ...typography.display,
    color: colors.actionText,
  },
});
