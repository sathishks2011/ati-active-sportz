/**
 * About — app metadata + roadmap (M7+ polish).
 *
 * Useful as a place to surface things parents-as-users might want
 * before they trust the app with a 90-minute match: what it does,
 * what it doesn't do (audio off, foreground-only), where Phase 2
 * is headed, and how to find the recordings.
 */

import React from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSessionStore } from '../state/sessionMachine';
import { colors, radii, spacing, typography } from '../design/tokens';

export function AboutScreen() {
  const setAppScreen = useSessionStore(s => s.setAppScreen);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable
          onPress={() => setAppScreen('session')}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Back to Setup">
          <Text style={styles.backBtnText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>About</Text>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.heroBlock}>
          <View style={styles.accentLine} />
          <Text style={styles.brand}>Active Sportz</Text>
          <Text style={styles.tagline}>
            Auto-recorded youth volleyball, with the dead time stripped
            out.
          </Text>
        </View>

        <Section title="What it does">
          <Bullet>
            Records the whole match in one continuous file, then
            produces a single clean Session Recording with only the
            active play.
          </Bullet>
          <Bullet>
            Watches motion inside the court you outline at Setup; opens
            and closes Active Segments automatically.
          </Bullet>
          <Bullet>
            Survives a force-quit mid-match: the next launch silently
            finalizes whatever was captured.
          </Bullet>
        </Section>

        <Section title="What it doesn't do (yet)">
          <Bullet>
            No audio — mic stays off the whole time.
          </Bullet>
          <Bullet>
            Foreground only — locking the phone ends the Session.
            Plug the phone in and leave the app open for long matches.
          </Bullet>
          <Bullet>
            One court at a time. Multiple sports (tennis, basketball,
            pickleball, etc.) are slated for Phase 2.
          </Bullet>
        </Section>

        <Section title="Where to find your recordings">
          <Bullet>
            Spliced Session Recording: Photos app, just like a normal
            video.
          </Bullet>
          <Bullet>
            Continuous Master Recording: kept on this device until you
            tap "Delete Master" in My Sessions. The Session Recording
            stays in Photos either way.
          </Bullet>
        </Section>

        <Section title="Phase 2 roadmap">
          <Bullet>Multiple sports (basketball, tennis, soccer…)</Bullet>
          <Bullet>
            Per-player highlight extraction inside Active Segments
          </Bullet>
          <Bullet>Venue / Camera-Setup memory across Sessions</Bullet>
          <Bullet>Cloud sync and sharing</Bullet>
        </Section>

        <Text style={styles.footer}>MVP build · iOS first</Text>
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

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.bullet}>
      <Text style={styles.bulletDot}>•</Text>
      <Text style={styles.bulletText}>{children}</Text>
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
  scroll: {
    padding: spacing.base,
    paddingBottom: spacing.xxxl,
    gap: spacing.lg,
  },
  heroBlock: {
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
    fontSize: 28,
    letterSpacing: 1.5,
  },
  tagline: {
    ...typography.body,
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    maxWidth: 280,
  },
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
    gap: spacing.sm,
  },
  bullet: { flexDirection: 'row', gap: spacing.sm },
  bulletDot: { color: colors.actionStop, fontSize: 14, lineHeight: 20 },
  bulletText: {
    ...typography.body,
    color: colors.text,
    flex: 1,
    fontSize: 13,
    lineHeight: 20,
  },
  footer: {
    ...typography.caption,
    color: colors.textSubtle,
    textAlign: 'center',
    fontSize: 10,
    marginTop: spacing.md,
  },
});
