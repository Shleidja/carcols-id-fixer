#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const VERSION = '0.1.0';

// Pool ranges:
//   siren / light: vanilla GTA V cap is 0-255. FiveM has not raised this
//                  server-side. Client-side, SirenSetting Limit Adjuster
//                  (SSLA, by cp702) raises the siren ID cap to 65535 with
//                  three reserved values: 0, 255, 65535. Enable via
//                  `sirenLimitAdjuster: true` in config.json or `--ssla`.
//   modkit:        FiveM bumped vanilla 0-1023 to 0-65535 via
//                  citizenfx/fivem ModKitIdRelocation.cpp
//                  (constexpr int NUM_MODKIT_INDICES = 65536).
const POOLS = {
  siren:  { min: 1, max: 254,   label: 'sirenSettings' },
  light:  { min: 1, max: 255,   label: 'lightSettings' },
  modkit: { min: 1, max: 65535, label: 'modKit' },
};
const SSLA_SIREN_MAX = 65534;        // SSLA raises cap, but 65535 is reserved
const SSLA_RESERVED  = new Set([0, 255, 65535]);
const PROTECTED = { siren: new Set([0]), light: new Set([0]), modkit: new Set([0]) };
const TARGET_FILES = new Set(['carcols.meta', 'carvariations.meta']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '.cache']);

const DEFAULTS = {
  pools: { sirens: true, lights: true, modkits: true },
  ignore: [],
  backup: true,
  dryRun: false,
  report: 'pretty',
  sirenLimitAdjuster: false,
};

// Hard-coded — CarcolsPatcher folder lives next to server.cfg, sibling to resources/.
const RESOURCES_REL = '../resources';

const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (isTTY ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const C = { dim: c(2), bold: c(1), red: c(31), green: c(32), yellow: c(33), cyan: c(36), gray: c(90), magenta: c(35) };
const tag    = (t) => `${C.magenta('[')}${C.cyan(t)}${C.magenta(']')}`;
const step   = (t, v) => process.stdout.write(`${tag(t.padEnd(6))} ${v ?? ''}\n`);
const ok     = (m) => process.stdout.write(`${C.green('  ok')}    ${m}\n`);
const warn   = (m) => process.stdout.write(`${C.yellow('  !!')}    ${m}\n`);
const errOut = (m) => process.stderr.write(`${C.red('  xx')}    ${m}\n`);
const header = (m) => process.stdout.write(`\n${C.bold(m)}\n`);

async function loadConfig(dir) {
  const p = path.join(dir, 'config.json');
  let raw;
  try { raw = await fs.readFile(p, 'utf8'); } catch { return { ...DEFAULTS, _path: null }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { throw new Error(`config.json is not valid JSON: ${e.message}`); }
  return {
    pools:  { ...DEFAULTS.pools, ...(parsed.pools || {}) },
    ignore: parsed.ignore ?? DEFAULTS.ignore,
    backup: parsed.backup ?? DEFAULTS.backup,
    dryRun: parsed.dryRun ?? DEFAULTS.dryRun,
    report: parsed.report ?? DEFAULTS.report,
    sirenLimitAdjuster: parsed.sirenLimitAdjuster ?? DEFAULTS.sirenLimitAdjuster,
    _path: p,
  };
}

const pick = (cli, cfg) => (cli === undefined ? cfg : cli);

function mergeOpts(config, cli) {
  return {
    siren:   pick(cli.siren,  config.pools.sirens),
    light:   pick(cli.light,  config.pools.lights),
    modkit:  pick(cli.modkit, config.pools.modkits),
    backup:  pick(cli.backup, config.backup),
    dry:     pick(cli.dry,    config.dryRun),
    json:    cli.json  ?? (config.report === 'json'),
    quiet:   cli.quiet ?? (config.report === 'quiet'),
    maxList: cli.maxList ?? 25,
    ignore:  config.ignore || [],
    ssla:    pick(cli.ssla, config.sirenLimitAdjuster),
  };
}

function effectivePools(opts) {
  const out = {
    siren:  { ...POOLS.siren },
    light:  { ...POOLS.light },
    modkit: { ...POOLS.modkit },
  };
  if (opts.ssla) out.siren.max = SSLA_SIREN_MAX;
  return out;
}

function resolveResourcesDir(configPath) {
  const base = configPath ? path.dirname(configPath) : process.cwd();
  return path.resolve(base, RESOURCES_REL);
}

async function findMetaFiles(root, ignore = []) {
  const out = { carcols: [], carvariations: [] };
  const absRoot = path.resolve(root);
  const skip = ignore.map((s) => (path.isAbsolute(s) ? path.resolve(s) : path.resolve(absRoot, s)));
  await walk(absRoot, out, skip);
  return out;
}

const isSkipped = (full, skip) => skip.some((s) => full === s || full.startsWith(s + path.sep));

async function walk(dir, out, skip) {
  if (isSkipped(dir, skip)) return;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(full, out, skip);
    } else if (e.isFile()) {
      if (isSkipped(full, skip)) continue;
      const lower = e.name.toLowerCase();
      if (!TARGET_FILES.has(lower)) continue;
      (lower === 'carcols.meta' ? out.carcols : out.carvariations).push(full);
    }
  }
}

