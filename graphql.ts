// graphql.ts — a small GraphQL v4 executor for the documents gh and
// github-mcp-server send: a real tokenizer + recursive-descent parser, then
// field resolution against the shared store. No GraphQL library.
// Spec: digest-graphql-mcp.md Part A.
import { Buffer } from 'node:buffer';

// ---------- lexer ----------
function lex(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '.' && src.slice(i, i + 3) === '...') { tokens.push({ kind: '...', value: '...' }); i += 3; continue; }
    if ('!$()[]{}:=@'.includes(ch)) { tokens.push({ kind: ch, value: ch }); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      let isFloat = false;
      if (src[j] === '.') { isFloat = true; while (j < src.length && /[0-9.]/.test(src[j])) j += 1; }
      const text = src.slice(i, j);
      tokens.push({ kind: isFloat ? 'float' : 'int', value: isFloat ? parseFloat(text) : parseInt(text, 10) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error('Unexpected character ' + JSON.stringify(ch));
  }
  tokens.push({ kind: 'eof', value: null });
  return tokens;
}

// ---------- parser ----------
function parseDocument(src) {
  const tokens = lex(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (kind) => {
    const t = next();
    if (t.kind !== kind) throw new Error('Expected ' + kind + ' but got ' + t.kind);
    return t;
  };
  const isPunct = (k) => peek().kind === k;
  const isName = (v) => peek().kind === 'name' && (v === undefined || peek().value === v);

  function parseValue() {
    const t = peek();
    if (t.kind === '$') { next(); return { kind: 'variable', name: expect('name').value }; }
    if (t.kind === 'int' || t.kind === 'float') { next(); return { kind: 'literal', value: t.value }; }
    if (t.kind === 'string') { next(); return { kind: 'literal', value: t.value }; }
    if (t.kind === 'name') {
      next();
      if (t.value === 'true') return { kind: 'literal', value: true };
      if (t.value === 'false') return { kind: 'literal', value: false };
      if (t.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === '[') {
      next();
      const items = [];
      while (!isPunct(']')) items.push(parseValue());
      expect(']');
      return { kind: 'list', items };
    }
    if (t.kind === '{') {
      next();
      const fields = [];
      while (!isPunct('}')) {
        const name = expect('name').value;
        expect(':');
        fields.push({ name, value: parseValue() });
      }
      expect('}');
      return { kind: 'object', fields };
    }
    throw new Error('Unexpected value token ' + t.kind);
  }

  function parseArguments() {
    const args = {};
    if (!isPunct('(')) return args;
    next();
    while (!isPunct(')')) {
      const name = expect('name').value;
      expect(':');
      args[name] = parseValue();
    }
    expect(')');
    return args;
  }

  function parseDirectives() {
    while (isPunct('@')) {
      next();
      expect('name');
      parseArguments();
    }
  }

  function parseSelectionSet() {
    expect('{');
    const sels = [];
    while (!isPunct('}')) sels.push(parseSelection());
    expect('}');
    return sels;
  }

  function parseSelection() {
    if (isPunct('...')) {
      next();
      if (isName('on')) {
        next();
        const typeCond = expect('name').value;
        parseDirectives();
        return { kind: 'inlineFragment', typeCondition: typeCond, selections: parseSelectionSet() };
      }
      if (peek().kind === 'name') {
        const name = next().value;
        parseDirectives();
        return { kind: 'fragmentSpread', name };
      }
      parseDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selections: parseSelectionSet() };
    }
    let alias = null;
    let name = expect('name').value;
    if (isPunct(':')) {
      next();
      alias = name;
      name = expect('name').value;
    }
    const args = parseArguments();
    parseDirectives();
    const selections = isPunct('{') ? parseSelectionSet() : null;
    return { kind: 'field', name, alias: alias || name, args, selections };
  }

  function parseType() {
    if (isPunct('[')) {
      next();
      const inner = parseType();
      expect(']');
      if (isPunct('!')) next();
      return { kind: 'list', of: inner };
    }
    const name = expect('name').value;
    if (isPunct('!')) next();
    return { kind: 'named', name };
  }

  function parseOperation() {
    let kind = 'query';
    let name = null;
    if (isName('query') || isName('mutation') || isName('subscription')) {
      kind = next().value;
      if (peek().kind === 'name') name = next().value;
    }
    const varDefs = {};
    if (isPunct('(')) {
      next();
      while (!isPunct(')')) {
        expect('$');
        const vname = expect('name').value;
        expect(':');
        parseType();
        if (isPunct('=')) { next(); parseValue(); }
        varDefs[vname] = true;
      }
      expect(')');
    }
    parseDirectives();
    return { kind, name, varDefs, selections: parseSelectionSet() };
  }

  const operations = [];
  const fragments = {};
  while (peek().kind !== 'eof') {
    if (isName('fragment')) {
      next();
      const fname = expect('name').value;
      expect('name'); // 'on'
      const typeCond = expect('name').value;
      parseDirectives();
      fragments[fname] = { typeCondition: typeCond, selections: parseSelectionSet() };
    } else {
      operations.push(parseOperation());
    }
  }
  return { operations, fragments };
}

function evalValue(node, variables) {
  switch (node.kind) {
    case 'variable': return variables ? variables[node.name] : undefined;
    case 'literal': return node.value;
    case 'enum': return node.value;
    case 'list': return node.items.map((v) => evalValue(v, variables));
    case 'object': {
      const out = {};
      for (const f of node.fields) out[f.name] = evalValue(f.value, variables);
      return out;
    }
    default: return undefined;
  }
}

// ---------- schema knowledge (field sets for validation + introspection) ----------
const TYPE_FIELDS = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['login'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'title', 'body'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes'],
  Node: ['id'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node'],
  Comment: ['id', 'body'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const ENUM_VALUES = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function encodeCursor(number) {
  return Buffer.from('cursor:' + number, 'utf8').toString('base64');
}

function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = text.match(/^cursor:(\d+)$/);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

// ---------- executor ----------
function executeDocument(doc, variables, store, operationName) {
  const errors = [];
  let op = null;
  if (operationName) op = doc.operations.find((o) => o.name === operationName) || null;
  if (!op) op = doc.operations[0] || null;
  if (!op) {
    return { data: null, errors: [{ message: 'No operation provided' }] };
  }
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const rootSource = { __typename: rootType };
  const data = executeSelections(rootType, rootSource, op.selections, variables, store, doc, errors);
  const out = { data };
  if (errors.length) out.errors = errors;
  return out;
}

function executeSelections(typeName, source, selections, variables, store, doc, errors) {
  const out = {};
  for (const sel of selections) {
    if (sel.kind === 'fragmentSpread') {
      const frag = doc.fragments[sel.name];
      if (!frag) continue;
      if (frag.typeCondition && frag.typeCondition !== typeName && frag.typeCondition !== source.__typename) continue;
      const sub = executeSelections(typeName, source, frag.selections, variables, store, doc, errors);
      Object.assign(out, sub);
      continue;
    }
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition && sel.typeCondition !== typeName && sel.typeCondition !== source.__typename) continue;
      const sub = executeSelections(typeName, source, sel.selections, variables, store, doc, errors);
      Object.assign(out, sub);
      continue;
    }
    // field
    const fields = TYPE_FIELDS[typeName] || [];
    if (sel.name !== '__typename' && !fields.includes(sel.name)) {
      errors.push({ message: 'Cannot query field "' + sel.name + '" on type "' + typeName + '".' });
      continue;
    }
    const args = {};
    for (const k of Object.keys(sel.args || {})) args[k] = evalValue(sel.args[k], variables);
    const value = resolveField(typeName, source, sel.name, args, store, errors);
    if (value === undefined) continue;
    if (sel.selections && value !== null && typeof value === 'object') {
      if (Array.isArray(value)) {
        out[sel.alias] = value.map((v) => (v && typeof v === 'object' && v.__typename)
          ? executeSelections(v.__typename, v, sel.selections, variables, store, doc, errors)
          : v);
      } else if (value.__typename) {
        out[sel.alias] = executeSelections(value.__typename, value, sel.selections, variables, store, doc, errors);
      } else {
        out[sel.alias] = value;
      }
    } else {
      out[sel.alias] = value;
    }
  }
  return out;
}

function issueStateOut(issue) {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prStateOut(pr) {
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueWrapper(repo, issue) {
  return { __typename: 'Issue', repo, issue };
}

function prWrapper(repo, pr) {
  return { __typename: 'PullRequest', repo, pr };
}

function paginateIssues(repo, issues, args) {
  let list = issues.slice();
  if (Array.isArray(args.states) && args.states.length) {
    const wanted = new Set(args.states.map((s) => String(s).toUpperCase()));
    list = list.filter((i) => wanted.has(issueStateOut(i)));
  }
  const orderBy = args.orderBy || {};
  const field = String(orderBy.field || 'CREATED_AT').toUpperCase();
  const dir = String(orderBy.direction || 'DESC').toUpperCase();
  void field;
  list.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return dir === 'ASC' ? (a.createdAt < b.createdAt ? -1 : 1) : (a.createdAt > b.createdAt ? -1 : 1);
    return dir === 'ASC' ? a.number - b.number : b.number - a.number;
  });
  let start = 0;
  if (args.after !== undefined && args.after !== null) {
    const afterNum = decodeCursor(args.after);
    if (afterNum !== null) {
      const idx = list.findIndex((i) => i.number === afterNum);
      if (idx >= 0) start = idx + 1;
    }
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  const endCursor = page.length ? encodeCursor(page[page.length - 1].number) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((i) => issueWrapper(repo, i)),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

function resolveField(typeName, source, field, args, store, errors) {
  if (field === '__typename') return source.__typename || typeName;

  if (typeName === 'Query') {
    if (field === 'viewer') return { __typename: 'User', login: store.ownerLogin || 'viewer' };
    if (field === 'repository') {
      const owner = args.owner;
      const name = args.name;
      if (typeof owner === 'string') store.noteOwnerLogin(owner);
      const repo = store.getRepo(owner, name);
      if (!repo) return null;
      return { __typename: 'Repository', repo };
    }
    if (field === 'node') {
      const found = store.findByGlobalId(args.id);
      if (!found) return null;
      if (found.kind === 'repo') return { __typename: 'Repository', repo: found.repo };
      if (found.kind === 'issue') return { __typename: 'Issue', repo: found.repo, issue: found.issue };
      if (found.kind === 'pr') return { __typename: 'PullRequest', repo: found.repo, pr: found.pr };
      if (found.kind === 'comment') return { __typename: 'Comment', id: found.comment.globalId, body: found.comment.body };
      return null;
    }
    if (field === '__type') {
      const tname = args.name;
      const fields = TYPE_FIELDS[tname];
      const enums = ENUM_VALUES[tname];
      if (!fields && !enums) return null;
      return {
        __typename: '__Type',
        name: tname,
        fields: fields ? fields.map((n) => ({ __typename: '__Field', name: n })) : null,
        enumValues: enums ? enums.map((n) => ({ __typename: '__EnumValue', name: n })) : null,
      };
    }
    return null;
  }

  if (typeName === 'Mutation') {
    if (field === 'createIssue') {
      const input = args.input || {};
      const found = store.findByGlobalId(input.repositoryId);
      if (!found || found.kind !== 'repo') { errors.push({ message: 'Repository not found: ' + String(input.repositoryId) }); return null; }
      const made = store.createIssue(found.repo, { title: input.title, body: input.body, labels: [] });
      return { __typename: 'CreateIssuePayload', issue: issueWrapper(found.repo, made.issue) };
    }
    if (field === 'closeIssue') {
      const input = args.input || {};
      const found = store.findByGlobalId(input.issueId);
      if (!found || found.kind !== 'issue') { errors.push({ message: 'Issue not found: ' + String(input.issueId) }); return null; }
      const issue = store.patchIssue(found.repo, found.issue.number, { state: 'closed' });
      return { __typename: 'CloseIssuePayload', issue: issueWrapper(found.repo, issue) };
    }
    if (field === 'createPullRequest') {
      const input = args.input || {};
      const found = store.findByGlobalId(input.repositoryId);
      if (!found || found.kind !== 'repo') { errors.push({ message: 'Repository not found: ' + String(input.repositoryId) }); return null; }
      const made = store.createPull(found.repo, { head: input.headRefName, base: input.baseRefName, title: input.title, body: input.body || '' });
      if (made.error) { errors.push({ message: 'Head or base branch not found' }); return null; }
      return { __typename: 'CreatePullRequestPayload', pullRequest: prWrapper(found.repo, made.pr) };
    }
    if (field === 'mergePullRequest') {
      const input = args.input || {};
      const found = store.findByGlobalId(input.pullRequestId);
      if (!found || found.kind !== 'pr') { errors.push({ message: 'Pull request not found: ' + String(input.pullRequestId) }); return null; }
      const merged = store.squashMerge(found.repo, found.pr);
      if (merged.error) { errors.push({ message: 'Pull request cannot be merged' }); return null; }
      return { __typename: 'MergePullRequestPayload', pullRequest: prWrapper(found.repo, found.pr) };
    }
    if (field === 'addComment') {
      const input = args.input || {};
      const found = store.findByGlobalId(input.subjectId);
      if (!found || found.kind !== 'issue') { errors.push({ message: 'Subject not found: ' + String(input.subjectId) }); return null; }
      const made = store.createComment(found.repo, found.issue.number, input.body);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'CommentEdge', node: { __typename: 'Comment', id: made.comment.globalId, body: made.comment.body } },
      };
    }
    return null;
  }

  if (typeName === 'User') {
    if (field === 'login') return source.login;
    return null;
  }

  if (typeName === 'Repository') {
    const repo = source.repo;
    switch (field) {
      case 'id': return store.repoGlobalId(repo);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return repo.owner + '/' + repo.name;
      case 'owner': return { __typename: 'User', login: repo.owner };
      case 'defaultBranchRef': {
        const tip = store.getRef(repo, 'refs/heads/' + repo.defaultBranch);
        if (!tip) return null;
        return { __typename: 'Ref', name: repo.defaultBranch };
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'issue': {
        const issue = store.getIssue(repo, args.number);
        return issue ? issueWrapper(repo, issue) : null;
      }
      case 'issues': return paginateIssues(repo, repo.issues, args);
      case 'pullRequests': {
        let list = repo.pulls.slice();
        const first = typeof args.first === 'number' ? args.first : list.length;
        return { __typename: 'PullRequestConnection', nodes: list.slice(0, first).map((p) => prWrapper(repo, p)) };
      }
      case 'pullRequest': {
        const pr = store.getPull(repo, args.number);
        return pr ? prWrapper(repo, pr) : null;
      }
      default: return null;
    }
  }

  if (typeName === 'Ref') {
    if (field === 'name') return source.name;
    return null;
  }

  if (typeName === 'Issue') {
    const issue = source.issue;
    switch (field) {
      case 'id': return issue.id;
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issueStateOut(issue);
      case 'body': return issue.body;
      default: return null;
    }
  }

  if (typeName === 'IssueConnection') {
    if (field === 'nodes') return source.nodes;
    if (field === 'pageInfo') return source.pageInfo;
    if (field === 'totalCount') return source.nodes.length;
    return null;
  }

  if (typeName === 'PageInfo') {
    if (field === 'hasNextPage') return source.hasNextPage;
    if (field === 'endCursor') return source.endCursor;
    if (field === 'hasPreviousPage') return false;
    if (field === 'startCursor') return null;
    return null;
  }

  if (typeName === 'PullRequest') {
    const pr = source.pr;
    const repo = source.repo;
    switch (field) {
      case 'id': return pr.id;
      case 'number': return pr.number;
      case 'title': return pr.title;
      case 'body': return pr.body;
      case 'state': return prStateOut(pr);
      case 'merged': return pr.merged;
      case 'headRefName': return pr.head.ref;
      case 'baseRefName': return pr.base.ref;
      case 'mergeable': return store.mergeableFor(repo, pr);
      case 'files': {
        const files = store.diffTrees(pr.baseTree, pr.headTree);
        const first = typeof args.first === 'number' ? args.first : files.length;
        return {
          __typename: 'PullRequestConnection',
          nodes: files.slice(0, first).map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename, additions: f.additions, deletions: f.deletions, changes: f.changes })),
        };
      }
      default: return null;
    }
  }

  if (typeName === 'PullRequestConnection') {
    if (field === 'nodes') return source.nodes;
    if (field === 'pageInfo') return { __typename: 'PageInfo', hasNextPage: false, endCursor: null };
    if (field === 'totalCount') return source.nodes.length;
    return null;
  }

  if (typeName === 'PullRequestChangedFile') {
    if (field === 'path') return source.path;
    if (field === 'additions') return source.additions || 0;
    if (field === 'deletions') return source.deletions || 0;
    if (field === 'changes') return source.changes || 0;
    return null;
  }

  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    if (field === 'issue') return source.issue;
    return null;
  }
  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    if (field === 'pullRequest') return source.pullRequest;
    return null;
  }
  if (typeName === 'AddCommentPayload') {
    if (field === 'commentEdge') return source.commentEdge;
    return null;
  }
  if (typeName === 'CommentEdge') {
    if (field === 'node') return source.node;
    return null;
  }
  if (typeName === 'Comment') {
    if (field === 'id') return source.id;
    if (field === 'body') return source.body;
    return null;
  }
  if (typeName === '__Type') {
    if (field === 'name') return source.name;
    if (field === 'fields') return source.fields;
    if (field === 'enumValues') return source.enumValues;
    return null;
  }
  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (field === 'name') return source.name;
    return null;
  }
  if (typeName === 'Node') {
    if (field === 'id') {
      if (source.repo) return store.repoGlobalId(source.repo);
      if (source.issue) return source.issue.id;
      if (source.pr) return source.pr.id;
      return null;
    }
    return null;
  }
  return null;
}

