const fs = require('node:fs');
const path = require('node:path');

// Watch builds do not clean assets-dist. Remove only outputs belonging to
// deleted sources, before the next build in the same watcher queue.
function removeDeletedAssets(sourceFiles, sourceDirectory, outputDirectory, extension) {
  for (const file of sourceFiles) {
    if (fs.existsSync(file)) continue;
    const relative = path.relative(path.resolve(sourceDirectory), path.resolve(file));
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;

    let bundle;
    let directoryBundle = false;
    if (extension === 'css') {
      if (path.basename(relative).startsWith('_')) continue;
      bundle = relative.replace(/\.(scss|sass)$/, '');
    } else {
      const parts = relative.split(path.sep);
      bundle = parts[0].replace(/\.ts$/, '');
      if (parts.length > 1) {
        directoryBundle = true;
        const directory = path.resolve(sourceDirectory, parts[0]);
        // A TypeScript directory is concatenated into one bundle. Keep it
        // while any direct TypeScript source remains for the next build.
        if (fs.existsSync(directory) && fs.readdirSync(directory)
          .some((entry) => entry.endsWith('.ts'))) continue;
      }
    }

    const bundles = directoryBundle ? [bundle, bundle + '.polyfills'] : [bundle];
    for (const name of bundles) {
      for (const suffix of [`.${extension}`, `.min.${extension}`, `.${extension}.map`, `.min.${extension}.map`]) {
        fs.rmSync(path.resolve(outputDirectory, name + suffix), { force: true });
      }
    }
  }
}

module.exports = { removeDeletedAssets };
