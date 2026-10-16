const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  afterDeploy,
  buildKeychainSaveCommand,
  confirmKeychainSave,
  confirmProduction,
  deployAssets,
  formatSummary,
  getAssetFiles,
  getAssetType,
  getConfig,
  parseKeychainPassword,
  postFile,
  saveKeychainPassword,
  shouldCreateMissing,
} = require('../lib/deploy-assets');

const config = {
  name: 'development',
  origin: 'https://deploy.example.sitevision-cloud.se',
  expectedHost: 'deploy.example.sitevision-cloud.se',
  production: false,
  username: 'developer',
  password: 'secret',
};

function response(status, body, text = JSON.stringify(body)) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    text: async () => text,
  };
}

test('selects only top-level minified files for the requested asset type', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-assets-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  fs.writeFileSync(path.join(directory, 'main.min.css'), 'main');
  fs.writeFileSync(path.join(directory, 'main.min.js'), 'script');
  fs.writeFileSync(path.join(directory, 'main.css'), 'source');
  fs.writeFileSync(path.join(directory, 'main.min.css.map'), 'map');
  fs.mkdirSync(path.join(directory, 'components'));
  fs.writeFileSync(
    path.join(directory, 'components', 'component.min.css'),
    'component'
  );

  assert.deepEqual(getAssetFiles('css', directory), [
    { fileName: 'main.min.css', content: 'main' },
  ]);
  assert.deepEqual(getAssetFiles('js', directory), [
    { fileName: 'main.min.js', content: 'script' },
  ]);
});

test('requires an explicit CSS or JS asset type', () => {
  assert.equal(getAssetType(['node', 'script', 'css']), 'css');
  assert.equal(getAssetType(['node', 'script', 'js']), 'js');
  assert.throws(() => getAssetType(['node', 'script']), /css.*js/);
});

test('enables creation only through the script argument', () => {
  assert.equal(shouldCreateMissing(['node', 'script']), false);
  assert.equal(
    shouldCreateMissing(['node', 'script', '--create-missing']),
    true
  );
});

const projectConfig = {
  targets: {
    development: {
      origin: config.origin,
      production: false,
    },
  },
};

// Fakes for the Keychain and prompt so tests never call the real `security`
// binary or read a terminal.
function keychainFake(password) {
  const lookups = [];
  return {
    lookups,
    readKeychainPassword(account) {
      lookups.push(account);
      return password;
    },
  };
}

function promptFake(answer) {
  const prompts = [];
  return {
    prompts,
    async promptForPassword(prompt) {
      prompts.push(prompt);
      return answer;
    },
  };
}

test('uses the selected project target and personal credentials', async () => {
  const environment = {
    SITEVISION_TARGET: 'development',
    SITEVISION_DEPLOY_USERNAME: config.username,
    SITEVISION_DEPLOY_PASSWORD: config.password,
  };
  assert.deepEqual(await getConfig(environment, projectConfig), {
    ...config,
    passwordSource: 'environment',
    keychainAccount: `${config.username}@${config.expectedHost}`,
  });
  await assert.rejects(
    getConfig(environment, { targets: {} }),
    /Unknown SITEVISION_TARGET/
  );
  await assert.rejects(
    getConfig(environment, {
      targets: {
        development: {
          origin: 'http://example.sitevision-cloud.se/path',
          production: false,
        },
      },
    }),
    /HTTPS website origin/
  );
});

test('prefers the environment password over the Keychain', async () => {
  const keychain = keychainFake('keychain-password');
  const result = await getConfig(
    {
      SITEVISION_TARGET: 'development',
      SITEVISION_DEPLOY_USERNAME: config.username,
      SITEVISION_DEPLOY_PASSWORD: config.password,
    },
    projectConfig,
    { platform: 'darwin', readKeychainPassword: keychain.readKeychainPassword }
  );

  assert.equal(result.password, config.password);
  assert.deepEqual(keychain.lookups, []);
});

