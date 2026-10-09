# Installed Desktop verification

Desktop acceptance is incomplete. A Windows attempt with official DSH `0.2.0-rc.2` added the then-current plugin artifact, then hit a TypeError at `dsh-desktop-host/lib/index.js:337:29`: `ctx.connection` was missing when Desktop read `authenticatedUrl`. The underlying composition cause is unresolved, and the artifact source was not recorded. The v5 and prepublication `0.1.0` compatibility matrices used the official and fork CLIs but did not install or launch the plugin in Desktop. The planned npm alpha has not been published or tested in Desktop. Run this checklist on a supported macOS or Windows release target; Linux is not a supported Desktop release target.

## Record the target

Use a separate empty Harness home for each target row. Never use a home that contains a real ChatGPT grant. The target is the planned alpha release `@f12o/dsh-siwc@0.1.0-alpha.1` with npm dist-tag `alpha`; publication is pending. Its workspace tarball is [`dist/f12o-dsh-siwc-0.1.0-alpha.1.tgz`](../dist/f12o-dsh-siwc-0.1.0-alpha.1.tgz), SHA-256 `3c5f83e28a590c804245d05791b5cbead7fbbcc400649ed861bf775c02524a02`. The preserved v5 tarball belongs to the former package identity and is historical evidence only:

| Field | Value |
|---|---|
| Planned npm package | `@f12o/dsh-siwc@0.1.0-alpha.1`, dist-tag `alpha` (not yet published) |
| Install spec after publication | `@f12o/dsh-siwc@0.1.0-alpha.1` |
| Prior prepublication candidate tarball | `dist/f12o-dsh-siwc-0.1.0.tgz`; historical preparation artifact only |
| Prior candidate SHA-256 | `15c16502dc658f752c5551b116d98dae286f32c69de3cc9e4d54a279ef1c4110` |
| Alpha tarball | Packed; official and fork CLI/SDK/Web smoke passed; Desktop validation pending |
| Historical v5 package | `@f4ah6o/dsh-chatgpt@0.1.0`; ignored, untracked workspace tarball at `dist/f4ah6o-dsh-chatgpt-0.1.0.tgz` |
| Historical v5 SHA-256 | `66ed59d58fe7d241d2cfcfc777939a7a3d7d49710cdce4cbecc9dcee8ffeeb2d` |
| Host | Official DSH `0.2.0-rc.2`, official DSH `0.2.1-alpha.1`, or the fork; record the exact version/commit |
| Desktop version and OS/architecture | Record the installed release and supported target |
| Harness home | Record the fresh test-home path, without account data |
| Result | Pending |

Repeat the procedure for each Host variant being qualified. The existing artifact matrix does not establish Desktop compatibility for any of them.

## Install and launch

1. Fully quit any already-running copy of the installed Desktop application, including one hidden in the Dock or system tray, and confirm its process has exited. Electron's single-instance lock is not scoped by `DSH_HOME`; a running instance can receive the launch request and keep using its existing home.

2. Choose a new absolute directory for `DSH_HOME`. Set it in the shell that will launch both Desktop and its bundled CLI. The current fork resolves `DSH_HOME` before importing macOS login-shell environment values and keeps that resolved path; preservation has not been confirmed for both older official releases, so verify the profile path in step 4. On Windows, set a process-local value in PowerShell for this check. On macOS, resolve the installed application's executable from `CFBundleExecutable` in its `Contents/Info.plist`, then run that full executable path from the shell. On Windows, obtain the installed application's full executable path from its installed-app shortcut, then invoke that path from PowerShell. Do not assume Finder, `open -a`, the Start menu, or a shell startup file will pass a temporary variable to the application.

   macOS example:

   ```sh
   export DSH_HOME="$HOME/dsh-chatgpt-desktop-check/<target>"
   "/Applications/<installed-app>.app/Contents/MacOS/<CFBundleExecutable>" &
   ```

   Windows PowerShell example:

   ```powershell
   $env:DSH_HOME = "$env:LOCALAPPDATA\dsh-chatgpt-desktop-check\<target>"
   & "<full path to the installed application executable>"
   ```

