// 읽은 기록 저장소 (localStorage)
// 이 기기의 브라우저 안에만 저장한다. 서버로 보내는 것은 없다.
//
// 저장 모양:
// {
//   books:    { [책 id]: { page, total, readMs, finished, updatedAt } },
//   today:    { date: "2026-10-31", ms },          // 오늘 읽은 시간(모든 책 합계)
//   settings: { fontStep, theme }
// }

const KEY = 'bbooks.reading.v1';

function todayKey(d = new Date()) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function defaults() {
  return {
    books: {},
    today: { date: todayKey(), ms: 0 },
    settings: { fontStep: 2, theme: null },
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const saved = JSON.parse(raw);
    const base = defaults();
    return {
      books: saved.books && typeof saved.books === 'object' ? saved.books : {},
      today: saved.today && typeof saved.today.ms === 'number' ? saved.today : base.today,
      settings: { ...base.settings, ...(saved.settings || {}) },
    };
  } catch {
    // 저장소를 못 쓰는 환경(사생활 보호 모드 등)이거나 값이 깨졌을 때
    return defaults();
  }
}

let state = load();

// 다른 탭에서 바꾼 값을 덮어쓰지 않도록, 쓸 때마다 새로 읽고 고친 뒤 저장한다.
function update(fn) {
  state = load();
  fn(state);
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // 저장 공간이 없거나 막혀 있으면 이번 방문 동안만 메모리에 둔다.
  }
}

function rollToday(s) {
  const key = todayKey();
  if (s.today.date !== key) s.today = { date: key, ms: 0 };
}

function bookEntry(s, id) {
  if (!s.books[id]) s.books[id] = { page: 0, total: 0, readMs: 0, finished: false, updatedAt: 0 };
  return s.books[id];
}

export function getBookProgress(id) {
  const b = state.books[id];
  return {
    touched: !!b,
    page: b?.page ?? 0,
    total: b?.total ?? 0,
    anchor: Array.isArray(b?.anchor) ? b.anchor : null,
    readMs: b?.readMs ?? 0,
    finished: !!b?.finished,
  };
}

// anchor: 화면 쪽수와 상관없이 "몇 번째 작품의 어디쯤"인지 (글자 크기·화면이 바뀌어도 같은 곳을 찾기 위해)
export function saveBookPage(id, page, total, anchor) {
  update((s) => {
    const b = bookEntry(s, id);
    b.page = page;
    b.total = total;
    if (anchor) b.anchor = anchor;
    b.updatedAt = Date.now();
    if (page >= total - 1) b.finished = true;
  });
}

export function addReadingTime(id, ms) {
  if (!(ms > 0)) return;
  update((s) => {
    const b = bookEntry(s, id);
    b.readMs += ms;
    rollToday(s);
    s.today.ms += ms;
  });
}

export function getTodayMs() {
  return state.today.date === todayKey() ? state.today.ms : 0;
}

export function getSettings() {
  return { ...state.settings };
}

export function saveSettings(patch) {
  update((s) => Object.assign(s.settings, patch));
}
