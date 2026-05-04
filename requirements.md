# Twitter/X Scraper Chrome Extension — Requirements

> **Version:** 3.0 | **Updated:** 2026-03-29  
> Chrome Extension for media monitoring that discovers tweet URLs via DOM scanning, then scrapes full post data by intercepting TweetDetail GraphQL responses.

---

## 1. How It Works — Two-Phase Pipeline

```
Phase 1: COLLECT                          Phase 2: SCRAPE
─────────────────────                     ─────────────────────
User browses a timeline/hashtag/profile   User clicks "Start Scraping"
   │                                         │
   ▼                                         ▼
Clicks "Collect Tweets" (FAB or Panel)    For each queued URL (status=pending):
   │                                         │
   ▼                                         ├── Open tweet in new tab
DOM Scanner finds tweet URLs                 ├── Network interceptor captures
on the visible page                          │   TweetDetail GraphQL response
   │                                         ├── Parse & normalize all fields
   ▼                                         ├── Extract replies from thread
Auto-scroll loads more tweets                ├── Save to IndexedDB (status=scraped)
   │                                         ├── Close tab
   ▼                                         ├── Random delay (2-6s)
Each URL saved to IndexedDB                  └── Next URL
(status = "queued")                          │
   │                                         ▼
   ▼                                      User exports via CSV or API POST
Stop manually or when no new                 (status → exported)
tweets found after configurable scroll cycles (3 default)
```

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        Chrome Browser                         │
│                                                               │
│  ┌─────────────────────┐    ┌──────────────────────────────┐ │
│  │  MAIN WORLD         │    │  ISOLATED WORLD              │ │
│  │                     │    │                              │ │
│  │  network-           │───▶│  content.js                  │ │
│  │  interceptor.js     │    │  ├─ DOM Tweet Discoverer     │ │
│  │                     │    │  ├─ Auto-Scroll Controller   │ │
│  │  • Patches fetch    │    │  ├─ FAB Button               │ │
│  │  • Captures         │    │  └─ Interceptor Bridge       │ │
│  │    TweetDetail      │    │                              │ │
│  │    responses        │    │  tweet-parser.js             │ │
│  │  • Stores in IDB    │    │  └─ Normalizes GraphQL data  │ │
│  │  • Posts blobId     │    │                              │ │
│  └─────────────────────┘    └──────────────┬───────────────┘ │
│                                            │                  │
│  ┌─────────────────────────────────────────┼────────────────┐│
│  │  SERVICE WORKER — background.js         │                ││
│  │  ├─ Scraping queue processor                             ││
│  │  │  (open tab → wait for data → close → next)            ││
│  │  ├─ Export engine (CSV download / API POST)              ││
│  │  ├─ IndexedDB manager (queue CRUD + status tracking)     ││
│  │  └─ Message router (content ↔ sidepanel)                 ││
│  └──────────────────────────────────────────────────────────┘│
│                                                               │
│  ┌──────────────────────────────────────────────────────────┐│
│  │  SIDE PANEL — sidepanel.html                             ││
│  │  ├─ Tab 1: Queue (tweet list + status badges)            ││
│  │  ├─ Tab 2: Scraped Data (extracted results , export controls for CSV and API)              ││
│  │  ├─ Tab 3: Settings (API endpoint, delays, limits)       ││
│       ││
│  └──────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Phase 1 — Tweet Collection (DOM-Based)

### 3.1 Trigger

- **FAB Button:** Floating button on the page labeled **"Collect Tweets"**
- **Side Panel Button:** Same action, labeled **"Collect Tweets"**
- Both toggle between **"Collect Tweets"** and **"Stop Collecting"**

### 3.2 DOM Tweet URL Discovery

The discoverer scans the page DOM for tweet links without making any network requests:

```javascript
// Primary: find all tweet article elements
document.querySelectorAll('article[data-testid="tweet"]');

// Within each article, extract the status URL:
article.querySelectorAll('a[href*="/status/"]');
// Filter: href must match pattern /{username}/status/{tweetId}
// Regex: /^\/[^\/]+\/status\/(\d+)$/

// Construct full URL: https://x.com/{username}/status/{tweetId}
```

**De-duplication:** Before saving, check if the URL already exists in IndexedDB.

