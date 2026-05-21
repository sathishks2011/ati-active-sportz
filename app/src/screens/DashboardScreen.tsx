/**
 * Dashboard — the app's home screen.
 *
 * Replaces "first thing the user sees is the camera preview" with a
 * conventional app home: brand block, a few at-a-glance stats, and a
 * single CTA that drops the user into the Session flow. Camera
 * permission is *not* requested here — the prompt is deferred until
 * the user taps Start Recording, so first-time launches are not
 * ambushed by an OS modal.
 *
 * Stats come straight from `sessionRepo`. We recompute them every
 * time the Dashboard becomes visible so newly-finished Sessions show
 * up without a manual refresh. If we get to the point where reading
 * three aggregates on focus is measurable, M5's repo layer is the
 * place to add caching — for now the queries are sub-millisecond.
 */

import React, { useEffect, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useCameraPermission } from 'react-native-vision-camera';
import { DrawerMenu } from '../components/DrawerMenu';
import { useSessionStore } from '../state/sessionMachine';
import {
  countDone,
  listDone,
  mostRecentDone,
  sumActiveSeconds,
  type SessionRow,
} from '../persistence/sessionRepo';
import { countForSession } from '../persistence/segmentRepo';
import { colors, radii, spacing, typography } from '../design/tokens';

type DashboardStats = {
  sessionCount: number;
  activeSeconds: number;
  last: SessionRow | null;
};

type RecentEntry = {
  row: SessionRow;
  segmentCount: number;
};

const RECENT_LIMIT = 3;

function loadStats(): DashboardStats {
  return {
    sessionCount: countDone(),
    activeSeconds: sumActiveSeconds(),
    last: mostRecentDone(),
  };
}

function loadRecent(): RecentEntry[] {
  // listDone returns newest first.
  const rows = listDone().slice(0, RECENT_LIMIT);
  return rows.map(row => ({
    row,
    segmentCount: countForSession(row.id),
  }));
}

export function DashboardScreen() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [stats, setStats] = useState<DashboardStats>(loadStats);
  const [recent, setRecent] = useState<RecentEntry[]>(loadRecent);
  const setAppScreen = useSessionStore(s => s.setAppScreen);
  const sessionState = useSessionStore(s => s.sessionState);
  const reset = useSessionStore(s => s.reset);
  const {
    hasPermission,
    canRequestPermission,
    requestPermission,
  } = useCameraPermission();

  // Refresh whenever the Dashboard becomes the active screen — covers
  // returning from Done, Library, etc. without a manual pull-to-refresh.
  const appScreen = useSessionStore(s => s.appScreen);
  useEffect(() => {
    if (appScreen !== 'dashboard') return;
    setStats(loadStats());
    setRecent(loadRecent());
  }, [appScreen]);

  const onStart = async () => {
    // If a prior Session is still hanging on (e.g., the user is
    // coming back from Done without tapping "New Session"), nuke the
    // store first so we enter Setup with a fresh ROI.
    if (sessionState !== 'Setup') reset();

    if (!hasPermission) {
      if (canRequestPermission) {
        const granted = await requestPermission();
        if (!granted) {
          Alert.alert(
            'Camera permission required',
            'Active Sportz needs camera access to record gameplay. Enable it in Settings → Active Sportz → Camera.',
          );
          return;
        }
      } else {
        Alert.alert(
          'Camera permission needed',
          'Enable camera access in Settings → Active Sportz → Camera, then relaunch.',
        );
        return;
      }
    }
    setAppScreen('session');
  };

  const isFirstRun = stats.sessionCount === 0;

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.headerRow}>
          <Pressable
            style={styles.menuBtn}
            onPress={() => setDrawerOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Open menu">
            <View style={styles.menuIconBar} />
            <View style={styles.menuIconBar} />
            <View style={styles.menuIconBar} />
          </Pressable>
          <View style={styles.headerSpacer} />
        </View>

        <View style={styles.hero}>
          <View style={styles.accentLine} />
          <Text style={styles.brand}>ActiveSportz</Text>
          <Text style={styles.heroTag}>
            {isFirstRun
              ? 'Welcome — let’s record your first match.'
              : 'Frame the court, tap Auto Record, walk away.'}
          </Text>
        </View>

        {isFirstRun ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>How it works</Text>
            <EmptyBullet>
              Outline the court with a quick drag.
            </EmptyBullet>
            <EmptyBullet>
              The app records the whole match without you touching the
              phone.
            </EmptyBullet>
            <EmptyBullet>
              Dead time is stripped automatically — you get one clean
              video.
            </EmptyBullet>
          </View>
        ) : (
          <View style={styles.statsGrid}>
            <StatCard label="Sessions" value={String(stats.sessionCount)} />
            <StatCard
              label="Active gameplay"
              value={formatDuration(stats.activeSeconds)}
            />
            <StatCard
              label="Last session"
              value={
                stats.last
                  ? formatRelative(stats.last.startedAtMs)
                  : '—'
              }
              wide
            />
          </View>
        )}

        <Pressable
          style={styles.ctaBtn}
          onPress={onStart}
          accessibilityRole="button"
          accessibilityLabel="Start Recording a new Session">
          <View style={styles.ctaPlayIcon}>
            <View style={styles.ctaPlayTriangle} />
          </View>
          <Text style={styles.ctaText}>Start Recording</Text>
        </Pressable>
        <Text style={styles.ctaHint}>
          {hasPermission
            ? 'You’ll outline the court next.'
            : 'Camera access will be requested on first start.'}
        </Text>

        {recent.length > 0 && (
          <View style={styles.recentBlock}>
            <View style={styles.recentHeader}>
              <Text style={styles.sectionTitle}>Recent Sessions</Text>
              <Pressable
                onPress={() => setAppScreen('library')}
                accessibilityRole="button"
                accessibilityLabel="See all sessions">
                <Text style={styles.seeAll}>See all ›</Text>
              </Pressable>
            </View>
            {recent.map(entry => (
              <RecentRow key={entry.row.id} entry={entry} />
            ))}
          </View>
        )}
      </ScrollView>
      <DrawerMenu open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </View>
  );
}

