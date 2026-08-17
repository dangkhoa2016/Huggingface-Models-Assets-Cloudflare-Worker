import test from 'node:test';
import assert from 'node:assert/strict';

import worker, {
  parseEntityTagList,
  strongMatch,
  weakMatch,
  toHttpSecond,
} from '../src/worker.js';

const COMMIT = 'a'.repeat(40);
const ASSET_URL = `https://assets.example/assets/hf/owner/repo/${COMMIT}/docs/logo.png`;

function sha(char = 'b') {
  return char.repeat(64);
}

function makeObject(key, body, options = {}) {
  const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(body);
  const httpMetadata = options.httpMetadata ?? {};
  return {
    key,
    size: options.size ?? bytes.byteLength,
    etag: options.etag ?? 'etag-value',
    httpEtag: `"${options.etag ?? 'etag-value'}"`,
    uploaded: options.uploaded ?? new Date('2026-08-17T00:00:00Z'),
    httpMetadata,
    customMetadata: options.customMetadata ?? {},
    range: options.range,
    body: new Blob([bytes]).stream(),
    writeHttpMetadata(headers) {
      if (httpMetadata.contentType) headers.set('content-type', httpMetadata.contentType);
      if (httpMetadata.cacheControl) headers.set('cache-control', httpMetadata.cacheControl);
    },
  };
}

function makeConditionBodyless(object) {
  return { ...object, body: null };
}

class FakeBucket {
  constructor(entries = []) {
    this.objects = new Map(entries);
    this.getCalls = [];
    this.putCalls = [];
  }

  async head(key) {
    return this.objects.get(key) ?? null;
  }

