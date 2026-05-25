# carcols-id-fixer

Finds and fixes siren, light, and modkit ID clashes across every `carcols.meta` and `carvariations.meta` in a FiveM resources folder. One file. No dependencies. MIT.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/node-18%2B-brightgreen)](https://nodejs.org)

***

> **Why this exists**
>
> We built this because we don't think anyone should pay €20 for under 600 lines of code. If you like what we do, you can support us at **[cfx.software](https://cfx.software)** or **[inkwell.dev](https://inkwell.dev)**.

***

## Updates

**May 25 2026 — run it from the server console**

No SSH needed now. There's a FiveM resource in [`fivem-command/`](fivem-command) that lets you run everything from the live server console, so it works on game panels. Drop it in, add two lines to `server.cfg`:

```cfg
add_unsafe_child_process_permission "fivem-command"
ensure fivem-command
```

Then `carcols scan` / `carcols fix` / `carcols revert` straight from the console. Console only, so players can't trigger it in-game. Same engine, same backups, same revert.

***

## The problem

GTA V gives every server three small ID buckets:

| Bucket  | Range  | Lives in                                        |
| ------- | ------ | ----------------------------------------------- |
| sirens  | 1 to 254 (65534 with SSLA) | `carcols.meta` `<Sirens><Item><id>` |
| lights  | 1 to 255  | `carcols.meta` `<Lights><Item><id>`          |
| modkits | 1 to 65535 | `carcols.meta` `<Kits><Item><id>` + `<kitName>` |

Every car pack you add takes a slot in each bucket. When two cars land on the same slot, sirens flash the wrong pattern, lights show the wrong color, and modkits go missing from LSC. The usual fix is opening every `carcols.meta` by hand and renumbering. Every time you add a new pack.

> The modkit ceiling is vanilla `1023` on stock GTA V, but FiveM raised it to `65535` in [`ModKitIdRelocation.cpp`](https://github.com/citizenfx/fivem/blob/master/code/components/gta-streaming-five/src/ModKitIdRelocation.cpp) (`NUM_MODKIT_INDICES = 65536`). This tool targets the FiveM range.

This tool reads every meta file under `resources/`, finds the clashes, and gives the loser a free number. The matching `<Item>N_kitname</Item>` lines in `carvariations.meta` get updated too, so the engine still finds the kit. Originals are saved as `.bak` so you can roll back.

## Install

You need Node.js 18 or newer.

```sh
git clone https://github.com/CFX-Software/carcols-id-fixer.git
```

Drop the `carcols-id-fixer/` folder into your server root. The same folder that holds `server.cfg`. Like this:

```
fxserver/
├── server.cfg
├── resources/
└── carcols-id-fixer/
    ├── index.js
    ├── config.json
    └── package.json
```

The tool reads `../resources` automatically. No path settings to mess with.

## Run

```sh
cd carcols-id-fixer

node .                # find clashes, fix them, save .bak files
node . --revert       # put the originals back

# Look without changing anything
node . scan           # report only
node . fix --dry      # show what would change
node . fix --no-modkits

# Verify coverage — dump every file the walker found
node . list
node . list --json    # machine-readable
```

After a fix, restart your vehicle resources (or the whole server). FiveM only re-reads carcols data when a resource starts.

### Flags

| Flag                                      | What it does                          |
| ----------------------------------------- | ------------------------------------- |
| `--sirens` / `--no-sirens`                | Turn the sirens bucket on or off      |
| `--ssla` / `--no-ssla`                    | Enable [SirenSetting Limit Adjuster](https://www.gta5-mods.com/scripts/sirensetting-limit-adjuster) mode. Raises the siren cap from 254 to 65534. Requires every client to have the SSLA mod ([FiveM build](https://www.lcpdfr.com/downloads/dev-resources/fivem/50047-fivem-sirensetting-limit-adjuster/)) installed. |
| `--lights` / `--no-lights`                | Turn the lights bucket on or off      |
| `--modkits` / `--no-modkits`              | Turn the modkits bucket on or off     |
| `--dry`                                   | Plan only. Don't write anything       |
| `--no-backup`                             | Skip `.bak` files (not recommended)   |
| `--json`                                  | Emit the report as JSON               |
| `--quiet`                                 | Only show ok / warning lines          |
| `--max-list <N>`                          | Trim long tables (default 25)         |
| `-h`, `--help`  /  `-v`, `--version`      | Help / version                        |

Flags always beat `config.json` for that one run.

## config.json

```json
{
  "pools":  { "sirens": true, "lights": true, "modkits": true },
  "ignore": [],
  "backup": true,
  "dryRun": false,
  "report": "pretty",
  "sirenLimitAdjuster": false
}
```

| Field    | Type     | Default    | What it does                                                       |
| -------- | -------- | ---------- | ------------------------------------------------------------------ |
| `pools`  | object   | all `true` | Turn each bucket on or off                                         |
| `ignore` | string[] | `[]`       | Folders to skip. Absolute path, or relative to `../resources`      |
| `backup` | bool     | `true`     | Save a `.bak` before changing anything                             |
| `dryRun` | bool     | `false`    | Plan only. Don't write                                             |
| `report` | string   | `"pretty"` | `"pretty"`, `"json"`, or `"quiet"`                                 |
| `sirenLimitAdjuster` | bool | `false` | Raise siren cap from 254 to 65534. Needs the [SSLA](https://www.gta5-mods.com/scripts/sirensetting-limit-adjuster) client mod installed on every connecting player. |

## Backups

Every changed file gets a sibling `<file>.bak`:

```
resources/[Vehicles]/foo/data/carcols.meta
resources/[Vehicles]/foo/data/carcols.meta.bak    ← original
```

`.bak` is created **once** per file. Running `fix` again never overwrites an existing `.bak`, so the true original is always there. `node . --revert` restores every `*.meta.bak` and removes the `.bak` files. The tool only ever touches `carcols.meta.bak` and `carvariations.meta.bak`. Other `.bak` files left behind by other tools are not touched.

## What the fix does

1. Walks `../resources` and reads every `carcols.meta` and `carvariations.meta`.
2. Builds three ID lists. Anything claimed by more than one file is a clash.
3. For each clash it keeps the lowest path as the winner and gives the loser a free number from the **top** of the range down. Stock GTA vehicles sit in the low range and the scanner can't see them, so picking high keeps reassigned ids clear of stock.
4. It rewrites the carcols entry **and** the binding that points at it:
   * `<id value="N" />` in carcols (all three pools)
   * `<kitName>N_kitname</kitName>` in carcols (modkits)
   * `<Item>N_kitname</Item>` in every `carvariations.meta` that referenced that kit (matched by name, globally)
   * `<sirenSettings value="N" />` and `<lightSettings value="N" />` in the carvariations sitting next to the carcols file (matched by number, scoped to the same folder since these ids repeat across resources)
5. The original is saved as `<file>.bak` (once per file). Running it again on already-fixed files does nothing.

The rewriter splices the raw bytes of the file. Formatting, comments, indents, and line endings stay exactly the same outside the small bits that change.

## Edge cases handled

* Modkit ID `0` is the engine default. Never moved.
* Some packs ship with the kitName number not matching the `<id>` value. The engine matches kit references by the full kitName text, so this tool does the same. Cross-file references stay correct even when the prefix is "wrong" in the source.
* IDs out of range (like `19851985`) still count as a clash, but only valid numbers in range are picked as replacements.
* Symlinks, `node_modules`, and `.git` are skipped.

## What it doesn't do

* It doesn't update `vehicles.meta` `<sirenId>` numbers. Most packs bind sirens to vehicles by `<name>`, which isn't affected. If a pack uses numeric `<sirenId>` references, search for `<sirenId value=` after a fix.
* Files are read as UTF-8 only.

## Why not the alternatives

* [`carcolsfixer.com`](https://carcolsfixer.com/). €20, closed source, license-key gated.
* [`JakeC-06/Carcols-and-Modkit-Fixer`](https://github.com/JakeC-06/Carcols-and-Modkit-Fixer). Free, web-based.
* This tool. Free, MIT, runs locally, single file, no DRM, with backup, revert, and an ignore list.

## Credits

Thanks to [**csyon**](https://forum.cfx.re/u/csyon) for pointing out that FiveM raised the modkit ID ceiling from the vanilla `1023` to `65535`, which let us widen the modkit range and stop leaving slots on the table.

## Run it from the server console (game panels)

No SSH? There's a FiveM resource wrapper in [`fivem-command/`](fivem-command)
that registers a `carcols` console command and runs the engine for you. It
needs one line in `server.cfg`:

```cfg
add_unsafe_child_process_permission "carcols-id-fixer"
ensure carcols-id-fixer
```

Then `carcols scan` / `carcols fix` / `carcols revert` straight from the panel
console. See [`fivem-command/README.md`](fivem-command/README.md).

## License

[MIT](LICENSE). Use it, fork it, ship it.

***

Built by [CFX-Software](https://cfx.software) and [inkwell.dev](https://inkwell.dev).
