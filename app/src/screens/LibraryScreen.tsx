/**
 * Library screen — "My Sessions" listing (M5, ADR-0007).
 *
 * Shows every Session that has reached `done` in DB, newest first.
 * Each row surfaces:
 *   - Start timestamp (the only date label parents will read at a glance).
 *   - Duration of the Session Recording vs the Master.
 *   - Number of Active Segments + detection mode (adaptive / fixed).
 *   - "Delete Master Recording" action — only when the Master file is
 *     still on disk; clears the path in DB and removes the file. The
 *     Session Recording in Photos is unaffected; the library entry
 *     remains as a record that the Session happened.
 *
 * Tap a row → no-op for M5. M6/M7 may add in-app playback or an
 * "open in Photos" affordance.
 */

import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  Alert,
} from 'react-native';
import { useSessionStore } from '../state/sessionMachine';
import { colors, radii, spacing, typography } from '../design/tokens';
import {
  clearMasterUri,
  listDone,
  type SessionRow,
} from '../persistence/sessionRepo';
import { countForSession } from '../persistence/segmentRepo';
import { deleteFile, fileExists } from '../native/Splicer';

type LibraryEntry = {
  row: SessionRow;
  segmentCount: number;
  masterOnDisk: boolean;
};

// How long the Recent-Sessions arrival highlight stays on a card before
// it fades back to the default border. Long enough to register, short
// enough that the user isn't stuck looking at a "selected" row.
const FOCUS_HIGHLIGHT_MS = 2_500;

export function LibraryScreen() {
  const setAppScreen = useSessionStore(s => s.setAppScreen);
  const focusedSessionId = useSessionStore(s => s.focusedSessionId);
  const setFocusedSessionId = useSessionStore(s => s.setFocusedSessionId);
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // Local highlight state — initialized once from the store's
  // `focusedSessionId` and cleared after FOCUS_HIGHLIGHT_MS. Holding
  // a local copy means the timeout can also clear the store value
  // (so re-visiting the Library doesn't re-highlight a stale row)
  // while keeping the highlight visible for the full duration.
  const [highlightId, setHighlightId] = useState<number | null>(
    focusedSessionId,
  );

  const refresh = async () => {
    setLoading(true);
    const rows = listDone();
    const enriched = await Promise.all(
      rows.map(async row => {
        const segmentCount = countForSession(row.id);
        const masterOnDisk =
          row.masterUri != null ? await fileExists(row.masterUri) : false;
        return { row, segmentCount, masterOnDisk };
      }),
    );
    setEntries(enriched);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (highlightId == null) return;
    const t = setTimeout(() => {
      setHighlightId(null);
      setFocusedSessionId(null);
    }, FOCUS_HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [highlightId, setFocusedSessionId]);

  const onDeleteMaster = (entry: LibraryEntry) => {
    if (entry.row.masterUri == null) return;
    Alert.alert(
      'Delete Master Recording?',
      'The Session Recording in Photos will stay. The original continuous Master file will be removed from this device. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteFile(entry.row.masterUri!);
              clearMasterUri(entry.row.id);
              refresh();
            } catch (e: any) {
              Alert.alert(
                'Could not delete Master',
                e?.message ?? String(e),
              );
            }
          },
        },
      ],
    );
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable
          onPress={() => {
            setFocusedSessionId(null);
            setAppScreen('dashboard');
          }}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Back to Dashboard">
          <Text style={styles.backBtnText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>My Sessions</Text>
        <View style={styles.headerSpacer} />
      </View>
      {loading ? (
        <Text style={styles.empty}>Loading…</Text>
      ) : entries.length === 0 ? (
        <Text style={styles.empty}>
          No Sessions yet. Tap “New Session” to record one.
        </Text>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {entries.map(entry => (
            <SessionCard
              key={entry.row.id}
              entry={entry}
              highlighted={entry.row.id === highlightId}
              onDeleteMaster={() => onDeleteMaster(entry)}
            />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function SessionCard({
  entry,
  highlighted,
  onDeleteMaster,
}: {
  entry: LibraryEntry;
  highlighted: boolean;
  onDeleteMaster: () => void;
}) {
  const { row, segmentCount, masterOnDisk } = entry;
  const started = new Date(row.startedAtMs);
  const ended = row.endedAtMs != null ? new Date(row.endedAtMs) : null;
  const wallS = ended ? (row.endedAtMs! - row.startedAtMs) / 1000 : null;
  return (
    <View style={[styles.card, highlighted && styles.cardHighlighted]}>
      <Text style={styles.cardTitle}>
        {started.toLocaleDateString()} {started.toLocaleTimeString()}
      </Text>
      <Text style={styles.cardMeta}>
        {wallS != null ? `${wallS.toFixed(0)}s recorded · ` : ''}
        {segmentCount} segment{segmentCount === 1 ? '' : 's'} ·{' '}
        {row.usedFixedThreshold ? 'fixed-threshold' : 'adaptive'}
      </Text>
      <Text style={styles.cardUri} numberOfLines={1}>
        Session: {row.sessionUri ?? '(missing)'}
      </Text>
      <Text style={styles.cardUri} numberOfLines={1}>
        Master:{' '}
        {row.masterUri == null
          ? '(deleted)'
          : masterOnDisk
            ? row.masterUri
            : `${row.masterUri} (file missing)`}
      </Text>
      {row.masterUri != null && masterOnDisk && (
        <Pressable
          style={styles.deleteBtn}
          onPress={onDeleteMaster}
          accessibilityRole="button"
          accessibilityLabel="Delete Master Recording, keep Session Recording">
          <Text style={styles.deleteBtnText}>
            Delete Master (keep Session)
          </Text>
        </Pressable>
      )}
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
  backBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  backBtnText: {
    ...typography.bodyEmphasis,
    color: colors.text,
  },
  title: {
    ...typography.heading,
    color: colors.text,
    flex: 1,
    textAlign: 'center',
  },
  headerSpacer: { width: 60 },
  empty: {
    ...typography.body,
    color: colors.textSubtle,
    textAlign: 'center',
    marginTop: spacing.xxxl,
  },
  list: {
    padding: spacing.base,
    gap: spacing.md,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  cardHighlighted: {
    borderColor: colors.actionStop,
    // Same warm tint as the ROI-capturing fill so the highlight feels
    // like a brand-consistent "this is the thing you tapped" cue
    // rather than a generic selection.
    backgroundColor: colors.roiCapturingFill,
  },
  cardTitle: {
    ...typography.bodyEmphasis,
    color: colors.text,
  },
  cardMeta: {
    ...typography.caption,
    color: colors.textMuted,
  },
  cardUri: {
    ...typography.caption,
    color: colors.textSubtle,
    fontSize: 10,
    fontFamily: 'Menlo',
  },
  deleteBtn: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceSubtle,
  },
  deleteBtnText: {
    ...typography.caption,
    color: colors.stateSoft.capturing,
    fontSize: 11,
    textTransform: 'uppercase',
  },
});
