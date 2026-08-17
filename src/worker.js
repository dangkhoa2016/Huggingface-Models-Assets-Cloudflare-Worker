const ASSET_PREFIX = '/assets/';
const DEFAULT_MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

function corsHeaders(initial = {}) {
  const headers = new Headers(initial);
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-expose-headers', '*');
  return headers;
}

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  const headers = corsHeaders({
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  return new Response(JSON.stringify(payload), { status, headers });
}

function parseAssetKey(url) {
  const rawPath = url.pathname;
  if (!rawPath.startsWith(ASSET_PREFIX) || /%2f|%5c/i.test(rawPath)) {
    return null;
  }

  const rawSegments = rawPath.slice(ASSET_PREFIX.length).split('/');
  if (rawSegments.length < 5 || rawSegments.some((segment) => !segment)) {
    return null;
  }

  let segments;
  try {
    segments = rawSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }

  if (
    segments[0] !== 'hf'
    || !segments[1]
    || !segments[2]
    || !COMMIT_RE.test(segments[3])
    || segments.some((segment) => segment === '.' || segment === '..' || /[\\\0\r\n]/.test(segment))
  ) {
    return null;
  }

  return `hf/${segments.slice(1).join('/')}`;
}

function constantTimeEqual(left, right) {
  const encoder = new TextEncoder();
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

function isAuthorized(request, env) {
  if (!env?.PUBLISH_TOKEN) return false;
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return false;
  return constantTimeEqual(header.slice(7), env.PUBLISH_TOKEN);
}

function isOWS(c) {
  return c === ' ' || c === '\t';
}

function parseEntityTagList(value) {
  if (value === '*') return ['*'];
  const tags = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && isOWS(value[i])) i++;
    if (i >= value.length) break;
    let weak = false;
    if (value[i] === 'W' && value[i + 1] === '/') { weak = true; i += 2; }
    if (value[i] !== '"') return null;
    i++;
    let tag = '';
    while (i < value.length && value[i] !== '"') {
      tag += value[i]; i++;
    }
    if (i >= value.length) return null;
    i++;
    tags.push({ weak, tag });
    while (i < value.length && isOWS(value[i])) i++;
    if (i < value.length && value[i] === ',') { i++; continue; }
    break;
  }
  while (i < value.length && isOWS(value[i])) i++;
  if (i !== value.length) return null;
  return tags.length > 0 ? tags : null;
}

function strongMatch(parsed, current) {
  for (const t of parsed) {
    if (t === '*' || (!t.weak && t.tag === current)) return true;
  }
  return false;
}

function weakMatch(parsed, current) {
  for (const t of parsed) {
    if (t === '*' || t.tag === current) return true;
  }
  return false;
}

function toHttpSecond(date) {
  return Math.floor(date.getTime() / 1000);
}

function formatHttpDate(date) {
  return date.toUTCString();
}

function maxUploadBytes(env) {
  const parsed = Number.parseInt(env?.MAX_UPLOAD_BYTES ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_UPLOAD_BYTES;
}

async function putAsset(request, env, key, pathname) {
  if (!env?.PUBLISH_TOKEN) {
    return jsonResponse({ error: 'Server Configuration Error', message: 'PUBLISH_TOKEN is not configured.' }, 500);
  }
  if (!isAuthorized(request, env)) {
    return jsonResponse(
      { error: 'Unauthorized', message: 'A valid publisher bearer token is required.' },
      401,
      { 'www-authenticate': 'Bearer' },
    );
  }

  const digest = request.headers.get('x-content-sha256') ?? '';
  if (!SHA256_RE.test(digest)) {
    return jsonResponse({ error: 'Bad Request', message: 'X-Content-SHA256 must be lowercase hexadecimal SHA-256.' }, 400);
  }

  const declaredLength = request.headers.get('content-length');
  if (declaredLength === null) {
    return jsonResponse({ error: 'Length Required', message: 'Content-Length is required for bounded uploads.' }, 411);
  }
  const length = Number.parseInt(declaredLength, 10);
  if (!Number.isSafeInteger(length) || length < 0) {
    return jsonResponse({ error: 'Bad Request', message: 'Content-Length is invalid.' }, 400);
  }
  if (length > maxUploadBytes(env)) {
    return jsonResponse({ error: 'Payload Too Large', message: 'The asset exceeds MAX_UPLOAD_BYTES.' }, 413);
  }

  const existing = await env.ASSETS.head(key);
  if (existing) {
    if (existing.customMetadata?.sha256 === digest) {
      return jsonResponse({ status: 'already_exists', key, url: pathname }, 200);
    }
    return jsonResponse({ error: 'Conflict', message: 'This immutable asset key already contains different content.' }, 409);
  }

  const stored = await env.ASSETS.put(key, request.body ?? new Uint8Array(), {
    onlyIf: new Headers({ 'if-none-match': '*' }),
    httpMetadata: {
      contentType: request.headers.get('content-type') || 'application/octet-stream',
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    },
    customMetadata: { sha256: digest },
    sha256: digest,
  });

  if (!stored) {
    const raced = await env.ASSETS.head(key);
    if (raced?.customMetadata?.sha256 === digest) {
      return jsonResponse({ status: 'already_exists', key, url: pathname }, 200);
    }
    return jsonResponse({ error: 'Conflict', message: 'This immutable asset key was written concurrently.' }, 409);
  }

  return jsonResponse({ status: 'created', key, url: pathname }, 201, { etag: stored.httpEtag });
}

function assetHeaders(object, ranged = false) {
  const headers = corsHeaders();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  if (!headers.has('cache-control')) {
    headers.set('cache-control', IMMUTABLE_CACHE_CONTROL);
  }
  if (object.uploaded) {
    headers.set('last-modified', formatHttpDate(object.uploaded));
  }

  if (ranged && object.range) {
    const start = object.range.offset ?? Math.max(0, object.size - object.range.suffix);
    const length = object.range.length ?? object.range.suffix ?? Math.max(0, object.size - start);
    const end = start + length - 1;
    headers.set('content-range', `bytes ${start}-${end}/${object.size}`);
    headers.set('content-length', String(length));
  } else {
    headers.set('content-length', String(object.size));
  }
  return headers;
}

function evaluatePreconditions(request, object) {
  const etag = object.httpEtag;
  const etagValue = etag !== null ? etag.replace(/^"(.*)"$/, '$1') : null;

  const ifMatch = request.headers.get('if-match');
  if (ifMatch !== null) {
    if (etagValue === null) return 412;
    const parsed = parseEntityTagList(ifMatch);
    if (!parsed || !strongMatch(parsed, etagValue)) return 412;
  } else {
    const ifUnmodifiedSince = request.headers.get('if-unmodified-since');
    if (ifUnmodifiedSince !== null && object.uploaded) {
      const date = new Date(ifUnmodifiedSince);
      if (!Number.isNaN(date.getTime()) && toHttpSecond(object.uploaded) > toHttpSecond(date)) {
        return 412;
      }
    }
  }

  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch !== null) {
    const parsed = parseEntityTagList(ifNoneMatch);
    if (parsed && weakMatch(parsed, etagValue ?? '')) return 304;
  } else {
    const ifModifiedSince = request.headers.get('if-modified-since');
    if (ifModifiedSince !== null && object.uploaded) {
      const date = new Date(ifModifiedSince);
      if (!Number.isNaN(date.getTime()) && toHttpSecond(object.uploaded) <= toHttpSecond(date)) {
        return 304;
      }
    }
  }

  return null;
}

