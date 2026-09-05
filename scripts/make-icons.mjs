/**
 * アプリアイコンを生成する。
 *
 *   node scripts/make-icons.mjs
 *
 * 画像を1枚ずつ手で置くと、色を変えたときに揃わなくなる。
 * 台紙にシールを1枚貼った絵を、コードから描いて public/icons/ に書き出す。
 * 依存は node の zlib だけ(PNG を自前で組み立てている)。
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

// styles.css のテーマ色に合わせる
const PAPER = [0xfd, 0xf7, 0xec];
const ACCENT = [0xf2, 0x99, 0x4a];
const GOLD = [0xe8, 0xb6, 0x4c];
const LINE = [0xe5, 0xd8, 0xc0];

/**
 * 星の内側判定。
 * 外接円 R の 5 芒星を、10 頂点の多角形として持って点が内側かを見る。
 */
function starPolygon(cx, cy, outer, points = 5) {
  const inner = outer * 0.44;
  const vertices = [];
  for (let i = 0; i < points * 2; i++) {
    const radius = i % 2 === 0 ? outer : inner;
    // 頂点がまっすぐ上を向くように -90 度回す
    const angle = (Math.PI * i) / points - Math.PI / 2;
    vertices.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  return vertices;
}

function isInside(polygon, x, y) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * @param size    出力する一辺のピクセル数
 * @param padding 端からの余白の割合。マスカブルアイコンでは大きめに取る
 */
function drawIcon(size, padding) {
  const pixels = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const content = size * (1 - padding * 2);

  // 台紙(角丸の四角)と、その上のシール1枚
  const cardRadius = content / 2;
  const cardCorner = content * 0.22;
  const stickerRadius = content * 0.3;
  const star = starPolygon(center, center, stickerRadius * 0.62);

  const SAMPLES = 3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const px = x + (sx + 0.5) / SAMPLES;
          const py = y + (sy + 0.5) / SAMPLES;
          const sample = shade(px, py);
          r += sample[0];
          g += sample[1];
          b += sample[2];
          a += sample[3];
        }
      }

      const total = SAMPLES * SAMPLES;
      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(r / total);
      pixels[offset + 1] = Math.round(g / total);
      pixels[offset + 2] = Math.round(b / total);
      pixels[offset + 3] = Math.round(a / total);
    }
  }

  function shade(px, py) {
    // 角丸四角の内側か(角は円で判定)
    const dx = Math.abs(px - center);
    const dy = Math.abs(py - center);
    const half = cardRadius;
    const inner = half - cardCorner;
    const outsideCard =
      dx > half ||
      dy > half ||
      (dx > inner && dy > inner && Math.hypot(dx - inner, dy - inner) > cardCorner);
    if (outsideCard) return [PAPER[0], PAPER[1], PAPER[2], 255];

    // 台紙の縁を少しだけ濃くして、紙の厚みを出す
    const edge = Math.max(dx, dy) > half - size * 0.012;
    const card = edge ? mix([0xff, 0xfd, 0xf8], LINE, 0.8) : [0xff, 0xfd, 0xf8];

    const distance = Math.hypot(px - center, py - center);
    if (distance > stickerRadius) return [card[0], card[1], card[2], 255];

    // シール本体。中心をわずかに明るくして丸みを出す
    const sticker = mix(GOLD, ACCENT, Math.min(1, distance / stickerRadius));
    if (isInside(star, px, py)) return [0xff, 0xff, 0xff, 255];
    return [sticker[0], sticker[1], sticker[2], 255];
  }

  return pixels;
}

// ── PNG の組み立て ────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // ビット深度
  header[9] = 6; // RGBA
  // 10..12 は圧縮・フィルタ・インタレースの既定値(0)

  // 各行の先頭にフィルタ種別のバイトを置く
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const from = y * size * 4;
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, from, from + size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── 書き出し ──────────────────────────────────

const TARGETS = [
  { file: "icon-192.png", size: 192, padding: 0.06 },
  { file: "icon-512.png", size: 512, padding: 0.06 },
  // マスカブルは端が切られるので、安全域を大きく取る
  { file: "icon-maskable-512.png", size: 512, padding: 0.18 },
  // iOS のホーム画面用。角丸は OS 側が付けるので余白は小さめ
  { file: "apple-touch-icon.png", size: 180, padding: 0.04 },
  { file: "favicon-32.png", size: 32, padding: 0.02 },
];

mkdirSync(OUT_DIR, { recursive: true });
for (const target of TARGETS) {
  const png = encodePng(target.size, drawIcon(target.size, target.padding));
  writeFileSync(join(OUT_DIR, target.file), png);
  console.log(`${target.file}  ${target.size}x${target.size}  ${(png.length / 1024).toFixed(1)}KB`);
}
