const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const browserSync = require('browser-sync');
const { createDevOptions } = require('../lib/dev-proxy');

test('proxy serves local assets and preserves published-page resource selection', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sitevision-dev-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'css'));
  await fs.mkdir(path.join(directory, 'js'));
  await fs.writeFile(path.join(directory, 'css/main.css'), 'body { color: blue; }');
  await fs.writeFile(path.join(directory, 'css/main.min.css'), 'body { color: red; }');
  await fs.writeFile(path.join(directory, 'css/main.min.css.map'), '{"version":3}');
  await fs.writeFile(path.join(directory, 'css/missing.min.css'), 'deleted after discovery');
  await fs.writeFile(path.join(directory, 'css/orphan.min.css.map'), '{"version":3}');
  await fs.mkdir(path.join(directory, 'css/components'));
  await fs.writeFile(
    path.join(directory, 'css/components/component.min.css'),
    '.component { color: green; }'
  );
  await fs.writeFile(path.join(directory, 'js/base.min.js'), 'window.localBuild = true;');
  await fs.writeFile(path.join(directory, 'js/base.js'), 'window.localBuild = false;');

  const upstreamRequests = [];
  let target;
  const upstream = http.createServer((req, res) => {
    upstreamRequests.push(req.url);
    if (req.url === '/') {
      assert.equal(req.headers['if-none-match'], undefined);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "script-src 'nonce-sitevision'; connect-src 'none'",
      });
      return res.end(`<html><head>
        <meta http-equiv="Content-Security-Policy" content="script-src 'none'">
        <link rel="stylesheet" href="${target}/download/123/456/main.min.css?version=1">
        </head><body><a href="${target}/next">Next</a>
        <script>window.pageResources = {"globalJsLinks":["${target}/download/123/456/base.min.js"]};</script>
        </body></html>`);
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('remote resource');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  target = `http://127.0.0.1:${upstream.address().port}`;

  const logs = [];
  const errors = [];
  const options = createDevOptions({ target, targetName: 'development', port: 43100 }, directory, {
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
  });
  await fs.unlink(path.join(directory, 'css/missing.min.css'));
  await fs.writeFile(path.join(directory, 'css/late.min.css'), 'added after discovery');
  const proxy = browserSync.create('dev-proxy-test');
  t.after(() => proxy.exit());
  await new Promise((resolve, reject) => proxy.init({
    ...options,
    open: false,
    logLevel: 'silent',
  }, (error) => error ? reject(error) : resolve()));
  const local = `http://127.0.0.1:${proxy.instance.server.address().port}`;
  assert.deepEqual(upstreamRequests, [], 'Starting the proxy must not request the website');
  assert.ok(logs.includes(`[Dev] Target: development → ${target}`));
  assert.ok(logs.includes(`[Dev] Local: ${local}`));
  assert.match(logs.find((message) => message.includes('Available local bundles:')), /base.min.js, main.min.css, missing.min.css$/);

  const page = await fetch(local, {
    headers: { Accept: 'text/html', 'If-None-Match': 'old-version' },
  });
  const html = await page.text();
  assert.equal(page.headers.get('content-security-policy'), null);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(html, /http-equiv="Content-Security-Policy"/i);
  assert.match(html, /browser-sync-client/);
  assert.ok(html.includes(`//127.0.0.1:${proxy.instance.server.address().port}/next`));
  assert.ok(html.includes(`//127.0.0.1:${proxy.instance.server.address().port}/download/123/456/base.min.js`));
  assert.equal((html.match(/<link /g) || []).length, 1);

  const css = await fetch(`${local}/download/123/456/main.min.css?version=1`);
  assert.equal(await css.text(), 'body { color: red; }');
  assert.equal(css.headers.get('cache-control'), 'no-store');
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.equal(await (await fetch(`${local}/download/123/456/base.min.js`)).text(), 'window.localBuild = true;');
  assert.equal(await (await fetch(`${local}/download/123/456/main.min.css.map`)).text(), '{"version":3}');
  const head = await fetch(`${local}/download/123/456/main.min.css`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(`${local}/download/123/456/missing.min.css`)).status, 404);
  assert.equal(logs.filter((message) => message === '[Dev] Serving local bundle: main.min.css').length, 1);
  assert.match(errors[0], /Local build file unavailable: missing.min.css/);
  assert.equal(await (await fetch(`${local}/download/main.css`)).text(), 'remote resource');
  assert.equal(await (await fetch(`${local}/download/base.js`)).text(), 'remote resource');
  assert.equal(await (await fetch(`${local}/download/component.min.css`)).text(), 'remote resource');
  assert.equal(await (await fetch(`${local}/download/orphan.min.css.map`)).text(), 'remote resource');
  assert.equal(await (await fetch(`${local}/download/late.min.css`)).text(), 'remote resource');
  assert.equal(await (await fetch(`${local}/images/icon.svg`)).text(), 'remote resource');
  assert.equal(await (await fetch(`${local}/download/vendor.css`)).text(), 'remote resource');
  assert.deepEqual(upstreamRequests, [
    '/',
    '/download/main.css',
    '/download/base.js',
    '/download/component.min.css',
    '/download/orphan.min.css.map',
    '/download/late.min.css',
    '/images/icon.svg',
    '/download/vendor.css',
  ]);
});