### 3.3 Auto-Scroll

After scanning visible tweets, automatically scroll to load more:

| Parameter         | Default                    | Description                                           |
| ----------------- | -------------------------- | ----------------------------------------------------- |
| Scroll step       | `window.innerHeight * 0.8` | Scroll by ~80% of viewport                            |
| Scroll interval   | 2000ms                     | Pause between scrolls                                 |
| Stale threshold   | 3 cycles                   | Stop if no new tweets found for 3 consecutive scrolls |
| Max scroll cycles | 100                        | Safety cap                                            |

**Scroll loop:**

1. Scan DOM for tweet URLs → save new ones to IndexedDB
2. Scroll down (use anti bot features - Research this)
3. Wait for new content to render (2s)
4. Repeat
5. Stop if: user clicks Stop, OR stale limit reached, OR max cycles reached

### 3.4 Collection Status Updates

During collection, the FAB and side panel show real-time stats:

- `"Collecting... 47 tweets found"` (FAB badge)
- Side panel queue tab updates live count

---

## 4. Phase 2 — Tweet Scraping (GraphQL Interception)

### 4.1 Trigger

- **Side Panel Button:** **"Start Scraping"** / **"Pause"** / **"Resume"** / **"Stop"**
- Only processes tweets with IndexedDB status = `queued`

### 4.2 Network Interceptor

A script injected into the page's MAIN world that monkey-patches `window.fetch`:

1. Intercept all fetch calls matching URL pattern `/i/api/graphql/` + `TweetDetail`
2. Clone the response (non-destructive)
3. Parse JSON, store full payload in IndexedDB (`intercepted_blobs` store)
4. Post `{ blobId, url }` to ISOLATED world via `window.postMessage`
5. Content script reads the blob, deletes it, and forwards to the parser

### 4.3 Scraping Loop (Background Service Worker)

```
processQueue():
  1. Get next tweet from IndexedDB where status = "queued"
  2. Update status → "scraping"
  3. Open tweet URL in new tab
  4. Set timeout (30s) — if no data received, mark "failed"
  5. Wait for SCRAPE_COMPLETE message from content script
  6. Save normalized data to IndexedDB (status → "scraped")
  7. Close tab
  8. Wait random delay (configurable: 2-6 seconds)
  9. Check if paused/stopped → if yes, break
  10. Go to step 1
```

### 4.4 What Gets Scraped

When a TweetDetail response is captured, extract all of the following:

#### Root Tweet + All Replies in the Thread

The response contains `data.threaded_conversation_with_injections_v2.instructions[]`:

- **Entry type `TimelineTimelineItem`** (entryId starts with `tweet-`) → **Root tweet**
- **Entry type `TimelineTimelineModule`** (entryId starts with `conversationthread-`) → **Reply threads**
- Each thread's `items[]` contains individual reply tweets

---

## 5. Data Model — What to Extract

### 5.1 Tweet Fields

| Field             | JSON Path from `tweet_results.result`                            | Type   |
| ----------------- | ---------------------------------------------------------------- | ------ |
| `tweet_id`        | `rest_id`                                                        | string |
| `text`            | `note_tweet.note_tweet_results.result.text` ∥ `legacy.full_text` | string |
| `created_at`      | `legacy.created_at`                                              | string |
| `lang`            | `legacy.lang`                                                    | string |
| `conversation_id` | `legacy.conversation_id_str`                                     | string |
| `source`          | `source` (strip HTML tags)                                       | string |
| `url`             | derived: `https://x.com/{screen_name}/status/{tweet_id}`         | string |

### 5.2 Engagement Metrics

| Field       | JSON Path               | Type       |
| ----------- | ----------------------- | ---------- |
| `views`     | `views.count`           | string→int |
| `likes`     | `legacy.favorite_count` | int        |
| `retweets`  | `legacy.retweet_count`  | int        |
| `replies`   | `legacy.reply_count`    | int        |
| `quotes`    | `legacy.quote_count`    | int        |
| `bookmarks` | `legacy.bookmark_count` | int        |

### 5.3 Author Fields

From `tweet_results.result.core.user_results.result`:

