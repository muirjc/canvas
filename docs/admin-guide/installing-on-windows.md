# Installing Canvas on Windows

Canvas can run on one Windows 10 or 11 PC (64-bit) for one person, with nothing else to set up: no
server, no database to install, no internet connection needed once it's installed. You use it in your
browser, at an address only your own PC can reach. You're its admin, so the rest of this guide applies to
you too, apart from sign-in with Microsoft Entra and GitHub approval, which a Windows install doesn't have.

## Installing

1. Run **CanvasSetup-*version*.exe**. It installs for your Windows account only and doesn't need
   administrator rights.
2. **Windows protected your PC**: the installer isn't signed yet, so Microsoft Defender SmartScreen may
   stop it. Choose **More info**, check the app is **CanvasSetup**, then **Run anyway**.
3. **Your Canvas account**: enter your email address and a temporary password of at least 12 characters
   (not a very common one, and not containing your email address). You choose your real password when you
   first sign in. This page only appears on a first install.
4. Leave **Start Canvas and open it in your browser** ticked and choose **Finish**.

The first start can take up to a minute while Canvas sets up its database (and your antivirus checks the
new files). Later starts take a few seconds.

## Signing in for the first time

Your browser opens Canvas at **http://localhost:3888**. Sign in with the email address and temporary
password from the installer; Canvas then asks you to choose a new password. Two-step verification is
optional on a Windows install: you can turn it on from your account page (**Change password** at the
top of the screen, see [Your account](../user-guide/your-account.md)).

You can bookmark the address. If something else on your PC was already using port 3888, Canvas picks
another port and keeps it, so use **Canvas** in the Start menu rather than the bookmark if the page
doesn't load.

## Starting and stopping

| To | Do this |
|---|---|
| Start Canvas, or open it if it's running | Start menu → **Canvas** |
| Stop Canvas | Start menu → **Stop Canvas** |

Canvas runs in the background with no window of its own; closing the browser tab doesn't stop it. It
doesn't start by itself when you sign in to Windows: use **Canvas** in the Start menu when you want it.

## Where your work is kept

Everything Canvas stores is in one folder, **%LOCALAPPDATA%\Canvas** (paste that into File Explorer's
address bar):

| File | What it is |
|---|---|
| `canvas.db` | Your diagrams, projects, standards and accounts |
| `settings.json` | Canvas's port, the keys that protect sign-in, and optional settings. Keep it private |
| `logs\canvas.log` | What Canvas did, for when something goes wrong |

The program itself is in **%LOCALAPPDATA%\Programs\Canvas** and holds nothing of yours.

## Backing up and restoring

To back up, choose **Stop Canvas**, then copy the whole **%LOCALAPPDATA%\Canvas** folder somewhere
safe (another drive, or cloud storage). Copy the whole folder, not just `canvas.db`: `settings.json` holds
the key your two-step verification is encrypted with.

To restore, choose **Stop Canvas**, delete everything in the folder, copy your backup's files in, then
start Canvas. You can restore onto a new PC the same way, after installing Canvas and starting it once
there: your restored accounts replace the one the installer set up.

You can also export single diagrams at any time (Mermaid, SVG or PNG), as described in
[Sharing and exporting](../user-guide/sharing-and-exporting.md).

## Upgrading

Run the newer **CanvasSetup-*version*.exe**. It stops Canvas if it's running, replaces the program and
keeps your data: there's no account page, and you sign in as before. On its first start the new version
updates the database and adds any new diagram types.

## Uninstalling

Use **Settings → Apps → Installed apps → Canvas → Uninstall** (or **Add or remove programs**). Canvas is
stopped and removed, and you're asked whether to delete your diagrams, accounts and settings too. Say
**No** to keep them, for example if you'll install Canvas again; they stay in **%LOCALAPPDATA%\Canvas**.

## If something goes wrong

- **The browser says the page can't be reached.** Choose **Canvas** in the Start menu. If it still
  doesn't open, look at the end of `logs\canvas.log` in the data folder.
- **You can't sign in** (forgotten password, locked after too many tries, or a lost authenticator).
  Open **Command Prompt** and run:

  ```
  "%LOCALAPPDATA%\Programs\Canvas\python\python.exe" -m canvas_api.desktop reset-admin
  ```

  It asks for your account's email address and a new temporary password. Your account becomes an
  unlocked admin again, two-step verification is turned off (set it up again from your account page),
  and you're signed out everywhere. Sign in with the temporary password and choose a new one.
- **AI chat** is off until you give Canvas an AI provider. Stop Canvas, add it to the `"env"` section of
  `settings.json`, and start Canvas again, for example:

  ```json
  "env": { "AI_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "your key" }
  ```

  (`"openai"` with `OPENAI_API_KEY` works too.) AI chat needs an internet connection; nothing else does.

## Licences

Canvas is open source (Apache License 2.0). The installer includes its own copy of Python and the
libraries Canvas uses; their licences are in **%LOCALAPPDATA%\Programs\Canvas\licenses**:
`THIRD-PARTY-NOTICES.md` (the web app's and the server's packages), `PYTHON-LICENSE.txt` and
`PYTHON-RUNTIME-NOTICES.txt` (Python and the libraries built into it, such as OpenSSL and SQLite).
