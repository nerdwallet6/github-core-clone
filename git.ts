// git.ts — git smart HTTP: upload-pack v2 (+ v0 fallback), receive-pack v0.
// Own object store access goes through the shared store (store.ts). Pack
// reading handles plain, OFS-delta and REF-delta entries; packs we send are
// plain (non-delta) version-2 packs. Spec: digest-git.md.
import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';

const ZERO_OID = '0'.repeat(40);
const TYPE_CODES = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_CACHE = new Map(); // key -> Buffer (invalidated on ref updates)

function sha1Hex(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

// ---------- pkt-line ----------
function pktLine(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

function decodePktLines(buf) {
  // Returns [{ kind: 'data'|'flush'|'delim'|'end', text? }] or throws.
  const out = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line');
    const head = buf.toString('ascii', off, off + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('invalid pkt-line length "' + head + '"');
    const len = parseInt(head, 16);
    if (len === 0) { out.push({ kind: 'flush' }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim' }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'end' }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', text: buf.toString('utf8', off + 4, off + len) });
    off += len;
  }
  return out;
}

function pktLinesToText(packets) {
  return packets.filter((p) => p.kind === 'data').map((p) => p.text);
}

// ---------- packfile ----------
function encodePackObjectHeader(typeCode, size) {
  const bytes = [];
  let b = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  if (size) b |= 0x80;
  bytes.push(b);
  while (size) {
    let c = size & 0x7f;
    size >>= 7;
    if (size) c |= 0x80;
    bytes.push(c);
  }
  return Buffer.from(bytes);
}

function writePack(entries) {
  // entries: [{type, data: Buffer}] — plain objects, deterministic order.
  const sorted = entries.slice().sort((a, b) => {
    const sa = sha1Hex(Buffer.concat([Buffer.from(a.type + ' ' + a.data.length + '\0'), a.data]));
    const sb = sha1Hex(Buffer.concat([Buffer.from(b.type + ' ' + b.data.length + '\0'), b.data]));
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  const parts = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const e of sorted) {
    parts.push(encodePackObjectHeader(TYPE_CODES[e.type], e.data.length));
    parts.push(deflateSync(e.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

function findZlibEnd(buf, off, expectedSize) {
  // inflateSync ignores trailing bytes and throws when truncated, so the
  // minimal end offset that inflates to expectedSize is the stream end.
  let lo = off + 1;
  let hi = buf.length;
  const ok = (end) => {
    try {
      return inflateSync(buf.subarray(off, end)).length === expectedSize;
    } catch {
      return false;
    }
  };
  if (!ok(hi)) throw new Error('pack-zlib: stream does not terminate');
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function readVarint(buf, off) {
  let value = buf[off] & 0x7f;
  let shift = 7;
  let pos = off + 1;
  while (buf[pos - 1] & 0x80) {
    value |= (buf[pos] & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return { value, next: pos };
}

function applyDelta(base, delta) {
  let pos = 0;
  const readVar = () => {
    let v = 0;
    let shift = 0;
    while (true) {
      const b = delta[pos++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readVar();
  const tgtSize = readVar();
  if (srcSize !== base.length) throw new Error('delta-base-size mismatch');
  const out = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) cpOff |= delta[pos++] << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) cpSize |= delta[pos++] << (8 * i);
      if (cpSize === 0) cpSize = 0x10000;
      if (cpOff + cpSize > base.length) throw new Error('delta-corrupt copy overrun');
      out.push(base.subarray(cpOff, cpOff + cpSize));
      outLen += cpSize;
    } else if (op !== 0) {
      if (pos + op > delta.length) throw new Error('delta-corrupt literal overrun');
      out.push(delta.subarray(pos, pos + op));
      outLen += op;
      pos += op;
    } else {
      throw new Error('delta-corrupt zero opcode');
    }
  }
  if (outLen !== tgtSize) throw new Error('delta-size mismatch');
  return Buffer.concat(out, outLen);
}

function readPack(buf, resolveBase) {
  if (buf.length < 32) throw new Error('pack-truncated');
  if (buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack-header');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('pack-version');
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const computed = sha1Hex(buf.subarray(0, buf.length - 20));
  if (trailer.toString('hex') !== computed) throw new Error('pack-checksum');
  const objects = new Map(); // sha -> { type, data }
  const rawEntries = []; // { typeCode, data, baseOid?, baseOff? } in pack order
  let off = 12;
  for (let i = 0; i < count; i++) {
    const first = buf[off];
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let pos = off + 1;
    while (buf[pos - 1] & 0x80) {
      size |= (buf[pos] & 0x7f) << shift;
      shift += 7;
      pos += 1;
    }
    let baseOid = null;
    let baseOff = null;
    if (typeCode === 7) {
      baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else if (typeCode === 6) {
      let b = buf[pos++];
      let base = b & 0x7f;
      while (b & 0x80) {
        b = buf[pos++];
        base = ((base + 1) << 7) | (b & 0x7f);
      }
      baseOff = off - base;
      if (baseOff < 0) throw new Error('pack-delta-base');
    } else if (!CODE_TYPES[typeCode]) {
      throw new Error('pack-type ' + typeCode);
    }
    const dataEnd = findZlibEnd(buf, pos, size);
    const data = inflateSync(buf.subarray(pos, dataEnd));
    if (data.length !== size) throw new Error('pack-size');
    rawEntries.push({ typeCode, data, baseOid, baseOff, offset: off });
    off = dataEnd;
  }
  if (off !== buf.length - 20) throw new Error('pack-trailing');
  // Resolve entries (plain first, then deltas, recursively).
  const byOffset = new Map(rawEntries.map((e) => [e.offset, e]));
  const resolving = new Set();
  function resolveEntry(e) {
    if (e.resolved) return e.resolved;
    if (resolving.has(e.offset)) throw new Error('pack-delta-cycle');
    resolving.add(e.offset);
    let out;
    if (e.typeCode === 6 || e.typeCode === 7) {
      let base = null;
      if (e.typeCode === 6) {
        const baseEntry = byOffset.get(e.baseOff);
        if (!baseEntry) throw new Error('pack-delta-base');
        base = resolveEntry(baseEntry);
      } else {
        if (objects.has(e.baseOid)) base = objects.get(e.baseOid);
        else if (resolveBase) base = resolveBase(e.baseOid);
        if (!base) throw new Error('pack-delta-base');
      }
      const data = applyDelta(base.data, e.data);
      out = { type: base.type, data };
    } else {
      out = { type: CODE_TYPES[e.typeCode], data: e.data };
    }
    resolving.delete(e.offset);
    const sha = sha1Hex(Buffer.concat([Buffer.from(out.type + ' ' + out.data.length + '\0'), out.data]));
    e.resolved = out;
    objects.set(sha, out);
    return out;
  }
  for (const e of rawEntries) resolveEntry(e);
  return { version, count, objects };
}

// ---------- reachability ----------
function collectReachable(store, roots) {
  // Returns Map sha -> { type, data } of every object reachable from roots.
  const out = new Map();
  const stack = (roots || []).filter(Boolean);
  const seen = new Set();
  while (stack.length) {
    const sha = stack.pop();
    if (!sha || sha === ZERO_OID || seen.has(sha)) continue;
    seen.add(sha);
    const obj = store.getObject(sha);
    if (!obj) continue;
    out.set(sha, obj);
    if (obj.type === 'commit') {
      const c = store.getCommit(sha);
      if (c) {
        if (c.tree) stack.push(c.tree);
        for (const p of c.parents) stack.push(p);
      }
    } else if (obj.type === 'tree') {
      for (const e of store.parseTreeObject(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const m = text.match(/^object ([0-9a-f]{40})$/m);
      if (m) stack.push(m[1]);
    }
  }
  return out;
}

function commitDepthMap(store, wants, maxDepth) {
  // BFS from wants; returns Map commitSha -> generation (1 = want itself).
  const depth = new Map();
  const queue = [];
  for (const w of wants) {
    if (w && w !== ZERO_OID && !depth.has(w)) { depth.set(w, 1); queue.push(w); }
  }
  while (queue.length) {
    const sha = queue.shift();
    const d = depth.get(sha);
    if (maxDepth && d >= maxDepth) continue;
    const c = store.getCommit(sha);
    if (!c) continue;
    for (const p of c.parents) {
      if (!depth.has(p)) { depth.set(p, d + 1); queue.push(p); }
    }
  }
  return depth;
}

function objectsForCommits(store, commitShas) {
  const out = new Map();
  for (const sha of commitShas) {
    for (const [oid, obj] of collectReachable(store, [sha])) out.set(oid, obj);
  }
  return out;
}

function objectsForCommitsShallow(store, commitShas) {
  // Objects for exactly these commits: the commit objects themselves plus
  // each commit's tree closure (trees + blobs). Parent commits are NOT
  // included — that is what makes a depth-N fetch actually shallow.
  const out = new Map();
  for (const sha of commitShas) {
    const obj = store.getObject(sha);
    if (!obj) continue;
    out.set(sha, obj);
    const c = store.getCommit(sha);
    if (c && c.tree) {
      const stack = [c.tree];
      const seen = new Set();
      while (stack.length) {
        const t = stack.pop();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        const tobj = store.getObject(t);
        if (!tobj) continue;
        out.set(t, tobj);
        if (tobj.type === 'tree') {
          for (const e of store.parseTreeObject(tobj.data)) stack.push(e.oid);
        }
      }
    }
  }
  return out;
}

// ---------- advertisements ----------
const V2_CAPS = ['fetch=shallow filter', 'ls-refs=unborn', 'object-format=sha1', 'agent=makefun-git-forge/1.0'];
const V0_UPLOAD_CAPS = 'side-band-64k multi_ack thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=makefun-git-forge/1.0';
const V0_RECEIVE_CAPS = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=makefun-git-forge/1.0';

function refLinesV0(store, repo, caps) {
  const refs = store.listRefs(repo);
  const lines = [];
  const headTip = store.getRef(repo, 'refs/heads/main');
  if (refs.length === 0) {
    lines.push(ZERO_OID + ' capabilities^{}\0' + caps + '\n');
  } else {
    let first = true;
    const head = refs.find((r) => r.name === 'refs/heads/main') || refs[0];
    const ordered = [head, ...refs.filter((r) => r !== head)];
    for (const r of ordered) {
      lines.push(r.oid + ' ' + r.name + (first ? '\0' + caps : '') + '\n');
      first = false;
      // Peeled tag lines for annotated tags.
      if (r.name.startsWith('refs/tags/')) {
        const obj = store.getObject(r.oid);
        if (obj && obj.type === 'tag') {
          const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
          if (m) lines.push(m[1] + ' ' + r.name + '^{}\n');
        }
      }
    }
  }
  void headTip;
  return lines;
}

function advertisementV2(service) {
  const parts = [pktLine('# service=' + service + '\n'), FLUSH];
  parts.push(pktLine('version 2'));
  for (const c of V2_CAPS) parts.push(pktLine(c));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function advertisementV0(store, repo, service) {
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  const parts = [pktLine('# service=' + service + '\n'), FLUSH];
  for (const line of refLinesV0(store, repo, caps)) parts.push(pktLine(line));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function sendAdvertisement(res, store, repo, service, wantV2) {
  if (wantV2 && service === 'git-upload-pack') {
    res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement' });
    res.end(advertisementV2(service));
  } else {
    const ct = service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(advertisementV0(store, repo, service));
  }
}

// ---------- ls-refs (v2) ----------
function lsRefsResponse(store, repo, args) {
  const refs = store.listRefs(repo);
  const out = [];
  const peel = args.peel !== false;
  const symrefs = args.symrefs !== false;
  const wantUnborn = !!args.unborn;
  const prefixes = args.prefixes || [];
  const headTip = store.getRef(repo, 'refs/heads/main');
  const include = (name) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  // HEAD is a ref named "HEAD": it matches a prefix only when the prefix
  // is a prefix of "HEAD" (or there is no prefix). A prefix like
  // "refs/heads/" must NOT pull HEAD in.
  if (symrefs && (!prefixes.length || prefixes.some((p) => 'HEAD'.startsWith(p)))) {
    if (headTip) out.push(headTip + ' HEAD symref-target:refs/heads/main\n');
    else if (wantUnborn) out.push('unborn HEAD symref-target:refs/heads/main\n');
  }
  for (const r of refs) {
    if (!include(r.name)) continue;
    let line = r.oid + ' ' + r.name;
    if (peel && r.name.startsWith('refs/tags/')) {
      const obj = store.getObject(r.oid);
      if (obj && obj.type === 'tag') {
        const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
        if (m) line += ' peeled:' + m[1];
      }
    }
    out.push(line + '\n');
  }
  const parts = out.map((l) => pktLine(l));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------- fetch ----------
function planFetch(store, wants, haves, shallowBoundaries, deepen) {
  // Returns { objects: Map, newShallow: [], unshallow: [] }.
  const held = new Map(); // objects the client already holds
  if (haves && haves.length) {
    const heldCommits = new Set();
    const stack = haves.filter(Boolean);
    const seen = new Set();
    while (stack.length) {
      const sha = stack.pop();
      if (!sha || sha === ZERO_OID || seen.has(sha)) continue;
      seen.add(sha);
      heldCommits.add(sha);
      if (shallowBoundaries && shallowBoundaries.includes(sha)) continue; // do not walk past a shallow boundary
      const c = store.getCommit(sha);
      if (c) for (const p of c.parents) stack.push(p);
    }
    // Objects the client already holds: the tree closure of each held
    // commit, and nothing beyond a shallow boundary. (collectReachable
    // would walk past the boundary and wrongly mark the parent as held,
    // which made deepen-N fetches deliver nothing new.)
    for (const [oid, obj] of objectsForCommitsShallow(store, [...heldCommits])) held.set(oid, obj);
  }
  let wanted;
  let newShallow = [];
  let unshallow = [];
  if (deepen) {
    const depth = commitDepthMap(store, wants, deepen);
    // Depth-limited: only the commits within N generations plus their tree
    // closures. collectReachable would also pull in every ancestor commit,
    // which is exactly what a shallow clone must not receive.
    wanted = objectsForCommitsShallow(store, [...depth.keys()]);
    // New shallow boundaries: wanted commits at max depth whose parent is
    // neither delivered nor held.
    const deliveredCommits = new Set(depth.keys());
    const heldCommits = new Set([...held.keys()].filter((k) => store.getObject(k) && store.getObject(k).type === 'commit'));
    for (const [sha, d] of depth) {
      if (d !== deepen) continue;
      const c = store.getCommit(sha);
      const parents = c ? c.parents : [];
      // A boundary commit is shallow unless every parent is delivered or
      // held; a root commit at the boundary is shallow too.
      const open = parents.filter((p) => !deliveredCommits.has(p) && !heldCommits.has(p));
      if (open.length || parents.length === 0) newShallow.push(sha);
    }
    // Unshallow: old boundaries whose parents are now delivered or held.
    for (const b of shallowBoundaries || []) {
      const c = store.getCommit(b);
      if (!c) continue;
      const parents = c.parents || [];
      if (parents.every((p) => deliveredCommits.has(p) || heldCommits.has(p))) unshallow.push(b);
    }
  } else {
    wanted = new Map();
    for (const w of wants) {
      for (const [oid, obj] of collectReachable(store, [w])) wanted.set(oid, obj);
    }
  }
  const objects = new Map();
  for (const [oid, obj] of wanted) if (!held.has(oid)) objects.set(oid, obj);
  return { objects, newShallow, unshallow };
}

function sidebandPackets(pack) {
  const parts = [];
  const CHUNK = 60000;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(off + CHUNK, pack.length));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    const len = payload.length + 4;
    parts.push(Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]));
  }
  if (pack.length === 0) {
    const payload = Buffer.from([1]);
    parts.push(Buffer.concat([Buffer.from('0005', 'ascii'), payload]));
  }
  return parts;
}

function fetchResponseV2(store, wants, haves, shallowBoundaries, deepen) {
  const plan = planFetch(store, wants, haves, shallowBoundaries, deepen);
  const pack = writePack([...plan.objects.values()].map((o) => ({ type: o.type, data: o.data })));
  const parts = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine('NAK\n'));
  parts.push(DELIM);
  if (deepen) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.newShallow) parts.push(pktLine('shallow ' + s + '\n'));
    for (const s of plan.unshallow) parts.push(pktLine('unshallow ' + s + '\n'));
    parts.push(DELIM);
  }
  parts.push(pktLine('packfile\n'));
  for (const p of sidebandPackets(pack)) parts.push(p);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchResponseV0(store, wants, haves, shallowBoundaries, deepen) {
  const plan = planFetch(store, wants, haves, shallowBoundaries, deepen);
  const pack = writePack([...plan.objects.values()].map((o) => ({ type: o.type, data: o.data })));
  const parts = [];
  parts.push(pktLine('NAK\n'));
  if (deepen) {
    for (const s of plan.newShallow) parts.push(pktLine('shallow ' + s + '\n'));
    for (const s of plan.unshallow) parts.push(pktLine('unshallow ' + s + '\n'));
  }
  for (const p of sidebandPackets(pack)) parts.push(p);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function parseFetchArgs(packets) {
  const args = { wants: [], haves: [], shallow: [], deepen: null, thinPack: true, filter: null };
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.text;
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(/\s+/)[0]);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.deepen = n;
    } else if (line.startsWith('deepen-since ')) args.deepen = args.deepen || 1;
    else if (line.startsWith('filter ')) args.filter = line.slice(7).trim();
    else if (line === 'thin-pack' || line === 'thin-pack\n') args.thinPack = true;
  }
  return args;
}

// ---------- receive-pack (v0 push) ----------
const RESPONSE_CACHE = new Map(); // fetch responses, keyed by repo+args

function cacheKeyFor(repo, wants, haves, shallow, deepen, v2) {
  return repo.owner + '/' + repo.name + '|' + (v2 ? 'v2' : 'v0') + '|' +
    JSON.stringify([wants.slice().sort(), (haves || []).slice().sort(), (shallow || []).slice().sort(), deepen]);
}

function invalidateRepoCache(repo) {
  const prefix = repo.owner + '/' + repo.name + '|';
  for (const k of [...RESPONSE_CACHE.keys()]) if (k.startsWith(prefix)) RESPONSE_CACHE.delete(k);
}

function splitPushBody(buf) {
  // Returns { commands: [{oldOid, newOid, ref, caps}], packStart }.
  const commands = [];
  let off = 0;
  let packStart = buf.length;
  while (off < buf.length) {
    if (off + 4 > buf.length) break;
    const head = buf.toString('ascii', off, off + 4);
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 0) break;
    if (len === 0) { packStart = off + 4; break; }
    if (len === 1 || len === 2) { off += 4; continue; }
    if (off + len > buf.length) break;
    const text = buf.toString('utf8', off + 4, off + len);
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).trim();
    const caps = nul >= 0 ? text.slice(nul + 1).trim() : '';
    const m = line.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/);
    if (m) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3], caps });
    off += len;
  }
  return { commands, packStart };
}

function handlePush(store, repo, body) {
  const { commands, packStart } = splitPushBody(body);
  const report = [];
  let unpackOk = true;
  let unpackDetail = '';
  let sideband = false;
  if (commands.length === 0) {
    return { status: 400, body: Buffer.from('no commands', 'utf8') };
  }
  const firstCaps = commands[0].caps || '';
  sideband = firstCaps.includes('side-band-64k');
  const packBytes = body.subarray(packStart);
  const hasPack = packBytes.length > 0;
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  if (needsPack && hasPack) {
    try {
      const pack = readPack(packBytes, (oid) => store.getObject(oid) || null);
      for (const [sha, obj] of pack.objects) {
        if (!store.getObject(sha)) store.putObject(obj.type, obj.data);
      }
    } catch (e) {
      unpackOk = false;
      unpackDetail = String((e && e.message) || e).slice(0, 200);
    }
  }
  if (unpackOk) {
    for (const cmd of commands) {
      const current = store.getRef(repo, cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (!current || current !== cmd.oldOid) {
          report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          store.deleteRef(repo, cmd.ref);
          report.push({ ref: cmd.ref, ok: true });
        }
      } else if (cmd.oldOid === ZERO_OID) {
        // Create.
        if (current) {
          report.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
        } else if (!store.getObject(cmd.newOid)) {
          report.push({ ref: cmd.ref, ok: false, reason: 'missing object' });
        } else {
          store.setRef(repo, cmd.ref, cmd.newOid);
          report.push({ ref: cmd.ref, ok: true });
        }
      } else {
        // Update: old must match and new must descend from old.
        if (!current || current !== cmd.oldOid) {
          report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        } else if (!store.getObject(cmd.newOid)) {
          report.push({ ref: cmd.ref, ok: false, reason: 'missing object' });
        } else if (!store.isAncestor(cmd.oldOid, cmd.newOid)) {
          report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          store.setRef(repo, cmd.ref, cmd.newOid);
          report.push({ ref: cmd.ref, ok: true });
        }
      }
    }
    invalidateRepoCache(repo);
  }
  const lines = [];
  lines.push(unpackOk ? 'unpack ok\n' : 'unpack ' + unpackDetail + '\n');
  for (const r of report) {
    lines.push(r.ok ? 'ok ' + r.ref + '\n' : 'ng ' + r.ref + ' ' + r.reason + '\n');
  }
  const reportBuf = Buffer.concat([...lines.map((l) => pktLine(l)), FLUSH]);
  let out;
  if (sideband) {
    const parts = [];
    const CHUNK = 60000;
    for (let off = 0; off < reportBuf.length; off += CHUNK) {
      const slice = reportBuf.subarray(off, Math.min(off + CHUNK, reportBuf.length));
      const payload = Buffer.concat([Buffer.from([1]), slice]);
      const len = payload.length + 4;
      parts.push(Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]));
    }
    parts.push(FLUSH);
    out = Buffer.concat(parts);
  } else {
    out = reportBuf;
  }
  return { status: 200, body: out, sideband };
}