function StatCard({
  label,
  value,
  wide,
}: {
  label: string;
  value: string;
  wide?: boolean;
}) {
  return (
    <View style={[styles.statCard, wide && styles.statCardWide]}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

function EmptyBullet({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.emptyBullet}>
      <Text style={styles.emptyBulletDot}>•</Text>
      <Text style={styles.emptyBulletText}>{children}</Text>
    </View>
  );
}

function RecentRow({ entry }: { entry: RecentEntry }) {
  const { row, segmentCount } = entry;
  const started = new Date(row.startedAtMs);
  return (
    <View style={styles.recentRow}>
      <Text style={styles.recentRowTitle}>
        {started.toLocaleDateString()} {started.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })}
      </Text>
      <Text style={styles.recentRowMeta}>
        {segmentCount} segment{segmentCount === 1 ? '' : 's'} ·{' '}
        {row.usedFixedThreshold ? 'fixed' : 'adaptive'}
      </Text>
    </View>
  );
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 1) return '—';
  const t = Math.round(totalSeconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatRelative(atMs: number): string {
  const diffMs = Date.now() - atMs;
  if (diffMs < 60_000) return 'Just now';
  const m = Math.floor(diffMs / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(atMs).toLocaleDateString();
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: {
    padding: spacing.base,
    paddingTop: 60,
    paddingBottom: spacing.xxxl + spacing.xl,
    gap: spacing.xl,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerSpacer: { flex: 1 },
  menuBtn: {
    width: 44,
    height: 44,
    borderRadius: radii.md,
    backgroundColor: colors.surfacePanel,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  menuIconBar: {
    width: 20,
    height: 2,
    borderRadius: 1,
    backgroundColor: colors.text,
  },
  hero: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg,
  },
  accentLine: {
    width: 80,
    height: 2,
    backgroundColor: colors.actionStop,
    borderRadius: radii.sm,
  },
  brand: {
    ...typography.display,
    color: colors.text,
    fontSize: 32,
    letterSpacing: 2,
  },
  heroTag: {
    ...typography.body,
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    maxWidth: 280,
  },

  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  statCard: {
    flexGrow: 1,
    flexBasis: '46%',
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  statCardWide: { flexBasis: '100%' },
  statLabel: {
    ...typography.caption,
    color: colors.textSubtle,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  statValue: {
    ...typography.display,
    color: colors.text,
    fontSize: 22,
    letterSpacing: 0.6,
  },

  emptyCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  emptyTitle: {
    ...typography.bodyEmphasis,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  emptyBullet: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  emptyBulletDot: { color: colors.actionStop, fontSize: 14, lineHeight: 20 },
  emptyBulletText: {
    ...typography.body,
    color: colors.text,
    flex: 1,
    fontSize: 13,
    lineHeight: 20,
  },

  ctaBtn: {
    backgroundColor: colors.actionStop,
    borderRadius: radii.pill,
    paddingVertical: spacing.md + 2,
    paddingHorizontal: spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    shadowColor: colors.actionStop,
    shadowOpacity: 0.45,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  ctaPlayIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaPlayTriangle: {
    width: 0,
    height: 0,
    borderLeftWidth: 9,
    borderTopWidth: 6,
    borderBottomWidth: 6,
    borderRightWidth: 0,
    borderLeftColor: colors.text,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    marginLeft: 2,
  },
  ctaText: {
    ...typography.display,
    color: colors.actionText,
    fontSize: 17,
    letterSpacing: 1.2,
  },
  ctaHint: {
    ...typography.caption,
    color: colors.textSubtle,
    fontSize: 11,
    textAlign: 'center',
  },

  recentBlock: { gap: spacing.sm },
  recentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionTitle: {
    ...typography.caption,
    color: colors.textSubtle,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  seeAll: {
    ...typography.bodyEmphasis,
    color: colors.stateSoft.watching,
    fontSize: 12,
  },
  recentRow: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
  },
  recentRowTitle: {
    ...typography.bodyEmphasis,
    color: colors.text,
    fontSize: 13,
  },
  recentRowMeta: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
});
