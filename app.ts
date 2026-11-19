// app.ts — HTTP server: body reading, request-id header, routing.
// Routes: GET /healthz (no auth), /api/v3/* (REST), /api/graphql,
// /mcp (MCP), /<owner>/<repo>.git/* (git smart HTTP). Anything else: 404 JSON.
import http from 'node:http';
import { Buffer } from 'node:buffer';
import { createStore } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git.ts';

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export function createApp() {
  const store = createStore();
  let reqCounter = 0;

  const server = http.createServer((req, res) => {
    reqCounter += 1;
    res.setHeader('X-GitHub-Request-Id', 'req-' + reqCounter);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('error', () => {
      if (!res.writableEnded) sendJson(res, 400, { message: 'Bad request' });
    });
    req.on('end', () => {
      req.rawBody = Buffer.concat(chunks);
      req.jsonBody = undefined;
      req.jsonError = false;
      const ct = req.headers['content-type'] || '';
      // Parse a JSON body only when the content type says JSON, or when
      // there is no content type at all (some clients omit it). Git smart
      // HTTP bodies are binary with an x-git-* content type: attempting
      // JSON.parse on every push pack wasted time and flagged jsonError.
      const mayBeJson = ct.includes('json') || (!ct && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE'));
      if (req.rawBody.length > 0 && mayBeJson) {
        try {
          req.jsonBody = JSON.parse(req.rawBody.toString('utf8'));
        } catch {
          req.jsonError = true;
        }
      }
      dispatch(req, res, store).catch(() => {
        if (!res.writableEnded) sendJson(res, 500, { message: 'Internal error' });
      });
    });
  });

  server.store = store;
  return server;
}

async function dispatch(req, res, store) {
  let path = '/';
  try {
    req.parsedUrl = new URL(req.url, 'http://localhost');
    path = req.parsedUrl.pathname;
  } catch {
    path = req.url || '/';
  }

  if (path === '/healthz') {
    if (req.method === 'GET') sendJson(res, 200, { ok: true });
    else sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRest(req, res, store);
    return;
  }

  if (path === '/api/graphql') {
    await handleGraphql(req, res, store);
    return;
  }

  if (path === '/mcp') {
    await handleMcp(req, res, store);
    return;
  }

  const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git(\/.*)?$/);
  if (gitMatch) {
    await handleGit(req, res, store);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
