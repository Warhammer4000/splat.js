// develop.js — the comparison surface.
//
// One image area, never two. What the model renders is the picture; the
// photograph it is being trained against is revealed through a loupe you drag,
// a swipe divider, or an error map. That way "rendered vs target" is one thing
// you look at, not two things you look between.

const SP = 28, LV = 6;

let sprites = null;
function atlas() {
  if (sprites) return sprites;
  sprites = [];
  for (let r = 0; r < LV; r++) for (let g = 0; g < LV; g++) for (let b = 0; b < LV; b++) {
    const c = document.createElement('canvas'); c.width = c.height = SP;
    const x = c.getContext('2d');
    const col = `${Math.round(r * 255 / (LV - 1))},${Math.round(g * 255 / (LV - 1))},${Math.round(b * 255 / (LV - 1))}`;
    const gr = x.createRadialGradient(SP / 2, SP / 2, 0, SP / 2, SP / 2, SP / 2);
    gr.addColorStop(0, `rgba(${col},.95)`);
    gr.addColorStop(.5, `rgba(${col},.5)`);
    gr.addColorStop(1, `rgba(${col},0)`);
    x.fillStyle = gr; x.fillRect(0, 0, SP, SP);
    sprites.push(c);
  }
  return sprites;
}

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function fitRect(iw, ih, w, h, pad = 0) {
  const s = Math.min((w - pad * 2) / iw, (h - pad * 2) / ih);
  const rw = iw * s, rh = ih * s;
  return { x: (w - rw) / 2, y: (h - rh) / 2, w: rw, h: rh, s };
}

export class Developer {
  constructor() {
    this.bmp = null;
    this.url = null;
    this.dev = document.createElement('canvas');
    this.err = document.createElement('canvas');
    this.small = document.createElement('canvas');
    this.key = '';
    this.errKey = '';
  }

  /** hand it an already-decoded photograph (the app keeps one shared cache) */
  setBitmap(bitmap, url) {
    if (this.url === url) return;
    this.url = url;
    this.bmp = bitmap;
    this.key = ''; this.errKey = '';
  }

  get ready() { return !!this.bmp; }