async function getAsset(request, env, key) {
  const hasRange = request.headers.has('range');
  const ifRange = request.headers.get('if-range');

  let rangeAllowed = hasRange;
  if (hasRange && ifRange !== null) {
    rangeAllowed = false;
    const head = await env.ASSETS.head(key);
    if (head && ifRange === head.httpEtag) {
      rangeAllowed = true;
    }
  }

  const passHeaders = new Headers(request.headers);
  if (!rangeAllowed) {
    passHeaders.delete('range');
  }
  passHeaders.delete('if-range');

  const object = await env.ASSETS.get(key, {
    onlyIf: passHeaders,
    range: rangeAllowed ? passHeaders : undefined,
  });
  if (!object) {
    return jsonResponse({ error: 'Not Found', message: 'The asset does not exist.' }, 404);
  }

  const ranged = rangeAllowed && Boolean(object.range);
  const headers = assetHeaders(object, ranged);
  if (!object.body) {
    const status = evaluatePreconditions(request, object);
    if (status === 412) {
      headers.delete('content-length');
      headers.delete('content-range');
    }
    return new Response(null, { status: status ?? 412, headers });
  }

  return new Response(object.body, {
    status: ranged ? 206 : 200,
    headers,
  });
}

async function headAsset(request, env, key) {
  const object = await env.ASSETS.head(key);
  if (!object) {
    return jsonResponse({ error: 'Not Found', message: 'The asset does not exist.' }, 404);
  }

  const headers = assetHeaders(object);
  const status = evaluatePreconditions(request, object);
  if (status !== null) {
    if (status === 412) {
      headers.delete('content-length');
      headers.delete('content-range');
    }
    return new Response(null, { status, headers });
  }

  return new Response(null, { status: 200, headers });
}

function optionsResponse() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders({
      'access-control-allow-methods': 'GET, HEAD, PUT, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type, Content-Length, X-Content-SHA256, Range, If-Range, If-Match, If-None-Match, If-Modified-Since, If-Unmodified-Since',
      'access-control-max-age': '86400',
    }),
  });
}

export {
  createWorker,
  parseEntityTagList,
  strongMatch,
  weakMatch,
  toHttpSecond,
};

function createWorker() {
  return {
    async fetch(request, env) {
      if (!env?.ASSETS) {
        return jsonResponse({ error: 'Server Configuration Error', message: 'ASSETS R2 binding is not configured.' }, 500);
      }

      const url = new URL(request.url);
      const key = parseAssetKey(url);
      if (!key) {
        return jsonResponse({ error: 'Bad Request', message: 'The asset path is invalid.' }, 400);
      }

      if (request.method === 'PUT') {
        return putAsset(request, env, key, url.pathname);
      }

      if (request.method === 'GET') {
        return getAsset(request, env, key);
      }

      if (request.method === 'HEAD') {
        return headAsset(request, env, key);
      }

      if (request.method === 'OPTIONS') {
        return optionsResponse();
      }

      return jsonResponse(
        { error: 'Method Not Allowed', message: 'This method is not supported.' },
        405,
        { allow: 'GET, HEAD, PUT, OPTIONS' },
      );
    },
  };
}

export default createWorker();
