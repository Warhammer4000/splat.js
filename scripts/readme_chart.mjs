// node scripts/readme_chart.mjs — writes docs/img/truck-psnr-vs-time-{light,dark}.svg
// Truck test PSNR against training time: the Splat.js rows of the README table
// as one curve, the two locally measured trainers as marks, the papers as lines.
import { writeFileSync } from 'node:fs';

const SPLAT = [   // README rows: minutes of training, held-out PSNR, cycles
  { min: 6, psnr: 25.83, label: '6 min · 30 k cycles' },
  { min: 10, psnr: 26.14, label: '10 min · 40 k' },
  { min: 20, psnr: 26.41, label: '20 min · 73 k' },
  { min: 60, psnr: 26.59, label: '60 min · 165 k' },
];
const LOCAL = [   // measured on the same machine, same images, same holdout
  { min: 5.5, psnr: 26.14, name: 'LichtFeld Studio', sub: '5½ min · 26.14', dx: -35, anchor: 'start', dy: [-32, -19] },
  { min: 30, psnr: 26.10, name: 'Brush v0.3', sub: '30 min · 26.10', dx: 0, anchor: 'middle', dy: [18, 30] },
];
const PAPERS = [  // native CUDA, 30 k iterations; time not comparable, drawn as levels
  { psnr: 26.41, name: 'Student Splatting & Scooping', off: -4 },
  { psnr: 26.11, name: '3DGS-MCMC', off: 4 },
  { psnr: 25.77, name: 'Scaffold-GS', off: -3 },
  { psnr: 25.74, name: 'Mip-Splatting', off: 10 },
  { psnr: 25.18, name: '3DGS (2023)', off: 4 },
];

const W = 820, H = 420, L = 120, R = 590, T = 44, B = 356;
const X0 = 0, X1 = 66, Y0 = 25.0, Y1 = 26.8;
const x = (m) => L + (m - X0) / (X1 - X0) * (R - L);
const y = (p) => B - (p - Y0) / (Y1 - Y0) * (B - T);
const f2 = (v) => v.toFixed(2);
const esc = (t) => t.replace(/&/g, '&amp;');

