const fs = require('node:fs');
const path = require('node:path');

// Keep published pages and non-bundled resources upstream while replacing only
// the local bundles that the page already references.
function validateDevConfig(config) {
  if (!config.target) {
    throw new Error(
      'The selected Sitevision target is missing an origin.'
    );
  }

  if (config.https && typeof config.https === 'object') {
    // Fail before BrowserSync starts if its local TLS files are missing. The
    // local certificate is separate from, and does not weaken, upstream TLS.
    const missingCertificateFiles = ['key', 'cert']
      .map((property) => config.https[property])
      .filter((file) => typeof file === 'string' && !fs.existsSync(file));

    if (missingCertificateFiles.length) {
      throw new Error(
        `Local HTTPS certificate is missing. Run "npm run setup:cert" first. Missing: ${missingCertificateFiles.join(', ')}`
      );
    }
  }

  const target = new URL(config.target);
  if (!['http:', 'https:'].includes(target.protocol) || target.pathname !== '/' ||
      target.search || target.hash || target.username || target.password) {
    throw new Error('dev.config.js target must be a website origin, without a path or credentials.');
  }
  return target;
}

function createDevOptions(config, outputDirectory = path.resolve('assets-dist'), logger = console) {
  const target = validateDevConfig(config);

  const files = new Map();
  // Build the asset set once, after the initial Gulp build. Only direct files
  // ending in *.min.css or *.min.js become local entrypoints; source files,
  // nested component bundles, and later additions remain upstream until the
  // proxy is restarted.
  for (const extension of ['css', 'js']) {
    const directory = path.resolve(outputDirectory, extension);
    const suffix = `.min.${extension}`;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      // CSS-only or JS-only builds do not create the other directory.
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(suffix)) {
        files.set(entry.name, path.join(directory, entry.name));
      }
    }
  }

  const servedBundles = new Set();

  // Local responses whose upstream response has started. BrowserSync may still
  // be buffering a partial body, so headersSent cannot tell whether a
  // status-coded error page is still valid.
  const startedResponses = new WeakSet();

  function handleProxyError(error, response) {
    // A broken upstream can report through both the request and the response.
    if (response.destroyed || response.writableEnded) return;
    const responseStarted = startedResponses.has(response);
    const timedOut = error.code === 'ETIMEDOUT';
    const message = timedOut
      ? `Target ${target.host} did not respond within 15 seconds.`
      : responseStarted
        ? `Target ${target.host} ended the response early (${error.code || 'upstream error'}).`
        : `Could not connect to target ${target.host} (${error.code || 'upstream error'}).`;
    logger.error(`[Dev] ${message} Check the target, network/VPN and upstream HTTPS certificate.`);
    if (responseStarted || response.headersSent) return response.destroy();
    response.writeHead(timedOut ? 504 : 502, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(`${message}\nCheck the dev terminal for details.`);
  }

  function localAssets(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, target).pathname);
    } catch {
      res.writeHead(400);
      return res.end('Invalid asset URL');
    }
    // Sitevision URLs contain archive IDs and may have cache-busting queries.
    // Matching the final filename exactly keeps those URL details irrelevant
    // without making similarly named or unrelated files local by accident.
    const filename = path.posix.basename(pathname);
    const sourceMap = filename.endsWith('.map');
    // A map is local only when its minified bundle was discovered as well;
    // orphan maps continue to be served by Sitevision.
    const asset = files.get(sourceMap ? filename.slice(0, -4) : filename);
    if (!asset) return next();

    const localPath = asset + (sourceMap ? '.map' : '');
    fs.readFile(localPath, (error, content) => {
      if (error) {
        // Do not silently fall back to the published bundle after discovery:
        // that would hide a broken or stale local build.
        logger.error(`[Dev] Local build file unavailable: ${filename}. Check the build output; restart after removing or renaming bundles.`);
        res.writeHead(error.code === 'ENOENT' ? 404 : 500, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        return res.end(`Local build file unavailable: ${filename}. Check the Gulp build output.`);
      }
      if (!sourceMap && req.method === 'GET' && !servedBundles.has(filename)) {
        servedBundles.add(filename);
        logger.log(`[Dev] Serving local bundle: ${filename}`);
      }
      res.writeHead(200, {
        'Content-Type': sourceMap ? 'application/json' :
          filename.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': content.length,
      });
      res.end(req.method === 'HEAD' ? undefined : content);
    });
  }

  return {
    proxy: {
      target: target.origin,
      // The proxy's own certificate terminates local HTTPS; secure: true keeps
      // certificate verification enabled for the separate upstream request.
      proxyOptions: { secure: true, cookieDomainRewrite: '' },
      // Rewrite only Domain for loopback. BrowserSync's cookie parser drops
      // Secure, so http-proxy must preserve Secure, HttpOnly and SameSite.
      cookies: { stripDomain: false },
      proxyRes: [(response, incoming, localResponse) => {
        // http-proxy pipes the body but does not end the local response when the
        // upstream connection breaks after the headers.
        startedResponses.add(localResponse);
        response.on('error', (error) => handleProxyError(error, localResponse));
        const location = response.headers.location;
        // Rewrite only redirects back to the target origin. External redirects
        // must remain external, while 303 is handled explicitly for login POSTs.
        if ([301, 302, 303, 307, 308].includes(response.statusCode) &&
            location && URL.canParse(location, target)) {
          const requestUrl = new URL(incoming.url, target);
          const redirect = new URL(location, requestUrl);
          if (redirect.origin === target.origin) {
            const localOrigin = `${incoming.socket.encrypted ? 'https' : 'http'}://${incoming.headers.host}`;
            response.headers.location = localOrigin + redirect.pathname + redirect.search + redirect.hash;
          }
        }
        if ((response.headers['content-type'] || '').includes('text/html')) {
          // BrowserSync buffers rewritten HTML and supplies Content-Length.
          delete response.headers['transfer-encoding'];
          // The injected BrowserSync client needs inline script and a socket;
          // this relaxation applies only to the loopback preview response.
          delete response.headers['content-security-policy'];
          delete response.headers['content-security-policy-report-only'];
          response.headers['cache-control'] = 'no-store';
        }
      }],
      proxyReq: [(request, incoming, response) => {
        // BrowserSync's errHandler receives only the error, so handle the
        // outgoing request here where the local response is available too.
        request.on('error', (error) => handleProxyError(error, response));
        request.setTimeout(15000, () => {
          const error = new Error('Upstream request timed out');
          error.code = 'ETIMEDOUT';
          request.destroy(error);
        });
        const localOrigin = `${incoming.socket.encrypted ? 'https' : 'http'}://${incoming.headers.host}`;
        // Translate same-origin form submissions to the target, but preserve a
        // genuinely foreign Origin or Referer instead of disguising its source.
        if (incoming.headers.origin === localOrigin) {
          request.setHeader('origin', target.origin);
        }
        const referer = incoming.headers.referer;
        if (referer === localOrigin || (referer && referer.startsWith(localOrigin + '/'))) {
          request.setHeader('referer', target.origin + referer.slice(localOrigin.length));
        }
        // A 304 response has no HTML for BrowserSync to inject its client into.
        request.removeHeader('if-none-match');
        request.removeHeader('if-modified-since');
      }],
    },
    middleware: [localAssets],
    callbacks: {
      ready(error, bs) {
        if (error) return;
        logger.log(`[Dev] Target: ${config.targetName || target.host} → ${target.origin}${config.production ? ' (PRODUCTION)' : ''}`);
        logger.log(`[Dev] Local: ${bs.options.getIn(['urls', 'local'])}`);
        logger.log(`[Dev] Available local bundles: ${[...files.keys()].sort().join(', ') || 'none'}`);
        logger.log('[Dev] Bundles are used only when the page references their exact filenames.');
        logger.log('[Dev] SCSS → CSS injection. TypeScript → page reload.');
        logger.log('[Dev] Restart after adding, removing or renaming bundles, or changing target. Stop with Ctrl+C.');
        if (config.production) {
          logger.log('[Dev] Forms and other requests are forwarded to the production site.');
        }
      },
    },
    // Sitevision may also emit CSP through a meta element.
    rewriteRules: [{
      match: /<meta\b(?=[^>]*\bhttp-equiv\s*=\s*["']Content-Security-Policy(?:-Report-Only)?["'])[^>]*>/gi,
      replace: '',
    }],
    port: config.port,
    https: config.https,
    // Bind the preview to loopback; it is a local development proxy, not a
    // network-facing replacement for the published site.
    listen: '127.0.0.1',
    open: true,
    online: false,
    ui: false,
    ghostMode: false,
    notify: false,
  };
}

module.exports = { createDevOptions, validateDevConfig };
