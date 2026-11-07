'use strict';
// core/registry.js — Découverte et classification des modules du bot.
//
// Le noyau v2 charge trois familles de modules, chacune reconnue par sa forme :
//   • commande — { data, execute }            (v1 historique OU v2)
//   • cron     — { name, schedule, execute }  (nouveau en v2)
//   • événement— { name, execute }            (v1 historique)
//
// La classification est pure et testable hors-ligne : aucun require de Discord.

const fs = require('fs');
const path = require('path');

const { isStubbed, installCanvasStub, isCanvasLoadError } = require('../utils/canvasFallback');

// L'ordre est trié explicitement (et non laissé au système de fichiers) : les
// listeners `guildMemberAdd` s'exécutent dans cet ordre et le bot en dépend
// (antijoin → antiraid → guildMemberAdd). Un tri déterministe garantit le même
// comportement sous Windows, Linux et macOS.
function byName(a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); }

function getJsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).sort(byName).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return getJsFiles(full);
    if (entry.name.endsWith('.js')) return [full];
    return [];
  });
}

function isCommandModule(mod) { return Boolean(mod && mod.data && typeof mod.execute === 'function'); }
function isCronModule(mod)    { return Boolean(mod && typeof mod.schedule === 'string' && typeof mod.execute === 'function'); }
function isEventModule(mod)   { return Boolean(mod && typeof mod.name === 'string' && typeof mod.execute === 'function'); }

// L'ordre compte : un cron possède aussi un `name`, il doit être testé avant un
// événement, sinon il serait classé à tort comme événement.
function moduleKind(mod) {
  if (isCommandModule(mod)) return 'command';
  if (isCronModule(mod)) return 'cron';
  if (isEventModule(mod)) return 'event';
  return null;
}

function isV2(mod) { return Boolean(mod && mod.__v2 === true); }

function categoryOf(file, baseDir, mod) {
  if (mod?.meta?.category) return mod.meta.category;
  const rel = path.relative(baseDir, path.dirname(file));
  return rel === '' ? 'racine' : rel.split(path.sep).join('/');
}

// Charge tous les modules d'un dossier et les classe. Les fichiers qui échouent
// au require n'interrompent jamais le chargement : ils sont listés dans `failed`.
function loadModules(dir, { logger = null } = {}) {
  const commands = [], events = [], crons = [], failed = [];
  for (const file of getJsFiles(dir)) {
    let mod;
    try {
      mod = require(file);
    } catch (err) {
      // Un binaire natif optionnel absent (canvas) ne doit pas faire disparaître
      // une commande entière : on bascule sur un moteur d'images neutre et on
      // recharge le module une seule fois. Tout autre échec reste signalé.
      if (!isStubbed() && isCanvasLoadError(err)) {
        installCanvasStub({ reason: `canvas requis par ${path.basename(file)}` });
        try {
          mod = require(file);
        } catch (retryErr) {
          failed.push({ file, error: retryErr.message.split('\n')[0] });
          logger?.error?.(`échec require ${file} : ${retryErr.message.split('\n')[0]}`);
          continue;
        }
      } else {
        failed.push({ file, error: err.message.split('\n')[0] });
        logger?.error?.(`échec require ${file} : ${err.message.split('\n')[0]}`);
        continue;
      }
    }
    const kind = moduleKind(mod);
    if (!kind) continue; // fichier utilitaire, pas un module
    const entry = { file, mod, kind, category: categoryOf(file, dir, mod), v2: isV2(mod) };
    if (kind === 'command') commands.push(entry);
    else if (kind === 'cron') crons.push(entry);
    else events.push(entry);
  }
  return { commands, events, crons, failed };
}

module.exports = {
  getJsFiles,
  isCommandModule,
  isCronModule,
  isEventModule,
  isV2,
  moduleKind,
  categoryOf,
  loadModules,
};
