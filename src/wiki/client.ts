/**
 * A deliberately slow MediaWiki client for community.bistudio.com.
 *
 * Two things shape this file:
 *
 * 1. The site sits behind Cloudflare. Ordinary page requests (even /robots.txt)
 *    get a JS challenge, but `/wikidata/api.php` answers JSON directly — so the
 *    action API is the only sane way in, and we never parse rendered HTML.
 * 2. Cloudflare rate-limits the API on a sliding window of recent requests.
 *    Measured behaviour: batch size, User-Agent, URL encoding and page content
 *    make no difference — only request volume over time does, and requests made
 *    while blocked appear to refresh the block. So we pace every request,
 *    honour `maxlag`, and go fully quiet for five minutes on a 403 rather than
 *    probing at it.
 *
 * This client is used by the ingest scripts only. The MCP server itself never
 * touches the network — it reads the local index.
 */

export const WIKI_BASE = "https://community.bistudio.com";
export const API_URL = `${WIKI_BASE}/wikidata/api.php`;

/** MediaWiki etiquette asks for a descriptive UA with a contact route. */
const USER_AGENT = "arma-mcp/0.1.0 (https://github.com/Nighthawk42/arma-mcp)";

/** Anonymous API clients are capped at 50 titles per query. */
export const TITLES_PER_REQUEST = 50;

export interface ClientOptions {
  /** Minimum gap between requests, ms. */
  minIntervalMs?: number;
  maxRetries?: number;
  fetchFn?: typeof fetch;
  /** Progress/diagnostic sink. Never stdout — stdio transport owns it. */
  log?: (message: string) => void;
}

export interface RevisionPage {
  title: string;
  pageid?: number;
  missing?: boolean;
  wikitext?: string;
  revision?: { id: number; timestamp: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WikiClient {
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: typeof fetch;
  private readonly log: (message: string) => void;
  private lastRequestAt = 0;
  /** Number of API requests made — reported by the ingest for transparency. */
  public requestCount = 0;

  constructor(options: ClientOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 5000;
    this.maxRetries = options.maxRetries ?? 8;
    this.fetchFn = options.fetchFn ?? fetch;
    this.log = options.log ?? (() => {});
  }

  pageUrl(title: string): string {
    return `${WIKI_BASE}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
  }

  /** One paced, retried API request. Returns parsed JSON. */
  async request(params: Record<string, string>, overrides: { maxRetries?: number } = {}): Promise<any> {
    const maxRetries = overrides.maxRetries ?? this.maxRetries;
    const query = new URLSearchParams({
      format: "json",
      formatversion: "2",
      maxlag: "5",
      ...params,
    });
    const url = `${API_URL}?${query}`;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
      this.requestCount++;

      let response: Response;
      try {
        response = await this.fetchFn(url, {
          headers: { "user-agent": USER_AGENT, accept: "application/json" },
        });
      } catch (cause) {
        await this.backoff(attempt, `network error: ${String(cause)}`);
        continue;
      }

      // 429/503 carry Retry-After; maxlag replies use 503 too.
      if (response.status === 429 || response.status === 503) {
        const retryAfter = Number(response.headers.get("retry-after") ?? 0);
        await this.backoff(attempt, `HTTP ${response.status}`, retryAfter * 1000);
        continue;
      }
      // Cloudflare returns 403 for a small number of *specific pages*: asking
      // for "BIN fnc droneDestructionFX" alone fails every time, while its
      // neighbours succeed, so this is a content rule rather than rate
      // limiting. A batch containing one poisoned title fails as a whole,
      // which is why callers bisect and quarantine rather than just retrying.
      //
      // Retried anyway (briefly) because a genuine throttle also shows up here.
      if (response.status === 403) {
        await this.backoff(attempt, "HTTP 403 (blocked page or throttle)", 30_000);
        continue;
      }
      if (!response.ok) {
        await this.backoff(attempt, `HTTP ${response.status}`);
        continue;
      }

      const text = await response.text();
      // A Cloudflare challenge arrives as 200 text/html. Treat it as throttling.
      if (!text.trimStart().startsWith("{")) {
        await this.backoff(attempt, "non-JSON response (Cloudflare challenge)", 20_000);
        continue;
      }

      const body = JSON.parse(text);
      if (body.error?.code === "maxlag") {
        await this.backoff(attempt, "replication lag", 5000);
        continue;
      }
      if (body.error) {
        throw new Error(`Wiki API error ${body.error.code}: ${body.error.info ?? ""}`);
      }
      return body;
    }
    throw new Error(`Wiki request failed after ${maxRetries} retries: ${url}`);
  }

  private async backoff(attempt: number, reason: string, floorMs = 0): Promise<void> {
    const delay = Math.max(floorMs, this.minIntervalMs * 2 ** attempt);
    this.log(`  retry ${attempt + 1}: ${reason} — waiting ${Math.round(delay / 1000)}s`);
    await sleep(delay);
  }

  /** Every page title in a category (namespace 0), following continuations. */
  async categoryMembers(category: string): Promise<string[]> {
    const titles: string[] = [];
    let cmcontinue: string | undefined;
    do {
      const body = await this.request({
        action: "query",
        list: "categorymembers",
        cmtitle: category.startsWith("Category:") ? category : `Category:${category}`,
        cmnamespace: "0",
        cmlimit: "500",
        ...(cmcontinue ? { cmcontinue } : {}),
      });
      for (const m of body.query?.categorymembers ?? []) titles.push(m.title);
      cmcontinue = body.continue?.cmcontinue;
    } while (cmcontinue);
    return titles;
  }

  /** Fetch wikitext + revision metadata for up to 50 titles in one request. */
  async fetchWikitext(
    titles: string[],
    overrides: { maxRetries?: number } = {},
  ): Promise<RevisionPage[]> {
    if (titles.length === 0) return [];
    if (titles.length > TITLES_PER_REQUEST) {
      throw new Error(`fetchWikitext takes at most ${TITLES_PER_REQUEST} titles`);
    }
    const body = await this.request(
      {
        action: "query",
        prop: "revisions",
        rvprop: "content|ids|timestamp",
        rvslots: "main",
        titles: titles.join("|"),
      },
      overrides,
    );
    return (body.query?.pages ?? []).map((p: any): RevisionPage => {
      const rev = p.revisions?.[0];
      return {
        title: p.title,
        pageid: p.pageid,
        missing: Boolean(p.missing),
        wikitext: rev?.slots?.main?.content,
        revision: rev ? { id: rev.revid, timestamp: rev.timestamp } : undefined,
      };
    });
  }

  /**
   * Titles in namespace 0 edited since `since` (ISO timestamp).
   *
   * This is what makes the weekly update cheap: one request tells us what
   * changed, so we only refetch those pages instead of the whole corpus.
   */
  async changedSince(since: string): Promise<{ titles: string[]; latest: string }> {
    const titles = new Set<string>();
    let latest = since;
    let rccontinue: string | undefined;
    do {
      const body = await this.request({
        action: "query",
        list: "recentchanges",
        rcnamespace: "0",
        rcprop: "title|timestamp",
        rcend: since,
        rcdir: "older",
        rclimit: "500",
        rctype: "edit|new",
        ...(rccontinue ? { rccontinue } : {}),
      });
      for (const c of body.query?.recentchanges ?? []) {
        titles.add(c.title);
        if (c.timestamp > latest) latest = c.timestamp;
      }
      rccontinue = body.continue?.rccontinue;
    } while (rccontinue);
    return { titles: [...titles], latest };
  }
}

/** Split a list into chunks the API will accept in one request. */
export function chunk<T>(items: T[], size = TITLES_PER_REQUEST): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
