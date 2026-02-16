/* Simple front-end for aggregated feed JSON (no framework). */

const NEWS_URL = './data/news.json';
const META_URL = './data/meta.json';

const els = {
  q: document.getElementById('q'),
  timeRange: document.getElementById('timeRange'),
  hideRead: document.getElementById('hideRead'),
  clearRead: document.getElementById('clearRead'),
  resetFilters: document.getElementById('resetFilters'),
  refresh: document.getElementById('refresh'),
  list: document.getElementById('list'),
  empty: document.getElementById('empty'),
  statusLine: document.getElementById('statusLine'),
  updatedLine: document.getElementById('updatedLine'),
  countLine: document.getElementById('countLine'),
  categoryFilters: document.getElementById('categoryFilters'),
  sourceFilters: document.getElementById('sourceFilters'),
  errorsBox: document.getElementById('errorsBox'),
};

const STORAGE_KEY = 'adnews_state_v2';
const SCHEMA_VERSION = 2;

function loadStateRaw() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

function migrateOrDefault(raw) {
  const base = {
    schemaVersion: SCHEMA_VERSION,
    query: '',
    timeRange: 'all',
    hideRead: false,
    categories: null, // null => all selected
    sources: null,    // null => all selected
    readIds: [],
  };

  if (!raw || typeof raw !== 'object') return base;

  // If schema mismatch, keep read history but reset filters to show everything.
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    return {
      ...base,
      readIds: Array.isArray(raw.readIds) ? raw.readIds : [],
    };
  }

  // Schema matches: validate fields
  return {
    ...base,
    ...raw,
    schemaVersion: SCHEMA_VERSION,
    query: typeof raw.query === 'string' ? raw.query : '',
    timeRange: typeof raw.timeRange === 'string' ? raw.timeRange : 'all',
    hideRead: !!raw.hideRead,
    categories: raw.categories === null || Array.isArray(raw.categories) ? raw.categories : null,
    sources: raw.sources === null || Array.isArray(raw.sources) ? raw.sources : null,
    readIds: Array.isArray(raw.readIds) ? raw.readIds : [],
  };
}

function nowTs() {
  return Date.now();
}

function parseISO(d) {
  const t = Date.parse(d);
  return Number.isFinite(t) ? t : null;
}

