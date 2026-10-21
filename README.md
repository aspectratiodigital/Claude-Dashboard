# Blueprint

A 3D command centre for Aspect Ratio Digital. Every site you're building with Claude, pulled live from GitHub and drawn as an isometric city on a drafting sheet: one building per project, one floor per page. Builds, deploys, failures, issues, pull requests and Claude at work all show up on the buildings themselves. Click a building to select it, click again to open it up, and open any site's desktop and mobile previews fullscreen.

It installs as a desktop app on Windows, or runs in your browser.

![Blueprint](docs/screenshots/blueprint.jpg)

## Install the desktop app

You need [Node.js 20 or newer](https://nodejs.org) (22 LTS recommended) and Git, just once, to build the installer. In a terminal:

```powershell
cd D:\Claude-Dashboard
git fetch origin
git checkout claude/project-thread-35jdu8
git pull
npm install
npm run dist
```

That makes `release\ARD Blueprint Setup 0.1.0.exe`. Double-click it, click through the installer, and you get **ARD Blueprint** on your desktop and in the Start menu. Pin it to the taskbar if you like. The app has the data service built in, so nothing else needs to be running.

If PowerShell says `npm.ps1 cannot be loaded because running scripts is disabled`, type `npm.cmd` instead of `npm` (for example `npm.cmd run dist`), or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once and open a new window.

Windows may show "Windows protected your PC" the first time, because the installer isn't code-signed. Click **More info**, then **Run anyway**.

To update later: `git pull`, `npm run dist` again, and run the new installer over the old one. Your settings are kept.

The app keeps its settings, GitHub token and notifications in `%APPDATA%\ARD Blueprint\data`, separate from the `.jarvis` folder the browser version uses, so connect GitHub once inside the app.

## Run it in the browser

For working on the dashboard itself, from `D:\Claude-Dashboard`:

```powershell
cd D:\Claude-Dashboard
git fetch origin
git checkout claude/project-thread-35jdu8
git pull
npm install
npm run dev
```

Then open **http://localhost:5173**. Once this branch is merged you can use `git checkout main` and `git pull` instead.

Starting from scratch:

```bash
git clone https://github.com/aspectratiodigital/Claude-Dashboard.git
cd Claude-Dashboard
npm install
npm run dev
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Dashboard in your browser at http://localhost:5173, with the local data service built in |
| `npm run app` | The same thing in its own desktop window (Electron), with live reload |
| `npm run app:prod` | Builds and opens the desktop app exactly as installed, without making an installer |
| `npm run dist` | Builds the Windows installer into `release/` |
| `npm run build` | Type-checks and builds into `dist/` and `dist-electron/` |

## Connect your projects

The first time it opens you'll see demo projects and a banner. Click **Connect** (or the gear icon) to open Settings.

1. **GitHub.** Either click **Create a read-only GitHub token**, which opens GitHub with the right read-only permissions already ticked, and paste the token in; or, if you use the GitHub CLI, run `gh auth login` once and the dashboard picks it up by itself.
2. **Projects.** Every repo under `aspectratiodigital` shows up. The live URL, preview URL and framework are found from each repo's website field and its deploys. You can override any of them, set a `localhost` port for your dev server, or hide a repo.
3. **PageSpeed (optional).** Paste a free Google PageSpeed Insights key if you want Lighthouse scores. Without one, the dashboard still checks each live site every few minutes for free: whether it's up, how fast it answers, and its basic SEO tags.

Your token and keys are saved in `.jarvis/settings.json` on your computer only. That folder is ignored by Git, and the token is only ever sent to GitHub. To limit which repos appear, list them in `include` (or `exclude`) in [`jarvis.config.json`](jarvis.config.json).

### How it finds your Claude projects

claude.ai doesn't offer an API for Projects yet, so the dashboard can't read your project list from claude.ai directly. Instead it treats each GitHub repo you work in as a project and spots Claude's work on it from:

- branches Claude creates (`claude/...`)
- pull requests that link back to a claude.ai session or project (that link becomes the project's **Claude project** button)
- `Claude-Session:` and `Co-Authored-By: Claude` lines in commits
- Claude Code sessions on this computer, from `~/.claude/projects`. Only the session title, folder, branch and times are read, never the conversation.

So the projects on screen are the real sites you're working on with Claude, and each thread links back to where it lives.

## What's on the plan

One building per site. Its footprint grows with this week's commits and it has one floor per page.

| You see | It means |
| --- | --- |
| Cranes and a scan line | A build is running |
| A green lift | It's deploying |
| A red beacon, the building turns red | A build or deploy failed, or the site is down |
| Flags | Open issues |
| A drone over the roof | Claude is working on it |
| A ring spreading from the building | Something just happened |

Click a building to select it. Click it again (or press `Enter`) to **open it up**: it separates into a cross-section you can click through, with the roof for site speed, the sign for SEO, a floor for each page, the foundation for build quality, and huts for Claude's threads.

![A building opened up](docs/screenshots/blueprint-dissect.jpg)

The other six dashboards (Nexus, Helix, Township, Gallery, Arcade, Reef) were retired. Their code is in this repository's history at commit `f6032d0`, and `git checkout f6032d0` brings them back.

## Claude bar

The **Notes with Claude** panel runs your own Claude Code, signed in with your Claude account, so there's no API key or extra billing. Pick a project in **About**, or click its building, and Claude works in that project's folder on this computer. It finds the folder from where you last used Claude Code on that repo, or from **Folder** if you've set one for that project in Settings. With **All projects** it answers from the live state of every site.

Claude can read files and look at git history freely. Before it edits a file or runs a command, the panel shows what it wants to do with **Allow** and **No** buttons. Each project keeps its conversation until you close the app.

To set it up once, in PowerShell:

```powershell
npm.cmd install -g @anthropic-ai/claude-code
claude.cmd
```

Sign in when asked, then close and reopen the dashboard. The panel's corner reads **Claude Code** when it's connected. If `claude` lives somewhere unusual, add `"claudePath": "C:\\path\\to\\claude.exe"` to the settings file.

## Previews

Open a project and you get a large desktop preview and a phone preview side by side, a page picker, and a switch between the live site and your `localhost` dev server. Click either preview to open it fullscreen at that size, then flip between desktop and mobile, change page, reload or pop it out to your browser.

![Fullscreen mobile preview](docs/screenshots/stage.jpg)

## Notifications

Changes are spotted as the data refreshes (about once a minute) and appear in three places at once: a toast at the top, the bell's history drawer (press `N`), and an effect on that building. The drawer has a **Preview a notification** panel so you can fire any kind on any project and see how it looks.

The kinds: build started, passed or failed; deploying, deployed or deploy failed; new issue; pull request opened, review requested or merged; push; Claude started working; site down or back up; site slower than usual.

## Controls

| Key | Action |
| --- | --- |
| `Ctrl K` | Command palette: jump to any project or preview |
| `N` | Notifications |
| `Esc` | Close the fullscreen preview, then the open project |
| `F` | Frame-rate meter |
| `Enter` | Open up the selected building |
| `Q` `E` | Rotate the plan |
| Drag, scroll | Pan and zoom |

## Laptop friendly

Settings has a **Quality** choice. **Auto** reads your graphics chip once: a dedicated GPU gets **High**, and integrated graphics (most laptops, including the MateBook) get **Balanced**. On battery it drops a level by itself.

- **High:** full resolution, glow and smoothing.
- **Balanced:** resolution capped, glow drawn at reduced size, no blur behind panels (the most expensive effect on integrated graphics), simpler materials.
- **Battery saver:** no glow, lower resolution, the lightest version of every scene.

On every level the scene pauses completely while a fullscreen preview is open, drops to 30 frames a second after 20 seconds without input, and steps resolution down if frames start slipping. Press `F` to see the frame rate.

## How it's built

- **Vite + React 19 + TypeScript.**
- **three.js through React Three Fiber**, with labels are plain DOM positioned from the scene, which keeps them sharp and cheap.
- **A small local service** runs inside the dev server ([`server/`](server)). In the desktop app the same service is bundled into `dist-electron/server.mjs` and served on `127.0.0.1` only ([`server/app.ts`](server/app.ts)). It polls GitHub with ETag caching (so it barely touches your rate limit), reads local Claude Code sessions, checks your live sites, turns changes into notifications, and streams everything to the page.
- **Electron** and **electron-builder** for the desktop app and its Windows installer ([`electron/main.cjs`](electron/main.cjs), `build` in `package.json`).

```
server/                  local data service: GitHub, Claude sessions, site checks, notifications
src/data/                the data contract, live store, and the demo projects
src/shared/              scene canvas and quality tiers, previews, notifications, project panel
src/concepts/blueprint/  the Blueprint scene and panels
electron/                desktop app entry and the server bundle config
build/                   app icon
```
