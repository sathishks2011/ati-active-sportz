/**
 * Slide-in drawer menu (M7+ polish).
 *
 * A traditional left-side hamburger drawer. Triggered by the menu
 * icon on the Setup screen; tapping a backdrop area closes it.
 *
 * Routing pivot: each item flips `sessionMachine.appScreen` to the
 * matching destination ('session' returns to the active Setup /
 * Recording / Done flow). The drawer itself is gated on `open` so
 * the camera preview behind it is untouched while closed.
 *
 * No new native deps — the slide animation is `Animated.timing` on
 * `translateX` and the backdrop is a plain `Pressable`. Width is
 * 80% of the screen so even on narrow devices the items stay
 * comfortably finger-sized.
 */

import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  useSessionStore,
  type AppScreen,
} from '../state/sessionMachine';
import {
  colors,
  motion as motionTokens,
  radii,
  spacing,
  typography,
} from '../design/tokens';

type Item = {
  key: AppScreen;
  label: string;
  hint?: string;
};

const ITEMS: Item[] = [
  { key: 'session', label: 'New Session', hint: 'Frame a court and tap Auto Record' },
  { key: 'library', label: 'My Sessions', hint: 'Past recordings and Master retention' },
  { key: 'settings', label: 'Settings', hint: 'Detection and Warm-up preferences' },
  { key: 'about', label: 'About', hint: 'App info and roadmap' },
];

export function DrawerMenu({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { width: W } = useWindowDimensions();
  const drawerWidth = Math.min(320, W * 0.8);
  const translateX = useRef(new Animated.Value(-drawerWidth)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const setAppScreen = useSessionStore(s => s.setAppScreen);
  const reset = useSessionStore(s => s.reset);
  const sessionState = useSessionStore(s => s.sessionState);
  const appScreen = useSessionStore(s => s.appScreen);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(translateX, {
        toValue: open ? 0 : -drawerWidth,
        duration: motionTokens.normal,
        useNativeDriver: true,
      }),
      Animated.timing(backdropOpacity, {
        toValue: open ? 1 : 0,
        duration: motionTokens.normal,
        useNativeDriver: true,
      }),
    ]).start();
  }, [open, drawerWidth, translateX, backdropOpacity]);

  const onSelect = (item: Item) => {
    // "New Session" is the natural reset: drop the current ROI /
    // segment buffer / done info so the user lands on Setup Step 1.
    // Other items just pivot the appScreen — the underlying Session
    // state is preserved so a running Session keeps recording even
    // while the user reads About or Settings (paranoid but right —
    // we don't want a stray tap to end a match).
    if (item.key === 'session') {
      // Only reset if not currently recording — interrupting a live
      // Session via the menu would be a footgun.
      if (sessionState === 'Setup' || sessionState === 'Done') {
        reset();
      }
      setAppScreen('session');
    } else {
      setAppScreen(item.key);
    }
    onClose();
  };

  return (
    <View
      style={[styles.root, !open && styles.rootClosed]}
      pointerEvents={open ? 'auto' : 'none'}>
      <Animated.View
        style={[styles.backdrop, { opacity: backdropOpacity }]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityLabel="Close menu"
        />
      </Animated.View>
      <Animated.View
        style={[
          styles.drawer,
          { width: drawerWidth, transform: [{ translateX }] },
        ]}>
        <View style={styles.brandBlock}>
          <Text style={styles.brandText}>Active Sportz</Text>
          <Text style={styles.brandSub}>Auto-recorded gameplay</Text>
        </View>
        <View style={styles.items}>
          {ITEMS.map(item => {
            const isActive =
              (item.key === 'session' && appScreen === 'session') ||
              (item.key !== 'session' && appScreen === item.key);
            return (
              <Pressable
                key={item.key}
                style={[styles.item, isActive && styles.itemActive]}
                onPress={() => onSelect(item)}
                accessibilityRole="button"
                accessibilityLabel={item.label}
                accessibilityState={{ selected: isActive }}>
                <Text style={styles.itemLabel}>{item.label}</Text>
                {item.hint && (
                  <Text style={styles.itemHint}>{item.hint}</Text>
                )}
              </Pressable>
            );
          })}
        </View>
        <View style={styles.footer}>
          <Text style={styles.footerLabel}>Sport</Text>
          <Text style={styles.footerValue}>Volleyball</Text>
          <Text style={styles.footerNote}>More sports in Phase 2</Text>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFill, zIndex: 50 },
  rootClosed: {
    // When closed the drawer view should never block touches on the
    // underlying screen, even if it's still in the DOM.
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
  drawer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.surface,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    paddingTop: 80,
    paddingBottom: spacing.xl,
    paddingHorizontal: spacing.lg,
    gap: spacing.xl,
  },
  brandBlock: {
    gap: spacing.xs,
    paddingBottom: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  brandText: {
    ...typography.display,
    color: colors.text,
    fontSize: 20,
    letterSpacing: 1.5,
  },
  brandSub: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 11,
  },
  items: { gap: spacing.xs, flex: 1 },
  item: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
  },
  itemActive: {
    backgroundColor: colors.surfaceSubtle,
  },
  itemLabel: {
    ...typography.bodyEmphasis,
    color: colors.text,
    fontSize: 16,
  },
  itemHint: {
    ...typography.caption,
    color: colors.textSubtle,
    fontSize: 11,
    marginTop: 2,
  },
  footer: {
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.xs / 2,
  },
  footerLabel: {
    ...typography.caption,
    color: colors.textSubtle,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  footerValue: {
    ...typography.bodyEmphasis,
    color: colors.text,
    fontSize: 14,
  },
  footerNote: {
    ...typography.caption,
    color: colors.textSubtle,
    fontSize: 10,
  },
});