| Field                      | JSON Path (under user result)              | Type    |
| -------------------------- | ------------------------------------------ | ------- |
| `author_id`                | `rest_id`                                  | string  |
| `author_username`          | `core.screen_name`                         | string  |
| `author_display_name`      | `core.name`                                | string  |
| `author_join_date`         | `core.created_at`                          | string  |
| `author_avatar`            | `avatar.image_url`                         | string  |
| `author_bio`               | `profile_bio.description`                  | string  |
| `author_location`          | `location.location`                        | string  |
| `author_followers`         | `legacy.followers_count`                   | int     |
| `author_following`         | `legacy.friends_count`                     | int     |
| `author_tweet_count`       | `legacy.statuses_count`                    | int     |
| `author_listed_count`      | `legacy.listed_count`                      | int     |
| `author_verified`          | `is_blue_verified`                         | boolean |
| `author_professional_type` | `professional.professional_type`           | string  |
| `author_website`           | `legacy.entities.url.urls[0].expanded_url` | string  |

### 5.4 Media Attachments

From `legacy.extended_entities.media[]`:

| Field               | JSON Path (under media item)                  | Type   |
| ------------------- | --------------------------------------------- | ------ |
| `media_type`        | `type` (`photo`/`video`/`animated_gif`)       | string |
| `media_url`         | `media_url_https`                             | string |
| `media_width`       | `original_info.width`                         | int    |
| `media_height`      | `original_info.height`                        | int    |
| `media_alt`         | `ext_alt_text`                                | string |
| `video_url`         | `video_info.variants[]` → highest bitrate MP4 | string |
| `video_duration_ms` | `video_info.duration_millis`                  | int    |

### 5.5 Reply Context

| Field               | JSON Path                            | Type    |
| ------------------- | ------------------------------------ | ------- |
| `is_reply`          | `!!legacy.in_reply_to_status_id_str` | boolean |
| `reply_to_tweet_id` | `legacy.in_reply_to_status_id_str`   | string  |
| `reply_to_user_id`  | `legacy.in_reply_to_user_id_str`     | string  |
| `reply_to_username` | `legacy.in_reply_to_screen_name`     | string  |

### 5.6 Tweet Flags

| Field                 | JSON Path                          | Type    |
| --------------------- | ---------------------------------- | ------- |
| `is_quote`            | `legacy.is_quote_status`           | boolean |
| `is_retweet`          | `!!legacy.retweeted_status_result` | boolean |
| `is_sensitive`        | `legacy.possibly_sensitive`        | boolean |
| `has_community_notes` | `has_birdwatch_notes`              | boolean |

### 5.7 Entities

| Entity   | JSON Path                         | Extract                         |
| -------- | --------------------------------- | ------------------------------- |
| Hashtags | `legacy.entities.hashtags[]`      | `.text`                         |
| Mentions | `legacy.entities.user_mentions[]` | `.screen_name`, `.id_str`       |
| URLs     | `legacy.entities.urls[]`          | `.expanded_url`, `.display_url` |

### 5.8 Card / Poll Data

From `card.legacy` (if present):

| Field              | Source                                                        |
| ------------------ | ------------------------------------------------------------- |
| `card_type`        | `card.legacy.name` (`summary`, `poll2choice_text_only`, etc.) |
| `card_title`       | binding value key `title`                                     |
| `card_description` | binding value key `description`                               |
| `card_url`         | binding value key `card_url`                                  |
| `poll_choices`     | binding values `choice{N}_label` + `choice{N}_count`          |
| `poll_end_date`    | binding value `end_datetime_utc`                              |

### 5.9 Special Tweet Types

| `__typename`                 | Handling                                   |
| ---------------------------- | ------------------------------------------ |
| `Tweet`                      | Normal — extract fully                     |
| `TweetWithVisibilityResults` | Access data via `.tweet` sub-property      |
| `TweetTombstone`             | Deleted/suspended — skip, mark as `failed` |

---

## 6. IndexedDB Schema

**Database Name:** `TwitterScraperDB`

### 6.1 Store: `tweet_queue`

Primary store for the entire pipeline — a tweet moves through statuses:

