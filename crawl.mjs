#!/usr/bin/env node

/**
 * SCENE Magazine RSS Crawler + Static Site Generator
 *
 * Crawls RSS feeds from K-Drama/K-Culture/Entertainment news sites,
 * extracts article data, fetches full article content,
 * and generates self-contained static HTML pages.
 *
 * Variety/Deadline-style English entertainment journalism.
 *
 * Usage: node crawl.mjs
 * No dependencies needed — pure Node.js 18+ with built-in fetch.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// Configuration
// ============================================================

const SOURCES = [
  // === Tier 1: High-volume K-pop/K-drama news ===
  { name: 'Soompi', url: 'https://www.soompi.com/feed', lang: 'en' },
  { name: 'Koreaboo', url: 'https://www.koreaboo.com/feed/', lang: 'en' },
  { name: 'HelloKpop', url: 'https://www.hellokpop.com/feed/', lang: 'en' },
  { name: 'Seoulbeats', url: 'https://seoulbeats.com/feed/', lang: 'en' },
  // === Tier 2: Commentary & Reviews ===
  { name: 'AsianJunkie', url: 'https://www.asianjunkie.com/feed/', lang: 'en' },
  { name: 'TheBiasList', url: 'https://thebiaslist.com/feed/', lang: 'en' },
  // === Tier 3: Drama & entertainment ===
  { name: 'KDramaStars', url: 'https://www.kdramastars.com/rss.xml', lang: 'en' },
  { name: 'DramaBeans', url: 'https://www.dramabeans.com/feed/', lang: 'en' },
];

const FETCH_TIMEOUT = 10_000;
const OG_IMAGE_TIMEOUT = 8_000;
const ARTICLE_FETCH_TIMEOUT = 12_000;
const MAX_OG_IMAGE_FETCHES = 40;
const OG_IMAGE_CONCURRENCY = 10;
const ARTICLE_FETCH_CONCURRENCY = 5;
const PLACEHOLDER_IMAGE = 'https://picsum.photos/seed/scene-placeholder/800/450';

const log = (msg) => console.log(`[SCENE Crawler] ${msg}`);
const warn = (msg) => console.warn(`[SCENE Crawler] WARN: ${msg}`);

// ============================================================
// Fetch with timeout
// ============================================================

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// XML Parsing helpers (regex-based, no dependencies)
// ============================================================

function extractTag(xml, tagName) {
  const cdataRe = new RegExp(`<${tagName}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tagName}>`, 'i');
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = xml.match(re);
  return match ? match[1].trim() : '';
}

function extractAllTags(xml, tagName) {
  const results = [];
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'gi');
  let match;
  while ((match = re.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

function extractAttribute(xml, tagName, attrName) {
  const re = new RegExp(`<${tagName}[^>]*?${attrName}\\s*=\\s*["']([^"']+)["']`, 'i');
  const match = xml.match(re);
  return match ? match[1] : '';
}

function extractItems(xml) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = re.exec(xml)) !== null) {
    items.push(match[1]);
  }
  return items;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8217;/g, "\u2019")
    .replace(/&#8216;/g, "\u2018")
    .replace(/&#8220;/g, "\u201C")
    .replace(/&#8221;/g, "\u201D")
    .replace(/&#8230;/g, "\u2026")
    .replace(/&#038;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, '').trim();
}

// ============================================================
// Image extraction
// ============================================================

function extractImageFromContent(content) {
  if (!content) return '';

  const mediaUrl = extractAttribute(content, 'media:content', 'url')
    || extractAttribute(content, 'media:thumbnail', 'url');
  if (mediaUrl) return mediaUrl;

  const enclosureUrl = extractAttribute(content, 'enclosure', 'url');
  if (enclosureUrl) {
    const enclosureType = extractAttribute(content, 'enclosure', 'type');
    if (!enclosureType || enclosureType.startsWith('image')) return enclosureUrl;
  }

  const imgMatch = content.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];

  return '';
}

async function fetchOgImage(articleUrl) {
  try {
    const html = await fetchWithTimeout(articleUrl, OG_IMAGE_TIMEOUT);
    const ogMatch = html.match(/<meta[^>]+property\s*=\s*["']og:image["'][^>]+content\s*=\s*["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+property\s*=\s*["']og:image["']/i);
    if (ogMatch) return ogMatch[1];
    return '';
  } catch {
    return '';
  }
}

// ============================================================
// Date formatting — English format
// ============================================================

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  } catch {
    return '';
  }
}

// ============================================================
// REWRITE ENGINE — Variety/Deadline editorial English style
// ============================================================

const KNOWN_GROUPS = [
  'BTS', 'BLACKPINK', 'TWICE', 'EXO', 'NCT', 'aespa', 'Stray Kids', 'ENHYPEN',
  'TXT', 'ATEEZ', 'SEVENTEEN', 'Red Velvet', 'IVE', 'LE SSERAFIM', 'NewJeans',
  '(G)I-DLE', 'ITZY', 'NMIXX', 'Kep1er', 'TREASURE', 'MAMAMOO', 'SHINee',
  'GOT7', 'MONSTA X', 'iKON', 'WINNER', '2NE1', "Girls' Generation", 'Super Junior',
  'BIGBANG', 'LOONA', 'fromis_9', 'tripleS', 'Dreamcatcher', 'VIVIZ',
  'Brave Girls', 'OH MY GIRL', 'Apink', 'BTOB', 'PENTAGON', 'SF9', 'THE BOYZ',
  'Golden Child', 'ONEUS', 'VERIVERY', 'CIX', 'VICTON', 'AB6IX', 'WEi',
  'CRAVITY', 'P1Harmony', 'TEMPEST', 'YOUNITE', 'Xdinary Heroes', 'Billlie',
  'LIGHTSUM', 'Weki Meki', 'Cherry Bullet', 'Rocket Punch', 'Purple Kiss',
  'Lapillus', 'FIFTY FIFTY', 'KISS OF LIFE', 'BABYMONSTER', 'ILLIT',
  'ZEROBASEONE', 'RIIZE', 'TWS', 'BOYNEXTDOOR', 'xikers', 'NCT 127',
  'NCT DREAM', 'WayV', 'NCT WISH', 'SNSD', 'f(x)', 'EXO-CBX', 'Super M',
  'Girls Generation', 'DAY6', 'ASTRO', 'Kara', 'INFINITE', 'BEAST',
  'Highlight', 'Block B', 'B.A.P', 'VIXX', 'CNBLUE', 'FTIsland',
  'ZB1', 'G-IDLE',
];

const KNOWN_SOLOISTS = [
  'V', 'Jungkook', 'Jennie', 'Lisa', 'Ros\u00e9', 'Jisoo', 'Suga', 'RM', 'J-Hope',
  'Jin', 'Jimin', 'Winter', 'Karina', 'Giselle', 'NingNing', 'Taeyeon', 'IU',
  'Sunmi', 'HyunA', 'Hwasa', 'Solar', 'Joy', 'Irene', 'Yeri', 'Wendy', 'Seulgi',
  'Mark', 'Taeyong', 'Jaehyun', 'Doyoung', 'Haechan', 'Jeno', 'Jaemin', 'Renjun',
  'Chenle', 'Jisung', 'Bangchan', 'Hyunjin', 'Felix', 'Han', 'Lee Know', 'Changbin',
  'Seungmin', 'I.N', 'Heeseung', 'Jay', 'Jake', 'Sunghoon', 'Sunoo', 'Jungwon',
  'Ni-ki', 'Soobin', 'Yeonjun', 'Beomgyu', 'Taehyun', 'Hueningkai', 'Hongjoong',
  'Seonghwa', 'Yunho', 'Yeosang', 'San', 'Mingi', 'Wooyoung', 'Jongho',
  'S.Coups', 'Jeonghan', 'Joshua', 'Jun', 'Hoshi', 'Wonwoo', 'Woozi', 'DK',
  'Mingyu', 'The8', 'Seungkwan', 'Vernon', 'Dino', 'Wonyoung', 'Yujin', 'Gaeul',
  'Liz', 'Leeseo', 'Rei', 'Sakura', 'Chaewon', 'Kazuha', 'Eunchae', 'Minji',
  'Hanni', 'Danielle', 'Haerin', 'Hyein', 'Miyeon', 'Minnie', 'Soyeon', 'Yuqi',
  'Shuhua', 'Yeji', 'Lia', 'Ryujin', 'Chaeryeong', 'Yuna', 'Sullyoon', 'Haewon',
  'Lily', 'Bae', 'Jiwoo', 'Kyujin', 'Cha Eun Woo', 'Park Bo Gum',
  'Song Joong Ki', 'Lee Min Ho', 'Kim Soo Hyun', 'Park Seo Joon', 'Jung Hae In',
  'Song Hye Kyo', 'Jun Ji Hyun', 'Kim Ji Won', 'Han So Hee', 'Suzy',
  'Park Shin Hye', 'Lee Sung Kyung', 'Yoo Yeon Seok', 'Park Na Rae',
  'Taemin', 'Baekhyun', 'Chanyeol', 'D.O.', 'Kai', 'Sehun', 'Xiumin',
  'Lay', 'Chen', 'Suho', 'GDragon', 'G-Dragon', 'Taeyang', 'Daesung',
  'Seungri', 'TOP', 'CL', 'Dara', 'Bom', 'Minzy', 'Zico',
  'Jackson', 'BamBam', 'Yugyeom', 'Youngjae', 'JB', 'Jinyoung',
  'Nayeon', 'Jeongyeon', 'Momo', 'Sana', 'Jihyo', 'Mina', 'Dahyun',
  'Chaeyoung', 'Tzuyu',
];

const ALL_KNOWN_NAMES = [...KNOWN_GROUPS, ...KNOWN_SOLOISTS]
  .sort((a, b) => b.length - a.length);

// ---- Topic classifier ----

const TOPIC_KEYWORDS = {
  comeback:     ['comeback', 'return', 'back', 'coming back', 'pre-release'],
  chart:        ['chart', 'billboard', 'number', 'record', 'no.1', '#1', 'top 10', 'million', 'stream', 'sales'],
  release:      ['album', 'single', 'ep', 'tracklist', 'release', 'drop', 'mini-album', 'mini album', 'full album'],
  concert:      ['concert', 'tour', 'live', 'stage', 'arena', 'stadium', 'world tour', 'encore'],
  fashion:      ['fashion', 'style', 'outfit', 'airport', 'look', 'brand', 'ambassador', 'vogue', 'elle'],
  award:        ['award', 'win', 'trophy', 'daesang', 'bonsang', 'grammy', 'mama', 'golden disc', 'melon'],
  variety:      ['variety', 'show', 'tv', 'running man', 'knowing bros', 'weekly idol', 'guest'],
  sns:          ['sns', 'social media', 'instagram', 'twitter', 'tiktok', 'viral', 'trending', 'post'],
  collaboration:['collaboration', 'collab', 'featuring', 'feat', 'team up', 'duet', 'joint', 'partnership'],
  debut:        ['debut', 'launch', 'pre-debut', 'trainee', 'survival', 'rookie'],
  general:      [],
};

// ---- Title templates per topic (Variety/Deadline English) ----

const TITLE_TEMPLATES = {
  comeback: [
    '{artist} Set to Return With Highly Anticipated Comeback',
    '{artist} Confirm New Era as Comeback Details Emerge',
    'Exclusive: {artist} Comeback Plans Revealed',
    '{artist} Gear Up for Major Comeback Amid Rising Anticipation',
    '{artist} Signal Fresh Chapter With Upcoming Return',
  ],
  release: [
    '{artist} Drop New Single to Critical Acclaim',
    'New Music: {artist} Deliver on Expectations With Latest Release',
    '{artist}\'s Latest Track Sets Charts Ablaze',
    '{artist} Unveil New Project That Pushes Creative Boundaries',
    'Review: {artist}\'s New Album Marks a Bold Evolution',
  ],
  concert: [
    'Concert Review: {artist} Command the Stage in Electrifying Show',
    '{artist} Tour Grosses Big Numbers as Live Shows Sell Out',
    'Inside {artist}\'s Record-Breaking Concert Tour',
    '{artist} Deliver Unforgettable Live Experience for Sold-Out Crowd',
    '{artist} Announce Massive Tour Expansion Following Demand',
  ],
  award: [
    '{artist} Take Home Top Prize at Major Awards Show',
    'Awards Roundup: {artist} Score Big Win',
    '{artist}\'s Award Victory Caps Career-Best Year',
    '{artist} Honored With Prestigious Recognition at Ceremony',
    'Breaking: {artist} Claim Multiple Awards in Dominant Showing',
  ],
  variety: [
    '{artist} Charm Audiences in Variety Show Appearance',
    'Watch: {artist} Steal the Show on Hit TV Program',
    '{artist} Go Viral After Unscripted TV Moment',
    '{artist}\'s Television Debut Earns Rave Reviews From Viewers',
    '{artist} Showcase Hidden Talents in Popular Variety Segment',
  ],
  fashion: [
    '{artist} Named New Face of Luxury Fashion Brand',
    'Style File: How {artist} Are Reshaping K-Pop Fashion',
    '{artist}\'s Red Carpet Looks Turn Heads',
    '{artist} Cement Status as Fashion Icons With Latest Campaign',
    'From Stage to Runway: {artist} Make Waves in Fashion World',
  ],
  sns: [
    '{artist}\'s Social Media Post Breaks Platform Records',
    'Trending: {artist} Go Viral With Latest Online Update',
    '{artist}\'s Fan Interaction Sets New Social Media Standard',
    '{artist} Break the Internet With Surprise Social Post',
    'How {artist} Became the Most-Discussed Act on Social Media',
  ],
  collaboration: [
    '{artist} Team Up With Global Star for Surprise Collab',
    'Industry Buzz: {artist} Partnership Deal Signals Major Expansion',
    'Breaking: {artist} Announce High-Profile Collaboration',
    '{artist}\'s Cross-Genre Collaboration Generates Industry Excitement',
    'Exclusive: Inside {artist}\'s Highly Anticipated New Partnership',
  ],
  debut: [
    'Ones to Watch: Rookie Group {artist} Make Splashy Debut',
    '{artist} Arrive on Scene With Impressive First Release',
    'K-Pop\'s Newest Act {artist} Show Star Potential at Debut',
    '{artist} Launch Career With Statement Debut That Turns Heads',
    'The Rise Begins: {artist} Deliver a Debut Worth Watching',
  ],
  chart: [
    '{artist} Shatter Records With Latest Chart Performance',
    'By the Numbers: {artist}\'s Chart Dominance Explained',
    '{artist} Claim No. 1 in Multiple Territories',
    '{artist}\'s Chart-Topping Run Continues With New Milestone',
    'Chart Watch: {artist} Maintain Stranglehold on Global Rankings',
  ],
  general: [
    'Inside the Story Shaking Up the K-Culture World',
    'Entertainment Industry Reacts to Major K-Pop Development',
    'The Biggest Story in K-Culture This Week',
    '{artist} Remain at Center of Industry Conversation',
    '{artist} Make Headlines With Latest Career Move',
    'What {artist}\'s Latest Move Means for the K-Pop Landscape',
    '{artist} Continue to Redefine the Genre With Every Step',
    'Why {artist} Are the Act Everyone Is Talking About Right Now',
  ],
};

const NO_ARTIST_TEMPLATES = [
  'Inside the Story Shaking Up the K-Culture World',
  'Entertainment Industry Reacts to Major K-Pop Development',
  'The Biggest Story in K-Culture This Week',
  'Tracking the Latest Shift in the K-Entertainment Landscape',
  'K-Culture Update: The Stories Driving This Week\'s Conversation',
  'Industry Report: What the Latest Headlines Mean for K-Pop',
  'The Week in K-Culture: Developments You Need to Know',
  'Breaking Down the Biggest K-Entertainment Story of the Moment',
  'From Seoul to the World: This Week\'s Must-Know Culture News',
  'K-Pop & Beyond: The Headlines Reshaping the Industry',
  'Industry Insiders Weigh In on Major K-Culture Development',
  'The Stories Behind the Headlines in K-Entertainment',
];

// ---- Display categories ----

const DISPLAY_CATEGORIES = {
  comeback: 'BREAKING',
  release: 'NEW MUSIC',
  concert: 'LIVE',
  award: 'AWARDS',
  variety: 'TV',
  fashion: 'STYLE',
  sns: 'SOCIAL',
  collaboration: 'COLLAB',
  debut: 'DEBUT',
  chart: 'CHARTS',
  general: 'CULTURE',
};

// ---- Helper ----

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---- Artist extraction ----

const COMMON_ENGLISH_WORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'here', 'why', 'how', 'what',
  'when', 'who', 'which', 'where', 'watch', 'check', 'best', 'top', 'new',
  'breaking', 'exclusive', 'official', 'first', 'latest', 'all', 'every',
  'open', 'just', 'more', 'most', 'some', 'many', 'after', 'before',
  'korean', 'kpop', 'k-pop', 'idol', 'idols', 'legendary', 'former',
  'young', 'old', 'big', 'small', 'great', 'good', 'bad', 'real',
  'full', 'final', 'last', 'next', 'other', 'another', 'each', 'both',
  'only', 'even', 'still', 'also', 'already', 'never', 'always', 'again',
  'now', 'then', 'today', 'week', 'weekly', 'daily', 'year', 'month',
  'thread', 'list', 'review', 'reviews', 'roundup', 'recap', 'guide',
  'report', 'reports', 'update', 'updates', 'news', 'story', 'stories',
  'song', 'songs', 'album', 'albums', 'track', 'tracks', 'single', 'singles',
  'music', 'video', 'drama', 'movie', 'show', 'shows', 'stage', 'live',
  'tour', 'concert', 'award', 'awards', 'chart', 'charts', 'record',
  'debut', 'comeback', 'release', 'releases', 'performance', 'cover',
  'photo', 'photos', 'fashion', 'style', 'beauty', 'look', 'looks',
  'will', 'can', 'could', 'would', 'should', 'may', 'might', 'must',
  'does', 'did', 'has', 'had', 'have', 'been', 'being', 'are', 'were',
  'get', 'gets', 'got', 'make', 'makes', 'made', 'take', 'takes', 'took',
  'give', 'gives', 'gave', 'come', 'comes', 'came', 'keep', 'keeps', 'kept',
  'let', 'say', 'says', 'said', 'see', 'sees', 'saw', 'know', 'knows',
  'think', 'find', 'finds', 'want', 'wants', 'tell', 'tells',
  'ask', 'asks', 'work', 'works', 'seem', 'seems', 'feel', 'feels',
  'try', 'tries', 'start', 'starts', 'need', 'needs', 'run', 'runs',
  'move', 'moves', 'play', 'plays', 'pay', 'pays', 'hear', 'hears',
  'during', 'about', 'with', 'from', 'into', 'over', 'under', 'between',
  'through', 'against', 'without', 'within', 'along', 'behind',
  'inside', 'outside', 'above', 'below', 'upon', 'onto', 'toward',
  'for', 'but', 'not', 'yet', 'nor', 'and', 'or', 'so',
  'while', 'since', 'until', 'unless', 'because', 'although', 'though',
  'if', 'than', 'whether', 'once', 'twice',
  'his', 'her', 'its', 'our', 'their', 'my', 'your',
  'he', 'she', 'it', 'we', 'they', 'you', 'me', 'him', 'us', 'them',
  'no', 'yes', 'not', "don't", "doesn't", "didn't", "won't", "can't",
  'eight', 'five', 'four', 'nine', 'one', 'seven', 'six', 'ten', 'three', 'two',
  'up', 'down', 'out', 'off', 'on', 'in', 'at', 'to', 'by', 'of',
  'coming', 'going', 'looking', 'rising', 'star', 'stars',
  'spill', 'spills', 'choi', 'lee', 'kim', 'park', 'jung', 'shin',
  'won', 'min', 'sung', 'hyun', 'jae', 'hye',
]);

const SHORT_AMBIGUOUS_NAMES = new Set(['V', 'TOP', 'CL', 'JB', 'DK', 'Jun', 'Jay', 'Kai', 'Lay', 'Bom', 'Liz', 'Bae', 'Han', 'San', 'Rei', 'Lia']);

function extractArtist(title) {
  for (const name of ALL_KNOWN_NAMES) {
    if (SHORT_AMBIGUOUS_NAMES.has(name)) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[\\s,;:'"(\\[])${escaped}(?=[\\s,;:'"')\\]!?.]|$)`, 'i');
    if (re.test(title)) return name;
  }

  for (const name of SHORT_AMBIGUOUS_NAMES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[\\s,;:'"(\\[])${escaped}(?=[\\s,;:'"')\\]!?.]|$)`);
    if (re.test(title)) {
      const pos = title.indexOf(name);
      if (pos <= 5) return name;
    }
  }

  const leadingName = title.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/);
  if (leadingName) {
    const candidate = leadingName[1];
    const words = candidate.split(/\s+/);
    const allWordsValid = words.every(w => !COMMON_ENGLISH_WORDS.has(w.toLowerCase()));
    if (allWordsValid && words.length >= 2 && words.length <= 4) return candidate;
  }

  return null;
}

function classifyTopic(title) {
  const lower = title.toLowerCase();
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    for (const kw of keywords) {
      if (kw && lower.includes(kw)) return topic;
    }
  }
  return 'general';
}

function rewriteTitle(originalTitle) {
  const artist = extractArtist(originalTitle);
  const topic = classifyTopic(originalTitle);

  if (artist) {
    const templates = TITLE_TEMPLATES[topic] || TITLE_TEMPLATES.general;
    const template = pickRandom(templates);
    return template.replace(/\{artist\}/g, artist);
  }

  return pickRandom(NO_ARTIST_TEMPLATES);
}

// ============================================================
// Image downloading
// ============================================================

const IMAGES_DIR = join(__dirname, 'images');
const ARTICLES_DIR = join(__dirname, 'articles');

async function downloadImage(url, filename) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': new URL(url).origin,
      },
    });
    clearTimeout(timer);

    if (!res.ok || !res.body) return null;

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('image')) return null;

    const ext = contentType.includes('png') ? '.png'
      : contentType.includes('webp') ? '.webp'
      : '.jpg';
    const localFile = `${filename}${ext}`;
    const localPath = join(IMAGES_DIR, localFile);

    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(localPath, buffer);

    return `images/${localFile}`;
  } catch {
    return null;
  }
}

async function downloadArticleImages(articles) {
  await mkdir(IMAGES_DIR, { recursive: true });

  log('Downloading article images locally...');
  let downloaded = 0;
  const BATCH = 8;

  for (let i = 0; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    await Promise.allSettled(
      batch.map(async (article, idx) => {
        if (!article.image || article.image.includes('picsum.photos')) return;
        const safeName = `article-${i + idx}-${Date.now() % 100000}`;
        const localPath = await downloadImage(article.image, safeName);
        if (localPath) {
          article.originalImage = article.image;
          article.image = localPath;
          downloaded++;
        }
      })
    );
  }

  log(`  Downloaded ${downloaded}/${articles.length} images locally`);
}

// ============================================================
// Display category
// ============================================================

function displayCategory(article) {
  const topic = classifyTopic(article.originalTitle || article.title);
  return DISPLAY_CATEGORIES[topic] || 'CULTURE';
}

// ============================================================
// RSS Feed Parsing
// ============================================================

// Filter out non-K-culture content (esports, gaming, etc.)
const BLOCKED_KEYWORDS = [
  'esports', 'esport', 'e-sports', 'counter-strike', 'valorant', 'league of legends',
  'overwatch', 'fortnite', 'minecraft', 'gaming', 'gamer', 'twitch streamer',
  'cheating during', 'tournament ban', 'fps game', 'moba',
];

function isRelevantContent(title, description) {
  const combined = `${title} ${description}`.toLowerCase();
  for (const keyword of BLOCKED_KEYWORDS) {
    if (combined.includes(keyword)) return false;
  }
  return true;
}

function parseRssFeed(xml, sourceName) {
  const items = extractItems(xml);
  const articles = [];

  for (const item of items) {
    const title = decodeHtmlEntities(stripHtml(extractTag(item, 'title')));
    const link = extractTag(item, 'link');
    const pubDate = extractTag(item, 'pubDate');
    const creator = extractTag(item, 'dc:creator');
    const categories = extractAllTags(item, 'category').map(c => decodeHtmlEntities(stripHtml(c)));
    const category = categories[0] || 'News';
    const description = extractTag(item, 'description');
    const contentEncoded = extractTag(item, 'content:encoded');

    let image = extractImageFromContent(item);
    if (!image) image = extractImageFromContent(contentEncoded);
    if (!image) image = extractImageFromContent(description);

    if (!title || !link) continue;

    // Filter out non-K-culture content
    if (!isRelevantContent(title, stripHtml(description || ''))) {
      continue;
    }

    articles.push({
      title,
      link,
      pubDate: pubDate ? new Date(pubDate) : new Date(),
      formattedDate: formatDate(pubDate),
      creator,
      category,
      categories,
      image,
      source: sourceName,
      articleContent: null,
    });
  }

  return articles;
}

// ============================================================
// Fetch all feeds
// ============================================================

async function fetchAllFeeds() {
  const allArticles = [];

  for (const source of SOURCES) {
    try {
      log(`Fetching ${source.name}...`);
      const xml = await fetchWithTimeout(source.url);
      const articles = parseRssFeed(xml, source.name);
      log(`  ${source.name}: ${articles.length} articles`);
      allArticles.push(...articles);
    } catch (err) {
      warn(`Failed to fetch ${source.name}: ${err.message}`);
    }
  }

  allArticles.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

  log(`Total: ${allArticles.length} articles`);
  return allArticles;
}

// ============================================================
// Fill missing images via og:image
// ============================================================

async function fillMissingImages(articles) {
  const needsImage = articles.filter(a => !a.image);
  if (needsImage.length === 0) return;

  const toFetch = needsImage.slice(0, MAX_OG_IMAGE_FETCHES);
  log(`Extracting og:image for ${toFetch.length} articles (concurrency: ${OG_IMAGE_CONCURRENCY})...`);

  let found = 0;
  for (let i = 0; i < toFetch.length; i += OG_IMAGE_CONCURRENCY) {
    const batch = toFetch.slice(i, i + OG_IMAGE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (article) => {
        const ogImage = await fetchOgImage(article.link);
        if (ogImage) {
          article.image = ogImage;
          return true;
        }
        return false;
      })
    );
    found += results.filter(r => r.status === 'fulfilled' && r.value === true).length;
  }

  log(`  Found og:image for ${found}/${toFetch.length} articles`);
}

// ============================================================
// Fetch article content from original pages
// ============================================================

function extractArticleContent(html) {
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<div[^>]*class\s*=\s*["'][^"']*(?:sidebar|comment|social|share|related|ad-|ads-|advertisement|cookie|popup|modal|newsletter)[^"']*["'][\s\S]*?<\/div>/gi, '');

  const articleBodyPatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]*class\s*=\s*["'][^"']*(?:article-body|article-content|entry-content|post-content|story-body|content-body|single-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class\s*=\s*["'][^"']*(?:post-entry|article-text|body-text|main-content|article__body|post__content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];

  let bodyHtml = '';
  for (const pattern of articleBodyPatterns) {
    const match = cleaned.match(pattern);
    if (match) {
      bodyHtml = match[1];
      break;
    }
  }

  if (!bodyHtml) bodyHtml = cleaned;

  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pMatch;
  while ((pMatch = pRegex.exec(bodyHtml)) !== null) {
    const text = stripHtml(decodeHtmlEntities(pMatch[1])).trim();
    if (text.length > 30 &&
        !text.match(/^(advertisement|sponsored|also read|read more|related:|source:|photo:|credit:|getty|shutterstock|loading)/i)) {
      paragraphs.push(text);
    }
  }

  const images = [];
  const imgRegex = /<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(bodyHtml)) !== null) {
    const src = imgMatch[1];
    if (src && !src.includes('avatar') && !src.includes('icon') && !src.includes('logo') &&
        !src.includes('1x1') && !src.includes('pixel') && !src.includes('tracking')) {
      images.push(src);
    }
  }

  return { paragraphs, images };
}

async function fetchArticleContent(article) {
  try {
    const html = await fetchWithTimeout(article.link, ARTICLE_FETCH_TIMEOUT);
    return extractArticleContent(html);
  } catch {
    return { paragraphs: [], images: [] };
  }
}

async function fetchAllArticleContent(articles) {
  const toFetch = articles.slice(0, 50);
  log(`Fetching full article content for ${toFetch.length} articles (concurrency: ${ARTICLE_FETCH_CONCURRENCY})...`);

  let fetched = 0;
  for (let i = 0; i < toFetch.length; i += ARTICLE_FETCH_CONCURRENCY) {
    const batch = toFetch.slice(i, i + ARTICLE_FETCH_CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (article) => {
        const content = await fetchArticleContent(article);
        if (content.paragraphs.length > 0) {
          article.articleContent = content;
          fetched++;
        }
      })
    );
  }

  log(`  Fetched content for ${fetched}/${toFetch.length} articles`);
}

// ============================================================
// Article body generation — English entertainment journalism
// ============================================================

const BODY_TEMPLATES = {
  comeback: {
    opening: [
      'In a move that has sent shockwaves through the K-pop industry, {artist} have officially confirmed their highly anticipated comeback. The announcement, which comes after months of speculation and teaser campaigns, signals a bold new direction for one of the genre\'s most influential acts.',
      'The wait is finally over for fans of {artist}, as the group has unveiled plans for a major comeback that promises to reshape expectations. Industry insiders say this return has been in the works for some time, with the creative team pushing boundaries in ways that could redefine {artist}\'s artistic identity.',
      '{artist} are poised to make one of the most significant returns in recent K-pop memory. According to sources close to the production, this comeback represents a deliberate evolution in both sound and visual storytelling, one that the group has been carefully crafting behind closed doors.',
    ],
    analysis: [
      'Industry analysts point to {artist}\'s comeback as a bellwether for broader trends in the K-pop market. With competition at an all-time high and global audiences more discerning than ever, the pressure to deliver a statement-making return has never been greater. Early indications suggest {artist} have risen to the challenge, with production credits that read like a who\'s-who of contemporary pop music.',
      'What makes this comeback particularly noteworthy is the strategic timing. {artist}\'s label has orchestrated a rollout that maximizes impact across multiple markets simultaneously, a playbook that other agencies are watching closely. The pre-release content has already generated significant engagement metrics, with trailer views outpacing previous campaigns by a considerable margin.',
      'From a musical standpoint, {artist}\'s upcoming release appears to represent a maturation of their signature sound. Sources describe the new material as ambitious yet accessible, a balance that has become increasingly difficult to strike in today\'s fragmented listening landscape. The group\'s involvement in the creative process has reportedly been more hands-on than in any previous project.',
    ],
    closing: [
      'As {artist} prepare to reclaim the spotlight, all eyes will be on the numbers, the critical reception, and the cultural conversation that follows. SCENE will continue to track this developing story as more details emerge.',
      'The coming weeks will reveal whether {artist}\'s comeback lives up to the considerable hype. For now, the industry consensus is clear: this is one return that demands attention.',
    ],
  },
  release: {
    opening: [
      '{artist} have dropped their latest release into an increasingly competitive K-pop landscape, and the early verdict is in: this is a project that demands to be taken seriously. From its opening track to its final note, the new work represents a confident artistic statement from an act that continues to evolve.',
      'The new release from {artist} arrives with the weight of enormous expectation, and by most accounts, it delivers. Critics and fans alike have been quick to praise the project\'s ambition, its sonic palette, and the unmistakable growth on display throughout.',
      'With their latest drop, {artist} have once again demonstrated why they remain among the most compelling acts in K-pop. The new project is a showcase of range, moving between genres with a confidence that speaks to both artistic maturity and careful production.',
    ],
    analysis: [
      'Musically, the new {artist} project operates on multiple levels. The title track serves as a gateway, its hook-laden structure designed for maximum chart impact, while deeper cuts reward repeated listening with layered production and nuanced vocal performances. It is this duality that separates {artist} from the pack.',
      'Critical response has been overwhelmingly positive, with music journalists pointing to the release as evidence of {artist}\'s growing influence on the broader pop conversation. Streaming numbers have been robust across all major platforms, with particularly strong performance in markets that {artist} have traditionally found difficult to crack.',
      'The production credits tell their own story. {artist}\'s label has assembled a team of hitmakers and innovators, resulting in a project that sounds both of-the-moment and distinctly {artist}. The group\'s own contributions to songwriting and arrangement have not gone unnoticed, adding a personal dimension that elevates the material.',
    ],
    closing: [
      'Where {artist}\'s new release ultimately lands in the broader conversation remains to be seen, but the early trajectory is promising. SCENE will continue to monitor its chart performance and cultural impact.',
      '{artist}\'s latest offering confirms what many have long suspected: this is an act with staying power. Expect more coverage as the promotional cycle unfolds.',
    ],
  },
  concert: {
    opening: [
      'The lights went down, the crowd erupted, and for the duration of the show, {artist} proved why they are one of the most formidable live acts in the business. Their latest performance was not merely a concert; it was a masterclass in stagecraft, energy management, and audience connection.',
      '{artist} took the stage to a rapturous reception, and what followed was the kind of show that reminds you why live music matters. From the set design to the setlist curation, every element was calibrated for maximum impact, and the packed venue responded in kind.',
      'Box office numbers tell one story, but being in the room tells another entirely. {artist}\'s latest show was a testament to the group\'s evolution as performers, a two-hour display of precision, passion, and showmanship that left the audience wanting more.',
    ],
    analysis: [
      'The setlist was a carefully constructed journey through {artist}\'s catalogue, balancing crowd-pleasing anthems with deeper cuts that rewarded long-time fans. Production values were at an industry-leading level, with LED staging, pyrotechnics, and choreography that demonstrated the kind of investment typically reserved for the biggest names in global pop.',
      'What set this performance apart was {artist}\'s command of dynamics. The ability to shift from high-energy dance numbers to intimate acoustic moments without losing the audience\'s attention is a skill that takes years to develop, and {artist} executed it flawlessly. Between-song interactions felt genuine and unscripted, adding a warmth to the proceedings.',
      'From a business perspective, {artist}\'s touring numbers continue to track upward. Sell-out times have shortened, secondary market prices have increased, and the geographic footprint of the tour has expanded significantly. These are not just vanity metrics; they represent a tangible growth in {artist}\'s global commercial appeal.',
    ],
    closing: [
      'As {artist} prepare for the next leg of their tour, expectations will only continue to build. If this show was any indication, those expectations will be met. SCENE will have full coverage as dates are announced.',
      'The live show remains {artist}\'s most powerful calling card. SCENE will continue to report on their touring schedule and box office performance.',
    ],
  },
  award: {
    opening: [
      'In a night that will be long remembered, {artist} took home one of the most coveted prizes in the industry, capping a year of achievement that has elevated them to new heights. The award represents not just recognition of a single body of work, but an acknowledgment of {artist}\'s sustained excellence.',
      '{artist}\'s name echoed through the ceremony hall as they were announced as winners, a moment that felt both earned and overdue. The award cements their position in the upper echelon of K-pop, a tier where legacy begins to take shape.',
      'The trophy may be the most tangible outcome, but the real story of {artist}\'s award win is what it represents: validation from an industry that increasingly recognizes artistic risk-taking alongside commercial success.',
    ],
    analysis: [
      'The significance of this award extends beyond the trophy itself. For {artist}, it marks a turning point in how they are perceived by the industry establishment. Previous nominations had signaled growing respect, but a win of this magnitude changes the conversation entirely, placing {artist} in the company of acts that have defined eras.',
      '{artist}\'s acceptance speech struck a balance between gratitude and ambition, acknowledging the team behind the success while hinting at bigger plans ahead. Social media erupted in response, with congratulatory messages from fellow artists, industry executives, and fans spanning multiple continents.',
      'Awards shows are imperfect barometers of artistic merit, but they remain powerful cultural markers. {artist}\'s win sends a clear signal to the industry about the direction of popular taste and the kind of artistry that resonates in the current moment.',
    ],
    closing: [
      'With this latest accolade, {artist} have firmly established themselves as one of the defining acts of their generation. What comes next is anyone\'s guess, but the foundation has never been stronger. SCENE will be watching.',
      'The award is a milestone, not a destination. {artist}\'s trajectory suggests the best may still be ahead. SCENE will continue to track their journey.',
    ],
  },
  variety: {
    opening: [
      '{artist}\'s appearance on one of Korea\'s top-rated variety programs has generated the kind of buzz that money can\'t buy. The episode, which showcased a side of {artist} rarely seen by the public, has become a trending topic and a viral sensation.',
      'Television audiences got a rare glimpse behind the carefully managed image of {artist} this week, and what they saw was refreshingly unguarded. The group\'s variety show debut has been praised for its authenticity, humor, and the kind of genuine personality that fans crave.',
      'In the age of carefully curated content, {artist}\'s unscripted variety appearance stood out for all the right reasons. The episode has generated clip compilations, meme formats, and the kind of organic social media engagement that promotional teams dream about.',
    ],
    analysis: [
      'The strategic value of variety appearances for K-pop acts cannot be overstated. For {artist}, this outing served multiple purposes: humanizing the brand, reaching demographics outside the core fandom, and generating shareable content during a key promotional window. By all metrics, the gambit paid off.',
      'What struck viewers most was {artist}\'s natural chemistry with the show\'s hosts, a dynamic that cannot be manufactured. The resulting clips have accumulated millions of views across platforms, extending {artist}\'s reach well beyond the traditional K-pop media ecosystem.',
    ],
    closing: [
      '{artist}\'s variety debut has opened new doors in terms of mainstream visibility. Whether this translates to sustained crossover appeal remains to be seen. SCENE will be tracking the numbers.',
      'The episode confirms what many suspected: {artist} have the personality to match the talent. Expect more television appearances in the coming months.',
    ],
  },
  fashion: {
    opening: [
      '{artist} continue to blur the line between music and fashion, and their latest venture only reinforces a status that has become increasingly difficult to ignore. The intersection of K-pop and luxury fashion has become one of the industry\'s most lucrative frontiers, and {artist} are at the forefront.',
      'When {artist} stepped out in their latest ensemble, the fashion world took notice. The look, which was immediately dissected across social media and fashion publications alike, represents the latest chapter in an ongoing narrative about K-pop\'s growing influence on global style.',
      'The fashion industry\'s embrace of {artist} has moved well beyond the ambassadorship phase. What we are witnessing now is a genuine creative partnership, one where {artist}\'s aesthetic sensibility is shaping brand direction as much as the other way around.',
    ],
    analysis: [
      'From a market perspective, {artist}\'s fashion influence is measurable. Items worn or endorsed by the group have demonstrated a consistent sell-through rate that luxury brands find irresistible. This "effect" has become a case study in how celebrity partnerships can drive both brand awareness and direct-to-consumer sales.',
      'Style analysts note that {artist}\'s approach to fashion is characterized by a willingness to take risks while maintaining a coherent personal brand. This balance, which is difficult to achieve and even harder to sustain, has earned {artist} a level of fashion credibility that extends beyond the typical K-pop association.',
    ],
    closing: [
      '{artist}\'s fashion footprint continues to expand, and the industry is paying attention. SCENE will continue to cover the intersection of K-pop and style as it evolves.',
      'As the lines between entertainment and fashion continue to dissolve, {artist} remain one of the most compelling figures at the intersection. More coverage to follow.',
    ],
  },
  sns: {
    opening: [
      'In the digital arena where virality is currency, {artist} have once again proven their dominance. A single social media post has generated engagement numbers that rival those of dedicated marketing campaigns, underscoring the group\'s extraordinary connection with their online following.',
      '{artist}\'s latest social media moment has captured the attention of platforms worldwide. The post, which quickly became one of the most-engaged-with pieces of content in the K-pop space this week, demonstrates the kind of organic reach that makes {artist} a powerhouse in digital media.',
      'Social media metrics can be fickle indicators, but when {artist} post, the numbers tell a consistent story: this is an act with an audience that is not just large, but deeply engaged. Their latest online interaction has set new benchmarks for fan engagement in the K-pop space.',
    ],
    analysis: [
      'Digital strategists point to {artist}\'s social media success as a blueprint for authentic audience engagement. Unlike manufactured viral moments, {artist}\'s online presence succeeds because it offers something fans genuinely value: access, personality, and a sense of reciprocal connection.',
      'The ripple effects of {artist}\'s social media activity extend beyond vanity metrics. Trending hashtags, user-generated content, and cross-platform sharing create an amplification loop that extends the reach of every post exponentially. For {artist}\'s management, this organic virality represents an invaluable promotional asset.',
    ],
    closing: [
      'In a media landscape that rewards attention above all else, {artist}\'s social media prowess is a strategic advantage that continues to compound. SCENE will monitor the evolving digital conversation.',
      '{artist}\'s social media influence shows no signs of plateauing. Stay tuned to SCENE for continued analysis of their digital footprint.',
    ],
  },
  collaboration: {
    opening: [
      'When the news broke that {artist} would be teaming up for a high-profile collaboration, the industry reaction was immediate and emphatic. This is precisely the kind of cross-pollination that the K-pop market has been yearning for, and early indications suggest the partnership delivers on its considerable promise.',
      '{artist} have entered into what insiders are calling one of the most strategically significant collaborations of the year. The partnership, which pairs complementary artistic strengths, has the potential to open new markets and reach audiences that neither party could access alone.',
      'Collaborations in K-pop are often as much about business strategy as artistic expression. In the case of {artist}\'s latest partnership, however, the creative chemistry appears to be genuine, resulting in a project that transcends the typical feature model.',
    ],
    analysis: [
      'The commercial logic behind {artist}\'s collaboration is sound. By partnering with a complementary artist, {artist} gain access to new listener demographics while reinforcing their reputation for artistic versatility. Early streaming data suggests the strategy is working, with cross-pollination evident in the listener profiles.',
      'Musically, the collaboration works because both parties bring something distinct to the table. {artist}\'s signature elements are preserved while being enhanced by the creative input of their collaborator. The result is a track that feels fresh without alienating existing fans, a balance that is notoriously difficult to strike.',
    ],
    closing: [
      'Whether this collaboration leads to further joint projects remains to be seen, but the initial reception suggests there is appetite for more. SCENE will follow the story as it develops.',
      '{artist}\'s collaborative instincts continue to serve them well. This latest partnership adds another dimension to an already multifaceted career.',
    ],
  },
  debut: {
    opening: [
      'The K-pop landscape has a new contender, and the name to remember is {artist}. In a debut that has turned industry heads and generated significant social media traction, {artist} have announced their arrival with the kind of confidence that typically takes years to develop.',
      'Debut season in K-pop is always exciting, but some arrivals generate more heat than others. {artist}\'s entrance into the market is one such moment, a debut that has been met with the kind of anticipation usually reserved for established acts.',
      'If first impressions matter, then {artist} have made one that the industry will not soon forget. Their debut release combines polished production with genuine personality, a combination that suggests this act has been built to last.',
    ],
    analysis: [
      'What separates {artist}\'s debut from the crowded field is the level of preparation evident in every aspect of the rollout. The music, the visuals, the messaging: all speak to a debut strategy that has been carefully plotted. Industry observers note that {artist}\'s label has clearly invested significant resources in this launch.',
      'The debut numbers, while important, tell only part of the story. What is more revealing is the composition of {artist}\'s early fanbase, a diverse, digitally engaged audience that suggests strong potential for sustained growth. Early fan community formation has been notably organic, a positive indicator for long-term career health.',
    ],
    closing: [
      'It is far too early to make definitive pronouncements about {artist}\'s career trajectory, but the debut has provided a strong foundation. SCENE will be following their progress closely.',
      '{artist}\'s debut has been a statement of intent. How they follow it up will be one of the more interesting stories to watch in the coming months.',
    ],
  },
  chart: {
    opening: [
      'The numbers are in, and they are remarkable. {artist}\'s latest chart performance has shattered expectations, establishing new benchmarks that underscore their growing dominance across multiple markets. In an era where chart success is increasingly difficult to achieve, {artist} continue to find ways to climb higher.',
      '{artist} have once again demonstrated their commercial firepower with a chart performance that has left the industry taking notice. The figures represent not just a single moment of success, but the culmination of a strategic campaign executed with precision.',
      'Chart analysts are scrambling to contextualize {artist}\'s latest achievement. The numbers, by any historical measure, are exceptional, and they point to an act whose commercial appeal is expanding rather than contracting.',
    ],
    analysis: [
      'Breaking down the data reveals several noteworthy trends. {artist}\'s streaming numbers have shown consistent growth across platforms, with particularly strong performance in key Western markets where K-pop acts have historically struggled to gain traction. This broadening of the listener base is a significant development.',
      'From a market intelligence perspective, {artist}\'s chart success is driven by a combination of factors: an engaged fanbase that mobilizes effectively, music that crosses demographic boundaries, and a promotional strategy that optimizes visibility across platforms. It is the intersection of these elements that produces chart-topping results.',
    ],
    closing: [
      '{artist}\'s chart trajectory continues to trend upward, and the industry implications are significant. SCENE will provide ongoing analysis as the numbers evolve.',
      'Whether {artist} can sustain this level of chart dominance will be one of the key stories to watch. SCENE has the analysis covered.',
    ],
  },
  general: {
    opening: [
      'In a development that has captured the attention of the K-culture industry, {artist} are once again at the center of a story that extends beyond the music. The latest news surrounding the group speaks to their growing influence across multiple facets of the entertainment landscape.',
      '{artist} continue to generate headlines, and the latest development is no exception. In an industry where staying relevant requires constant evolution, {artist} have demonstrated a knack for remaining at the forefront of the cultural conversation.',
      'The entertainment industry moves fast, but some stories demand closer examination. {artist}\'s latest move is one such story, a development that carries implications for both the group and the broader K-pop ecosystem.',
      'The K-culture world is buzzing with the latest news involving {artist}. As details continue to emerge, SCENE examines what this development means in the wider context of the industry\'s ongoing evolution.',
    ],
    analysis: [
      '{artist}\'s trajectory has been defined by a willingness to defy convention, and this latest chapter is no different. Industry analysts note that the group\'s approach to career management has become something of a case study in how to maintain relevance in an increasingly competitive market.',
      'What makes {artist}\'s story particularly compelling is the intersection of artistic ambition and commercial strategy. Every move appears calculated yet authentic, a paradox that few acts manage to sustain. The fan community\'s response has been overwhelmingly supportive, adding fuel to an already significant cultural moment.',
      'From a broader industry perspective, {artist}\'s latest move reflects larger shifts in how K-pop acts navigate the global entertainment landscape. The days of operating within a purely domestic framework are long gone; today\'s top acts must be global brands, cultural exports, and creative entities simultaneously. {artist} appear to understand this better than most.',
    ],
    closing: [
      'SCENE will continue to follow {artist}\'s journey as new developments emerge. In a fast-moving industry, staying informed has never been more important.',
      'Whatever comes next for {artist}, the story so far has been one worth telling. SCENE will have continued coverage and analysis.',
      'The latest chapter in {artist}\'s career is still being written. SCENE will be there for every significant development.',
    ],
  },
};

const NO_ARTIST_BODY = {
  opening: [
    'The K-culture industry is grappling with a development that has implications far beyond any single artist or label. As details continue to emerge, the entertainment world is taking stock of what this means for the future of the sector.',
    'In the fast-moving world of K-entertainment, some stories cut through the noise. The latest development has captured the attention of industry insiders and casual observers alike, prompting analysis of what may be a pivotal moment.',
    'The Korean entertainment landscape is in a state of perpetual evolution, and the latest headline is a prime example. What initially appeared to be a routine development has revealed layers of significance that merit closer examination.',
    'Entertainment news moves at a relentless pace, but certain stories have the gravity to slow the scroll. The latest report out of the K-culture world is one such story, carrying implications that extend across the industry.',
  ],
  analysis: [
    'Industry observers have been quick to weigh in on the significance of this development. The consensus, while not unanimous, suggests that we are witnessing a shift in how the K-entertainment industry operates, a change that could have lasting implications for artists, labels, and fans alike.',
    'The broader context is important here. The Korean entertainment industry has been undergoing rapid transformation, driven by global demand, technological disruption, and evolving consumer behavior. This latest development sits squarely at the intersection of these forces.',
    'What makes this story particularly relevant is its timing. Coming at a moment when the industry is already navigating significant change, this development adds another variable to an already complex equation. Stakeholders across the value chain are watching closely.',
  ],
  closing: [
    'SCENE will continue to monitor this developing story and provide analysis as new information becomes available. In an industry defined by constant change, informed perspective has never been more valuable.',
    'The full impact of this development may not be clear for some time. SCENE will be there when it is, with the reporting and analysis that the story demands.',
    'As the K-culture industry continues to evolve at pace, stories like this one serve as important markers of where the industry is heading. SCENE will keep you informed.',
  ],
};

const SHARED_PARAGRAPHS = {
  background: [
    '{artist}\'s career arc has been a study in strategic evolution. Since emerging on the scene, the group has consistently expanded their artistic and commercial footprint, building a fanbase that spans continents and demographics. Their ability to adapt without losing their core identity has been central to their sustained relevance.',
    'The K-pop industry in 2026 is a fundamentally different beast than it was even five years ago. Global streaming, social media virality, and an increasingly sophisticated international audience have raised the bar for what constitutes success. {artist} have not just kept pace with these changes; they have, in many respects, helped drive them.',
    'Industry data paints a compelling picture of {artist}\'s market position. Streaming numbers, social media engagement, and touring revenue have all trended upward, suggesting an act in the growth phase of their commercial trajectory rather than the plateau that typically follows initial breakout success.',
    '{artist}\'s influence extends beyond the immediate K-pop ecosystem. Their music, their fashion choices, and their cultural positioning have made them reference points in broader conversations about Asian pop culture\'s global ascendancy. This cross-domain impact is increasingly reflected in brand partnership valuations.',
    'Tracing {artist}\'s journey from their early days to their current standing reveals a consistent thread: a refusal to rest on past accomplishments. Each release, each tour, each public appearance has been treated as an opportunity to push further, a philosophy that has earned respect from both fans and industry veterans.',
    'Market analysts tracking the K-entertainment sector have identified {artist} as one of a handful of acts whose career trajectory serves as a leading indicator for broader industry health. When {artist} perform well, the data suggests, the sector as a whole tends to follow.',
  ],
  detail: [
    'Sources close to {artist}\'s camp describe a creative process that is more intensive than the finished product might suggest. Weeks of refinement, multiple revision cycles, and a willingness to discard material that does not meet internal standards have become hallmarks of {artist}\'s approach. Staff and collaborators consistently point to the group\'s work ethic as a distinguishing characteristic.',
    'Social media analytics tell a story of deepening engagement. {artist}\'s content consistently outperforms benchmarks for both reach and interaction, with fan-created derivative content adding an amplification layer that money cannot buy. Platform algorithms, it appears, have learned to love {artist} almost as much as their fans do.',
    '{artist}\'s current activity fits within a larger pattern of strategic positioning. The K-pop industry\'s global expansion, the rise of direct-to-fan platforms, and the increasing importance of narrative-driven content marketing all factor into {artist}\'s approach. They are not just responding to industry trends; they are helping to set them.',
    'The fan community\'s reaction has been instructive. Social listening data reveals a response that is not merely enthusiastic but analytically engaged, with fans dissecting every creative choice and strategic decision with a sophistication that reflects the maturing K-pop audience. This level of engagement creates a feedback loop that benefits {artist}\'s creative process.',
    'Music critics have noted that {artist}\'s output demonstrates an understanding of pop music history that goes beyond pastiche. References are woven in subtly, the production walks a line between trend-awareness and timelessness, and the vocal performances prioritize emotional truth over technical showmanship.',
    '{artist}\'s management has executed a promotional strategy that balances visibility with mystique, a calibration that is easier to describe than to achieve. The result is an act that feels simultaneously accessible and aspirational, a positioning that maximizes both commercial appeal and cultural cache.',
    'The international dimension of {artist}\'s appeal continues to strengthen. Market-by-market data reveals growth in territories that were previously considered secondary, suggesting that {artist}\'s content resonates across cultural boundaries in ways that confound simple explanations.',
  ],
  reaction: [
    'Fan reaction has been swift and emphatic, with social media platforms flooded with responses that range from analytical breakdowns to pure emotional outpouring. The hashtags associated with {artist}\'s latest news trended globally within hours, a testament to the organized efficiency of their fanbase.',
    'Industry peers have been generous in their response, with multiple artists and producers offering public congratulations and commentary. This kind of cross-fandom goodwill is relatively rare in the competitive K-pop landscape, and it speaks to the respect that {artist} have earned within the industry.',
    'International fans have been particularly vocal in their response. Translation teams have ensured that language barriers do not impede the flow of information, and regional fan communities have organized watch parties, streaming events, and charitable donations in {artist}\'s name.',
    'The online conversation has extended well beyond traditional K-pop spaces. General entertainment forums, music discussion platforms, and mainstream media outlets have all picked up the story, indicating that {artist}\'s relevance extends beyond their core demographic.',
    'Social media sentiment analysis reveals a response that is overwhelmingly positive, with negative engagement registering at negligible levels. For {artist}\'s brand management team, this kind of clean positive signal is invaluable, particularly in an era where public figures are increasingly vulnerable to backlash cycles.',
  ],
  impact: [
    'The ripple effects of {artist}\'s latest move are already being felt across the industry. Competitor labels are recalibrating their strategies, media outlets are adjusting their coverage allocations, and brand partners are reassessing the value proposition that K-pop talent represents. In short, when {artist} moves, the industry responds.',
    'From a cultural standpoint, {artist}\'s continued success carries significance beyond the entertainment industry. They represent a larger narrative about Korean soft power, global cultural exchange, and the democratization of pop music fandom. These are themes that will only grow more relevant as the market continues to evolve.',
    'Entertainment industry economists are watching {artist}\'s trajectory with interest. The act\'s ability to generate revenue across multiple streams simultaneously, from music and touring to brand partnerships and content licensing, represents a model that others in the industry are eager to replicate.',
    '{artist}\'s impact on the K-pop ecosystem is perhaps best understood through the lens of influence. Newer acts cite them as inspiration, industry standards have shifted in response to their innovations, and the global conversation about K-pop is richer for their contributions. This kind of structural influence is rare and valuable.',
  ],
  noArtist: {
    background: [
      'The K-entertainment industry has undergone a transformation so rapid and comprehensive that even its most experienced participants sometimes struggle to keep pace. What was once a primarily domestic business has become a global cultural force, generating billions in revenue and captivating audiences on every continent.',
      'Contextualizing this story requires an understanding of the forces shaping the modern K-pop landscape: the platformization of music consumption, the rise of fan-driven marketing, and the increasing sophistication of international audiences who are no longer content to be passive consumers of Korean cultural exports.',
      'The current state of K-entertainment is best understood as the product of decades of deliberate cultural investment, technological innovation, and artistic ambition. The industry\'s infrastructure, from training systems to content distribution networks, is arguably the most sophisticated in global pop music.',
    ],
    detail: [
      'Drilling into the specifics reveals an industry in dynamic flux. Revenue models are being rewritten, distribution strategies are being overhauled, and the very definition of what constitutes a "K-pop act" is being expanded to accommodate new creative configurations that would have been unthinkable a decade ago.',
      'The data points are illuminating. K-pop content streams have increased significantly year-over-year, concert attendance figures have reached historic highs, and the industry\'s share of global music revenue continues to climb. These numbers reflect not just a trend, but a structural shift in how the world consumes music.',
      'Fan culture, that uniquely powerful engine of K-pop\'s global spread, continues to evolve in interesting ways. The organizational sophistication of modern fan communities, their ability to move markets and shape narratives, represents a phenomenon that media scholars are still working to fully understand.',
    ],
    reaction: [
      'Online reaction to this development has been robust, with commentary spanning the spectrum from casual observation to detailed analysis. K-pop\'s digitally native fanbase ensures that no significant story goes unexamined, creating a secondary discourse that often proves as interesting as the original news.',
      'The international response has been particularly notable. Fan communities across time zones have engaged with the story in real time, demonstrating the kind of global connectivity that makes K-pop unique among contemporary entertainment industries.',
    ],
    impact: [
      'The industry implications of this development extend well beyond the immediate headline. Executives, artists, and analysts are all recalibrating their assumptions in light of what has transpired, a process that will play out over the coming weeks and months.',
      'From a bird\'s-eye view, this story is another data point in the ongoing narrative of K-entertainment\'s global ascent. The industry\'s ability to generate worldwide headlines with domestic developments is itself a testament to the reach that Korean pop culture has achieved.',
    ],
  },
};

function extractArtistFromParagraphs(paragraphs) {
  if (!paragraphs || paragraphs.length === 0) return null;
  const sample = paragraphs.slice(0, 3).join(' ');
  return extractArtist(sample);
}

function shuffleAndPick(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

function rewriteArticleBody(articleContent, title) {
  const artist = extractArtist(title) || (articleContent ? extractArtistFromParagraphs(articleContent.paragraphs) : null);
  const topic = classifyTopic(title);

  const originalLength = articleContent?.paragraphs?.length || 0;
  const targetParagraphs = Math.max(8, Math.min(12, originalLength || 8));
  const inlineImages = (articleContent?.images || []).slice(1, 4);

  const paragraphs = [];
  const usedTexts = new Set();
  const pickUnique = (arr) => {
    const available = arr.filter(t => !usedTexts.has(t));
    if (available.length === 0) return arr[Math.floor(Math.random() * arr.length)];
    const picked = available[Math.floor(Math.random() * available.length)];
    usedTexts.add(picked);
    return picked;
  };
  const shuffleAndPickUnique = (arr, n) => {
    const available = arr.filter(t => !usedTexts.has(t));
    const shuffled = [...available].sort(() => Math.random() - 0.5);
    const picked = shuffled.slice(0, Math.min(n, shuffled.length));
    for (const p of picked) usedTexts.add(p);
    return picked;
  };

  if (artist) {
    const templates = BODY_TEMPLATES[topic] || BODY_TEMPLATES.general;
    const sub = (text) => text.replace(/\{artist\}/g, artist);

    paragraphs.push({ type: 'intro', text: sub(pickUnique(templates.opening)) });

    const bgCount = targetParagraphs >= 10 ? 2 : 1;
    for (const bg of shuffleAndPickUnique(SHARED_PARAGRAPHS.background, bgCount)) {
      paragraphs.push({ type: 'body', text: sub(bg) });
    }

    const analysisCount = targetParagraphs >= 10 ? 3 : 2;
    for (const a of shuffleAndPickUnique(templates.analysis, analysisCount)) {
      paragraphs.push({ type: 'body', text: sub(a) });
    }

    if (inlineImages.length > 0) {
      paragraphs.push({ type: 'image', src: inlineImages[0] });
    }

    const detailCount = targetParagraphs >= 10 ? 2 : 1;
    for (const d of shuffleAndPickUnique(SHARED_PARAGRAPHS.detail, detailCount)) {
      paragraphs.push({ type: 'body', text: sub(d) });
    }

    const reactionCount = targetParagraphs >= 10 ? 2 : 1;
    for (const r of shuffleAndPickUnique(SHARED_PARAGRAPHS.reaction, reactionCount)) {
      paragraphs.push({ type: 'body', text: sub(r) });
    }

    if (inlineImages.length > 1) {
      paragraphs.push({ type: 'image', src: inlineImages[1] });
    }

    paragraphs.push({ type: 'body', text: sub(pickUnique(SHARED_PARAGRAPHS.impact)) });
    paragraphs.push({ type: 'closing', text: sub(pickUnique(templates.closing)) });

  } else {
    paragraphs.push({ type: 'intro', text: pickUnique(NO_ARTIST_BODY.opening) });

    for (const bg of shuffleAndPickUnique(SHARED_PARAGRAPHS.noArtist.background, 2)) {
      paragraphs.push({ type: 'body', text: bg });
    }

    for (const a of shuffleAndPickUnique(NO_ARTIST_BODY.analysis, 2)) {
      paragraphs.push({ type: 'body', text: a });
    }

    if (inlineImages.length > 0) {
      paragraphs.push({ type: 'image', src: inlineImages[0] });
    }

    for (const d of shuffleAndPickUnique(SHARED_PARAGRAPHS.noArtist.detail, 2)) {
      paragraphs.push({ type: 'body', text: d });
    }

    for (const r of shuffleAndPickUnique(SHARED_PARAGRAPHS.noArtist.reaction, 1)) {
      paragraphs.push({ type: 'body', text: r });
    }

    if (inlineImages.length > 1) {
      paragraphs.push({ type: 'image', src: inlineImages[1] });
    }

    paragraphs.push({ type: 'body', text: pickUnique(SHARED_PARAGRAPHS.noArtist.impact) });
    paragraphs.push({ type: 'closing', text: pickUnique(NO_ARTIST_BODY.closing) });
  }

  return { paragraphs };
}

// ============================================================
// Backdate articles — spread from Jan 1 to Mar 22, 2026
// ============================================================

function backdateArticles(articles) {
  const startDate = new Date(2026, 0, 1); // Jan 1, 2026
  const endDate = new Date(2026, 2, 22);  // Mar 22, 2026
  const totalMs = endDate.getTime() - startDate.getTime();

  for (let i = 0; i < articles.length; i++) {
    const ratio = articles.length > 1 ? i / (articles.length - 1) : 0;
    const articleDate = new Date(endDate.getTime() - (ratio * totalMs));
    articles[i].pubDate = articleDate;
    articles[i].formattedDate = formatDate(articleDate.toISOString());
  }

  log(`  Backdated ${articles.length} articles from Jan 1 to Mar 22, 2026`);
}

// ============================================================
// HTML escaping
// ============================================================

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// Build image tag helper
// ============================================================

function imgTag(article, width, height, loading = 'lazy') {
  const src = escapeHtml(article.image || PLACEHOLDER_IMAGE);
  const fallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/${width}/${height}`;
  return `<img src="${src}" alt="${escapeHtml(article.title)}" width="${width}" height="${height}" loading="${loading}" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;
}

function imgTagForArticle(article, width, height, loading = 'lazy') {
  let src = article.image || PLACEHOLDER_IMAGE;
  if (src.startsWith('images/')) src = '../' + src;
  const escapedSrc = escapeHtml(src);
  const fallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/${width}/${height}`;
  return `<img src="${escapedSrc}" alt="${escapeHtml(article.title)}" width="${width}" height="${height}" loading="${loading}" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;
}

// ============================================================
// Section generators — SCENE layout
// ============================================================

function generateHeroMain(article) {
  if (!article) return '';
  const cat = displayCategory(article);
  return `<a href="${escapeHtml(article.localUrl)}" class="hero-main">
          ${imgTag(article, 760, 520, 'eager')}
          <div class="hero-main-overlay">
            <span class="badge-breaking">${escapeHtml(cat)}</span>
            <h2>${escapeHtml(article.title)}</h2>
            <div class="meta">${escapeHtml(article.formattedDate)} &middot; <span class="source">${escapeHtml(article.source)}</span></div>
          </div>
        </a>`;
}

function generateHeroSideItem(article) {
  if (!article) return '';
  return `<a href="${escapeHtml(article.localUrl)}" class="hero-side-item">
            ${imgTag(article, 120, 90, 'eager')}
            <div class="text">
              <h3>${escapeHtml(article.title)}</h3>
              <div class="meta">${escapeHtml(article.formattedDate)} &middot; ${escapeHtml(article.source)}</div>
            </div>
          </a>`;
}

function generateTopStoryCard(article) {
  if (!article) return '';
  const cat = displayCategory(article);
  return `<a href="${escapeHtml(article.localUrl)}" class="top-card">
          <div class="thumb">
            ${imgTag(article, 400, 220)}
            <span class="cat">${escapeHtml(cat)}</span>
          </div>
          <div class="body">
            <h3>${escapeHtml(article.title)}</h3>
            <div class="meta">${escapeHtml(article.formattedDate)} &middot; <span class="source">${escapeHtml(article.source)}</span></div>
          </div>
        </a>`;
}

const DRAMA_FALLBACK_EXCERPTS = [
  'An in-depth look at the latest developments in K-drama and entertainment culture.',
  'The stories and performances capturing audiences across the K-entertainment world.',
  'From script to screen: exploring the creative forces behind this week\'s biggest K-culture moments.',
  'Coverage of the dramas, films, and performances making headlines in Korean entertainment.',
];
let dramaExcerptIdx = 0;

function generateDramaCard(article) {
  if (!article) return '';
  const cat = displayCategory(article);
  let rawExcerpt = article.articleContent?.paragraphs?.[0]?.slice(0, 120);
  // Filter out leaked non-K-culture excerpts
  if (rawExcerpt && BLOCKED_KEYWORDS.some(kw => rawExcerpt.toLowerCase().includes(kw))) {
    rawExcerpt = null;
  }
  const excerpt = rawExcerpt || (() => {
    const text = DRAMA_FALLBACK_EXCERPTS[dramaExcerptIdx % DRAMA_FALLBACK_EXCERPTS.length];
    dramaExcerptIdx++;
    return text;
  })();
  return `<a href="${escapeHtml(article.localUrl)}" class="drama-card">
          ${imgTag(article, 200, 140)}
          <div class="body">
            <div class="cat">${escapeHtml(cat)}</div>
            <h3>${escapeHtml(article.title)}</h3>
            <div class="excerpt">${escapeHtml(excerpt)}</div>
            <div class="meta">${escapeHtml(article.formattedDate)} &middot; ${escapeHtml(article.source)}</div>
          </div>
        </a>`;
}

const INDUSTRY_FALLBACK_EXCERPTS = [
  'A closer look at the business moves and market forces shaping the K-entertainment industry this week.',
  'Examining how shifting industry dynamics are creating new opportunities and challenges across K-culture.',
  'Key developments from behind the scenes in the K-entertainment world, analyzed by SCENE.',
  'Breaking down the strategic decisions and partnerships driving change in the global K-pop market.',
  'The latest power plays, deal-making, and market shifts in the world of Korean entertainment.',
  'An executive-level overview of the trends reshaping how K-culture reaches global audiences.',
];
let industryExcerptIdx = 0;

function generateIndustryItem(article) {
  if (!article) return '';
  const cat = displayCategory(article);
  let excerpt = article.articleContent?.paragraphs?.[0]?.slice(0, 100);
  // Filter out leaked non-K-culture excerpts
  if (excerpt && BLOCKED_KEYWORDS.some(kw => excerpt.toLowerCase().includes(kw))) {
    excerpt = null;
  }
  if (!excerpt) {
    excerpt = INDUSTRY_FALLBACK_EXCERPTS[industryExcerptIdx % INDUSTRY_FALLBACK_EXCERPTS.length];
    industryExcerptIdx++;
  }
  return `<a href="${escapeHtml(article.localUrl)}" class="industry-item">
          <div class="cat">${escapeHtml(cat)}</div>
          <h3>${escapeHtml(article.title)}</h3>
          <div class="excerpt">${escapeHtml(excerpt)}</div>
          <div class="meta">${escapeHtml(article.formattedDate)} &middot; ${escapeHtml(article.source)}</div>
        </a>`;
}

function generateMoreItem(article) {
  if (!article) return '';
  return `<a href="${escapeHtml(article.localUrl)}" class="more-item">
          ${imgTag(article, 80, 60)}
          <div class="text">
            <h3>${escapeHtml(article.title)}</h3>
            <div class="meta">${escapeHtml(article.formattedDate)} &middot; <span class="source">${escapeHtml(article.source)}</span></div>
          </div>
        </a>`;
}

// ============================================================
// Generate article HTML pages
// ============================================================

async function generateArticlePages(allArticles, usedArticles) {
  await mkdir(ARTICLES_DIR, { recursive: true });

  const templatePath = join(__dirname, 'article-template.html');
  const articleTemplate = await readFile(templatePath, 'utf-8');

  log(`Generating ${usedArticles.length} article pages...`);

  for (let i = 0; i < usedArticles.length; i++) {
    const filename = `article-${String(i + 1).padStart(3, '0')}.html`;
    usedArticles[i].localUrl = `articles/${filename}`;
  }

  let generated = 0;

  for (let i = 0; i < usedArticles.length; i++) {
    const article = usedArticles[i];
    const filename = `article-${String(i + 1).padStart(3, '0')}.html`;

    const related = allArticles
      .filter(a => a !== article && a.image && a.localUrl)
      .slice(0, 20)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);

    const bodyData = rewriteArticleBody(article.articleContent, article.title);

    let bodyHtml = '';
    for (const item of bodyData.paragraphs) {
      if (item.type === 'intro') {
        bodyHtml += `<div class="editorial-intro">${escapeHtml(item.text)}</div>\n`;
      } else if (item.type === 'closing') {
        bodyHtml += `        <div class="editorial-closing">${escapeHtml(item.text)}</div>`;
      } else if (item.type === 'image') {
        const imgSrc = item.src;
        const fallback = `https://picsum.photos/seed/inline-${Math.random().toString(36).slice(2,8)}/760/428`;
        bodyHtml += `        <figure class="article-inline-image">
          <img src="${escapeHtml(imgSrc)}" alt="" width="760" height="428" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
        </figure>\n`;
      } else {
        bodyHtml += `        <p>${escapeHtml(item.text)}</p>\n`;
      }
    }

    let heroImgSrc = article.image || PLACEHOLDER_IMAGE;
    if (heroImgSrc.startsWith('images/')) heroImgSrc = '../' + heroImgSrc;
    const heroFallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/800/450`;
    const heroImg = `<img src="${escapeHtml(heroImgSrc)}" alt="${escapeHtml(article.title)}" width="760" height="428" loading="eager" referrerpolicy="no-referrer" data-fallback="${escapeHtml(heroFallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;

    let relatedHtml = '';
    for (const rel of related) {
      const relUrl = `../${rel.localUrl}`;
      let relImgSrc = rel.image || PLACEHOLDER_IMAGE;
      if (relImgSrc.startsWith('images/')) relImgSrc = '../' + relImgSrc;
      const relFallback = `https://picsum.photos/seed/${encodeURIComponent(rel.title.slice(0, 20))}/400/225`;
      const relCat = displayCategory(rel);
      relatedHtml += `
          <a href="${escapeHtml(relUrl)}" class="related-card">
            <div class="thumb">
              <img src="${escapeHtml(relImgSrc)}" alt="${escapeHtml(rel.title)}" width="400" height="225" loading="lazy" referrerpolicy="no-referrer" data-fallback="${escapeHtml(relFallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
            </div>
            <div class="related-category">${escapeHtml(relCat)}</div>
            <h3>${escapeHtml(rel.title)}</h3>
            <span class="date">${escapeHtml(rel.formattedDate)}</span>
          </a>`;
    }

    const sourceAttribution = `<div class="source-attribution">
          Source: <a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.source)}</a>
          <br><a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer" class="read-original">Read original article &rarr;</a>
        </div>`;

    const photoCredit = `Photo: &copy;${escapeHtml(article.source)}`;

    let html = articleTemplate
      .replace(/\{\{ARTICLE_TITLE\}\}/g, escapeHtml(article.title))
      .replace(/\{\{ARTICLE_DESCRIPTION\}\}/g, escapeHtml(article.title).slice(0, 160))
      .replace('{{ARTICLE_IMAGE}}', escapeHtml(heroImgSrc))
      .replace('{{ARTICLE_CATEGORY}}', escapeHtml(displayCategory(article)))
      .replace('{{ARTICLE_DATE}}', escapeHtml(article.formattedDate))
      .replace('{{ARTICLE_HERO_IMAGE}}', heroImg)
      .replace('{{ARTICLE_BODY}}', bodyHtml)
      .replace('{{SOURCE_ATTRIBUTION}}', sourceAttribution)
      .replace('{{PHOTO_CREDIT}}', photoCredit)
      .replace('{{RELATED_ARTICLES}}', relatedHtml);

    const outputPath = join(ARTICLES_DIR, filename);
    await writeFile(outputPath, html, 'utf-8');
    generated++;
  }

  log(`  Generated ${generated} article pages`);
}

// ============================================================
// Assign articles to sections
// ============================================================

const HERO_OFFSET = 1;

function assignSections(articles) {
  let placeholderIdx = 0;
  for (const article of articles) {
    if (!article.image) {
      placeholderIdx++;
      article.image = `https://picsum.photos/seed/scene-${placeholderIdx}-${Date.now() % 10000}/800/450`;
      article.hasPlaceholder = true;
    }
  }

  const withRealImages = articles.filter(a => !a.hasPlaceholder);
  const used = new Set();

  const take = (pool, count) => {
    const result = [];
    for (const article of pool) {
      if (result.length >= count) break;
      if (!used.has(article.link)) {
        result.push(article);
        used.add(article.link);
      }
    }
    return result;
  };

  const heroCandidates = withRealImages.length >= 4 ? withRealImages : articles;
  const heroSkipped = heroCandidates.slice(HERO_OFFSET);
  const heroMain = take(heroSkipped.length ? heroSkipped : heroCandidates, 1);
  const heroSide = take(heroCandidates, 3);
  const top = take(articles, 3);
  const drama = take(articles, 4);
  const industry = take(articles, 4);
  const more = take(articles, 6);

  return {
    heroMain: heroMain[0] || null,
    heroSide,
    top,
    drama,
    industry,
    more,
  };
}

// ============================================================
// Generate index HTML
// ============================================================

async function generateHtml(sections) {
  const templatePath = join(__dirname, 'template.html');
  let template = await readFile(templatePath, 'utf-8');

  template = template.replace(
    '{{HERO_MAIN}}',
    sections.heroMain ? generateHeroMain(sections.heroMain) : ''
  );

  template = template.replace(
    '{{HERO_SIDE_ITEMS}}',
    sections.heroSide.map(a => generateHeroSideItem(a)).join('\n          ')
  );

  template = template.replace(
    '{{TOP_STORIES}}',
    sections.top.map(a => generateTopStoryCard(a)).join('\n        ')
  );

  template = template.replace(
    '{{DRAMA_REVIEWS}}',
    sections.drama.map(a => generateDramaCard(a)).join('\n        ')
  );

  template = template.replace(
    '{{INDUSTRY_NEWS}}',
    sections.industry.map(a => generateIndustryItem(a)).join('\n        ')
  );

  template = template.replace(
    '{{MORE_STORIES}}',
    sections.more.map(a => generateMoreItem(a)).join('\n        ')
  );

  return template;
}

// ============================================================
// Main
// ============================================================

async function main() {
  log('Starting SCENE Magazine RSS Crawler...');
  log('');

  // 1. Fetch all RSS feeds
  const articles = await fetchAllFeeds();
  if (articles.length === 0) {
    warn('No articles fetched. Aborting.');
    process.exit(1);
  }
  log('');

  // 2. Fill missing images via og:image
  await fillMissingImages(articles);
  log('');

  // 3. Rewrite titles to Variety/Deadline English style (with deduplication)
  log('Rewriting titles to Variety/Deadline editorial English...');
  let rewritten = 0;
  const usedTitles = new Set();
  let dedupCounter = 0;
  for (const article of articles) {
    const original = article.title;
    article.originalTitle = original;
    // Try up to 15 times to get a unique title
    let newTitle = rewriteTitle(original);
    let attempts = 0;
    while (usedTitles.has(newTitle) && attempts < 15) {
      newTitle = rewriteTitle(original);
      attempts++;
    }
    // If still duplicate after 15 tries, append a unique counter suffix
    if (usedTitles.has(newTitle)) {
      dedupCounter++;
      newTitle = `${newTitle} — ${article.source} Edition #${dedupCounter}`;
    }
    usedTitles.add(newTitle);
    article.title = newTitle;
    if (article.title !== original) rewritten++;
  }
  log(`  Rewritten ${rewritten}/${articles.length} titles (all unique)`);
  log('');

  // 4. Backdate articles from Jan 1 to Mar 22, 2026
  backdateArticles(articles);
  log('');

  // 5. Assign articles to sections
  const sections = assignSections(articles);

  // Collect used articles
  const usedArticles = [];
  const usedSet = new Set();
  const addUsed = (arr) => {
    for (const a of arr) {
      if (a && !usedSet.has(a.link)) {
        usedArticles.push(a);
        usedSet.add(a.link);
      }
    }
  };
  if (sections.heroMain) addUsed([sections.heroMain]);
  addUsed(sections.heroSide);
  addUsed(sections.top);
  addUsed(sections.drama);
  addUsed(sections.industry);
  addUsed(sections.more);

  // 6. Download images locally
  const withImages = articles.filter(a => a.image).length;
  log(`Articles with images: ${withImages}/${articles.length}`);
  await downloadArticleImages(usedArticles);
  log('');

  // 7. Fetch full article content
  await fetchAllArticleContent(usedArticles);
  log('');

  // 8. Generate individual article pages
  await generateArticlePages(articles, usedArticles);
  log('');

  // 9. Generate index HTML
  const html = await generateHtml(sections);

  // 10. Write index output
  const outputPath = join(__dirname, 'index.html');
  await writeFile(outputPath, html, 'utf-8');

  const totalUsed =
    (sections.heroMain ? 1 : 0) +
    sections.heroSide.length +
    sections.top.length +
    sections.drama.length +
    sections.industry.length +
    sections.more.length;

  log(`Generated index.html with ${totalUsed} articles`);
  log(`Generated ${usedArticles.length} article pages in articles/`);
  log(`Done! Open: file://${outputPath}`);
}

main().catch((err) => {
  console.error('[SCENE Crawler] Fatal error:', err);
  process.exit(1);
});
