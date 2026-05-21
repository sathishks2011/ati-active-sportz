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
import { useSessionStore, type DoneInfo } from '../state/sessionMachine';
import { colors, radii, spacing, typography } from '../design/tokens';

export function DoneScreen() {
  const doneInfo = useSessionStore(s => s.doneInfo);
  const error = useSessionStore(s => s.error);
  const reset = useSessionStore(s => s.reset);

  return (
    <View style={styles.root}>
      <View style={styles.panel}>
        <Text style={styles.eyebrow}>Session</Text>
        <Text style={styles.title}>
          {doneInfo ? 'Saved to Photos' : 'Finished with an error'}
        </Text>
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
      <Row k="Session in Photos" v={info.sessionPhotosId ?? '(none)'} mono />
      {info.masterPhotosId && (
        <Row k="Master in Photos (dev)" v={info.masterPhotosId} mono />
      )}
      <Row k="Master URI" v={info.masterUri} mono small />
      <Row k="Session URI" v={info.sessionUri} mono small />
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