  /** the blob-field render of this photo at a given training progress */
  _develop(w, h, progress) {
    const key = `${w}x${h}:${Math.round(progress * 70)}`;
    if (this.key === key) return this.dev;
    this.key = key;

    const dw = Math.min(1180, Math.max(240, Math.round(w)));
    const dh = Math.max(1, Math.round(dw * this.bmp.height / this.bmp.width));
    this.dev.width = dw; this.dev.height = dh;
    const c = this.dev.getContext('2d');

    // coarse sample of the photograph — this is all the model "knows" at this point
    const cells = Math.round(10 + 250 * Math.pow(progress, .85));
    const ch = Math.max(2, Math.round(cells * dh / dw));
    this.small.width = cells; this.small.height = ch;
    const sc = this.small.getContext('2d', { willReadFrequently: true });
    sc.clearRect(0, 0, cells, ch);
    sc.drawImage(this.bmp, 0, 0, cells, ch);
    const px = sc.getImageData(0, 0, cells, ch).data;

    c.fillStyle = '#070909';
    c.fillRect(0, 0, dw, dh);

    // blurry base: what a coarse cloud of soft blobs actually resolves to
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.globalAlpha = 1;
    c.drawImage(this.small, 0, 0, dw, dh);

    // lumpiness on top, so it reads as blobs and not as a blurred photo
    const cw = dw / cells, chh = dh / ch;
    const rad = Math.max(cw, chh) * (1.5 - .55 * progress);
    const sp = atlas();
    c.globalAlpha = .34 * (1 - .45 * progress);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cells; x++) {
        const o = (y * cells + x) * 4;
        const q = (Math.min(LV - 1, px[o] * LV >> 8) * LV + Math.min(LV - 1, px[o + 1] * LV >> 8)) * LV
                + Math.min(LV - 1, px[o + 2] * LV >> 8);
        const jx = ((x * 73 + y * 31) % 17) / 17 - .5, jy = ((x * 41 + y * 97) % 13) / 13 - .5;
        const cxp = (x + .5 + jx * (1 - progress) * .8) * cw, cyp = (y + .5 + jy * (1 - progress) * .8) * chh;
        c.drawImage(sp[q], cxp - rad, cyp - rad, rad * 2, rad * 2);
      }
    }

    // early floaters: half-formed blobs the optimiser has not yet recycled
    const nF = Math.round(70 * Math.max(0, 1 - progress * 3.6));
    c.globalAlpha = .3;
    for (let i = 0; i < nF; i++) {
      const r = (.04 + ((i * 37) % 11) / 60) * dw * (1 - progress);
      const q = ((i * 53) % sp.length);
      c.drawImage(sp[q], ((i * 97) % 100) / 100 * dw - r, ((i * 61) % 100) / 100 * dh - r, r * 2, r * 2);
    }

    // late detail — a converged model is genuinely close to the photograph
    c.globalAlpha = smooth(.32, 1, progress) * .92;
    c.drawImage(this.bmp, 0, 0, dw, dh);
    c.globalAlpha = 1;
    return this.dev;
  }

  _error(w, h, progress) {
    const key = `${w}:${Math.round(progress * 70)}`;
    if (this.errKey === key) return this.err;
    this.errKey = key;
    const dev = this._develop(w, h, progress);
    const ew = 260, eh = Math.max(2, Math.round(ew * dev.height / dev.width));
    this.err.width = ew; this.err.height = eh;
    const ec = this.err.getContext('2d', { willReadFrequently: true });
    ec.drawImage(dev, 0, 0, ew, eh);
    const a = ec.getImageData(0, 0, ew, eh);
    ec.clearRect(0, 0, ew, eh);
    ec.drawImage(this.bmp, 0, 0, ew, eh);
    const b = ec.getImageData(0, 0, ew, eh);
    const out = ec.createImageData(ew, eh);
    for (let i = 0; i < a.data.length; i += 4) {
      const d = (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1])
               + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3;
      const u = Math.min(1, d / 70);
      // cool where the model agrees, hot where it does not
      out.data[i]     = 20 + 235 * Math.pow(u, .75);
      out.data[i + 1] = 40 + 150 * Math.max(0, Math.sin(u * Math.PI * .95));
      out.data[i + 2] = 45 + 90 * Math.max(0, 1 - u * 2.4);
      out.data[i + 3] = 255;
    }
    ec.putImageData(out, 0, 0);
    return this.err;
  }

  /**
   * @param o { progress, mode:'render'|'photo'|'loupe'|'swipe'|'error', loupe:{x,y,r}, swipe:0..1 }
   * @returns the fit rect, so callers can align overlays
   */
  render(ctx, w, h, o) {
    const r = fitRect(this.bmp.width, this.bmp.height, w, h, 0);
    const dev = this._develop(r.w, r.h, o.progress);
    const drawDev = () => ctx.drawImage(dev, r.x, r.y, r.w, r.h);
    const drawPhoto = () => ctx.drawImage(this.bmp, r.x, r.y, r.w, r.h);
    const drawErr = () => {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this._error(r.w, r.h, o.progress), r.x, r.y, r.w, r.h);
    };

    if (o.clear !== false) { ctx.fillStyle = '#070909'; ctx.fillRect(0, 0, w, h); }

    if (o.mode === 'photo') { drawPhoto(); return r; }
    if (o.mode === 'error') { drawErr(); return r; }
    drawDev();
    if (o.mode === 'render') return r;

    // From here on the photograph is the top layer and the render is underneath.
    // Every mode is the same gesture: take some of the photograph away and the
    // render shows through.
    const label = (text, x, align, tone) => {
      ctx.font = '500 10px "Spline Sans Mono", monospace';
      ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = 'rgba(7,9,9,.75)';
      ctx.fillText(text, x + (align === 'left' ? 1 : -1), r.y + r.h - 11);
      ctx.fillStyle = tone;
      ctx.fillText(text, x, r.y + r.h - 12);
    };

    if (o.mode === 'swipe') {
      const x = r.x + r.w * (o.swipe ?? .5);
      ctx.save();                                  // photograph, up to the divider
      ctx.beginPath(); ctx.rect(r.x, r.y, x - r.x, r.h); ctx.clip();
      drawPhoto();
      ctx.restore();

      ctx.strokeStyle = 'rgba(47,212,193,.9)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); ctx.stroke();
      ctx.fillStyle = 'rgba(47,212,193,.9)';
      ctx.beginPath(); ctx.arc(x, r.y + r.h / 2, 7, 0, 7); ctx.fill();
      ctx.fillStyle = '#04231f';
      ctx.font = '600 9px "Spline Sans Mono", monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('↔', x, r.y + r.h / 2 + .5);

      if (x - r.x > 96) label('PHOTOGRAPH', r.x + 12, 'left', 'rgba(230,236,235,.9)');
      if (r.x + r.w - x > 76) label('RENDER', r.x + r.w - 12, 'right', 'rgba(47,212,193,.95)');
      return r;
    }

    if (o.mode === 'loupe' && o.loupe) {
      const { x, y, r: rr } = o.loupe;
      ctx.save();                                  // photograph, with a hole in it
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.arc(x, y, rr, 0, 7);
      ctx.clip('evenodd');
      drawPhoto();
      ctx.restore();

      ctx.strokeStyle = 'rgba(47,212,193,.95)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, rr, 0, 7); ctx.stroke();
      ctx.strokeStyle = 'rgba(7,9,9,.5)'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(x, y, rr + 3, 0, 7); ctx.stroke();
      ctx.fillStyle = 'rgba(47,212,193,.95)';
      ctx.font = '500 10px "Spline Sans Mono", monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('RENDER', x, y - rr - 9);
      label('PHOTOGRAPH', r.x + 12, 'left', 'rgba(230,236,235,.9)');
    }
    return r;
  }
}
