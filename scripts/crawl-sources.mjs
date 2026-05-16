import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const CRAWL_TIMEOUT_MS = Number(process.env.CRAWL_TIMEOUT_MS) || 20000;
const REACHABILITY_TIMEOUT_MS = Number(process.env.REACHABILITY_TIMEOUT_MS) || Math.min(7000, CRAWL_TIMEOUT_MS);
const USER_AGENT = 'Just-DDL-Crawler/1.0 (+https://just-agent.github.io/just-ddl/)';

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim().slice(0, 200) : null;
}

function fetchViaPowerShell(url) {
  if (process.platform !== 'win32') return null;
  const timeoutSec = Math.max(15, Math.ceil(CRAWL_TIMEOUT_MS / 1000) + 5);
  const escapedUrl = url.replace(/'/g, "''");
  const script = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); (Invoke-WebRequest -Uri '" + escapedUrl + "' -UseBasicParsing -TimeoutSec " + timeoutSec + " -Headers @{ 'User-Agent'='Mozilla/5.0'; 'Accept-Language'='en-US,en;q=0.9' }).Content";
  for (const command of ['pwsh', 'powershell']) {
    const result = spawnSync(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: (timeoutSec + 5) * 1000
    });
    if (result.status === 0 && result.stdout && result.stdout.trim().length > 1000) {
      return result.stdout;
    }
  }
  return null;
}

async function fetchSourcePage(source) {
  const report = {
    sourceId: source.id,
    source: source.name,
    url: source.url,
    items: [],
    reachable: false,
    httpStatus: null,
    finalUrl: null,
    title: null,
    contentLength: null,
    fetchedAt: new Date().toISOString(),
    note: 'Source reachability check only; curated data/items.json preserved until item parser is implemented.',
    error: null
  };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS);
    const res = await fetch(source.url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT }
    });
    clearTimeout(timer);
    report.httpStatus = res.status;
    report.finalUrl = res.url;
    const text = await res.text();
    report.contentLength = text.length;
    report.title = extractTitle(text);
    report.reachable = res.status >= 200 && res.status < 400;
    report.note = report.reachable
      ? 'Source reachable. Curated data/items.json preserved until item parser is implemented.'
      : `Source returned HTTP ${res.status}. Curated data/items.json preserved.`;
  } catch (err) {
    report.error = err.name === 'AbortError' ? `Timeout after ${REACHABILITY_TIMEOUT_MS}ms` : err.message;
    report.note = `Source fetch failed: ${report.error}. Curated data/items.json preserved.`;
  }
  return report;
}

const DRIVENDATA_URL = 'https://www.drivendata.org/competitions/';
const DRIVENDATA_MIN_ITEMS = 3;
const DRIVENDATA_MAX_FUTURE_DAYS = Number(process.env.DRIVENDATA_MAX_FUTURE_DAYS) || 700;

function decodeDrivenDataHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripDrivenDataHtml(value) {
  return decodeDrivenDataHtml(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDrivenDataDate(value) {
  const normalized = decodeDrivenDataHtml(value)
    .replace(/\b([A-Z][a-z]{2})\./g, '$1')
    .replace(/a\.m\./i, 'AM')
    .replace(/p\.m\./i, 'PM')
    .replace(/\s+/g, ' ')
    .trim();
  return new Date(normalized);
}

function drivenDataSlugFromHref(href, fallbackTitle) {
  const path = href.replace(/^https?:\/\/www\.drivendata\.org/i, '');
  const slug = path
    .replace(/^\/(competitions|benchmarks)\//, '')
    .replace(/\/$/, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  if (slug) return slug;
  return fallbackTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function parseDrivenDataItems() {
  const report = {
    sourceId: 'drivendata',
    source: 'DrivenData Competitions',
    url: DRIVENDATA_URL,
    items: [],
    reachable: false,
    httpStatus: null,
    finalUrl: null,
    title: null,
    contentLength: null,
    fetchedAt: new Date().toISOString(),
    note: 'DrivenData competitions parser.',
    error: null,
    parsedItemCount: 0,
    invalidItemCount: 0,
    parserHealthy: false
  };
  try {
    let text;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CRAWL_TIMEOUT_MS);
      const res = await fetch(DRIVENDATA_URL, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }
      });
      clearTimeout(timer);
      report.httpStatus = res.status;
      report.finalUrl = res.url;
      text = await res.text();
      report.reachable = res.status >= 200 && res.status < 400;
    } catch (fetchErr) {
      const fallbackText = fetchViaPowerShell(DRIVENDATA_URL);
      if (!fallbackText) throw fetchErr;
      text = fallbackText;
      report.httpStatus = 200;
      report.finalUrl = DRIVENDATA_URL;
      report.reachable = true;
      report.note = 'Fetched DrivenData with Windows PowerShell fallback after Node fetch failed.';
    }
    report.contentLength = text.length;
    report.title = (text.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || null;

    if (!report.reachable) {
      report.note = 'DrivenData returned HTTP ' + report.httpStatus + '. No items parsed.';
      return report;
    }

    // DrivenData is SSR. Cards expose exact UTC end dates in .end-date title attributes.
    const cardStarts = [...text.matchAll(/<div\s+class="[^"]*\bpanel-container\b[^"]*"[^>]*>/gi)].map(match => match.index);
    const seen = new Set();
    for (let i = 0; i < cardStarts.length; i += 1) {
      const block = text.slice(cardStarts[i], cardStarts[i + 1] ?? text.length);
      const href = (block.match(/<a\s+[^>]*href=['"]([^'"]+)['"][^>]*class="image/i) || block.match(/<h3[^>]*>[\s\S]*?<a\s+[^>]*href=['"]([^'"]+)['"]/i) || [])[1];
      const rawTitle = (block.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/i) || [])[1];
      const dateTitle = (block.match(/class="end-date"[^>]*title="([^"]+)"/i) || [])[1];
      const title = stripDrivenDataHtml(rawTitle);

      if (!href || !title || !dateTitle) {
        report.invalidItemCount += 1;
        continue;
      }
      const deadlineDate = parseDrivenDataDate(dateTitle);
      if (!deadlineDate || isNaN(deadlineDate.getTime())) {
        report.invalidItemCount += 1;
        continue;
      }
      const daysFromNow = (deadlineDate.getTime() - Date.now()) / 86400000;
      if (daysFromNow < -7 || daysFromNow > DRIVENDATA_MAX_FUTURE_DAYS) {
        report.invalidItemCount += 1;
        continue;
      }

      const isoDeadline = deadlineDate.toISOString().replace('.000Z', 'Z');
      const slug = drivenDataSlugFromHref(href, title);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      const isBenchmark = href.includes('/benchmarks/');
      const categoryTags = [...block.matchAll(/data-category_([a-z0-9-]+)="1"/gi)].map(match => match[1]);
      const tags = ['data science', isBenchmark ? 'benchmark' : 'competition', 'DrivenData', ...categoryTags].slice(0, 6);
      report.items.push({
        id: 'drivendata-' + slug,
        title: title,
        deadline: isoDeadline,
        dateRange: stripDrivenDataHtml(dateTitle),
        location: 'Online',
        isOnline: true,
        tags,
        url: new URL(href, DRIVENDATA_URL).href,
        status: 'upcoming',
        description: 'Parsed from official DrivenData listing. Deadline is read from the card end-date tooltip.',
        stage: 'Deadline',
        source: 'DrivenData Competitions',
        type: 'challenge'
      });
    }

    report.items.sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
    report.parsedItemCount = report.items.length;
    report.parserHealthy = report.parsedItemCount >= DRIVENDATA_MIN_ITEMS;
    report.note = 'Parsed ' + report.parsedItemCount + ' items from DrivenData; rejected ' + report.invalidItemCount + ' entries.';
  } catch (err) {
    report.error = err.name === 'AbortError' ? 'Timeout after ' + CRAWL_TIMEOUT_MS + 'ms' : err.message;
    report.note = 'DrivenData fetch failed: ' + report.error;
  }
  return report;
}

async function drivenDataAdapter() {
  return parseDrivenDataItems();
}

const ZINDI_URL = 'https://zindi.africa/competitions';
const ZINDI_MIN_ITEMS = 1;
const ZINDI_MAX_FUTURE_DAYS = Number(process.env.ZINDI_MAX_FUTURE_DAYS) || 500;

async function parseZindiItems() {
  const report = {
    sourceId: 'zindi',
    source: 'Zindi Africa',
    url: ZINDI_URL,
    items: [],
    reachable: false,
    httpStatus: null,
    finalUrl: null,
    title: null,
    contentLength: null,
    fetchedAt: new Date().toISOString(),
    note: 'Zindi competitions parser (__NEXT_DATA__ JSON extraction).',
    error: null,
    parsedItemCount: 0,
    invalidItemCount: 0,
    parserHealthy: false
  };
  try {
    let text;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CRAWL_TIMEOUT_MS);
      const res = await fetch(ZINDI_URL, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }
      });
      clearTimeout(timer);
      report.httpStatus = res.status;
      report.finalUrl = res.url;
      text = await res.text();
      report.reachable = res.status >= 200 && res.status < 400;
    } catch (fetchErr) {
      const fallbackText = fetchViaPowerShell(ZINDI_URL);
      if (!fallbackText) throw fetchErr;
      text = fallbackText;
      report.httpStatus = 200;
      report.finalUrl = ZINDI_URL;
      report.reachable = true;
      report.note = 'Fetched Zindi with Windows PowerShell fallback after Node fetch failed.';
    }
    report.contentLength = text.length;
    report.title = (text.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || null;

    if (!report.reachable) {
      report.note = 'Zindi returned HTTP ' + report.httpStatus + '. No items parsed.';
      return report;
    }

    // Zindi is Next.js SSR. Extract __NEXT_DATA__ JSON for structured competition data.
    const nextDataMatch = text.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (nextDataMatch) {
      try {
        const nextData = JSON.parse(nextDataMatch[1]);
        const pageProps = nextData?.props?.pageProps;
        // Try common key names for the competitions array
        const competitions = pageProps?.competitions || pageProps?.challenges || pageProps?.data || [];
        if (Array.isArray(competitions)) {
          for (const comp of competitions) {
            const title = comp.title || comp.name || comp.challenge_title;
            const deadlineStr = comp.deadline || comp.end_date || comp.end_date_iso || comp.endDate;
            const slug = comp.slug || comp.id || '';
            if (!title || !deadlineStr) {
              report.invalidItemCount += 1;
              continue;
            }
            const deadlineDate = new Date(deadlineStr);
            if (isNaN(deadlineDate.getTime())) {
              report.invalidItemCount += 1;
              continue;
            }
            const daysFromNow = (deadlineDate.getTime() - Date.now()) / 86400000;
            if (daysFromNow < -7 || daysFromNow > ZINDI_MAX_FUTURE_DAYS) {
              report.invalidItemCount += 1;
              continue;
            }
            const isoDeadline = deadlineDate.toISOString();
            const compUrl = comp.url || ('https://zindi.africa/competitions/' + slug);
            const category = comp.category || comp.type || '';
            const tags = ['data science', 'competition', 'Zindi'];
            if (category) tags.push(category);
            report.items.push({
              id: 'zindi-' + (slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')),
              title: title,
              deadline: isoDeadline,
              tags,
              url: compUrl,
              status: comp.status === 'Active' ? 'upcoming' : (comp.status || 'upcoming'),
              description: 'Parsed from Zindi Africa competitions (__NEXT_DATA__).',
              stage: 'Deadline',
              source: 'Zindi Africa',
              type: 'challenge'
            });
          }
        }
      } catch (jsonErr) {
        report.note = 'Zindi __NEXT_DATA__ JSON parse error: ' + jsonErr.message + '. Falling back to HTML parsing.';
      }
    }

    // Fallback: parse HTML links if __NEXT_DATA__ did not yield items
    if (report.items.length === 0) {
      const linkRe = /<a\s+[^>]*href="(\/competitions\/[^"\/]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      const seen = new Set();
      let m;
      while ((m = linkRe.exec(text)) !== null) {
        const href = m[1];
        const slug = href.replace(/^\/competitions\//, '');
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        const title = m[2].replace(/<[^>]+>/g, '').trim();
        if (!title || title.length < 3) continue;
        // Look for date in surrounding context
        const windowStart = m.index;
        const windowEnd = Math.min(text.length, m.index + 3000);
        const block = text.substring(windowStart, windowEnd);
        const dateMatch = block.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+(\d{1,2}),?\s+(\d{4})/i)
          || block.match(/(\d{4})-(\d{2})-(\d{2})/);
        if (!dateMatch) { report.invalidItemCount += 1; continue; }
        let deadlineDate;
        if (dateMatch[0].match(/[A-Za-z]/)) {
          const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
          const mon = MONTHS[dateMatch[0].match(/[A-Za-z]+/)[0].slice(0,3).toLowerCase()];
          deadlineDate = new Date(Number(dateMatch[2]), mon, Number(dateMatch[1]), 23, 59, 59);
        } else {
          deadlineDate = new Date(dateMatch[1] + '-' + dateMatch[2] + '-' + dateMatch[3] + 'T23:59:59Z');
        }
        if (isNaN(deadlineDate.getTime())) { report.invalidItemCount += 1; continue; }
        const daysFromNow = (deadlineDate.getTime() - Date.now()) / 86400000;
        if (daysFromNow < -7 || daysFromNow > ZINDI_MAX_FUTURE_DAYS) { report.invalidItemCount += 1; continue; }
        report.items.push({
          id: 'zindi-' + slug,
          title: title,
          deadline: deadlineDate.toISOString(),
          tags: ['data science', 'competition', 'Zindi'],
          url: 'https://zindi.africa' + href,
          status: 'upcoming',
          description: 'Parsed from Zindi Africa competitions (HTML fallback).',
          stage: 'Deadline',
          source: 'Zindi Africa',
          type: 'challenge'
        });
      }
    }

    report.parsedItemCount = report.items.length;
    report.parserHealthy = true;
    report.note = report.parsedItemCount >= ZINDI_MIN_ITEMS
      ? 'Parsed ' + report.parsedItemCount + ' items from Zindi; rejected ' + report.invalidItemCount + ' entries.'
      : 'Zindi reachable, but no trustworthy future deadlines were exposed in HTML; not blocking other parsers.';
  } catch (err) {
    report.error = err.name === 'AbortError' ? 'Timeout after ' + CRAWL_TIMEOUT_MS + 'ms' : err.message;
    report.note = 'Zindi fetch failed: ' + report.error;
  }
  return report;
}

async function zindiAdapter() {
  return parseZindiItems();
}

const CODALAB_URL = 'https://codalab.lisn.upsaclay.fr/competitions/';
const CODALAB_API_URL = 'https://codalab.lisn.upsaclay.fr/api/competition/';
const CODALAB_MIN_ITEMS = 1;
const CODALAB_MAX_FUTURE_DAYS = Number(process.env.CODALAB_MAX_FUTURE_DAYS) || 500;

async function parseCodalabItems() {
  const report = {
    sourceId: 'codalab',
    source: 'Codalab Competitions',
    url: CODALAB_URL,
    items: [],
    reachable: false,
    httpStatus: null,
    finalUrl: null,
    title: null,
    contentLength: null,
    fetchedAt: new Date().toISOString(),
    note: 'Codalab competitions parser (REST API + HTML fallback).',
    error: null,
    parsedItemCount: 0,
    invalidItemCount: 0,
    parserHealthy: false
  };
  try {
    // Try REST API first
    let apiItems = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CRAWL_TIMEOUT_MS);
      const res = await fetch(CODALAB_API_URL, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
      });
      clearTimeout(timer);
      if (res.status >= 200 && res.status < 400) {
        const json = await res.json();
        const comps = Array.isArray(json) ? json : (json.results || json.competitions || []);
        if (Array.isArray(comps) && comps.length > 0) {
          apiItems = comps;
          report.reachable = true;
          report.httpStatus = res.status;
          report.note = 'Parsed from Codalab REST API.';
        }
      }
    } catch {}

    // Fallback to HTML parsing if API did not work
    if (!apiItems) {
      let text;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CRAWL_TIMEOUT_MS);
        const res = await fetch(CODALAB_URL, {
          redirect: 'follow',
          signal: controller.signal,
          headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' }
        });
        clearTimeout(timer);
        report.httpStatus = res.status;
        report.finalUrl = res.url;
        text = await res.text();
        report.reachable = res.status >= 200 && res.status < 400;
      } catch (fetchErr) {
        const fallbackText = fetchViaPowerShell(CODALAB_URL);
        if (!fallbackText) throw fetchErr;
        text = fallbackText;
        report.httpStatus = 200;
        report.finalUrl = CODALAB_URL;
        report.reachable = true;
        report.note = 'Fetched Codalab with Windows PowerShell fallback.';
      }
      report.contentLength = text.length;
      report.title = (text.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || null;

      if (!report.reachable) {
        report.note = 'Codalab returned HTTP ' + report.httpStatus + '. No items parsed.';
        return report;
      }

      // Parse HTML: competition links like /competitions/{id}/ or /competition/{id}/
      const linkRe = /<a\s+[^>]*href="(\/competitions?\/)(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
      const seen = new Set();
      let m;
      while ((m = linkRe.exec(text)) !== null) {
        const compId = m[2];
        if (seen.has(compId)) continue;
        seen.add(compId);
        const title = m[3].replace(/<[^>]+>/g, '').trim();
        if (!title || title.length < 3) continue;
        // Look for date in surrounding context
        const windowStart = m.index;
        const windowEnd = Math.min(text.length, m.index + 3000);
        const block = text.substring(windowStart, windowEnd);
        const dateMatch = block.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+(\d{1,2}),?\s+(\d{4})/i)
          || block.match(/(\d{4})-(\d{2})-(\d{2})/);
        if (!dateMatch) { report.invalidItemCount += 1; continue; }
        let deadlineDate;
        if (dateMatch[0].match(/[A-Za-z]/)) {
          const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
          const mon = MONTHS[dateMatch[0].match(/[A-Za-z]+/)[0].slice(0,3).toLowerCase()];
          deadlineDate = new Date(Number(dateMatch[2]), mon, Number(dateMatch[1]), 23, 59, 59);
        } else {
          deadlineDate = new Date(dateMatch[1] + '-' + dateMatch[2] + '-' + dateMatch[3] + 'T23:59:59Z');
        }
        if (isNaN(deadlineDate.getTime())) { report.invalidItemCount += 1; continue; }
        const daysFromNow = (deadlineDate.getTime() - Date.now()) / 86400000;
        if (daysFromNow < -7 || daysFromNow > CODALAB_MAX_FUTURE_DAYS) { report.invalidItemCount += 1; continue; }
        report.items.push({
          id: 'codalab-' + compId,
          title: title,
          deadline: deadlineDate.toISOString(),
          tags: ['data science', 'competition', 'Codalab'],
          url: 'https://codalab.lisn.upsaclay.fr/competitions/' + compId + '/',
          status: 'upcoming',
          description: 'Parsed from Codalab competitions listing (HTML).',
          stage: 'Deadline',
          source: 'Codalab Competitions',
          type: 'challenge'
        });
      }
      report.parsedItemCount = report.items.length;
      report.parserHealthy = true;
      report.note = report.parsedItemCount > 0
        ? 'Parsed ' + report.parsedItemCount + ' items from Codalab HTML; rejected ' + report.invalidItemCount + ' entries.'
        : 'Codalab reachable, but no trustworthy future deadlines were exposed in HTML; not blocking other parsers.';
      return report;
    }

    // Process API items
    for (const comp of apiItems) {
      const title = comp.title || comp.name;
      const deadlineStr = comp.end_date || comp.deadline || comp.end_date_iso;
      if (!title || !deadlineStr) { report.invalidItemCount += 1; continue; }
      const deadlineDate = new Date(deadlineStr);
      if (isNaN(deadlineDate.getTime())) { report.invalidItemCount += 1; continue; }
      const daysFromNow = (deadlineDate.getTime() - Date.now()) / 86400000;
      if (daysFromNow < -7 || daysFromNow > CODALAB_MAX_FUTURE_DAYS) { report.invalidItemCount += 1; continue; }
      const compId = comp.id || comp.pk || title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      report.items.push({
        id: 'codalab-' + compId,
        title: title,
        deadline: deadlineDate.toISOString(),
        tags: ['data science', 'competition', 'Codalab'],
        url: comp.url || (CODALAB_URL + compId + '/'),
        status: comp.is_active ? 'upcoming' : 'upcoming',
        description: 'Parsed from Codalab REST API.',
        stage: 'Deadline',
        source: 'Codalab Competitions',
        type: 'challenge'
      });
    }

    report.parsedItemCount = report.items.length;
    report.parserHealthy = true;
    report.note = report.parsedItemCount > 0
      ? 'Parsed ' + report.parsedItemCount + ' items from Codalab API; rejected ' + report.invalidItemCount + ' entries.'
      : 'Codalab API reachable, but no trustworthy future deadlines were exposed; not blocking other parsers.';
  } catch (err) {
    report.error = err.name === 'AbortError' ? 'Timeout after ' + CRAWL_TIMEOUT_MS + 'ms' : err.message;
    report.note = 'Codalab fetch failed: ' + report.error;
  }
  return report;
}

