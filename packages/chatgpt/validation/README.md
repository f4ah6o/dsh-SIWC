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
