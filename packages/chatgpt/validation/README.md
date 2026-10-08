# ChatGPT auxiliary wire probe

Run this probe after installing the packed ChatGPT plugin in a profile and installing the matching public DSH packages in a consumer. It accepts DSH `0.2.0-rc.2` and `0.2.1-alpha.1`.

Set `DSH_CONSUMER_DIR` to the consumer directory and `DSH_PLUGIN_DIR` to the installed `@f4ah6o/dsh-chatgpt` package directory, then run `auxiliary-wire-probe.mjs` with Node `^22.19.0 || >=24.0.0`. For example:

```sh
DSH_CONSUMER_DIR=/path/to/consumer \
DSH_PLUGIN_DIR=/path/to/profile/node_modules/@f4ah6o/dsh-chatgpt \
node /path/to/plugin-checkout/packages/chatgpt/validation/auxiliary-wire-probe.mjs
```

When the plugin is installed directly in the consumer, `DSH_PLUGIN_DIR` may be omitted. Without `DSH_CONSUMER_DIR`, the current working directory is used as the consumer directory. The probe resolves both packages through their public exports; it does not import repository source files.

The fixture generates a local signing key, fake OAuth tokens, a local callback server, and a fake Responses SSE endpoint. Requests to the OpenAI hosts are redirected to that local fixture; any other external request is blocked. The probe needs no account, secret, or live API call. It checks the login host ID, title generation through the public title helper with a 64-token policy, compaction through `BasicCompactionEngine` with a 65,536-token policy, Responses tool calls and usage mapping, and rejection of an ordinary `maxTokens` request before HTTP.

Responses requests omit `max_output_tokens`. The policy values remain recorded by DSH and guide the title and compaction callers, but the provider cannot enforce those values as output ceilings when the Responses API request omits the cap.

## Recorded compatibility run

The v3 package tarball has SHA-256 `139c61df89e0b8ab4aaddd1e0c26976c6aafdbc5a3c5098ead62b5979f3e2ecc`. The byte-identical archive is preserved at `dist/f4ah6o-dsh-chatgpt-0.1.0.tgz` in the plugin checkout. The run completed on 2026-10-08 against published DSH `0.2.0-rc.2` and `0.2.1-alpha.1` installations.

Both versions passed the SDK Host probe, initialize/shutdown and disposal checks, a headless task against a local DeepSeek stub, the Web account-empty state with the generated Remote, `sdk-minimal` with matching public provider packages, and the preflight failure case with required providers disabled. Both versions also passed the auxiliary wire probe described above, including the persisted `urn:uuid:` host ID, title and compaction invocation policies, Responses tool and usage mapping, and rejection of an ordinary output-cap request before HTTP. Consumer logs are under `/tmp/dsh-chatgpt-compat-nan9yvg1/harness-v3-final/<version>/logs/` on the validation host.

The same v3 tarball passed the SDK, headless, Web, and `sdk-minimal` matrix against the `f4ah6o/deepseek-harness` checkout at commit `c27b5d573c1d`. The fork Web smoke used its Japanese default locale. The disabled-provider case reported the missing `credentials` and `authorization` services. Its logs are under `/tmp/dsh-chatgpt-compat-nan9yvg1/harness-P4gNBj/fork-main-v3/logs/`. The auxiliary wire probe also passed with the fork consumer and official DSH compatibility helper `0.2.1-alpha.1`.

The fixture probes use local OAuth and Responses fixtures; they do not authorize a ChatGPT account or make an inference request. The installed SDK, headless, Web, and fork checks also used empty ChatGPT account state. Real ChatGPT inference remains a separate unverified acceptance check.

The final local source checks passed: `pnpm test` reported 10 files and 69 tests passed in 4.77 seconds, `pnpm run typecheck` passed, `pnpm run build` passed for Host and Client, and `git diff --check` passed. The two direct auxiliary probe commands described above also exited successfully. This workspace has no lint script or linter configuration.
