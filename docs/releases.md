# Release guidance

The repository currently builds a web app, server and CLI bundles, a browser
demo, and a Docker image. See [development.md](development.md) and
[deployment.md](deployment.md) for their build and deployment commands.

For a proposed release, record the source commit, user-visible changes,
compatibility changes to the API or CLI, configuration changes, database
migration steps, and rollback considerations in its release notes. Validate
the relevant artifacts using the checks documented in the development guide
and `.github/workflows/ci.yml`.

No release cadence, semantic-versioning commitment, or supported-version
window is established by this document. The maintainer must decide those
before publishing versioned releases.

## Releasing `@poietic-tech/issues`

`apps/cli` is published to npm as `@poietic-tech/issues`, a module for the
`poietic-tech` host CLI. The release workflow
(`.github/workflows/release-issues.yml`) publishes it from a tag, through npm
trusted publishing (OIDC); no npm token exists.

1. Bump `version` in `apps/cli/package.json` and merge to `main`.
2. Tag the merge commit `issues-vX.Y.Z` (matching the version exactly) and push
   the tag.
3. Watch the `release-issues` run. It typechecks, runs the CLI tests (including
   the bundle test), checks that the tag is on `main`, matches the package
   version and that `dependencies` and `peerDependencies` hold no `workspace:`
   or `file:` specifier, builds the bundle, runs
   `apps/cli/scripts/smoke.sh` against the real host, and publishes.

`apps/cli/scripts/smoke.sh` also runs in CI as `module-smoke`. It needs network
access, since it installs `@poietic-tech/cli` from npm.

### One-time owner steps

1. Claim the npm name with a manual placeholder publish of
   `@poietic-tech/issues@0.0.1-stage`, with 2FA and `--tag stage`. A version
   that has been used once can never be published again.
2. On npmjs.com, add a trusted publisher: `poietic-tech` / `poietic-issues` /
   `release-issues.yml` / environment `npm`.
3. In the GitHub repo `poietic-tech/poietic-issues`, create the environment
   `npm` with the tag rule `issues-v*`, and protect it with required reviewers.
   Also add a tag ruleset restricting who can create `issues-v*` tags. The
   guards in the workflow stop mistakes, not malice.
4. Create the `github-ci` agent, set the org secret `POIETIC_AGENT_TOKEN`, and
   delete the old `POIETIC_ISSUES_*` token secret.
5. Delete `~/.config/poietic-issues/config.json`. Install the module, and use
   `poietic-tech login` with `POIETIC_IDENTITY=Claude` for local Claude
   sessions.

## Releasing `@poietic-tech/issues-client`

`packages/client` is published to npm as `@poietic-tech/issues-client`: the typed API client, the event follower and the provenance helpers agents use. The release workflow (`.github/workflows/release-issues-client.yml`) publishes it from a tag, through npm trusted publishing (OIDC).

Inside the monorepo the package's `exports` points at `src/`, as for every internal package. The workflow builds `dist/` and runs `packages/client/scripts/publish-manifest.mjs`, which points `exports` at the build and drops the monorepo-only fields, just before `npm publish`.

1. Bump `version` in `packages/client/package.json` and merge to `main`.
2. Tag the merge commit `issues-client-vX.Y.Z` (matching the version exactly) and push the tag.
3. Watch the `release-issues-client` run. It typechecks, runs the client tests (including the bundle test, which builds and imports the package), checks that the tag is on `main`, matches the package version and that `dependencies` holds no `workspace:` or `file:` specifier, builds, rewrites the manifest and publishes.

### One-time owner steps

1. Claim the npm name with a manual placeholder publish of `@poietic-tech/issues-client@0.0.1-stage`, with 2FA and `--tag stage`.
2. On npmjs.com, add a trusted publisher: `poietic-tech` / `poietic-issues` / `release-issues-client.yml` / environment `npm`.
3. Extend the `npm` environment's tag rule and the tag ruleset to cover `issues-client-v*`.
