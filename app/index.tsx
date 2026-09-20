import { Platform, StyleSheet, View } from "react-native";
import { useEffect, useMemo, useState } from "react";

import { DECODER_HTML } from "@/constants/decoderHtml";
import { GAS_STATION_URL } from "@/constants/config";

/**
 * Injects config the decoder page needs (the gas-station endpoint) before
 * it runs, without hand-editing the HTML string, and works whether the
 * page renders in a native WebView or directly in a browser tab.
 */
function withInjectedConfig(html: string, apiBase: string): string {
  const configScript = `<script>window.__GOOSE_PAINT_CONFIG__ = ${JSON.stringify({
    apiBase,
  })};</script>`;
  return html.replace("</head>", `${configScript}</head>`);
}

/**
 * Best-effort touch/mobile detection for the web build. There is no
 * perfect signal, so this combines two: a small viewport (phones/tablets
 * in portrait or landscape) and a mobile-flavored user agent. Either one
 * alone gives false positives (a narrow desktop window; a UA string that
 * lies), so mobile is declared only when at least one strong signal is
 * present AND the viewport isn't clearly desktop-sized.
 */
function isMobileWeb(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") {
    return false;
  }
  const ua = navigator.userAgent || "";
  const uaIsMobile = /Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini/i.test(ua);
  const uaIsIpadDesktopMode =
    /Macintosh/i.test(ua) && "ontouchend" in document; // iPadOS Safari reports as Mac
  const narrowViewport = window.innerWidth <= 900;
  const hasCoarsePointer =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;

  if (uaIsMobile || uaIsIpadDesktopMode) return true;
  return narrowViewport && hasCoarsePointer;
}

export default function Index() {
  const html = useMemo(() => withInjectedConfig(DECODER_HTML, GAS_STATION_URL), []);

  if (Platform.OS !== "web") {
    // iOS / Android: always the scanner, loaded through a WebView so the
    // existing camera + homography + Tesseract OCR code runs unmodified.
    // Lazy-required so react-native-webview never loads on the web bundle.
    const { default: NativeScanner } = require("@/components/NativeScanner");
    return <NativeScanner html={html} />;
  }

  return <WebEntry html={html} />;
}

function WebEntry({ html }: { html: string }) {
  const [mobile, setMobile] = useState<boolean | null>(null);

  useEffect(() => {
    setMobile(isMobileWeb());
    const onResize = () => setMobile(isMobileWeb());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (mobile === null) {
    // Avoid a flash of the wrong page while we check.
    return <View style={styles.fill} />;
  }

  if (!mobile) {
    const { default: DesktopHandoff } = require("@/components/DesktopHandoff");
    return <DesktopHandoff />;
  }

  const { default: WebScanner } = require("@/components/WebScanner");
  return <WebScanner html={html} />;
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#0e1015" },
});