function svg(theme) {
  const c = theme === 'dark'
    ? { text: '#c9d1d9', muted: '#8b949e', grid: '#30363d', axis: '#484f58', paper: '#8b949e', splat: '#2dd4bf', splatFill: '#0d1117', mark: '#d2a8ff' }
    : { text: '#1f2328', muted: '#59636e', grid: '#d8dee4', axis: '#8c959f', paper: '#6e7781', splat: '#0f9c8c', splatFill: '#ffffff', mark: '#8250df' };
  const font = `font-family="ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"`;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" ${font} font-size="12">\n`;
  s += `<title>Truck: held-out PSNR against training time</title>\n`;
  // grid + axes
  for (let p = Y0; p <= Y1 + 1e-9; p += 0.2) {
    s += `<line x1="${L}" x2="${R}" y1="${y(p).toFixed(1)}" y2="${y(p).toFixed(1)}" stroke="${c.grid}" stroke-width="1"/>\n`;
    s += `<text x="${L - 10}" y="${(y(p) + 4).toFixed(1)}" text-anchor="end" fill="${c.muted}" font-variant-numeric="tabular-nums">${p.toFixed(1)}</text>\n`;
  }
  for (let m = 0; m <= 60; m += 10) {
    s += `<line x1="${x(m).toFixed(1)}" x2="${x(m).toFixed(1)}" y1="${B}" y2="${B + 5}" stroke="${c.axis}"/>\n`;
    s += `<text x="${x(m).toFixed(1)}" y="${B + 20}" text-anchor="middle" fill="${c.muted}">${m}</text>\n`;
  }
  s += `<line x1="${L}" x2="${R}" y1="${B}" y2="${B}" stroke="${c.axis}"/>\n`;
  s += `<text x="${(L + R) / 2}" y="${B + 42}" text-anchor="middle" fill="${c.muted}">training minutes on one RTX 5080 (camera solve not included)</text>\n`;
  s += `<text transform="translate(28 ${(T + B) / 2}) rotate(-90)" text-anchor="middle" fill="${c.muted}">test PSNR, dB (32 held-out photos)</text>\n`;
  // papers as levels
  for (const p of PAPERS) {
    const yy = y(p.psnr).toFixed(1);
    s += `<line x1="${L}" x2="${R}" y1="${yy}" y2="${yy}" stroke="${c.paper}" stroke-dasharray="4 4" stroke-width="1"/>\n`;
    s += `<text x="${R + 10}" y="${(y(p.psnr) + 4 + p.off).toFixed(1)}" fill="${c.paper}">${esc(p.name)} <tspan font-variant-numeric="tabular-nums">${f2(p.psnr)}</tspan></text>\n`;
  }
  // Splat.js curve
  const pts = SPLAT.map((d) => `${x(d.min).toFixed(1)},${y(d.psnr).toFixed(1)}`).join(' ');
  s += `<polyline points="${pts}" fill="none" stroke="${c.splat}" stroke-width="2.5" stroke-linejoin="round"/>\n`;
  SPLAT.forEach((d, i) => {
    const px = x(d.min), py = y(d.psnr);
    s += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="5" fill="${c.splatFill}" stroke="${c.splat}" stroke-width="2.5"/>\n`;
    if (i === 0) {   // one line to the right, between the curve and the Scaffold-GS level
      s += `<text x="${(px + 12).toFixed(1)}" y="${(py + 4).toFixed(1)}" fill="${c.splat}" font-weight="600">${f2(d.psnr)} <tspan fill="${c.text}" font-weight="400" font-size="11">${d.label}</tspan></text>\n`;
      return;
    }
    const below = i === 1;
    const ty = below ? py + 20 : py - 12;
    const tx = below ? px + 10 : px;
    const anchor = below ? 'start' : 'middle';
    s += `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="${anchor}" fill="${c.splat}" font-weight="600">${f2(d.psnr)}</text>\n`;
    s += `<text x="${tx.toFixed(1)}" y="${(ty + (below ? 13 : -13)).toFixed(1)}" text-anchor="${anchor}" fill="${c.text}" font-size="11">${d.label}</text>\n`;
  });
  s += `<text x="${(x(60) + 12).toFixed(1)}" y="${(y(26.59) + 4).toFixed(1)}" fill="${c.splat}" font-weight="700" font-size="13">Splat.js</text>\n`;
  // local marks
  for (const m of LOCAL) {
    const px = x(m.min), py = y(m.psnr);
    s += `<path d="M ${px} ${py - 6} L ${px + 6} ${py} L ${px} ${py + 6} L ${px - 6} ${py} Z" fill="${c.mark}"/>\n`;
    s += `<text x="${(px + m.dx).toFixed(1)}" y="${(py + m.dy[0]).toFixed(1)}" text-anchor="${m.anchor}" fill="${c.mark}" font-weight="600" font-size="11">${m.name}</text>\n`;
    s += `<text x="${(px + m.dx).toFixed(1)}" y="${(py + m.dy[1]).toFixed(1)}" text-anchor="${m.anchor}" fill="${c.mark}" font-size="11">${m.sub}</text>\n`;
  }
  // title + legend line
  s += `<text x="${L}" y="22" fill="${c.text}" font-size="15" font-weight="700">Tanks &amp; Temples Truck — held-out PSNR against training time</text>\n`;
  s += `<text x="${L}" y="${T - 8}" fill="${c.muted}" font-size="11">Splat.js in one browser tab, 1.05 M splats, schedule set to the budget · ◆ trainers measured on the same machine · dashed: published methods</text>\n`;
  s += `</svg>\n`;
  return s;
}
for (const t of ['light', 'dark']) writeFileSync(`docs/img/truck-psnr-vs-time-${t}.svg`, svg(t));
console.log('written docs/img/truck-psnr-vs-time-{light,dark}.svg');