function extractBlock(text, tag) {
  // Case-sensitive on purpose: carcols.meta uses PascalCase block tags
  // (<Sirens>, <Lights>, <Kits>), but each entry contains lowercase children
  // with the same root word (<sirens>, <lights>). A case-insensitive
  // non-greedy match closes at the first nested lowercase tag, silently
  // truncating the block and losing every later entry.
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m) return null;
  const start = m.index + m[0].indexOf(m[1]);
  return { content: m[1], start, end: start + m[1].length };
}

function topLevelItems(text, blockStart, blockEnd) {
  const items = [];
  const re = /<(\/)?Item\b[^>]*>/g;
  re.lastIndex = blockStart;
  let depth = 0, openStart = -1, openTagEnd = -1, m;
  while ((m = re.exec(text)) && m.index < blockEnd) {
    const isClose = m[1] === '/';
    const selfClose = !isClose && m[0].endsWith('/>');
    if (selfClose) {
      if (depth === 0) items.push({ start: m.index, end: m.index + m[0].length, body: '' });
      continue;
    }
    if (!isClose) {
      if (depth === 0) { openStart = m.index; openTagEnd = m.index + m[0].length; }
      depth++;
    } else {
      depth--;
      if (depth === 0 && openStart !== -1) {
        items.push({ start: openStart, end: m.index + m[0].length, body: text.slice(openTagEnd, m.index) });
        openStart = -1; openTagEnd = -1;
      }
    }
  }
  return items;
}