async function codalabAdapter() {
  return parseCodalabItems();
}
async function kaggleAdapter() {
  return fetchSourcePage({ id: "kaggle", name: "Kaggle Competitions", url: "https://www.kaggle.com/competitions" });
}

async function tianchiAdapter() {
  return fetchSourcePage({ id: "tianchi", name: "Alibaba Tianchi", url: "https://tianchi.aliyun.com/competition/gameList/activeList" });
}

const adapters = [kaggleAdapter, tianchiAdapter, drivenDataAdapter, zindiAdapter, codalabAdapter];
const existingItemsUrl = new URL('../data/items.json', import.meta.url);
const existingItems = JSON.parse(fs.readFileSync(existingItemsUrl, 'utf8'));
let previousParsedItemCount = null;
try {
  const previousReport = JSON.parse(fs.readFileSync(new URL('../data/crawl-report.json', import.meta.url), 'utf8'));
  previousParsedItemCount = previousReport.parsedItemCount ?? null;
} catch {}
const reports = await Promise.all(adapters.map(adapter => adapter()));

const harvestedItems = reports.flatMap(report => report.items);
const parsedItemCount = reports.reduce((s, r) => s + (r.parsedItemCount || 0), 0);
const parserHealthy = reports.every(r => r.parserHealthy !== false);
const parserDropOk = previousParsedItemCount === null || parsedItemCount >= Math.floor(previousParsedItemCount * 0.5);