| Field           | Type             | Description                                                             |
| --------------- | ---------------- | ----------------------------------------------------------------------- |
| `url`           | string (keyPath) | Tweet URL (unique identifier)                                           |
| `tweet_id`      | string           | Extracted tweet ID from URL                                             |
| `status`        | string           | `queued` → `scraping` → `scraped` → `exporting` → `exported` / `failed` |
| `discovered_at` | string (ISO)     | When the URL was first collected                                        |
| `scraped_at`    | string (ISO)     | When the tweet was successfully scraped                                 |
| `exported_at`   | string (ISO)     | When the data was exported                                              |
| `error`         | string           | Error message if status = `failed`                                      |
| `retry_count`   | int              | Number of scrape attempts                                               |
| `data`          | object           | Full normalized tweet data (null until scraped)                         |
| `replies`       | object[]         | Array of normalized reply objects (null until scraped)                  |
| `source_page`   | string           | URL of the page where this tweet was discovered                         |

**Indexes:**

| Index           | Field           | Purpose                        |
| --------------- | --------------- | ------------------------------ |
| `by_status`     | `status`        | Query tweets by pipeline stage |
| `by_discovered` | `discovered_at` | Sort by discovery order        |
| `by_tweet_id`   | `tweet_id`      | Fast lookup by tweet ID        |

### 6.2 Store: `intercepted_blobs`

Ephemeral store for MAIN→ISOLATED world data transfer:

| Field       | Type             | Description                            |
| ----------- | ---------------- | -------------------------------------- |
| `id`        | string (keyPath) | Random ID                              |
| `data`      | object           | Raw GraphQL JSON payload               |
| `timestamp` | number           | Epoch ms, for cleanup of stale entries |

### 6.3 Store: `settings`

| Field   | Type             | Default | Description        |
| ------- | ---------------- | ------- | ------------------ |
| `key`   | string (keyPath) | —       | Setting identifier |
| `value` | any              | —       | Setting value      |

**Settings keys:**

| Key                 | Default | Description                        |
| ------------------- | ------- | ---------------------------------- |
| `api_endpoint`      | `""`    | URL for API POST                   |
| `api_key`           | `""`    | Auth key/token for API             |
| `api_batch_size`    | `25`    | Posts per API batch                |
| `scrape_delay_min`  | `2000`  | Min delay between tabs (ms)        |
| `scrape_delay_max`  | `6000`  | Max delay between tabs (ms)        |
| `scroll_interval`   | `2000`  | Scroll pause (ms)                  |
| `max_scroll_cycles` | `100`   | Max scrolls per collection session |
| `max_retries`       | `2`     | Retry failed scrapes               |

### 6.4 Status Flow Diagram

```
  ┌────────┐    scrape     ┌──────────┐    scrape    ┌─────────┐
  │ queued │──────────────▶│ scraping │────success──▶│ scraped │
  └────────┘               └──────────┘              └────┬────┘
       ▲                        │                         │
       │                     failure                   export
       │                        ▼                         ▼
       │                   ┌────────┐              ┌──────────┐
       │    retry ◀────────│ failed │              │ exported │
       │   (if retries     └────────┘              └──────────┘
       │    remaining)
       └───────────┘
```

**Status values:**

| Status      | Meaning                                                |
| ----------- | ------------------------------------------------------ |
| `queued`    | URL discovered, waiting to be scraped                  |
| `scraping`  | Currently being scraped (tab open)                     |
| `scraped`   | Data extracted successfully, ready for export          |
| `exporting` | Currently being sent to API                            |
| `exported`  | Successfully exported (CSV downloaded or API accepted) |
| `failed`    | Scraping or export failed (see `error` field)          |

---

## 7. UI Specification

### 7.1 FAB (Floating Action Button)

- **Position:** Fixed, bottom-right of the Twitter page
- **Size:** 56×56px circle, z-index 10000
- **Primary action:** Toggle tweet collection on/off

| State      | Appearance             | Label                  |
| ---------- | ---------------------- | ---------------------- |
| Idle       | Blue circle, scan icon | "Collect Tweets"       |
| Collecting | Pulsing green, spinner | Badge: "47 found"      |
| Scraping   | Pulsing orange         | Badge: "12/47 scraped" |

- **Click behavior:**
  - If idle → start collecting (scan DOM + auto-scroll)
  - If collecting → stop collecting
  - Scraping is controlled only from the side panel

