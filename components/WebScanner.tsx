import { StyleSheet, View } from "react-native";

import { GAS_STATION_URL } from "@/constants/config";

/**
 * Mobile-web path. The decoder page is rendered in a same-origin iframe
 * rather than injected directly into the React tree, because it owns
 * <video>/<canvas> elements and a getUserMedia() camera flow that are
 * simplest to keep exactly as authored (see public/decoder.html), rather
 * than ported into React state. A same-origin iframe still gets camera
 * access on a page served over HTTPS, same as the top-level document
 * would.
 *
 * decoder.html reads window.__GOOSE_PAINT_CONFIG__, which it can't get
 * from a prop since it's loaded as a static file, not inlined — so the
 * gas-station URL is passed as a query param and decoder.html's own
 * bootstrap script (see bottom of the file) sets the global from that.
 */
export default function WebScanner({ html: _html }: { html: string }) {
  const params = new URLSearchParams(window.location.search);
  params.set("apiBase", GAS_STATION_URL);
  const src = "/decoder.html?" + params.toString();

  return (
    <View style={styles.fill}>
      <iframe
        title="Goose Paint Scanner"
        src={src}
        allow="camera; clipboard-write"
        style={frameStyle}
      />
    </View>
  );
}

const frameStyle: React.CSSProperties = {
  border: "none",
  width: "100%",
  height: "100%",
  backgroundColor: "#08090e",
};

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#08090e" },
});