// ---------- HTTP handler ----------
function tokenOkGraphql(req) {
  const expected = process.env.MAKEFUN_SHOP_TOKEN || '';
  const h = req.headers.authorization || '';
  if (!expected) return h.startsWith('Bearer ') && h.length > 7;
  return h === 'Bearer ' + expected;
}

function sendJsonGraphql(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export async function handleGraphql(req, res, store) {
  if (req.method !== 'POST') {
    sendJsonGraphql(res, 404, { message: 'Not Found' });
    return;
  }
  if (!tokenOkGraphql(req)) {
    sendJsonGraphql(res, 401, { message: 'Unauthorized' });
    return;
  }
  if (req.jsonError) {
    sendJsonGraphql(res, 400, { errors: [{ message: 'Malformed JSON body' }] });
    return;
  }
  const body = req.jsonBody;
  if (!body || typeof body !== 'object') {
    sendJsonGraphql(res, 400, { errors: [{ message: 'Request body must be a JSON object' }] });
    return;
  }
  const runOne = (op) => {
    if (!op || typeof op.query !== 'string') return { data: null, errors: [{ message: 'No query provided' }] };
    let doc;
    try {
      doc = parseDocument(op.query);
    } catch (e) {
      return { data: null, errors: [{ message: String((e && e.message) || e) }] };
    }
    return executeDocument(doc, op.variables || {}, store, op.operationName);
  };
  if (Array.isArray(body)) {
    sendJsonGraphql(res, 200, body.map((op) => runOne(op)));
    return;
  }
  sendJsonGraphql(res, 200, runOne(body));
}
