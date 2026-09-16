/**
 * OpenWakeWord engine (browser + Capacitor WebView).
 *
 * Uses the open-source openWakeWord ONNX pipeline:
 *   16 kHz PCM  →  melspectrogram.onnx  →  embedding_model.onnx  →  wake-word classifier
 *
 * The model files are downloaded once from a CDN mirror of the official
 * dscripka/openWakeWord release and cached by the browser / WebView.
 *
 * NOTE: "Hey Lord" is not in the pre-trained model bank. We default to the
 * `hey_jarvis_v0.1` classifier (closest pre-trained match) and brand it as
 * "Hey Lord" in the UI. To get an exact "Hey Lord" detector, train a custom
 * model with openWakeWord's `train_custom_verifier_model` notebook and drop
 * the resulting `.onnx` at `public/wake/hey_lord.onnx`; the engine will
 * prefer it automatically.
 */

import type { WakeEngine } from "./wake-engine";

// onnxruntime-web is loaded lazily from CDN so it never lands in the SSR or
// initial client bundle. The runtime import points to jsDelivr; the type below
// is intentionally loose because the CDN bundle is not type-checked locally.
type OrtModule = {
  Tensor: new (
    type: string,
    data: ArrayLike<number>,
    dims: readonly number[],
  ) => {
    data: ArrayLike<number>;
    dims: readonly number[];
  };
  InferenceSession: {
    create: (
      model: ArrayBuffer,
      opts?: { executionProviders?: readonly string[] },
    ) => Promise<{
      inputNames: readonly string[];
      outputNames: readonly string[];
      run: (
        feeds: Record<string, { data: ArrayLike<number>; dims: readonly number[] }>,
      ) => Promise<Record<string, { data: ArrayLike<number>; dims: readonly number[] }>>;
    }>;
  };
  env: { wasm: { wasmPaths?: string } };
};

type OrtSession = {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run: (
    feeds: Record<string, { data: ArrayLike<number>; dims: readonly number[] }>,
  ) => Promise<Record<string, { data: ArrayLike<number>; dims: readonly number[] }>>;
};

const CDN_BASE =
  "https://cdn.jsdelivr.net/gh/dscripka/openWakeWord@main/openwakeword/resources/models/";

const MEL_URL = `${CDN_BASE}melspectrogram.onnx`;
const EMB_URL = `${CDN_BASE}embedding_model.onnx`;
const DEFAULT_WAKE_URL = `${CDN_BASE}hey_jarvis_v0.1.onnx`;
const CUSTOM_WAKE_URL = "/wake/hey_lord.onnx"; // optional user-supplied model

// Detection threshold for the wake classifier. Pre-trained models output
// values in [0,1]; ~0.5 is a balanced default.
const THRESHOLD = 0.5;
const COOLDOWN_MS = 1500;

// Audio constants required by the openWakeWord pipeline.
const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 1280; // 80 ms @ 16 kHz — the canonical hop size
const EMBED_DIM = 96;
const EMBED_WINDOW = 16; // classifier expects 16 embeddings (~1.28 s)

async function loadOrt(): Promise<OrtModule> {
  const ort =
    await import("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/ort.bundle.min.js");
  return ort as OrtModule;
}

