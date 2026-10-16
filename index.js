const { createDevOptions, validateDevConfig } = require('./lib/dev-proxy');
const { removeDeletedAssets } = require('./lib/dev-watch');
const {
  loadEnvironment,
  readProjectConfig,
  resolveTarget,
} = require('./lib/sitevision-target');

module.exports = {
  createDevOptions,
  loadEnvironment,
  readProjectConfig,
  removeDeletedAssets,
  resolveTarget,
  validateDevConfig,
};