test('login proxy preserves session cookies, translates local origins and redirects locally', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sitevision-dev-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'css'));
  await fs.mkdir(path.join(directory, 'js'));
  const requests = [];
  let target;
  const upstream = http.createServer((req, res) => {
    requests.push(req.headers);
    res.writeHead(303, {
      Location: 'success',
      'Set-Cookie': [
        'JSESSIONID=fixture; Domain=127.0.0.1; Path=/; Secure; HttpOnly; SameSite=None',
        '__Host-session=fixture; Path=/; Secure; HttpOnly; SameSite=Lax',
      ],
    });
    res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  target = `http://127.0.0.1:${upstream.address().port}`;
  const proxy = browserSync.create('dev-login-test');
  t.after(() => proxy.exit());
  await new Promise((resolve, reject) => proxy.init({
    ...createDevOptions({ target, port: 43200 }, directory),
    open: false,
    logLevel: 'silent',
  }, (error) => error ? reject(error) : resolve()));
  const local = `http://127.0.0.1:${proxy.instance.server.address().port}`;
  const response = await fetch(`${local}/account/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Origin: local,
      Referer: `${local}/login?redirect=${encodeURIComponent(target + '/')}`,
      Cookie: 'JSESSIONID=existing-fixture',
    },
  });
  assert.deepEqual(response.headers.getSetCookie(), [
    'JSESSIONID=fixture; Path=/; Secure; HttpOnly; SameSite=None',
    '__Host-session=fixture; Path=/; Secure; HttpOnly; SameSite=Lax',
  ]);
  assert.equal(response.headers.get('location'), `${local}/account/success`);
  assert.equal(requests[0].origin, target);
  assert.equal(requests[0].referer, `${target}/login?redirect=${encodeURIComponent(target + '/')}`);
  assert.equal(requests[0].cookie, 'JSESSIONID=existing-fixture');

  // A genuinely foreign origin must not be disguised as the target site.
  await fetch(`${local}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { Origin: 'https://other.example', Referer: 'https://other.example/form' },
  });
  assert.equal(requests[1].origin, 'https://other.example');
  assert.equal(requests[1].referer, 'https://other.example/form');
});

test('rejects targets with paths or credentials', () => {
  assert.throws(() => createDevOptions({}), /selected Sitevision target/);
  for (const target of ['file:///tmp', 'https://example.com/page', 'https://user:pass@example.com']) {
    assert.throws(() => createDevOptions({ target }), /website origin/);
  }
  assert.throws(() => createDevOptions({
    target: 'https://example.com',
    https: { key: '/missing/key.pem', cert: '/missing/cert.pem' },
  }), /npm run setup:cert/);
});

