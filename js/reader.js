// 읽기 모드: 양면 펼침(모바일은 한 면), 페이지 넘김, 타이머, 글자 크기, 이어 읽기
import * as store from './storage.js';

const FONT_STEPS = [15, 16.5, 18, 20, 22.5];   // px
const SPREAD_MIN_WIDTH = 860;                   // 이 폭 이상 + 가로가 넓으면 양면
const FLIP_MS = 620;
const IDLE_LIMIT_MS = 10 * 60 * 1000;           // 10분 동안 손대지 않으면 시간 재기를 쉰다
const CALM_AFTER_MS = 4000;                     // 4초 뒤 위아래 막대를 흐리게
const SAVE_EVERY_MS = 10000;

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatClock(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

export function formatDuration(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return '1분 미만';
  if (min < 60) return `${min}분`;
  return `${Math.floor(min / 60)}시간 ${min % 60}분`;
}

// 책 json의 pages 문자열 → 조각(unit) 목록
//   "# 제목"  : 작품 제목
//   "> 안내"  : 작은 안내 글씨(예: 첫머리 일부)
//   빈 줄     : 시는 연 나눔, 소설은 문단 나눔(소설은 줄마다 한 문단)
// 화면에 보이는 쪽은 이 조각들을 실제 쪽 크기에 맞춰 다시 채워 만든다.
export function parseUnits(text, format) {
  const units = [];
  let stanza = [];
  const flush = () => {
    if (stanza.length) units.push({ type: 'stanza', lines: stanza });
    stanza = [];
  };
  for (const raw of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (line.startsWith('# ')) { flush(); units.push({ type: 'h', text: line.slice(2).trim() }); continue; }
    if (line.startsWith('> ')) { flush(); units.push({ type: 'note', text: line.slice(2).trim() }); continue; }
    if (format === 'poem') stanza.push(line);
    else units.push({ type: 'para', text: line });
  }
  flush();
  return units;
}

export function unitsToHtml(units, format) {
  const html = units.map((u) => {
    if (u.type === 'h') return `<h3>${esc(u.text)}</h3>`;
    if (u.type === 'note') return `<p class="note">${esc(u.text)}</p>`;
    if (u.type === 'stanza') return `<p class="stanza${u.cont ? ' cont' : ''}">${u.lines.map((l) => `<span class="line">${esc(l)}</span>`).join('')}</p>`;
    return `<p${u.cont ? ' class="cont"' : ''}>${esc(u.text)}</p>`;
  }).join('');
  return `<div class="${format === 'poem' ? 'poem' : 'prose'}">${html}</div>`;
}

const isHeading = (u) => u.type === 'h' || u.type === 'note';

export class Reader {
  constructor(root, { onBack }) {
    this.root = root;
    this.onBack = onBack;
    const $ = (sel) => root.querySelector(sel);
    this.stage = $('#stage');
    this.bookEl = $('#book');
    this.titleEl = $('#reader-title');
    this.progressEl = $('#reader-progress');
    this.fillEl = $('#progress-fill');
    this.timerEl = $('#timer');
    this.timerNote = $('#timer-note');
    this.toast = $('#resume-toast');
    this.toastText = $('#resume-text');
    this.prevBtn = $('#btn-prev');
    this.nextBtn = $('#btn-next');
    this.fontDownBtn = $('#font-down');
    this.fontUpBtn = $('#font-up');

    this.book = null;
    this.pages = [];
    this.index = 0;
    this.spread = false;
    this.flip = null;
    this.drag = null;

    // 쪽 나누기용 보이지 않는 종이 한 장 (실제 쪽과 같은 크기·글자로 재어 본다)
    this.measure = document.createElement('div');
    this.measure.className = 'measure';
    this.measure.setAttribute('aria-hidden', 'true');
    this.measure.innerHTML = '<article class="page single"><div class="page-body"><div class="page-content"></div></div><p class="folio">0</p></article>';
    this.root.append(this.measure);
    this.measureBody = this.measure.querySelector('.page-body');
    this.measureContent = this.measure.querySelector('.page-content');

    this.onKey = this.onKey.bind(this);
    this.bind();
  }

  get isOpen() { return !!this.book; }

  bind() {
    this.root.querySelector('#btn-back').addEventListener('click', () => this.onBack());
    this.prevBtn.addEventListener('click', () => this.turn(-1));
    this.nextBtn.addEventListener('click', () => this.turn(1));
    this.fontDownBtn.addEventListener('click', () => this.changeFont(-1));
    this.fontUpBtn.addEventListener('click', () => this.changeFont(1));
    this.root.querySelector('#btn-restart').addEventListener('click', () => {
      this.hideToast();
      this.jumpTo(0);
      this.bookEl.focus({ preventScroll: true });
    });

    // 판권 면의 "처음부터 다시" / "서가로 돌아가기"
    this.bookEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-reader-action]');
      if (!btn) return;
      if (btn.dataset.readerAction === 'restart') this.jumpTo(0);
      if (btn.dataset.readerAction === 'back') this.onBack();
    });

    // 드래그 · 스와이프 · 클릭
    this.stage.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.stage.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.stage.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.stage.addEventListener('pointercancel', (e) => this.onPointerUp(e, true));

    new ResizeObserver(() => {
      if (!this.book) return;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.layout(), 120);
    }).observe(this.stage);

    for (const type of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) {
      this.root.addEventListener(type, () => this.wake(), { passive: true });
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushTime();
      else this.lastTick = Date.now();
    });
    window.addEventListener('pagehide', () => this.flushTime());
  }

  // ---------- 열기 / 닫기 ----------
  open(book) {
    this.book = book;
    this.units = book.pages.map((text) => parseUnits(text, book.format));
    this.pages = [];
    this.pageSize = null;
    const saved = store.getBookProgress(book.id);
    this.readMsAtOpen = saved.readMs;

    this.titleEl.textContent = book.title;
    this.root.hidden = false;
    document.body.classList.add('reading');
    this.applyFont();
    // 저장해 둔 "어느 작품의 어디쯤"(anchor)으로 위치를 찾는다. 쪽수는 화면·글자 크기마다 달라지기 때문.
    this.anchor = saved.anchor || null;
    this.layout(true, this.anchor);
    if (!this.anchor) {
      this.index = clamp(saved.page, 0, this.pages.length - 1);
      this.anchor = this.anchorOf(this.index);
    }
    this.render();
    this.startTimer();
    this.wake();
    window.addEventListener('keydown', this.onKey);

    if (this.index > 0) this.showToast(`지난번 읽던 ${this.index + 1}쪽부터 이어 읽어요.`);
    else this.hideToast();
    requestAnimationFrame(() => this.bookEl.focus({ preventScroll: true }));
  }

  close() {
    if (!this.book) return null;
    this.cancelFlip();
    this.drag = null;
    this.stopTimer();
    this.hideToast();
    clearTimeout(this.calmTimer);
    this.root.classList.remove('calm');
    window.removeEventListener('keydown', this.onKey);
    document.body.classList.remove('reading');
    this.root.hidden = true;
    this.bookEl.replaceChildren();
    const id = this.book.id;
    this.book = null;
    return id;
  }

  // ---------- 배치 ----------
  layout(force = false, anchor = undefined) {
    const rect = this.stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    if (this.drag?.flip || this.flip) {
      // 넘기는 중이면 끝난 뒤에 다시 잰다
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.layout(force, anchor), 200);
      return;
    }
    const spread = rect.width >= SPREAD_MIN_WIDTH && rect.width > rect.height * 1.15;
    let w;
    let h;
    if (spread) {
      // 한 면의 가로:세로 ≈ 0.71 (양면이면 1.42)
      h = Math.min(rect.height - 32, (rect.width - 120) / 1.42, 900);
      w = h * 1.42;
    } else {
      const narrow = rect.width < 600;
      w = Math.min(rect.width - (narrow ? 20 : 120), 600);
      h = Math.min(rect.height - (narrow ? 16 : 32), w * 1.75);
    }
    w = Math.round(w);
    h = Math.round(h);
    this.bookEl.style.width = `${w}px`;
    this.bookEl.style.height = `${h}px`;
    const pw = spread ? Math.floor(w / 2) : w;
    const sizeChanged = !this.pageSize || Math.abs(this.pageSize.w - pw) > 2 || Math.abs(this.pageSize.h - h) > 2;
    if (!force && !sizeChanged && spread === this.spread) return;

    // 다시 나눌 때는 사용자가 마지막으로 넘겨 온 지점을 기준으로 삼는다(바꿀 때마다 앞으로 밀리지 않게)
    const keep = anchor !== undefined ? anchor : (this.anchor || this.anchorOf(this.index));
    this.spread = spread;
    this.pageSize = { w: pw, h };
    this.paginate();
    if (keep) this.index = this.indexOfAnchor(keep);
    this.index = clamp(this.index, 0, this.pages.length - 1);
    if (anchor === undefined) this.render();
  }

  // ---------- 쪽 나누기 ----------
  // 작품 조각을 실제 쪽 크기에 맞춰 넘치지 않게 채운다. 한 쪽에 안 들어가는 연·문단은 줄·낱말 단위로 가른다.
  paginate() {
    const { w, h } = this.pageSize;
    this.measure.style.width = `${w}px`;
    this.measure.style.height = `${h}px`;
    const format = this.book.format;
    const fits = (list) => {
      this.measureContent.innerHTML = unitsToHtml(list, format);
      return this.measureBody.scrollHeight <= this.measureBody.clientHeight + 1;
    };

    const pages = [{ kind: 'title' }];
    this.units.forEach((units, src) => {
      const queue = units.map((unit, u) => ({ unit, u, part: 0 }));
      let cur = [];
      const push = () => {
        if (!cur.length) return;
        pages.push({ kind: 'text', src, u: cur[0].u, part: cur[0].part, units: cur.map((c) => c.unit) });
        cur = [];
      };
      while (queue.length) {
        const item = queue.shift();
        if (fits([...cur.map((c) => c.unit), item.unit])) { cur.push(item); continue; }
        // 제목이 쪽 끝에 홀로 남지 않게 다음 쪽으로 같이 넘긴다
        let trailing = 0;
        while (trailing < cur.length && isHeading(cur[cur.length - 1 - trailing].unit)) trailing++;
        if (cur.length > trailing) {
          const moved = cur.splice(cur.length - trailing, trailing);
          push();
          queue.unshift(...moved, item);
          continue;
        }
        // 이 쪽에 제목만 있거나 비어 있으면 조각을 갈라서 채운다
        const [head, tail] = this.splitUnit(item.unit, cur.map((c) => c.unit), fits);
        cur.push({ ...item, unit: head });
        push();
        if (tail) queue.unshift({ unit: tail, u: item.u, part: item.part + 1 });
      }
      push();
    });
    pages.push({ kind: 'colophon' });
    this.pages = pages;
  }

  splitUnit(unit, before, fits) {
    const tryParts = (pieces, make) => {
      // 들어가는 가장 긴 앞부분을 이분 탐색으로 찾는다 (최소 1개는 넣어 무한 반복을 막는다)
      let lo = 1;
      let hi = pieces.length - 1;
      let best = 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (fits([...before, make(pieces.slice(0, mid), false)])) { best = mid; lo = mid + 1; } else hi = mid - 1;
      }
      const rest = pieces.slice(best);
      return [make(pieces.slice(0, best), false), rest.length ? make(rest, true) : null];
    };
    if (unit.type === 'stanza' && unit.lines.length > 1) {
      return tryParts(unit.lines, (lines) => ({ type: 'stanza', lines }));
    }
    if (unit.type === 'stanza' && unit.lines[0].includes(' ')) {
      // 한 줄이 한 쪽보다 긴 시행은 낱말 단위로 갈라 다음 쪽에 잇는다
      return tryParts(unit.lines[0].split(' '), (ws, isTail) => ({ type: 'stanza', lines: [ws.join(' ')], cont: unit.cont || isTail }));
    }
    if (unit.type === 'para') {
      const words = unit.text.split(' ');
      if (words.length > 1) {
        return tryParts(words, (ws, isTail) => ({ type: 'para', text: ws.join(' '), cont: unit.cont || isTail }));
      }
    }
    return [unit, null];   // 더 가를 수 없으면 그대로 두고 쪽 안에서 스크롤
  }

  // 위치 표시: [작품 번호, 조각 번호, 갈라진 조각의 몇 번째]
  anchorOf(i) {
    const p = this.pages[i];
    if (!p) return null;
    if (p.kind === 'title') return [-1, 0, 0];
    if (p.kind === 'colophon') return [this.units.length, 0, 0];
    return [p.src, p.u, p.part];
  }

  indexOfAnchor(anchor) {
    const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    let found = 0;
    this.pages.forEach((_, i) => {
      if (cmp(this.anchorOf(i), anchor) <= 0) found = i;
    });
    return found;
  }

  spreadOf(i) { return Math.floor((i + 1) / 2); }
  lastSpread() { return Math.floor(this.pages.length / 2); }

  render() {
    this.bookEl.classList.toggle('spread', this.spread);
    if (this.spread) {
      const s = this.spreadOf(this.index);
      this.leftSlot = this.makeSlot('left', this.renderPage(2 * s - 1));
      this.rightSlot = this.makeSlot('right', this.renderPage(2 * s));
      this.bookEl.replaceChildren(this.leftSlot, this.rightSlot);
    } else {
      this.singleSlot = this.makeSlot('single', this.renderPage(this.index));
      this.bookEl.replaceChildren(this.singleSlot);
    }
    this.updateHud();
  }

  makeSlot(side, pageEl) {
    const slot = document.createElement('div');
    slot.className = `slot ${side}`;
    slot.append(pageEl);
    return slot;
  }

  sideOf(i) {
    if (!this.spread) return 'single';
    return i % 2 === 0 ? 'right' : 'left';   // -1(안쪽 표지)도 왼쪽
  }

  renderPage(i, sideOverride) {
    const el = document.createElement('article');
    el.className = `page ${sideOverride || this.sideOf(i)}`;
    const p = this.pages[i];
    if (!p) {
      el.classList.add('blank');
      el.setAttribute('aria-hidden', 'true');
      if (i === -1) el.innerHTML = '<p class="stamp">BBOOKS · 원미동</p>';
      return el;
    }
    const body = document.createElement('div');
    body.className = 'page-body';
    const content = document.createElement('div');
    content.className = 'page-content';
    content.innerHTML = this.pageHtml(p);
    body.append(content);
    const folio = document.createElement('p');
    folio.className = 'folio';
    folio.setAttribute('aria-hidden', 'true');
    folio.textContent = String(i + 1);
    el.append(body, folio);
    return el;
  }

  pageHtml(p) {
    const b = this.book;
    if (p.kind === 'title') {
      const read = this.readMsAtOpen > 0 ? `<p class="tp-read">이 책을 읽은 시간 ${formatDuration(this.readMsAtOpen)}</p>` : '';
      return `
        <div class="title-page">
          <p class="tp-shop">비북스 서가</p>
          <h1 class="tp-title">${esc(b.title)}</h1>
          <hr class="tp-rule">
          <p class="tp-author">${esc(b.author)}</p>
          ${b.year ? `<p class="tp-year">${esc(b.year)}</p>` : ''}
          ${b.intro ? `<p class="tp-desc">${esc(b.intro)}</p>` : ''}
          ${read}
          <p class="tp-hint">넘기기: 화살표 키 · 스와이프 · 클릭</p>
        </div>`;
    }
    if (p.kind === 'colophon') {
      const s = b.source || {};
      const rows = [
        ['원전', s.original],
        ['수록', s.works],
        ['본문', s.text],
        ['저작권', s.copyright],
      ].filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
      return `
        <div class="colophon">
          <p class="end-mark">${b.excerpt ? '발췌 끝' : '끝'}</p>
          <h3>출처</h3>
          <dl>${rows}</dl>
          ${s.verified ? '' : '<p class="unverified">※ 원문과 한 번 더 대조하고 있는 판본입니다.</p>'}
          <div class="colophon-actions">
            <button type="button" class="pill" data-reader-action="restart">처음부터 다시</button>
            <button type="button" class="pill" data-reader-action="back">서가로 돌아가기</button>
          </div>
          <p class="shop-sign">비북스 · 부천 원미동</p>
        </div>`;
    }
    return unitsToHtml(p.units, b.format);
  }

  updateHud() {
    const n = this.pages.length;
    let first;
    let last;
    if (this.spread) {
      const s = this.spreadOf(this.index);
      first = Math.max(0, 2 * s - 1);
      last = Math.min(n - 1, 2 * s);
      this.prevBtn.disabled = s <= 0;
      this.nextBtn.disabled = s >= this.lastSpread();
    } else {
      first = last = this.index;
      this.prevBtn.disabled = this.index <= 0;
      this.nextBtn.disabled = this.index >= n - 1;
    }
    this.progressEl.textContent = first === last ? `${first + 1} / ${n}쪽` : `${first + 1}–${last + 1} / ${n}쪽`;
    this.fillEl.style.width = `${((last + 1) / n) * 100}%`;
  }

  afterPageChange(byReader = true) {
    if (byReader) this.anchor = this.anchorOf(this.index);
    this.updateHud();
    store.saveBookPage(this.book.id, this.index, this.pages.length, this.anchor);
    if (this.index === 0) this.hideToast();
  }

  // ---------- 페이지 넘김 ----------
  // 넘어가는 종이(flipper)를 만들고, 그 아래에는 다음 장면을 미리 깔아 둔다.
  beginFlip(dir) {
    const n = this.pages.length;
    const el = document.createElement('div');
    el.setAttribute('aria-hidden', 'true');
    const face = (cls, page) => {
      const f = document.createElement('div');
      f.className = `face ${cls}`;
      f.append(page);
      return f;
    };
    let flip;

    if (this.spread) {
      const s = this.spreadOf(this.index);
      const t = s + dir;
      if (t < 0 || t > this.lastSpread()) return null;
      if (dir > 0) {
        el.className = 'flipper right';
        el.append(face('front', this.renderPage(2 * s)), face('back', this.renderPage(2 * t - 1)));
        this.rightSlot.replaceChildren(this.renderPage(2 * t));
      } else {
        el.className = 'flipper left';
        el.append(face('front', this.renderPage(2 * s - 1)), face('back', this.renderPage(2 * t)));
        this.leftSlot.replaceChildren(this.renderPage(2 * t - 1));
      }
      flip = {
        dir,
        angle: (p) => (dir > 0 ? -180 * p : 180 * p),
        commit: () => {
          if (dir > 0) this.leftSlot.replaceChildren(this.renderPage(2 * t - 1));
          else this.rightSlot.replaceChildren(this.renderPage(2 * t));
          this.index = Math.max(0, 2 * t - 1);
        },
        revert: () => {
          if (dir > 0) this.rightSlot.replaceChildren(this.renderPage(2 * s));
          else this.leftSlot.replaceChildren(this.renderPage(2 * s - 1));
        },
      };
    } else {
      const i = this.index;
      const t = i + dir;
      if (t < 0 || t >= n) return null;
      el.className = 'flipper single';
      const blank = this.renderPage(-2, 'single');
      if (dir > 0) {
        // 지금 장이 왼쪽으로 넘어가며 아래에 다음 장이 드러난다
        el.append(face('front', this.renderPage(i)), face('back', blank));
        this.singleSlot.replaceChildren(this.renderPage(t));
      } else {
        // 앞 장이 왼쪽에서 되돌아와 지금 장을 덮는다
        el.append(face('front', this.renderPage(t)), face('back', blank));
      }
      flip = {
        dir,
        angle: (p) => (dir > 0 ? -180 * p : -180 * (1 - p)),
        commit: () => {
          if (dir < 0) this.singleSlot.replaceChildren(this.renderPage(t));
          this.index = t;
        },
        revert: () => {
          if (dir > 0) this.singleSlot.replaceChildren(this.renderPage(i));
        },
      };
    }

    flip.el = el;
    flip.p = 0;
    this.bookEl.append(el);
    this.flip = flip;
    this.setFlip(flip, 0);
    return flip;
  }

  setFlip(flip, p) {
    flip.p = p;
    const a = flip.angle(p);
    flip.el.style.transform = `rotateY(${a}deg)`;
    // 종이가 세워질수록(90°에 가까울수록) 그늘이 진다
    flip.el.style.setProperty('--shade', (Math.sin((Math.abs(a) * Math.PI) / 180) * 0.6).toFixed(3));
  }

  animateFlip(flip, to, ease = easeInOut) {
    return new Promise((resolve) => {
      const from = flip.p;
      const duration = FLIP_MS * Math.abs(to - from);
      if (reduceMotion.matches || duration < 16) { this.setFlip(flip, to); resolve(); return; }
      const start = performance.now();
      const step = (now) => {
        if (this.flip !== flip) { resolve(); return; }
        const t = Math.min(1, (now - start) / duration);
        this.setFlip(flip, from + (to - from) * ease(t));
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  endFlip(flip, complete) {
    if (this.flip !== flip) return;
    flip.el.remove();
    if (complete) flip.commit();
    else flip.revert();
    this.flip = null;
    if (complete) this.afterPageChange();
  }

  cancelFlip() {
    if (!this.flip) return;
    this.flip.el.remove();
    this.flip.revert();
    this.flip = null;
  }

  async turn(dir) {
    if (!this.book || this.flip) return;
    const flip = this.beginFlip(dir);
    if (!flip) { this.bump(dir); return; }
    await this.animateFlip(flip, 1);
    this.endFlip(flip, true);
  }

  jumpTo(i) {
    this.cancelFlip();
    this.index = clamp(i, 0, this.pages.length - 1);
    this.render();
    this.afterPageChange();
  }

  bump(dir) {
    if (reduceMotion.matches) return;
    const cls = dir > 0 ? 'bump-next' : 'bump-prev';
    this.bookEl.classList.remove('bump-next', 'bump-prev');
    void this.bookEl.offsetWidth;
    this.bookEl.classList.add(cls);
    setTimeout(() => this.bookEl.classList.remove(cls), 400);
  }

  // ---------- 입력 ----------
  onKey(e) {
    if (!this.book || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    switch (e.key) {
      case 'ArrowRight':
      case 'PageDown':
        this.turn(1);
        break;
      case 'ArrowLeft':
      case 'PageUp':
        this.turn(-1);
        break;
      case ' ':
        if (e.target.closest('button')) return;
        this.turn(e.shiftKey ? -1 : 1);
        break;
      case 'Home':
        this.jumpTo(0);
        break;
      case 'End':
        this.jumpTo(this.pages.length - 1);
        break;
      case 'Escape':
        this.onBack();
        break;
      case '+':
      case '=':
        this.changeFont(1);
        break;
      case '-':
        this.changeFont(-1);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  onPointerDown(e) {
    if (!this.book || this.flip) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('button, a, .toast')) return;
    this.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), lastX: e.clientX, lastT: performance.now(), vx: 0, started: false, flip: null };
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.started) {
      if (Math.abs(dx) < 10) return;
      if (Math.abs(dy) > Math.abs(dx)) { this.drag = null; return; }   // 세로 스크롤은 브라우저에 맡긴다
      d.started = true;
      this.stage.classList.add('dragging');
      window.getSelection()?.removeAllRanges();
      try { this.stage.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
      d.flip = this.beginFlip(dx < 0 ? 1 : -1);
      if (!d.flip) this.bump(dx < 0 ? 1 : -1);
    }
    if (!d.flip) return;
    const now = performance.now();
    d.vx = (e.clientX - d.lastX) / Math.max(1, now - d.lastT);
    d.lastX = e.clientX;
    d.lastT = now;
    const width = this.spread ? this.bookEl.offsetWidth / 2 : this.bookEl.offsetWidth;
    const pull = d.flip.dir > 0 ? -dx : dx;
    this.setFlip(d.flip, clamp(pull / (width * 0.9), 0, 1));
  }

  async onPointerUp(e, cancelled = false) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    this.stage.classList.remove('dragging');

    if (!d.started) {
      if (cancelled) return;
      const moved = Math.hypot(e.clientX - d.x0, e.clientY - d.y0);
      const selected = String(window.getSelection() || '').length > 0;
      if (moved < 8 && performance.now() - d.t0 < 600 && !selected) this.tapAt(e.clientX);
      return;
    }
    const flip = d.flip;
    if (!flip) return;
    const fast = flip.dir > 0 ? d.vx < -0.45 : d.vx > 0.45;
    const complete = !cancelled && (flip.p > 0.35 || (fast && flip.p > 0.04));
    await this.animateFlip(flip, complete ? 1 : 0, easeOut);
    this.endFlip(flip, complete);
  }

  tapAt(x) {
    const r = this.bookEl.getBoundingClientRect();
    const boundary = this.spread ? r.left + r.width / 2 : r.left + r.width * 0.33;
    this.turn(x < boundary ? -1 : 1);
  }

  // ---------- 글자 크기 ----------
  applyFont() {
    const step = clamp(store.getSettings().fontStep ?? 2, 0, FONT_STEPS.length - 1);
    this.root.style.setProperty('--fs', `${FONT_STEPS[step]}px`);
    this.fontDownBtn.disabled = step <= 0;
    this.fontUpBtn.disabled = step >= FONT_STEPS.length - 1;
    return step;
  }

  changeFont(delta) {
    const step = clamp((store.getSettings().fontStep ?? 2) + delta, 0, FONT_STEPS.length - 1);
    store.saveSettings({ fontStep: step });
    this.applyFont();
    if (this.book) {
      this.cancelFlip();
      this.layout(true);
      this.afterPageChange(false);
    }
  }

  // ---------- 오늘 읽은 시간 ----------
  startTimer() {
    this.stopTimer();
    this.lastTick = Date.now();
    this.lastActive = Date.now();
    this.pendingMs = 0;
    this.sinceSave = 0;
    this.renderTimer();
    this.timerId = setInterval(() => this.tick(), 1000);
  }

  stopTimer() {
    clearInterval(this.timerId);
    this.timerId = null;
    this.flushTime();
  }

  tick() {
    const now = Date.now();
    let delta = now - this.lastTick;
    this.lastTick = now;
    const idle = now - this.lastActive > IDLE_LIMIT_MS;
    if (document.visibilityState !== 'visible' || idle) delta = 0;
    delta = Math.min(delta, 2000);   // 잠자기에서 깨어날 때 시간이 튀지 않게
    this.pendingMs += delta;
    this.sinceSave += delta;
    if (this.sinceSave >= SAVE_EVERY_MS) this.flushTime();
    this.renderTimer(idle);
  }

  flushTime() {
    if (!this.book || !(this.pendingMs > 0)) return;
    store.addReadingTime(this.book.id, this.pendingMs);
    this.pendingMs = 0;
    this.sinceSave = 0;
  }

  renderTimer(idle = false) {
    const ms = store.getTodayMs() + (this.pendingMs || 0);
    this.timerEl.textContent = formatClock(ms);
    this.timerEl.setAttribute('datetime', `PT${Math.floor(ms / 1000)}S`);
    this.timerNote.textContent = idle ? '· 쉬는 중' : '';
  }

  wake() {
    if (!this.book) return;
    this.lastActive = Date.now();
    this.root.classList.remove('calm');
    clearTimeout(this.calmTimer);
    this.calmTimer = setTimeout(() => this.root.classList.add('calm'), CALM_AFTER_MS);
  }

  // ---------- 이어 읽기 안내 ----------
  showToast(text) {
    this.toastText.textContent = text;
    this.toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.hideToast(), 7000);
  }

  hideToast() {
    clearTimeout(this.toastTimer);
    this.toast.hidden = true;
  }
}