  async get(key, options) {
    this.getCalls.push({ key, options });
    const object = this.objects.get(key);
    if (!object) return null;

    const onlyIf = options?.onlyIf;
    if (onlyIf instanceof Headers) {
      const etagRaw = object.httpEtag;
      const etagValue = etagRaw.replace(/^"(.*)"$/, '$1');

      const ifMatch = onlyIf.get('if-match');
      if (ifMatch !== null) {
        if (ifMatch === '*') {
          // * always matches an existing object
        } else {
          const tags = ifMatch.split(',').map((t) => t.trim().replace(/^"(.*)"$/, '$1'));
          if (!tags.includes(etagValue)) return makeConditionBodyless(object);
        }
      } else {
        const ifUnmodifiedSince = onlyIf.get('if-unmodified-since');
        if (ifUnmodifiedSince !== null && object.uploaded) {
          const date = new Date(ifUnmodifiedSince);
          if (!Number.isNaN(date.getTime()) && Math.floor(object.uploaded.getTime() / 1000) > Math.floor(date.getTime() / 1000)) {
            return makeConditionBodyless(object);
          }
        }
      }

      const ifNoneMatch = onlyIf.get('if-none-match');
      if (ifNoneMatch !== null) {
        if (ifNoneMatch === '*') {
          return makeConditionBodyless(object);
        }
        const tags = ifNoneMatch.split(',').map((t) => t.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1'));
        if (tags.includes(etagValue)) return makeConditionBodyless(object);
      } else {
        const ifModifiedSince = onlyIf.get('if-modified-since');
        if (ifModifiedSince !== null && object.uploaded) {
          const date = new Date(ifModifiedSince);
          if (!Number.isNaN(date.getTime()) && Math.floor(object.uploaded.getTime() / 1000) <= Math.floor(date.getTime() / 1000)) {
            return makeConditionBodyless(object);
          }
        }
      }
    }

    return object;
  }

  async put(key, value, options) {
    this.putCalls.push({ key, value, options });
    const onlyIf = options?.onlyIf;
    if (onlyIf instanceof Headers && onlyIf.get('if-none-match') === '*' && this.objects.has(key)) {
      return null;
    }
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    const object = makeObject(key, bytes, {
      httpMetadata: options.httpMetadata,
      customMetadata: options.customMetadata,
    });
    this.objects.set(key, object);
    return object;
  }
}

function env(bucket = new FakeBucket()) {
  return {
    ASSETS: bucket,
    PUBLISH_TOKEN: 'publish-secret',
    MAX_UPLOAD_BYTES: '16777216',
  };
}

// ── parseEntityTagList ──

test('parseEntityTagList returns wildcard star', () => {
  assert.deepEqual(parseEntityTagList('*'), ['*']);
});

test('parseEntityTagList parses a single strong tag', () => {
  assert.deepEqual(parseEntityTagList('"v1"'), [{ weak: false, tag: 'v1' }]);
});

test('parseEntityTagList parses a single weak tag', () => {
  assert.deepEqual(parseEntityTagList('W/"v1"'), [{ weak: true, tag: 'v1' }]);
});

test('parseEntityTagList parses comma-separated list', () => {
  assert.deepEqual(parseEntityTagList('"old", "current"'), [
    { weak: false, tag: 'old' },
    { weak: false, tag: 'current' },
  ]);
});

test('parseEntityTagList parses mixed weak/strong list', () => {
  assert.deepEqual(parseEntityTagList('"other", W/"current"'), [
    { weak: false, tag: 'other' },
    { weak: true, tag: 'current' },
  ]);
});

test('parseEntityTagList handles optional whitespace', () => {
  assert.deepEqual(parseEntityTagList('  "a" ,  "b"  '), [
    { weak: false, tag: 'a' },
    { weak: false, tag: 'b' },
  ]);
});

test('parseEntityTagList returns null for empty string', () => {
  assert.equal(parseEntityTagList(''), null);
});

test('parseEntityTagList returns null for malformed tag', () => {
  assert.equal(parseEntityTagList('not-a-tag'), null);
});

test('parseEntityTagList preserves backslash inside opaque-tag', () => {
  assert.deepEqual(parseEntityTagList('"v\\1"'), [{ weak: false, tag: 'v\\1' }]);
});

test('parseEntityTagList preserves weak tag with backslash', () => {
  assert.deepEqual(parseEntityTagList('W/"v\\1"'), [{ weak: true, tag: 'v\\1' }]);
});

test('parseEntityTagList handles HTAB as OWS', () => {
  assert.deepEqual(parseEntityTagList('"a",\t"b"'), [
    { weak: false, tag: 'a' },
    { weak: false, tag: 'b' },
  ]);
});

test('parseEntityTagList accepts trailing OWS', () => {
  assert.deepEqual(parseEntityTagList('"v1" \t '), [{ weak: false, tag: 'v1' }]);
});

test('parseEntityTagList rejects trailing garbage', () => {
  assert.equal(parseEntityTagList('"v1"garbage'), null);
});

// ── strongMatch ──

test('strongMatch matches wildcard', () => {
  assert.equal(strongMatch(['*'], 'anything'), true);
});

test('strongMatch matches strong tag', () => {
  assert.equal(strongMatch([{ weak: false, tag: 'v1' }], 'v1'), true);
});

test('strongMatch rejects weak tag', () => {
  assert.equal(strongMatch([{ weak: true, tag: 'v1' }], 'v1'), false);
});

test('strongMatch rejects mismatched tag', () => {
  assert.equal(strongMatch([{ weak: false, tag: 'other' }], 'v1'), false);
});

// ── weakMatch ──

test('weakMatch matches wildcard', () => {
  assert.equal(weakMatch(['*'], 'anything'), true);
});

test('weakMatch matches strong tag', () => {
  assert.equal(weakMatch([{ weak: false, tag: 'v1' }], 'v1'), true);
});

test('weakMatch matches weak tag', () => {
  assert.equal(weakMatch([{ weak: true, tag: 'v1' }], 'v1'), true);
});

test('weakMatch rejects mismatched tag', () => {
  assert.equal(weakMatch([{ weak: false, tag: 'other' }], 'v1'), false);
});

// ── toHttpSecond ──

test('toHttpSecond normalizes to whole seconds', () => {
  assert.equal(toHttpSecond(new Date('2026-08-17T00:00:00.500Z')), 1786924800);
  assert.equal(toHttpSecond(new Date('2026-08-17T00:00:00.999Z')), 1786924800);
  assert.equal(toHttpSecond(new Date('2026-08-17T00:00:01.000Z')), 1786924801);
});

// ── PUT ──

test('PUT stores an authenticated immutable object with HTTP and SHA metadata', async () => {
  const bucket = new FakeBucket();
  const response = await worker.fetch(new Request(ASSET_URL, {
    method: 'PUT',
    headers: {
      authorization: 'Bearer publish-secret',
      'content-type': 'image/png',
      'content-length': '3',
      'x-content-sha256': sha(),
    },
    body: 'png',
  }), env(bucket), {});

  assert.equal(response.status, 201);
  assert.equal(bucket.putCalls.length, 1);
  assert.equal(bucket.putCalls[0].key, `hf/owner/repo/${COMMIT}/docs/logo.png`);
  assert.equal(bucket.putCalls[0].options.httpMetadata.contentType, 'image/png');
  assert.equal(bucket.putCalls[0].options.httpMetadata.cacheControl, 'public, max-age=31536000, immutable');
  assert.equal(bucket.putCalls[0].options.customMetadata.sha256, sha());
  assert.equal(bucket.putCalls[0].options.sha256, sha());
  assert.equal(bucket.putCalls[0].options.onlyIf.get('if-none-match'), '*');
  assert.equal((await response.json()).url, `/assets/hf/owner/repo/${COMMIT}/docs/logo.png`);
});

test('PUT rejects missing or invalid bearer authentication without touching R2', async () => {
  for (const authorization of [null, 'Bearer wrong-secret', 'Basic publish-secret']) {
    const bucket = new FakeBucket();
    const headers = { 'x-content-sha256': sha() };
    if (authorization) headers.authorization = authorization;
    const response = await worker.fetch(new Request(ASSET_URL, {
      method: 'PUT', headers, body: 'x',
    }), env(bucket), {});
    assert.equal(response.status, 401);
    assert.equal(bucket.putCalls.length, 0);
  }
});

test('PUT rejects malformed paths and encoded separators', async () => {
  const urls = [
    `https://assets.example/assets/hf/owner/repo/not-a-commit/file.png`,
    `https://assets.example/assets/hf/owner/repo/${COMMIT}`,
    `https://assets.example/assets/hf/owner/repo/${COMMIT}/docs%2Fsecret.png`,
    `https://assets.example/assets/hf/owner/repo/${COMMIT}/docs%5Csecret.png`,
  ];
  for (const url of urls) {
    const response = await worker.fetch(new Request(url, {
      method: 'PUT',
      headers: { authorization: 'Bearer publish-secret', 'x-content-sha256': sha() },
      body: 'x',
    }), env(), {});
    assert.equal(response.status, 400, url);
  }
});

test('PUT requires a lowercase SHA-256 digest and enforces declared upload size', async () => {
  const missingDigest = await worker.fetch(new Request(ASSET_URL, {
    method: 'PUT', headers: { authorization: 'Bearer publish-secret' }, body: 'x',
  }), env(), {});
  assert.equal(missingDigest.status, 400);

  const missingLength = await worker.fetch(new Request(ASSET_URL, {
    method: 'PUT',
    headers: { authorization: 'Bearer publish-secret', 'x-content-sha256': sha() },
    body: 'x',
  }), env(), {});
  assert.equal(missingLength.status, 411);

  const tooLarge = await worker.fetch(new Request(ASSET_URL, {
    method: 'PUT',
    headers: {
      authorization: 'Bearer publish-secret',
      'x-content-sha256': sha(),
      'content-length': '11',
    },
    body: '01234567890',
  }), { ...env(), MAX_UPLOAD_BYTES: '10' }, {});
  assert.equal(tooLarge.status, 413);
});

test('PUT is idempotent for the same digest and conflicts for different content', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const existing = makeObject(key, 'png', { customMetadata: { sha256: sha() } });
  const bucket = new FakeBucket([[key, existing]]);

  const same = await worker.fetch(new Request(ASSET_URL, {
    method: 'PUT',
    headers: { authorization: 'Bearer publish-secret', 'x-content-sha256': sha(), 'content-length': '3' },
    body: 'png',
  }), env(bucket), {});
  assert.equal(same.status, 200);
  assert.equal((await same.json()).status, 'already_exists');
  assert.equal(bucket.putCalls.length, 0);

  const different = await worker.fetch(new Request(ASSET_URL, {
    method: 'PUT',
    headers: { authorization: 'Bearer publish-secret', 'x-content-sha256': sha('c'), 'content-length': '9' },
    body: 'different',
  }), env(bucket), {});
  assert.equal(different.status, 409);
  assert.equal(bucket.putCalls.length, 0);
});

