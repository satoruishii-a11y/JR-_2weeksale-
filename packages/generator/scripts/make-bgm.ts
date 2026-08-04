/**
 * デモ用 BGM を合成する。
 *
 * 元の実装は sine を4本足しただけの持続音で、これが仕上がりの安っぽさに
 * 相当効いていた。撥弦（Karplus-Strong）で箏に近い音を作り、
 * 低音のパッド・柔らかい打点・残響を重ねて「曲」の体裁にする。
 *
 * 本番はライセンス音源（Artlist / Epidemic Sound など）に差し替える前提で、
 * project.json の bgm がそのファイルを指すだけで済む。
 * 音量はテンプレートの audio.targetLufs で正規化されるので、
 * 音源が変わっても仕上がりのラウドネスは揃う。
 *
 *   npx tsx scripts/make-bgm.ts <出力先.mp3>
 */
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { runFfmpeg } from '../src/ffmpeg.js';

const SR = 48_000;
const BPM = 80;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const BARS = 8;
const DURATION = BAR * BARS; // 24 秒

/** 固定シード。毎回同じ音が出るようにする（生成物の再現性を保つ） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20261130);

/* ------------------------------------------------------------------ *
 * 音源
 * ------------------------------------------------------------------ */

/**
 * 撥弦の物理モデル（Karplus-Strong）。
 * 弦の長さぶんのノイズを巡回させながら平均を取ると、
 * 高い成分から先に減衰して撥弦らしい音色になる。
 */
function pluck(buffer: Float32Array, startSample: number, freq: number, seconds: number, amp: number): void {
  const period = Math.max(2, Math.round(SR / freq));
  const ring = new Float32Array(period);
  for (let i = 0; i < period; i++) ring[i] = rand() * 2 - 1;

  const length = Math.min(Math.round(seconds * SR), buffer.length - startSample);
  if (length <= 0) return;

  // 弦の減衰。高い音ほど早く減るよう周波数で調整する
  const damping = 0.9965 - Math.min(0.004, freq / 400_000);
  let index = 0;

  for (let i = 0; i < length; i++) {
    const current = ring[index]!;
    ring[index] = 0.5 * (current + ring[(index + 1) % period]!) * damping;
    index = (index + 1) % period;

    // 撥いた瞬間の立ち上がりと全体のリリース
    const attack = Math.min(1, i / (SR * 0.004));
    const release = Math.exp((-i / SR) * 1.5);
    buffer[startSample + i]! += current * amp * attack * release;
  }
}

/** 低音のパッド。根音と5度を重ね、わずかにデチューンして厚みを出す */
function pad(buffer: Float32Array, startSample: number, freq: number, seconds: number, amp: number): void {
  const length = Math.min(Math.round(seconds * SR), buffer.length - startSample);
  let lowpass = 0;

  for (let i = 0; i < length; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.6) * Math.min(1, (seconds - t) / 0.8);
    const tremolo = 0.86 + 0.14 * Math.sin(2 * Math.PI * 0.22 * t);

    const raw =
      Math.sin(2 * Math.PI * freq * t) * 0.6 +
      Math.sin(2 * Math.PI * freq * 1.003 * t) * 0.4 +
      Math.sin(2 * Math.PI * freq * 1.5 * t) * 0.22 +
      Math.sin(2 * Math.PI * freq * 2 * t) * 0.1;

    // 一次ローパスで角を落とす
    lowpass += (raw - lowpass) * 0.06;
    buffer[startSample + i]! += lowpass * amp * env * tremolo;
  }
}

/** 柔らかい打点。低いサインの減衰にノイズを少量混ぜる */
function thud(buffer: Float32Array, startSample: number, amp: number): void {
  const length = Math.min(Math.round(0.35 * SR), buffer.length - startSample);
  for (let i = 0; i < length; i++) {
    const t = i / SR;
    const env = Math.exp(-t * 16);
    const body = Math.sin(2 * Math.PI * 58 * t * (1 - t * 0.4));
    const air = (rand() * 2 - 1) * Math.exp(-t * 90) * 0.18;
    buffer[startSample + i]! += (body + air) * amp * env;
  }
}

/* ------------------------------------------------------------------ *
 * 残響
 * ------------------------------------------------------------------ */

function comb(input: Float32Array, delaySamples: number, feedback: number, damp: number): Float32Array {
  const out = new Float32Array(input.length);
  const buf = new Float32Array(delaySamples);
  let index = 0;
  let store = 0;

  for (let i = 0; i < input.length; i++) {
    const delayed = buf[index]!;
    out[i] = delayed;
    store = delayed * (1 - damp) + store * damp;
    buf[index] = input[i]! + store * feedback;
    index = (index + 1) % delaySamples;
  }
  return out;
}

function allpass(input: Float32Array, delaySamples: number, gain: number): Float32Array {
  const out = new Float32Array(input.length);
  const buf = new Float32Array(delaySamples);
  let index = 0;

  for (let i = 0; i < input.length; i++) {
    const delayed = buf[index]!;
    out[i] = -input[i]! + delayed;
    buf[index] = input[i]! + delayed * gain;
    index = (index + 1) % delaySamples;
  }
  return out;
}

