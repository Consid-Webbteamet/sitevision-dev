const fs = require('node:fs');
const path = require('node:path');

// Commands run from the project root, as npm scripts and Gulp do.
const projectRoot = process.cwd();
const projectConfigFile = path.join(projectRoot, 'sitevision.project.json');

function loadEnvironment(directory = projectRoot) {
  const environmentFile = path.join(directory, '.env');
  if (fs.existsSync(environmentFile)) {
    process.loadEnvFile(environmentFile);
  }
}

function readProjectConfig(fileName = projectConfigFile) {
  let contents;
  try {
    contents = fs.readFileSync(fileName, 'utf8');
  } catch (error) {
    throw new Error(`Could not read ${path.basename(fileName)}: ${error.message}`);
  }

  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Could not parse ${path.basename(fileName)}: ${error.message}`);
  }
}

function resolveTarget(
  environment = process.env,
  projectConfig = readProjectConfig()
) {
  const targetName = environment.SITEVISION_TARGET;
  if (!targetName) {
    throw new Error(
      'SITEVISION_TARGET is missing. Copy .env.example to .env and select a target from sitevision.project.json.'
    );
  }

  const targets = projectConfig?.targets;
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)) {
    throw new Error('sitevision.project.json must contain a "targets" object.');
  }
  if (!Object.hasOwn(targets, targetName)) {
    throw new Error(
      `Unknown SITEVISION_TARGET "${targetName}". Add it to sitevision.project.json or select an existing target.`
    );
  }

  const target = targets[targetName];
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new Error(
      `Target "${targetName}" in sitevision.project.json must be an object.`
    );
  }
  if (typeof target.production !== 'boolean') {
    throw new Error(
      `Target "${targetName}" in sitevision.project.json must have an explicit boolean "production" value.`
    );
  }
  if (typeof target.origin !== 'string' || /replace-me/i.test(target.origin)) {
    throw new Error(
      `Target "${targetName}" has a replace-me origin. Set its HTTPS origin in sitevision.project.json before running dev or deploy.`
    );
  }

  let origin;
  try {
    origin = new URL(target.origin);
  } catch (_error) {
    throw new Error(
      `Target "${targetName}" origin must be an HTTPS website origin without a path or credentials.`
    );
  }
  if (
    !/^https:\/\/[^/?#]+\/?$/i.test(target.origin) ||
    origin.protocol !== 'https:' ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new Error(
      `Target "${targetName}" origin must be an HTTPS website origin without a path or credentials.`
    );
  }

  return {
    name: targetName,
    origin: origin.origin,
    expectedHost: origin.hostname,
    production: target.production,
  };
}

module.exports = {
  loadEnvironment,
  readProjectConfig,
  resolveTarget,
};
