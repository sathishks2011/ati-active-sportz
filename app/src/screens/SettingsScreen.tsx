/**
 * Settings — preferences that persist across launches (M7+ polish).
 *
 * v1 is deliberately small. The single live toggle is "Always skip
 * Warm-up" — useful for users who reliably arrive mid-match and
 * would learn an unusable baseline otherwise. Everything else on
 * the screen is informational so users can see exactly which knobs
 * the detector is using and lobby for changes in feedback.
 */

import React from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useSessionStore } from '../state/sessionMachine';
import { useSettingsStore } from '../state/settingsStore';
import {
  END_THRESHOLD,
  START_BACKWARD_ADJUSTMENT_S,
  START_THRESHOLD,
  TRAILING_HOLD_MS,
} from '../detection/config';
import { CALIBRATION_DURATION_MS } from '../state/sessionMachine';
import { colors, radii, spacing, typography } from '../design/tokens';

export function SettingsScreen() {
  const setAppScreen = useSessionStore(s => s.setAppScreen);
  const alwaysSkipWarmup = useSettingsStore(s => s.alwaysSkipWarmup);
  const setAlwaysSkipWarmup = useSettingsStore(s => s.setAlwaysSkipWarmup);
  const resetSettings = useSettingsStore(s => s.resetSettings);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable
          onPress={() => setAppScreen('dashboard')}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Back to Setup">
          <Text style={styles.backBtnText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Settings</Text>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Section title="Detector">
          <Row
            label="Always skip Warm-up"
            hint="Start every Session with the fixed-threshold detector. Use this if you usually arrive after play has begun and the Warm-up window can't see a clean idle court."
            control={
              <Switch
                value={alwaysSkipWarmup}
                onValueChange={setAlwaysSkipWarmup}
                trackColor={{
                  false: colors.divider,
                  true: colors.actionStart,
                }}
                thumbColor={colors.text}
                accessibilityLabel="Always skip Warm-up"
              />
            }
          />
        </Section>

        <Section title="Detection (read-only)">
          <InfoRow
            k="Warm-up duration"
            v={`${CALIBRATION_DURATION_MS / 1000}s`}
          />
          <InfoRow k="Open threshold" v={START_THRESHOLD.toFixed(3)} />
          <InfoRow k="Close threshold" v={END_THRESHOLD.toFixed(3)} />
          <InfoRow
            k="Trailing hold"
            v={`${TRAILING_HOLD_MS / 1000}s`}
          />
          <InfoRow
            k="Start backward adjust"
            v={`${START_BACKWARD_ADJUSTMENT_S}s`}
          />
          <Text style={styles.note}>
            Tunable in `src/detection/config.ts`. Per ADR-0006 the
            adaptive baseline learned during Warm-up makes the same
            thresholds work across different gyms; if a gym keeps
            misfiring, raise “Open threshold” to filter noise.
          </Text>
        </Section>

        <Pressable
          style={styles.resetBtn}
          onPress={resetSettings}
          accessibilityRole="button"
          accessibilityLabel="Reset all settings">
          <Text style={styles.resetBtnText}>Reset to defaults</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function Row({
  label,
  hint,
  control,
}: {
  label: string;
  hint?: string;
  control: React.ReactNode;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint && <Text style={styles.rowHint}>{hint}</Text>}
      </View>
      <View>{control}</View>
    </View>
  );
}

function InfoRow({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoKey}>{k}</Text>
      <Text style={styles.infoVal}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingTop: 60 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  backBtnText: { ...typography.bodyEmphasis, color: colors.text },
  title: {
    ...typography.heading,
    color: colors.text,
    flex: 1,
    textAlign: 'center',
  },
  headerSpacer: { width: 60 },
  scroll: { padding: spacing.base, gap: spacing.lg, paddingBottom: spacing.xxxl },
  section: { gap: spacing.sm },
  sectionTitle: {
    ...typography.caption,
    color: colors.textSubtle,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  sectionBody: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { ...typography.bodyEmphasis, color: colors.text },
  rowHint: { ...typography.caption, color: colors.textMuted, fontSize: 11 },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  infoKey: { ...typography.body, color: colors.textMuted, fontSize: 13 },
  infoVal: { ...typography.mono, color: colors.text },
  note: {
    ...typography.caption,
    color: colors.textSubtle,
    fontSize: 11,
    marginTop: spacing.sm,
    lineHeight: 16,
  },
  resetBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceSubtle,
  },
  resetBtnText: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 11,
    textTransform: 'uppercase',
  },
});
