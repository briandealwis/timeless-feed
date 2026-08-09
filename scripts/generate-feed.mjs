#!/usr/bin/env node
// Builds an RSS podcast feed for Timeless Partners' "The 100 Year Conversation"
// series (https://www.timelesspartners.com/journal/conversations), which does
// not publish a feed of its own.
//
// The episode listing page server-renders a schema.org ItemList in JSON-LD
// with one entry per *published* episode (unlisted/"coming soon" guests are
// simply absent from it, so no extra filtering is needed there). Each episode
// page, however, resolves its actual audio file client-side after the page
// loads -- it never appears in the raw HTML -- so a headless browser is used
// to render each episode page and recover the real <audio> src.
//
// Because the site exposes no publish dates, this script keeps a small state
// file (data/episodes-state.json) recording the run date on which each
// episode slug was first seen, and uses that as the RSS pubDate. Once an
// episode has been seen, its pubDate never changes on later runs.

import { chromium } from "playwright";
import { parseHTML } from "linkedom";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE_ORIGIN = "https://www.timelesspartners.com";
const LISTING_URL = `${SITE_ORIGIN}/journal/conversations`;

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FEED_PATH = path.join(ROOT_DIR, "feed.xml");
const STATE_PATH = path.join(ROOT_DIR, "data", "episodes-state.json");

const FEED_TITLE = "The 100 Year Conversation — Timeless";
const FEED_DESCRIPTION =
  "Once a month, we sit with the leaders of institutions that have lasted " +
  "decades or centuries. We ask them how they endured. We publish what " +
  "they tell us. (Unofficial feed, not affiliated with or published by " +
  "Timeless Partners.)";
const FEED_AUTHOR = "Timeless Partners";
const FEED_CATEGORY = "Business";
const FEED_IMAGE = `${SITE_ORIGIN}/images/seo/social.jpg`;
const FEED_LANGUAGE = "en-us";

const AUDIO_EXTENSION_MIME = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  m4b: "audio/mp4",
  wav: "audio/wav",
  aac: "audio/aac",
  ogg: "audio/ogg",
};

const AUDIO_URL_PATTERN = /\.(mp3|m4a|m4b|wav|aac|ogg)(\?|#|$)/i;
const AUDIO_WAIT_TIMEOUT_MS = 15_000;

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "user-agent": "timeless-feed-bot/1.0 (+https://github.com/briandealwis/timeless-feed)" },
  });
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/** Extracts the schema.org ItemList of published episodes from the listing page. */
async function fetchPublishedEpisodeList() {
  const html = await fetchText(LISTING_URL);
  const { document } = parseHTML(html);
  const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];

  for (const script of scripts) {
    let data;
    try {
      data = JSON.parse(script.textContent);
    } catch {
      continue;
    }
    if (data && data["@type"] === "ItemList" && Array.isArray(data.itemListElement)) {
      return data.itemListElement
        .filter((entry) => entry && entry.url)
        .map((entry, index) => ({
          title: entry.name,
          url: entry.url,
          slug: entry.url.replace(/\/+$/, "").split("/").pop(),
          position: entry.position ?? index + 1,
        }));
    }
  }

  throw new Error("Could not find an ItemList JSON-LD block on the listing page");
}

function metaContent(document, selector) {
  const el = document.querySelector(selector);
  return el ? el.getAttribute("content")?.trim() || null : null;
}

/** Extracts static (server-rendered) metadata for an episode from its raw HTML. */
function extractStaticMeta(html) {
  const { document } = parseHTML(html);
  return {
    ogTitle: metaContent(document, 'meta[property="og:title"]'),
    ogDescription: metaContent(document, 'meta[property="og:description"]'),
    ogImage: metaContent(document, 'meta[property="og:image"]'),
  };
}

function resolveUrl(maybeUrl) {
  if (!maybeUrl) return null;
  try {
    return new URL(maybeUrl, SITE_ORIGIN).toString();
  } catch {
    return null;
  }
}

/**
 * Renders an episode page with a real browser and recovers the audio file
 * URL and (if available) duration. The player only sets its <audio> src
 * after client-side JS runs, and may only fetch the file once "Listen" is
 * pressed, so this: (1) checks the DOM directly, (2) clicks Listen and
 * watches network responses for an audio file if the DOM check comes up
 * empty.
 */