test('reads the password from the Keychain account for the target host', async () => {
  const keychain = keychainFake('keychain-password');
  const result = await getConfig(
    { SITEVISION_TARGET: 'development', SITEVISION_DEPLOY_USERNAME: config.username },
    projectConfig,
    { platform: 'darwin', readKeychainPassword: keychain.readKeychainPassword }
  );

  assert.equal(result.password, 'keychain-password');
  assert.deepEqual(keychain.lookups, [`${config.username}@${config.expectedHost}`]);
});

test('prompts for the password in a terminal when the Keychain has no entry', async () => {
  const keychain = keychainFake(undefined);
  const prompt = promptFake('typed-password');
  const result = await getConfig(
    { SITEVISION_TARGET: 'development', SITEVISION_DEPLOY_USERNAME: config.username },
    projectConfig,
    {
      platform: 'darwin',
      isInteractive: true,
      readKeychainPassword: keychain.readKeychainPassword,
      promptForPassword: prompt.promptForPassword,
    }
  );

  assert.equal(result.password, 'typed-password');
  assert.equal(prompt.prompts.length, 1);
  assert.match(prompt.prompts[0], /developer@deploy\.example\.sitevision-cloud\.se/);
});

test('fails clearly without a password outside a terminal and without the Keychain', async () => {
  const keychain = keychainFake(undefined);
  const prompt = promptFake('unused');
  await assert.rejects(
    getConfig(
      { SITEVISION_TARGET: 'development', SITEVISION_DEPLOY_USERNAME: config.username },
      projectConfig,
      {
        platform: 'darwin',
        isInteractive: false,
        readKeychainPassword: keychain.readKeychainPassword,
        promptForPassword: prompt.promptForPassword,
      }
    ),
    (error) => {
      assert.match(error.message, /No deploy password for developer@deploy\.example\.sitevision-cloud\.se/);
      assert.match(error.message, /macOS Keychain/);
      assert.match(error.message, /SITEVISION_DEPLOY_PASSWORD/);
      assert.equal(error.message.includes(config.password), false);
      return true;
    }
  );
  assert.deepEqual(prompt.prompts, []);
});

test('requires the username even when a password is available', async () => {
  await assert.rejects(
    getConfig(
      { SITEVISION_TARGET: 'development', SITEVISION_DEPLOY_PASSWORD: config.password },
      projectConfig
    ),
    /Missing .env values: SITEVISION_DEPLOY_USERNAME/
  );
});

test('includes the selected target hostname in every RESTApp request', async () => {
  let request;
  await postFile({
    action: 'update',
    config,
    file: { fileName: 'main.min.css', content: 'body{}' },
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return response(200, { success: true });
    },
  });

  assert.equal(
    request.url,
    'https://deploy.example.sitevision-cloud.se/rest-api/consid-deploy-files/update'
  );
  assert.deepEqual(request.body, {
    expectedHost: 'deploy.example.sitevision-cloud.se',
    fileName: 'main.min.css',
    content: 'body{}',
  });
});

test('treats only the RESTApp file-not-found contract as a missing file', async () => {
  const file = { fileName: 'main.min.css', content: 'body{}' };
  assert.deepEqual(
    await postFile({
      action: 'update',
      config,
      file,
      fetchImpl: async () =>
        response(404, { error: true, code: 'FILE_NOT_FOUND' }),
    }),
    { missing: true }
  );

  await assert.rejects(
    postFile({
      action: 'update',
      config,
      file,
      fetchImpl: async () => response(404, {}, '<html>Not found</html>'),
    }),
    /404.*Not found/
  );
});

test('sets an explicit request timeout', async () => {
  let signal;
  await postFile({
    action: 'update',
    config,
    file: { fileName: 'main.min.css', content: 'body{}' },
    timeoutMs: 1234,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return response(200, { success: true });
    },
  });
  assert.equal(signal.aborted, false);
});

test('shows the destination and file count before updating', async () => {
  const writes = [];
  const result = await deployAssets({
    config,
    files: [{ fileName: 'main.min.css', content: 'body{}' }],
    createMissing: false,
    fetchImpl: async () => {
      assert.match(
        writes.join(''),
        /Deploy target: development \(https:\/\/deploy\.example\.sitevision-cloud\.se\).*Deploying 1 files…/s
      );
      return response(200, { success: true, action: 'updated' });
    },
    output: {
      write(value) {
        writes.push(value);
      },
    },
  });

  assert.deepEqual(result.updated, ['main.min.css']);
  assert.deepEqual(result.unchanged, []);
  assert.deepEqual(result.failed, []);
  assert.doesNotMatch(writes.join(''), /main\.min\.css/);
});