3. On the initial Welcome screen, choose **Add API Key**, leave the key empty, and choose **Set up later** on the key form (Japanese: **APIキーを追加** → **後で設定**). This enters the workspace without a key, OAuth, or model request.

4. Confirm that the new home contains `$DSH_HOME/profiles/desktop/package.json`. On macOS, run `test -f "$DSH_HOME/profiles/desktop/package.json"`; in PowerShell, run `Test-Path (Join-Path $env:DSH_HOME 'profiles\desktop\package.json')`. If the check is false, stop: the launch did not initialize the requested Desktop profile, and the result is not a pass. Fully quit Desktop. Closing its window may only hide the application. Use the application's Quit command (or the Windows tray's Quit command) and wait for the process to exit.

5. After the alpha release is published to npm with the `alpha` dist-tag, in the same terminal and with the same `DSH_HOME`, add the exact prerelease to the initialized Desktop profile using that release's documented bundled CLI path and plugin command. If the profile already has the former package installed, remove it first; the old and renamed packages share provider, Remote, and credential identities and must not coexist:

   ```text
   plugin --profile desktop remove @f4ah6o/dsh-chatgpt
   ```

   Run this only when the former package is present. DSH Desktop supports the `remove <package>` operation through its bundled plugin command; do not use an npm-installed CLI or manually edit the profile manifest.

   macOS:

   ```sh
   DSH_HOME="$HOME/dsh-chatgpt-desktop-check/<target>" \
     "<bundled dsh CLI path documented for this release>" \
     plugin --profile desktop add '@f12o/dsh-siwc@0.1.0-alpha.1'
   ```

   Windows PowerShell:

   ```powershell
   $env:DSH_HOME = "$env:LOCALAPPDATA\dsh-chatgpt-desktop-check\<target>"
   & "<bundled dsh CLI path documented for this release>" `
     plugin --profile desktop add '@f12o/dsh-siwc@0.1.0-alpha.1'
   ```

   The alpha package is not published yet; do not treat this step as validated until that exact release is available and installed. Confirm the bundled CLI location in the documentation for the exact Desktop release; packaging paths may differ by release. Alternatively, use Desktop's Plugin Manager after its profile has been initialized. The current fork's Desktop guide documents `resources/runtime/cli/bin/dsh` (`dsh.cmd` on Windows), but that path has not been confirmed for both official versions in this matrix. Desktop uses its bundled runtime and pnpm for CLI plugin management; no system Node.js, pnpm, or local tarball transfer is required after publication. Do not run `dsh --profile desktop`, `--dump-config`, raw SDK arguments, custom package binaries, or platform-guard bypasses.

6. Relaunch the same installed application from the same shell with the same `DSH_HOME`. Verify that the ChatGPT Settings section is present, Host startup completes, and the fresh account list is empty. Fully quit and relaunch once more to verify the installed plugin remains available after restart.

7. Record the exit state and any sanitized startup diagnostics. Do not include OAuth URLs, account identifiers, email addresses, tokens, or credential-file contents. Keep the isolated Harness home for repeat checks or remove it only after Desktop has fully exited.

## Results

| Host variant | Desktop version | OS/architecture | Install method | Startup, empty-state, restart, and clean-quit result |
|---|---|---|---|---|
| Official DSH `0.2.0-rc.2`, prior artifact attempt | `0.2.0-rc.2` (confirm installed version) | Windows (architecture pending) | Then-current plugin artifact; source not recorded | TypeError after plugin add at `dsh-desktop-host/lib/index.js:337:29`: missing `ctx.connection` while reading `authenticatedUrl`; cause unresolved |
| Official DSH `0.2.0-rc.2`, planned alpha release | `0.2.0-rc.2` (target; confirm installed version) | Windows (architecture pending) | `@f12o/dsh-siwc@0.1.0-alpha.1` after publication | Pending; alpha is not published or tested in Desktop |
| Official DSH `0.2.1-alpha.1` | Pending | Pending | Pending | Pending |
| `f4ah6o/deepseek-harness` fork | Pending | Pending | Pending | Pending |