function formatDate(iso) {
  const t = parseISO(iso);
  if (!t) return 'Unknown date';
  const dt = new Date(t);
  return dt.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getCutoffMs(range) {
  const oneHour = 60 * 60 * 1000;
  const oneDay = 24 * oneHour;
  switch (range) {
    case '24h': return nowTs() - 1 * oneDay;
    case '7d': return nowTs() - 7 * oneDay;
    case '30d': return nowTs() - 30 * oneDay;
    case '90d': return nowTs() - 90 * oneDay;
    case 'all': return null;
    default: return null;
  }
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v; // avoid for feed content
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    if (typeof c === 'string') node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  }
  return node;
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function normalizeQuery(s) {
  return (s || '').trim().toLowerCase();
}

function matchesQuery(item, q) {
  if (!q) return true;
  const hay = [
    item.title || '',
    item.summary || '',
    item.source || '',
    item.category || '',
    ...(item.tags || []),
  ].join(' ').toLowerCase();
  return hay.includes(q);
}

function readSetFromState(state) {
  return new Set((state?.readIds || []).filter(Boolean));
}

function writeReadSetToState(state, readSet) {
  // Limit size so localStorage doesn't grow forever
  const MAX_READ = 2000;
  const arr = Array.from(readSet);
  const sliced = arr.length > MAX_READ ? arr.slice(arr.length - MAX_READ) : arr;
  state.readIds = sliced;
}

let state = migrateOrDefault(loadStateRaw());

let allItems = [];
let meta = null;

function isRead(itemId) {
  const s = readSetFromState(state);
  return s.has(itemId);
}

function markRead(itemId) {
  const s = readSetFromState(state);
  s.add(itemId);
  writeReadSetToState(state, s);
  saveState(state);
}

function clearRead() {
  state.readIds = [];
  saveState(state);
}

function setStatus(msg) {
  els.statusLine.textContent = msg;
}

function setUpdated(msg) {
  els.updatedLine.textContent = msg;
}

function setErrorsBox(errors) {
  if (!errors || errors.length === 0) {
    els.errorsBox.textContent = 'No feed errors recorded on last update.';
    return;
  }
  const lines = errors.map(e => `- ${e.name || e.id}: ${e.error || 'Unknown error'}`);
  els.errorsBox.textContent = lines.join('\n');
}

function selectedSetOrAll(key, values) {
  const saved = state[key];
  if (!saved) return new Set(values);
  return new Set(saved.filter(v => values.includes(v)));
}

function setSelection(key, set, allValues) {
  const arr = Array.from(set);
  if (arr.length === allValues.length) state[key] = null;
  else state[key] = arr;
  saveState(state);
}

function renderFilterCheckboxes(container, values, selectedSet, onToggle) {
  container.innerHTML = '';
  for (const v of values) {
    const id = `${container.id}_${v}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    const input = el('input', { type: 'checkbox', id });
    input.checked = selectedSet.has(v);
    input.addEventListener('change', () => onToggle(v, input.checked));

    const label = el('label', { class: 'filter-item', for: id }, [
      input,
      el('span', { text: v }),
    ]);

    container.appendChild(label);
  }
}

function applyFilters(items) {
  const q = normalizeQuery(state.query);
  const cutoff = getCutoffMs(state.timeRange);

  const categories = uniq(items.map(i => i.category).filter(Boolean)).sort();
  const sources = uniq(items.map(i => i.source).filter(Boolean)).sort();

  const selectedCats = selectedSetOrAll('categories', categories);
  const selectedSources = selectedSetOrAll('sources', sources);

  const filtered = items.filter(it => {
    if (cutoff != null) {
      const t = parseISO(it.published);
      if (!t || t < cutoff) return false;
    }
    if (!selectedCats.has(it.category)) return false;
    if (!selectedSources.has(it.source)) return false;
    if (!matchesQuery(it, q)) return false;
    if (state.hideRead && isRead(it.id)) return false;
    return true;
  });

  return { filtered, categories, sources, selectedCats, selectedSources };
}

function renderList(items) {
  els.list.innerHTML = '';
  els.empty.classList.toggle('hidden', items.length !== 0);

  for (const it of items) {
    const titleLink = el('a', {
      href: it.url,
      target: '_blank',
      rel: 'noopener noreferrer',
      class: 'card-title-link',
    });
    titleLink.textContent = it.title || '(untitled)';
    titleLink.addEventListener('click', () => {
      markRead(it.id);
      const card = titleLink.closest('.card');
      if (card) card.classList.add('read');
      if (state.hideRead) render();
    });

    const tags = (it.tags || []).slice(0, 8);
    const metaRow = el('div', { class: 'card-meta' }, [
      el('span', { class: 'pill', text: formatDate(it.published) }),
      it.source ? el('span', { class: 'pill', text: it.source }) : null,
      it.category ? el('span', { class: 'pill', text: it.category }) : null,
      ...tags.map(t => el('span', { class: 'pill', text: t })),
    ]);

    const summary = el('p', { class: 'summary' });
    summary.textContent = it.summary || '';

    const card = el('article', { class: 'card' }, [
      el('h3', { class: 'card-title' }, [titleLink]),
      metaRow,
      summary,
    ]);

    if (isRead(it.id)) card.classList.add('read');

    els.list.appendChild(card);
  }
}

function renderFilters(categories, sources, selectedCats, selectedSources) {
  renderFilterCheckboxes(els.categoryFilters, categories, selectedCats, (v, checked) => {
    const next = new Set(selectedCats);
    if (checked) next.add(v); else next.delete(v);
    setSelection('categories', next, categories);
    render();
  });

  renderFilterCheckboxes(els.sourceFilters, sources, selectedSources, (v, checked) => {
    const next = new Set(selectedSources);
    if (checked) next.add(v); else next.delete(v);
    setSelection('sources', next, sources);
    render();
  });
}

function render() {
  const { filtered, categories, sources, selectedCats, selectedSources } = applyFilters(allItems);

  renderFilters(categories, sources, selectedCats, selectedSources);
  renderList(filtered);

  const total = allItems.length;
  const showing = filtered.length;
  els.countLine.textContent = `Showing ${showing.toLocaleString()} of ${total.toLocaleString()} items`;
}

async function fetchJson(url) {
  const u = `${url}?ts=${Date.now()}`;
  const res = await fetch(u, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

async function loadData() {
  setStatus('Loading…');
  setUpdated('');
  els.errorsBox.textContent = '';

  try {
    const [m, items] = await Promise.all([
      fetchJson(META_URL).catch(() => null),
      fetchJson(NEWS_URL),
    ]);
    meta = m;
    allItems = Array.isArray(items) ? items : [];
    setStatus(`Loaded ${allItems.length.toLocaleString()} items`);
    if (meta?.generatedAt) {
      setUpdated(`Last updated: ${formatDate(meta.generatedAt)}`);
    } else {
      setUpdated('');
    }
    setErrorsBox(meta?.errors || []);
  } catch (err) {
    allItems = [];
    setStatus(`Failed to load data: ${err?.message || String(err)}`);
    setUpdated('');
    setErrorsBox([]);
  }

  render();
}

function wireUI() {
  els.q.value = state.query || '';
  els.timeRange.value = state.timeRange || 'all';
  els.hideRead.checked = !!state.hideRead;

  els.q.addEventListener('input', () => {
    state.query = els.q.value || '';
    saveState(state);
    render();
  });

  els.timeRange.addEventListener('change', () => {
    state.timeRange = els.timeRange.value;
    saveState(state);
    render();
  });

  els.hideRead.addEventListener('change', () => {
    state.hideRead = els.hideRead.checked;
    saveState(state);
    render();
  });

  els.clearRead.addEventListener('click', () => {
    clearRead();
    render();
  });

  els.resetFilters.addEventListener('click', () => {
    state.query = '';
    state.timeRange = 'all';
    state.hideRead = false;
    state.categories = null;
    state.sources = null;

    saveState(state);

    els.q.value = '';
    els.timeRange.value = 'all';
    els.hideRead.checked = false;

    render();
  });

  els.refresh.addEventListener('click', async () => {
    await loadData();
  });
}

wireUI();
loadData();
