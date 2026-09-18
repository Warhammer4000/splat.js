// cutouts.js — the "is this the person?" checkpoint: a strip of frames with
// the room removed. Resolves true (looks right) or false (not a person /
// cancel), and nothing expensive has run yet when the user says no.

export function cutoutsCard(card, frames, { coverage }) {
  return new Promise((resolve) => {
    // every frame, in capture order, in a strip that scrolls sideways (wheel, drag,
    // swipe); the buttons sit below it (the user, 2026-09-15)
    const picks = frames;
    card.innerHTML = `
      <div class="vid-head"><b>Cut out of the room</b><span class="prep-sub">${frames.length} frames · the person covers ${(coverage * 100).toFixed(0)}% of a frame</span></div>
      <div class="av-strip" id="av-strip"></div>
      <p class="fine av-fine">The avatar trains only on what is white here. Hair and finger tips should be there; the room should not. Scroll sideways to see every frame.</p>
      <div class="av-actions"><button class="btn btn-outline" id="av-no">Not a person</button><button class="btn btn-accent" id="av-yes">Looks right</button></div>`;
    const strip = card.querySelector('#av-strip');
    // a vertical wheel scrolls the strip sideways; dragging scrolls it too
    strip.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { strip.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
    let drag = null;
    strip.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, left: strip.scrollLeft }; strip.setPointerCapture(e.pointerId); });
    strip.addEventListener('pointermove', (e) => { if (drag) strip.scrollLeft = drag.left - (e.clientX - drag.x); });
    strip.addEventListener('pointerup', () => { drag = null; }); strip.addEventListener('pointercancel', () => { drag = null; });
    (async () => {
      for (const f of picks) {
        const [bmp, mask] = await Promise.all([createImageBitmap(f.source), createImageBitmap(f.mask)]);
        const h = 320, w = Math.round((bmp.width / bmp.height) * h);   // drawn at 2x, shown at 160 px
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.style.height = '160px'; cv.style.width = `${w / 2}px`;
        const g = cv.getContext('2d');
        // photo × matte over white
        g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
        const tmp = new OffscreenCanvas(w, h); const t = tmp.getContext('2d');
        t.drawImage(bmp, 0, 0, w, h);
        t.globalCompositeOperation = 'destination-in';
        // the matte is grayscale: use its luminance as alpha
        const m = new OffscreenCanvas(w, h); const mg = m.getContext('2d');
        mg.drawImage(mask, 0, 0, w, h);
        const md = mg.getImageData(0, 0, w, h); const ad = mg.createImageData(w, h);
        for (let p = 0; p < w * h; p++) { ad.data[p * 4 + 3] = md.data[p * 4]; }
        mg.putImageData(ad, 0, 0);
        t.drawImage(m, 0, 0);
        g.drawImage(tmp, 0, 0);
        bmp.close(); mask.close();
        cv.title = f.name || ''; strip.appendChild(cv);
        if (!card.isConnected || !card.contains(strip)) return;   // the card moved on
        await new Promise((r) => setTimeout(r, 0));
      }
    })().catch(() => {});
    card.querySelector('#av-yes').onclick = () => resolve(true);
    card.querySelector('#av-no').onclick = () => resolve(false);
  });
}
