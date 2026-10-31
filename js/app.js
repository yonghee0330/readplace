// 비북스 온라인 서가: 입장 화면 → 서가 → 읽기 모드
import { Reader, formatDuration } from './reader.js';
import * as store from './storage.js';
import * as sound from './sound.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const DEFAULT_TITLE = document.title;
const THEME_COLORS = { paper: '#efe6d6', night: '#24251f' };

const intro = $('#intro');
const shelfView = $('#shelf-view');
const shelfEl = $('#shelf');
const reader = new Reader($('#reader'), { onBack: goBack });

let books = [];
let openedFromShelf = false;

init();

async function init() {
  applyTheme(currentTheme());
  bindToggles();
  const started = performance.now();
  requestAnimationFrame(() => intro.classList.add('opening'));

  try {
    books = await loadBooks();
    if (!books.length) throw new Error('읽을 수 있는 책이 없습니다.');
  } catch (err) {
    console.error(err);
    showLoadError();
    return;
  }

  await wait(Math.max(0, (reduceMotion ? 300 : 1600) - (performance.now() - started)));
  renderShelf();
  shelfView.hidden = false;
  route();
  window.addEventListener('hashchange', route);

  intro.classList.add('done');
  setTimeout(() => { intro.hidden = true; }, 800);
}

// ---------- 책 불러오기 ----------
// books/index.json 에 적힌 순서대로 책을 꽂는다.
async function loadBooks() {
  const res = await fetch('books/index.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`books/index.json을 읽지 못했습니다 (${res.status})`);
  const list = await res.json();
  const results = await Promise.allSettled(list.books.map(async (file) => {
    const r = await fetch(`books/${file}`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${file}: ${r.status}`);
    return { file, book: await r.json() };
  }));
  const seen = new Set();
  return results.flatMap((r) => {
    if (r.status !== 'fulfilled') { console.warn('[비북스] 책을 읽지 못함:', r.reason); return []; }
    const { file, book } = r.value;
    if (!isValidBook(book, file) || seen.has(book.id)) return [];
    seen.add(book.id);
    return [book];
  });
}

// 출처(source)가 없는 책은 서가에 꽂지 않는다.
function isValidBook(b, file) {
  const problems = [];
  if (!b || typeof b !== 'object') problems.push('JSON 객체가 아님');
  else {
    for (const k of ['id', 'title', 'author']) {
      if (typeof b[k] !== 'string' || !b[k].trim()) problems.push(`${k} 없음`);
    }
    if (b.id && !/^[a-z0-9-]+$/.test(b.id)) problems.push('id는 영문 소문자·숫자·하이픈만');
    if (!Array.isArray(b.pages) || !b.pages.length || b.pages.some((p) => typeof p !== 'string')) problems.push('pages가 비었거나 문자열 배열이 아님');
    if (!b.source || !b.source.original || !b.source.copyright) problems.push('source(원전·저작권) 없음');
  }
  if (problems.length) console.warn(`[비북스] ${file} 건너뜀: ${problems.join(', ')}`);
  return !problems.length;
}

function showLoadError() {
  const el = $('#intro-error');
  const isFile = location.protocol === 'file:';
  el.innerHTML = isFile
    ? '파일을 바로 열면 책을 불러올 수 없어요.<br>폴더에서 <code>python3 -m http.server</code> 또는 <code>npx serve .</code>로 로컬 서버를 띄운 뒤 열어 주세요.'
    : '책을 불러오지 못했어요. 잠시 뒤 새로고침해 주세요.';
  el.hidden = false;
  intro.querySelector('.intro-text').textContent = '서점 문이 잠시 닫혀 있어요';
}

// ---------- 서가 ----------
function renderShelf() {
  shelfEl.replaceChildren(...books.map((book) => {
    const li = document.createElement('li');
    const meta = progressMeta(book);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cover';
    btn.dataset.book = book.id;
    btn.style.setProperty('--c', book.cover?.color || '#5b4a3a');
    btn.style.setProperty('--a', book.cover?.accent || '#e9dcc0');
    btn.style.setProperty('--ink-c', book.cover?.ink || '#fbf6ec');
    btn.setAttribute('aria-label', `${book.title}, ${book.author}${book.excerpt ? ', 일부 발췌' : ''}. ${meta.text}`);
    btn.innerHTML = `
      <span class="cover-text">
        <span class="cover-title"></span>
        <span class="cover-author"></span>
      </span>
      <span class="cover-art" aria-hidden="true">${coverArt(book.cover?.pattern)}</span>
      ${book.excerpt ? '<span class="cover-badge" aria-hidden="true">일부</span>' : ''}`;
    btn.querySelector('.cover-title').textContent = book.title;
    btn.querySelector('.cover-author').textContent = book.author;
    btn.addEventListener('click', () => {
      openedFromShelf = true;
      location.hash = `#/book/${book.id}`;
    });

    const p = document.createElement('p');
    p.className = 'meta';
    p.setAttribute('aria-hidden', 'true');
    p.textContent = meta.text;
    const bar = document.createElement('span');
    bar.className = 'bar';
    bar.innerHTML = `<i style="--w:${Math.round(meta.ratio * 100)}%"></i>`;
    p.append(bar);

    li.append(btn, p);
    return li;
  }));

  const today = store.getTodayMs();
  $('#today-total').innerHTML = today > 0
    ? `오늘 이 서가에서 읽은 시간 <strong>${formatDuration(today)}</strong>`
    : '오늘은 아직 펼친 책이 없어요.';
}

