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
import {
  useSettingsStore,
  labelForMode,
  helperTextForMode,
  effectiveThresholds,
  THRESHOLD_DEFAULTS,
} from '../state/settingsStore';
import {
  MIN_PLAYERS_IN_ROI,
  PERSON_DETECTOR_HZ,
  START_BACKWARD_ADJUSTMENT_S,
} from '../detection/config';
import { CALIBRATION_DURATION_MS } from '../state/sessionMachine';
import type { DetectionMode } from '../persistence/sessionRepo';
import { colors, radii, spacing, typography } from '../design/tokens';

export function SettingsScreen() {
  const setAppScreen = useSessionStore(s => s.setAppScreen);
  const alwaysSkipWarmup = useSettingsStore(s => s.alwaysSkipWarmup);
  const setAlwaysSkipWarmup = useSettingsStore(s => s.setAlwaysSkipWarmup);
  const detectionMode = useSettingsStore(s => s.detectionMode);
  const setDetectionMode = useSettingsStore(s => s.setDetectionMode);
  const userStartThreshold = useSettingsStore(s => s.userStartThreshold);
  const userEndThreshold = useSettingsStore(s => s.userEndThreshold);
  const userOpenHoldMs = useSettingsStore(s => s.userOpenHoldMs);
  const userTrailingHoldMs = useSettingsStore(s => s.userTrailingHoldMs);
  const setUserStartThreshold = useSettingsStore(s => s.setUserStartThreshold);
  const setUserEndThreshold = useSettingsStore(s => s.setUserEndThreshold);
  const setUserOpenHoldMs = useSettingsStore(s => s.setUserOpenHoldMs);
  const setUserTrailingHoldMs = useSettingsStore(s => s.setUserTrailingHoldMs);
  const resetSettings = useSettingsStore(s => s.resetSettings);
  const liveThresholds = effectiveThresholds({
    userStartThreshold,
    userEndThreshold,
    userOpenHoldMs,
    userTrailingHoldMs,
  });

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
        <Section title="Detection Mode">
          <ModeRow
            value="motion"
            selected={detectionMode === 'motion'}
            onSelect={setDetectionMode}
          />
          <ModeRow
            value="players"
            selected={detectionMode === 'players'}
            onSelect={setDetectionMode}
          />
          <ModeRow
            value="continuous"
            selected={detectionMode === 'continuous'}
            onSelect={setDetectionMode}
          />
          <Text style={styles.note}>
            The Mode is locked in when you tap Auto Record. Record the
            same match twice — once in Smart, once in Enhanced — to
            compare which trigger contract performs better in your gym.
            Pick Continuous for non-court captures or to validate the
            recorder without any detection in the loop. Switching
            Modes between Sessions is the recommended way to field-test
            (ADR-0009).
          </Text>
        </Section>

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

        <Section title="Detection tuning">
          <StepperRow
            label="Open threshold"
            hint="Higher = harder to trigger Capturing. Raise if non-game motion keeps firing; lower if real play isn't crossing."
            value={liveThresholds.startThreshold}
            isDefault={userStartThreshold == null}
            defaultValue={THRESHOLD_DEFAULTS.startThreshold}
            step={0.005}
            min={0.005}
            max={0.2}
            format={v => v.toFixed(3)}
            onChange={v => setUserStartThreshold(v)}
            onReset={() => setUserStartThreshold(null)}
          />
          <StepperRow
            label="Close threshold"
            hint="Must sit below the open threshold. Score must drop here to start the trailing hold."
            value={liveThresholds.endThreshold}
            isDefault={userEndThreshold == null}
            defaultValue={THRESHOLD_DEFAULTS.endThreshold}
            step={0.005}
            min={0.001}
            max={0.2}
            format={v => v.toFixed(3)}
            onChange={v => setUserEndThreshold(v)}
            onReset={() => setUserEndThreshold(null)}
          />
          <StepperRow
            label="Leading hold"
            hint="Motion must stay above the open threshold this long before Capturing opens. Higher = fewer transient false starts."
            value={liveThresholds.openHoldMs}
            isDefault={userOpenHoldMs == null}
            defaultValue={THRESHOLD_DEFAULTS.openHoldMs}
            step={100}
            min={0}
            max={5000}
            format={v => `${(v / 1000).toFixed(1)}s`}
            onChange={v => setUserOpenHoldMs(v)}
            onReset={() => setUserOpenHoldMs(null)}
          />
          <StepperRow
            label="Trailing hold"
            hint="After motion drops, Capturing stays open this long before closing. Bridges brief mid-rally lulls."
            value={liveThresholds.trailingHoldMs}
            isDefault={userTrailingHoldMs == null}
            defaultValue={THRESHOLD_DEFAULTS.trailingHoldMs}
            step={500}
            min={0}
            max={30000}
            format={v => `${(v / 1000).toFixed(1)}s`}
            onChange={v => setUserTrailingHoldMs(v)}
            onReset={() => setUserTrailingHoldMs(null)}
          />
          <Text style={styles.note}>
            These take effect at the *start* of the next Session — a
            Session already running keeps the values it had at Auto
            Record. Reset returns a knob to the app default.
          </Text>
        </Section>

        <Section title="Detection (read-only)">
          <InfoRow
            k="Warm-up duration"
            v={`${CALIBRATION_DURATION_MS / 1000}s`}
          />
          <InfoRow
            k="Start backward adjust"
            v={`${START_BACKWARD_ADJUSTMENT_S}s`}
          />
          {detectionMode === 'players' && (
            <>
              <InfoRow
                k="Min players in court"
                v={`${MIN_PLAYERS_IN_ROI}`}
              />
              <InfoRow
                k="Person-detector cadence"
                v={`${PERSON_DETECTOR_HZ} Hz`}
              />
            </>
          )}
          <Text style={styles.note}>
            Per ADR-0006 the adaptive baseline learned during Warm-up
            makes the same thresholds work across different gyms; if a
            specific gym keeps misfiring, raise "Open threshold" above
            to filter noise.
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

/**
 * Selectable Mode row. Internal Mode identifier (`'motion'` / `'players'`)
 * is stored in MMKV; UI labels (`Smart` / `Enhanced`) and helper text
 * come from the `labelForMode` / `helperTextForMode` helpers per
 * decisions-log: "Detection Mode names".
 */
function ModeRow({
  value,
  selected,
  onSelect,
}: {
  value: DetectionMode;
  selected: boolean;
  onSelect: (mode: DetectionMode) => void;
}) {
  return (
    <Pressable
      style={[styles.modeRow, selected && styles.modeRowSelected]}
      onPress={() => onSelect(value)}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${labelForMode(value)} mode`}>
      <View style={styles.modeRowText}>
        <Text style={styles.rowLabel}>{labelForMode(value)}</Text>
        <Text style={styles.rowHint}>{helperTextForMode(value)}</Text>
      </View>
      <View
        style={[
          styles.radioDot,
          selected && styles.radioDotSelected,
        ]}
      />
    </Pressable>
  );
}

/**
 * Numeric stepper row for editable detection thresholds. +/- buttons
 * adjust by `step`, clamped between `min` and `max`. A small "default"
 * affordance below the value lets the user revert to the app's built-in
 * value (`null` override stored). The displayed value is always the
 * resolved value (user override if set, otherwise default), so the user
 * never sees stale state after an edit.
 */
function StepperRow({
  label,
  hint,
  value,
  isDefault,
  defaultValue,
  step,
  min,
  max,
  format,
  onChange,
  onReset,
}: {
  label: string;
  hint?: string;
  value: number;
  isDefault: boolean;
  defaultValue: number;
  step: number;
  min: number;
  max: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  onReset: () => void;
}) {
  const dec = () => onChange(Math.max(min, Math.round((value - step) * 10000) / 10000));
  const inc = () => onChange(Math.min(max, Math.round((value + step) * 10000) / 10000));
  return (
    <View style={styles.stepperRow}>
      <View style={styles.stepperText}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint && <Text style={styles.rowHint}>{hint}</Text>}
        {!isDefault && (
          <Pressable onPress={onReset} accessibilityRole="button">
            <Text style={styles.stepperReset}>
              ↺ reset (default {format(defaultValue)})
            </Text>
          </Pressable>
        )}
      </View>
      <View style={styles.stepperControl}>
        <Pressable
          onPress={dec}
          disabled={value <= min}
          style={[
            styles.stepperBtn,
            value <= min && styles.stepperBtnDisabled,
          ]}
          accessibilityRole="button"
          accessibilityLabel={`Decrease ${label}`}>
          <Text style={styles.stepperBtnText}>−</Text>
        </Pressable>
        <Text style={styles.stepperValue}>{format(value)}</Text>
        <Pressable
          onPress={inc}
          disabled={value >= max}
          style={[
            styles.stepperBtn,
            value >= max && styles.stepperBtnDisabled,
          ]}
          accessibilityRole="button"
          accessibilityLabel={`Increase ${label}`}>
          <Text style={styles.stepperBtnText}>+</Text>
        </Pressable>
      </View>
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
  modeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  modeRowSelected: {
    borderColor: colors.actionStart,
    backgroundColor: colors.surfaceSubtle,
  },
  modeRowText: { flex: 1, gap: 2 },
  radioDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: colors.divider,
  },
  radioDotSelected: {
    borderColor: colors.actionStart,
    backgroundColor: colors.actionStart,
  },
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  stepperText: { flex: 1, gap: 2 },
  stepperReset: {
    ...typography.caption,
    color: colors.stateSoft.watching,
    fontSize: 11,
    marginTop: 2,
  },
  stepperControl: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  stepperBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.surfaceSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperBtnDisabled: { opacity: 0.35 },
  stepperBtnText: {
    ...typography.display,
    color: colors.text,
    fontSize: 18,
    lineHeight: 20,
  },
  stepperValue: {
    ...typography.mono,
    color: colors.text,
    minWidth: 56,
    textAlign: 'center',
    fontSize: 13,
  },
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