// ── GET ──

test('GET streams an R2 object with stored metadata, ETag, ranges, CORS and Last-Modified', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const uploaded = new Date('2026-08-17T00:00:00Z');
  const object = makeObject(key, 'png', {
    range: { offset: 0, length: 3 },
    uploaded,
    httpMetadata: {
      contentType: 'image/png',
      cacheControl: 'public, max-age=31536000, immutable',
    },
  });
  const bucket = new FakeBucket([[key, object]]);

  const response = await worker.fetch(new Request(ASSET_URL), env(bucket), {});

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'png');
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(response.headers.get('etag'), '"etag-value"');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('last-modified'), 'Mon, 17 Aug 2026 00:00:00 GMT');
  assert.equal(response.headers.get('content-range'), null);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(bucket.getCalls[0].options.range, undefined);
  assert.ok(bucket.getCalls[0].options.onlyIf instanceof Headers);
});

test('GET returns 206 and Content-Range when R2 returns a byte range', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'bc', {
    size: 4,
    range: { offset: 1, length: 2 },
    httpMetadata: { contentType: 'text/plain' },
  });
  const response = await worker.fetch(
    new Request(ASSET_URL, { headers: { range: 'bytes=1-2' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );

  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 1-2/4');
  assert.equal(response.headers.get('content-length'), '2');
  assert.equal(await response.text(), 'bc');
});

test('GET and HEAD return 404 for unknown immutable assets', async () => {
  for (const method of ['GET', 'HEAD']) {
    const response = await worker.fetch(new Request(ASSET_URL, { method }), env(), {});
    assert.equal(response.status, 404);
  }
});

// ── HEAD ──

test('HEAD returns object metadata without exposing a body', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const uploaded = new Date('2026-08-17T00:00:00Z');
  const object = makeObject(key, 'png', { uploaded, httpMetadata: { contentType: 'image/png' } });
  const response = await worker.fetch(
    new Request(ASSET_URL, { method: 'HEAD' }),
    env(new FakeBucket([[key, object]])),
    {},
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '3');
  assert.equal(response.headers.get('etag'), '"etag-value"');
  assert.equal(response.headers.get('last-modified'), 'Mon, 17 Aug 2026 00:00:00 GMT');
  assert.equal(await response.text(), '');
});