// 쪽수는 화면·글자 크기에 따라 달라지므로, 마지막으로 읽던 화면 기준으로 보여 준다.
function progressMeta(book) {
  const p = store.getBookProgress(book.id);
  if (!p.touched || !p.total) return { text: '새 책', ratio: 0 };
  if (p.finished && p.page >= p.total - 1) return { text: `다 읽음 · ${formatDuration(p.readMs)}`, ratio: 1 };
  const page = Math.min(p.page + 1, p.total);
  return { text: `${page} / ${p.total}쪽 · ${formatDuration(p.readMs)}`, ratio: page / p.total };
}

// ---------- 화면 전환 (#/book/책id) ----------
function route() {
  const m = location.hash.match(/^#\/book\/([a-z0-9-]+)$/);
  const book = m && books.find((b) => b.id === m[1]);
  if (book) {
    if (reader.book?.id === book.id) return;
    if (reader.isOpen) reader.close();
    shelfView.hidden = true;
    document.title = `${book.title} · 비북스`;
    reader.open(book);
    return;
  }
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  if (reader.isOpen) {
    const id = reader.close();
    renderShelf();
    shelfView.hidden = false;
    document.title = DEFAULT_TITLE;
    shelfEl.querySelector(`[data-book="${id}"]`)?.focus();
  }
}

function goBack() {
  if (openedFromShelf) {
    openedFromShelf = false;
    history.back();
  } else {
    history.replaceState(null, '', location.pathname + location.search);
    route();
  }
}

// ---------- 배경(종이/밤) · 빗소리 ----------
function currentTheme() {
  const saved = store.getSettings().theme;
  if (saved === 'paper' || saved === 'night') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'paper';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').setAttribute('content', THEME_COLORS[theme]);
  for (const b of $$('[data-action="theme"]')) {
    b.setAttribute('aria-pressed', String(theme === 'night'));
    b.title = theme === 'night' ? '종이 배경으로 바꾸기' : '밤 배경으로 바꾸기';
  }
}

function syncSound() {
  const on = sound.isPlaying();
  for (const b of $$('[data-action="sound"]')) {
    b.setAttribute('aria-pressed', String(on));
    b.title = on ? '빗소리 끄기' : '잔잔한 빗소리 켜기';
  }
}

function bindToggles() {
  if (!sound.isSupported()) {
    for (const b of $$('[data-action="sound"]')) {
      b.disabled = true;
      b.title = '이 브라우저에서는 소리를 낼 수 없어요';
    }
  }
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'theme') {
      const next = document.documentElement.dataset.theme === 'night' ? 'paper' : 'night';
      store.saveSettings({ theme: next });
      applyTheme(next);
    }
    if (btn.dataset.action === 'sound') {
      try {
        if (sound.isPlaying()) sound.stop();
        else await sound.start();
      } catch (err) {
        console.warn(err);
      }
      syncSound();
    }
  });
}

