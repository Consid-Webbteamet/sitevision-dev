#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { Writable } = require('node:stream');
const {
  loadEnvironment,
  resolveTarget,
} = require('./sitevision-target');

const projectRoot = process.cwd();
const requestTimeoutMs = 15_000;
const keychainService = 'sitevision-deploy';

function getAssetType(argv = process.argv) {
  const assetType = argv.slice(2).find((argument) => !argument.startsWith('-'));
  if (!['css', 'js'].includes(assetType)) {
    throw new Error('Asset type must be "css" or "js".');
  }
  return assetType;
}

function shouldCreateMissing(argv = process.argv) {
  return argv.includes('--create-missing');
}

function findKeychainPassword(account) {
  // A missing item or a denied prompt is treated the same as no password.
  // `-g` prints the password on stderr; `-w` would hex-encode non-ASCII values.
  const result = spawnSync(
    'security',
    ['find-generic-password', '-s', keychainService, '-a', account, '-g'],
    { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] }
  );
  return result.status === 0 ? parseKeychainPassword(result.stderr) : undefined;
}

function parseKeychainPassword(output) {
  // Passwords with quotes, backslashes or non-ASCII characters are hex-encoded.
  const line = output.split('\n').find((text) => text.startsWith('password: '));
  const hex = line?.match(/^password: 0x([0-9A-Fa-f]+)/);
  if (hex) return Buffer.from(hex[1], 'hex').toString('utf8');
  return line?.match(/^password: "(.*)"$/)?.[1];
}

