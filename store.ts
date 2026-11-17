// store.ts — the forge's single in-memory store: git objects, refs, repos,
// issues, pull requests, labels and comments. No HTTP code here.
// Determinism: every timestamp comes from trialNow() (MAKEFUN_TRIAL_NOW when
// set); every id is a sequential counter or a content hash. Nothing here
// reads the wall clock or Math.random in a response-affecting path.
import { createHash } from 'node:crypto';

const ZERO_OID = '0'.repeat(40);
const COMMIT_AUTHOR = 'makefun <makefun@example.invalid>';

function sha1Hex(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

function gitObjectId(type, data) {
  const header = Buffer.from(type + ' ' + data.length + '\0', 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

// Git tree sort: entries compare by name bytes, a directory as if its name
// ended in '/'.
function treeSortKey(name, isDir) {
  return isDir ? name + '/' : name;
}

function parseTreeObject(data) {
  const entries = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.toString('utf8', off, sp);
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

function buildTreeObject(entries) {
  const sorted = entries.slice().sort((a, b) => {
    const ka = treeSortKey(a.name, a.mode === '40000');
    const kb = treeSortKey(b.name, b.mode === '40000');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts = sorted.map((e) => {
    const head = Buffer.from(e.mode + ' ' + e.name + '\0', 'utf8');
    return Buffer.concat([head, Buffer.from(e.oid, 'hex')]);
  });
  return Buffer.concat(parts);
}

function parseCommitObject(data) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  let message = split >= 0 ? text.slice(split + 2) : '';
  if (message.endsWith('\n')) message = message.slice(0, -1);
  let tree = null;
  const parents = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

export function createStore() {
  const objects = new Map(); // sha -> { type, data: Buffer }
  const commitMeta = new Map(); // commit sha -> { message, tree, parents }
  const repos = new Map(); // "<owner>/<name>" -> repo
  const pending = new Map(); // name -> repo (created before owner login known)
  let ownerLogin = null;
  let repoIdSeq = 1;

  function trialNowMs() {
    const raw = process.env.MAKEFUN_TRIAL_NOW;
    if (raw) {
      const asNum = Number(raw);
      if (Number.isFinite(asNum) && asNum > 0) {
        return asNum > 1e12 ? asNum : asNum * 1000;
      }
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
    return Date.now();
  }

  function trialNowSec() {
    return Math.floor(trialNowMs() / 1000);
  }

  function trialNowIso() {
    return new Date(trialNowMs()).toISOString();
  }

  function hashObject(type, data) {
    return gitObjectId(type, data);
  }

  function putObject(type, data) {
    const sha = gitObjectId(type, data);
    if (!objects.has(sha)) objects.set(sha, { type, data });
    return sha;
  }

  function getObject(sha) {
    return objects.get(sha);
  }

  function blobShaFor(content) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    return putObject('blob', buf);
  }

  function readTreeRecursive(treeSha, prefix, out) {
    if (!treeSha || treeSha === ZERO_OID) return out;
    const obj = objects.get(treeSha);
    if (!obj || obj.type !== 'tree') return out;
    for (const e of parseTreeObject(obj.data)) {
      const path = prefix ? prefix + '/' + e.name : e.name;
      if (e.mode === '40000') readTreeRecursive(e.oid, path, out);
      else out.set(path, { blobSha: e.oid, mode: e.mode });
    }
    return out;
  }

  function treeFromPathMap(pathMap) {
    // pathMap: Map path -> { blobSha, mode }. Build nested trees bottom-up.
    function build(paths, prefix) {
      const entries = [];
      const dirs = new Map();
      for (const [path, info] of paths) {
        if (prefix && !path.startsWith(prefix + '/')) continue;
        const rest = prefix ? path.slice(prefix.length + 1) : path;
        const slash = rest.indexOf('/');
        if (slash < 0) entries.push({ mode: info.mode, name: rest, oid: info.blobSha });
        else {
          const dir = rest.slice(0, slash);
          if (!dirs.has(dir)) dirs.set(dir, []);
          dirs.get(dir).push([path, info]);
        }
      }
      for (const [dir, sub] of dirs) {
        const subMap = new Map(sub);
        const subSha = build(subMap, prefix ? prefix + '/' + dir : dir);
        entries.push({ mode: '40000', name: dir, oid: subSha });
      }
      return putObject('tree', buildTreeObject(entries));
    }
    return build(pathMap, '');
  }

  function buildTree(baseTreeSha, changes) {
    // changes: Map path -> Buffer (new content) | null (delete)
    const flat = readTreeRecursive(baseTreeSha, '', new Map());
    for (const [path, content] of changes) {
      if (content === null) flat.delete(path);
      else flat.set(path, { blobSha: blobShaFor(content), mode: '100644' });
    }
    return treeFromPathMap(flat);
  }

  function makeCommit({ tree, parents, message }) {
    const ts = trialNowSec();
    const msg = message.endsWith('\n') ? message : message + '\n';
    let text = 'tree ' + tree + '\n';
    for (const p of parents || []) text += 'parent ' + p + '\n';
    text += 'author ' + COMMIT_AUTHOR + ' ' + ts + ' +0000\n';
    text += 'committer ' + COMMIT_AUTHOR + ' ' + ts + ' +0000\n';
    text += '\n' + msg;
    const sha = putObject('commit', Buffer.from(text, 'utf8'));
    commitMeta.set(sha, { message, tree, parents: parents || [] });
    return sha;
  }

  function getCommit(sha) {
    const meta = commitMeta.get(sha);
    if (meta) return meta;
    const obj = objects.get(sha);
    if (!obj || obj.type !== 'commit') return null;
    const parsed = parseCommitObject(obj.data);
    return { message: parsed.message, tree: parsed.tree, parents: parsed.parents };
  }

  function commitMessage(sha) {
    const c = getCommit(sha);
    return c ? c.message : '';
  }

  function commitTree(sha) {
    const c = getCommit(sha);
    return c ? c.tree : null;
  }

  function isAncestor(anc, sha) {
    if (!anc || anc === ZERO_OID || !sha || sha === ZERO_OID) return false;
    if (anc === sha) return true;
    const seen = new Set();
    const stack = [sha];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === anc) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const c = getCommit(cur);
      if (c) for (const p of c.parents) stack.push(p);
    }
    return false;
  }

  function listCommitsFrom(tip) {
    // Walk parents from tip, most-recent-first traversal order, deduped.
    const out = [];
    const seen = new Set();
    const stack = tip ? [tip] : [];
    while (stack.length) {
      const sha = stack.shift();
      if (!sha || sha === ZERO_OID || seen.has(sha)) continue;
      seen.add(sha);
      const c = getCommit(sha);
      if (!c) continue;
      out.push(sha);
      for (const p of c.parents) stack.push(p);
    }
    return out;
  }

  function diffTrees(baseTreeSha, headTreeSha) {
    const base = readTreeRecursive(baseTreeSha, '', new Map());
    const head = readTreeRecursive(headTreeSha, '', new Map());
    const files = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        const oldLines = lineCount(b.blobSha);
        files.push({ filename: path, status: 'removed', additions: 0, deletions: oldLines, changes: oldLines });
      } else if (!b && h) {
        const newLines = lineCount(h.blobSha);
        files.push({ filename: path, status: 'added', additions: newLines, deletions: 0, changes: newLines });
      } else if (b && h && b.blobSha !== h.blobSha) {
        const oldLines = lineCount(b.blobSha);
        const newLines = lineCount(h.blobSha);
        files.push({ filename: path, status: 'modified', additions: newLines, deletions: oldLines, changes: newLines + oldLines });
      }
    }
    return files;
  }

  function lineCount(blobSha) {
    const obj = objects.get(blobSha);
    if (!obj) return 0;
    const text = obj.data.toString('utf8');
    if (text.length === 0) return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  }

  return {
    ZERO_OID,
    objects,
    trialNowMs,
    trialNowSec,
    trialNowIso,
    hashObject,
    putObject,
    getObject,
    blobShaFor,
    readTreeRecursive,
    treeFromPathMap,
    buildTree,
    makeCommit,
    getCommit,
    commitMessage,
    commitTree,
    isAncestor,
    listCommitsFrom,
    diffTrees,
    lineCount,
    parseTreeObject,
    parseCommitObject,
    buildTreeObject,
    get ownerLogin() { return ownerLogin; },
    noteOwnerLogin,
    createRepo,
    getRepo,
    deleteRepo,
    listReposByOwner,
    listAllRepos,
    getRef,
    setRef,
    deleteRef,
    listRefs,
    getDefaultBranch,
    resolveRef,
    createLabel,
    getLabel,
    listLabels,
    createIssue,
    getIssue,
    listIssues,
    patchIssue,
    createComment,
    listComments,
    createBranch,
    getBranch,
    listBranches,
    createPull,
    getPull,
    listPulls,
    mergeableFor,
    squashMerge,
    putContent,
    deleteContent,
    getContent,
    repoGlobalId,
    issueGlobalId,
    prGlobalId,
    commentGlobalId,
    findByGlobalId,
  };

  function findByGlobalId(id) {
    for (const repo of listAllRepos()) {
      if (repoGlobalId(repo) === id) return { kind: 'repo', repo };
      for (const issue of repo.issues) {
        if (issueGlobalId(repo, issue.number) === id) return { kind: 'issue', repo, issue };
        for (const c of listComments(repo, issue.number)) {
          if (commentGlobalId(repo, issue.number, c.id) === id) return { kind: 'comment', repo, issue, comment: c };
        }
      }
      for (const pr of repo.pulls) {
        if (prGlobalId(repo, pr.number) === id) return { kind: 'pr', repo, pr };
      }
    }
    return null;
  }

  function noteOwnerLogin(login) {
    if (ownerLogin || !login || typeof login !== 'string') return;
    ownerLogin = login;
    for (const [name, repo] of pending) {
      pending.delete(name);
      repo.owner = login;
      repos.set(login + '/' + name, repo);
    }
  }

  function createRepo({ owner, name, isPrivate, description }) {
    // An explicitly named owner always wins over the adopted login: an
    // MCP create_repo (or any caller) that names its owner means it.
    const effOwner = owner || ownerLogin || '__pending__';
    const key = effOwner + '/' + name;
    if (repos.has(key) || (effOwner === '__pending__' && pending.has(name))) {
      return { error: 'exists' };
    }
    const now = trialNowIso();
    const repo = {
      id: repoIdSeq++,
      owner: effOwner,
      name,
      private: !!isPrivate,
      description: description || '',
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      seq: 1,
      commentSeq: 1,
      comments: new Map(),
    };
    if (effOwner === '__pending__') pending.set(name, repo);
    else repos.set(key, repo);
    return { repo };
  }

  function getRepo(owner, name) {
    if (owner && name) {
      const r = repos.get(owner + '/' + name);
      if (r) return r;
      if (!ownerLogin) {
        const p = pending.get(name);
        if (p) return p;
      }
    }
    return undefined;
  }

  function deleteRepo(owner, name) {
    if (repos.delete(owner + '/' + name)) return true;
    if (pending.delete(name)) return true;
    return false;
  }

  function listReposByOwner(owner) {
    const out = [];
    for (const repo of repos.values()) if (repo.owner === owner) out.push(repo);
    if (!ownerLogin && owner === '__pending__') {
      for (const repo of pending.values()) out.push(repo);
    }
    return out;
  }

  function listAllRepos() {
    return [...repos.values(), ...pending.values()];
  }

  function getRef(repo, refname) {
    return repo.refs.get(refname);
  }

  function setRef(repo, refname, sha) {
    repo.refs.set(refname, sha);
  }

  function deleteRef(repo, refname) {
    return repo.refs.delete(refname);
  }

  function listRefs(repo) {
    return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  function getDefaultBranch(repo) {
    return repo.defaultBranch || 'main';
  }

  function resolveRef(repo, ref) {
    if (!ref) return getRef(repo, 'refs/heads/' + getDefaultBranch(repo));
    if (ref.startsWith('refs/')) return getRef(repo, ref);
    if (/^[0-9a-f]{40}$/i.test(ref)) return objects.has(ref) ? ref : undefined;
    return getRef(repo, 'refs/heads/' + ref);
  }

  function createLabel(repo, { name, color }) {
    if (repo.labels.has(name)) return { error: 'exists' };
    const label = { name, color: color || 'ededed' };
    repo.labels.set(name, label);
    return { label };
  }

  function getLabel(repo, name) {
    return repo.labels.get(name);
  }

  function listLabels(repo) {
    return [...repo.labels.values()];
  }

  function repoGlobalId(repo) {
    return 'R_' + sha1Hex(Buffer.from('repo:' + repo.owner + '/' + repo.name, 'utf8')).slice(0, 24);
  }

  function issueGlobalId(repo, number) {
    return 'I_' + sha1Hex(Buffer.from('issue:' + repo.owner + '/' + repo.name + '/' + number, 'utf8')).slice(0, 24);
  }

  function prGlobalId(repo, number) {
    return 'PR_' + sha1Hex(Buffer.from('pr:' + repo.owner + '/' + repo.name + '/' + number, 'utf8')).slice(0, 24);
  }

  function commentGlobalId(repo, number, id) {
    return 'C_' + sha1Hex(Buffer.from('comment:' + repo.owner + '/' + repo.name + '/' + number + '/' + id, 'utf8')).slice(0, 24);
  }

  function createIssue(repo, { title, body, labels }) {
    const number = repo.seq++;
    const now = trialNowIso();
    const issue = {
      number,
      id: issueGlobalId(repo, number),
      title: title || '',
      body: body || '',
      state: 'open',
      labels: (labels || []).slice(),
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.push(issue);
    return { issue };
  }

  function getIssue(repo, number) {
    return repo.issues.find((i) => i.number === number);
  }

  function listIssues(repo, { state, sort, direction }) {
    let list = repo.issues.slice();
    if (state && state !== 'all') list = list.filter((i) => i.state === state);
    const dir = direction === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -dir : dir;
      return (a.number - b.number) * dir;
    });
    return list;
  }

  function patchIssue(repo, number, patch) {
    const issue = getIssue(repo, number);
    if (!issue) return null;
    if (patch.state === 'open' || patch.state === 'closed') issue.state = patch.state;
    if (typeof patch.title === 'string') issue.title = patch.title;
    if (typeof patch.body === 'string') issue.body = patch.body;
    if (Array.isArray(patch.labels)) issue.labels = patch.labels.slice();
    issue.updatedAt = trialNowIso();
    return issue;
  }

  function createComment(repo, issueNumber, body) {
    const id = repo.commentSeq++;
    const comment = { id, globalId: commentGlobalId(repo, issueNumber, id), body: body || '', createdAt: trialNowIso() };
    if (!repo.comments.has(issueNumber)) repo.comments.set(issueNumber, []);
    repo.comments.get(issueNumber).push(comment);
    return { comment };
  }

  function listComments(repo, issueNumber) {
    return (repo.comments.get(issueNumber) || []).slice();
  }

  function createBranch(repo, branch, sha) {
    setRef(repo, 'refs/heads/' + branch, sha);
    return { ref: 'refs/heads/' + branch, sha };
  }

  function getBranch(repo, branch) {
    return getRef(repo, 'refs/heads/' + branch);
  }

  function listBranches(repo) {
    const out = [];
    for (const [name, oid] of repo.refs) {
      if (name.startsWith('refs/heads/')) out.push({ name: name.slice('refs/heads/'.length), sha: oid });
    }
    const def = getDefaultBranch(repo);
    out.sort((a, b) => {
      if (a.name === def) return -1;
      if (b.name === def) return 1;
      return a.name < b.name ? -1 : 1;
    });
    return out;
  }

  function createPull(repo, { head, base, title, body }) {
    const headSha = getRef(repo, 'refs/heads/' + head);
    const baseSha = getRef(repo, 'refs/heads/' + base);
    if (!headSha || !baseSha) return { error: 'missing-branch' };
    const number = repo.seq++;
    const now = trialNowIso();
    const pr = {
      number,
      id: prGlobalId(repo, number),
      title: title || '',
      body: body || '',
      state: 'open',
      head: { ref: head, sha: headSha },
      base: { ref: base, sha: baseSha },
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      headTree: commitTree(headSha),
      baseTree: commitTree(baseSha),
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.push(pr);
    return { pr };
  }

  function getPull(repo, number) {
    return repo.pulls.find((p) => p.number === number);
  }

  function listPulls(repo, { state }) {
    let list = repo.pulls.slice();
    if (state && state !== 'all') list = list.filter((p) => p.state === state);
    return list;
  }

  function mergeableFor(repo, pr) {
    const baseTip = getRef(repo, 'refs/heads/' + pr.base.ref);
    if (!baseTip) return 'UNKNOWN';
    const ancestorTree = pr.baseTree;
    const headTree = pr.headTree;
    const currentBaseTree = commitTree(baseTip);
    const changed = diffTrees(ancestorTree, headTree);
    const currentMap = readTreeRecursive(currentBaseTree, '', new Map());
    const ancestorMap = readTreeRecursive(ancestorTree, '', new Map());
    const headMap = readTreeRecursive(headTree, '', new Map());
    for (const f of changed) {
      const cur = currentMap.get(f.filename);
      const anc = ancestorMap.get(f.filename);
      const hed = headMap.get(f.filename);
      const curSha = cur ? cur.blobSha : null;
      const ancSha = anc ? anc.blobSha : null;
      const hedSha = hed ? hed.blobSha : null;
      if (curSha !== ancSha && curSha !== hedSha) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  function squashMerge(repo, pr) {
    if (pr.state !== 'open') return { error: 'closed' };
    if (mergeableFor(repo, pr) === 'CONFLICTING') return { error: 'conflict' };
    const baseTip = getRef(repo, 'refs/heads/' + pr.base.ref);
    const baseTree = commitTree(baseTip);
    const headMap = readTreeRecursive(pr.headTree, '', new Map());
    const ancestorMap = readTreeRecursive(pr.baseTree, '', new Map());
    const changes = new Map();
    for (const f of diffTrees(pr.baseTree, pr.headTree)) {
      const entry = headMap.get(f.filename);
      if (entry) {
        const obj = objects.get(entry.blobSha);
        changes.set(f.filename, obj ? obj.data : Buffer.alloc(0));
      } else {
        changes.set(f.filename, null);
      }
    }
    void ancestorMap;
    const mergedTree = buildTree(baseTree, changes);
    const message = pr.title + ' (#' + pr.number + ')';
    const sha = makeCommit({ tree: mergedTree, parents: [baseTip], message });
    setRef(repo, 'refs/heads/' + pr.base.ref, sha);
    pr.state = 'closed';
    pr.merged = true;
    pr.merged_at = trialNowIso();
    pr.merge_commit_sha = sha;
    pr.updatedAt = trialNowIso();
    return { sha };
  }

  function putContent(repo, { path, content, message, branch }) {
    const branchName = branch || getDefaultBranch(repo);
    const refname = 'refs/heads/' + branchName;
    let tip = getRef(repo, refname);
    let baseTree = null;
    const parents = [];
    if (tip) {
      baseTree = commitTree(tip);
      parents.push(tip);
    } else {
      // Unborn branch: start from the default branch tip when it exists.
      const defTip = getRef(repo, 'refs/heads/' + getDefaultBranch(repo));
      if (defTip && branchName !== getDefaultBranch(repo)) {
        baseTree = commitTree(defTip);
        parents.push(defTip);
      }
    }
    const flat = readTreeRecursive(baseTree, '', new Map());
    const existing = flat.get(path);
    const blobSha = blobShaFor(content);
    const changes = new Map([[path, content]]);
    const newTree = buildTree(baseTree, changes);
    const sha = makeCommit({ tree: newTree, parents, message: message || 'Update ' + path });
    setRef(repo, refname, sha);
    return { blobSha, commitSha: sha, created: !existing, oldBlobSha: existing ? existing.blobSha : null };
  }

  function deleteContent(repo, { path, message, branch }) {
    const branchName = branch || getDefaultBranch(repo);
    const refname = 'refs/heads/' + branchName;
    const tip = getRef(repo, refname);
    if (!tip) return { error: 'no-branch' };
    const baseTree = commitTree(tip);
    const flat = readTreeRecursive(baseTree, '', new Map());
    const existing = flat.get(path);
    if (!existing) return { error: 'not-found' };
    const changes = new Map([[path, null]]);
    const newTree = buildTree(baseTree, changes);
    const sha = makeCommit({ tree: newTree, parents: [tip], message: message || 'Delete ' + path });
    setRef(repo, refname, sha);
    return { commitSha: sha, oldBlobSha: existing.blobSha };
  }

  function getContent(repo, path, ref) {
    const tip = resolveRef(repo, ref);
    if (!tip) return { error: 'no-branch' };
    const tree = commitTree(tip);
    const flat = readTreeRecursive(tree, '', new Map());
    const entry = flat.get(path);
    if (entry) {
      const obj = objects.get(entry.blobSha);
      return { kind: 'file', blobSha: entry.blobSha, data: obj ? obj.data : Buffer.alloc(0) };
    }
    // Directory?
    const prefix = path ? path + '/' : '';
    const children = new Map();
    for (const [p, info] of flat) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) children.set(rest, { type: 'file', name: rest, path: p, sha: info.blobSha });
    }
    // Subdirectories: find their tree shas by walking the tree object.
    const treeObj = objects.get(tree);
    if (treeObj) {
      const parts = path ? path.split('/') : [];
      let curTree = tree;
      let ok = true;
      for (const part of parts) {
        const o = objects.get(curTree);
        if (!o) { ok = false; break; }
        const found = parseTreeObject(o.data).find((e) => e.name === part && e.mode === '40000');
        if (!found) { ok = false; break; }
        curTree = found.oid;
      }
      if (ok && path) {
        const o = objects.get(curTree);
        if (o) {
          for (const e of parseTreeObject(o.data)) {
            const childPath = path + '/' + e.name;
            if (e.mode === '40000') children.set(e.name, { type: 'dir', name: e.name, path: childPath, sha: e.oid });
            else if (!children.has(e.name)) children.set(e.name, { type: 'file', name: e.name, path: childPath, sha: e.oid });
          }
        }
      } else if (ok && !path) {
        const o = objects.get(curTree);
        if (o) {
          for (const e of parseTreeObject(o.data)) {
            if (e.mode === '40000') children.set(e.name, { type: 'dir', name: e.name, path: e.name, sha: e.oid });
            else if (!children.has(e.name)) children.set(e.name, { type: 'file', name: e.name, path: e.name, sha: e.oid });
          }
        }
      }
    }
    if (children.size > 0) return { kind: 'dir', entries: [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)) };
    return { error: 'not-found' };
  }
}