// ---------- 표지 그림 (외부 이미지 없이 SVG로) ----------
function coverArt(pattern) {
  const svg = (body) => `<svg viewBox="0 0 120 90" preserveAspectRatio="xMidYMax slice" fill="currentColor">${body}</svg>`;
  const flower = (x, y, r, o) => `<g transform="translate(${x} ${y})" opacity="${o}">${[0, 72, 144, 216, 288]
    .map((a) => `<ellipse cx="0" cy="${-r * 0.9}" rx="${r * 0.55}" ry="${r * 0.9}" transform="rotate(${a})"/>`).join('')}
    <circle r="${r * 0.3}" fill="#fff" fill-opacity=".45"/></g>`;
  const art = {
    petals: () => svg(`${flower(28, 58, 11, 0.95)}${flower(74, 40, 8, 0.7)}${flower(98, 70, 12, 0.85)}${flower(54, 82, 7, 0.6)}
      <ellipse cx="14" cy="30" rx="3" ry="5" transform="rotate(30 14 30)" opacity=".5"/>
      <ellipse cx="48" cy="22" rx="2.5" ry="4.5" transform="rotate(-20 48 22)" opacity=".45"/>
      <ellipse cx="104" cy="28" rx="2.5" ry="4.5" transform="rotate(50 104 28)" opacity=".4"/>`),
    stars: () => svg(`<path d="M92 14a14 14 0 1 0 12 22 11 11 0 1 1-12-22Z" opacity=".9"/>
      ${[[18, 22, 1.6], [34, 46, 1.1], [52, 18, 1.3], [60, 60, 1.8], [24, 72, 1.2], [80, 74, 1.4], [104, 56, 1], [44, 84, 0.9], [70, 32, 0.9], [12, 50, 0.8]]
        .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" opacity=".85"/>`).join('')}
      <path d="M40 40l1.6 4.4L46 46l-4.4 1.6L40 52l-1.6-4.4L34 46l4.4-1.6Z"/>
      <path d="M88 52l1 2.8 2.8 1-2.8 1L88 59.6l-1-2.8-2.8-1 2.8-1Z" opacity=".8"/>`),
    ripple: () => svg(`<g fill="none" stroke="currentColor" stroke-width="1.4">
      <ellipse cx="60" cy="70" rx="12" ry="3.5" opacity=".95"/><ellipse cx="60" cy="70" rx="26" ry="7.5" opacity=".7"/>
      <ellipse cx="60" cy="70" rx="42" ry="12" opacity=".45"/><ellipse cx="60" cy="70" rx="58" ry="17" opacity=".25"/></g>
      <path d="M60 20c8 4 10 12 4 20-8-2-11-10-4-20Z" opacity=".85"/><path d="M60 22l2 16" stroke="#000" stroke-opacity=".25" stroke-width=".8" fill="none"/>`),
    grapes: () => svg(`${[[52, 36], [62, 36], [72, 36], [57, 45], [67, 45], [77, 44], [62, 54], [72, 53], [67, 62], [57, 62], [62, 71]]
        .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="5.4" opacity=".9"/>`).join('')}
      <path d="M64 30c0-8 4-12 10-14" fill="none" stroke="currentColor" stroke-width="1.6"/>
      <path d="M76 16c10-6 22-2 24 8-10 4-20 2-24-8Z" opacity=".6"/>
      <path d="M40 26c-6-2-8 4-4 6s4 8-2 8" fill="none" stroke="currentColor" stroke-width="1.1" opacity=".6"/>`),
    field: () => svg(`<circle cx="92" cy="22" r="10" opacity=".85"/>
      <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
      <path d="M-4 52Q60 38 124 52" opacity=".9"/><path d="M-4 62Q60 48 124 62" opacity=".75"/>
      <path d="M-4 72Q60 58 124 72" opacity=".6"/><path d="M-4 82Q60 68 124 82" opacity=".45"/>
      <path d="M22 50v-8M22 44l-3-3M22 46l3-3M40 46v-8M40 40l-3-3M40 42l3-3" opacity=".8"/></g>`),
    feather: () => svg(`<g fill="none" stroke="currentColor" stroke-linecap="round">
      <path d="M30 84C46 60 70 34 100 14" stroke-width="1.6"/>
      ${Array.from({ length: 12 }, (_, k) => {
        const t = 0.18 + k * 0.065;
        const x = 30 + 70 * t;
        const y = 84 - 70 * t;
        return `<path d="M${x} ${y}q${8 - k * 0.3} 10 ${18 - k * 0.6} 12M${x} ${y}q-10 ${-4 + k * 0.2} ${-12 + k * 0.4} ${-16 + k * 0.6}" stroke-width=".9" opacity="${0.5 + k * 0.04}"/>`;
      }).join('')}</g>`),
    rain: () => svg(`<g stroke="currentColor" stroke-linecap="round" stroke-width="1.1">
      ${Array.from({ length: 22 }, (_, k) => {
        const x = (k * 37) % 128 - 4;
        const y = (k * 23) % 60;
        return `<path d="M${x} ${y}l-5 12" opacity="${0.35 + ((k * 7) % 5) / 10}"/>`;
      }).join('')}</g>
      <g fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="70" cy="74" r="12"/>
      <path d="M70 62v24M58 74h24M61.5 65.5l17 17M78.5 65.5l-17 17" stroke-width=".8"/>
      <path d="M58 74H36l-6-12M82 74l14-18" stroke-width="1.4"/></g>`),
  };
  return (art[pattern] || art.stars)();
}
