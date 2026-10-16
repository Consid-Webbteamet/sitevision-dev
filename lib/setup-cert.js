#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { X509Certificate, createPrivateKey, createPublicKey } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { isIP } = require('node:net');

const certificateNames = ['localhost', '127.0.0.1', '::1'];

function installMessage(platform) {
  if (platform === 'darwin') {
    return 'Install it with "brew install mkcert" and run this command again.';
  }
  if (platform === 'win32') {
    return 'Install it with "choco install mkcert" and run this command again.';
  }
  return 'Install mkcert from https://github.com/FiloSottile/mkcert and run this command again.';
}

function runMkcert(arguments_, options = {}) {
  const run = options.spawnSync || spawnSync;
  const result = run('mkcert', arguments_, {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
  });

  if (result.error?.code === 'ENOENT') {
    throw new Error(`mkcert is not installed or is not available in PATH.\n${installMessage(options.platform || process.platform)}`);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`mkcert exited with status ${result.status || 1}.${details ? `\n${details}` : ''}`);
  }

  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

function certificateIsUsable(certificateFile, keyFile, options = {}) {
  const fileSystem = options.fs || fs;
  const now = options.now || Date.now();
  const minimumValidity = options.minimumValidity || 30 * 24 * 60 * 60 * 1000;

  try {
    const certificate = new X509Certificate(fileSystem.readFileSync(certificateFile));
    const certificateKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
    const privateKey = createPrivateKey(fileSystem.readFileSync(keyFile));
    const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });

    // Do not reuse a certificate merely because it parses: it must cover all
    // local names, have enough lifetime left, and match the private key.
    return certificateNames.every((name) => isIP(name) ? certificate.checkIP(name) : certificate.checkHost(name)) &&
      new Date(certificate.validFrom).getTime() <= now &&
      new Date(certificate.validTo).getTime() - now > minimumValidity &&
      certificateKey.equals(publicKey);
  } catch {
    return false;
  }
}

function ensureCertificate(options = {}) {
  const fileSystem = options.fs || fs;
  const logger = options.logger || console;
  const projectDirectory = options.projectDirectory || process.cwd();
  const certificateDirectory = path.join(projectDirectory, '.certs');
  const keyFile = path.join(certificateDirectory, 'localhost-key.pem');
  const certificateFile = path.join(certificateDirectory, 'localhost.pem');
  const executeMkcert = (arguments_) => runMkcert(arguments_, options);
  const usable = options.certificateIsUsable || certificateIsUsable;

  if (options.setup) {
    // Trust-store changes are limited to the explicit setup command because
    // the operating system may request administrator approval.
    executeMkcert(['-install']);
    logger.log('✓ Local HTTPS authority is trusted by the system.');
  }

  // Ordinary development startup reuses a valid leaf certificate. Explicit
  // setup always regenerates it from the currently installed local CA so the
  // command also repairs a replaced or restored mkcert authority.
  if (!options.setup && usable(certificateFile, keyFile, options)) {
    fileSystem.chmodSync(keyFile, 0o600);
    logger.log(`✓ Reusing the valid certificate in ${certificateDirectory}`);
    logger.log('✓ Local HTTPS certificate is ready.');
    return { certificateFile, keyFile, generated: false };
  }

  if (!options.setup) {
    throw new Error(
      'Local HTTPS certificate is missing, invalid or expires soon. Run "npm run setup:cert" and then start development again.'
    );
  }

  fileSystem.mkdirSync(certificateDirectory, { recursive: true });
  executeMkcert([
    '-key-file', keyFile,
    '-cert-file', certificateFile,
    ...certificateNames,
  ]);
  // The private key is used only by the local HTTPS listener and should not
  // be readable by other users on the development machine.
  fileSystem.chmodSync(keyFile, 0o600);

  logger.log(`✓ Created a certificate for localhost, 127.0.0.1 and ::1 in ${certificateDirectory}`);
  logger.log('✓ Local HTTPS certificate is ready.');
  return { certificateFile, keyFile, generated: true };
}

if (require.main === module) {
  try {
    ensureCertificate({ setup: process.argv.includes('--setup') });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { certificateIsUsable, ensureCertificate, runMkcert };
