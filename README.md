# Interloq

**Two brilliant minds. One flawless plan. Zero wasted afternoons.**

Imagine handing your next project to a dream team. One member is a visionary who drafts the
blueprint; the other is a critic who has never let a weak idea slip past. Interloq brings them
together. Before a single line of work begins, they sit you down, ask exactly the right questions
and capture what you really want. Then the visionary writes the plan, and the critic tests it round
after round until there is nothing left to improve.

Only then does the building start, and every stage is inspected the moment it's done. If anything
goes off course, the plan is refined, reviewed again and put back on track. You're never nagged:
Interloq speaks up only when a decision is truly yours. Watch it all unfold live in your browser,
from any seat in the house, and keep every word of the conversation on record. Less supervising,
more achieving. That's Interloq.

---

## What it does, in plain words

1. **Questions.** Claude Code proposes questions about your task, Codex reviews them, and you answer
   them in an interview.
2. **Plan.** Claude Code writes a plan, and Codex reviews it in rounds until a review raises no
   issue.
3. **Work.** Claude Code carries out the plan.
4. **Check.** After every stretch of work, Codex reviews what was done against the plan and your
   requirements.
5. **Revise.** If the work stops, or a review finds a problem, the plan is revised and reviewed
   again before the work goes on.

Interloq asks you only where a decision is needed, for example when the two agents disagree
repeatedly or a review reaches its round limit.

Behind the brand, the records each run leaves behind go in a directory called `plan-review/` inside
your project; that name is unchanged from before the program was called Interloq.

## What you need

- **Docker** with Docker Compose.
- **A Claude Code login token** in the environment variable `CLAUDE_CODE_OAUTH_TOKEN` on the host.
- **A logged-in Codex** whose credentials live in the external Docker volume
  `iou-notes-codex_codex-config`, which is mounted as `~/.codex` in the container.
- **Node.js 22.18 or later and git** inside the container. The image provides them.
- **Node.js 22.18 or later, npm and git on the host.** `npm ci` refuses an older Node
  (`engine-strict`). The installed copy (see below) is mounted
  read-only into containers, so its `npm ci` and `npm run build` have to run on the host.
- **Network access** for both agents.
- **Read access to GitHub from the host** (`git@github.com:mackler/interloq.git`): the installed copy
  fetches its updates from there (see "Deploying an update").
- **Only if you change the program:** Chromium for the end-to-end tests. In the development
  container, run `npx playwright install chromium` as the user and
  `npx playwright install-deps chromium` as root. `npm test` also needs bats and bashly in the
  container: bashly is in the image; bats is not yet, so a fresh container needs
  `apt-get install -y bats` as root.

## Your two copies

Interloq uses two clones of this repository on the host:

| Copy | Path on the host | Purpose |
|---|---|---|
| Installed copy | `~/work/interloq` | What real runs use. Containers mount it read-only at `/opt/interloq`. |
| Development copy | `~/work/interloq-dev` | Where changes are made. Use `bin/ilcli` to start its container. |

`bin/ilcli` manages the development container (`compose.cc.yaml`). That container mounts the
development copy at `/workspace` and the installed copy at `/opt/interloq`, holds both agents'
credentials, and publishes port 8090 for the web page.

| Command | What it does |
|---|---|
| `bin/ilcli` or `bin/ilcli run [args]` | Starts the container if needed, then starts Claude Code in it |
| `bin/ilcli shell` | Opens a Bash shell in the container |
| `bin/ilcli build` | Builds the image `claude-code-base` from `container/Dockerfile` |
| `bin/ilcli down` | Stops and removes the container (the volumes are kept) |
| `bin/ilcli release` | Pushes `main` to GitHub, where the checks run (see "Deploying an update") |
| `bin/ilcli upgrade` | In the installed copy: brings it to the tested `release` branch, then `npm ci` and `npm run build` |
| `bin/ilcli help [command]` | Shows the usage text, which documents every command |

## First-time setup

1. Clone the repository twice from GitHub: the installed copy on the `release` branch, which only
   tested commits reach, and the development copy on `main`:

   ```sh
   git clone --branch release git@github.com:mackler/interloq.git ~/work/interloq
   git clone git@github.com:mackler/interloq.git ~/work/interloq-dev
   ```

2. On the host, in the installed copy, install the dependencies and build the page, which every run
   needs, since the page is Interloq's only interface:

   ```sh
   cd ~/work/interloq
   bin/ilcli upgrade
   ```

   It runs `npm ci` and `npm run build` (and fetches first; on a fresh clone there is nothing new).

3. In the development copy, install its own dependencies and turn on the type-check hook for
   commits:

   ```sh
   cd ~/work/interloq-dev
   npm ci
   git config core.hooksPath .githooks
   ```

   If you intend to run `npm test`, install Chromium as described in "What you need".
4. Export your Claude Code token, then build the image:

   ```sh
   export CLAUDE_CODE_OAUTH_TOKEN=...
   bin/ilcli build
   ```

5. Make sure that everything under "What you need" is in place, and that the Codex volume holds a
   login.

## Start the web server

