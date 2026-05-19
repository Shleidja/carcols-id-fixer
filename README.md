# carcols-id-fixer

Finds and fixes siren, light, and modkit ID clashes across every `carcols.meta` and `carvariations.meta` in a FiveM resources folder. One file. No dependencies. MIT.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/node-18%2B-brightgreen)](https://nodejs.org)

***

> **Why this exists**
>
> We built this because we don't think anyone should pay €20 for under 600 lines of code. If you like what we do, you can support us at **[cfx.software](https://cfx.software)** or **[inkwell.dev](https://inkwell.dev)**.

***

## The problem

GTA V gives every server three small ID buckets:

| Bucket  | Range  | Lives in                                        |
| ------- | ------ | ----------------------------------------------- |
| sirens  | 1 to 255  | `carcols.meta` `<Sirens><Item><id>`          |
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
  "report": "pretty"
}
```

| Field    | Type     | Default    | What it does                                                       |
| -------- | -------- | ---------- | ------------------------------------------------------------------ |
| `pools`  | object   | all `true` | Turn each bucket on or off                                         |
| `ignore` | string[] | `[]`       | Folders to skip. Absolute path, or relative to `../resources`      |
| `backup` | bool     | `true`     | Save a `.bak` before changing anything                             |
| `dryRun` | bool     | `false`    | Plan only. Don't write                                             |
| `report` | string   | `"pretty"` | `"pretty"`, `"json"`, or `"quiet"`                                 |

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
3. For each clash it keeps the lowest path as the winner, picks the smallest free number in range, and rewrites:
   * `<id value="N" />` in carcols
   * `<kitName>N_kitname</kitName>` in carcols (modkits only)
   * `<Item>N_kitname</Item>` in every `carvariations.meta` that pointed at it
4. The original is saved as `<file>.bak` (once per file). Running it again on already-fixed files does nothing.

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

## License

[MIT](LICENSE). Use it, fork it, ship it.

***

Built by [CFX-Software](https://cfx.software) and [inkwell.dev](https://inkwell.dev).