function mergeFetchedWithExisting(fetchedItems, currentItems) {
  const merged = new Map();
  for (const item of currentItems) {
    if (item?.id) merged.set(item.id, item);
  }
  for (const item of fetchedItems) {
    if (item?.id) merged.set(item.id, item);
  }
  return [...merged.values()].sort((a, b) => {
    const dateDiff = Date.parse(a.deadline) - Date.parse(b.deadline);
    if (dateDiff !== 0) return dateDiff;
    return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN');
  });
}

if (harvestedItems.length >= DRIVENDATA_MIN_ITEMS && parserHealthy && parserDropOk) {
  const mergedItems = mergeFetchedWithExisting(harvestedItems, existingItems);
  fs.writeFileSync(existingItemsUrl, JSON.stringify(mergedItems, null, 2) + '\n', 'utf8');
  console.log('crawler wrote ' + harvestedItems.length + ' fetched items; preserved/merged total ' + mergedItems.length + ' items');
} else {
  console.log('parser emitted ' + harvestedItems.length + ' items (health gate failed or threshold not met); preserving ' + existingItems.length + ' curated items in data/items.json');
}

const reachableCount = reports.filter(r => r.reachable).length;
console.log('reachability: ' + reachableCount + '/' + reports.length + ' sources reachable');
if (parsedItemCount > 0) console.log('parsedItemCount: ' + parsedItemCount);

fs.writeFileSync(new URL('../data/crawl-report.json', import.meta.url), JSON.stringify({
  topicId: "data-science-ddl",
  generatedAt: new Date().toISOString(),
  adapterCount: reports.length,
  reachableCount,
  parsedItemCount,
  previousParsedItemCount,
  parserHealthy,
  parserDropOk,
  adapters: reports
}, null, 2) + '\n', 'utf8');
