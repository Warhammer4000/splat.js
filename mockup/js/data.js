// data.js — everything the mockup pretends to know.

// TODO: point at the real repository before this goes public.
export const REPO = 'https://github.com/arrival-space/splat.js';

// Numbers are the REAL measured results of the prototype (see ../prototype/README.md)
// so the mock reads like the finished product, not like lorem ipsum.

export const PRESETS = [
  {
    id: 'truck', name: 'Truck', where: 'Tanks & Temples',
    kind: 'Standard test set',
    origin: '42 photos of the Truck sequence from the Tanks & Temples reconstruction benchmark.',
    links: [
      { label: 'Tanks & Temples', url: 'https://www.tanksandtemples.org/' },
      { label: 'image set', url: 'https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/' },
    ],
    dir: 'truck', pattern: '{i:6}.jpg', start: 1, count: 42,
    mockPoses: 'file',                    // MOCKUP ONLY: real poses+cloud on disk drive the visuals
    capture: 'orbit',
    captureLine: 'One slow arc walked around the subject',
    res: '1957 x 1091',
    badge: { kind: 'good', text: 'Clean result' },
    blurb: 'A parked truck, circled once on foot. Even spacing, constant light, ' +
           'plenty of sideways movement — close to a textbook capture.',
    stats: { sfm: 11, cams: 42, of: 42, points: 4989, rms: 0.42, splats: 92000 },
    psnr: { train: 25.5, hold: 25.6 }, minutes: 3,
  },
  {
    id: 'train', name: 'Train', where: 'Tanks & Temples',
    kind: 'Standard test set',
    origin: '84 photos of the Train sequence from the Tanks & Temples reconstruction benchmark.',
    links: [
      { label: 'Tanks & Temples', url: 'https://www.tanksandtemples.org/' },
      { label: 'image set', url: 'https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/' },
    ],
    dir: 'train', pattern: '{i:5}.jpg', start: 1, count: 84,
    mockPoses: 'file',
    capture: 'orbit',
    captureLine: 'Two passes around a locomotive, 84 frames',
    res: '1959 x 1090',
    badge: { kind: 'good', text: 'Twice the frames' },
    blurb: 'More photos of a harder subject: dark paint, repeating windows, and a seam ' +
           'where the shoot was interrupted and picked up again.',
    stats: { sfm: 58, cams: 84, of: 84, points: 15500, rms: 0.52, splats: 140000 },
    psnr: { train: 24.1, hold: 25.2 }, minutes: 6,
  },
  {
    id: 'camping', name: 'Camping', where: 'Handheld video',
    kind: 'Handheld phone video',
    origin: '113 frames pulled from a phone video. Not a benchmark — an ordinary capture, with everything that goes wrong in one.',
    links: [],
    dir: 'camping', pattern: 'frame_{i:5}.jpg', start: 1, count: 113,
    mockPoses: 'sim', simPath: 'walk',
    capture: 'walk',
    captureLine: 'Phone video, walked past the scene',
    res: '1920 x 1080',
    badge: { kind: 'note', text: 'Video frames' },
    blurb: 'Every frame of a walking video. Neighbouring frames barely differ, so the ' +
           'solver has to chain landmarks across dozens of them.',
    stats: { sfm: 112, cams: 113, of: 113, points: 17000, rms: 0.67, splats: 88000 },
    psnr: { train: 27.3, hold: 28.0 }, minutes: 8,
  },
  {
    id: 'synthetic', name: 'Synthetic Corner', where: 'Rendered',
    kind: 'Generated on this page',
    origin: '12 views rendered here on the fly, with exact camera positions. The clean case, for comparison.',
    links: [],
    dir: 'synthetic', pattern: 'synthetic_{i:2}.png', start: 0, count: 12,
    mockPoses: 'sim', simPath: 'arc',
    capture: 'orbit',
    captureLine: '12 rendered views, perfect geometry',
    res: '640 x 480',
    badge: { kind: 'fast', text: 'Fastest — 30 s' },
    blurb: 'A synthetic scene with known camera positions. Nothing is noisy, nothing is ' +
           'blurry — the ceiling everything else gets measured against.',
    stats: { sfm: 3, cams: 12, of: 12, points: 3100, rms: 0.43, splats: 30000 },
    psnr: { train: 40.8, hold: 38.9 }, minutes: 1,
  },
  {
    id: 'bicycle', name: 'Bicycle', where: 'Mip-NeRF 360',
    kind: 'Standard test set',
    origin: '42 photos of the Bicycle scene from the Mip-NeRF 360 dataset.',
    links: [{ label: 'Mip-NeRF 360', url: 'https://jonbarron.info/mipnerf360/' }],
    dir: 'bicycle', files: 'files.json', count: 42,
    mockPoses: 'sim', simPath: 'sphere',
    capture: 'orbit',
    captureLine: 'Outdoor 360, wide steps between shots',
    res: '1237 x 822',
    badge: { kind: 'hard', text: 'Hard case' },
    blurb: 'Grass, gravel and leaves. Every patch looks like every other patch, so ' +
           'landmarks match the wrong places and most photos never get placed.',
    stats: { sfm: 44, cams: 10, of: 42, points: 379, rms: 1.31, splats: 20000 },
    psnr: { train: 19.0, hold: 17.3 }, minutes: 4,
  },
];