// ---------- dispatcher ----------
function tokenOkGit(req) {
  const expected = process.env.MAKEFUN_SHOP_TOKEN || '';
  const h = req.headers.authorization || '';
  if (!expected) return h.startsWith('Bearer ') && h.length > 7;
  return h === 'Bearer ' + expected;
}

function sendJsonGit(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export async function handleGit(req, res, store) {
  const url = new URL(req.url, 'http://localhost');
  const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\.git(\/.*)?$/);
  if (!m) { sendJsonGit(res, 404, { message: 'Not Found' }); return; }
  const owner = decodeURIComponent(m[1]);
  const repoName = decodeURIComponent(m[2]);
  const rest = m[3] || '';

  if (!tokenOkGit(req)) { sendJsonGit(res, 401, { message: 'Unauthorized' }); return; }
  store.noteOwnerLogin(owner);
  const repo = store.getRepo(owner, repoName);

  if (req.method === 'GET' && rest === '/info/refs') {
    const service = url.searchParams.get('service');
    if (!service || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
      sendJsonGit(res, 404, { message: 'Not Found' });
      return;
    }
    if (!repo) { sendJsonGit(res, 404, { message: 'Repository not found' }); return; }
    const wantV2 = (req.headers['git-protocol'] || '') === 'version=2';
    sendAdvertisement(res, store, repo, service, wantV2);
    return;
  }

  if (req.method === 'POST' && rest === '/git-upload-pack') {
    if (!repo) { sendJsonGit(res, 404, { message: 'Repository not found' }); return; }
    const wantV2 = (req.headers['git-protocol'] || '') === 'version=2';
    let packets;
    try {
      packets = decodePktLines(req.rawBody || Buffer.alloc(0));
    } catch {
      sendJsonGit(res, 400, { message: 'Bad pkt-line' });
      return;
    }
    const texts = pktLinesToText(packets);
    const first = (texts[0] || '').trim();
    if (wantV2 && first === 'command=ls-refs') {
      const args = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const t of texts) {
        const line = t.trim();
        if (line === 'peel') args.peel = true;
        else if (line === 'symrefs') args.symrefs = true;
        else if (line === 'unborn') args.unborn = true;
        else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length).trim());
      }
      res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
      res.end(lsRefsResponse(store, repo, args));
      return;
    }
    if (wantV2 && first === 'command=fetch') {
      const args = parseFetchArgs(packets);
      const key = cacheKeyFor(repo, args.wants, args.haves, args.shallow, args.deepen, true);
      let out = RESPONSE_CACHE.get(key);
      if (!out) {
        out = fetchResponseV2(store, args.wants, args.haves, args.shallow, args.deepen);
        RESPONSE_CACHE.set(key, out);
      }
      res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
      res.end(out);
      return;
    }
    // v0 fetch (no Git-Protocol header, or a v0-shaped body).
    const args = parseFetchArgs(packets);
    if (!args.wants.length) {
      res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
      res.end(Buffer.concat([pktLine('NAK\n'), FLUSH]));
      return;
    }
    const key = cacheKeyFor(repo, args.wants, args.haves, args.shallow, args.deepen, false);
    let out = RESPONSE_CACHE.get(key);
    if (!out) {
      out = fetchResponseV0(store, args.wants, args.haves, args.shallow, args.deepen);
      RESPONSE_CACHE.set(key, out);
    }
    res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
    res.end(out);
    return;
  }

  if (req.method === 'POST' && rest === '/git-receive-pack') {
    if (!repo) { sendJsonGit(res, 404, { message: 'Repository not found' }); return; }
    const result = handlePush(store, repo, req.rawBody || Buffer.alloc(0));
    res.writeHead(result.status, { 'Content-Type': 'application/x-git-receive-pack-result' });
    res.end(result.body);
    return;
  }

  sendJsonGit(res, 404, { message: 'Not Found' });
}