const readTextTag = (body, tag) => {
  const m = body.match(new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`, 'i'));
  return m ? m[1].trim() : null;
};

function parseCarcols(text, file) {
  const out = { sirens: [], lights: [], kits: [] };
  for (const [tag, key] of [['Sirens', 'sirens'], ['Lights', 'lights'], ['Kits', 'kits']]) {
    const block = extractBlock(text, tag);
    if (!block) continue;
    for (const item of topLevelItems(text, block.start, block.end)) {
      const idM = item.body.match(/<id\s+value\s*=\s*"(-?\d+)"\s*\/?>/i);
      if (!idM) continue;
      const id = parseInt(idM[1], 10);
      const idAbs = text.indexOf(idM[0], item.start);
      const entry = {
        id, file,
        idMatch: { start: idAbs, end: idAbs + idM[0].length },
      };
      if (key === 'kits') {
        const knM = item.body.match(/<kitName>\s*([^<]*?)\s*<\/kitName>/i);
        if (knM) {
          const knAbs = text.indexOf(knM[0], item.start);
          entry.kitName = knM[1].trim();
          entry.kitNameMatch = { start: knAbs, end: knAbs + knM[0].length };
        }
      } else {
        entry.name = readTextTag(item.body, 'name');
      }
      out[key].push(entry);
    }
  }
  return out;
}

function parseCarvariations(text, file) {
  // Modkit refs: <kits><Item>ID_name</Item></kits> — matched by full string.
  const kitRefs = [];
  const kitsRe = /<kits>([\s\S]*?)<\/kits>/gi;
  let km;
  while ((km = kitsRe.exec(text))) {
    const inner = km[1];
    const innerStart = km.index + km[0].indexOf(inner);
    const itemRe = /<Item>\s*(\d+)_([^<\s]+?)\s*<\/Item>/gi;
    let im;
    while ((im = itemRe.exec(inner))) {
      kitRefs.push({
        id: parseInt(im[1], 10),
        kitName: `${im[1]}_${im[2]}`,
        refStart: innerStart + im.index,
        refEnd: innerStart + im.index + im[0].length,
        sourceFile: file,
      });
    }
  }

  // Siren/light refs: <sirenSettings value="N"/> and <lightSettings value="N"/>
  // bind a vehicle to a carcols <Sirens>/<Lights> <id> by NUMBER. These ids
  // repeat across resources, so they're matched per-directory at apply time.
  const numRef = (tag) => {
    const out = [];
    const re = new RegExp(`<${tag}\\s+value\\s*=\\s*"(\\d+)"\\s*/?>`, 'gi');
    let m;
    while ((m = re.exec(text))) {
      out.push({ id: parseInt(m[1], 10), start: m.index, end: m.index + m[0].length, tag, sourceFile: file });
    }
    return out;
  };

  return { kitRefs, sirenRefs: numRef('sirenSettings'), lightRefs: numRef('lightSettings') };
}

const shortPath = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

async function buildIndex(rootDir, ignore = []) {
  const found = await findMetaFiles(rootDir, ignore);
  const carcolsMap = new Map();
  const varMap = new Map();
  const pools = { siren: new Map(), light: new Map(), modkit: new Map() };
  const varRefsByKitName = new Map();          // global: kitName -> refs[]
  const sirenRefsByDir = new Map();            // dir -> (id -> refs[])
  const lightRefsByDir = new Map();            // dir -> (id -> refs[])

  const addDirRef = (map, dir, ref) => {
    let byId = map.get(dir);
    if (!byId) { byId = new Map(); map.set(dir, byId); }
    const list = byId.get(ref.id) || [];
    list.push(ref);
    byId.set(ref.id, list);
  };

  for (const f of found.carcols) {
    const text = await readTextSafe(f); if (text === null) continue;
    const parsed = parseCarcols(text, f);
    carcolsMap.set(f, { text, parsed });
    addEntries(pools.siren,  parsed.sirens, f);
    addEntries(pools.light,  parsed.lights, f);
    addEntries(pools.modkit, parsed.kits,   f);
  }
  for (const f of found.carvariations) {
    const text = await readTextSafe(f); if (text === null) continue;
    const { kitRefs, sirenRefs, lightRefs } = parseCarvariations(text, f);
    varMap.set(f, { text });
    for (const r of kitRefs) {
      const list = varRefsByKitName.get(r.kitName) || [];
      list.push(r);
      varRefsByKitName.set(r.kitName, list);
    }
    const dir = path.dirname(f);
    for (const r of sirenRefs) addDirRef(sirenRefsByDir, dir, r);
    for (const r of lightRefs) addDirRef(lightRefsByDir, dir, r);
  }
  return {
    files: { carcols: carcolsMap, carvariations: varMap },
    pools, varRefsByKitName, sirenRefsByDir, lightRefsByDir,
  };
}

function addEntries(map, entries) {
  for (const e of entries) {
    const list = map.get(e.id) || [];
    list.push(e);
    map.set(e.id, list);
  }
}

async function readTextSafe(p) {
  try { return (await fs.readFile(p)).toString('utf8'); } catch { return null; }
}

function detectConflicts(pools, opts) {
  const result = { siren: [], light: [], modkit: [] };
  for (const key of ['siren', 'light', 'modkit']) {
    if (!opts[key]) continue;
    for (const [id, entries] of pools[key]) {
      if (PROTECTED[key].has(id)) continue;
      if (entries.length > 1) result[key].push({ id, entries });
    }
  }
  return result;
}

// Pick a free id from the TOP of the pool downward. Stock GTA V vehicles
// occupy the dense low range (modkits, sirens, lights all start near 0), and
// the scanner can't see stock ids. Assigning low would land reassigned ids
// straight onto stock-used slots, so we hand out high ids first to stay clear.
function pickFreeId(pool, used) {
  for (let i = pool.max; i >= pool.min; i--) if (!used.has(i)) return i;
  return null;
}

function planReassignments(pools, conflicts, opts) {
  const eff = effectivePools(opts);
  const used = {
    siren:  new Set(pools.siren.keys()),
    light:  new Set(pools.light.keys()),
    modkit: new Set(pools.modkit.keys()),
  };
  // Lock reserved values out of the picker.
  if (opts.ssla) for (const v of SSLA_RESERVED) used.siren.add(v);
  for (const v of PROTECTED.siren)  used.siren.add(v);
  for (const v of PROTECTED.light)  used.light.add(v);
  for (const v of PROTECTED.modkit) used.modkit.add(v);

  const plan       = { siren: [], light: [], modkit: [] };
  const unfixable  = { siren: [], light: [], modkit: [] };

  for (const key of ['siren', 'light', 'modkit']) {
    if (!opts[key]) continue;
    for (const conflict of conflicts[key]) {
      const sorted = [...conflict.entries].sort((a, b) => a.file.localeCompare(b.file));
      for (let i = 1; i < sorted.length; i++) {
        const e = sorted[i];
        const newId = pickFreeId(eff[key], used[key]);
        if (newId === null) {
          unfixable[key].push({ from: e.id, entry: e, kitName: e.kitName });
          continue;
        }
        used[key].add(newId);
        plan[key].push({ from: e.id, to: newId, entry: e, kitName: e.kitName });
      }
    }
  }
  return { plan, unfixable, eff };
}

async function applyPlan({ files, plan, varRefsByKitName, sirenRefsByDir, lightRefsByDir, backup, dryRun }) {
  const editsByFile = new Map();
  const addEdit = (file, start, end, replacement) => {
    const arr = editsByFile.get(file) || [];
    arr.push({ start, end, replacement });
    editsByFile.set(file, arr);
  };
  let refEdits = 0;

  // Rewrite the matching carvariations <sirenSettings>/<lightSettings> value=N,
  // scoped to the same directory as the carcols file being renumbered (these
  // ids repeat across resources, so a global update would corrupt other cars).
  const updateNumRefs = (byDir, dir, fromId, toId, tag) => {
    const byId = byDir.get(dir);
    if (!byId) return;
    for (const r of byId.get(fromId) || []) {
      addEdit(r.sourceFile, r.start, r.end, `<${tag} value="${toId}" />`);
      refEdits++;
    }
  };

  const visit = (group, kind) => {
    for (const change of group) {
      const e = change.entry;
      addEdit(e.file, e.idMatch.start, e.idMatch.end, `<id value="${change.to}" />`);
      const dir = path.dirname(e.file);
      if (kind === 'modkit' && e.kitNameMatch) {
        const stripped = (e.kitName || '').replace(/^\d+_/, '');
        const newKitName = `${change.to}_${stripped}`;
        addEdit(e.file, e.kitNameMatch.start, e.kitNameMatch.end, `<kitName>${newKitName}</kitName>`);
        for (const r of varRefsByKitName.get(e.kitName) || []) {
          addEdit(r.sourceFile, r.refStart, r.refEnd, `<Item>${newKitName}</Item>`);
          refEdits++;
        }
      } else if (kind === 'siren') {
        updateNumRefs(sirenRefsByDir, dir, change.from, change.to, 'sirenSettings');
      } else if (kind === 'light') {
        updateNumRefs(lightRefsByDir, dir, change.from, change.to, 'lightSettings');
      }
    }
  };
  visit(plan.siren, 'siren'); visit(plan.light, 'light'); visit(plan.modkit, 'modkit');

  const writes = [];
  for (const [file, edits] of editsByFile) {
    edits.sort((a, b) => b.start - a.start);
    const meta = files.carcols.get(file) || files.carvariations.get(file);
    if (!meta) continue;
    let text = meta.text;
    for (const ed of edits) text = text.slice(0, ed.start) + ed.replacement + text.slice(ed.end);
    writes.push({ file, text });
  }

  if (dryRun) return { writes, written: 0, refEdits };

  let written = 0;
  for (const w of writes) {
    if (backup) {
      const bak = `${w.file}.bak`;
      try { await fs.access(bak); } catch { await fs.copyFile(w.file, bak); }
    }
    await fs.writeFile(w.file, w.text, 'utf8');
    written++;
  }
  return { writes, written, refEdits };
}

async function revertAll(rootDir) {
  const baks = [];
  await walkBaks(path.resolve(rootDir), baks);
  for (const bak of baks) {
    const target = bak.replace(/\.bak$/, '');
    await fs.copyFile(bak, target);
    await fs.unlink(bak);
  }
  return baks;
}

async function walkBaks(dir, out) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walkBaks(full, out);
    } else if (e.isFile()) {
      const l = e.name.toLowerCase();
      if (l === 'carcols.meta.bak' || l === 'carvariations.meta.bak') out.push(full);
    }
  }
}

const HELP = `carcols-patcher v${VERSION}
  ID overlap patcher for FiveM carcols.meta / carvariations.meta

USAGE
  node .                  patch using config.json (default action)
  node . --revert         roll back from .bak files
  node . scan   [dir]     report only, no writes
  node . list   [dir]     print every meta file the walker found
  node . fix    [dir]     scan + patch + write .bak
  node . revert [dir]     restore originals from .bak

FLAGS
  --sirens  / --no-sirens
  --lights  / --no-lights        toggle a pool
  --modkits / --no-modkits
  --dry                          plan-only, no writes
  --no-backup                    skip .bak (not recommended)
  --json                         emit JSON report
  --quiet                        only ok/warn lines
  --max-list <N>                 trim per-pool tables (default 25)
  -h, --help    -v, --version

  --ssla / --no-ssla             enable SirenSetting Limit Adjuster mode
                                  (raises siren cap from 254 to 65534,
                                  client mod required: gta5-mods.com/scripts
                                  /sirensetting-limit-adjuster)

CONFIG (config.json, optional)
  {
    "pools":   { "sirens": true, "lights": true, "modkits": true },
    "ignore":  [],
    "backup":  true,
    "dryRun":  false,
    "report":  "pretty",
    "sirenLimitAdjuster": false
  }

Place this folder next to server.cfg. \`../resources\` is read automatically.`;

function parseArgs(argv) {
  if (argv[0] === '--revert') argv = ['revert', ...argv.slice(1)];

  const out = { help: false, version: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help':    out.help = true; break;
      case '-v': case '--version': out.version = true; break;
      case '--sirens':    out.siren = true; break;
      case '--no-sirens': out.siren = false; break;
      case '--lights':    out.light = true; break;
      case '--no-lights': out.light = false; break;
      case '--modkits':   out.modkit = true; break;
      case '--no-modkits':out.modkit = false; break;
      case '--dry':       out.dry = true; break;
      case '--backup':    out.backup = true; break;
      case '--no-backup': out.backup = false; break;
      case '--json':      out.json = true; break;
      case '--quiet':     out.quiet = true; break;
      case '--max-list':  out.maxList = parseInt(argv[++i] || '25', 10); break;
      case '--ssla':                  out.ssla = true; break;
      case '--no-ssla':               out.ssla = false; break;
      case '--siren-limit-adjuster':  out.ssla = true; break;
      default:
        if (a.startsWith('--')) { errOut(`unknown flag: ${a}`); process.exit(2); }
        positional.push(a);
    }
  }
  out.cmd  = positional[0];
  out.root = positional[1];
  return out;
}

async function assertDir(p) {
  try { const s = await fs.stat(p); if (!s.isDirectory()) throw 0; }
  catch { errOut(`cannot read directory: ${p}`); process.exit(2); }
}

const collisionBadge = (n, enabled) => {
  if (!enabled) return C.dim('skipped');
  if (n === 0) return C.green('clean');
  return C.red(`${n} overlap${n === 1 ? '' : 's'}`);
};
const poolSizesLine = (p) => [
  `siren ${C.cyan(p.siren.size)}${C.dim('/' + POOLS.siren.max)}`,
  `light ${C.cyan(p.light.size)}${C.dim('/' + POOLS.light.max)}`,
  `modkit ${C.cyan(p.modkit.size)}${C.dim('/' + POOLS.modkit.max)}`,
].join(C.dim(' · '));

function printConflictTable(root, label, list, maxList) {
  if (list.length === 0) return;
  header(`-- ${label} overlaps (${list.length}) --`);
  const rows = list.slice(0, maxList);
  for (const conf of rows) {
    process.stdout.write(`  ${C.red('#' + conf.id)} held by ${conf.entries.length} files\n`);
    for (const e of conf.entries) {
      const note = e.kitName ? C.dim(`  ${e.kitName}`) : (e.name ? C.dim(`  ${e.name}`) : '');
      process.stdout.write(`    ${C.gray('-')} ${shortPath(root, e.file)}${note}\n`);
    }
  }
  if (list.length > rows.length) process.stdout.write(`  ${C.dim(`(${list.length - rows.length} more — raise --max-list to see all)`)}\n`);
}

function printPlan(root, plan, maxList) {
  for (const [k, label] of [['siren', 'sirenSettings'], ['light', 'lightSettings'], ['modkit', 'modKit']]) {
    if (plan[k].length === 0) continue;
    header(`-- ${label} moves (${plan[k].length}) --`);
    const rows = plan[k].slice(0, maxList);
    for (const r of rows) {
      const note = r.kitName ? C.dim(`  ${r.kitName}`) : '';
      process.stdout.write(`  ${C.yellow('#' + r.from)} ${C.dim('→')} ${C.green('#' + r.to)}  ${shortPath(root, r.entry.file)}${note}\n`);
    }
    if (plan[k].length > rows.length) process.stdout.write(`  ${C.dim(`(${plan[k].length - rows.length} more)`)}\n`);
  }
}

const slim = (p, root) => ({
  from: p.from, to: p.to,
  file: shortPath(root, p.entry.file),
  kitName: p.kitName || null, name: p.entry.name || null,
});

const toJson = (root, conflicts, pools) => {
  const mk = (list) => list.map((conf) => ({
    id: conf.id,
    files: conf.entries.map((e) => ({ file: shortPath(root, e.file), kitName: e.kitName || null, name: e.name || null })),
  }));
  return {
    pools: {
      siren:  { used: pools.siren.size,  max: POOLS.siren.max },
      light:  { used: pools.light.size,  max: POOLS.light.max },
      modkit: { used: pools.modkit.size, max: POOLS.modkit.max },
    },
    conflicts: { siren: mk(conflicts.siren), light: mk(conflicts.light), modkit: mk(conflicts.modkit) },
  };
};

async function cmdScan(root, opts, config) {
  await assertDir(root);
  if (!opts.quiet) {
    step('cfg',   config._path ? `read ${C.dim(path.basename(config._path))}` : C.dim('using defaults (no config.json)'));
    step('walk',  C.dim(root));
  }
  const idx = await buildIndex(root, opts.ignore);
  if (!opts.quiet) {
    step('index', `${C.cyan(idx.files.carcols.size)} carcols / ${C.cyan(idx.files.carvariations.size)} carvariations`);
    step('pool',  poolSizesLine(idx.pools));
  }
  const conflicts = detectConflicts(idx.pools, opts);
  const sN = conflicts.siren.length, lN = conflicts.light.length, mN = conflicts.modkit.length;
  if (!opts.quiet) {
    step('siren',  collisionBadge(sN, opts.siren));
    step('light',  collisionBadge(lN, opts.light));
    step('modkit', collisionBadge(mN, opts.modkit));
  }
  if (opts.json) { process.stdout.write(JSON.stringify(toJson(root, conflicts, idx.pools), null, 2) + '\n'); return; }
  if (!opts.quiet) {
    printConflictTable(root, 'sirenSettings', conflicts.siren, opts.maxList);
    printConflictTable(root, 'lightSettings', conflicts.light, opts.maxList);
    printConflictTable(root, 'modKit',         conflicts.modkit, opts.maxList);
  }
  const total = sN + lN + mN;
  if (total === 0) ok('clean — no overlapping ids in scanned pools');
  else warn(`${total} overlap${total === 1 ? '' : 's'} — run \`node . fix\` to patch`);
}

async function cmdFix(root, opts, config) {
  await assertDir(root);
  if (!opts.quiet) {
    step('cfg',   config._path ? `read ${C.dim(path.basename(config._path))}` : C.dim('using defaults (no config.json)'));
    step('walk',  C.dim(root));
  }
  const idx = await buildIndex(root, opts.ignore);
  const conflicts = detectConflicts(idx.pools, opts);
  const sN = conflicts.siren.length, lN = conflicts.light.length, mN = conflicts.modkit.length;
  if (!opts.quiet) {
    step('siren',  collisionBadge(sN, opts.siren));
    step('light',  collisionBadge(lN, opts.light));
    step('modkit', collisionBadge(mN, opts.modkit));
  }
  if (sN + lN + mN === 0) { ok('nothing to patch'); return; }

  const { plan, unfixable, eff } = planReassignments(idx.pools, conflicts, opts);
  const total = plan.siren.length + plan.light.length + plan.modkit.length;
  const unfixTotal = unfixable.siren.length + unfixable.light.length + unfixable.modkit.length;
  if (!opts.quiet) step('plan',  `${C.cyan(total)} id reassignments queued`);
  if (unfixTotal > 0 && !opts.quiet) {
    step('error', `${C.red(unfixTotal)} unfixable · pool exhausted`);
  }

  const result = await applyPlan({
    files: idx.files, plan,
    varRefsByKitName: idx.varRefsByKitName,
    sirenRefsByDir: idx.sirenRefsByDir,
    lightRefsByDir: idx.lightRefsByDir,
    backup: opts.backup, dryRun: opts.dry,
  });

  if (!opts.quiet) {
    step('refs',  `${C.cyan(result.refEdits)} carvariations bindings updated`);
    if (opts.dry) {
      step('dry',   `${C.yellow(result.writes.length)} files would change · ${C.dim('no writes performed')}`);
      printPlan(root, plan, opts.maxList);
    } else {
      step('write', `${C.green(result.written)} files patched` + (opts.backup ? C.dim(' · .bak written') : ''));
    }
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      reassignments: {
        siren:  plan.siren.map((p) => slim(p, root)),
        light:  plan.light.map((p) => slim(p, root)),
        modkit: plan.modkit.map((p) => slim(p, root)),
      },
      filesWritten: result.written, dryRun: !!opts.dry,
      unfixable: {
        siren:  unfixable.siren.map((u) => slim(u, root)),
        light:  unfixable.light.map((u) => slim(u, root)),
        modkit: unfixable.modkit.map((u) => slim(u, root)),
      },
    }, null, 2) + '\n');
    return;
  }
  if (unfixTotal > 0) {
    process.stdout.write('\n');
    errOut(`POOL LIMIT REACHED — ${unfixTotal} overlap${unfixTotal === 1 ? '' : 's'} could not be fixed (see below)`);
    for (const [k, label, max] of [
      ['siren',  'sirenSettings', eff.siren.max],
      ['light',  'lightSettings', eff.light.max],
      ['modkit', 'modKit',        eff.modkit.max],
    ]) {
      const list = unfixable[k];
      if (list.length === 0) continue;
      header(`-- ${label} unfixable (${list.length}) — every id in 1-${max} already claimed --`);
      for (const u of list.slice(0, opts.maxList)) {
        const note = u.kitName ? C.dim(`  ${u.kitName}`) : (u.entry.name ? C.dim(`  ${u.entry.name}`) : '');
        process.stdout.write(`  ${C.red('#' + u.from)}  ${shortPath(root, u.entry.file)}${note}\n`);
      }
      if (list.length > opts.maxList) process.stdout.write(`  ${C.dim(`(${list.length - opts.maxList} more)`)}\n`);
    }
    process.stdout.write('\n');
    if (unfixable.siren.length > 0 && !opts.ssla) {
      process.stdout.write(`${C.bold('Why this happens:')} GTA V vanilla caps unique sirenSettings IDs at 254. Your server already uses every slot, so no new id can be assigned without overflow.\n\n`);
      process.stdout.write(`${C.bold('Options:')}\n`);
      process.stdout.write(`  1. Have every player install ${C.cyan('SirenSetting Limit Adjuster')} client-side, then re-run with ${C.cyan('--ssla')}. Cap rises to 65534.\n`);
      process.stdout.write(`     ${C.dim('https://www.gta5-mods.com/scripts/sirensetting-limit-adjuster')}\n`);
      process.stdout.write(`     ${C.dim('https://www.lcpdfr.com/downloads/dev-resources/fivem/50047-fivem-sirensetting-limit-adjuster/')}\n`);
      process.stdout.write(`  2. Delete duplicate emergency vehicle packs to free slots.\n`);
      process.stdout.write(`  3. Merge sirens across vehicles (share one entry by name).\n\n`);
    } else if (unfixable.siren.length > 0 && opts.ssla) {
      process.stdout.write(`${C.bold('Even with SSLA active, slots 1-65534 are all claimed.')} Audit ${C.cyan('node . list')} and prune unused vehicle packs.\n\n`);
    }
  }
  if (!opts.dry) ok('done — restart vehicle resources to load new ids');
  if (unfixTotal > 0) process.exitCode = 1;
}