// ── OPTIONS ──

test('OPTIONS advertises the asset API and unsupported methods return 405', async () => {
  const options = await worker.fetch(new Request(ASSET_URL, { method: 'OPTIONS' }), env(), {});
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-methods'), 'GET, HEAD, PUT, OPTIONS');
  assert.match(options.headers.get('access-control-allow-headers'), /Authorization/i);

  const post = await worker.fetch(new Request(ASSET_URL, { method: 'POST' }), env(), {});
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD, PUT, OPTIONS');
});

// ── If-Range ──

test('If-Range with matching ETag returns partial content (206)', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'bc', {
    size: 4,
    etag: 'current',
    range: { offset: 1, length: 2 },
    httpMetadata: { contentType: 'text/plain' },
  });
  const bucket = new FakeBucket([[key, object]]);

  const response = await worker.fetch(
    new Request(ASSET_URL, {
      headers: { range: 'bytes=1-2', 'if-range': '"current"' },
    }),
    env(bucket),
    {},
  );

  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 1-2/4');
  assert.equal(await response.text(), 'bc');
  assert.ok(bucket.getCalls[0].options.range instanceof Headers);
  assert.equal(bucket.getCalls[0].options.range.get('range'), 'bytes=1-2');
  assert.equal(bucket.getCalls[0].options.onlyIf.get('if-range'), null);
});

