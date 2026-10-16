const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveTarget } = require('../lib/sitevision-target');

function projectTarget(origin, production = false) {
  return {
    targets: {
      development: { origin, production },
    },
  };
}

test('resolves the selected HTTPS origin and derives its hostname', () => {
  assert.deepEqual(
    resolveTarget(
      { SITEVISION_TARGET: 'development' },
      projectTarget('https://Example.Sitevision-Cloud.se:8443/', true)
    ),
    {
      name: 'development',
      origin: 'https://example.sitevision-cloud.se:8443',
      expectedHost: 'example.sitevision-cloud.se',
      production: true,
    }
  );
});

test('rejects a missing or unknown target selector', () => {
  const projectConfig = projectTarget('https://example.sitevision-cloud.se');
  assert.throws(
    () => resolveTarget({}, projectConfig),
    /SITEVISION_TARGET is missing/
  );
  assert.throws(
    () => resolveTarget({ SITEVISION_TARGET: 'production' }, projectConfig),
    /Unknown SITEVISION_TARGET "production"/
  );
});

test('rejects replace-me target placeholders', () => {
  assert.throws(
    () =>
      resolveTarget(
        { SITEVISION_TARGET: 'development' },
        projectTarget('https://replace-me-development.example.invalid')
      ),
    /replace-me origin/
  );
});

test('requires an explicit production boolean', () => {
  assert.throws(
    () =>
      resolveTarget(
        { SITEVISION_TARGET: 'development' },
        {
          targets: {
            development: {
              origin: 'https://example.sitevision-cloud.se',
            },
          },
        }
      ),
    /explicit boolean "production"/
  );
});

test('rejects non-HTTPS origins, paths, queries, hashes and credentials', () => {
  for (const origin of [
    'http://example.sitevision-cloud.se',
    'https://example.sitevision-cloud.se/path',
    'https://example.sitevision-cloud.se/.',
    'https://example.sitevision-cloud.se//',
    'https://example.sitevision-cloud.se?preview=true',
    'https://example.sitevision-cloud.se?',
    'https://example.sitevision-cloud.se#fragment',
    'https://example.sitevision-cloud.se#',
    'https://user:password@example.sitevision-cloud.se',
    'not a URL',
  ]) {
    assert.throws(
      () =>
        resolveTarget(
          { SITEVISION_TARGET: 'development' },
          projectTarget(origin)
        ),
      /HTTPS website origin/,
      origin
    );
  }
});