/**
 * A set made of the visitor's own photographs. Same shape as the staged ones,
 * so nothing downstream has to know the difference — only the geometry is
 * invented, because there is no solver here to find the real thing.
 */
export function ownSet(files, urls, imgW, imgH) {
  const n = files.length;
  return {
    id: '__own', name: 'Your photos', where: 'Uploaded',
    own: files.map((f, i) => ({ name: f.name, url: urls[i] })),
    count: n, mockPoses: 'sim', simPath: 'sphere',
    imgW, imgH,
    kind: 'Your own photos',
    res: `${imgW} x ${imgH}`,
    origin: `${n} photos, read straight off your machine. Nothing is uploaded — they are ` +
            'decoded in this tab and go no further.',
    links: [],
    captureLine: 'Your capture',
    badge: { kind: 'note', text: 'Yours' },
    blurb: '',
    stats: {
      sfm: Math.round(4 + n * 0.35), cams: n, of: n,
      points: Math.min(30000, Math.round(n * 420)), rms: 0.61,
      splats: Math.min(140000, Math.round(n * 2200) + 40000),
    },
    psnr: { train: 23.4, hold: 22.6 },
    minutes: Math.max(1, Math.round(n / 14)),
  };
}

export const PHASES = [
  { id: 'frames',   n: '01', label: 'Frames' },
  { id: 'features', n: '02', label: 'Landmarks' },
  { id: 'cameras',  n: '03', label: 'Cameras' },
  { id: 'seed',     n: '04', label: 'Seed' },
  { id: 'train',    n: '05', label: 'Train' },
  { id: 'result',   n: '06', label: 'Result' },
];

// Rail copy. `lead` is the one line a novice reads; `more` opens on demand.
export const COPY = {
  frames: {
    title: 'The photographs',
    lead: 'Everything below is squeezed out of these pictures. No depth sensor, no scan, ' +
          'no stored idea of what a truck looks like.',
    more: [
      'Photos are downscaled for the solver. What matters at this stage is where things ' +
      'are, not how sharp they are.',
      'Blurry frames stay in for camera tracking but drop out of the comparison later, so ' +
      'the model never learns someone’s shaky hand.',
    ],
    action: 'Find landmarks',
  },
  features: {
    title: 'Recognisable spots',
    lead: 'The solver marks spots it could recognise again from another angle: corners, ' +
          'texture, edges. Smooth walls and blank sky give it nothing.',
    more: [
      'Each mark gets a short numeric fingerprint of its surroundings, so the same spot ' +
      'can be found in other photos even when it has moved, rotated or changed size.',
      'Two photos are then compared fingerprint by fingerprint. Plenty of pairings are ' +
      'wrong; a geometry test throws out everything that could not be explained by one ' +
      'rigid scene seen from two positions.',
    ],
    action: 'Place the cameras',
  },
  cameras: {
    title: 'Where each photo was taken',
    lead: 'A spot seen from two known directions fixes a point in space. A photo with ' +
          'enough known points fixes a camera. Solved together, they give both.',
    more: [
      'Cameras are added one at a time, each anchored to the photos it shares the most ' +
      'landmarks with, and the whole set is re-balanced as it grows.',
      'The cloud that falls out is only a few thousand points — far too coarse to look ' +
      'at. Its job is to say roughly where surfaces are, so the next stage does not have ' +
      'to start from nothing.',
    ],
    action: 'Seed the splats',
  },
  seed: {
    title: 'One splat per point',
    lead: 'Every point becomes a splat — a soft 3D blob with a position, a size along ' +
          'three axes, an orientation, a colour and a transparency. That is the whole model.',
    more: [
      'No mesh, no texture, no surface. A scene is a few hundred thousand of these splats, ' +
      'sorted back to front and stacked until they look like a photograph.',
      'They start out round, roughly as wide as the gap to their nearest neighbour, and ' +
      'mostly see-through. Everything interesting about them is learned next.',
    ],
    action: 'Start training',
  },
  train: {
    title: 'Guess, compare, nudge',
    lead: 'Render the splats from one photo’s viewpoint, compare with the photo, nudge ' +
          'every splat a little to shrink the difference. Then pick another photo.',
    more: [
      'Nothing here knows what a truck is. The only instruction is “look more like this ' +
      'photograph from this angle”, repeated tens of thousands of times.',
      'Splats that end up contributing nothing get recycled — moved next to splats that are ' +
      'carrying detail, where the capacity is actually worth something.',
      'The camera positions keep being adjusted too. They came out of a rough solve, and a ' +
      'fraction of a degree of error shows up as blur no splat can fix.',
    ],
    action: 'Finish',
  },
  result: {
    title: 'The result',
    lead: 'One file, ready for any splat viewer.',
    more: [],
    action: 'Export',
  },
};