test('If-Range with stale ETag ignores Range and returns full object (200)', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'hello', {
    size: 5,
    etag: 'current',
    httpMetadata: { contentType: 'text/plain' },
  });
  const bucket = new FakeBucket([[key, object]]);

  const response = await worker.fetch(
    new Request(ASSET_URL, {
      headers: { range: 'bytes=1-2', 'if-range': '"stale"' },
    }),
    env(bucket),
    {},
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-range'), null);
  assert.equal(await response.text(), 'hello');
  assert.equal(bucket.getCalls[0].options.range, undefined);
  assert.equal(bucket.getCalls[0].options.onlyIf.get('range'), null);
  assert.equal(bucket.getCalls[0].options.onlyIf.get('if-range'), null);
});

test('Range without If-Range returns partial content as before (206)', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'bc', {
    size: 4,
    range: { offset: 1, length: 2 },
    httpMetadata: { contentType: 'text/plain' },
  });
  const bucket = new FakeBucket([[key, object]]);

  const response = await worker.fetch(
    new Request(ASSET_URL, { headers: { range: 'bytes=1-2' } }),
    env(bucket),
    {},
  );

  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 1-2/4');
  assert.equal(await response.text(), 'bc');
  assert.ok(bucket.getCalls[0].options.range instanceof Headers);
  assert.equal(bucket.getCalls[0].options.range.get('range'), 'bytes=1-2');
});

// ── If-Match ──

test('If-Match with current strong ETag returns 200', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, { headers: { 'if-match': '"v1"' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'png');
});

test('If-Match with wrong ETag returns 412', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, { headers: { 'if-match': '"wrong"' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 412);
});

test('If-Match * returns 200 for existing object', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, { headers: { 'if-match': '*' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 200);
});

test('If-Match list with one matching tag returns 200', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, { headers: { 'if-match': '"other", "v1"' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 200);
});

test('If-Match list with no matching tags returns 412', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, { headers: { 'if-match': '"other", "missing"' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 412);
});

test('If-Match weak tag does not strong-match current ETag (returns 412)', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, { headers: { 'if-match': 'W/"v1"' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 412);
});

test('If-Match backslash mismatch does not match current ETag (returns 412)', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, { headers: { 'if-match': '"v\\1"' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 412);
});

test('HEAD If-Match backslash mismatch returns 412', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, { method: 'HEAD', headers: { 'if-match': '"v\\1"' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 412);
  assert.equal(await response.text(), '');
});

// ── If-None-Match ──

test('If-None-Match with current ETag returns 304', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, { headers: { 'if-none-match': '"v1"' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 304);
  assert.equal(await response.text(), '');
});

test('If-None-Match with non-current ETag returns 200', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, { headers: { 'if-none-match': '"other"' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'png');
});

test('If-None-Match * returns 304 for existing object', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, { headers: { 'if-none-match': '*' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 304);
});

test('If-None-Match list with one matching tag returns 304', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, { headers: { 'if-none-match': '"other", "v1"' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 304);
});

test('If-None-Match weak tag weak-matches current ETag (returns 304)', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, { headers: { 'if-none-match': 'W/"v1"' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 304);
});

test('If-None-Match backslash mismatch does not match current ETag (returns 200)', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, { headers: { 'if-none-match': '"v\\1"' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 200);
});

test('HEAD If-None-Match backslash mismatch returns 200', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, { method: 'HEAD', headers: { 'if-none-match': '"v\\1"' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
});

// ── Mixed conditions ──

test('If-Match current + If-None-Match current returns 304', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, {
      headers: { 'if-match': '"v1"', 'if-none-match': '"v1"' },
    }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 304);
});

test('If-Match wrong + If-None-Match current returns 412', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, {
      headers: { 'if-match': '"wrong"', 'if-none-match': '"v1"' },
    }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 412);
});

test('If-Match * + If-None-Match * returns 304', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, {
      headers: { 'if-match': '*', 'if-none-match': '*' },
    }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 304);
});