test('connection failures return 502 and identify the target in the terminal', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sitevision-dev-error-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'css'));
  await fs.mkdir(path.join(directory, 'js'));
  const upstream = http.createServer();
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${upstream.address().port}`;
  await new Promise((resolve) => upstream.close(resolve));
  const logs = [];
  const errors = [];
  const proxy = browserSync.create('dev-connection-error-test');
  t.after(() => proxy.exit());
  await new Promise((resolve, reject) => proxy.init({
    ...createDevOptions({ target, targetName: 'production', production: true, port: 43300 }, directory, {
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    }),
    open: false,
    logLevel: 'silent',
  }, (error) => error ? reject(error) : resolve()));
  const response = await fetch(`http://127.0.0.1:${proxy.instance.server.address().port}`, {
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(await response.text(), /ECONNREFUSED/);
  assert.ok(errors[0].includes(new URL(target).host));
  assert.ok(logs.some((message) => message.includes('(PRODUCTION)')));
  assert.ok(logs.includes('[Dev] Forms and other requests are forwarded to the production site.'));
});

test('an unresponsive target returns 504 after the upstream timeout', { timeout: 20000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sitevision-dev-timeout-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'css'));
  await fs.mkdir(path.join(directory, 'js'));
  const upstream = http.createServer(() => {});
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    upstream.closeAllConnections();
    upstream.close(resolve);
  }));
  const errors = [];
  const proxy = browserSync.create('dev-timeout-test');
  t.after(() => proxy.exit());
  await new Promise((resolve, reject) => proxy.init({
    ...createDevOptions({ target: `http://127.0.0.1:${upstream.address().port}`, port: 43400 }, directory, {
      log() {},
      error: (message) => errors.push(message),
    }),
    open: false,
    logLevel: 'silent',
  }, (error) => error ? reject(error) : resolve()));
  const response = await fetch(`http://127.0.0.1:${proxy.instance.server.address().port}`, {
    signal: AbortSignal.timeout(19000),
  });
  assert.equal(response.status, 504);
  assert.match(await response.text(), /did not respond within 15 seconds/);
  assert.match(errors[0], /did not respond within 15 seconds/);
});

test('CSS-only and JS-only builds do not require the other asset directory', async (t) => {
  for (const [extension, filename] of [['css', 'main.min.css'], ['js', 'base.min.js']]) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), `sitevision-dev-${extension}-only-`));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.mkdir(path.join(directory, extension));
    await fs.writeFile(path.join(directory, extension, filename), '');
    const logs = [];
    const options = createDevOptions({ target: 'https://example.com' }, directory, {
      log: (message) => logs.push(message),
      error() {},
    });
    options.callbacks.ready(null, { options: { getIn: () => 'http://127.0.0.1' } });
    assert.ok(logs.includes(`[Dev] Available local bundles: ${filename}`));
  }
});

test('an upstream that breaks off an HTML response ends the local response promptly', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sitevision-dev-aborted-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': '1000' });
    res.write('<html><body>partial');
    setTimeout(() => res.destroy(), 40);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const errors = [];
  const proxy = browserSync.create('dev-aborted-test');
  t.after(() => proxy.exit());
  await new Promise((resolve, reject) => proxy.init({
    ...createDevOptions({ target: `http://127.0.0.1:${upstream.address().port}`, port: 43500 }, directory, {
      log() {},
      error: (message) => errors.push(message),
    }),
    open: false,
    logLevel: 'silent',
  }, (error) => error ? reject(error) : resolve()));
  const started = Date.now();
  await assert.rejects(async () => {
    const response = await fetch(`http://127.0.0.1:${proxy.instance.server.address().port}`, {
      headers: { Accept: 'text/html' },
      signal: AbortSignal.timeout(5000),
    });
    await response.text();
  }, (error) => error.name !== 'TimeoutError');
  assert.ok(Date.now() - started < 2000);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ended the response early \(ECONNRESET\)/);
});
