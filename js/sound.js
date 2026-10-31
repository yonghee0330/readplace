// 잔잔한 서점 소리: 창밖 빗소리 + 실내의 낮은 공기 소리
// 파일을 내려받지 않고 Web Audio로 그 자리에서 만든다. 기본은 꺼짐.

const VOLUME = 0.32;

let ctx = null;
let master = null;
let noiseBuf = null;
let dropTimer = null;
let suspendTimer = null;
let playing = false;

export const isSupported = () => !!(window.AudioContext || window.webkitAudioContext);
export const isPlaying = () => playing;

// 분홍 소음(빗줄기에 가까운 부드러운 쉬익 소리)
function pinkNoise(seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return buf;
}

// 갈색 소음(낮게 웅웅거리는 방 안 공기)
function brownNoise(seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    d[i] = last * 3.5;
  }
  return buf;
}

function filter(type, frequency, q) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  if (q) f.Q.value = q;
  return f;
}

function gain(value) {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

function build() {
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC();
  master = gain(0);
  master.connect(ctx.destination);
  noiseBuf = pinkNoise(4);

  // 1) 빗줄기
  const rain = ctx.createBufferSource();
  rain.buffer = noiseBuf;
  rain.loop = true;
  const rainGain = gain(0.55);
  rain.connect(filter('highpass', 500)).connect(filter('lowpass', 4200)).connect(rainGain).connect(master);

  // 2) 바람결처럼 아주 느리게 커졌다 작아지게
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.07;
  lfo.connect(gain(0.15)).connect(rainGain.gain);

  // 3) 방 안의 낮은 공기 소리
  const room = ctx.createBufferSource();
  room.buffer = brownNoise(5);
  room.loop = true;
  room.connect(filter('lowpass', 380)).connect(gain(0.5)).connect(master);

  rain.start();
  lfo.start();
  room.start();
}

// 처마에 떨어지는 빗방울: 짧은 소음 조각을 불규칙하게 톡톡
function drop() {
  if (!playing) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const env = ctx.createGain();
  const peak = 0.04 + Math.random() * 0.1;
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(peak, t + 0.004);
  env.gain.exponentialRampToValueAtTime(0.0001, t + 0.05 + Math.random() * 0.06);
  src.connect(filter('bandpass', 1800 + Math.random() * 4200, 2 + Math.random() * 4)).connect(env).connect(master);
  src.start(t, Math.random() * 3, 0.15);
  dropTimer = setTimeout(drop, 30 + Math.random() * 140);
}

export async function start() {
  if (!isSupported()) throw new Error('이 브라우저는 Web Audio를 지원하지 않습니다.');
  if (!ctx) build();
  clearTimeout(suspendTimer);
  await ctx.resume();
  playing = true;
  const t = ctx.currentTime;
  master.gain.cancelScheduledValues(t);
  master.gain.setValueAtTime(master.gain.value, t);
  master.gain.linearRampToValueAtTime(VOLUME, t + 2);
  clearTimeout(dropTimer);
  drop();
}

export function stop() {
  if (!ctx || !playing) return;
  playing = false;
  clearTimeout(dropTimer);
  const t = ctx.currentTime;
  master.gain.cancelScheduledValues(t);
  master.gain.setValueAtTime(master.gain.value, t);
  master.gain.linearRampToValueAtTime(0, t + 0.8);
  suspendTimer = setTimeout(() => ctx.suspend(), 1000);
}
