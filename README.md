# `@f4ah6o/dsh-chatgpt`

ChatGPT subscription inference for DeepSeek Harness through OpenAI's Sign in with ChatGPT flow. The package keeps OAuth credentials in the Host Credentials service and exposes only redacted account state to the Client.

Install the package in the environment that resolves the DSH Host plugin and Client contribution. Add a profile entry to enable it:

```yaml
- id: chatgpt
  name: '@f4ah6o/dsh-chatgpt'
  config:
    authorizeOnStart: true
```

`authorizeOnStart` starts a local-browser sign-in before a headless profile begins its task when no account is connected. Web and Desktop users can start sign-in from the account settings view. A connected account can also serve saved-grant SDK and headless runs without opening a browser.

The package publishes separate Host, Remote, and lazy Client entry points. Its supported DSH compatibility is limited to the explicitly tested `0.2.0-rc.2` and `0.2.1-alpha.1` API lines; install a matching DSH release and Cordis runtime.