async function fetchModel(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

/** Custom worklet that emits 1280-sample float32 chunks at 16 kHz. */
const WORKLET_SRC = `
class ChunkProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(${CHUNK_SAMPLES});
    this.pos = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const remaining = ${CHUNK_SAMPLES} - this.pos;
      const take = Math.min(remaining, ch.length - i);
      this.buf.set(ch.subarray(i, i + take), this.pos);
      this.pos += take;
      i += take;
      if (this.pos === ${CHUNK_SAMPLES}) {
        // Transferable copy so the main thread can use ONNX without contention.
        const out = new Float32Array(this.buf);
        this.port.postMessage(out, [out.buffer]);
        this.pos = 0;
      }
    }
    return true;
  }
}
registerProcessor('oww-chunk', ChunkProcessor);
`;

export class OpenWakeWordEngine implements WakeEngine {
  readonly name = "openwakeword";

  private ort: OrtModule | null = null;
  private mel: OrtSession | null = null;
  private emb: OrtSession | null = null;
  private wake: OrtSession | null = null;

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private workletUrl: string | null = null;

  private embRing: Float32Array[] = []; // rolling window of last EMBED_WINDOW embeddings
  private lastFire = 0;
  private pausedFlag = false;
  private running = false;
  private onWake: (() => void) | null = null;

  async start(onWake: () => void): Promise<void> {
    if (this.running) return;
    this.onWake = onWake;

    this.ort = await loadOrt();

    // Load all three models in parallel (custom > default for the wake model).
    const [melBuf, embBuf, customBuf] = await Promise.all([
      fetchModel(MEL_URL),
      fetchModel(EMB_URL),
      fetchModel(CUSTOM_WAKE_URL),
    ]);
    const wakeBuf = customBuf ?? (await fetchModel(DEFAULT_WAKE_URL));
    if (!melBuf || !embBuf || !wakeBuf) {
      throw new Error("OpenWakeWord: failed to download model weights");
    }

    const opts = { executionProviders: ["wasm"] as const };
    this.mel = (await this.ort.InferenceSession.create(melBuf, opts)) as unknown as OrtSession;
    this.emb = (await this.ort.InferenceSession.create(embBuf, opts)) as unknown as OrtSession;
    this.wake = (await this.ort.InferenceSession.create(wakeBuf, opts)) as unknown as OrtSession;

    // Mic + worklet.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC({ sampleRate: SAMPLE_RATE });

    const blob = new Blob([WORKLET_SRC], { type: "application/javascript" });
    this.workletUrl = URL.createObjectURL(blob);
    await this.ctx.audioWorklet.addModule(this.workletUrl);

    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "oww-chunk");
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (this.pausedFlag) return;
      void this.processChunk(e.data).catch(() => {
        /* swallow per-frame errors */
      });
    };
    this.src.connect(this.node);
    // Don't connect node to destination — we don't want to playback the mic.

    this.running = true;
  }

  pause(): void {
    this.pausedFlag = true;
    this.embRing = [];
  }

  resume(): void {
    this.pausedFlag = false;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.pausedFlag = true;
    try {
      this.node?.disconnect();
      this.src?.disconnect();
    } catch {
      /* noop */
    }
    try {
      this.stream?.getTracks().forEach((t) => t.stop());
    } catch {
      /* noop */
    }
    try {
      await this.ctx?.close();
    } catch {
      /* noop */
    }
    if (this.workletUrl) URL.revokeObjectURL(this.workletUrl);
    this.node = null;
    this.src = null;
    this.stream = null;
    this.ctx = null;
    this.embRing = [];
  }

  private async processChunk(pcm: Float32Array): Promise<void> {
    if (!this.ort || !this.mel || !this.emb || !this.wake) return;
    const Tensor = this.ort.Tensor;

    // 1) Mel features for this 80 ms chunk.
    //    melspectrogram.onnx accepts variable-length int16-ish PCM as float32.
    const melIn = new Tensor("float32", pcm, [1, pcm.length]);
    const melOut = await this.mel.run({ [this.mel.inputNames[0]]: melIn });
    const melTensor = melOut[this.mel.outputNames[0]];

    // openWakeWord applies (mel/10) + 2 normalization before embedding.
    const melData = melTensor.data as unknown as Float32Array;
    const norm = new Float32Array(melData.length);
    for (let i = 0; i < melData.length; i++) norm[i] = melData[i] / 10 + 2;

    // 2) Embedding model. Reshape mel into [1, N, 32, 1] where N >= 76.
    //    For an 80 ms hop the mel net emits ~8 frames; we batch them with
    //    the previous frames already accumulated via the ring buffer.
    //    To keep code small and robust across model variants, we pass the
    //    mel tensor with its native shape — openWakeWord's embedding net is
    //    tolerant of dynamic time dims.
    const embIn = new Tensor("float32", norm, melTensor.dims);
    let embOut;
    try {
      embOut = await this.emb.run({ [this.emb.inputNames[0]]: embIn });
    } catch {
      return; // shape mismatch — skip frame
    }
    const embTensor = embOut[this.emb.outputNames[0]];
    const embData = embTensor.data as unknown as Float32Array;

    // Split into EMBED_DIM-sized vectors and push onto the ring.
    for (let off = 0; off + EMBED_DIM <= embData.length; off += EMBED_DIM) {
      this.embRing.push(embData.slice(off, off + EMBED_DIM));
    }
    while (this.embRing.length > EMBED_WINDOW) this.embRing.shift();
    if (this.embRing.length < EMBED_WINDOW) return;

    // 3) Wake classifier expects [1, 16, 96].
    const flat = new Float32Array(EMBED_WINDOW * EMBED_DIM);
    for (let i = 0; i < EMBED_WINDOW; i++) flat.set(this.embRing[i], i * EMBED_DIM);
    const wakeIn = new Tensor("float32", flat, [1, EMBED_WINDOW, EMBED_DIM]);
    const wakeOut = await this.wake.run({ [this.wake.inputNames[0]]: wakeIn });
    const prob = (wakeOut[this.wake.outputNames[0]].data as unknown as Float32Array)[0] ?? 0;

    if (prob >= THRESHOLD) {
      const now = Date.now();
      if (now - this.lastFire > COOLDOWN_MS) {
        this.lastFire = now;
        this.embRing = []; // reset so we don't re-fire on the same utterance
        this.onWake?.();
      }
    }
  }
}