### 7.2 Side Panel

#### Tab 1: Queue

- **Header stats bar:** `47 queued • 12 scraped • 3 exported • 1 failed`
- **Tweet card list:** Each card shows:
  - Tweet URL (truncated, clickable)
  - Status badge (color-coded: blue=queued, orange=scraping, green=scraped, purple=exported, red=failed)
  - Discovered timestamp
  - Error message (if failed)
  - paginated
- **Bulk actions toolbar:**
  - ☐ Select All / Deselect All
  - 🗑 **Delete Selected** — removes from queue
  - 🗑 **Clear Queue** — removes all tweets with status `queued`
  - 🗑 **Clear All** — empties entire queue (with confirmation)
  - 🔄 **Retry Failed** — resets `failed` items to `queued`
- **Action buttons:**
  - **"Collect Tweets"** — starts Phase 1 DOM collection on current page
  - **"Start Scraping"** / **"Pause"** / **"Resume"** / **"Stop"** — controls Phase 2

#### Tab 2: Scraped Data

- **Data table** with columns: Author, Text (preview), Likes, RTs, Replies, Views, Date
- Click row → expand to full details including media, reply context, entities
- **Filter bar:** Filter by status, author, date range, has-media, is-reply
- **Search:** Full-text search across tweet text
- Select rows for targeted export

- **CSV Export:**
  - Button: **"Download CSV"** — exports all `scraped` items
  - Button: **"Download Selected CSV"** — exports checked items only
  - Checkbox: Include replies in export (default: yes)
  - After download, update status → `exported`

- **API Export:**
  - Button: **"Send to API"** — POST all `scraped` items in batches
  - Button: **"Send Selected to API"** — POST checked items only
  - Batch size configurable in Settings
  - Shows progress: "Sending batch 2/4..."
  - After successful POST, update status → `exported`
  - On failure, status remains `scraped`, error logged

- **API POST format:**

```json
{
  "batch_id": "uuid",
  "batch_number": 1,
  "total_in_batch": 25,
  "posts": [
    /* normalized tweet objects */
  ]
}
```

#### Tab 3: Settings

| Setting            | Input Type | Default   | Description                |
| ------------------ | ---------- | --------- | -------------------------- |
| API Endpoint URL   | text       | _(empty)_ | URL to POST data to        |
| API Key / Token    | password   | _(empty)_ | Authorization header value |
| API Batch Size     | number     | 25        | Posts per API request      |
| Scrape Delay (min) | number     | 2000      | Min ms between tab opens   |
| Scrape Delay (max) | number     | 6000      | Max ms between tab opens   |
| Scroll Interval    | number     | 2000      | Ms between auto-scrolls    |
| Max Scrolls        | number     | 100       | Safety cap for collection  |
| Max Retries        | number     | 2         | Retry failed scrapes       |
| Include Replies    | toggle     | ON        | Scrape replies in thread   |

- **"Save Settings"** button → persists to IndexedDB `settings` store
- **"Reset to Defaults"** button

---

## 8. Export Schemas

### 8.1 CSV Columns

| Column                | Source                              |
| --------------------- | ----------------------------------- |
| `tweet_id`            | id                                  |
| `tweet_url`           | url                                 |
| `tweet_text`          | text                                |
| `tweet_lang`          | lang                                |
| `tweet_created_at`    | created_at                          |
| `tweet_source`        | source                              |
| `conversation_id`     | conversation_id                     |
| `author_id`           | author.id                           |
| `author_username`     | author.username                     |
| `author_display_name` | author.display_name                 |
| `author_bio`          | author.bio                          |
| `author_location`     | author.location                     |
| `author_followers`    | author.followers_count              |
| `author_following`    | author.following_count              |
| `author_tweets`       | author.tweet_count                  |
| `author_verified`     | author.verified                     |
| `author_join_date`    | author.join_date                    |
| `author_website`      | author.website_url                  |
| `author_avatar`       | author.profile_image_url            |
| `views`               | engagement.views                    |
| `likes`               | engagement.likes                    |
| `retweets`            | engagement.retweets                 |
| `replies`             | engagement.replies                  |
| `quotes`              | engagement.quotes                   |
| `bookmarks`           | engagement.bookmarks                |
| `is_reply`            | flags.is_reply                      |
| `is_retweet`          | flags.is_retweet                    |
| `is_quote`            | flags.is_quote                      |
| `reply_to_tweet_id`   | reply_context.in_reply_to_status_id |
| `reply_to_username`   | reply_context.in_reply_to_username  |
| `media_count`         | media.length                        |
| `media_types`         | media types joined by `;`           |
| `media_urls`          | media URLs joined by `;`            |
| `hashtags`            | joined by `;`                       |
| `mentions`            | mention usernames joined by `;`     |
| `extracted_at`        | extraction timestamp                |

