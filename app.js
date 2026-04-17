/* ============================================================
   映画ウォッチリスト v2 — GitHub Gist 多端末同期対応
   ============================================================ */

const TMDB_BASE     = 'https://api.themoviedb.org/3';
const TMDB_IMG_W    = 'https://image.tmdb.org/t/p/w300';
const GIST_FILENAME = 'movie-watchlist.json';
const EXPIRING_DAYS = 14;

const PRESET_TAGS = [
  'アクション', 'コメディ', 'ドラマ', 'SF', 'ホラー',
  'ロマンス', 'アニメ', 'スリラー', 'ファンタジー',
  'ドキュメンタリー', 'ミステリー', '歴史', '音楽', 'アドベンチャー',
];

const PRIME_IDS = new Set([9, 10, 119]);

/* ============================================================
   State
   ============================================================ */
const state = {
  // Gistで全端末同期するデータ
  movies:      [],
  apiKey:      '',
  country:     'JP',
  // このデバイスのみ（localStorageに保存）
  githubToken: '',
  gistId:      '',
  // UI状態
  filter:      'all',
  sort:        'added',
  editId:      null,
  editTags:    [],
  editRating:  0,
};

/* ============================================================
   ローカルストレージ（認証情報のみ）
   ============================================================ */
function loadLocal() {
  state.githubToken = localStorage.getItem('mw_ghtoken') || '';
  state.gistId      = localStorage.getItem('mw_gistid')  || '';
}

function saveLocal() {
  localStorage.setItem('mw_ghtoken', state.githubToken);
  localStorage.setItem('mw_gistid',  state.gistId);
}

/* ============================================================
   GitHub Gist API
   ============================================================ */
async function ghFetch(path, opts = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${state.githubToken}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub API エラー ${res.status}`);
  }
  return res.json();
}

async function connectGist() {
  // 既存のGistを探す
  const gists = await ghFetch('/gists?per_page=100');
  const found = gists.find(g => g.files[GIST_FILENAME]);
  if (found) {
    state.gistId = found.id;
    saveLocal();
    return;
  }
  // 新規作成
  const created = await ghFetch('/gists', {
    method: 'POST',
    body: JSON.stringify({
      description: '映画ウォッチリスト — 自動同期データ',
      public: false,
      files: {
        [GIST_FILENAME]: {
          content: JSON.stringify({ version: 1, movies: [], apiKey: '', country: 'JP' }, null, 2),
        },
      },
    }),
  });
  state.gistId = created.id;
  saveLocal();
}

async function loadFromGist() {
  const gist = await ghFetch(`/gists/${state.gistId}`);
  const raw  = gist.files[GIST_FILENAME]?.content;
  if (!raw) return;
  const data    = JSON.parse(raw);
  state.movies  = data.movies  || [];
  state.apiKey  = data.apiKey  || '';
  state.country = data.country || 'JP';
}

/* ---- 保存（デバウンス 2秒） ---- */
let saveTimer = null;

function scheduleSave() {
  setSyncStatus('pending');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 2000);
}

async function flushSave() {
  if (!state.gistId || !state.githubToken) return;
  setSyncStatus('saving');
  try {
    await ghFetch(`/gists/${state.gistId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        files: {
          [GIST_FILENAME]: {
            content: JSON.stringify({
              version: 1,
              movies:  state.movies,
              apiKey:  state.apiKey,
              country: state.country,
            }, null, 2),
          },
        },
      }),
    });
    setSyncStatus('saved');
  } catch (e) {
    console.error('Gist保存エラー:', e);
    setSyncStatus('error');
  }
}

/* ---- 同期ステータス表示 ---- */
function setSyncStatus(status) {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  const labels = { pending: '⏳', saving: '☁️ 同期中…', saved: '✓ 同期済み', error: '⚠️ エラー', idle: '' };
  el.textContent   = labels[status] || '';
  el.dataset.status = status;
  if (status === 'saved') {
    setTimeout(() => { el.textContent = ''; el.dataset.status = 'idle'; }, 3000);
  }
}

/* ============================================================
   TMDB API
   ============================================================ */
