import { StyleSheet, Text, View } from "react-native";

/**
 * Shown when the web build is opened on a desktop-sized, non-touch
 * browser. Goose Paint needs a real camera pointed at a physical badge
 * screen, which desktop browsers generally can't offer the way a phone
 * can, so desktop visitors are told to switch devices instead of hitting
 * a broken camera permission prompt.
 */
export default function DesktopHandoff() {
  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.dot} />
          <Text style={styles.brand}>GOOSE//PAINT</Text>
        </View>
        <Text style={styles.status}>STANDBY · DESKTOP CLIENT DETECTED</Text>
      </View>

      <View style={styles.main}>
        <View style={styles.iconWrap}>
          <Text style={styles.iconGlyph}>📱</Text>
        </View>

        <View style={styles.tag}>
          <Text style={styles.tagText}>HANDOFF REQUIRED</Text>
        </View>

        <Text style={styles.headline}>Please switch to mobile to continue</Text>

        <Text style={styles.subtitle}>
          Goose Paint Decoder requires mobile camera hardware for badge
          optical scanning. Open this page on your phone to scan a badge,
          or paste a raw code if you already have one.
        </Text>
      </View>

      <View style={styles.footer} />
    </View>
  );
}

const PRIMARY = "#4edea3";

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0e1015",
    paddingHorizontal: 24,
    paddingVertical: 32,
    justifyContent: "space-between",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: PRIMARY,
  },
  brand: {
    color: "#d4d4d8",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 2,
  },
  status: {
    color: "#71717a",
    fontSize: 10,
    letterSpacing: 1,
  },
  main: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 18,
    maxWidth: 480,
    alignSelf: "center",
  },
  iconWrap: {
    width: 96,
    height: 96,
    borderRadius: 24,
    backgroundColor: "rgba(39,39,42,0.8)",
    borderWidth: 1,
    borderColor: "rgba(82,82,91,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  iconGlyph: { fontSize: 40 },
  tag: {
    borderWidth: 1,
    borderColor: "rgba(16,185,129,0.2)",
    backgroundColor: "rgba(16,185,129,0.05)",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  tagText: {
    color: PRIMARY,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 1.5,
  },
  headline: {
    color: "#ffffff",
    fontSize: 30,
    fontWeight: "700",
    textAlign: "center",
    lineHeight: 36,
  },
  subtitle: {
    color: "#a1a1aa",
    fontSize: 15,
    textAlign: "center",
    lineHeight: 22,
  },
  footer: { height: 1 },
});
