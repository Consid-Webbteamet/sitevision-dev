const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeDeletedAssets } = require('../lib/dev-watch');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sitevision-dev-watch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  const output = path.join(directory, 'output');
  fs.mkdirSync(source);
  fs.mkdirSync(output);
  return { directory, source, output };
}

test('removes deleted stylesheet outputs and maps while preserving other bundles', (t) => {
  const { source, output } = fixture(t);
  for (const name of ['page.css', 'page.min.css', 'page.css.map', 'page.min.css.map', 'other.min.css']) {
    fs.writeFileSync(path.join(output, name), 'fixture');
  }
  removeDeletedAssets([path.join(source, 'page.scss')], source, output, 'css');
  assert.deepEqual(fs.readdirSync(output), ['other.min.css']);
});

test('keeps outputs when a source has been recreated before the queued rebuild', (t) => {
  const { source, output } = fixture(t);
  fs.writeFileSync(path.join(source, 'page.scss'), 'body {}');
  fs.writeFileSync(path.join(output, 'page.min.css'), 'fixture');
  removeDeletedAssets([path.join(source, 'page.scss')], source, output, 'css');
  assert.ok(fs.existsSync(path.join(output, 'page.min.css')));
});

test('removes directory JS and polyfill bundles only after the last direct TS source is deleted', (t) => {
  const { source, output } = fixture(t);
  fs.mkdirSync(path.join(source, 'base'));
  const remaining = path.join(source, 'base/remaining.ts');
  fs.writeFileSync(remaining, 'console.log("remaining");');
  for (const name of ['base.js', 'base.min.js', 'base.polyfills.js', 'base.polyfills.min.js']) {
    fs.writeFileSync(path.join(output, name), 'fixture');
  }
  removeDeletedAssets([path.join(source, 'base/removed.ts')], source, output, 'js');
  assert.equal(fs.readdirSync(output).length, 4);
  fs.unlinkSync(remaining);
  removeDeletedAssets([remaining], source, output, 'js');
  assert.deepEqual(fs.readdirSync(output), []);
});

test('removes a standalone TS bundle without deleting a separate polyfills entrypoint', (t) => {
  const { source, output } = fixture(t);
  fs.writeFileSync(path.join(output, 'file.min.js'), 'fixture');
  fs.writeFileSync(path.join(output, 'file.polyfills.min.js'), 'separate entrypoint');
  removeDeletedAssets([path.join(source, 'file.ts')], source, output, 'js');
  assert.deepEqual(fs.readdirSync(output), ['file.polyfills.min.js']);
});