// Stat glossary — one plain line each, on demand, so numbers stay browsable
// instead of intimidating.
export const HELP = {
  frames: 'How many photographs went in.',
  placed: 'Photos the solver managed to position in 3D. Anything unplaced goes unused.',
  points: 'Landmarks triangulated into 3D. The starting skeleton for the splats.',
  rms: 'Average distance, in pixels, between where a landmark should appear and where it ' +
       'does. Under one pixel is a solid solve.',
  focal: 'How zoomed in the lens is, in pixels. Guessed from the photos — no camera data ' +
         'is read from the files.',
  k1: 'Lens distortion: straight lines bending near the edge of the frame.',
  track: 'How many photos an average landmark is visible in. Longer is sturdier.',
  splats: 'Splats in the model right now. The count grows during training as detail is needed.',
  iter: 'One render-compare-nudge cycle against one photograph.',
  ips: 'Cycles per second on this machine.',
  psnr: 'How close the render is to the photograph, in decibels. Every +3 dB halves the ' +
        'error; above 30 dB is hard to tell apart by eye.',
  hold: 'The same score on a photo hidden from training. This is the honest one — it says ' +
        'whether the model understood the scene or memorised the pictures.',
  sharp: 'How much fine detail a frame has. Low means motion blur.',
  parallax: 'How much the viewpoint actually moved between photos, in degrees. Turning on ' +
            'the spot gives zero, and zero means no depth can be recovered.',
  vram: 'Graphics memory held by the splats, the photos and the optimiser state.',
  mem: 'Size of the finished file.',
  match: 'Landmark pairings between two photos that survived the geometry test.',
};

// Named training events — the moments worth pointing at on the curve.
export const EVENTS = [
  { at: 0.000, kind: 'start', label: 'Splats seeded' },
  { at: 0.035, kind: 'warm',  label: 'Cameras unlocked' },
  { at: 0.090, kind: 'grow',  label: 'Capacity +5%' },
  { at: 0.190, kind: 'grow',  label: 'Capacity +5%' },
  { at: 0.310, kind: 'grow',  label: 'Capacity +5%' },
  { at: 0.450, kind: 'grow',  label: 'Capacity +5%' },
  { at: 0.620, kind: 'stop',  label: 'Growth stops' },
  { at: 0.800, kind: 'decay', label: 'Step size decays' },
];

// Ghost runs: pre-baked comparisons, so "what if" is one click and not a second wait.
export const GHOSTS = {
  none: null,
  half: {
    label: 'Half the photos', drop: 4.2, holdDrop: 6.4,
    note: 'Same scene, every second frame thrown away. The render still looks fine from ' +
          'the photos it kept, and falls apart everywhere else.',
  },
  nocam: {
    label: 'Fixed camera positions', drop: 1.1, holdDrop: 0.7,
    note: 'Cameras left exactly where the solver put them. The splats spend their capacity ' +
          'covering up a fraction of a degree of pose error.',
  },
  small: {
    label: 'A quarter of the splats', drop: 2.6, holdDrop: 1.4,
    note: 'Fewer splats, less to overfit with. Both curves drop, but the gap between them ' +
          'narrows.',
  },
};

// Capture guide (v2 seed) — the misconception first, then what to do instead.
export const GUIDE = [
  {
    kind: 'bad', diagram: 'spin',
    title: 'Turning on the spot records nothing',
    body: 'A panorama moves the camera by a few centimetres. Depth comes from seeing the ' +
          'same thing from genuinely different places, so a full 360 from one standpoint ' +
          'gives a solver nothing to work with.',
  },
  {
    kind: 'good', diagram: 'orbit',
    title: 'Walk around the subject instead',
    body: 'Keep the subject in frame and move sideways around it. Every step you take is ' +
          'depth information. A full circle is ideal; a wide arc already works.',
  },
  {
    kind: 'good', diagram: 'overlap',
    title: 'Overlap generously, move slowly',
    body: 'Neighbouring photos should share most of their content — a small step, then ' +
          'another. Walking too fast between shots breaks the chain, and so does motion ' +
          'blur: pause, then shoot.',
  },
  {
    kind: 'good', diagram: 'height',
    title: 'Change height, and come back',
    body: 'A second pass higher or lower fills in what the first pass hid. Finish where ' +
          'you started so the loop closes — that one overlap keeps the whole circle from ' +
          'drifting.',
  },
  {
    kind: 'bad', diagram: 'shiny',
    title: 'Skip what does not hold still',
    body: 'Mirrors, glass, water and bare white walls look different from every angle or ' +
          'the same from all of them. Both confuse the solver. So do people who move ' +
          'between shots.',
  },
];
