import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

/**
 * このビルドの識別子。操作記録に載せる。
 *
 * ホーム画面から開いたままの PWA は何日も読み込み直されないことがあり、
 * 「記録が来ない = 使われていない」のか「古いビルドのまま動いている」のかが
 * 区別できなかった。ビルドした時刻を入れておけば、記録を見るだけで分かる。
 *
 * サーバは screen / name / detail と同じく [A-Za-z0-9_:-] しか受け取らないので、
 * 数字だけの形にしてある(例: 202608231530)。
 */
const APP_VERSION = new Date().toISOString().replace(/\D/g, "").slice(0, 12);

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
});
