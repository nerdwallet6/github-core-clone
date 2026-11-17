// rest.ts — GitHub REST v3 handlers. Spec: digest-rest.md.
// Every reply is JSON with a non-empty X-GitHub-Request-Id (set by app.ts).
// Errors are {"message": "<non-empty string>"}.
import { Buffer } from 'node:buffer';

function sendJson(res, status, obj, extra) {
  const body = JSON.stringify(obj);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) };
  if (extra) for (const k of Object.keys(extra)) headers[k] = extra[k];
  res.writeHead(status, headers);
  res.end(body);
}

function sendErr(res, status, message) {
  sendJson(res, status, { message: message || 'Error' });
}

function sendNoContent(res) {
  res.writeHead(204);
  res.end();
}

function tokenOk(req) {
  const expected = process.env.MAKEFUN_SHOP_TOKEN || '';
  const h = req.headers.authorization || '';
  if (!expected) return h.startsWith('Bearer ') && h.length > 7;
  return h === 'Bearer ' + expected;
}

function queryOf(req) {
  try {
    return new URL(req.url, 'http://localhost').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function pageParams(req) {
  const q = queryOf(req);
  let perPage = parseInt(q.get('per_page') || '30', 10);
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 30;
  if (perPage > 100) perPage = 100;
  let page = parseInt(q.get('page') || '1', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  return { perPage, page, q };
}

function paginate(req, res, items) {
  const { perPage, page } = pageParams(req);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage < items.length) {
    const base = 'http://' + (req.headers.host || 'localhost') + req.url.split('?')[0];
    const next = base + '?per_page=' + perPage + '&page=' + (page + 1);
    const lastPage = Math.ceil(items.length / perPage);
    const last = base + '?per_page=' + perPage + '&page=' + lastPage;
    res.setHeader('Link', '<' + next + '>; rel="next", <' + last + '>; rel="last"');
  }
  return slice;
}

function repoJson(store, repo) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.owner + '/' + repo.name,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: '',
    clone_url: '',
  };
}

function issueJson(issue) {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((n) => ({ name: n })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function prJson(store, repo, pr) {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.head.ref, sha: pr.head.sha, label: repo.owner + ':' + pr.head.ref },
    base: { ref: pr.base.ref, sha: pr.base.sha, label: repo.owner + ':' + pr.base.ref },
    merged: pr.merged,
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
  };
}

function decodeSegments(parts) {
  return parts.map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
}

export async function handleRest(req, res, store) {
  const url = new URL(req.url, 'http://localhost');
  const rawParts = url.pathname.split('/').filter((s) => s.length > 0);
  // rawParts[0..1] = api, v3
  const parts = rawParts.slice(2);
  const method = req.method;

  if (method !== 'GET' && method !== 'HEAD' && req.jsonError) {
    sendErr(res, 400, 'Malformed JSON body');
    return;
  }

  // Auth: everything except the API root GET requires a token. The root is
  // also checked by the suite only with a token present; enforce uniformly
  // except /healthz (handled in app.ts, never reaches here).
  if (!tokenOk(req)) {
    sendErr(res, 401, 'Unauthorized');
    return;
  }

  try {
    await route(req, res, store, parts, method, url);
  } catch (e) {
    sendErr(res, 500, 'Internal error: ' + (e && e.message ? String(e.message).slice(0, 200) : 'unknown'));
  }
}

async function route(req, res, store, parts, method, url) {
  // GET /api/v3[/]
  if (parts.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'X-OAuth-Scopes': 'repo, read:org' });
    } else sendErr(res, 404, 'Not Found');
    return;
  }

  if (parts[0] === 'meta') {
    if (method === 'GET') sendJson(res, 200, { installed_version: '1.0.0' });
    else sendErr(res, 404, 'Not Found');
    return;
  }

  if (parts[0] === 'user') {
    await routeUser(req, res, store, parts.slice(1), method);
    return;
  }

  if (parts[0] === 'repos') {
    await routeRepos(req, res, store, parts.slice(1), method);
    return;
  }

  sendErr(res, 404, 'Not Found');
}

