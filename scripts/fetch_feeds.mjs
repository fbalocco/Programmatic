import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import Parser from 'rss-parser';

const ROOT_DIR = new URL('..', import.meta.url);
const CONFIG_PATH = new URL('../feeds.yml', import.meta.url);
const DATA_DIR = new URL('../data/', import.meta.url);
const NEWS_PATH = new URL('../data/news.json', import.meta.url);
const META_PATH = new URL('../data/meta.json', import.meta.url);

function stripHtml(input) {
  if (!input) return '';
  return String(input)
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(s, maxLen = 260) {
  const t = (s || '').trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen - 1).trimEnd() + '…';
}

// Simple stable hash (FNV-1a 32-bit) for item IDs
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // unsigned
  return (h >>> 0).toString(16).padStart(8, '0');
}

function safeIsoDate(maybeDate) {
  if (!maybeDate) return null;
  const t = Date.parse(maybeDate);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

function cleanUrl(rawUrl, stripParams = []) {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    for (const p of stripParams) u.searchParams.delete(p);
    // Common extra cleanup: remove empty query and trailing hash-only.
    if ([...u.searchParams.keys()].length === 0) u.search = '';
    if (u.hash === '#') u.hash = '';
    return u.toString();
  } catch {
    return rawUrl;
  }
}

function containsAny(haystack, needles = []) {
  if (!needles || needles.length === 0) return true;
  const h = (haystack || '').toLowerCase();
  return needles.some(n => h.includes(String(n).toLowerCase()));
}

function excludedByAny(haystack, excludes = []) {
  if (!excludes || excludes.length === 0) return false;
  const h = (haystack || '').toLowerCase();
  return excludes.some(n => h.includes(String(n).toLowerCase()));
}

function computeTags(text) {
  const t = (text || '').toLowerCase();
  const rules = [
    { tag: 'Privacy', re: /\bprivacy\b|gdpr|consent|tracking|cookie|cookies|data broker|eprivacy|dsa|dma/i },
    { tag: 'Antitrust', re: /\bantitrust\b|\bcompetition\b|monopoly|dominant position|merger/i },
    { tag: 'RTB', re: /\brtb\b|real-time bidding|openrtb|bid request|bid response|auction/i },
    { tag: 'Identity', re: /\bidentity\b|id-less|idfa|maid|uid2|ppid/i },
    { tag: 'Measurement', re: /measurement|attribution|incrementality|mmm|mta|conversion/i },
    { tag: 'CTV', re: /\bctv\b|connected tv|\bott\b|streaming/i },
    { tag: 'Fraud', re: /fraud|ivt|spoofing|ads\.txt|app-ads\.txt|sellers\.json/i },
    { tag: 'AI', re: /\bai\b|llm|machine learning|generative/i },
    { tag: 'Policy', re: /regulation|law|court|enforcement|settlement|complaint|filed|trial/i },
  ];

  const tags = [];
  for (const r of rules) {
    if (r.re.test(t)) tags.push(r.tag);
  }
  return tags;
}

async function loadConfig() {
  const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
  const cfg = YAML.parse(raw);

  if (!cfg || !Array.isArray(cfg.feeds)) {
    throw new Error('feeds.yml is missing or invalid (expected top-level "feeds" array).');
  }

  const defaults = cfg.defaults || {};
  return {
    defaults: {
      maxItemsPerFeed: defaults.maxItemsPerFeed ?? 40,
      maxTotalItems: defaults.maxTotalItems ?? 700,
      timeoutMs: defaults.timeoutMs ?? 25000,
      userAgent: defaults.userAgent ?? 'AdAuctionNewsBot/1.0 (+https://github.com/)',
      stripUrlParams: defaults.stripUrlParams ?? [],
    },
    feeds: cfg.feeds,
  };
}

async function fetchText(url, { timeoutMs, userAgent } = {}) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs ?? 25000);

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': userAgent || 'AdAuctionNewsBot/1.0',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8',
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(to);
  }
}

async function parseFeedFromUrl(parser, url, reqOpts) {
  const xml = await fetchText(url, reqOpts);
  return await parser.parseString(xml);
}

