// data.js — the preset sets and the fixed copy. Every runtime number in the
// app is measured live; what lives here is only what a card needs to SAY
// before anything has run.

export const REPO = 'https://github.com/arrival-space/splat.js';
export const DATA = '../data/';

export const PRESETS = [
  {
    id: 'truck', name: 'Truck',
    kind: 'Standard test set',
    origin: '42 photos of the Truck sequence from the Tanks & Temples reconstruction benchmark.',
    links: [
      { label: 'Tanks & Temples', url: 'https://www.tanksandtemples.org/' },
      { label: 'image set', url: 'https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/' },
    ],
    dir: 'truck', pattern: '{i:6}.jpg', start: 1, count: 42,
    blurb: 'A parked truck, circled once on foot. Even spacing, constant light, ' +
           'plenty of sideways movement — close to a textbook capture.',
    approx: '~6 min',
  },
  {
    id: 'truck-full', name: 'Truck · all',
    kind: 'Standard test set — complete',
    origin: 'All 251 photos of the Tanks & Temples Truck sequence — the complete benchmark set, nothing skipped.',
    links: [
      { label: 'Tanks & Temples', url: 'https://www.tanksandtemples.org/' },
      { label: 'image set', url: 'https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/' },
    ],
    dir: 'truck', pattern: '{i:6}.jpg', start: 1, count: 251,
    blurb: 'The same walk at full density. Six times the photos of the small set — ' +
           'and pair matching grows with the square of the count, so bring patience.',
    approx: '~40 min',
  },
  {
    id: 'camping', name: 'Camping',
    kind: 'Handheld phone video',
    origin: '113 frames pulled from a phone video. Not a benchmark — an ordinary capture, with everything that goes wrong in one.',
    links: [],
    dir: 'camping', pattern: 'frame_{i:5}.jpg', start: 1, count: 113,
    blurb: 'Every frame of a walking video. Neighbouring frames barely differ, so the ' +
           'solver has to chain landmarks across dozens of them.',
    approx: '~8 min',
  },
  {
    id: 'train', name: 'Train',
    kind: 'Standard test set',
    origin: '84 photos of the Train sequence from the Tanks & Temples reconstruction benchmark.',
    links: [
      { label: 'Tanks & Temples', url: 'https://www.tanksandtemples.org/' },
      { label: 'image set', url: 'https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/' },
    ],
    dir: 'train', pattern: '{i:5}.jpg', start: 1, count: 84,
    blurb: 'More photos of a harder subject: dark paint, repeating windows, and a seam ' +
           'where the shoot was interrupted and picked up again.',
    approx: '~10 min',
  },
  {
    id: 'train-full', name: 'Train · all',
    kind: 'Standard test set — complete',
    origin: 'All 301 photos of the Tanks & Temples Train sequence — the complete benchmark set.',
    links: [
      { label: 'Tanks & Temples', url: 'https://www.tanksandtemples.org/' },
      { label: 'image set', url: 'https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/' },
    ],
    dir: 'train', pattern: '{i:5}.jpg', start: 1, count: 301,
    blurb: 'The hardest set here, complete: dark paint, repeating windows, and three ' +
           'hundred photos of pair matching. A long run, for benchmarking.',
    approx: '~50 min',
  },
  {
    id: 'synthetic', name: 'Synthetic Corner',
    kind: 'Rendered test set',
    origin: '12 rendered views with exact known camera positions. The clean case, for comparison.',
    links: [],
    dir: 'synthetic', pattern: 'synthetic_{i:2}.png', start: 0, count: 12,
    blurb: 'A synthetic scene with known camera positions. Nothing is noisy, nothing is ' +
           'blurry — the ceiling everything else gets measured against.',
    approx: '~2 min',
  },
];

/** A set made of the visitor's own photographs — the primary path. */
export function ownSet(files, urls) {
  const n = files.length;
  return {
    id: '__own', name: 'Your photos',
    kind: 'Your own photos',
    origin: `${n} photos, read straight off your machine. Nothing is uploaded — they are ` +
            'decoded in this tab and go no further.',
    links: [],
    files, urls, count: n,
    blurb: '',
    approx: n <= 20 ? '~3 min' : n <= 60 ? '~6 min' : '~10 min',
  };
}

export const HOLD_HELP =
  'One photograph is held back from training and only ever scored, never learned from. ' +
  'Its score is the honest one — it says whether the model understood the scene or ' +
  'memorised the pictures.';