async function extractAudio(browser, episodeUrl) {
  const context = await browser.newContext({
    userAgent: "timeless-feed-bot/1.0 (+https://github.com/briandealwis/timeless-feed)",
  });
  const page = await context.newPage();

  let audioUrl = null;
  const onResponse = (response) => {
    if (audioUrl) return;
    const url = response.url();
    const contentType = response.headers()["content-type"] || "";
    if (contentType.startsWith("audio/") || AUDIO_URL_PATTERN.test(url)) {
      audioUrl = url;
    }
  };
  page.on("response", onResponse);

  try {
    await page.goto(episodeUrl, { waitUntil: "networkidle", timeout: 30_000 });

    audioUrl = await page
      .locator("audio")
      .first()
      .getAttribute("src", { timeout: 2_000 })
      .catch(() => null);

    if (!audioUrl) {
      audioUrl = await page
        .locator("audio source")
        .first()
        .getAttribute("src", { timeout: 2_000 })
        .catch(() => null);
    }

    if (!audioUrl) {
      const listenButton = page.getByRole("button", { name: /^listen$/i }).first();
      if (await listenButton.isVisible().catch(() => false)) {
        await listenButton.click({ timeout: 5_000 }).catch(() => {});
      }
      const deadline = Date.now() + AUDIO_WAIT_TIMEOUT_MS;
      while (!audioUrl && Date.now() < deadline) {
        await page.waitForTimeout(500);
      }
    }

    let durationSeconds = null;
    if (audioUrl) {
      durationSeconds = await page
        .waitForFunction(
          () => {
            const el = document.querySelector("audio");
            return el && Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null;
          },
          { timeout: 5_000 }
        )
        .then((handle) => handle.jsonValue())
        .catch(() => null);
    }

    return { audioUrl: resolveUrl(audioUrl), durationSeconds };
  } finally {
    page.off("response", onResponse);
    await context.close();
  }
}

async function headContentLength(url) {
  try {
    const res = await fetch(url, { method: "HEAD" });
    const len = res.headers.get("content-length");
    return len ? Number(len) : null;
  } catch {
    return null;
  }
}