async function tmdb(path, params = {}) {
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set('api_key', state.apiKey);
  url.searchParams.set('language', 'ja-JP');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

async function searchTMDB(query) {
  const d = await tmdb('/search/movie', { query, include_adult: 'false' });
  return d.results || [];
}

async function fetchPrimeStatus(tmdbId) {
  try {
    const d      = await tmdb(`/movie/${tmdbId}/watch/providers`);
    const region = d.results?.[state.country];
    if (!region) return false;
    return (region.flatrate || []).some(p =>
      PRIME_IDS.has(p.provider_id) ||
      (p.provider_name?.toLowerCase().includes('amazon') &&
       p.provider_name?.toLowerCase().includes('prime'))
    );
  } catch { return false; }
}

/* ============================================================
   Movie Operations
   ============================================================ */
function findMovie(id)    { return state.movies.find(m => m.id === id); }
function isAdded(tmdbId)  { return state.movies.some(m => m.tmdbId === tmdbId); }

async function addMovie(tmdbMovie) {
  if (isAdded(tmdbMovie.id)) { toast('すでにリストに追加されています'); return; }
  const movie = {
    id:            `m_${Date.now()}`,
    tmdbId:        tmdbMovie.id,
    title:         tmdbMovie.title || tmdbMovie.original_title || '不明',
    originalTitle: tmdbMovie.original_title || '',
    year:          (tmdbMovie.release_date || '').slice(0, 4) || '?',
    posterPath:    tmdbMovie.poster_path || null,
    overview:      tmdbMovie.overview || '',
    status:        'watchlist',
    rating:        0,
    tags:          [],
    onPrime:       false,
    primeDetected: false,
    expiresDate:   null,
    addedAt:       new Date().toISOString(),
  };
  state.movies.unshift(movie);
  scheduleSave();
  renderAll();
  toast(`「${movie.title}」を追加しました`);

  // Amazonプライム判定（バックグラウンド）
  const onPrime = await fetchPrimeStatus(tmdbMovie.id);
  const m = state.movies.find(x => x.tmdbId === tmdbMovie.id);
  if (m) {
    m.onPrime = onPrime; m.primeDetected = true;
    scheduleSave(); renderAll();
    if (onPrime) toast('✓ Amazonプライムで視聴可能');
  }
}

function updateMovie(id, changes) {
  const idx = state.movies.findIndex(m => m.id === id);
  if (idx !== -1) { state.movies[idx] = { ...state.movies[idx], ...changes }; scheduleSave(); }
}

function deleteMovie(id) {
  const m = findMovie(id);
  state.movies = state.movies.filter(x => x.id !== id);
  scheduleSave(); renderAll();
  if (m) toast(`「${m.title}」を削除しました`);
}

/* ============================================================
   Filter & Sort
   ============================================================ */
function filteredMovies() {
  const today = new Date(); today.setHours(0,0,0,0);
  const soon  = new Date(today); soon.setDate(soon.getDate() + EXPIRING_DAYS);
  let list = [...state.movies];
  switch (state.filter) {
    case 'watchlist': list = list.filter(m => m.status === 'watchlist'); break;
    case 'watched':   list = list.filter(m => m.status === 'watched');   break;
    case 'prime':     list = list.filter(m => m.onPrime);                break;
    case 'expiring':
      list = list.filter(m => {
        if (!m.onPrime || !m.expiresDate) return false;
        const d = new Date(m.expiresDate);
        return d >= today && d <= soon;
      }); break;
  }
  switch (state.sort) {
    case 'title':  list.sort((a,b) => a.title.localeCompare(b.title,'ja')); break;
    case 'year':   list.sort((a,b) => (b.year||0)-(a.year||0));             break;
    case 'rating': list.sort((a,b) => b.rating-a.rating);                   break;
    default:       list.sort((a,b) => new Date(b.addedAt)-new Date(a.addedAt));
  }
  return list;
}

function counts() {
  const today = new Date(); today.setHours(0,0,0,0);
  const soon  = new Date(today); soon.setDate(soon.getDate() + EXPIRING_DAYS);
  return {
    all:      state.movies.length,
    watchlist: state.movies.filter(m => m.status === 'watchlist').length,
    watched:  state.movies.filter(m => m.status === 'watched').length,
    prime:    state.movies.filter(m => m.onPrime).length,
    expiring: state.movies.filter(m => {
      if (!m.onPrime || !m.expiresDate) return false;
      const d = new Date(m.expiresDate); return d >= today && d <= soon;
    }).length,
  };
}

/* ============================================================
   Rendering
   ============================================================ */
function renderAll() { renderCounts(); renderGrid(); }

function renderCounts() {
  const c = counts();
  const s = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v > 0 ? ` ${v}` : ''; };
  s('cnt-all', c.all); s('cnt-watchlist', c.watchlist); s('cnt-watched', c.watched);
  s('cnt-prime', c.prime); s('cnt-expiring', c.expiring);
}