function normalizeItem(feedDef, item, stripParams) {
  const title = stripHtml(item.title || item.title?.value || '') || '(untitled)';

  const rawLink =
    item.link ||
    item.guid ||
    (Array.isArray(item.links) && item.links.length ? item.links[0]?.url : null);

  const url = cleanUrl(rawLink, stripParams);

  const published =
    safeIsoDate(item.isoDate) ||
    safeIsoDate(item.pubDate) ||
    safeIsoDate(item.published) ||
    safeIsoDate(item.date) ||
    safeIsoDate(item.updated) ||
    null;

  const rawSummary =
    item.contentSnippet ||
    item.summary ||
    item.content ||
    item['content:encoded'] ||
    '';

  const summary = truncate(stripHtml(rawSummary), 280);

  const combinedText = `${title} ${summary}`;
  const tags = computeTags(combinedText);

  const stableIdSeed = url || `${feedDef.id}|${title}|${published || ''}`;
  const id = fnv1a(stableIdSeed);

  return {
    id,
    title,
    url,
    source: feedDef.name,
    sourceId: feedDef.id,
    category: feedDef.category || 'Uncategorized',
    tags,
    published: published || new Date().toISOString(),
    summary,
  };
}

async function main() {
  const cfg = await loadConfig();
  const { defaults, feeds } = cfg;

  const parser = new Parser();

  await fs.mkdir(DATA_DIR, { recursive: true });

  const errors = [];
  const all = [];

  for (const feedDef of feeds) {
    const maxItems = feedDef.maxItemsPerFeed ?? defaults.maxItemsPerFeed;
    const reqOpts = { timeoutMs: defaults.timeoutMs, userAgent: defaults.userAgent };

    try {
      const parsed = await parseFeedFromUrl(parser, feedDef.url, reqOpts);
      const items = Array.isArray(parsed.items) ? parsed.items : [];

      const include = feedDef.keywords?.include || null;
      const exclude = feedDef.keywords?.exclude || null;

      const normalized = [];
      for (const it of items.slice(0, maxItems)) {
        const n = normalizeItem(feedDef, it, defaults.stripUrlParams);
        if (!n.url) continue;

        const text = `${n.title} ${n.summary}`;
        if (include && include.length > 0 && !containsAny(text, include)) continue;
        if (exclude && exclude.length > 0 && excludedByAny(text, exclude)) continue;

        normalized.push(n);
      }

      all.push(...normalized);
    } catch (e) {
      errors.push({
        id: feedDef.id,
        name: feedDef.name,
        url: feedDef.url,
        error: e?.message || String(e),
      });
    }
  }

  // Dedupe by URL (after stripping params). Keep newest by published date.
  const byUrl = new Map();
  for (const it of all) {
    const key = it.url;
    const existing = byUrl.get(key);
    if (!existing) {
      byUrl.set(key, it);
      continue;
    }
    const tNew = Date.parse(it.published) || 0;
    const tOld = Date.parse(existing.published) || 0;
    if (tNew >= tOld) byUrl.set(key, it);
  }

  const deduped = Array.from(byUrl.values());

  // Sort newest first
  deduped.sort((a, b) => (Date.parse(b.published) || 0) - (Date.parse(a.published) || 0));

  // Limit total items
  const limited = deduped.slice(0, defaults.maxTotalItems);

  const meta = {
    generatedAt: new Date().toISOString(),
    feedCount: feeds.length,
    itemCount: limited.length,
    errors,
  };

  await fs.writeFile(NEWS_PATH, JSON.stringify(limited, null, 2) + '\n', 'utf-8');
  await fs.writeFile(META_PATH, JSON.stringify(meta, null, 2) + '\n', 'utf-8');

  // Helpful log for Actions
  console.log(`Generated ${meta.itemCount} items from ${meta.feedCount} feeds`);
  if (errors.length) {
    console.log(`Feed errors: ${errors.length}`);
    for (const e of errors) console.log(`- ${e.id}: ${e.error}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
