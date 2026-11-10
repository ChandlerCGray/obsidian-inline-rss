/*
  Inline RSS: renders RSS/Atom feeds as a table inside an ```inline-rss code block.
  See README.md for usage. Fetched items are cached in the plugin's data.json;
  nothing is written to your notes.
*/

const { Plugin, MarkdownRenderChild, requestUrl } = require('obsidian');

const DEFAULT_REFRESH_MIN = 30;
const TICK_MS = 60 * 1000;                     // how often open blocks check whether they're due
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // drop cached feeds nobody has fetched in 30 days

// ---------- Block parsing ----------

function parseBlock(source) {
  const opts = { max: 15, perFeed: 3, refreshMin: DEFAULT_REFRESH_MIN, feeds: [] };
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;

    const pipe = line.indexOf('|');
    if (pipe > -1) {
      const name = line.slice(0, pipe).trim();
      const url = line.slice(pipe + 1).trim();
      if (url) opts.feeds.push({ name: name || url, url });
      continue;
    }

    const m = line.match(/^([\w-]+)\s*:\s*(\d+)$/);
    if (m) {
      const key = m[1].toLowerCase();
      if (key === 'max') opts.max = Number(m[2]);
      if (key === 'per-feed') opts.perFeed = Number(m[2]);
      if (key === 'refresh') opts.refreshMin = Math.max(1, Number(m[2]));
      continue;
    }

    if (/^https?:\/\//i.test(line)) opts.feeds.push({ name: line, url: line });
  }
  return opts;
}

// ---------- Feed parsing (RSS 2.0, RSS 1.0/RDF, Atom) ----------

function childText(node, names) {
  for (const c of Array.from(node.children)) {
    if (names.includes(c.localName) && c.textContent.trim()) return c.textContent.trim();
  }
  return null;
}

function entryLink(node) {
  for (const c of Array.from(node.children)) {
    if (c.localName !== 'link') continue;
    const rel = c.getAttribute('rel');
    if (rel && rel !== 'alternate') continue;
    const href = c.getAttribute('href');
    if (href) return href.trim();
    if (c.textContent.trim()) return c.textContent.trim();
  }
  return null;
}

function decodeEntities(s) {
  if (!s || !s.includes('&')) return s;
  return new DOMParser().parseFromString(s, 'text/html').documentElement.textContent;
}

