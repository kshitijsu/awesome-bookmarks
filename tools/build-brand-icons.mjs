// Builds brand/ from a downloaded Simple Icons package (https://simpleicons.org), without running any of its code.
//   npm pack simple-icons@16.38.0   (check the tarball's sha512 against `npm view simple-icons@16.38.0 dist.integrity`)
//   tar -xzf simple-icons-16.38.0.tgz package/data package/icons
//   node tools/build-brand-icons.mjs <path to the extracted package folder>
// Writes brand/<slug>.svg (our own one-path SVG, white) and brand/index.json: { key: [slug, hex, light] },
// where a key is a host ("mail.google.com", "x.com") or a site's name label ("github"), and light marks brand
// colours too pale for a white logo. Only icons under the pack's own CC0 licence are taken.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = process.argv[2];
if (!PKG || !existsSync(join(PKG, 'data/simple-icons.json'))) {
  console.error('Usage: node tools/build-brand-icons.mjs <extracted simple-icons package folder>');
  process.exit(2);
}
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'brand');

// Sites where one domain holds several products: the host decides. Kept only if the pack has the slug.
const HOSTS = {
  'mail.google.com': 'gmail', 'calendar.google.com': 'googlecalendar', 'drive.google.com': 'googledrive',
  'docs.google.com': 'googledocs', 'sheets.google.com': 'googlesheets', 'meet.google.com': 'googlemeet',
  'console.cloud.google.com': 'googlecloud', 'maps.google.com': 'googlemaps', 'photos.google.com': 'googlephotos',
  'news.ycombinator.com': 'ycombinator', 'music.youtube.com': 'youtubemusic', 'twitter.com': 'x',
  'chatgpt.com': 'openai', 'chat.openai.com': 'openai', 'claude.ai': 'claude', 'web.whatsapp.com': 'whatsapp',
};

const SLUG_RE = /^[a-z0-9]{1,60}$/;
const HEX_RE = /^[0-9A-F]{6}$/;
const PATH_RE = /^[MmZzLlHhVvCcSsQqTtAa0-9eE+\-., ]{1,20000}$/;
const SVG_RE = /^<svg role="img" viewBox="0 0 24 24" xmlns="http:\/\/www\.w3\.org\/2000\/svg"><title>[^<]*<\/title><path d="([^"]*)"\/><\/svg>\s*$/;

const lum = hex => {
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b;
};
// "www.example.co.uk" → "example.co.uk"; null for hosts we don't key on.
const TWO_LEVEL = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.in', 'co.jp', 'com.au', 'co.nz', 'com.br', 'co.za']);
function apex(host) {
  const parts = host.replace(/^www\./, '').split('.');
  const n = TWO_LEVEL.has(parts.slice(-2).join('.')) ? 3 : 2;
  return parts.length >= n ? parts.slice(-n).join('.') : null;
}

const data = JSON.parse(readFileSync(join(PKG, 'data/simple-icons.json'), 'utf8'));
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
const brands = new Map(); // slug -> [slug, hex, light]
const skipped = { licence: 0, data: 0, svg: 0 };
const sourceHosts = new Map(); // apex domain of a brand's source -> slugs using it
for (const e of Array.isArray(data) ? data : []) {
  if (e?.license && e.license.type !== 'CC0-1.0') { skipped.licence++; continue; }
  if (!SLUG_RE.test(e?.slug) || !HEX_RE.test(e?.hex)) { skipped.data++; continue; }
  let svg;
  try { svg = readFileSync(join(PKG, 'icons', `${e.slug}.svg`), 'utf8'); } catch { skipped.svg++; continue; }
  const d = SVG_RE.exec(svg)?.[1];
  if (!d || !PATH_RE.test(d)) { skipped.svg++; continue; }
  writeFileSync(join(OUT, `${e.slug}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#fff" d="${d}"/></svg>\n`);
  brands.set(e.slug, [e.slug, e.hex, lum(e.hex) > .6]);
  try {
    const host = apex(new URL(e.source).hostname.toLowerCase());
    if (host) sourceHosts.set(host, [...(sourceHosts.get(host) || []), e.slug]);
  } catch { /* no usable source address */ }
}

const index = {};
for (const [slug, b] of brands) index[slug] = b; // the site's name label: github.com → "github"
for (const [host, slugs] of sourceHosts) if (slugs.length === 1 && !(host in index)) index[host] = brands.get(slugs[0]); // shared hosts (github.com…) skipped
let hand = 0;
for (const [host, slug] of Object.entries(HOSTS)) if (brands.has(slug)) { index[host] = brands.get(slug); hand++; }
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index));
console.log(`brands written: ${brands.size}; skipped: ${JSON.stringify(skipped)}; index keys: ${Object.keys(index).length} (${hand} hand-listed hosts)`);