function renderGrid() {
  const grid  = document.getElementById('movieGrid');
  const empty = document.getElementById('emptyState');
  const list  = filteredMovies();
  if (!list.length) { grid.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  grid.innerHTML = list.map(cardHTML).join('');
}

function daysLeft(expiresDate) {
  if (!expiresDate) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  return Math.ceil((new Date(expiresDate) - today) / 86400000);
}

function posterSrc(path) { return path ? `${TMDB_IMG_W}${path}` : ''; }

function cardHTML(m) {
  const dl       = daysLeft(m.expiresDate);
  const expiring = m.onPrime && dl !== null && dl >= 0 && dl <= EXPIRING_DAYS;
  const topBadges = [
    m.status === 'watched' ? `<span class="badge b-watched">✓</span>` : '',
    m.onPrime              ? `<span class="badge b-prime">▶</span>`   : '',
  ].join('');
  const botBadges = expiring
    ? `<span class="badge b-expiring">⏰ ${dl === 0 ? '今日' : `残${dl}日`}</span>` : '';
  const stars = m.status === 'watched' && m.rating > 0
    ? `<span class="card-stars">${'★'.repeat(m.rating)}${'☆'.repeat(5-m.rating)}</span>` : '';
  const poster = m.posterPath
    ? `<img class="card-poster-img" src="${posterSrc(m.posterPath)}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="card-no-poster">🎬</div>`;
  const tagsHtml = m.tags.slice(0,3).map(t=>`<span class="tag-chip">${esc(t)}</span>`).join('');
  return `
    <div class="movie-card" data-id="${m.id}">
      <div class="card-poster-wrap">
        ${poster}
        <div class="card-overlay">
          <div class="card-top">${topBadges}</div>
          <div class="card-bottom">${botBadges}</div>
        </div>
      </div>
      <div class="card-info">
        <div class="card-title">${esc(m.title)}</div>
        <div class="card-meta"><span class="card-year">${m.year}</span>${stars}</div>
        ${tagsHtml ? `<div class="card-tags">${tagsHtml}</div>` : ''}
      </div>
    </div>`;
}

/* ============================================================
   Search
   ============================================================ */
let searchTimer = null;

function setupSearch() {
  const input    = document.getElementById('searchInput');
  const clearBtn = document.getElementById('searchClear');
  const dropdown = document.getElementById('searchDropdown');
  const list     = document.getElementById('searchList');

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearBtn.classList.toggle('hidden', !q);
    if (!q) { dropdown.classList.add('hidden'); return; }
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doSearch(q), 380);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { clearTimeout(searchTimer); doSearch(input.value.trim()); }
    if (e.key === 'Escape') clearSearch();
  });
  clearBtn.addEventListener('click', clearSearch);
  document.addEventListener('click', e => {
    if (!document.querySelector('.header-search').contains(e.target))
      dropdown.classList.add('hidden');
  });
  list.addEventListener('click', async e => {
    const btn = e.target.closest('.search-item-add');
    if (!btn || btn.disabled) return;
    const tmdbId = parseInt(btn.dataset.tid);
    btn.disabled = true; btn.textContent = '追加中…';
    try {
      const data = await tmdb(`/movie/${tmdbId}`);
      await addMovie(data);
      btn.textContent = '追加済み';
    } catch { btn.disabled = false; btn.textContent = '追加'; toast('追加に失敗しました'); }
  });
}

function clearSearch() {
  document.getElementById('searchInput').value = '';
  document.getElementById('searchClear').classList.add('hidden');
  document.getElementById('searchDropdown').classList.add('hidden');
}

async function doSearch(q) {
  if (!q) return;
  if (!state.apiKey) { toast('設定からTMDB APIキーを登録してください'); return; }
  const dropdown = document.getElementById('searchDropdown');
  const list     = document.getElementById('searchList');
  dropdown.classList.remove('hidden');
  list.innerHTML = `<div class="search-msg">🔍 検索中...</div>`;
  try {
    const results = await searchTMDB(q);
    if (!results.length) { list.innerHTML = `<div class="search-msg">見つかりませんでした</div>`; return; }
    list.innerHTML = results.slice(0,10).map(searchItemHTML).join('');
  } catch (e) {
    list.innerHTML = `<div class="search-msg">エラー: ${esc(e.message)}</div>`;
  }
}