test('reports changed, unchanged and legacy update responses separately', async () => {
  const writes = [];
  const result = await deployAssets({
    config,
    files: [
      { fileName: 'changed.min.css', content: 'changed' },
      { fileName: 'unchanged.min.css', content: 'unchanged' },
      { fileName: 'legacy.min.css', content: 'legacy' },
    ],
    createMissing: false,
    fetchImpl: async (_url, options) => {
      const fileName = JSON.parse(options.body).fileName;
      return response(200, {
        success: true,
        action: 'updated',
        ...(fileName === 'legacy.min.css'
          ? {}
          : { changed: fileName === 'changed.min.css' }),
      });
    },
    output: {
      write(value) {
        writes.push(value);
      },
    },
  });

  assert.deepEqual(result.updated, ['changed.min.css', 'legacy.min.css']);
  assert.deepEqual(result.unchanged, ['unchanged.min.css']);
  assert.doesNotMatch(writes.join(''), /changed\.min\.css/);
  assert.equal(
    formatSummary('css', result, false),
    '\nUpdated (2)\n  changed.min.css\n  legacy.min.css\n\n' +
      'Unchanged (1)\n  unchanged.min.css\n\n' +
      'CSS deploy complete:\n2 updated, 1 unchanged\n'
  );
});

test('production deploy fails closed before any request without confirmation', async () => {
  let requests = 0;
  const result = await deployAssets({
    config: { ...config, name: 'production', production: true },
    files: [{ fileName: 'main.min.css', content: 'body{}' }],
    createMissing: false,
    fetchImpl: async () => {
      requests += 1;
      return response(200, { success: true });
    },
    confirmProductionTarget: async () => false,
    output: { write() {} },
  });

  assert.equal(requests, 0);
  assert.deepEqual(result.unprocessed, ['main.min.css']);
  assert.match(result.error, /No network requests/);
});

test('production confirmation precedes updates and create-missing confirmation', async () => {
  const events = [];
  const productionConfig = {
    ...config,
    name: 'production',
    production: true,
  };
  const result = await deployAssets({
    config: productionConfig,
    files: [{ fileName: 'main.min.js', content: 'script' }],
    createMissing: true,
    confirmProductionTarget: async (selectedConfig) => {
      assert.equal(selectedConfig, productionConfig);
      events.push('production-confirmed');
      return true;
    },
    fetchImpl: async (url) => {
      const action = url.split('/').pop();
      events.push(action);
      return action === 'update'
        ? response(404, { error: true, code: 'FILE_NOT_FOUND' })
        : response(200, { success: true });
    },
    confirm: async () => {
      events.push('creation-confirmed');
      return true;
    },
    output: { write() {} },
  });

  assert.deepEqual(events, [
    'production-confirmed',
    'update',
    'creation-confirmed',
    'create',
  ]);
  assert.deepEqual(result.created, ['main.min.js']);
});

test('production confirmation fails closed without a TTY', async () => {
  assert.equal(
    await confirmProduction(
      { name: 'production', origin: config.origin },
      { isTTY: false },
      { write() {} }
    ),
    false
  );
});

test('production confirmation requires an explicit yes', async () => {
  async function answer(value) {
    const input = new PassThrough();
    const output = new PassThrough();
    input.isTTY = true;
    const confirmation = confirmProduction(
      { name: 'production', origin: config.origin },
      input,
      output
    );
    input.end(`${value}\n`);
    return confirmation;
  }

  assert.equal(await answer('y'), true);
  assert.equal(await answer('Yes'), true);
  assert.equal(await answer(''), false);
  assert.equal(await answer('n'), false);
  assert.equal(await answer('production'), false);
});

