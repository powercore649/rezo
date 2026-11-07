'use strict';
// core/latencyGuard.js — Filet de sécurité contre « L'application ne répond pas ».
//
// Discord exige qu'une interaction soit acquittée sous 3 s. Une commande qui
// interroge la base, dessine une carte ou appelle un service externe dépasse
// facilement ce budget quand le pool Mongo sature (waitQueueTimeout = 10 s) ou
// qu'un cache est froid. Résultat : l'utilisateur voit un échec alors que la
// commande, elle, a bien abouti.
//
// Ce module ajoute un filet unique, branché au seul point d'exécution du
// routeur. Il ne modifie AUCUNE commande :
//   • la commande démarre normalement : si elle répond à temps, rien ne change ;
//   • si elle dépasse le budget, l'interaction est acquittée à sa place, donc le
//     « ne répond pas » ne peut plus arriver ;
//   • son premier `reply()` est alors réécrit en `editReply()`, pour que son
//     message remplace l'accusé de réception au lieu d'être refusé ;
//   • un `showModal()` tardif (impossible après acquittement) devient un message
//     clair invitant à relancer, au lieu d'une exception non rattrapée.
//
// Le filet est inerte dans tous les autres cas : interaction déjà acquittée,
// non acquittable (autocomplétion, modal), ou commande qui répond à temps.

const DEFAULT_BUDGET_MS = 2_300; // marge de 700 ms sous la limite Discord

/** Une interaction peut-elle encore être acquittée par nous ? */
function canAutoAck(interaction) {
  return !!interaction
    && typeof interaction.deferReply === 'function'
    && typeof interaction.editReply === 'function'
    && interaction.deferred !== true
    && interaction.replied !== true;
}

/**
 * Enveloppe `fn` en acquittant l'interaction si elle dépasse `budgetMs`.
 *
 * @param {object} interaction  interaction Discord (ou doublure de test)
 * @param {() => Promise<any>} fn  exécution de la commande
 * @param {{budgetMs?:number, logger?:{warn:Function}, label?:string}} options
 * @returns {Promise<any>} le résultat de `fn`
 */
async function runWithAutoAck(interaction, fn, {
  budgetMs = DEFAULT_BUDGET_MS,
  logger = console,
  label = null,
} = {}) {
  if (!canAutoAck(interaction) || !(budgetMs > 0)) return fn();

  const hasOwnReply = Object.prototype.hasOwnProperty.call(interaction, 'reply');
  const originalReply = interaction.reply;
  const originalShowModal = interaction.showModal;
  const hasOwnModal = Object.prototype.hasOwnProperty.call(interaction, 'showModal');

  let autoAcked = false; // notre accusé de réception a été accepté
  let autoAckFailed = false; // tentative refusée : Discord a déjà acquitté
  let timer = null;

  const restore = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    // On retire la propriété pour rendre la méthode d'origine (prototype).
    if (!hasOwnReply) delete interaction.reply; else interaction.reply = originalReply;
    if (!originalShowModal) return;
    if (!hasOwnModal) delete interaction.showModal; else interaction.showModal = originalShowModal;
  };

  // Remplaçant de `reply()` : après notre accusé de réception, Discord refuse
  // toute nouvelle réponse. On la transforme donc en édition du message
  // d'attente — c'est exactement ce que l'utilisateur attend.
  const replyProxy = function replyProxy(payload, ...rest) {
    if (!autoAcked) return originalReply.call(this, payload, ...rest);
    if (interaction.replied) {
      return typeof interaction.followUp === 'function'
        ? interaction.followUp(payload)
        : Promise.resolve();
    }
    // `ephemeral` n'existe pas sur editReply : on le retire du message.
    const clean = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? { ...payload }
      : payload;
    if (clean && typeof clean === 'object') delete clean.ephemeral;
    return interaction.editReply(clean);
  };

  // Un modal ne peut plus s'ouvrir une fois l'interaction acquittée : au lieu
  // d'une exception, on affiche un message actionnable.
  const modalProxy = function modalProxy(modal, ...rest) {
    if (!autoAcked || typeof originalShowModal !== 'function') {
      return originalShowModal.call(this, modal, ...rest);
    }
    return interaction.editReply({
      content: '⌛ Cette action a mis trop de temps à se préparer. Relance la commande pour ouvrir le formulaire.',
    }).catch(() => {});
  };

  const startTimer = () => {
    timer = setTimeout(async () => {
      if (!canAutoAck(interaction)) return; // la commande a répondu entre-temps
      try {
        await interaction.deferReply();
        autoAcked = true;
        const name = label || interaction.commandName || interaction.customId || 'inconnu';
        if (logger?.warn) {
          logger.warn(`[latence] /${name} a dépassé ${budgetMs} ms — interaction acquittée automatiquement`);
        }
      } catch {
        // Acquittement refusé (déjà acquittée côté Discord) : on rend la main à
        // la commande, qui gérera comme avant.
        autoAckFailed = true;
      }
    }, budgetMs);
    if (typeof timer?.unref === 'function') timer.unref(); // ne retient pas le process
  };

  interaction.reply = replyProxy;
  if (typeof originalShowModal === 'function') interaction.showModal = modalProxy;
  startTimer();

  try {
    return await fn();
  } finally {
    restore();
  }
}

module.exports = { runWithAutoAck, canAutoAck, DEFAULT_BUDGET_MS };
