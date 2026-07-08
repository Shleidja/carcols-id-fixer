// carcols-id-fixer — FiveM server command wrapper.
//
// Runs the pure-Node engine (index.js) as a child process so server owners on
// game panels can scan/fix/revert from the live server console with no SSH.
//
// REQUIRES in server.cfg (resource name must match this resource's folder):
//   add_unsafe_child_process_permission "carcols-id-fixer"
//   ensure carcols-id-fixer
//
// USAGE (server console):
//   carcols scan            report id overlaps, no writes
//   carcols fix             reassign clashing ids, write .bak backups
//   carcols fix --ssla      use the wider siren range (SSLA installed)
//   carcols revert          restore originals from .bak

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const RES = GetCurrentResourceName();
const log = (m) => console.log(`[carcols] ${m}`);

// Locate the engine script. Self-contained copy wins; repo layout is the fallback.
function findEngine() {
  const here = GetResourcePath(RES);
  const candidates = [
    path.join(here, 'index.js'),       // index.js copied into the resource
    path.join(here, '..', 'index.js'), // resource is a subfolder of the repo
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

// Walk up from the resource path to the server's resources/ root.
function findResourcesDir() {
  const here = GetResourcePath(RES);
  const parts = here.split(/[\\/]+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].toLowerCase() === 'resources') {
      return parts.slice(0, i + 1).join(path.sep);
    }
  }
  return null;
}

// Prefer the convar override, then `node` on PATH, then this runtime's own node.
function nodeBinary() {
  const override = GetConvar('carcols_node', '');
  if (override && override.length) return override;
  return 'node';
}

function run(args) {
  const engine = findEngine();
  if (!engine) {
    log('^1cannot find index.js. Put this folder inside the carcols-id-fixer repo, or copy index.js next to server.js.^7');
    return;
  }
  const resourcesDir = GetConvar('carcols_resources', '') || findResourcesDir();
  if (!resourcesDir) {
    log('^1cannot locate the resources/ folder. Set: set carcols_resources "/abs/path/to/resources"^7');
    return;
  }

  const cmd = args[0] || 'scan';
  const passthru = args.slice(1).filter((a) => a.startsWith('--'));
  const argv = [engine, cmd, resourcesDir, ...passthru];

  const spawnWith = (bin, onFail) => {
    log(`running: ${path.basename(bin)} ${cmd} ${passthru.join(' ')}`.trim());
    log(`engine: ${engine}`); // full path — a stale index.js copied into the resource shadows the repo one
    let child;
    try {
      child = cp.spawn(bin, argv, { env: { ...process.env, NO_COLOR: '1' } });
    } catch (e) { return onFail && onFail(e); }
    child.on('error', (e) => { if (e && e.code === 'ENOENT' && onFail) onFail(e); else log(`^1spawn error: ${e.message}^7`); });
    child.stdout.on('data', (d) => process.stdout.write(d.toString()));
    child.stderr.on('data', (d) => process.stdout.write(`^3${d.toString()}^7`));
    child.on('exit', (code) => log(code === 0 ? '^2done^7' : `^1exited with code ${code}^7`));
  };

  // Try node on PATH; if missing, fall back to this runtime's node binary.
  spawnWith(nodeBinary(), () => {
    log('node not on PATH — falling back to the server runtime node');
    spawnWith(process.execPath);
  });
}

RegisterCommand('carcols', (source, args) => {
  // Console only (source 0). In-game players cannot trigger file writes.
  if (source !== 0) return;
  if (!args.length) { log('usage: carcols <scan|fix|revert> [--ssla] [--no-modkits] ...'); return; }
  run(args);
}, true);

on('onResourceStart', (name) => {
  if (name !== RES) return;
  log('ready. console commands: carcols scan | carcols fix | carcols revert');
  log('reminder: server.cfg needs  add_unsafe_child_process_permission "' + RES + '"');
});