test('updates existing files and reports contracted missing files', async () => {
  const result = await deployAssets({
    config,
    files: [
      { fileName: 'missing.min.css', content: 'missing' },
      { fileName: 'existing.min.css', content: 'existing' },
    ],
    createMissing: false,
    fetchImpl: async (_url, options) => {
      const fileName = JSON.parse(options.body).fileName;
      return fileName.startsWith('missing')
        ? response(404, { error: true, code: 'FILE_NOT_FOUND' })
        : response(200, { success: true, action: 'updated' });
    },
    output: { write() {} },
  });

  assert.deepEqual(result.updated, ['existing.min.css']);
  assert.deepEqual(result.missing, ['missing.min.css']);
  assert.match(
    formatSummary('css', result),
    /CSS deploy finished with missing files:/
  );
});

test('creates missing files only after confirmation', async () => {
  const actions = [];
  const result = await deployAssets({
    config,
    files: [{ fileName: 'template.min.js', content: 'template' }],
    createMissing: true,
    fetchImpl: async (url) => {
      const action = url.split('/').pop();
      actions.push(action);
      return action === 'update'
        ? response(404, { error: true, code: 'FILE_NOT_FOUND' })
        : response(200, { success: true, action: 'created' });
    },
    confirm: async () => true,
    output: { write() {} },
  });

  assert.deepEqual(actions, ['update', 'create']);
  assert.deepEqual(result.created, ['template.min.js']);
  assert.deepEqual(result.missing, []);
});

test('returns a complete summary when creation is declined', async () => {
  const result = await deployAssets({
    config,
    files: [{ fileName: 'template.min.css', content: 'template' }],
    createMissing: true,
    fetchImpl: async () =>
      response(404, { error: true, code: 'FILE_NOT_FOUND' }),
    confirm: async () => false,
    output: { write() {} },
  });

  assert.match(result.error, /cancelled/);
  assert.deepEqual(result.missing, ['template.min.css']);
  assert.match(formatSummary('css', result), /CSS deploy incomplete:/);
  assert.match(formatSummary('css', result), /Missing \(1\)\n  template\.min\.css/);
});

test('reports completed, failed, missing and unprocessed files after an error', async () => {
  const result = await deployAssets({
    config,
    files: [
      { fileName: 'missing.min.css', content: 'missing' },
      { fileName: 'updated.min.css', content: 'updated' },
      { fileName: 'failed.min.css', content: 'failed' },
      { fileName: 'later.min.css', content: 'later' },
    ],
    createMissing: false,
    fetchImpl: async (_url, options) => {
      const fileName = JSON.parse(options.body).fileName;
      if (fileName === 'missing.min.css') {
        return response(404, { error: true, code: 'FILE_NOT_FOUND' });
      }
      if (fileName === 'failed.min.css') throw new Error('offline');
      return response(200, { success: true });
    },
    output: { write() {} },
  });

  assert.deepEqual(result.updated, ['updated.min.css']);
  assert.deepEqual(result.failed, ['failed.min.css']);
  assert.deepEqual(result.missing, ['missing.min.css']);
  assert.deepEqual(result.unprocessed, ['later.min.css']);
  assert.match(formatSummary('css', result), /Not processed \(1\)\n  later\.min\.css/);
});

test('keeps a complete summary when creation fails partway through', async () => {
  const result = await deployAssets({
    config,
    files: [
      { fileName: 'created.min.js', content: 'created' },
      { fileName: 'failed.min.js', content: 'failed' },
      { fileName: 'later.min.js', content: 'later' },
    ],
    createMissing: true,
    fetchImpl: async (url, options) => {
      const action = url.split('/').pop();
      const fileName = JSON.parse(options.body).fileName;
      if (action === 'update') {
        return response(404, { error: true, code: 'FILE_NOT_FOUND' });
      }
      if (fileName === 'failed.min.js') {
        return response(403, { error: true, message: 'Forbidden' });
      }
      return response(200, { success: true, action: 'created' });
    },
    confirm: async () => true,
    output: { write() {} },
  });

  assert.deepEqual(result.created, ['created.min.js']);
  assert.deepEqual(result.failed, ['failed.min.js']);
  assert.deepEqual(result.missing, ['failed.min.js', 'later.min.js']);
  assert.deepEqual(result.unprocessed, ['later.min.js']);
  assert.match(formatSummary('js', result), /Created \(1\)[\s\S]*Failed \(1\)/);
});


