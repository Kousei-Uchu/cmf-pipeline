const $ = (sel) => document.querySelector(sel);

const state = {
  result: null,
  selected: null,
  expanded: null,
  mode: 'both',
  job: null,
};

const healthEl = $('#health');
const groupsEl = $('#groups');
const inspector = $('#inspector');
const inspectEmpty = $('#empty-inspect');
const inspectBody = $('#inspect-body');
const dock = $('#dock');
const logEl = $('#log');
const dockStatus = $('#dock-status');
const dockActions = $('#dock-actions');
const form = $('#search-form');
const q = $('#q');

async function loadHealth() {
  try {
    const h = await fetch('/api/health').then((r) => r.json());
    const bits = [
      h.ytdlp ? `yt-dlp ${h.ytdlp}` : 'yt-dlp missing',
      h.ffmpeg ? 'ffmpeg ok' : 'ffmpeg missing',
      h.spotify ? 'spotify on' : 'spotify off',
    ];
    healthEl.textContent = bits.join(' · ');
    healthEl.dataset.state = h.ok ? 'ok' : 'bad';
  } catch {
    healthEl.textContent = 'server unreachable';
    healthEl.dataset.state = 'bad';
  }
}

function thumb(item) {
  return item.thumbnail || item.album?.images?.[0]?.url || '/favicon.svg';
}

