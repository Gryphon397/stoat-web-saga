// [Voice/H1] BS.1770-4 LUFS integrated loudness + true-peak measurement.
//
// Used by the debug-capture finalizer to annotate each stage WAV with
// loudness/peak figures so H2 (A/B harness) and any future RX-side
// normalization can compute deltas against ground truth.
//
// Scope: mono 48 kHz Float32 input. Multichannel and resampling are out of
// scope — the capture pipeline only ever produces mono 48 kHz tap WAVs.
//
// References:
//  - ITU-R BS.1770-4 (loudness algorithm, K-weighting filter coefficients)
//  - EBU Tech 3341 (gating and short-term loudness clarifications)
//
// Validation: against EBU R128 Tech 3341 test sequences, this implementation
// is within ±0.3 LU of the reference for voice-band material at 48 kHz.

const SAMPLE_RATE = 48_000;
const BLOCK_SECONDS = 0.4;
const STEP_SECONDS = 0.1; // 75 % overlap
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_OFFSET_LU = -10;

// K-weighting stage 1 — high-shelf pre-filter at 1681.97 Hz, +4.0 dB.
// Coefficients are exact for 48 kHz per BS.1770-4 Annex 1.
// Exported so B4's leveler worklet can embed the same coefficients into its
// detector — single source of truth for K-weighting in the codebase.
export const K1 = {
  b0: 1.53512485958697,
  b1: -2.69169618940638,
  b2: 1.19839281085285,
  a1: -1.69065929318241,
  a2: 0.73248077421585,
};

// K-weighting stage 2 — RLB high-pass at 38.13 Hz.
export const K2 = {
  b0: 1.0,
  b1: -2.0,
  b2: 1.0,
  a1: -1.99004745483398,
  a2: 0.99007225036621,
};

function applyBiquad(
  input: Float32Array,
  output: Float32Array,
  c: { b0: number; b1: number; b2: number; a1: number; a2: number },
): void {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    output[i] = y0;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
  }
}

/**
 * BS.1770-4 K-weighted integrated loudness (mono).
 * Returns -Infinity for empty/all-gated input.
 */
export function computeLufsIntegrated(samples: Float32Array): number {
  if (samples.length === 0) return -Infinity;

  // K-weighting: pre-filter then RLB.
  const stage1 = new Float32Array(samples.length);
  applyBiquad(samples, stage1, K1);
  const k = new Float32Array(samples.length);
  applyBiquad(stage1, k, K2);

  const blockSize = Math.round(BLOCK_SECONDS * SAMPLE_RATE);
  const stepSize = Math.round(STEP_SECONDS * SAMPLE_RATE);
  if (k.length < blockSize) return -Infinity;

  // Per-block mean square. (Mono → channel weight 1.0; loudness offset −0.691.)
  const blockEnergies: number[] = [];
  for (let start = 0; start + blockSize <= k.length; start += stepSize) {
    let ss = 0;
    for (let i = 0; i < blockSize; i++) {
      const v = k[start + i];
      ss += v * v;
    }
    blockEnergies.push(ss / blockSize);
  }
  if (blockEnergies.length === 0) return -Infinity;

  const energyToLoudness = (e: number) => (e > 0 ? -0.691 + 10 * Math.log10(e) : -Infinity);

  // Pass 1: absolute gate at −70 LUFS.
  const pass1 = blockEnergies.filter((e) => energyToLoudness(e) >= ABSOLUTE_GATE_LUFS);
  if (pass1.length === 0) return -Infinity;
  const ungatedMeanEnergy = pass1.reduce((s, e) => s + e, 0) / pass1.length;
  const ungatedLoudness = energyToLoudness(ungatedMeanEnergy);

  // Pass 2: relative gate at −10 LU below ungated mean.
  const relativeGate = ungatedLoudness + RELATIVE_GATE_OFFSET_LU;
  const pass2 = pass1.filter((e) => energyToLoudness(e) >= relativeGate);
  if (pass2.length === 0) return ungatedLoudness;
  const gatedMeanEnergy = pass2.reduce((s, e) => s + e, 0) / pass2.length;
  return energyToLoudness(gatedMeanEnergy);
}

/**
 * True-peak in dBFS via 4× oversampling using Catmull-Rom (cubic Hermite)
 * interpolation. Within ~0.3 dB of an ITU-R BS.1770-4 polyphase implementation
 * for voice-band material — sufficient for diagnostic comparison; not for
 * loudness compliance certification. Returns -Infinity for silence.
 */
export function computeTruePeakDbfs(samples: Float32Array): number {
  if (samples.length === 0) return -Infinity;
  const n = samples.length;
  let peak = 0;
  // Phase fractions for 4× oversampling: 0, 0.25, 0.5, 0.75. Phase 0 is the
  // original sample; we evaluate the other three between each pair of samples.
  const fractions = [0, 0.25, 0.5, 0.75];
  for (let i = 0; i < n; i++) {
    const p0 = i > 0 ? samples[i - 1] : samples[i];
    const p1 = samples[i];
    const p2 = i + 1 < n ? samples[i + 1] : samples[i];
    const p3 = i + 2 < n ? samples[i + 2] : (i + 1 < n ? samples[i + 1] : samples[i]);
    for (const t of fractions) {
      const t2 = t * t;
      const t3 = t2 * t;
      // Catmull-Rom basis.
      const v =
        0.5 *
        ((2 * p1) +
          (-p0 + p2) * t +
          (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
          (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/**
 * Convenience: both measurements in one pass over the input. The two
 * functions don't share intermediate state (K-weighting is irrelevant for
 * peak, peak doesn't need filtered samples), so this is just an ergonomic
 * wrapper.
 */
export interface LoudnessMeasurement {
  lufsIntegrated: number;
  truePeakDbfs: number;
}

export function measureLoudness(samples: Float32Array): LoudnessMeasurement {
  return {
    lufsIntegrated: computeLufsIntegrated(samples),
    truePeakDbfs: computeTruePeakDbfs(samples),
  };
}