function searchItemHTML(m) {
  const added = isAdded(m.id);
  const year  = (m.release_date || '').slice(0,4);
  return `
    <div class="search-item">
      <img class="search-item-poster" src="${posterSrc(m.poster_path)}" alt="" onerror="this.style.visibility='hidden'">
      <div class="search-item-info">
        <div class="search-item-title">${esc(m.title || m.original_title || '')}</div>
        <div class="search-item-year">${year || '年不明'}</div>
        <div class="search-item-overview">${esc(m.overview || '')}</div>
      </div>
      <button class="search-item-add" data-tid="${m.id}" ${added ? 'disabled' : ''}>
        ${added ? '追加済み' : '追加'}
      </button>
    </div>`;
}

/* ============================================================
   Detail Modal
   ============================================================ */
function openDetail(id) {
  const m = findMovie(id);
  if (!m) return;
  state.editId = id; state.editTags = [...m.tags]; state.editRating = m.rating;

  const poster   = document.getElementById('detailPoster');
  const noPoster = document.getElementById('detailNoPoster');
  if (m.posterPath) {
    poster.src = posterSrc(m.posterPath); poster.style.display = '';
    poster.onerror = () => { poster.style.display = 'none'; noPoster.classList.remove('hidden'); };
    noPoster.classList.add('hidden');
  } else { poster.style.display = 'none'; noPoster.classList.remove('hidden'); }

  const dl = daysLeft(m.expiresDate);
  const expiring = m.onPrime && dl !== null && dl >= 0 && dl <= EXPIRING_DAYS;
  document.getElementById('detailBadges').innerHTML = [
    m.onPrime  ? `<span class="badge b-prime">▶ Amazonプライム</span>` : '',
    expiring   ? `<span class="badge b-expiring">⏰ ${dl === 0 ? '今日終了' : `残${dl}日`}</span>` : '',
    m.status === 'watched' ? `<span class="badge b-watched">✓ 視聴済み</span>` : '',
  ].join('');

  document.getElementById('detailTitle').textContent = m.title;
  const meta = [m.year, m.originalTitle !== m.title ? m.originalTitle : null].filter(Boolean);
  document.getElementById('detailMeta').textContent = meta.join(' · ');
  document.getElementById('detailOverview').textContent = m.overview || '（あらすじなし）';
  setStatusButtons(m.status);
  setStars(m.rating);
  document.getElementById('primeToggle').checked = m.onPrime;
  document.getElementById('primeLabel').textContent = m.onPrime ? 'オン' : 'オフ';
  document.getElementById('primeAutoLabel').textContent = m.primeDetected ? '（自動検出済み）' : '';
  document.getElementById('expiresDateInput').value = m.expiresDate || '';
  renderEditTags();
  document.getElementById('detailModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeDetail() {
  document.getElementById('detailModal').classList.add('hidden');
  document.body.style.overflow = '';
  state.editId = null;
}

function setStatusButtons(status) {
  document.getElementById('statusWatchlist').className = 'status-btn' + (status === 'watchlist' ? ' s-watchlist' : '');
  document.getElementById('statusWatched').className   = 'status-btn' + (status === 'watched'   ? ' s-watched'   : '');
}

function setStars(rating) {
  document.querySelectorAll('#starRating .star').forEach(s =>
    s.classList.toggle('lit', +s.dataset.val <= rating)
  );
}

function renderEditTags() {
  const cur = document.getElementById('currentTagsList');
  cur.innerHTML = state.editTags.map((tag, i) => `
    <span class="tag-item">${esc(tag)}<button class="tag-remove" data-idx="${i}">✕</button></span>`
  ).join('');
  cur.querySelectorAll('.tag-remove').forEach(btn =>
    btn.addEventListener('click', () => { state.editTags.splice(+btn.dataset.idx, 1); renderEditTags(); })
  );
  const pre = document.getElementById('presetTagsRow');
  pre.innerHTML = PRESET_TAGS.map(tag =>
    `<button class="preset-tag-btn ${state.editTags.includes(tag)?'on':''}" data-tag="${escAttr(tag)}">${esc(tag)}</button>`
  ).join('');
  pre.querySelectorAll('.preset-tag-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      const tag = btn.dataset.tag;
      const idx = state.editTags.indexOf(tag);
      if (idx !== -1) state.editTags.splice(idx,1); else state.editTags.push(tag);
      renderEditTags();
    })
  );
}

