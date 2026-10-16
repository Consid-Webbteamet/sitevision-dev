# @consid/sitevision-dev

Shared tooling for Sitevision projects based on the boilerplate:

- a local HTTPS development proxy for BrowserSync that serves local CSS and
  JavaScript bundles in published Sitevision pages,
- local HTTPS certificate setup with mkcert,
- deployment of minified CSS and JavaScript through the `consid-deploy-files`
  RESTApp.

Requires Node.js 22 or later.

## Install

Install a released version from a git tag:

```sh
npm install --save-dev "git+https://github.com/Consid-Webbteamet/sitevision-dev.git#semver:^1.0.0"
```

The repository is public, so no Git credentials or SSH keys are needed. Use the
full `git+https://` URL; the `github:` shorthand can be saved as an SSH URL in
`package-lock.json`.

`package-lock.json` pins the exact commit. Run `npm update @consid/sitevision-dev`
to move to the newest tag within the range.

## Usage in a project

Every command runs from the project root (where `npm run` and Gulp run) and
reads these project files:

| File | Purpose |
| --- | --- |
| `sitevision.project.json` | Named targets with HTTPS `origin` and `production` flag |
| `.env` | `SITEVISION_TARGET`, `SITEVISION_DEPLOY_USERNAME` and optionally `SITEVISION_DEPLOY_PASSWORD` |
| `assets-dist/css`, `assets-dist/js` | Built `*.min.css` and `*.min.js` bundles |
| `.certs/` | Local HTTPS certificate created by `sitevision-cert --setup` |

### Commands

```json
"scripts": {
  "dev": "sitevision-cert && gulp dev",
  "setup:cert": "sitevision-cert --setup",
  "deploy:css": "gulp && sitevision-deploy css",
  "deploy:css:create-missing": "gulp && sitevision-deploy css --create-missing",
  "deploy:js": "gulp && sitevision-deploy js",
  "deploy:js:create-missing": "gulp && sitevision-deploy js --create-missing"
}
```

Messages printed by the commands refer to these script names.

| Command | Description |
| --- | --- |
| `sitevision-cert` | Verifies that the local certificate is valid; fails otherwise |
| `sitevision-cert --setup` | Trusts the local mkcert CA and regenerates the certificate |
| `sitevision-deploy css\|js` | Updates existing files in Sitevision |
| `sitevision-deploy css\|js --create-missing` | Also creates missing files after confirmation |

### Node API

```js
const {
  createDevOptions,
  validateDevConfig,
  removeDeletedAssets,
  loadEnvironment,
  resolveTarget,
} = require('@consid/sitevision-dev');
```

- `loadEnvironment()` and `resolveTarget()` select the target in `dev.config.js`.
- `validateDevConfig(config)` and `createDevOptions(config)` return the
  BrowserSync proxy options for `browserSync.init()`.
- `removeDeletedAssets(files, sourceDirectory, outputDirectory, extension)`
  removes build outputs of deleted sources in Gulp watch tasks.

BrowserSync and Gulp are dependencies of the project, not of this package.

## RESTApp contract

Deployment calls the `consid-deploy-files` RESTApp on the target site. Changes
to this contract must be additive (new endpoints or optional fields) so that
every package version works with every RESTApp version.

`POST {origin}/rest-api/consid-deploy-files/update` and `.../create`

- Basic authentication with the personal Sitevision credentials.
- JSON body: `expectedHost` (hostname of the target origin), `fileName` and
  `content`.
- Success: `{ "success": true, "changed": <boolean> }`. `changed` is optional;
  without it the file is reported as updated.
- Missing file on update: status `404` with
  `{ "error": true, "code": "FILE_NOT_FOUND" }`.
- Other errors: a non-2xx status, optionally with `{ "message": "..." }`.

The RESTApp must reject a request unless `expectedHost` matches both its
configured allowed hostname and `req.hostname`.

## Development

```sh
npm install
npm test
```

## Releasing

Use [semantic versioning](https://semver.org/):

- patch: bug fixes,
- minor: new backwards-compatible features,
- major: changed commands, configuration files or Node API.

1. Update `version` in `package.json` and add an entry to `CHANGELOG.md`.
2. Commit, then tag and push:

   ```sh
   git tag v1.2.3
   git push && git push --tags
   ```

Never move or delete a published tag; release a new version instead.

## License

MIT
