// mcp.ts — Model Context Protocol endpoint: JSON-RPC 2.0 over Streamable
// HTTP. Modern era (revision 2026-07-28) via server/discover, with a legacy
// initialize handshake fallback. Tools share the store with REST.
// Spec: digest-graphql-mcp.md Part B.
import { Buffer } from 'node:buffer';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository' },
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const ALIASES = {
  create_repo: ['create_repository', 'repo_create', 'repos_create', 'repository_create'],
  get_repo: ['get_repository', 'repo_get', 'repos_get', 'repository_get'],
  create_issue: ['issue_create', 'issues_create'],
  list_issues: ['issues_list', 'issue_list'],
  create_pull_request: ['pull_request_create', 'pulls_create', 'create_pr', 'pr_create'],
  merge_pull_request: ['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge'],
};

const SYNONYMS = {
  owner: ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'],
  repo: ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'],
  title: ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'],
  body: ['body', 'issue_body', 'description', 'content', 'text', 'comment'],
  head: ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch'],
  base: ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch'],
  pull_number: ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'],
  name: ['name', 'repo', 'repository', 'repository_name', 'repo_name'],
  description: ['description', 'about', 'summary', 'body'],
  private: ['private', 'is_private'],
  state: ['state', 'status'],
};

function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTool(name) {
  const n = norm(name);
  for (const t of TOOLS) {
    if (norm(t.name) === n) return t;
    if ((ALIASES[t.name] || []).some((a) => norm(a) === n)) return t;
    if (n.endsWith(norm(t.name))) return t;
  }
  return null;
}

function mapArgs(tool, args) {
  const out = {};
  const props = Object.keys(tool.inputSchema.properties || {});
  const byNorm = {};
  for (const p of props) byNorm[norm(p)] = p;
  // Canonical semantic keys the suite sends, mapped onto schema properties.
  const semanticKeys = ['owner', 'repo', 'title', 'body', 'head', 'base', 'pull_number', 'name', 'description', 'private', 'state'];
  for (const key of semanticKeys) {
    if (args[key] === undefined) continue;
    // Direct property match first.
    if (props.includes(key)) { out[key] = args[key]; continue; }
    // Synonym match.
    let placed = false;
    for (const syn of SYNONYMS[key] || []) {
      if (props.includes(syn)) { out[syn] = args[key]; placed = true; break; }
    }
    if (!placed) {
      // No matching property: keep the canonical key only if the schema has it.
      if (byNorm[norm(key)]) out[byNorm[norm(key)]] = args[key];
    }
  }
  // Pass through any other argument whose name matches a schema property.
  for (const k of Object.keys(args)) {
    if (out[k] === undefined && props.includes(k)) out[k] = args[k];
    if (out[k] === undefined && byNorm[norm(k)] && out[byNorm[norm(k)]] === undefined) {
      out[byNorm[norm(k)]] = args[k];
    }
  }
  // full_name fallback: "owner/repo" when the schema has no repo property.
  if (out.repo === undefined && typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [o, r] = args.full_name.split('/');
    if (props.includes('owner')) out.owner = o;
    if (props.includes('repo')) out.repo = r;
  }
  return out;
}

function toolResult(obj) {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj, isError: false };
}

function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function callTool(tool, args, store) {
  const name = tool.name;
  if (name === 'create_repo') {
    const owner = args.owner || store.ownerLogin || 'viewer';
    if (typeof args.owner === 'string') store.noteOwnerLogin(args.owner);
    const made = store.createRepo({ owner, name: args.name, isPrivate: args.private, description: args.description });
    if (made.error) return toolError('Repository already exists: ' + args.name);
    const repo = made.repo;
    return toolResult({
      full_name: repo.owner + '/' + repo.name,
      name: repo.name,
      owner: { login: repo.owner },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      id: repo.id,
    });
  }
  if (name === 'get_repo') {
    if (typeof args.owner === 'string') store.noteOwnerLogin(args.owner);
    const repo = store.getRepo(args.owner, args.repo);
    if (!repo) return toolError('Repository not found: ' + args.owner + '/' + args.repo);
    return toolResult({
      full_name: repo.owner + '/' + repo.name,
      name: repo.name,
      owner: { login: repo.owner },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      id: repo.id,
    });
  }
  if (name === 'create_issue') {
    if (typeof args.owner === 'string') store.noteOwnerLogin(args.owner);
    const repo = store.getRepo(args.owner, args.repo);
    if (!repo) return toolError('Repository not found: ' + args.owner + '/' + args.repo);
    const made = store.createIssue(repo, { title: args.title, body: args.body, labels: [] });
    const issue = made.issue;
    return toolResult({ number: issue.number, id: issue.id, title: issue.title, body: issue.body, state: 'open', labels: [] });
  }
  if (name === 'list_issues') {
    if (typeof args.owner === 'string') store.noteOwnerLogin(args.owner);
    const repo = store.getRepo(args.owner, args.repo);
    if (!repo) return toolError('Repository not found: ' + args.owner + '/' + args.repo);
    const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'all';
    const list = store.listIssues(repo, { state: state === 'all' ? 'all' : state, sort: 'created', direction: 'desc' });
    return toolResult({
      issues: list.map((i) => ({ number: i.number, id: i.id, title: i.title, body: i.body, state: i.state })),
    });
  }
  if (name === 'create_pull_request') {
    if (typeof args.owner === 'string') store.noteOwnerLogin(args.owner);
    const repo = store.getRepo(args.owner, args.repo);
    if (!repo) return toolError('Repository not found: ' + args.owner + '/' + args.repo);
    const made = store.createPull(repo, { head: args.head, base: args.base, title: args.title, body: args.body || '' });
    if (made.error) return toolError('Head or base branch not found');
    const pr = made.pr;
    return toolResult({
      number: pr.number, id: pr.id, title: pr.title, state: 'open',
      head: { ref: pr.head.ref, sha: pr.head.sha },
      base: { ref: pr.base.ref, sha: pr.base.sha },
    });
  }
  if (name === 'merge_pull_request') {
    if (typeof args.owner === 'string') store.noteOwnerLogin(args.owner);
    const repo = store.getRepo(args.owner, args.repo);
    if (!repo) return toolError('Repository not found: ' + args.owner + '/' + args.repo);
    const pr = store.getPull(repo, Number(args.pull_number));
    if (!pr) return toolError('Pull request not found: ' + args.pull_number);
    const merged = store.squashMerge(repo, pr);
    if (merged.error) return toolError('Pull request cannot be merged: ' + merged.error);
    return toolResult({ number: pr.number, merged: true, state: 'closed', sha: merged.sha });
  }
  return toolError('Unknown tool: ' + name);
}

