# timeless-feed

An unofficial RSS podcast feed for [Timeless Partners'](https://www.timelesspartners.com)
"The 100 Year Conversation" series, published at
[/journal/conversations](https://www.timelesspartners.com/journal/conversations),
which doesn't publish a feed of its own.

Not affiliated with or endorsed by Timeless Partners.

## How it works

- `scripts/generate-feed.mjs` reads the episode listing page's server-rendered
  `ItemList` JSON-LD to find published episodes (episodes shown as "coming
  soon" without a link are absent from it, so they're naturally skipped).
- For each episode, it renders the page with a headless browser (the audio
  file URL is only resolved client-side, so a plain HTTP fetch can't see it)
  and recovers the audio URL and, if available, its duration.
- The site publishes no episode dates. `data/episodes-state.json` records the
  date each episode slug was *first seen* by this tool, and that date is used
  as the RSS `pubDate`. Once set, an episode's date never changes on later
  runs, so ordering stays stable.
- The result is written to `feed.xml` at the repo root, a standard RSS 2.0
  feed with iTunes podcast tags, subscribable from any podcast app or RSS
  reader.

## Automation

`.github/workflows/update-feed.yml` runs weekly (Mondays, 13:00 UTC) and can
also be triggered manually from the Actions tab. Each run regenerates
`feed.xml` and, if anything changed, opens a pull request automatically via
[`peter-evans/create-pull-request`](https://github.com/peter-evans/create-pull-request) —
no manual steps are needed to get a PR opened. The PR is **not**
auto-merged; review and merge it to publish the update.

For the workflow to be able to open PRs, the repository must have
**Settings → Actions → General → Workflow permissions** set to
"Read and write permissions" (or at least "Allow GitHub Actions to create and
approve pull requests" enabled).

## Subscribing to the feed

Once merged to the default branch, the feed is reachable at:

```
https://raw.githubusercontent.com/briandealwis/timeless-feed/main/feed.xml
```

For a URL with the correct `application/rss+xml` content type (some picky
podcast apps care), enable GitHub Pages for this repository instead and point
apps at the Pages URL.

## Running locally

```
npm install
npx playwright install --with-deps chromium
npm run generate-feed
```
