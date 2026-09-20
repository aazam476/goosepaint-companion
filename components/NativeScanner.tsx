import { StyleSheet } from "react-native";
import { WebView } from "react-native-webview";
import { SafeAreaView } from "react-native-safe-area-context";

type AndroidPermissionRequestEvent = {
  grant: (resources: readonly string[]) => void;
  resources: readonly string[];
};

/**
 * iOS / Android path. The decoder page (camera + homography + Tesseract
 * OCR + gas-station submit, all unmodified from public/decoder.html) runs
 * inside a WebView. originWhitelist + the camera permission flags below
 * are what let getUserMedia() work inside the WebView instead of failing
 * with a permissions error, which is the normal WebView default.
 */
export default function NativeScanner({ html }: { html: string }) {
  return (
    <SafeAreaView style={styles.fill} edges={["top", "bottom"]}>
      <WebView
        source={{ html }}
        style={styles.fill}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        // Android: without this, getUserMedia() rejects even after the
        // OS-level camera permission is granted, because WebView gates
        // media capture behind its own onPermissionRequest callback.
        onPermissionRequest={(event: AndroidPermissionRequestEvent) =>
          event.grant(event.resources)
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#08090e" },
});