function tokenOkMcp(req) {
  const expected = process.env.MAKEFUN_SHOP_TOKEN || '';
  const h = req.headers.authorization || '';
  if (!expected) return h.startsWith('Bearer ') && h.length > 7;
  return h === 'Bearer ' + expected;
}

function sendJsonMcp(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: err };
}

export async function handleMcp(req, res, store) {
  if (req.method === 'DELETE') {
    res.writeHead(200);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJsonMcp(res, 404, { message: 'Not Found' });
    return;
  }
  if (!tokenOkMcp(req)) {
    sendJsonMcp(res, 401, { message: 'Unauthorized' });
    return;
  }
  if (req.jsonError) {
    let id = null;
    const m = (req.rawBody || Buffer.alloc(0)).toString('utf8').match(/"id"\s*:\s*(\d+|"[^"]*")/);
    if (m) {
      try { id = JSON.parse(m[1]); } catch { id = null; }
    }
    sendJsonMcp(res, 400, rpcError(id, -32700, 'Parse error'));
    return;
  }
  const body = req.jsonBody;
  if (!body || typeof body !== 'object' || typeof body.method !== 'string') {
    sendJsonMcp(res, 400, rpcError(body && body.id !== undefined ? body.id : null, -32600, 'Invalid Request'));
    return;
  }
  const id = body.id;
  const method = body.method;
  const params = (body.params && typeof body.params === 'object') ? body.params : {};

  if (method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return;
  }

  // Protocol-version gate: a declared revision outside the supported list
  // is refused with -32022 (except initialize, which negotiates).
  const meta = params._meta || {};
  const declared = meta['io.modelcontextprotocol/protocolVersion'] || meta.protocolVersion;
  if (declared && method !== 'initialize' && !SUPPORTED_VERSIONS.includes(declared)) {
    sendJsonMcp(res, 200, rpcError(id, -32022, 'Unsupported protocol version: ' + declared, { supported: SUPPORTED_VERSIONS }));
    return;
  }

  if (method === 'server/discover') {
    sendJsonMcp(res, 200, rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS.slice(),
      serverInfo: { ...SERVER_INFO },
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
    }));
    return;
  }

  if (method === 'initialize') {
    const offered = params.protocolVersion;
    const negotiated = typeof offered === 'string' && SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    sendJsonMcp(res, 200, rpcResult(id, {
      protocolVersion: negotiated,
      serverInfo: { ...SERVER_INFO },
      capabilities: { tools: {} },
    }));
    return;
  }

  if (method === 'tools/list') {
    sendJsonMcp(res, 200, rpcResult(id, { tools: TOOLS }));
    return;
  }

  if (method === 'tools/call') {
    const toolName = params.name;
    const tool = typeof toolName === 'string' ? findTool(toolName) : null;
    if (!tool) {
      sendJsonMcp(res, 200, rpcError(id, -32602, 'Unknown tool: ' + String(toolName)));
      return;
    }
    const rawArgs = (params.arguments && typeof params.arguments === 'object') ? params.arguments : {};
    const args = mapArgs(tool, rawArgs);
    const required = tool.inputSchema.required || [];
    const missing = required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
    if (missing.length) {
      sendJsonMcp(res, 200, rpcResult(id, toolError('Missing required argument(s): ' + missing.join(', '))));
      return;
    }
    let result;
    try {
      result = callTool(tool, args, store);
    } catch (e) {
      result = toolError('Tool failed: ' + String((e && e.message) || e));
    }
    sendJsonMcp(res, 200, rpcResult(id, result));
    return;
  }

  if (method === 'ping') {
    sendJsonMcp(res, 200, rpcResult(id, {}));
    return;
  }

  sendJsonMcp(res, 200, rpcError(id, -32601, 'Method not found: ' + method));
}