export function mimeForUrl(url) {
  const match = /\.([a-z0-9]+)(?:\?|#|$)/i.exec(new URL(url).pathname);
  const ext = match ? match[1].toLowerCase() : null;
  return AUDIO_EXTENSION_MIME[ext] || "audio/mpeg";
}

export function formatItunesDuration(seconds) {
  if (!seconds || !Number.isFinite(seconds)) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

async function saveState(state) {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export function buildRssItem(episode) {
  const parts = [];
  parts.push("    <item>");
  parts.push(`      <title>${escapeXml(episode.title)}</title>`);
  parts.push(`      <link>${escapeXml(episode.url)}</link>`);
  parts.push(`      <guid isPermaLink="true">${escapeXml(episode.url)}</guid>`);
  parts.push(`      <pubDate>${new Date(episode.firstSeenAt).toUTCString()}</pubDate>`);
  if (episode.description) {
    const safeDescription = episode.description.replace(/]]>/g, "]]]]><![CDATA[>");
    parts.push(`      <description><![CDATA[${safeDescription}]]></description>`);
  }
  if (episode.image) {
    parts.push(`      <itunes:image href="${escapeXml(episode.image)}"/>`);
  }
  if (episode.audioUrl) {
    const length = episode.audioLength ?? 0;
    parts.push(
      `      <enclosure url="${escapeXml(episode.audioUrl)}" length="${length}" type="${mimeForUrl(
        episode.audioUrl
      )}"/>`
    );
  }
  const itunesDuration = formatItunesDuration(episode.durationSeconds);
  if (itunesDuration) {
    parts.push(`      <itunes:duration>${itunesDuration}</itunes:duration>`);
  }
  parts.push("      <itunes:explicit>false</itunes:explicit>");
  parts.push("    </item>");
  return parts.join("\n");
}

export function buildRssFeed(episodes) {
  const now = new Date().toUTCString();
  const items = episodes.map(buildRssItem).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(FEED_TITLE)}</title>
    <link>${escapeXml(LISTING_URL)}</link>
    <description>${escapeXml(FEED_DESCRIPTION)}</description>
    <language>${FEED_LANGUAGE}</language>
    <lastBuildDate>${now}</lastBuildDate>
    <itunes:author>${escapeXml(FEED_AUTHOR)}</itunes:author>
    <itunes:explicit>false</itunes:explicit>
    <itunes:category text="${escapeXml(FEED_CATEGORY)}"/>
    <itunes:image href="${escapeXml(FEED_IMAGE)}"/>
    <image>
      <url>${escapeXml(FEED_IMAGE)}</url>
      <title>${escapeXml(FEED_TITLE)}</title>
      <link>${escapeXml(LISTING_URL)}</link>
    </image>
${items}
  </channel>
</rss>
`;
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  return writeFile(file, `${name}<<EOF\n${value}\nEOF\n`, { flag: "a" });
}

async function main() {
  console.log(`Fetching episode list from ${LISTING_URL} ...`);
  const publishedEpisodes = await fetchPublishedEpisodeList();
  console.log(`Found ${publishedEpisodes.length} published episode(s).`);

  const state = await loadState();
  const nowIso = new Date().toISOString();
  const newSlugs = [];

  const browser = await chromium.launch();
  const episodes = [];
  const skipped = [];

  try {
    for (const entry of publishedEpisodes) {
      console.log(`Processing "${entry.title}" (${entry.url}) ...`);

      if (!state[entry.slug]) {
        state[entry.slug] = { firstSeenAt: nowIso, title: entry.title, url: entry.url };
        newSlugs.push(entry.slug);
      } else {
        state[entry.slug].title = entry.title;
        state[entry.slug].url = entry.url;
      }

      let staticMeta = {};
      try {
        const html = await fetchText(entry.url);
        staticMeta = extractStaticMeta(html);
      } catch (err) {
        console.warn(`  ! Failed to fetch static HTML: ${err.message}`);
      }

      let audioUrl = null;
      let durationSeconds = null;
      try {
        ({ audioUrl, durationSeconds } = await extractAudio(browser, entry.url));
      } catch (err) {
        console.warn(`  ! Failed to render page for audio extraction: ${err.message}`);
      }

      if (!audioUrl) {
        console.warn(`  ! No audio file found for "${entry.title}" — including without an enclosure.`);
        skipped.push(entry.title);
      }

      const audioLength = audioUrl ? await headContentLength(audioUrl) : null;

      episodes.push({
        title: entry.title,
        url: entry.url,
        slug: entry.slug,
        description: staticMeta.ogDescription,
        image: resolveUrl(staticMeta.ogImage),
        audioUrl,
        audioLength,
        durationSeconds,
        firstSeenAt: state[entry.slug].firstSeenAt,
        originalPosition: entry.position,
      });
    }
  } finally {
    await browser.close();
  }

  // Newest first: primarily by when this tool first saw the episode: ties
  // (e.g. every episode on the very first run) fall back to the listing
  // page's position, which increases in publish order, so the highest
  // position is the most recently published.
  episodes.sort((a, b) => {
    if (a.firstSeenAt !== b.firstSeenAt) {
      return a.firstSeenAt < b.firstSeenAt ? 1 : -1;
    }
    return b.originalPosition - a.originalPosition;
  });

  const feedXml = buildRssFeed(episodes);
  await writeFile(FEED_PATH, feedXml, "utf8");
  await saveState(state);

  console.log(`Wrote ${episodes.length} episode(s) to ${path.relative(ROOT_DIR, FEED_PATH)}.`);
  if (newSlugs.length) {
    console.log(`New episode(s) discovered: ${newSlugs.join(", ")}`);
  }
  if (skipped.length) {
    console.log(`Episode(s) without a resolved audio file: ${skipped.join(", ")}`);
  }

  await setOutput("new_episode_count", String(newSlugs.length));
  await setOutput("new_episode_titles", newSlugs.map((slug) => state[slug].title).join(", "));
  await setOutput("total_episode_count", String(episodes.length));
  await setOutput("missing_audio_count", String(skipped.length));
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