### 8.2 API POST Body

```json
{
  "batch_id": "a1b2c3d4-...",
  "batch_number": 1,
  "total_in_batch": 25,
  "posts": [
    {
      "id": "1796577666151133261",
      "url": "https://x.com/disclosetv/status/1796577666151133261",
      "text": "NEW - Tax rate in Germany...",
      "lang": "en",
      "created_at": "Fri May 31 16:21:09 +0000 2024",
      "conversation_id": "1796577666151133261",
      "source": "Twitter Web App",

      "author": {
        "id": "15392486",
        "username": "disclosetv",
        "display_name": "Disclose.tv",
        "bio": "Observing world events...",
        "location": "🌍",
        "followers_count": 1700724,
        "following_count": 1255,
        "tweet_count": 10957,
        "verified": true,
        "join_date": "Fri Jul 11 15:25:39 +0000 2008",
        "website_url": "https://www.disclose.tv",
        "profile_image_url": "https://pbs.twimg.com/..."
      },

      "engagement": {
        "views": 191688,
        "likes": 2137,
        "retweets": 457,
        "replies": 91,
        "quotes": 70,
        "bookmarks": 125
      },

      "media": [
        {
          "type": "photo",
          "url": "https://pbs.twimg.com/media/GO64pWqWsAgheiu.png",
          "width": 924,
          "height": 476,
          "video_url": null,
          "duration_ms": 0
        }
      ],

      "hashtags": [],
      "mentions": [],
      "urls": [],

      "is_reply": false,
      "is_retweet": false,
      "is_quote": false,
      "reply_to_tweet_id": null,
      "reply_to_username": null,

      "extracted_at": "2026-03-29T14:52:00.000Z"
    }
  ]
}
```

---

## 9. GraphQL Response Parsing Reference

### 9.1 TweetDetail Response Path

```
data
└── threaded_conversation_with_injections_v2
    └── instructions[]
        ├── { type: "TimelineClearCache" }
        ├── { type: "TimelineAddEntries", entries: [...] }
        │     ├── tweet-{id}               → Root tweet (TimelineTimelineItem)
        │     ├── conversationthread-{id}  → Reply thread (TimelineTimelineModule)
        │     │     └── items[].item.itemContent.tweet_results.result
        │     └── cursor-bottom-{id}       → Pagination cursor
        └── { type: "TimelineTerminateTimeline" }
```

### 9.2 Code Reference: Extracting Data

```javascript
// --- Navigate response ---
const instructions =
  response.data.threaded_conversation_with_injections_v2.instructions;
const addEntries = instructions.find((i) => i.type === "TimelineAddEntries");
const entries = addEntries?.entries || [];

// --- Root tweet ---
const rootEntry = entries.find((e) => e.entryId?.startsWith("tweet-"));
const rootTweet = rootEntry?.content?.itemContent?.tweet_results?.result;

// --- Reply threads ---
const threads = entries.filter((e) =>
  e.entryId?.startsWith("conversationthread-"),
);
const replies = [];
threads.forEach((thread) => {
  (thread.content?.items || []).forEach((item) => {
    const reply = item?.item?.itemContent?.tweet_results?.result;
    if (reply && reply.__typename !== "TweetTombstone") {
      replies.push(reply);
    }
  });
});

// --- Tweet data ---
const tweet = rootTweet;
const text =
  tweet.note_tweet?.note_tweet_results?.result?.text || tweet.legacy?.full_text;
const views = parseInt(tweet.views?.count || "0", 10);

// --- Author ---
const user = tweet.core?.user_results?.result;
const username = user?.core?.screen_name;
const followers = user?.legacy?.followers_count;

// --- Media ---
const media = tweet.legacy?.extended_entities?.media || [];
const bestVideo = (m) =>
  (m.video_info?.variants || [])
    .filter((v) => v.content_type === "video/mp4")
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]?.url;

// --- Card/Poll ---
const card = tweet.card?.legacy;
const cardValues = {};
card?.binding_values?.forEach((bv) => {
  cardValues[bv.key] = bv.value;
});
```