function formatDur(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function cardButton(item, groupId) {
  const btn = document.createElement('button');
  btn.className = 'card';
  btn.type = 'button';
  btn.dataset.id = item.id;
  btn.innerHTML = `
    <img alt="" src="${escapeAttr(thumb(item))}" />
    <div class="meta">
      <div class="title">${escapeHtml(item.title || 'Untitled')}</div>
      <div class="sub">${escapeHtml(item.author || item.channel || '')} ${formatDur(item.duration_ms)}</div>
    </div>`;
  btn.addEventListener('click', () => selectItem(item, groupId, btn));
  return btn;
}

function collectionThumb(result) {
  const img = result.collection?.images?.[0]?.url;
  if (img) return img;
  return thumb(result.items?.[0] || {});
}

function renderDownloadAllBar(result) {
  const count = result.items?.length || 0;
  if (result.kind !== 'url' || count < 2) return;
  const bar = document.createElement('div');
  bar.className = 'download-all-bar';
  bar.innerHTML = `
    <img alt="" src="${escapeAttr(collectionThumb(result))}" />
    <div class="meta">
      <p class="eyebrow">${escapeHtml(result.collection_kind || result.source || 'collection')}</p>
      <h2>${escapeHtml(result.title || 'Collection')}</h2>
      <p class="muted">${count} tracks</p>
    </div>
    <button type="button" id="download-all-btn">Download all</button>
  `;
  bar.querySelector('#download-all-btn').addEventListener('click', () => openCollectionInspector(result));
  groupsEl.append(bar);
}

function openCollectionInspector(result) {
  document.querySelectorAll('.card.selected').forEach((el) => el.classList.remove('selected'));
  state.selected = null;
  const items = result.items || [];
  state.expanded = { title: result.title, items };
  renderInspectorCollection({
    type: result.collection_kind || result.kind || 'collection',
    title: result.title || 'Collection',
    thumbSrc: collectionThumb(result),
    items,
  });
  inspector.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderGroups(result) {
  groupsEl.innerHTML = '';
  if (result.error) {
    groupsEl.innerHTML = `<p class="error">${escapeHtml(result.error)}</p>`;
    return;
  }
  if (!result.groups?.length) {
    groupsEl.innerHTML = `<p class="muted">Nothing matched.</p>`;
    return;
  }
  renderDownloadAllBar(result);
  for (const group of result.groups) {
    const wrap = document.createElement('section');
    wrap.className = 'group';
    wrap.innerHTML = `<h2>${escapeHtml(group.label)}</h2>`;
    if (group.error) {
      wrap.innerHTML += `<p class="error">${escapeHtml(group.error)}</p>`;
    }
    const grid = document.createElement('div');
    grid.className = 'cards';
    for (const item of group.items || []) {
      grid.append(cardButton(item, group.id));
    }
    wrap.append(grid);
    groupsEl.append(wrap);
  }
}

async function selectItem(item, groupId, btn) {
  document.querySelectorAll('.card.selected').forEach((el) => el.classList.remove('selected'));
  btn?.classList.add('selected');
  state.selected = item;
  state.expanded = null;

  if (item.type === 'album' || item.type === 'playlist' || item.type === 'artist') {
    const type = item.type;
    const id = item.spotify_id;
    inspectEmpty.classList.add('hidden');
    inspectBody.classList.remove('hidden');
    inspectBody.innerHTML = `<p class="muted">Expanding ${escapeHtml(type)}…</p>`;
    const data = await fetch(
      `/api/expand?source=spotify&type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`,
    ).then((r) => r.json());
    if (data.error) {
      inspectBody.innerHTML = `<p class="error">${escapeHtml(data.error)}</p>`;
      return;
    }
    state.expanded = data;
    renderInspectorCollection({
      type: item.type,
      title: data.title || item.title,
      thumbSrc: thumb(item),
      items: data.items || [],
    });
    return;
  }

  renderInspectorTrack(item);
}

function renderInspectorCollection({ type, title, thumbSrc, items }) {
  inspectEmpty.classList.add('hidden');
  inspectBody.classList.remove('hidden');
  inspectBody.innerHTML = `
    <div class="cover-row">
      <img alt="" src="${escapeAttr(thumbSrc)}" />
      <div>
        <p class="eyebrow">${escapeHtml(type || '')}</p>
        <h2>${escapeHtml(title || '')}</h2>
        <p class="muted">${items?.length || 0} items</p>
      </div>
    </div>
    ${modePicker()}
    <div class="stack">
      <button type="button" id="run-all">Pack all as .cmf</button>
    </div>
    <p class="muted" style="margin-top:16px">Tracks</p>
    <div class="cards" id="expand-cards"></div>
  `;
  wireModes();
  $('#run-all')?.addEventListener('click', () => startJob(items || []));
  const grid = $('#expand-cards');
  for (const track of items || []) {
    grid.append(cardButton(track, 'expanded'));
  }
}

function renderInspectorTrack(item) {
  inspectEmpty.classList.add('hidden');
  inspectBody.classList.remove('hidden');
  inspectBody.innerHTML = `
    <div class="cover-row">
      <img alt="" src="${escapeAttr(thumb(item))}" />
      <div>
        <p class="eyebrow">${escapeHtml(item.source || 'media')}</p>
        <h2>${escapeHtml(item.title)}</h2>
        <p class="muted">${escapeHtml(item.author || '')}${item.duration_ms ? ' · ' + formatDur(item.duration_ms) : ''}</p>
        ${item.url ? `<p><a href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer" style="color:var(--accent-2)">Open source</a></p>` : ''}
      </div>
    </div>
    ${modePicker()}
    <div class="stack">
      <button type="button" id="run-one">Confirm and pack .cmf</button>
    </div>
  `;
  wireModes();
  $('#run-one')?.addEventListener('click', () => startJob([item]));
}

function modePicker() {
  return `
    <div class="modes" role="group" aria-label="Delivery mode">
      <button type="button" class="chip" data-mode="audio">Audio only</button>
      <button type="button" class="chip" data-mode="video">Video only</button>
      <button type="button" class="chip" data-mode="both">Audio and video</button>
    </div>`;
}

function wireModes() {
  inspectBody.querySelectorAll('[data-mode]').forEach((el) => {
    el.setAttribute('aria-pressed', el.dataset.mode === state.mode ? 'true' : 'false');
    el.addEventListener('click', () => {
      state.mode = el.dataset.mode;
      inspectBody.querySelectorAll('[data-mode]').forEach((b) => {
        b.setAttribute('aria-pressed', b.dataset.mode === state.mode ? 'true' : 'false');
      });
    });
  });
}

async function startJob(items) {
  if (!items.length) return;
  dock.classList.remove('hidden');
  logEl.textContent = '';
  dockActions.innerHTML = '';
  dockStatus.textContent = 'Starting…';
  const res = await fetch('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, mode: state.mode, exportKind: 'file' }),
  });
  const data = await res.json();
  if (!res.ok) {
    dockStatus.textContent = 'Failed';
    logEl.textContent = data.error || 'Could not start job';
    return;
  }
  state.job = data.id;
  const es = new EventSource(`/api/jobs/${data.id}/events`);
  es.onmessage = (ev) => {
    const payload = JSON.parse(ev.data);
    if (payload.type === 'close') {
      es.close();
      return;
    }
    appendLog(payload);
    if (payload.type === 'done') {
      dockStatus.textContent = 'Ready';
      const origin = window.location.origin;
      dockActions.innerHTML = `
        <a href="${payload.download}" download>Download ${escapeHtml(payload.fileName)}</a>
        <button type="button" class="ghost" id="copy-url">Copy export URL</button>
        <button type="button" class="ghost" id="data-url">Fetch data URL</button>
      `;
      $('#copy-url')?.addEventListener('click', async () => {
        const url = origin + payload.exportUrl;
        await navigator.clipboard.writeText(url);
        dockStatus.textContent = 'Export URL copied';
      });
      $('#data-url')?.addEventListener('click', async () => {
        const json = await fetch(`${payload.exportUrl}?format=dataurl`).then((r) => r.json());
        if (json.error) {
          appendLog({ type: 'error', message: json.error });
          return;
        }
        await navigator.clipboard.writeText(json.data_url);
        dockStatus.textContent = 'data: URL copied (zip payload)';
      });
    }
    if (payload.type === 'error') dockStatus.textContent = 'Error';
  };
}

function appendLog(payload) {
  const line =
    payload.message ||
    payload.line ||
    (payload.type === 'done' ? `packed ${payload.fileName}` : payload.type);
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = q.value.trim();
  const url = `/api/search?query=${encodeURIComponent(query)}`;
  history.replaceState(null, '', query ? `/?query=${encodeURIComponent(query)}` : '/');
  groupsEl.innerHTML = `<p class="muted">Searching…</p>`;
  try {
    const result = await fetch(url).then((r) => r.json());
    if (result.error) throw new Error(result.error);
    state.result = result;
    renderGroups(result);
  } catch (err) {
    groupsEl.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
});

function escapeHtml(s) {
  return String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replaceAll("'", '&#39;');
}

const bootQuery = new URLSearchParams(location.search).get('query');
if (bootQuery) {
  q.value = bootQuery;
  form.requestSubmit();
}

loadHealth();