test('colors group headings and status without coloring file names', () => {
  const result = {
    updated: ['main.min.css'],
    unchanged: ['template.min.css'],
    created: [],
    failed: ['failed.min.css'],
    missing: ['missing.min.css'],
    unprocessed: ['later.min.css'],
    error: 'offline',
  };
  const plain = formatSummary('css', result, false);
  const colored = formatSummary('css', result, true);
  assert.equal(colored.replace(/\x1b\[[0-9;]*m/g, ''), plain);
  assert.ok(colored.includes('\x1b[1;32mUpdated (1)\x1b[0m\n  main.min.css'));
  assert.ok(colored.includes('\x1b[1;31mFailed (1)\x1b[0m'));
  assert.ok(colored.includes('\x1b[1;36mUnchanged (1)\x1b[0m'));
  assert.doesNotMatch(plain, /Created|\(0\)/);
  assert.match(plain, /CSS deploy incomplete:\n.*\n\nReason: offline/);
});

test('records whether the password came from the Keychain or a prompt', async () => {
  const environment = { SITEVISION_TARGET: 'development', SITEVISION_DEPLOY_USERNAME: config.username };
  const fromKeychain = await getConfig(environment, projectConfig, {
    platform: 'darwin',
    readKeychainPassword: () => 'keychain-password',
  });
  const fromPrompt = await getConfig(environment, projectConfig, {
    platform: 'darwin',
    isInteractive: true,
    readKeychainPassword: () => undefined,
    promptForPassword: async () => 'typed-password',
  });

  assert.equal(fromKeychain.passwordSource, 'keychain');
  assert.equal(fromPrompt.passwordSource, 'prompt');
  assert.equal(fromPrompt.keychainAccount, `${config.username}@${config.expectedHost}`);
});

test('parses Keychain passwords printed by security -g', () => {
  assert.equal(parseKeychainPassword('password: "plain text"\n'), 'plain text');
  assert.equal(parseKeychainPassword('password: 0x61C3A962  "a\\303\\251b"\n'), 'aéb');
  assert.equal(parseKeychainPassword('keychain: "login"\n'), undefined);
});

test('builds a security -i save command that quotes and escapes its arguments', () => {
  assert.equal(
    buildKeychainSaveCommand('user@example.com', 'pa"ss\\wo rd$é'),
    'add-generic-password -U -s sitevision-deploy -a "user@example.com" -w "pa\\"ss\\\\wo rd$é"'
  );
});

function answerKeychainSave(answer) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  const confirmation = confirmKeychainSave('user@example.com', input, output);
  input.end(`${answer}\n`);
  return confirmation;
}

test('saves the Keychain password by default and only on an explicit no', async () => {
  assert.equal(await answerKeychainSave(''), true);
  assert.equal(await answerKeychainSave('y'), true);
  assert.equal(await answerKeychainSave('YES'), true);
  assert.equal(await answerKeychainSave('n'), false);
  assert.equal(await answerKeychainSave('no'), false);
  assert.equal(
    await confirmKeychainSave('user@example.com', { isTTY: false }, { write() {} }),
    false
  );
});

// Fakes replace the real `security` binary and stdin in every afterDeploy call.
function deployFakes({ answer = true, saved = true, output = { write() {} } } = {}) {
  const calls = { asked: [], saved: [] };
  return {
    calls,
    output,
    confirmSave: async (account) => {
      calls.asked.push(account);
      return answer;
    },
    saveKeychain: (account, password) => {
      calls.saved.push({ account, password });
      return saved;
    },
  };
}

function deployResult(overrides = {}) {
  return {
    updated: [],
    unchanged: [],
    created: [],
    failed: [],
    missing: [],
    unprocessed: [],
    error: null,
    ...overrides,
  };
}

const promptConfig = {
  ...config,
  passwordSource: 'prompt',
  keychainAccount: `${config.username}@${config.expectedHost}`,
};