### 9.3 DOM Selectors for Tweet Discovery (Phase 1)

```javascript
// Tweet articles
document.querySelectorAll('article[data-testid="tweet"]');

// Tweet URL links within an article
article.querySelectorAll('a[href*="/status/"]');
// Valid pattern: /{username}/status/{digits}
// Regex: /^\/([^\/]+)\/status\/(\d+)$/

// Example extraction:
const links = article.querySelectorAll('a[href*="/status/"]');
links.forEach((link) => {
  const match = link.getAttribute("href")?.match(/^\/([^\/]+)\/status\/(\d+)$/);
  if (match) {
    const url = `https://x.com${match[0]}`;
    const tweetId = match[2];
    // Save to IndexedDB if not already present
  }
});
```

---

## 10. Rate Limiting & Error Handling

### 10.1 Throttling

| Parameter           | Default              | Purpose                         |
| ------------------- | -------------------- | ------------------------------- |
| Tab open delay      | 2000–6000ms (random) | Between each tweet scrape       |
| Scroll interval     | 2000ms               | Between auto-scroll steps       |
| Max concurrent tabs | 1                    | Only one scraping tab at a time |
| Tab timeout         | 30s                  | Close tab if no data captured   |
| Max retries         | 2                    | Re-queue failed scrapes         |

### 10.2 Error Handling

| Scenario                                | Response                                           |
| --------------------------------------- | -------------------------------------------------- |
| TweetDetail not received within timeout | Mark `failed`, retry if attempts remaining         |
| Deleted tweet (`TweetTombstone`)        | Mark `failed` with reason "Tweet deleted"          |
| Tab crash / navigation error            | Mark `failed`, close tab, continue queue           |
| API POST failure (network)              | Keep status as `scraped`, log error, retry later   |
| API POST failure (4xx/5xx)              | Keep status as `scraped`, show error in side panel |
| IndexedDB unavailable                   | Fallback: direct `postMessage` with payload        |
| Extension context invalidated           | Show "Refresh page" message via FAB                |

---

## 11. File Structure

```
twitter-scraper/
├── manifest.json                 # Manifest V3
├── background.js                 # Service worker: queue processor, export, messaging
├── content.js                    # ISOLATED world: DOM discoverer, scroll, FAB, bridge
├── network-interceptor.js        # MAIN world: fetch/XHR patching for TweetDetail
├── tweet-parser.js               # GraphQL response normalizer
├── db.js                         # IndexedDB helper (open, CRUD, queries)
├── content.css                   # FAB & overlay styles
├── sidepanel/
│   ├── sidepanel.html            # Side panel markup
│   ├── sidepanel.js              # Side panel logic (tabs, actions, rendering)
│   └── sidepanel.css             # Side panel styles
└── icons/
    └── icon128.png               # Extension icon
```

---

## 12. Manifest

```json
{
  "manifest_version": 3,
  "name": "Twitter/X Tweet Scraper",
  "version": "1.0.0",
  "description": "Collect and scrape tweets for media monitoring and analysis",
  "permissions": ["activeTab", "storage", "sidePanel", "tabs"],
  "host_permissions": ["https://twitter.com/*", "https://x.com/*"],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["https://twitter.com/*", "https://x.com/*"],
      "js": ["db.js", "tweet-parser.js", "content.js"],
      "css": ["content.css"],
      "run_at": "document_idle"
    },
    {
      "matches": ["https://twitter.com/*", "https://x.com/*"],
      "js": ["network-interceptor.js"],
      "run_at": "document_start",
      "world": "MAIN"
    }
  ],
  "side_panel": {
    "default_path": "sidepanel/sidepanel.html"
  },
  "action": {
    "default_title": "Tweet Scraper"
  },
  "icons": { "128": "icons/icon128.png" }
}
```
