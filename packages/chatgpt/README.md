# `@f4ah6o/dsh-chatgpt`

ChatGPT subscription inference for DeepSeek Harness through OpenAI's Sign in with ChatGPT flow. The package keeps OAuth credentials in the Host Credentials service and exposes only redacted account state to the Client.

Install the bundle in each profile that should provide ChatGPT inference:

```sh
dsh plugin --profile web add @f4ah6o/dsh-chatgpt
dsh plugin --profile headless add @f4ah6o/dsh-chatgpt
```

Web and Desktop users can sign in from ChatGPT account settings. To sign in from a CLI-only profile, opt into a local browser flow for that invocation with a profile patch:

```sh
cat > /tmp/chatgpt-headless-login.patch.yml <<'YAML'
- id: chatgpt
  config:
    authorizeOnStart: true
YAML

dsh --profile headless --patch /tmp/chatgpt-headless-login.patch.yml "List the models available to my ChatGPT account"
```

The command prints a loopback authorization URL and waits for the callback. Open the URL in a browser on the same PC. The account grant is saved in the profile Credentials store; later headless and SDK requests use it without opening a browser. `authorizeOnStart` defaults to `false`.

The Client shows the account's full list-visible model catalog. The provider only selects models with known context metadata. Configure `modelOverrides` for a new model or a capability that differs for your SIWC account; each row is keyed by the exact model slug and may set `contextWindow`, `inputModalities`, `reasoningEfforts`, and `defaultReasoningEffort`.

The package publishes separate Host, Remote, and lazy Client entry points. Its supported DSH compatibility is limited to the explicitly tested `0.2.0-rc.2` and `0.2.1-alpha.1` API lines; install a matching DSH release and Cordis runtime.
