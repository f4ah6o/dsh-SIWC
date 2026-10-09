# Publishing to npm

The `@f12o/dsh-siwc` package is published from the GitHub Actions workflow at [`.github/workflows/publish.yml`](.github/workflows/publish.yml). The workflow runs on a GitHub-hosted Ubuntu runner, pins Node.js, pnpm, and npm, checks the package version and repository metadata, runs the build, typecheck, and tests, packs only `packages/chatgpt`, then publishes that tarball to the public npm registry with OIDC. It does not use an npm token secret.

## Bootstrap the first release

npm requires the package to exist on the registry before it can configure a trusted publisher, and requires account-level two-factor authentication for `npm trust` ([trusted publishing prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites)). The first package version therefore needs one manual publication by an npm package owner.

Use Node.js `24.21.0` and pnpm `11.7.0`. First run the workflow from `main` with its default `dry_run: true` and `expected_version: 0.1.0-alpha.1`. Then, from a checkout of this repository, build and publish the alpha candidate with npm CLI `11.21.0`:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm run test
cd packages/chatgpt
npm exec --yes --package=npm@11.21.0 -- npm login --auth-type=web --registry=https://registry.npmjs.org
npm exec --yes --package=npm@11.21.0 -- npm publish --access public --tag alpha --registry https://registry.npmjs.org
```

Skip `npm login` when this machine is already authenticated as a package owner. Complete the browser login and any two-factor challenge it requests. Check that `packages/chatgpt/package.json` still declares `0.1.0-alpha.1` before publishing; npm does not allow replacing a published version.

## Configure npm trusted publishing

After the first version exists, enable account-level two-factor authentication if needed, then create the package's GitHub Actions trust relationship:

```sh
npm exec --yes --package=npm@11.21.0 -- npm trust github @f12o/dsh-siwc --file publish.yml --repo f4ah6o/dsh-SIWC --env npm --allow-publish --yes
npm exec --yes --package=npm@11.21.0 -- npm trust list @f12o/dsh-siwc
```

The configuration must name workflow file `publish.yml`, repository `f4ah6o/dsh-SIWC`, GitHub environment `npm`, and the `npm publish` permission. npm requires the first successful trusted publish within two days after creating the relationship; create it when a new, unpublished version is ready ([npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)).

## Publish later prereleases

Before each trusted publish, commit a new version that has never been published. From the GitHub Actions page, run **Publish npm package** on `main` with `expected_version` matching `packages/chatgpt/package.json`, choose `alpha` or `canary`, and keep `dry_run: true` for the first run. After its checks pass, run it again with `dry_run: false` to publish. The workflow rejects other repositories and refs, version mismatches, and dist-tags other than `alpha` or `canary`; it never assigns the `latest` tag.

The workflow uses the `npm` GitHub environment and grants only `contents: read` plus `id-token: write`. npm exchanges the job's short-lived OIDC identity for publish access and creates provenance for this public repository; no npm token is stored in GitHub secrets.
