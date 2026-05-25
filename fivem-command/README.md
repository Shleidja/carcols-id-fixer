# carcols-id-fixer — FiveM server command

Run carcols-id-fixer straight from the live server console. No SSH, no
terminal access. Built for game panels (Pterodactyl, Zap, txAdmin, etc.).

It registers a `carcols` console command that runs the normal engine
(`index.js`) as a child process, so you get the same scan / fix / revert
behaviour without leaving the panel.

## Install

1. Put the whole `carcols-id-fixer` repo into your `resources/` folder. This
   `fivem-command/` subfolder is the resource. (Or copy `index.js` next to
   `server.js` to make this folder fully standalone.)
2. In `server.cfg`:

   ```cfg
   # name must match the resource folder name
   add_unsafe_child_process_permission "carcols-id-fixer"
   ensure carcols-id-fixer
   ```

   `add_unsafe_child_process_permission` is required — it lets the resource
   spawn the Node process that does the work. Without it FiveM blocks the
   child process and nothing runs.

3. Restart the server (or `refresh; ensure carcols-id-fixer`).

If your resource folder is named something other than `carcols-id-fixer`, use
that name in both lines.

## Use

In the server console:

```
carcols scan          # report id overlaps, write nothing
carcols fix           # reassign clashing ids, write .bak backups
carcols fix --ssla    # use the wider siren range (SSLA mod installed)
carcols revert        # restore originals from .bak
```

Output streams back into the console. Restart your vehicle resources after a
`fix`.

Commands run from the server console only. In-game players cannot trigger a
fix, even as admin — file writes stay off the network.

## Requirements

- Node.js on the host. The wrapper tries `node` on PATH first, then falls back
  to the server runtime's own node binary.
- If `node` is somewhere non-standard, point at it:

  ```cfg
  set carcols_node "/usr/bin/node"
  ```

- Resources folder is auto-detected. Override if needed:

  ```cfg
  set carcols_resources "/home/container/resources"
  ```

## How it works

The resource calls `child_process.spawn(node, ['index.js', 'fix', resourcesDir])`.
FiveM sandboxes child processes by default; `add_unsafe_child_process_permission`
is the documented switch that allows it for a named resource. The engine itself
is unchanged — same code as the CLI, same `.bak` backups, same `revert`.

Pairs with the standalone CLI: anything you can do with `node . fix` you can do
here from the panel.