function parseFeed(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText.trim(), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('response was not valid XML');

  const nodes = Array.from(doc.getElementsByTagName('*'))
    .filter(n => n.localName === 'item' || n.localName === 'entry');

  const items = [];
  for (const n of nodes) {
    const link = entryLink(n);
    if (!link || !/^https?:\/\//i.test(link)) continue;   // only http(s) links, never javascript: etc.
    const title = (decodeEntities(childText(n, ['title'])) || link).replace(/\s+/g, ' ');
    const rawDate = childText(n, ['pubDate', 'published', 'updated', 'date']);
    const t = rawDate ? new Date(rawDate).getTime() : NaN;
    items.push({ title, link, date: isNaN(t) ? null : t });
  }
  items.sort((a, b) => (b.date || 0) - (a.date || 0));
  return items;
}

// ---------- Formatting ----------

function fmtDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtStamp(ms) {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

// ---------- Rendered block ----------

class FeedsView extends MarkdownRenderChild {
  constructor(containerEl, opts, plugin) {
    super(containerEl);
    this.opts = opts;
    this.plugin = plugin;
    this.loading = false;
  }

  onload() {
    this.plugin.views.add(this);
    this.render();
    this.load(false);
  }

  onunload() {
    this.plugin.views.delete(this);
  }

  async load(force) {
    if (this.loading) return;
    const maxAge = this.opts.refreshMin * 60 * 1000;
    const due = this.opts.feeds.some(f => {
      const c = this.plugin.cache[f.url];
      return !c || Date.now() - c.fetchedAt >= maxAge;
    });
    if (!force && !due) return;   // nothing stale: skip the "Refreshing…" flicker
    this.loading = true;
    this.render();
    await Promise.all(this.opts.feeds.map(f => this.plugin.fetchFeed(f.url, force, maxAge)));
    this.loading = false;
    await this.plugin.persist();
    this.render();
  }

  render() {
    const el = this.containerEl;
    el.empty();
    el.addClass('inline-rss');

    const { max, perFeed, feeds } = this.opts;
    if (!feeds.length) {
      el.createDiv({ cls: 'inline-rss-meta', text: 'No feeds listed. Add lines like: Name | https://example.com/feed' });
      return;
    }

    const rows = [];
    const errors = [];
    let lastFetch = 0;
    for (const f of feeds) {
      const c = this.plugin.cache[f.url];
      if (!c) continue;
      lastFetch = Math.max(lastFetch, c.fetchedAt);
      if (c.error) errors.push(`${f.name} failed to load: ${c.error}`);
      for (const it of c.items.slice(0, perFeed)) rows.push({ ...it, source: f.name });
    }
    rows.sort((a, b) => (b.date || 0) - (a.date || 0));

    // Faint status line with a refresh link
    const meta = el.createDiv({ cls: 'inline-rss-meta' });
    meta.createSpan({ text: this.loading ? 'Refreshing…' : (lastFetch ? `Updated ${fmtStamp(lastFetch)}` : '') });
    if (!this.loading) {
      const btn = meta.createEl('a', { cls: 'inline-rss-refresh', text: 'Refresh', href: '#' });
      btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); this.load(true); });
    }

    if (rows.length) {
      const table = el.createEl('table');
      const head = table.createEl('thead').createEl('tr');
      for (const h of ['Title', 'Source', 'Date']) head.createEl('th', { text: h });

      const body = table.createEl('tbody');
      for (const r of rows.slice(0, max)) {
        const tr = body.createEl('tr');
        const a = tr.createEl('td').createEl('a', {
          cls: 'external-link',
          text: r.title,
          href: r.link,
          attr: { target: '_blank', rel: 'noopener' }
        });
        a.addEventListener('click', e => e.stopPropagation());
        tr.createEl('td', { cls: 'inline-rss-muted', text: r.source });
        tr.createEl('td', { cls: 'inline-rss-muted', text: r.date ? fmtDate(r.date) : '' });
      }
    } else if (!this.loading) {
      el.createDiv({ cls: 'inline-rss-meta', text: 'No posts to show.' });
    }

    for (const msg of errors) el.createDiv({ cls: 'inline-rss-error', text: msg });
  }
}

// ---------- Plugin ----------

module.exports = class InlineRssPlugin extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    this.cache = saved.cache || {};      // url -> { fetchedAt, items, error? }
    this.views = new Set();
    this.inflight = new Map();

    this.registerMarkdownCodeBlockProcessor('inline-rss', (source, el, ctx) => {
      ctx.addChild(new FeedsView(el, parseBlock(source), this));
    });

    this.registerInterval(window.setInterval(() => this.refreshAll(false), TICK_MS));

    this.addCommand({
      id: 'refresh-feeds',
      name: 'Refresh feeds',
      callback: () => this.refreshAll(true)
    });
  }

  refreshAll(force) {
    for (const v of this.views) v.load(force);
  }

  fetchFeed(url, force, maxAgeMs) {
    const c = this.cache[url];
    if (!force && c && Date.now() - c.fetchedAt < maxAgeMs) return Promise.resolve();
    if (this.inflight.has(url)) return this.inflight.get(url);

    const p = (async () => {
      try {
        const res = await requestUrl({ url, headers: { 'User-Agent': 'Mozilla/5.0 (Inline RSS)' } });
        this.cache[url] = { fetchedAt: Date.now(), items: parseFeed(res.text).slice(0, 50) };
      } catch (e) {
        const prev = this.cache[url];
        this.cache[url] = {
          fetchedAt: Date.now(),
          items: prev ? prev.items : [],   // keep showing the last good results
          error: (e && e.message) || String(e)
        };
      } finally {
        this.inflight.delete(url);
      }
    })();

    this.inflight.set(url, p);
    return p;
  }

  async persist() {
    const cutoff = Date.now() - CACHE_TTL_MS;
    for (const url of Object.keys(this.cache)) {
      if (this.cache[url].fetchedAt < cutoff) delete this.cache[url];
    }
    await this.saveData({ cache: this.cache });
  }
};
