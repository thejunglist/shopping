# Deployment

How the app gets from a push on GitHub to your Proxmox server, and how to set that up once.

## How it works

```
pull request ──► test job (GitHub-hosted runner) ─────────────► merge blocked unless green
push to main ──► test job ──► bundle ──► deploy job (self-hosted runner in the LXC)
                                              │
                          backup DB ─► unpack ─► npm ci ─► switch symlink ─► restart ─► /healthz
                                                                              │ fails
                                                                              ▼
                                                                  roll back, fail the pipeline
```

- **`test`** runs on GitHub's own virtual machines for every pull request and every push to `main`: lint, server tests, frontend build, dependency audit. On a push it also builds the release bundle.
- **`deploy`** runs only for pushes to `main`, after `test` passes, on a self-hosted runner inside your container. Pull requests never reach it.

### Why the split

A self-hosted runner executes job code directly on your machine and is not reset between jobs. In a public repository anyone can fork it and open a pull request, so if pull requests could reach the runner, a stranger's code would run inside your container, next to your database and on your tailnet. Keeping `test` on GitHub-hosted runners and `deploy` on `main` only means the one way code reaches your server is by being merged.

That makes **who can merge to `main`** the real security boundary. Set up the protections in [GitHub settings](#github-settings) below.

### On the server

```
/opt/shopping/
  current -> releases/<git-sha>      symlink, switched atomically on deploy
  releases/<git-sha>/
    server/                          src, migrations, node_modules
    public/                          built frontend
    VERSION                          reported by /healthz
/var/lib/shopping/shopping.db        the database (survives deploys)
/var/backups/shopping/               gzip'd database backups
```

Two users: **`shopping`** runs the app and owns the data; **`runner`** runs the GitHub runner and writes to `/opt/shopping`. The only things `runner` may do as another user are restart the `shopping` service and run the root-owned backup script (see `deploy/sudoers-shopping-deploy`).

Database migrations run when the service starts. If one fails, `/healthz` never reports the new version and the deploy rolls back. Migrations are forward-only, so rolling back the code does **not** undo schema changes: keep migrations backward compatible, or restore the pre-deploy backup (below).

## One-time setup

### 1. Create the container (Proxmox)

Create a Debian 12 (or Ubuntu LTS) LXC: 1 core, 512 MB to 1 GB RAM, 4 to 8 GB disk. Then, on the **Proxmox host**, add the TUN device so Tailscale works. Edit `/etc/pve/lxc/<id>.conf`:

```
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
```

Restart the container.

### 2. Prepare the container

Inside the container, as root, from a checkout of this repository:

```sh
apt-get update && apt-get install -y git
git clone https://github.com/<you>/<repo>.git /root/shopping-src
sudo bash /root/shopping-src/deploy/setup.sh
```

`setup.sh` installs Node 22 and the SQLite CLI, creates the `shopping` and `runner` users and the directories, installs the backup script, the systemd units (app plus nightly backup timer at about 02:30) and the sudoers rule. It is safe to re-run, and you must re-run it if `deploy/backup.sh`, the unit files or the sudoers file change, because those are installed root-owned on purpose and are not updated by deploys.

The binary for `better-sqlite3` comes prebuilt for Linux on x64 and arm64 (glibc). On any other platform you would need `build-essential` and `python3`, and to drop `--ignore-scripts` from `deploy/deploy.sh`.

### 3. Tailscale

Inside the container:

```sh
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --hostname=shopping
tailscale serve --bg 3000
```

In the Tailscale admin console, enable **MagicDNS** and **HTTPS certificates**. The app is then at `https://shopping.<your-tailnet>.ts.net`.

To let your partner in, either invite them to your tailnet, or share only the `shopping` node with them (admin console → Machines → `shopping` → Share), which avoids giving them access to the rest of your network.

### 4. The GitHub Actions runner

In your repository: **Settings → Actions → Runners → New self-hosted runner**, choose Linux and the right architecture. GitHub shows the exact commands and a registration token. Run them **as the `runner` user** (never root), with the label `shopping`:

```sh
sudo -iu runner
mkdir actions-runner && cd actions-runner
# ...download and extract as shown by GitHub...
./config.sh --url https://github.com/<you>/<repo> --token <TOKEN> --labels shopping
exit
cd /home/runner/actions-runner
sudo ./svc.sh install runner
sudo ./svc.sh start
```

The runner makes outbound connections only; nothing is exposed.

### GitHub settings

All of these matter more because the repository is public.

| Where | Setting |
| --- | --- |
| Settings → Branches (or Rules → Rulesets) | Protect `main`: require a pull request, require the **`test`** status check to pass, block force pushes |
| Settings → Actions → General | "Fork pull request workflows from outside collaborators": **Require approval for all outside collaborators** |
| Settings → Actions → General | Workflow permissions: **Read repository contents** |
| Settings → Actions → Runners | Make sure the runner is registered to this repository only, not a shared group |
| Settings → Environments | Create **`production`**. Optionally add yourself as a required reviewer to approve each deploy |

Also: never use the `pull_request_target` trigger in a workflow here (it can expose secrets to fork pull requests), and keep secrets, real prices and your CSV out of the repository.

### 5. First deploy

Push to `main`. When the pipeline is green, open `https://shopping.<your-tailnet>.ts.net` on your phone. You should see "Server is ok", the release SHA, the schema version and your Tailscale login.

## Everyday operations

```sh
# Logs
journalctl -u shopping -f
journalctl -u 'actions.runner.*' -f

# Which release is live
readlink /opt/shopping/current
curl -s http://127.0.0.1:3000/healthz

# Roll back by hand (as root, or via sudo)
ln -sfn /opt/shopping/releases/<older-sha> /opt/shopping/current
systemctl restart shopping

# Run a backup now
sudo -u shopping /usr/local/bin/shopping-backup manual
ls -lh /var/backups/shopping
```

### Restore a backup

```sh
systemctl stop shopping
sudo -u shopping sh -c 'gunzip -c /var/backups/shopping/<file>.db.gz > /var/lib/shopping/shopping.db'
rm -f /var/lib/shopping/shopping.db-wal /var/lib/shopping/shopping.db-shm
systemctl start shopping
```

### Backups

Two layers, plus one you should add:

1. **App backups:** nightly timer and a copy before every deploy, kept for 30 days in `/var/backups/shopping` (`shopping-backup`, using SQLite's online backup, so it is safe while the app is running).
2. **Container backups:** schedule a Proxmox `vzdump` of the container to another disk or NAS (Datacenter → Backup).
3. **Off-box copy:** sync `/var/backups/shopping` somewhere that is not the Proxmox machine.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Deploy job queued forever | Runner offline, or its label is not `shopping` |
| `sudo: a password is required` in the deploy log | `deploy/setup.sh` has not been run (or not re-run after changing the sudoers file) |
| Health check fails and the log shows a migration error | A new `.sql` file is invalid; the deploy rolled back. Fix it and push again |
| Health check fails, no obvious error | `journalctl -u shopping -n 50`; the failed release is kept in `/opt/shopping/releases/` for inspection |
| Site works over HTTP on the tailnet but not HTTPS | HTTPS certificates not enabled in the Tailscale admin console |
| Page shows "unknown (not via Tailscale)" | You reached the app some other way than `tailscale serve` (for example by curl on localhost) |