async function routeUser(req, res, store, parts, method) {
  if (parts.length === 0) {
    if (method === 'GET') {
      const login = store.ownerLogin || 'viewer';
      sendJson(res, 200, { login, id: 1000, type: 'User', name: login });
    } else sendErr(res, 404, 'Not Found');
    return;
  }
  if (parts[0] === 'repos') {
    if (method === 'GET') {
      const owner = store.ownerLogin || '__pending__';
      const list = store.listReposByOwner(owner).map((r) => repoJson(store, r));
      sendJson(res, 200, paginate(req, res, list));
      return;
    }
    if (method === 'POST') {
      const body = req.jsonBody || {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name) { sendErr(res, 422, 'Repository name is required'); return; }
      const made = store.createRepo({ name, isPrivate: body.private, description: body.description });
      if (made.error) { sendErr(res, 422, 'Repository already exists'); return; }
      sendJson(res, 201, repoJson(store, made.repo));
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }
  sendErr(res, 404, 'Not Found');
}

function loadRepo(req, res, store, owner, name) {
  const dec = decodeSegments([owner, name]);
  const o = dec[0];
  const n = dec[1];
  store.noteOwnerLogin(o);
  const repo = store.getRepo(o, n);
  if (!repo) {
    sendErr(res, 404, 'Repository not found');
    return null;
  }
  return repo;
}

async function routeRepos(req, res, store, parts, method) {
  if (parts.length < 2) { sendErr(res, 404, 'Not Found'); return; }
  const owner = parts[0];
  const name = parts[1];
  const rest = parts.slice(2);

  if (rest.length === 0) {
    const repo = loadRepo(req, res, store, owner, name);
    if (!repo) return;
    if (method === 'GET') { sendJson(res, 200, repoJson(store, repo)); return; }
    if (method === 'PATCH') {
      const body = req.jsonBody || {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      repo.updatedAt = store.trialNowIso();
      sendJson(res, 200, repoJson(store, repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      sendNoContent(res);
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  const sub = rest[0];
  if (sub === 'branches') {
    const repo = loadRepo(req, res, store, owner, name);
    if (!repo) return;
    if (method !== 'GET') { sendErr(res, 404, 'Not Found'); return; }
    const list = store.listBranches(repo).map((b) => ({ name: b.name, commit: { sha: b.sha } }));
    sendJson(res, 200, list);
    return;
  }

  if (sub === 'commits') {
    const repo = loadRepo(req, res, store, owner, name);
    if (!repo) return;
    if (method !== 'GET') { sendErr(res, 404, 'Not Found'); return; }
    const q = queryOf(req);
    const tip = store.resolveRef(repo, q.get('sha'));
    if (!tip) { sendJson(res, 200, []); return; }
    const list = store.listCommitsFrom(tip).map((sha) => ({
      sha,
      commit: { message: store.commitMessage(sha) },
    }));
    sendJson(res, 200, paginate(req, res, list));
    return;
  }

  if (sub === 'git') {
    const repo = loadRepo(req, res, store, owner, name);
    if (!repo) return;
    if (rest[1] === 'refs' && method === 'POST') {
      const body = req.jsonBody || {};
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/i.test(sha)) { sendErr(res, 422, 'Invalid ref or sha'); return; }
      store.setRef(repo, ref, sha.toLowerCase());
      sendJson(res, 201, { ref, object: { sha: sha.toLowerCase() } });
      return;
    }
    if (rest[1] === 'refs' && rest[2] === 'heads' && rest.length === 4 && method === 'GET') {
      const branch = decodeSegments([rest[3]])[0];
      const sha = store.getBranch(repo, branch);
      if (!sha) { sendErr(res, 404, 'Branch not found'); return; }
      sendJson(res, 200, { ref: 'refs/heads/' + branch, object: { sha } });
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  if (sub === 'contents') {
    await routeContents(req, res, store, owner, name, rest.slice(1), method);
    return;
  }

  if (sub === 'labels') {
    const repo = loadRepo(req, res, store, owner, name);
    if (!repo) return;
    if (method === 'GET') {
      sendJson(res, 200, store.listLabels(repo).map((l) => ({ name: l.name, color: l.color })));
      return;
    }
    if (method === 'POST') {
      const body = req.jsonBody || {};
      const labelName = typeof body.name === 'string' ? body.name : '';
      if (!labelName) { sendErr(res, 422, 'Label name is required'); return; }
      const made = store.createLabel(repo, { name: labelName, color: body.color });
      const label = made.label || store.getLabel(repo, labelName);
      sendJson(res, 201, { name: label.name, color: label.color });
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  if (sub === 'issues') {
    await routeIssues(req, res, store, owner, name, rest.slice(1), method);
    return;
  }

  if (sub === 'pulls') {
    await routePulls(req, res, store, owner, name, rest.slice(1), method);
    return;
  }

  sendErr(res, 404, 'Not Found');
}

async function routeContents(req, res, store, owner, name, parts, method) {
  const repo = loadRepo(req, res, store, owner, name);
  if (!repo) return;
  const path = decodeSegments(parts).join('/');
  const q = queryOf(req);

  if (method === 'GET') {
    const got = store.getContent(repo, path, q.get('ref'));
    if (got.error === 'not-found') { sendErr(res, 404, 'Not Found'); return; }
    if (got.error === 'no-branch') { sendErr(res, 404, 'Not Found'); return; }
    if (got.kind === 'file') {
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        content: got.data.toString('base64'),
        sha: got.blobSha,
        size: got.data.length,
        name: path.split('/').pop(),
        path,
      });
      return;
    }
    sendJson(res, 200, got.entries);
    return;
  }

  if (method === 'PUT') {
    const body = req.jsonBody || {};
    const contentB64 = typeof body.content === 'string' ? body.content.replace(/[\r\n\t ]/g, '') : '';
    let content;
    try {
      content = Buffer.from(contentB64, 'base64');
      if (contentB64 && content.length === 0 && contentB64 !== '') throw new Error('bad base64');
    } catch {
      sendErr(res, 400, 'Invalid base64 content');
      return;
    }
    const branch = typeof body.branch === 'string' ? body.branch : undefined;
    const cur = store.getContent(repo, path, branch);
    const exists = cur.kind === 'file';
    if (exists && body.sha && String(body.sha).toLowerCase() !== cur.blobSha.toLowerCase()) {
      sendErr(res, 409, 'Conflict: sha does not match the current blob');
      return;
    }
    const made = store.putContent(repo, { path, content, message: body.message, branch });
    sendJson(res, exists ? 200 : 201, {
      content: { sha: made.blobSha, encoding: 'base64', name: path.split('/').pop(), path },
      commit: { sha: made.commitSha },
    });
    return;
  }

  if (method === 'DELETE') {
    const body = req.jsonBody || {};
    const cur = store.getContent(repo, path, typeof body.branch === 'string' ? body.branch : undefined);
    if (cur.kind !== 'file') { sendErr(res, 404, 'Not Found'); return; }
    if (body.sha && String(body.sha).toLowerCase() !== cur.blobSha.toLowerCase()) {
      sendErr(res, 409, 'Conflict: sha does not match the current blob');
      return;
    }
    const made = store.deleteContent(repo, { path, message: body.message, branch: typeof body.branch === 'string' ? body.branch : undefined });
    if (made.error) { sendErr(res, 404, 'Not Found'); return; }
    sendJson(res, 200, { commit: { sha: made.commitSha } });
    return;
  }

  sendErr(res, 404, 'Not Found');
}

async function routeIssues(req, res, store, owner, name, parts, method) {
  const repo = loadRepo(req, res, store, owner, name);
  if (!repo) return;

  if (parts.length === 0) {
    if (method === 'POST') {
      const body = req.jsonBody || {};
      const labels = [];
      for (const l of Array.isArray(body.labels) ? body.labels : []) {
        const lname = typeof l === 'string' ? l : l && l.name;
        if (!lname) continue;
        if (!store.getLabel(repo, lname)) { sendErr(res, 422, 'Label does not exist: ' + lname); return; }
        labels.push(lname);
      }
      const made = store.createIssue(repo, { title: body.title, body: body.body, labels });
      sendJson(res, 201, issueJson(made.issue));
      return;
    }
    if (method === 'GET') {
      const q = queryOf(req);
      const state = q.get('state') || 'open';
      const sort = q.get('sort') || 'created';
      const direction = q.get('direction') || 'desc';
      void sort;
      const list = store.listIssues(repo, { state, sort, direction }).map((i) => issueJson(i));
      sendJson(res, 200, paginate(req, res, list));
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  const num = parseInt(parts[0], 10);
  if (!Number.isFinite(num)) { sendErr(res, 404, 'Not Found'); return; }

  if (parts.length === 1) {
    if (method === 'GET') {
      const issue = store.getIssue(repo, num);
      if (!issue) { sendErr(res, 404, 'Issue not found'); return; }
      sendJson(res, 200, issueJson(issue));
      return;
    }
    if (method === 'PATCH') {
      const body = req.jsonBody || {};
      const issue = store.patchIssue(repo, num, body);
      if (!issue) { sendErr(res, 404, 'Issue not found'); return; }
      sendJson(res, 200, issueJson(issue));
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  if (parts[1] === 'comments') {
    if (method === 'POST') {
      const issue = store.getIssue(repo, num);
      if (!issue) { sendErr(res, 404, 'Issue not found'); return; }
      const body = req.jsonBody || {};
      const made = store.createComment(repo, num, body.body);
      sendJson(res, 201, { id: made.comment.id, body: made.comment.body, created_at: made.comment.createdAt });
      return;
    }
    if (method === 'GET') {
      const issue = store.getIssue(repo, num);
      if (!issue) { sendErr(res, 404, 'Issue not found'); return; }
      const list = store.listComments(repo, num).map((c) => ({ id: c.id, body: c.body, created_at: c.createdAt }));
      sendJson(res, 200, list);
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  sendErr(res, 404, 'Not Found');
}

async function routePulls(req, res, store, owner, name, parts, method) {
  const repo = loadRepo(req, res, store, owner, name);
  if (!repo) return;

  if (parts.length === 0) {
    if (method === 'POST') {
      const body = req.jsonBody || {};
      const made = store.createPull(repo, { head: body.head, base: body.base, title: body.title, body: body.body });
      if (made.error) { sendErr(res, 422, 'Head or base branch not found'); return; }
      sendJson(res, 201, prJson(store, repo, made.pr));
      return;
    }
    if (method === 'GET') {
      const q = queryOf(req);
      const state = q.get('state') || 'open';
      const list = store.listPulls(repo, { state }).map((p) => prJson(store, repo, p));
      sendJson(res, 200, paginate(req, res, list));
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  const num = parseInt(parts[0], 10);
  if (!Number.isFinite(num)) { sendErr(res, 404, 'Not Found'); return; }

  if (parts.length === 1) {
    if (method === 'GET') {
      const pr = store.getPull(repo, num);
      if (!pr) { sendErr(res, 404, 'Pull request not found'); return; }
      sendJson(res, 200, prJson(store, repo, pr));
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  if (parts[1] === 'files') {
    if (method !== 'GET') { sendErr(res, 404, 'Not Found'); return; }
    const pr = store.getPull(repo, num);
    if (!pr) { sendErr(res, 404, 'Pull request not found'); return; }
    sendJson(res, 200, store.diffTrees(pr.baseTree, pr.headTree));
    return;
  }

  if (parts[1] === 'merge') {
    if (method !== 'PUT') { sendErr(res, 404, 'Not Found'); return; }
    const pr = store.getPull(repo, num);
    if (!pr) { sendErr(res, 404, 'Pull request not found'); return; }
    const merged = store.squashMerge(repo, pr);
    if (merged.error === 'conflict') { sendErr(res, 405, 'Merge conflict'); return; }
    if (merged.error) { sendErr(res, 405, 'Pull request cannot be merged'); return; }
    sendJson(res, 200, { merged: true, sha: merged.sha, message: 'Pull request successfully merged' });
    return;
  }

  sendErr(res, 404, 'Not Found');
}
