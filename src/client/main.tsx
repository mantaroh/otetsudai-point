import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { startTelemetry } from "./lib/telemetry";
import { PinProvider } from "./pin";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 認証エラーを何度も叩き直さない。UI 側で分岐する。
      retry: false,
      refetchOnWindowFocus: true,
    },
  },
});

/**
 * Service Worker はビルドしたものにだけ入れる。
 * 開発中に登録されていると、直したはずの画面が古いまま出て混乱するため。
 */
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // 登録できなくてもアプリは普通に動く。オフライン表示が効かないだけ。
    });
  });
}

/**
 * 画面の操作記録を開始する。
 *
 * ここでしか呼ばない。画面テストは main.tsx を通らないので、
 * テスト中に記録の通信が走ることはない。
 * 家庭の設定で止めている場合は、App が受け取った設定で切る。
 */
startTelemetry();

const container = document.getElementById("root");
if (!container) throw new Error("#root が見つかりません");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <PinProvider>
        <App />
      </PinProvider>
    </QueryClientProvider>
  </StrictMode>,
);