async function cmdRevert(root, opts) {
  await assertDir(root);
  const restored = await revertAll(root);
  if (restored.length === 0) { warn('no .bak files — nothing to undo'); return; }
  if (!opts.quiet) step('undo',  `${C.cyan(restored.length)} files restored from .bak`);
  ok('rollback complete');
}

async function cmdList(root, opts) {
  await assertDir(root);
  const idx = await buildIndex(root, opts.ignore);
  const carcols = [...idx.files.carcols.keys()].sort();
  const vars    = [...idx.files.carvariations.keys()].sort();

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      root,
      counts: { carcols: carcols.length, carvariations: vars.length },
      carcols:        carcols.map((f) => shortPath(root, f)),
      carvariations:  vars.map((f)    => shortPath(root, f)),
    }, null, 2) + '\n');
    return;
  }

  if (!opts.quiet) {
    step('walk',  C.dim(root));
    step('found', `${C.cyan(carcols.length)} carcols.meta / ${C.cyan(vars.length)} carvariations.meta`);
  }

  header(`-- carcols.meta (${carcols.length}) --`);
  for (const f of carcols) process.stdout.write(`  ${shortPath(root, f)}\n`);

  header(`-- carvariations.meta (${vars.length}) --`);
  for (const f of vars) process.stdout.write(`  ${shortPath(root, f)}\n`);

  ok(`${carcols.length + vars.length} files scanned in total`);
}

async function main(argv) {
  const cli = parseArgs(argv);
  if (cli.help)    { process.stdout.write(HELP + '\n'); return; }
  if (cli.version) { process.stdout.write(`carcols-patcher ${VERSION}\n`); return; }

  const SUBS = new Set(['scan', 'fix', 'revert', 'list']);
  if (!cli.cmd || !SUBS.has(cli.cmd)) {
    cli.root = cli.cmd;
    cli.cmd = 'fix';
  }

  const config = await loadConfig(process.cwd());
  const opts = mergeOpts(config, cli);
  if (opts.json) opts.quiet = true; // JSON output must be the only thing on stdout
  const root = cli.root || resolveResourcesDir(config._path);

  if (cli.cmd === 'scan')   return cmdScan(root, opts, config);
  if (cli.cmd === 'fix')    return cmdFix(root, opts, config);
  if (cli.cmd === 'revert') return cmdRevert(root, opts, config);
  if (cli.cmd === 'list')   return cmdList(root, opts);
}

main(process.argv.slice(2)).catch((e) => { console.error(e?.stack || e); process.exit(1); });