test('If-Match current + If-Unmodified-Since stale returns 200 (If-UDS ignored)', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', {
    etag: 'v1',
    uploaded: new Date('2026-08-17T00:00:00Z'),
  });
  const response = await worker.fetch(
    new Request(ASSET_URL, {
      headers: {
        'if-match': '"v1"',
        'if-unmodified-since': 'Thu, 01 Jan 2020 00:00:00 GMT',
      },
    }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 200);
});

test('If-None-Match non-current + If-Modified-Since not modified returns 200 (If-MS ignored)', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', {
    etag: 'v1',
    uploaded: new Date('2020-01-01T00:00:00Z'),
  });
  const response = await worker.fetch(
    new Request(ASSET_URL, {
      headers: {
        'if-none-match': '"other"',
        'if-modified-since': 'Mon, 17 Aug 2026 00:00:00 GMT',
      },
    }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 200);
});

// ── If-Unmodified-Since ──

test('If-Unmodified-Since passes (not modified) returns 200', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', {
    uploaded: new Date('2026-08-17T00:00:00Z'),
  });
  const response = await worker.fetch(
    new Request(ASSET_URL, {
      headers: { 'if-unmodified-since': 'Mon, 17 Aug 2026 00:00:00 GMT' },
    }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 200);
});

test('If-Unmodified-Since fails (modified after) returns 412', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', {
    uploaded: new Date('2026-08-17T00:00:01Z'),
  });
  const response = await worker.fetch(
    new Request(ASSET_URL, {
      headers: { 'if-unmodified-since': 'Mon, 17 Aug 2026 00:00:00 GMT' },
    }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 412);
});

test('If-Unmodified-Since with invalid date is ignored', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png');
  const response = await worker.fetch(
    new Request(ASSET_URL, {
      headers: { 'if-unmodified-since': 'not-a-date' },
    }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 200);
});

// ── If-Modified-Since ──

test('If-Modified-Since returns 304 when not modified', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', {
    uploaded: new Date('2026-08-17T00:00:00Z'),
  });
  const response = await worker.fetch(
    new Request(ASSET_URL, {
      headers: { 'if-modified-since': 'Mon, 17 Aug 2026 00:00:00 GMT' },
    }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 304);
  assert.equal(await response.text(), '');
});

test('If-Modified-Since returns 200 when modified after date', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', {
    uploaded: new Date('2026-08-17T00:00:01Z'),
  });
  const response = await worker.fetch(
    new Request(ASSET_URL, {
      headers: { 'if-modified-since': 'Mon, 17 Aug 2026 00:00:00 GMT' },
    }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 200);
});

test('If-Modified-Since with invalid date is ignored', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png');
  const response = await worker.fetch(
    new Request(ASSET_URL, {
      headers: { 'if-modified-since': 'not-a-date' },
    }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 200);
});

test('If-None-Match present suppresses If-Modified-Since evaluation', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'current' });
  const response = await worker.fetch(
    new Request(ASSET_URL, {
      headers: { 'if-none-match': '"other"', 'if-modified-since': 'Thu, 01 Jan 2020 00:00:00 GMT' },
    }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 200);
});

// ── Date precision ──

test('If-Unmodified-Since normalizes to whole seconds (500ms within same second passes)', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', {
    uploaded: new Date('2026-08-17T00:00:00.500Z'),
  });
  const response = await worker.fetch(
    new Request(ASSET_URL, {
      headers: { 'if-unmodified-since': 'Mon, 17 Aug 2026 00:00:00 GMT' },
    }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 200);
});

test('If-Modified-Since normalizes to whole seconds (500ms within same second returns 304)', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', {
    uploaded: new Date('2026-08-17T00:00:00.500Z'),
  });
  const response = await worker.fetch(
    new Request(ASSET_URL, {
      headers: { 'if-modified-since': 'Mon, 17 Aug 2026 00:00:00 GMT' },
    }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 304);
});

// ── HEAD conditional matrix ──

test('HEAD no conditions returns 200', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, { method: 'HEAD' }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
});

test('HEAD + If-Match current returns 200', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, { method: 'HEAD', headers: { 'if-match': '"v1"' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('etag'), '"v1"');
  assert.equal(await response.text(), '');
});

