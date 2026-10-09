# Installed Desktop verification

This manual check has not been run for the ChatGPT plugin. The v5 tarball was validated with the official CLI and the `f4ah6o/deepseek-harness` CLI, but those runs did not install or launch the plugin in an Electron Desktop application. Run this checklist on a supported macOS or Windows release target; Linux is not a supported Desktop release target.

## Record the target

Use a separate empty Harness home for each target row. Never use a home that contains a real ChatGPT grant. The package is the workspace-only v5 tarball, not an npm release:

| Field | Value |
|---|---|
| Artifact | `dist/f4ah6o-dsh-chatgpt-0.1.0.tgz` |
| SHA-256 | `66ed59d58fe7d241d2cfcfc777939a7a3d7d49710cdce4cbecc9dcee8ffeeb2d` |
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

5. In the same terminal and with the same `DSH_HOME`, add the tarball to the initialized Desktop profile using that release's documented bundled CLI path and plugin command:

   macOS:

   ```sh
   DSH_HOME="$HOME/dsh-chatgpt-desktop-check/<target>" \
     "<bundled dsh CLI path documented for this release>" \
     plugin --profile desktop add "/absolute/path/to/f4ah6o-dsh-chatgpt-0.1.0.tgz"
   ```

   Windows PowerShell:

   ```powershell
   $env:DSH_HOME = "$env:LOCALAPPDATA\dsh-chatgpt-desktop-check\<target>"
   & "<bundled dsh CLI path documented for this release>" `
     plugin --profile desktop add "<absolute path to f4ah6o-dsh-chatgpt-0.1.0.tgz>"
   ```

   Confirm the bundled CLI location in the documentation for the exact Desktop release; packaging paths may differ by release. The current fork's Desktop guide documents `resources/runtime/cli/bin/dsh` (`dsh.cmd` on Windows), but that path has not been confirmed for both official versions in this matrix. Alternatively, add the same tarball through Desktop's Plugin Manager after its profile has been initialized. Desktop uses its bundled runtime and pnpm for CLI plugin management; no system Node.js or pnpm installation is required. Do not run `dsh --profile desktop`, `--dump-config`, raw SDK arguments, custom package binaries, or platform-guard bypasses.

6. Relaunch the same installed application from the same shell with the same `DSH_HOME`. Verify that the ChatGPT Settings section is present, Host startup completes, and the fresh account list is empty. Fully quit and relaunch once more to verify the installed plugin remains available after restart.

7. Record the exit state and any sanitized startup diagnostics. Do not include OAuth URLs, account identifiers, email addresses, tokens, or credential-file contents. Keep the isolated Harness home for repeat checks or remove it only after Desktop has fully exited.

## Results

| Host variant | Desktop version | OS/architecture | Install method | Startup, empty-state, restart, and clean-quit result |
|---|---|---|---|---|
| Official DSH `0.2.0-rc.2` | `0.2.0-rc.2` (target; confirm installed version) | Windows (architecture pending) | Pending | Pending |
| Official DSH `0.2.1-alpha.1` | Pending | Pending | Pending | Pending |
| `f4ah6o/deepseek-harness` fork | Pending | Pending | Pending | Pending |
