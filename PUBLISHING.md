# Publishing to npm

The `@f12o/dsh-siwc` package is published from the GitHub Actions workflow at [`.github/workflows/publish.yml`](.github/workflows/publish.yml). The workflow runs on a GitHub-hosted Ubuntu runner, pins Node.js, pnpm, and npm, checks the package version and repository metadata, runs the build, typecheck, and tests, packs only `packages/chatgpt`, then publishes that tarball to the public npm registry with OIDC. It does not use an npm token secret.

## Bootstrap a package name

npm requires a package to exist before it can configure a trusted publisher, and requires account-level two-factor authentication for `npm trust` ([trusted publishing prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites)). Manually publish one unique initial version only when the package name is absent from npm. The `@f12o/dsh-siwc` name is already bootstrapped: `0.1.0-alpha.1` was manually published. Do not manually publish later versions after the package name exists; use the trusted workflow.

## Check npm trusted publishing

The npm trust relationship is configured for repository `f4ah6o/dsh-SIWC`, workflow file `publish.yml`, GitHub environment `npm`, and the `npm publish` permission.

Run `npm trust list` and any needed `npm trust` configuration with npm CLI `11.21.0` while authenticated as a package owner. npm may request browser sign-in and two-factor verification:

```sh
npm exec --yes --package=npm@11.21.0 -- npm trust list @f12o/dsh-siwc
```

If the relationship is absent, enable account-level two-factor authentication and restore it with:

```sh
npm exec --yes --package=npm@11.21.0 -- npm trust github @f12o/dsh-siwc --file publish.yml --repo f4ah6o/dsh-SIWC --env npm --allow-publish --yes
```

npm requires the first successful trusted publish within two days after creating the relationship, so register it when a new version is ready ([npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)).

## Publish prereleases

Before each trusted publish, commit a version that has never been published. The workflow's `expected_version` default must match `packages/chatgpt/package.json`; confirm both values before dispatch, and update the workflow default with each package version change. Use Node.js `24.21.0` and pnpm `11.7.0`; run **Publish npm package** on `main` with that `expected_version`, choose the `alpha` or `canary` dist-tag, and keep `dry_run: true` for the first run. After the dry-run checks pass, run it again with `dry_run: false` to publish the tarball.

The workflow rejects other repositories and refs, version mismatches, and dist-tags other than `alpha` or `canary`; it never assigns the `latest` tag. The publish job uses the `npm` GitHub environment and grants only `contents: read` plus `id-token: write`. npm exchanges the job's short-lived OIDC identity for publish access and creates provenance for this public repository.