1. Open a shell in the container, then start the server:

   ```sh
   bin/ilcli shell
   node /opt/interloq/src/web.ts
   ```

   The server listens on port 8090, which the container publishes to the host. To use another port,
   start the server with the port as its argument (`node /opt/interloq/src/web.ts <port>`). Also
   add a matching `ports` line to `compose.cc.yaml`, run `bin/ilcli down` and start the
   container again so that the line takes effect, and open `http://localhost:<port>/` instead.
2. On the host, open **http://localhost:8090/** in your browser.
3. Fill in the task and the project directory, then press Start. The project directory must be the
   top-level directory of a git repository. A subdirectory is refused.
4. Follow the run in the page, and answer its questions there. Any open tab can answer, and a
   second window shows the same run.
5. **Stop task** ends the current run (exit code 130). The server keeps running and is ready for the
   next task.
6. **Ctrl+C** in the server's terminal ends the server. Every open tab is told that the server is
   ending.

If the server reports that "the page has not been built", run `npm run build` on the host in
`~/work/interloq`, then start the server again.

## Deploying an update (after making a change)

**The installed copy can only ever install a commit whose tests passed.** It follows the branch
`release` on GitHub, and only the checks on GitHub move that branch: after every push to `main` they
run the whole `npm test`, and only if it passes do they fast-forward `release` to that commit. So a
change reaches real runs by this route, and by no other:

1. **Commit in the development copy.** Running `npm test` locally first is still worthwhile; it is
   the same suite that GitHub runs.

   ```sh
   cd ~/work/interloq-dev   # or /workspace inside the development container
   npm test
   git commit ...
   ```

   The pre-commit hook runs `npm run check` and refuses a commit that has a type error.
2. **Publish `main`, on the host, in the development copy.**

   ```sh
   bin/ilcli release
   ```

   It pushes `main` to GitHub. It refuses, and pushes nothing, if the working tree has uncommitted
   changes, if you are not on `main`, or if `main` is behind `origin/main`.
3. **The checks run on GitHub.** Follow them in the repository's Actions tab (workflow `ci`). If
   `npm test` passes, the `release` job moves `release` to your commit; if it fails, `release` stays
   where it was, and the installed copy cannot pick up the change.
4. **Upgrade the installed copy, on the host.**

   ```sh
   cd ~/work/interloq
   bin/ilcli upgrade
   ```

   It fetches `release` from GitHub, fast-forwards to it, and runs `npm ci` and `npm run build` every
   time (the page imports code from `src/`), then prints the commit it landed on. It refuses, and
   changes nothing, if the copy has local modifications, is not on `release`, or has commits that
   `origin/release` does not have. If `npm ci` or the build fails, run it again: it repeats both.
5. **Restart the web server.** It loads its code only at startup. Press Ctrl+C in its terminal, then
   start it again with `node /opt/interloq/src/web.ts`.
6. **Reload every open browser tab.** A tab reconnects by itself, but it keeps running the old page
   until you reload it.

### One-time setup on GitHub

The `release` job pushes with a deploy key, and a ruleset lets only that key update `release`, so
neither you nor anyone else can move it by hand to an untested commit.

1. Generate a key pair, without a passphrase, somewhere temporary:

   ```sh
   ssh-keygen -t ed25519 -N '' -C interloq-release -f release_key
   ```

2. In the repository's Settings → Deploy keys, add `release_key.pub` with **Allow write access**.
3. In Settings → Secrets and variables → Actions, add a repository secret `RELEASE_DEPLOY_KEY`
   holding the contents of `release_key`. Then delete both files.
4. In Settings → Rules → Rulesets, create a branch ruleset targeting `release`: enable
   **Restrict updates**, **Restrict deletions** and **Block force pushes**, and add **Deploy keys** as
   the only bypass.
5. Check it: a hand push to `release` (for example `git push origin main:release`) must be rejected.

The key is a credential: keep it only in the secret, and rotate it (a new key, the secret replaced,
the old deploy key deleted) if it may have leaked.

### Switching the installed copy to `release` (once)

An installed copy set up before this route pulled from the development copy. Point it at GitHub and
at `release` once:

```sh
cd ~/work/interloq
git remote set-url origin git@github.com:mackler/interloq.git
git fetch origin
git switch --track origin/release
bin/ilcli upgrade
```

`git switch` refuses if the copy has local changes; the host needs read access to GitHub.

## Settings

The settings are read in this order, and each one overrides the one before:

1. the built-in defaults;
2. `config.json` in the installed copy (applies to every project);
3. `<project>/plan-review/config.json` (applies to one project).

Useful keys are `claudeModel`, `codexModel` and `ignorePaths`. `ignorePaths` lists files that may
change during a run without being counted as a change to the project, for example
`.devcontainer/claude.json`. If a file holds invalid JSON, a wrong type or an unknown key, Interloq
stops before it calls any agent.

## Where the results go

Everything is recorded in `<project>/plan-review/`:

- `conversation.md`: the whole exchange in readable form, in order;
- `requirements.md`: your agreed requirements;
- `plan.md`: the plan;
- the review rounds, the issue logs and `usage.jsonl` (the cost of each agent call).

When a new run starts, the previous run's records are moved to `plan-review/archive-<time>/`
automatically.

## For developers

How the program works, the rules for changing it, the decided behaviour and the facts established
so far are in [CLAUDE.md](CLAUDE.md). The design history is in [docs/history.md](docs/history.md),
and the reviews are in [docs/](docs/).
