/**
 * Splash screen — brand-first landing shown during app boot.
 *
 * Wraps the post-launch app for as long as it takes for (a) a short
 * branded beat to elapse and (b) the M5 crash-recovery sweep to finish.
 * The recovery sweep used to live under its own bare loader in
 * App.tsx; folding it into the splash means recovery feels like part
 * of normal boot rather than an extra screen.
 *
 * Visual: dark background with an orange-tinted honeycomb pattern
 * (Unicode hex glyphs in a staggered grid — no SVG or image assets so
 * the iOS pod list stays unchanged). The wordmark sits centered with
 * a thin orange accent line. Below: a "Volleyball today, more sports
 * coming" line with a row of sport-ball glyphs as a visual tease for
 * the Phase-2 multi-sport expansion called out in CONTEXT.md. The
 * MVP itself remains volleyball-only.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '../design/tokens';

const HEX_GLYPH = '⬢'; // ⬢
const HEX_ROWS = 16;
const HEX_COLS = 9;

const TAGLINE = 'Auto-recorded gameplay — no manual cuts.';
const SPORT_GLYPHS = ['🏐', '🎾', '🏀', '⚽'];
// 🏐 🎾 🏀 ⚽

export function SplashScreen({ subText }: { subText?: string }) {
  // Subtle fade-up on the wordmark so the splash feels intentional
  // rather than static. Cheap, native-driven.
  const wordmarkOpacity = useRef(new Animated.Value(0)).current;
  const wordmarkLift = useRef(new Animated.Value(8)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(wordmarkOpacity, {
        toValue: 1,
        duration: 350,
        useNativeDriver: true,
      }),
      Animated.timing(wordmarkLift, {
        toValue: 0,
        duration: 400,
        useNativeDriver: true,
      }),
    ]).start();
  }, [wordmarkLift, wordmarkOpacity]);

  return (
    <View style={styles.root}>
      <HexPattern />
      <View style={styles.centerColumn} pointerEvents="none">
        <Animated.View
          style={[
            styles.wordmarkBlock,
            {
              opacity: wordmarkOpacity,
              transform: [{ translateY: wordmarkLift }],
            },
          ]}>
          <View style={styles.accentLine} />
          <Text style={styles.wordmark}>Active Sportz</Text>
          <View style={styles.accentLine} />
          <Text style={styles.tagline}>{TAGLINE}</Text>
        </Animated.View>
      </View>
      <View style={styles.bottomColumn} pointerEvents="none">
        <View style={styles.sportRow}>
          {SPORT_GLYPHS.map((g, i) => (
            <Text key={i} style={styles.sportGlyph}>
              {g}
            </Text>
          ))}
        </View>
        <Text style={styles.sportNote}>
          Volleyball today · more sports coming
        </Text>
        {subText && <Text style={styles.subText}>{subText}</Text>}
      </View>
    </View>
  );
}

function HexPattern() {
  return (
    <View style={hexStyles.fill} pointerEvents="none">
      {Array.from({ length: HEX_ROWS }, (_unused, r) => (
        <View
          key={r}
          style={[hexStyles.row, r % 2 === 1 && hexStyles.rowOffset]}>
          {Array.from({ length: HEX_COLS }, (_unusedCell, c) => (
            <Text
              key={c}
              style={[
                hexStyles.hex,
                // Random-ish per-cell intensity for visual texture
                // without an actual RNG (deterministic so reload is stable).
                ((r * 7 + c * 13) % 5 === 0) && hexStyles.hexAccent,
              ]}>
              {HEX_GLYPH}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.bg,
  },
  centerColumn: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  wordmarkBlock: {
    alignItems: 'center',
    gap: spacing.md,
  },
  accentLine: {
    width: 120,
    height: 2,
    backgroundColor: colors.actionStop, // warm orange accent
    borderRadius: radii.sm,
  },
  wordmark: {
    ...typography.display,
    color: colors.text,
    fontSize: 38,
    letterSpacing: 2,
  },
  tagline: {
    ...typography.body,
    color: colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    maxWidth: 280,
  },
  bottomColumn: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: spacing.xxxl,
    alignItems: 'center',
    gap: spacing.sm,
  },
  sportRow: {
    flexDirection: 'row',
    gap: spacing.lg,
  },
  sportGlyph: {
    fontSize: 28,
    opacity: 0.85,
  },
  sportNote: {
    ...typography.caption,
    color: colors.textSubtle,
    fontSize: 11,
    letterSpacing: 0.6,
  },
  subText: {
    ...typography.body,
    color: colors.textSubtle,
    fontSize: 12,
    marginTop: spacing.md,
    textAlign: 'center',
  },
});

const hexStyles = StyleSheet.create({
  fill: {
    ...StyleSheet.absoluteFill,
    overflow: 'hidden',
    opacity: 0.18,
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 14,
  },
  rowOffset: {
    marginLeft: 22,
  },
  hex: {
    fontSize: 40,
    color: colors.stateSoft.calibrating, // muted amber-orange
    lineHeight: 44,
  },
  hexAccent: {
    color: colors.actionStop, // bright orange highlight on ~20% of cells
    opacity: 1,
  },
});
