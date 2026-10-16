const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { ensureCertificate, runMkcert } = require('../lib/setup-cert');

test('development startup reuses a valid certificate without changing trust', () => {
  const calls = [];
  const permissions = [];
  const result = ensureCertificate({
    projectDirectory: '/project',
    certificateIsUsable: () => true,
    logger: { log() {} },
    fs: { chmodSync(file, mode) { permissions.push({ file, mode }); } },
    spawnSync(command, arguments_) {
      calls.push({ command, arguments_ });
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.generated, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(permissions, [
    { file: path.join('/project', '.certs', 'localhost-key.pem'), mode: 0o600 },
  ]);
});

test('development startup explains how to set up an unusable certificate', () => {
  assert.throws(
    () =>
      ensureCertificate({
        projectDirectory: '/project',
        certificateIsUsable: () => false,
        logger: { log() {} },
      }),
    /npm run setup:cert/
  );
});

test('explicit setup installs trust and creates a missing certificate', () => {
  const calls = [];
  const directories = [];
  const permissions = [];
  const result = ensureCertificate({
    projectDirectory: '/project',
    setup: true,
    certificateIsUsable: () => false,
    logger: { log() {} },
    fs: {
      mkdirSync(directory, options) { directories.push({ directory, options }); },
      chmodSync(file, mode) { permissions.push({ file, mode }); },
    },
    spawnSync(command, arguments_) {
      calls.push({ command, arguments_ });
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  const certificateDirectory = path.join('/project', '.certs');
  assert.equal(result.generated, true);
  assert.deepEqual(directories, [
    { directory: certificateDirectory, options: { recursive: true } },
  ]);
  assert.deepEqual(calls.map((call) => call.arguments_), [
    ['-install'],
    [
      '-key-file', path.join(certificateDirectory, 'localhost-key.pem'),
      '-cert-file', path.join(certificateDirectory, 'localhost.pem'),
      'localhost', '127.0.0.1', '::1',
    ],
  ]);
  assert.deepEqual(permissions, [
    { file: path.join(certificateDirectory, 'localhost-key.pem'), mode: 0o600 },
  ]);
});

test('explicit setup regenerates an otherwise valid certificate', () => {
  const calls = [];
  let usabilityChecks = 0;
  const result = ensureCertificate({
    projectDirectory: '/project',
    setup: true,
    certificateIsUsable() {
      usabilityChecks++;
      return true;
    },
    logger: { log() {} },
    fs: { mkdirSync() {}, chmodSync() {} },
    spawnSync(_command, arguments_) {
      calls.push(arguments_);
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.generated, true);
  assert.equal(usabilityChecks, 0);
  assert.deepEqual(calls, [
    ['-install'],
    [
      '-key-file', path.join('/project', '.certs', 'localhost-key.pem'),
      '-cert-file', path.join('/project', '.certs', 'localhost.pem'),
      'localhost', '127.0.0.1', '::1',
    ],
  ]);
});

test('missing mkcert reports a platform-specific installation command', () => {
  assert.throws(
    () =>
      runMkcert(['-install'], {
        platform: 'darwin',
        spawnSync: () => ({ error: { code: 'ENOENT' } }),
      }),
    /brew install mkcert/
  );
  assert.throws(
    () =>
      runMkcert(['-install'], {
        platform: 'win32',
        spawnSync: () => ({ error: { code: 'ENOENT' } }),
      }),
    /choco install mkcert/
  );
});