function quoteForSecurity(value) {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

function buildKeychainSaveCommand(account, password) {
  // The password goes through stdin of `security -i`, never through argv.
  return (
    `add-generic-password -U -s ${keychainService} ` +
    `-a ${quoteForSecurity(account)} -w ${quoteForSecurity(password)}`
  );
}

function runSecurityCommand(command) {
  // Output is ignored so a failing command cannot echo the password.
  return spawnSync('security', ['-i'], {
    input: `${command}\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'ignore', 'ignore'],
  });
}

function saveKeychainPassword(
  account,
  password,
  {
    runCommand = runSecurityCommand,
    readKeychainPassword = findKeychainPassword,
  } = {}
) {
  const result = runCommand(buildKeychainSaveCommand(account, password));
  // `security -i` can exit 0 even when the add fails, so read the item back.
  return result.status === 0 && readKeychainPassword(account) === password;
}

async function askForPassword(prompt) {
  // readline echoes typed characters to this sink, so they are never shown.
  const silentOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const terminal = readline.createInterface({
    input: process.stdin,
    output: silentOutput,
    terminal: true,
  });

  process.stdout.write(prompt);
  try {
    const password = await terminal.question('');
    process.stdout.write('\n');
    return password;
  } finally {
    terminal.close();
  }
}

async function getConfig(
  environment = process.env,
  projectConfig,
  {
    platform = process.platform,
    isInteractive = Boolean(process.stdin.isTTY),
    readKeychainPassword = findKeychainPassword,
    promptForPassword = askForPassword,
  } = {}
) {
  const target = resolveTarget(environment, projectConfig);
  const username = environment.SITEVISION_DEPLOY_USERNAME;

  if (!username) {
    throw new Error('Missing .env values: SITEVISION_DEPLOY_USERNAME');
  }

  // The password is looked up per host so development and production can use
  // different Keychain entries. The environment variable stays for CI.
  const account = `${username}@${target.expectedHost}`;
  let password = environment.SITEVISION_DEPLOY_PASSWORD;
  let passwordSource = 'environment';
  if (!password && platform === 'darwin') {
    password = readKeychainPassword(account);
    passwordSource = 'keychain';
  }
  if (!password && isInteractive) {
    password = await promptForPassword(`Sitevision password for ${account}: `);
    passwordSource = 'prompt';
  }
  if (!password) {
    throw new Error(
      `No deploy password for ${account}. Store it in the macOS Keychain (see README), ` +
        'or set SITEVISION_DEPLOY_PASSWORD for non-interactive runs.'
    );
  }

  return {
    ...target,
    username,
    password,
    passwordSource,
    keychainAccount: account,
  };
}

function getAssetFiles(
  assetType,
  directory = path.join(projectRoot, 'assets-dist', assetType)
) {
  if (!['css', 'js'].includes(assetType)) {
    throw new Error('Asset type must be "css" or "js".');
  }

  // A non-recursive directory read is deliberate: only direct minified
  // entrypoints are deployable, and the sorted order makes the deploy stable.
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(`.min.${assetType}`)
    )
    .map((entry) => ({
      fileName: entry.name,
      content: fs.readFileSync(path.join(directory, entry.name), 'utf8'),
    }))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
}

async function postFile({
  action,
  config,
  file,
  fetchImpl = fetch,
  timeoutMs = requestTimeoutMs,
}) {
  // The RESTApp exposes separate update and create operations so an ordinary
  // deploy cannot accidentally create a new archive file.
  let response;
  try {
    response = await fetchImpl(
      `${config.origin}/rest-api/consid-deploy-files/${action}`,
      {
        method: 'POST',
        headers: {
          Authorization:
            'Basic ' +
            Buffer.from(`${config.username}:${config.password}`).toString(
              'base64'
            ),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          expectedHost: config.expectedHost,
          fileName: file.fileName,
          content: file.content,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      }
    );
  } catch (error) {
    const message =
      error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? `request timed out after ${timeoutMs} ms`
        : `request failed: ${error.message || error}`;
    throw new Error(`${file.fileName}: ${message}`);
  }
  const responseText = await response.text();
  let responseBody;

  try {
    responseBody = responseText ? JSON.parse(responseText) : {};
  } catch (_error) {
    responseBody = {};
  }

  // A missing update target is handled as a possible create candidate; every
  // other failed response remains a hard deployment error.
  if (
    action === 'update' &&
    response.status === 404 &&
    responseBody.error === true &&
    responseBody.code === 'FILE_NOT_FOUND'
  ) {
    return { missing: true };
  }

  if (!response.ok) {
    const message = responseBody.message || responseText || response.statusText;
    throw new Error(`${file.fileName}: ${response.status} ${message}`);
  }

  if (!responseBody.success) {
    throw new Error(`${file.fileName}: RESTApp returned an invalid response`);
  }

  return responseBody;
}

async function confirmCreation(
  fileNames,
  input = process.stdin,
  output = process.stdout
) {
  // Creation changes the remote archive, so non-interactive execution must
  // fail closed instead of treating the absence of a terminal as consent.
  if (!input.isTTY) return false;

  output.write('\nThe following files do not exist in Sitevision:\n');
  fileNames.forEach((fileName) => output.write(`- ${fileName}\n`));

  const terminal = readline.createInterface({ input, output });
  const answer = await terminal.question(
    `Create ${fileNames.length} new file${fileNames.length === 1 ? '' : 's'}? [y/N] `
  );
  terminal.close();

  return ['y', 'yes'].includes(answer.trim().toLowerCase());
}

async function confirmKeychainSave(
  account,
  input = process.stdin,
  output = process.stdout
) {
  // The default is yes, so a non-terminal run must not save the password.
  if (!input.isTTY) return false;

  const terminal = readline.createInterface({ input, output });
  const answer = await terminal.question(
    `Save the password in the macOS Keychain for ${account}? [Y/n] `
  );
  terminal.close();

  const normalized = answer.trim().toLowerCase();
  return normalized === '' || ['y', 'yes'].includes(normalized);
}

async function confirmProduction(
  config,
  input = process.stdin,
  output = process.stdout
) {
  if (!input.isTTY) return false;

  output.write(
    `\nWARNING: "${config.name}" (${config.origin}) is marked as production.\n`
  );
  const terminal = readline.createInterface({ input, output });
  const answer = await terminal.question('Deploy to production? [y/N] ');
  terminal.close();

  return ['y', 'yes'].includes(answer.trim().toLowerCase());
}

async function deployAssets({
  config,
  files,
  createMissing,
  fetchImpl = fetch,
  confirm = confirmCreation,
  confirmProductionTarget = confirmProduction,
  output = process.stdout,
}) {
  const result = {
    updated: [],
    unchanged: [],
    created: [],
    failed: [],
    missing: [],
    unprocessed: [],
    error: null,
  };
  const missingFiles = [];

  output.write(
    `Deploy target: ${config.name} (${config.origin})${
      config.production ? ' [production]' : ''
    }\nDeploying ${files.length} files…\n`
  );
  output.write('\n');

  if (config.production) {
    const confirmed = await confirmProductionTarget(config);
    if (!confirmed) {
      result.unprocessed = files.map((file) => file.fileName);
      result.error =
        'Production deployment cancelled. No network requests were made.';
      return result;
    }
  }

  // Send updates sequentially. Missing files are collected so later existing
  // files still update, while every other remote error stops the deployment.
  for (const [index, file] of files.entries()) {
    try {
      const updateResult = await postFile({
        action: 'update',
        config,
        file,
        fetchImpl,
      });

      if (updateResult.missing) {
        missingFiles.push(file);
      } else if (updateResult.changed === false) {
        result.unchanged.push(file.fileName);
      } else {
        result.updated.push(file.fileName);
      }
    } catch (error) {
      result.failed.push(file.fileName);
      result.missing = missingFiles.map((missingFile) => missingFile.fileName);
      result.unprocessed = files
        .slice(index + 1)
        .map((unprocessedFile) => unprocessedFile.fileName);
      result.error = error.message;
      return result;
    }
  }

  if (missingFiles.length === 0) {
    return result;
  }

  if (!createMissing) {
    result.missing = missingFiles.map((file) => file.fileName);
    return result;
  }

  const confirmed = await confirm(missingFiles.map((file) => file.fileName));
  if (!confirmed) {
    result.missing = missingFiles.map((file) => file.fileName);
    result.error = 'Creation cancelled. No missing files were created.';
    return result;
  }

  // Only the confirmed missing files use the create-only endpoint. Existing
  // files were already handled above and are never recreated here.
  for (const [index, file] of missingFiles.entries()) {
    try {
      await postFile({
        action: 'create',
        config,
        file,
        fetchImpl,
      });
      result.created.push(file.fileName);
    } catch (error) {
      result.failed.push(file.fileName);
      result.missing = missingFiles
        .slice(index)
        .map((missingFile) => missingFile.fileName);
      result.unprocessed = missingFiles
        .slice(index + 1)
        .map((unprocessedFile) => unprocessedFile.fileName);
      result.error = error.message;
      return result;
    }
  }

  return result;
}

function formatSummary(
  assetType,
  result,
  color = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined
) {
  const style = (text, code) =>
    color ? `\x1b[${code}m${text}\x1b[0m` : text;
  let status = 'complete';
  let statusColor = '1;32';
  if (result.error || result.failed.length) {
    status = 'incomplete';
    statusColor = '1;31';
  } else if (result.missing.length) {
    status = 'finished with missing files';
    statusColor = '1;33';
  }

  const lines = [''];
  const counts = [];
  for (const [label, fileNames, code] of [
    ['Updated', result.updated, '1;32'],
    ['Created', result.created, '1;32'],
    ['Failed', result.failed, '1;31'],
    ['Missing', result.missing, '1;33'],
    ['Not processed', result.unprocessed, '1;33'],
    ['Unchanged', result.unchanged, '1;36'],
  ]) {
    if (fileNames.length > 0) {
      lines.push(style(`${label} (${fileNames.length})`, code));
      lines.push(...fileNames.map((fileName) => `  ${fileName}`), '');
      counts.push(`${fileNames.length} ${label.toLowerCase()}`);
    }
  }

  lines.push(style(`${assetType.toUpperCase()} deploy ${status}:`, statusColor));
  if (counts.length > 0) lines.push(counts.join(', '));
  if (result.error) lines.push('', `Reason: ${result.error}`);
  return `${lines.join('\n')}\n`;
}

async function afterDeploy({
  config,
  result,
  platform = process.platform,
  isInteractive = Boolean(process.stdin.isTTY),
  confirmSave = confirmKeychainSave,
  saveKeychain = saveKeychainPassword,
  output = process.stdout,
}) {
  // A 404 with the RESTApp contract also proves the credentials were accepted.
  const credentialsAccepted =
    result.updated.length +
      result.unchanged.length +
      result.created.length +
      result.missing.length >
    0;

  if (
    config.passwordSource === 'prompt' &&
    platform === 'darwin' &&
    isInteractive &&
    credentialsAccepted &&
    (await confirmSave(config.keychainAccount))
  ) {
    if (saveKeychain(config.keychainAccount, config.password)) {
      output.write('Password saved to the macOS Keychain.\n');
    } else {
      output.write('Warning: the password was not saved to the macOS Keychain.\n');
    }
  }

  // 403 can also mean missing write permission, so the hint says "may".
  if (
    config.passwordSource === 'keychain' &&
    /: (401|403) /.test(result.error || '')
  ) {
    const { keychainAccount: account } = config;
    output.write(
      `\nThe Keychain password for ${account} may be wrong or out of date. ` +
        'Update it with:\n' +
        `  security add-generic-password -U -s ${keychainService} -a ${account} -w\n` +
        'or remove it with:\n' +
        `  security delete-generic-password -s ${keychainService} -a ${account}\n`
    );
  }
}

async function main() {
  loadEnvironment();
  const assetType = getAssetType();
  const config = await getConfig();
  const files = getAssetFiles(assetType);

  if (files.length === 0) {
    throw new Error(
      `No top-level assets-dist/${assetType}/*.min.${assetType} files found.`
    );
  }

  const result = await deployAssets({
    config,
    files,
    createMissing: shouldCreateMissing(),
  });

  process.stdout.write(formatSummary(assetType, result));

  if (result.error || result.failed.length > 0 || result.missing.length > 0) {
    if (!result.error && result.missing.length > 0) {
      process.stdout.write(
        `Run "npm run deploy:${assetType}:create-missing" to create missing files.\n`
      );
    }
    process.exitCode = 1;
  }

  await afterDeploy({ config, result });
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Asset deploy failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  afterDeploy,
  buildKeychainSaveCommand,
  confirmCreation,
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
};