function addCustomTag() {
  const input = document.getElementById('tagInput');
  const tag   = input.value.trim();
  if (!tag) return;
  if (state.editTags.includes(tag)) { toast('すでに追加されています'); return; }
  if (state.editTags.length >= 10)  { toast('タグは10個まで');        return; }
  state.editTags.push(tag); input.value = ''; renderEditTags();
}

function saveDetail() {
  if (!state.editId) return;
  const status  = document.getElementById('statusWatched').classList.contains('s-watched') ? 'watched' : 'watchlist';
  const onPrime = document.getElementById('primeToggle').checked;
  const expires = document.getElementById('expiresDateInput').value || null;
  updateMovie(state.editId, { status, rating: state.editRating, onPrime, expiresDate: expires, tags: [...state.editTags] });
  renderAll(); closeDetail(); toast('保存しました');
}

/* ============================================================
   Settings Modal
   ============================================================ */
function openSettings() {
  document.getElementById('settingsGhToken').value = '';
  document.getElementById('settingsApiKey').value  = state.apiKey;
  document.getElementById('countrySelect').value   = state.country;
  document.getElementById('settingsModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeSettings() {
  document.getElementById('settingsModal').classList.add('hidden');
  document.body.style.overflow = '';
}

async function saveSettings() {
  const newToken  = document.getElementById('settingsGhToken').value.trim();
  const newApiKey = document.getElementById('settingsApiKey').value.trim();
  const newCountry = document.getElementById('countrySelect').value;

  if (newToken) { state.githubToken = newToken; state.gistId = ''; saveLocal(); }
  if (newApiKey) state.apiKey = newApiKey;
  state.country = newCountry;

  // 再接続が必要な場合
  if (newToken) {
    closeSettings();
    showScreen('loadingScreen');
    try {
      await connectGist();
      await loadFromGist();
    } catch (e) { toast(`接続エラー: ${e.message}`); showScreen('mainApp'); return; }
  }

  scheduleSave();
  closeSettings();
  showScreen('mainApp');
  renderAll();
  toast('設定を保存しました');
}

/* ============================================================
   画面切り替え
   ============================================================ */
function showScreen(id) {
  ['step1','loadingScreen','step2','mainApp'].forEach(n =>
    document.getElementById(n)?.classList.add('hidden')
  );
  document.getElementById(id)?.classList.remove('hidden');
}

/* ============================================================
   Toast
   ============================================================ */
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
}

/* ============================================================
   Utilities
   ============================================================ */