test('HEAD + If-Match wrong returns 412', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, { method: 'HEAD', headers: { 'if-match': '"wrong"' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 412);
  assert.equal(await response.text(), '');
});

test('HEAD + If-Match * returns 200', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, { method: 'HEAD', headers: { 'if-match': '*' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
});

test('HEAD + If-None-Match current returns 304', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, { method: 'HEAD', headers: { 'if-none-match': '"v1"' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 304);
  assert.equal(await response.text(), '');
});

test('HEAD + If-None-Match W/"v1" returns 304 (weak match)', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, { method: 'HEAD', headers: { 'if-none-match': 'W/"v1"' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 304);
  assert.equal(await response.text(), '');
});

test('HEAD + If-None-Match * returns 304', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, { method: 'HEAD', headers: { 'if-none-match': '*' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 304);
  assert.equal(await response.text(), '');
});

test('HEAD + If-Modified-Since not modified returns 304', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', {
    uploaded: new Date('2026-08-17T00:00:00Z'),
  });
  const response = await worker.fetch(
    new Request(ASSET_URL, {
      method: 'HEAD',
      headers: { 'if-modified-since': 'Mon, 17 Aug 2026 00:00:00 GMT' },
    }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 304);
  assert.equal(await response.text(), '');
});

test('HEAD + If-Unmodified-Since failed returns 412', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', {
    uploaded: new Date('2026-08-17T00:00:01Z'),
  });
  const response = await worker.fetch(
    new Request(ASSET_URL, {
      method: 'HEAD',
      headers: { 'if-unmodified-since': 'Mon, 17 Aug 2026 00:00:00 GMT' },
    }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 412);
  assert.equal(await response.text(), '');
});

test('HEAD + If-Match current + If-None-Match current returns 304', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1' });
  const response = await worker.fetch(
    new Request(ASSET_URL, {
      method: 'HEAD',
      headers: { 'if-match': '"v1"', 'if-none-match': '"v1"' },
    }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 304);
  assert.equal(await response.text(), '');
});

// ── 412 response framing ──

test('GET If-Match failure returns 412 with empty body and no Content-Length', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1', size: 3 });
  const response = await worker.fetch(
    new Request(ASSET_URL, { headers: { 'if-match': '"wrong"' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 412);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(response.headers.get('content-range'), null);
  assert.equal(response.headers.get('etag'), '"v1"');
});

test('GET If-Unmodified-Since failure returns 412 with no Content-Length', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', {
    etag: 'v1',
    uploaded: new Date('2026-08-17T00:00:01Z'),
  });
  const response = await worker.fetch(
    new Request(ASSET_URL, {
      headers: { 'if-unmodified-since': 'Mon, 17 Aug 2026 00:00:00 GMT' },
    }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 412);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(response.headers.get('content-range'), null);
});

test('HEAD If-Match failure returns 412 with no Content-Length', async () => {
  const key = `hf/owner/repo/${COMMIT}/docs/logo.png`;
  const object = makeObject(key, 'png', { etag: 'v1', size: 3 });
  const response = await worker.fetch(
    new Request(ASSET_URL, { method: 'HEAD', headers: { 'if-match': '"wrong"' } }),
    env(new FakeBucket([[key, object]])),
    {},
  );
  assert.equal(response.status, 412);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(response.headers.get('content-range'), null);
});

// ── OPTIONS CORS ──

test('OPTIONS advertises If-Match and If-Unmodified-Since in CORS headers', async () => {
  const options = await worker.fetch(new Request(ASSET_URL, { method: 'OPTIONS' }), env(), {});
  assert.equal(options.status, 204);
  const allowHeaders = options.headers.get('access-control-allow-headers');
  assert.match(allowHeaders, /If-Match/);
  assert.match(allowHeaders, /If-Unmodified-Since/);
  assert.match(allowHeaders, /Range/);
  assert.match(allowHeaders, /If-Range/);
  assert.match(allowHeaders, /If-None-Match/);
  assert.match(allowHeaders, /If-Modified-Since/);
});