/** Freeverb を簡略化した残響。櫛形4本を並列に足し、全域通過2段で拡散させる */
function reverb(input: Float32Array, spread: number): Float32Array {
  const delays = [1557, 1617, 1491, 1422].map((d) => Math.round((d * SR) / 44_100) + spread);
  const wet = new Float32Array(input.length);

  for (const delay of delays) {
    const c = comb(input, delay, 0.79, 0.28);
    for (let i = 0; i < wet.length; i++) wet[i]! += c[i]! * 0.25;
  }

  // 全域通過を2段。1段目の戻り値で受けることで型が揃う
  let out = allpass(wet, Math.round((556 * SR) / 44_100) + spread, 0.5);
  out = allpass(out, Math.round((441 * SR) / 44_100) + spread, 0.5);
  return out;
}

/* ------------------------------------------------------------------ *
 * 編曲
 * ------------------------------------------------------------------ */

interface Chord {
  /** パッドが鳴らす根音 */
  root: number;
  /** 撥弦が使う和音構成音 */
  notes: number[];
}

// イ短調。2小節ずつ Am - F - C - G
const PROGRESSION: Chord[] = [
  { root: 110.0, notes: [220.0, 261.63, 329.63, 440.0] }, // Am
  { root: 87.31, notes: [174.61, 220.0, 261.63, 349.23] }, // F
  { root: 130.81, notes: [261.63, 329.63, 392.0, 523.25] }, // C
  { root: 98.0, notes: [196.0, 246.94, 293.66, 392.0] }, // G
];

/** 小節内で撥く位置（拍）と使う構成音の番号。少し隙間を作って間を持たせる */
const PATTERN: Array<{ beat: number; note: number; amp: number }> = [
  { beat: 0, note: 0, amp: 1.0 },
  { beat: 1.5, note: 2, amp: 0.72 },
  { beat: 2, note: 1, amp: 0.85 },
  { beat: 3.25, note: 3, amp: 0.6 },
];

function arrange(): Float32Array {
  const dry = new Float32Array(Math.round(DURATION * SR));

  for (let bar = 0; bar < BARS; bar++) {
    const chord = PROGRESSION[Math.floor(bar / 2) % PROGRESSION.length]!;
    const barStart = Math.round(bar * BAR * SR);

    // パッドは2小節伸ばす。小節の頭ごとに重ねると切れ目が目立つ
    if (bar % 2 === 0) {
      pad(dry, barStart, chord.root, BAR * 2, 0.5);
      pad(dry, barStart, chord.root * 1.5, BAR * 2, 0.22);
    }

    for (const hit of PATTERN) {
      // 最初の小節は撥弦を減らして静かに入る
      const gate = bar === 0 && hit.beat > 0 ? 0 : 1;
      if (gate === 0) continue;
      const at = barStart + Math.round(hit.beat * BEAT * SR);
      pluck(dry, at, chord.notes[hit.note]!, 2.6, 0.34 * hit.amp);
    }

    // 打点は1拍目と3拍目。冒頭2小節は入れずに音数を絞る
    if (bar >= 2) {
      thud(dry, barStart, 0.5);
      thud(dry, barStart + Math.round(2 * BEAT * SR), 0.34);
    }
  }

  return dry;
}

/* ------------------------------------------------------------------ *
 * 書き出し
 * ------------------------------------------------------------------ */

function toWav(left: Float32Array, right: Float32Array): Buffer {
  const frames = left.length;
  const dataBytes = frames * 4; // 16bit × 2ch
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(2, 22); // stereo
  buffer.writeUInt32LE(SR, 24);
  buffer.writeUInt32LE(SR * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < frames; i++) {
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left[i]! * 32767))), 44 + i * 4);
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(right[i]! * 32767))), 46 + i * 4);
  }
  return buffer;
}

export async function writeBgmMp3(outFile: string): Promise<void> {
  const dry = arrange();
  const wetL = reverb(dry, 0);
  const wetR = reverb(dry, 23); // 左右で遅延をずらして広がりを作る

  const left = new Float32Array(dry.length);
  const right = new Float32Array(dry.length);
  const fadeIn = 1.5 * SR;
  const fadeOut = 3.5 * SR;

  for (let i = 0; i < dry.length; i++) {
    const envelope =
      Math.min(1, i / fadeIn) * Math.min(1, (dry.length - i) / fadeOut);
    // 残響を混ぜたあと、軽く飽和させて硬さを取る
    left[i] = Math.tanh((dry[i]! * 0.78 + wetL[i]! * 0.34) * 1.1) * 0.86 * envelope;
    right[i] = Math.tanh((dry[i]! * 0.78 + wetR[i]! * 0.34) * 1.1) * 0.86 * envelope;
  }

  const wavFile = outFile.replace(/\.mp3$/, '.wav');
  await writeFile(wavFile, toWav(left, right));
  await runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', wavFile,
    '-c:a', 'libmp3lame', '-b:a', '160k', '-ar', String(SR), '-ac', '2',
    outFile,
  ]);
  await unlink(wavFile);
}

async function main(): Promise<void> {
  const out = process.argv[2] ?? path.resolve('bgm.mp3');
  await writeBgmMp3(out);
  console.log(`BGM を生成しました: ${out}（${DURATION} 秒 / ${BPM} BPM）`);
}

if (process.argv[1] && process.argv[1].endsWith('make-bgm.ts')) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