function esc(s)     { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escAttr(s) { return String(s??'').replace(/"/g,'&quot;'); }

/* ============================================================
   Event Listeners
   ============================================================ */
function setupEvents() {
  /* --- ステップ1: GitHub接続 --- */
  const connectBtn = document.getElementById('setupConnectBtn');
  connectBtn.addEventListener('click', async () => {
    const token = document.getElementById('setupToken').value.trim();
    if (!token) { showSetupError('トークンを入力してください'); return; }
    state.githubToken = token; saveLocal();
    connectBtn.textContent = '接続中…'; connectBtn.disabled = true;
    document.getElementById('setupError').classList.add('hidden');
    showScreen('loadingScreen');
    try {
      await connectGist();
      await loadFromGist();
      if (!state.apiKey) { showScreen('step2'); return; }
      showScreen('mainApp'); renderAll();
    } catch (e) {
      state.githubToken = ''; saveLocal();
      showScreen('step1');
      showSetupError(`接続失敗: ${e.message}`);
    } finally { connectBtn.textContent = 'GitHubに接続する'; connectBtn.disabled = false; }
  });
  document.getElementById('setupToken').addEventListener('keydown', e => {
    if (e.key === 'Enter') connectBtn.click();
  });

  /* --- ステップ2: TMDBキー設定 --- */
  const apiKeyBtn = document.getElementById('setupApiKeyBtn');
  apiKeyBtn.addEventListener('click', async () => {
    const key = document.getElementById('setupApiKey').value.trim();
    if (!key) { toast('APIキーを入力してください'); return; }
    state.apiKey = key;
    await flushSave();
    showScreen('mainApp'); renderAll();
  });
  document.getElementById('setupApiKey').addEventListener('keydown', e => {
    if (e.key === 'Enter') apiKeyBtn.click();
  });

  /* --- QRコード --- */
  document.getElementById('showQRBtn').addEventListener('click', showQRCode);

  /* --- 設定 --- */
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('settingsClose').addEventListener('click', closeSettings);
  document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);
  document.getElementById('settingsModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeSettings();
  });

  /* --- フィルタータブ --- */
  document.querySelectorAll('.filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.filter = btn.dataset.filter; renderGrid();
    });
  });

  /* --- ソート --- */
  document.getElementById('sortSelect').addEventListener('change', e => {
    state.sort = e.target.value; renderGrid();
  });

  /* --- グリッドカードクリック --- */
  document.getElementById('movieGrid').addEventListener('click', e => {
    const card = e.target.closest('.movie-card');
    if (card) openDetail(card.dataset.id);
  });

  /* --- 詳細モーダル --- */
  document.getElementById('detailClose').addEventListener('click', closeDetail);
  document.getElementById('detailModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeDetail();
  });
  document.getElementById('statusWatchlist').addEventListener('click', () => setStatusButtons('watchlist'));
  document.getElementById('statusWatched').addEventListener('click',   () => setStatusButtons('watched'));

  /* --- 星評価 --- */
  const stars = document.querySelectorAll('#starRating .star');
  stars.forEach(s => {
    s.addEventListener('click', () => {
      const val = +s.dataset.val;
      state.editRating = state.editRating === val ? 0 : val;
      setStars(state.editRating);
    });
    s.addEventListener('mouseenter', () =>
      stars.forEach(x => x.classList.toggle('lit', +x.dataset.val <= +s.dataset.val))
    );
    s.addEventListener('mouseleave', () => setStars(state.editRating));
  });

  /* --- Primeトグル --- */
  document.getElementById('primeToggle').addEventListener('change', e => {
    document.getElementById('primeLabel').textContent = e.target.checked ? 'オン' : 'オフ';
  });

  /* --- 期限日クリア --- */
  document.getElementById('clearDateBtn').addEventListener('click', () => {
    document.getElementById('expiresDateInput').value = '';
  });

  /* --- タグ --- */
  document.getElementById('addTagBtn').addEventListener('click', addCustomTag);
  document.getElementById('tagInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') addCustomTag();
  });

  /* --- 保存・削除 --- */
  document.getElementById('saveDetailBtn').addEventListener('click', saveDetail);
  document.getElementById('deleteDetailBtn').addEventListener('click', () => {
    const m = findMovie(state.editId);
    if (!m) return;
    if (confirm(`「${m.title}」を削除しますか？`)) { deleteMovie(state.editId); closeDetail(); }
  });

  /* --- ESC --- */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeDetail(); closeSettings(); }
  });
}

function showSetupError(msg) {
  const el = document.getElementById('setupError');
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}

/* ============================================================
   QRコード（スマホ設定共有）
   ============================================================ */
function showQRCode() {
  const area = document.getElementById('qrArea');
  const img  = document.getElementById('qrImg');
  if (!state.githubToken) { toast('GitHubトークンが設定されていません'); return; }

  const setupUrl = `${location.origin}${location.pathname}#setup/${state.githubToken}`;
  const qrApi    = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(setupUrl)}`;
  img.src = qrApi;
  area.classList.toggle('hidden');
}

/* ============================================================
   Init
   ============================================================ */
async function init() {
  loadLocal();
  setupSearch();
  setupEvents();

  // QRコードからの自動セットアップ（#setup/TOKEN）
  const hash = location.hash;
  if (hash.startsWith('#setup/')) {
    const token = hash.slice(7);
    history.replaceState(null, '', location.pathname); // ハッシュをURLから消す
    if (token) {
      state.githubToken = token;
      saveLocal();
    }
  }

  if (!state.githubToken) { showScreen('step1'); return; }

  showScreen('loadingScreen');
  try {
    if (!state.gistId) await connectGist();
    await loadFromGist();
  } catch (e) {
    localStorage.removeItem('mw_gistid');
    state.gistId = '';
    showScreen('step1');
    showSetupError(`読み込みエラー: ${e.message}`);
    return;
  }

  if (!state.apiKey) { showScreen('step2'); return; }
  showScreen('mainApp');
  renderAll();
}

document.addEventListener('DOMContentLoaded', init);
