/**
 * Splash screen — brand-first landing shown during app boot.
 *
 * Wraps the post-launch app for as long as it takes for (a) a short
 * branded beat to elapse and (b) the M5 crash-recovery sweep to finish.
 * The recovery sweep used to live under its own bare loader in
 * App.tsx; folding it into the splash means recovery feels like part
 * of normal boot rather than an extra screen.
 *
 * Visual composition:
 *   - Dark background with a faint scatter of person-doing-sports
 *     glyphs at very low opacity standing in for "players playing"
 *     imagery. No image asset is required, so the iOS pod list and
 *     asset catalog stay untouched. (If you later drop a photographic
 *     backdrop into ios/.../Images.xcassets, swap the SportFigures
 *     component for an `<Image source={require(...)}>`.)
 *   - A single large hexagon centered on the screen — the
 *     "ActiveSportz" brand mark sits inside it as a watermark.
 *   - A subtle fade-up animation on the hexagon block so the splash
 *     feels intentional rather than static.
 *   - Bottom row of sport-ball glyphs over a "Volleyball today ·
 *     more sports coming" caption, signalling the Phase-2 multi-sport
 *     expansion that CONTEXT.md flags. MVP itself remains
 *     volleyball-only.
 */

import React, { useEffect, useRef } from 'react';
import {
  Animated,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { colors, radii, spacing, typography } from '../design/tokens';

const HEX_GLYPH = '⬢';
const TAGLINE = 'Auto-recorded gameplay — no manual cuts.';
const SPORT_BALL_GLYPHS = ['🏐', '🎾', '🏀', '⚽'];
// People-doing-sport glyphs render as actual player silhouettes on iOS.
// Coordinates are normalized (0..1) so the layout scales with window size.
// Roughly arranged around the periphery, leaving the centered hexagon
// visually uncluttered.
const SPORT_FIGURES: Array<{
  glyph: string;
  x: number;
  y: number;
  size: number;
  rotation?: number;
}> = [
  { glyph: '🤾', x: 0.12, y: 0.16, size: 56, rotation: -10 }, // handball
  { glyph: '⛹️', x: 0.82, y: 0.18, size: 56, rotation: 12 }, // basketball
  { glyph: '🎾', x: 0.18, y: 0.34, size: 36, rotation: 6 },
  { glyph: '🏐', x: 0.78, y: 0.36, size: 38, rotation: -8 },
  { glyph: '🤸', x: 0.1, y: 0.7, size: 52, rotation: 4 }, // cartwheel
  { glyph: '🏃', x: 0.82, y: 0.66, size: 50, rotation: -6 }, // running
  { glyph: '🏃‍♀️', x: 0.5, y: 0.86, size: 44 },
];

export function SplashScreen({ subText }: { subText?: string }) {
  const { width: W, height: H } = useWindowDimensions();
  // Hex sized to a comfortable proportion of the shorter window edge so
  // it lands big on phones in either orientation.
  const hexSize = Math.min(W, H) * 0.86;

  const opacity = useRef(new Animated.Value(0)).current;
  const lift = useRef(new Animated.Value(8)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 350,
        useNativeDriver: true,
      }),
      Animated.timing(lift, {
        toValue: 0,
        duration: 400,
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, lift]);

  return (
    <View style={styles.root}>
      <SportFigures W={W} H={H} />
      <View style={styles.centerColumn} pointerEvents="none">
        <Animated.View
          style={[
            styles.hexBlock,
            {
              opacity,
              transform: [{ translateY: lift }],
              width: hexSize,
              height: hexSize,
            },
          ]}>
          {/* The hexagon itself: a single very-large Unicode glyph
              tinted in the brand orange at low opacity, with the
              wordmark overlaid in the geometric center. */}
          <Text
            style={[
              styles.hexShape,
              { fontSize: hexSize, lineHeight: hexSize },
            ]}>
            {HEX_GLYPH}
          </Text>
          <View style={styles.watermarkBlock}>
            <View style={styles.accentLine} />
            <Text style={styles.watermark}>ActiveSportz</Text>
            <Text style={styles.tagline}>{TAGLINE}</Text>
            <View style={styles.accentLine} />
          </View>
        </Animated.View>
      </View>
      <View style={styles.bottomColumn} pointerEvents="none">
        <View style={styles.sportRow}>
          {SPORT_BALL_GLYPHS.map((g, i) => (
            <Text key={i} style={styles.sportBallGlyph}>
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

function SportFigures({ W, H }: { W: number; H: number }) {
  return (
    <View style={figureStyles.root} pointerEvents="none">
      {SPORT_FIGURES.map((f, i) => (
        <Text
          key={i}
          style={[
            figureStyles.figure,
            {
              left: f.x * W - f.size / 2,
              top: f.y * H - f.size / 2,
              fontSize: f.size,
              lineHeight: f.size * 1.1,
              transform: f.rotation ? [{ rotate: `${f.rotation}deg` }] : [],
            },
          ]}>
          {f.glyph}
        </Text>
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
  },
  hexBlock: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  hexShape: {
    position: 'absolute',
    color: colors.actionStop, // warm brand orange
    opacity: 0.22,
    textAlign: 'center',
  },
  watermarkBlock: {
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
  },
  accentLine: {
    width: 80,
    height: 2,
    backgroundColor: colors.actionStop,
    borderRadius: radii.sm,
  },
  watermark: {
    ...typography.display,
    color: colors.text,
    fontSize: 36,
    letterSpacing: 2.5,
  },
  tagline: {
    ...typography.body,
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    maxWidth: 240,
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
  sportBallGlyph: {
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

const figureStyles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFill,
    opacity: 0.12,
  },
  figure: {
    position: 'absolute',
  },
});
