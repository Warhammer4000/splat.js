// fetch_zip_subset.mjs — extract selected files from a remote ZIP without
// downloading the whole archive, via HTTP range requests (ZIP64-aware).
// Usage: node fetch_zip_subset.mjs <zipUrl> <pathPrefix> <outDir>
import { inflateRawSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const [zipUrl, prefix, outDir] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: node fetch_zip_subset.mjs <zipUrl> <pathPrefix> <outDir>');
  process.exit(1);
}

async function fetchRange(start, end) {
  const resp = await fetch(zipUrl, { headers: { Range: `bytes=${start}-${end}` } });
  if (resp.status !== 206 && resp.status !== 200) throw new Error(`range fetch failed: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

const head = await fetch(zipUrl, { method: 'HEAD' });
const total = Number(head.headers.get('content-length'));
console.log(`archive size: ${(total / 1e9).toFixed(2)} GB`);

// --- locate End Of Central Directory (and ZIP64 variants) ---
const tailLen = Math.min(70000, total);
const tail = await fetchRange(total - tailLen, total - 1);
let eocd = -1;
for (let i = tail.length - 22; i >= 0; i--) {
  if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) throw new Error('EOCD not found');
let cdOffset = tail.readUInt32LE(eocd + 16);
let cdSize = tail.readUInt32LE(eocd + 12);
if (cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) {
  // ZIP64: locator sits 20 bytes before EOCD
  const loc = eocd - 20;
  if (tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('ZIP64 locator not found');
  const eocd64Off = Number(tail.readBigUInt64LE(loc + 8));
  const e64 = await fetchRange(eocd64Off, eocd64Off + 63);
  if (e64.readUInt32LE(0) !== 0x06064b50) throw new Error('ZIP64 EOCD not found');
  cdSize = Number(e64.readBigUInt64LE(40));
  cdOffset = Number(e64.readBigUInt64LE(48));
}
console.log(`central directory: ${(cdSize / 1e6).toFixed(1)} MB at ${cdOffset}`);

const cd = await fetchRange(cdOffset, cdOffset + cdSize - 1);

// --- parse central directory entries ---
const entries = [];
let p = 0;
while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
  const method = cd.readUInt16LE(p + 10);
  let compSize = cd.readUInt32LE(p + 20);
  let uncompSize = cd.readUInt32LE(p + 24);
  const nameLen = cd.readUInt16LE(p + 28);
  const extraLen = cd.readUInt16LE(p + 30);
  const commentLen = cd.readUInt16LE(p + 32);
  let localOff = cd.readUInt32LE(p + 42);
  const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
  // ZIP64 extra field (id 0x0001): fields present only for 0xFFFFFFFF values,
  // in order uncompressed, compressed, localOffset
  let ep = p + 46 + nameLen;
  const eEnd = ep + extraLen;
  while (ep + 4 <= eEnd) {
    const id = cd.readUInt16LE(ep), sz = cd.readUInt16LE(ep + 2);
    if (id === 0x0001) {
      let fp = ep + 4;
      if (uncompSize === 0xFFFFFFFF) { uncompSize = Number(cd.readBigUInt64LE(fp)); fp += 8; }
      if (compSize === 0xFFFFFFFF) { compSize = Number(cd.readBigUInt64LE(fp)); fp += 8; }
      if (localOff === 0xFFFFFFFF) { localOff = Number(cd.readBigUInt64LE(fp)); fp += 8; }
    }
    ep += 4 + sz;
  }
  entries.push({ name, method, compSize, uncompSize, localOff });
  p += 46 + nameLen + extraLen + commentLen;
}
console.log(`entries: ${entries.length}`);

const wanted = entries.filter((e) => e.name.startsWith(prefix) && e.uncompSize > 0);
console.log(`matching '${prefix}': ${wanted.length} files, ` +
  `${(wanted.reduce((s, e) => s + e.compSize, 0) / 1e6).toFixed(1)} MB compressed`);
if (!wanted.length) {
  console.log('sample entries:', entries.slice(0, 20).map((e) => e.name));
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
let done = 0;
for (const e of wanted) {
  // local header: 30 bytes fixed + name + extra (lengths can differ from CD!)
  const lh = await fetchRange(e.localOff, e.localOff + 29);
  if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`bad local header for ${e.name}`);
  const lNameLen = lh.readUInt16LE(26);
  const lExtraLen = lh.readUInt16LE(28);
  const dataStart = e.localOff + 30 + lNameLen + lExtraLen;
  const raw = await fetchRange(dataStart, dataStart + e.compSize - 1);
  const data = e.method === 0 ? raw : inflateRawSync(raw);
  if (data.length !== e.uncompSize) throw new Error(`size mismatch for ${e.name}`);
  writeFileSync(join(outDir, basename(e.name)), data);
  done++;
  if (done % 20 === 0) console.log(`  ${done}/${wanted.length}`);
}
console.log(`extracted ${done} files to ${outDir}`);