test('offers to save a typed password after the credentials were accepted', async () => {
  const fakes = deployFakes();
  await afterDeploy({
    ...fakes,
    config: promptConfig,
    result: deployResult({ updated: ['main.min.css'] }),
    platform: 'darwin',
    isInteractive: true,
  });

  assert.deepEqual(fakes.calls.asked, [promptConfig.keychainAccount]);
  assert.deepEqual(fakes.calls.saved, [
    { account: promptConfig.keychainAccount, password: config.password },
  ]);
});

test('does not offer to save for other sources, platforms, terminals or outcomes', async () => {
  const accepted = deployResult({ updated: ['main.min.css'] });
  const cases = [
    { config: { ...promptConfig, passwordSource: 'environment' }, result: accepted },
    { config: { ...promptConfig, passwordSource: 'keychain' }, result: accepted },
    {
      config: promptConfig,
      result: deployResult({ failed: ['main.min.css'], error: 'main.min.css: 500 Server Error' }),
    },
    { config: promptConfig, result: accepted, platform: 'linux' },
    { config: promptConfig, result: accepted, isInteractive: false },
  ];

  for (const testCase of cases) {
    const fakes = deployFakes();
    await afterDeploy({
      ...fakes,
      config: testCase.config,
      result: testCase.result,
      platform: testCase.platform ?? 'darwin',
      isInteractive: testCase.isInteractive ?? true,
    });
    assert.deepEqual(fakes.calls.asked, []);
    assert.deepEqual(fakes.calls.saved, []);
  }
});

test('leaves the Keychain unchanged when the save is declined', async () => {
  const fakes = deployFakes({ answer: false });
  await afterDeploy({
    ...fakes,
    config: promptConfig,
    result: deployResult({ updated: ['main.min.css'] }),
    platform: 'darwin',
    isInteractive: true,
  });

  assert.deepEqual(fakes.calls.asked, [promptConfig.keychainAccount]);
  assert.deepEqual(fakes.calls.saved, []);
});

test('warns without the password when the Keychain save fails', async () => {
  const writes = [];
  await afterDeploy({
    ...deployFakes({ saved: false, output: { write: (value) => writes.push(value) } }),
    config: promptConfig,
    result: deployResult({ updated: ['main.min.css'] }),
    platform: 'darwin',
    isInteractive: true,
  });

  const output = writes.join('');
  assert.match(output, /not saved to the macOS Keychain/);
  assert.equal(output.includes(config.password), false);
});

test('hints that a rejected Keychain password may be wrong', async () => {
  const keychainConfig = { ...promptConfig, passwordSource: 'keychain' };
  const rejected = deployResult({
    failed: ['main.min.css'],
    error: 'main.min.css: 401 Unauthorized',
  });
  const run = async (overrides) => {
    const writes = [];
    await afterDeploy({
      ...deployFakes({ output: { write: (value) => writes.push(value) } }),
      platform: 'darwin',
      isInteractive: true,
      ...overrides,
    });
    return writes.join('');
  };

  const hint = await run({ config: keychainConfig, result: rejected });
  assert.match(hint, /may be wrong/);
  assert.match(hint, /delete-generic-password -s sitevision-deploy -a developer@deploy\.example\.sitevision-cloud\.se/);
  assert.equal(
    await run({ config: { ...keychainConfig, passwordSource: 'environment' }, result: rejected }),
    ''
  );
  assert.equal(
    await run({
      config: keychainConfig,
      result: deployResult({ failed: ['main.min.css'], error: 'main.min.css: 500 Server Error' }),
    }),
    ''
  );
});

test('reports a Keychain save as successful only when the item reads back exactly', () => {
  const account = 'developer@deploy.example.sitevision-cloud.se';
  const password = "it's #1 \"q\" \\ é";
  const saved = (readBack, status = 0) =>
    saveKeychainPassword(account, password, {
      runCommand: () => ({ status }),
      readKeychainPassword: () => readBack,
    });

  assert.equal(saved(password), true);
  assert.equal(saved('old-password'), false);
  assert.equal(saved(undefined), false);
  assert.equal(saved(password, 1), false);
});
