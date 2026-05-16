// Generates favicons, PWA icons, the OG social-share image, and the web app
// manifest from the brand source SVG. Idempotent — re-run any time the brand
// assets change.
//
// Source of truth:
//   - public/assets/akash-sign-red.svg                       (red "Λ" mark)
//   - node_modules/@fontsource/inter/files/inter-latin-*.woff (OG typography)
//
// Inter is loaded from @fontsource/inter (static-weight WOFF) rather than
// public/fonts/Inter-Variable.ttf because satori's bundled opentype.js fork
// trips on the variable font's fvar name records (TypeError reading '256').
//
// Outputs (all written to public/):
//   - favicon.svg, favicon.ico
//   - apple-touch-icon.png (180x180)
//   - icon-192.png, icon-512.png
//   - og-image.png (1200x630)
//   - site.webmanifest
//
// Caching gotcha: packages/web/nginx.conf caches png/svg/ico as immutable for
// 1 year. If you change branding later, social scrapers and CDN edges will
// serve stale copies. Either accept "first deploy is canon" or bump filenames
// (og-image-v2.png etc.) and update index.html / site.webmanifest in lockstep.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import satori from 'satori';
import sharp from 'sharp';
import toIco from 'to-ico';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '..');
const PUBLIC = path.join(WEB_DIR, 'public');
const SIGN_SVG = path.join(PUBLIC, 'assets', 'akash-sign-red.svg');
const FONTSOURCE_DIR = path.resolve(WEB_DIR, '..', '..', 'node_modules', '@fontsource', 'inter', 'files');
const INTER_400 = path.join(FONTSOURCE_DIR, 'inter-latin-400-normal.woff');
const INTER_700 = path.join(FONTSOURCE_DIR, 'inter-latin-700-normal.woff');

const BG = '#000000';
const FG = '#FAFAFA';
const MUTED = '#ABABAF';

async function makeSquareIcon(signSvg, size, paddingRatio = 0.7) {
  // Rasterize the sign at the target inner width, then center on a black canvas.
  const signWidth = Math.round(size * paddingRatio);
  const signBuffer = await sharp(signSvg, { density: 384 })
    .resize({ width: signWidth })
    .png()
    .toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 4, background: BG },
  })
    .composite([{ input: signBuffer, gravity: 'center' }])
    .png()
    .toBuffer();
}

async function main() {
  const [signSvg, inter400, inter700] = await Promise.all([
    fs.readFile(SIGN_SVG),
    fs.readFile(INTER_400),
    fs.readFile(INTER_700),
  ]);

  // 1. favicon.svg — modern browsers consume the SVG directly.
  await fs.copyFile(SIGN_SVG, path.join(PUBLIC, 'favicon.svg'));
  console.log('wrote favicon.svg');

  // 2. apple-touch-icon.png (180x180) — iOS strips alpha to white on older
  //    versions, so bake in the black background.
  await fs.writeFile(
    path.join(PUBLIC, 'apple-touch-icon.png'),
    await makeSquareIcon(signSvg, 180),
  );
  console.log('wrote apple-touch-icon.png');

  // 3. PWA manifest icons.
  for (const size of [192, 512]) {
    await fs.writeFile(
      path.join(PUBLIC, `icon-${size}.png`),
      await makeSquareIcon(signSvg, size),
    );
    console.log(`wrote icon-${size}.png`);
  }

  // 4. favicon.ico — multi-resolution 16/32/48 for legacy browsers.
  const icoSources = await Promise.all(
    [16, 32, 48].map((s) => makeSquareIcon(signSvg, s, 0.78)),
  );
  await fs.writeFile(path.join(PUBLIC, 'favicon.ico'), await toIco(icoSources));
  console.log('wrote favicon.ico');

  // 5. og-image.png (1200x630) — composed via satori with Inter glyphs
  //    embedded as paths so rendering is bit-perfect across machines.
  const signDataUri = `data:image/svg+xml;base64,${signSvg.toString('base64')}`;
  const ogLayout = {
    type: 'div',
    props: {
      style: {
        width: 1200,
        height: 630,
        backgroundColor: BG,
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 96,
        paddingRight: 96,
        gap: 64,
        fontFamily: 'Inter',
      },
      children: [
        {
          type: 'img',
          props: { src: signDataUri, width: 210, height: 186 },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: 96,
                    fontWeight: 700,
                    color: FG,
                    letterSpacing: '-0.03em',
                    lineHeight: 1.05,
                  },
                  children: 'Akash Functions',
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: 38,
                    fontWeight: 400,
                    color: MUTED,
                    lineHeight: 1.3,
                  },
                  children: 'Describe a function. Deploy on Akash.',
                },
              },
            ],
          },
        },
      ],
    },
  };

  const ogSvg = await satori(ogLayout, {
    width: 1200,
    height: 630,
    fonts: [
      { name: 'Inter', data: inter400, weight: 400, style: 'normal' },
      { name: 'Inter', data: inter700, weight: 700, style: 'normal' },
    ],
  });
  await sharp(Buffer.from(ogSvg), { density: 384 })
    .resize(1200, 630)
    .png()
    .toFile(path.join(PUBLIC, 'og-image.png'));
  console.log('wrote og-image.png');

  // 6. site.webmanifest — display:browser because this isn't a standalone PWA.
  const manifest = {
    name: 'Akash Functions',
    short_name: 'Akash Fns',
    description: 'Describe a function. Deploy on Akash.',
    theme_color: BG,
    background_color: BG,
    display: 'browser',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
  await fs.writeFile(
    path.join(PUBLIC, 'site.webmanifest'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  console.log('wrote site.webmanifest');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
