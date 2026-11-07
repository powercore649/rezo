// utils/licenseGate.js — Portail de licence + essai gratuit REZO.
//
// Une clé de licence (générée par l'owner via /license, activée via
// /license → Activer une clé) est nécessaire pour accéder aux systèmes phares
// du bot. Une clé = un serveur : activer une clé sur un serveur déjà couvert
// remplace la licence précédente.
//
// ESSAI GRATUIT : en l'absence de licence, le PROPRIÉTAIRE du serveur peut
// démarrer un essai (/license). L'essai donne les mêmes accès qu'une licence
// complète pendant la durée configurée (défaut : 7 jours).
//
// L'essai n'est volontairement pas « un clic pour tous » :
//   • seul le propriétaire du serveur peut le démarrer (pas n'importe quel admin) ;
//   • un seul essai par personne, tous serveurs confondus (fini le farming de
//     serveurs vides pour multiplier les essais) ;
//   • le serveur doit avoir un minimum de membres (défaut 5) et d'ancienneté
//     (défaut 2 jours) — réglable via TRIAL_MIN_MEMBERS / TRIAL_MIN_AGE_DAYS ;
//   • un seul essai par serveur, jamais renouvelable sauf reset owner.
// Les propriétaires du bot (OWNER_IDS) ignorent ces conditions.
//
// checkAccess() accepte licence OU essai actif.
// Un cache mémoire de 60 s évite une requête Mongo par interaction.

const { EmbedBuilder } = require('discord.js');
const License = require('../models/License');
const Trial   = require('../models/Trial');
const { COLORS } = require('./embeds');
const core    = require('./licenseCore');
const masterLicense = require('./masterLicense');

// ── Format de clé ─────────────────────────────────────────────────────────────
// REZO-XXXX-XXXX-XXXX-XXXX, alphabet sans caractères ambigus (I/L/O/0/1).
const KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LEGACY_KEY   = core.KEY_PATTERN;

// Une clé recopiée arrive souvent sans tirets ou avec des espaces : on la
// normalise avant de la valider, plutôt que de refuser une clé correcte.
function normalizeKey(raw) { return core.normalizeKey(raw); }
function isValidKeyFormat(key) { return core.isValidKeyFormat(key); }

// ── Durée d'essai par défaut ──────────────────────────────────────────────────
// Modifiable par l'owner via /license (panel owner).
// Stocké en mémoire (rechargé au démarrage depuis process.env ou défaut).
let TRIAL_DURATION_MS = parseInt(process.env.TRIAL_DURATION_DAYS || '7') * 86_400_000;
let TRIAL_ENABLED     = (process.env.TRIAL_ENABLED || 'true') !== 'false';

function positiveInt(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Garde-fous anti-multiplication d'essais (ignorés pour les owners du bot).
let TRIAL_MIN_MEMBERS  = positiveInt(process.env.TRIAL_MIN_MEMBERS, 5);
let TRIAL_MIN_AGE_DAYS = positiveInt(process.env.TRIAL_MIN_AGE_DAYS, 2);

// ── Commandes verrouillées par la licence / l'essai ──────────────────────────
const LICENSE_REQUIRED_COMMANDS = [
  // ── Réseau de bump ──────────────────────────────────────────────────────────
  'bump',
  'territoires',
  'topserveurs',
  'config',

  // ── Identité visuelle par serveur (licence ACTIVE uniquement) ──────────────
  'branding',

  // ── Anniversaires ───────────────────────────────────────────────────────────
  'anniversaire',
  'anniversaire-config',

  // ── Tickets ─────────────────────────────────────────────────────────────────
  'ticket',

  // ── ModMail ─────────────────────────────────────────────────────────────────
  'modmail',

  // ── Anti-raid avancé ────────────────────────────────────────────────────────
  'antiraid',
  'honeypot',

  // ── Giveaways ───────────────────────────────────────────────────────────────
  'giveaway',

  // ── Onboarding ──────────────────────────────────────────────────────────────
  'onboarding',

  // ── Starter Pack (structure complète du serveur) ─────────────────────────────
  'starterpack',

  // ── Sauvegarde / restauration complète du serveur ───────────────────────────
  'backup',

  // ── Intelligence artificielle (une seule commande depuis la fusion) ──────────
  'imagine',
  'ia',

  // ── Leveling / XP ───────────────────────────────────────────────────────────
  'leveling',
  'xp',
  'rank',

  // ── Économie — VOLONTAIREMENT LIBRE ────────────────────────────────────────
  // Les pièces servent à acheter une licence depuis /balance : un serveur non
  // licencié doit donc pouvoir gagner et dépenser des pièces. Verrouiller
  // l'économie reviendrait à demander une licence pour pouvoir l'acheter.

  // ── Stream alerts ────────────────────────────────────────────────────────────
  'streamalerts',

  // ── YouTube Sub Alert ─────────────────────────────────────────────────────
  'youtube-sub',

  // ── Notifications ────────────────────────────────────────────────────────────
  'notifications',

  // ── Invitations avancées ─────────────────────────────────────────────────────
  'invites-avance',
  'invites-config',

  // ── Starboard ────────────────────────────────────────────────────────────────
  'starboard',

  // ── Partenariats ─────────────────────────────────────────────────────────────
  'partenariat',
  'partenariat-config',

  // ── Authentification personnelle (PIN · 2FA · codes de secours) ─────────────
  'authentificator',

  // ── Récap hebdomadaire d'activité ───────────────────────────────────────────
  'recap',

  // ── Autopilote (score d'efficacité + configuration automatique) ─────────────
  'autopilote',

  // ── Cartographie interactive (tuiles réelles, déplacement aux boutons) ───────
  'carte',

  // ── Anti-VPN (vérification de connexion par portail) ────────────────────────
  'antivpn',
];

// Fonctionnalités qui exigent une LICENCE ACTIVE : l'essai gratuit ne suffit
// pas. Elles restent dans la liste ci-dessus pour le verrouillage général et
// l'affichage dans /license, mais utilisent un message dédié.
const FULL_LICENSE_COMMANDS = ['branding'];

// Les paliers sont la source de vérité (utils/licenseCore) : toute
// fonctionnalité ajoutée là-bas est automatiquement protégée ici.
for (const feature of core.PREMIUM_COMMANDS) {
  if (!LICENSE_REQUIRED_COMMANDS.includes(feature)) LICENSE_REQUIRED_COMMANDS.push(feature);
}

function getOwnerIds() {
  return (process.env.OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}
function isOwner(userId) {
  return getOwnerIds().includes(userId);
}

// ── Génération de clé — REZO-XXXX-XXXX-XXXX-XXXX ─────────────────────────────
function keyBlock(random = Math.random) {
  let out = '';
  for (let i = 0; i < 4; i++) out += KEY_ALPHABET[Math.floor(random() * KEY_ALPHABET.length)];
  return out;
}

function generateKey(random = Math.random) {
  return `REZO-${keyBlock(random)}-${keyBlock(random)}-${keyBlock(random)}-${keyBlock(random)}`;
}

async function createLicense(ownerId, { jours = null, note = '', kind = 'standard', maxGuilds = null, graceDays = null, planId = 'custom' } = {}) {
  // Le système de licence est lui-même protégé par la licence maître : sans
  // jeton signé valide, cette instance n'a pas le droit d'émettre une clé.
  const master = masterLicense.guard();
  if (!master.ok) {
    const err = new Error(master.message);
    err.code = 'master_locked';
    err.reason = master.reason;
    throw err;
  }

  const info = core.kindInfo(kind);
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await License.create({
        key: generateKey(),
        createdBy: ownerId,
        planId: String(planId || 'custom').slice(0, 40),
        kind: info.id,
        maxGuilds: Math.max(1, Math.min(25, Number(maxGuilds) || info.maxGuilds)),
        graceDays: Number.isFinite(graceDays) ? Math.max(0, Math.min(60, graceDays)) : 3,
        expiresAt: jours ? new Date(Date.now() + jours * 86_400_000) : null,
        note,
      });
    } catch (err) {
      if (err?.code === 11000) continue;
      throw err;
    }
  }
  throw new Error('Impossible de générer une clé unique après 10 tentatives.');
}

// ── Boutique de licences (achat avec les pièces du serveur) ──────────────────
// Prix et durée réglables par l'owner via l'environnement. L'économie est
// volontairement libre : les membres gagnent des pièces puis achètent la
// licence depuis /balance, sans argent réel.
let LICENSE_PRICE_COINS = Math.max(1, positiveInt(process.env.LICENSE_PRICE_COINS, 25_000));
let LICENSE_DAYS        = Math.max(1, positiveInt(process.env.LICENSE_DAYS, 30));

function getLicenseShopConfig() {
  return { priceCoins: LICENSE_PRICE_COINS, days: LICENSE_DAYS };
}

function setLicenseShopConfig({ priceCoins, days } = {}) {
  if (Number.isFinite(priceCoins) && priceCoins >= 1) LICENSE_PRICE_COINS = Math.floor(priceCoins);
  if (Number.isFinite(days) && days >= 1)            LICENSE_DAYS = Math.floor(days);
}

// ── Cache licence (60 s TTL) ──────────────────────────────────────────────────
const { createBoundedCache } = require('./boundedCache');
// BORNÉ : une entrée par serveur ; l'expiration est gérée par `checkedAt`.
const licenseCache = createBoundedCache({ max: 20_000, ttl: 0, name: 'license' });
const CACHE_TTL    = 60_000;

/** Licence liée à un serveur (siège unique ou licence réseau). */
async function findLicenseByGuild(guildId) {
  if (!guildId) return null;
  const id = String(guildId);
  return License.findOne({ $or: [{ guildId: id }, { guildIds: id }] });
}

function describe(doc, status) {
  return { status, license: doc, kind: doc?.kind || 'standard', maxGuilds: core.maxSeatsOf(doc), seats: core.seatsOf(doc), daysLeft: core.daysLeft(doc), graceDays: Number(doc?.graceDays) || 0 };
}

/**
 * État complet d'une licence pour un serveur.
 *
 * Lecture PURE : aucun statut n'est marqué en base ici. L'ancien code écrivait
 * `revoked: true` dès qu'une licence expirait, ce qui détruisait la distinction
 * entre « expirée » et « révoquée » et empêchait le renouvellement. Le balayage
 * (sweepExpired) s'occupe des essais et des caches.
 */
async function getLicenseStatus(guildId) {
  if (!guildId) return describe(null, 'none');

  const cached = licenseCache.get(guildId);
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL) return cached.value;

  const found = await findLicenseByGuild(guildId);
  const doc = found ? (typeof found.toObject === 'function' ? found.toObject() : found) : null;

  const value = !doc || !isValidKeyFormat(doc.key)
    ? describe(null, 'none')
    : describe(doc, core.computeStatus(doc));

  licenseCache.set(guildId, { value, checkedAt: Date.now() });
  return value;
}

async function isLicensed(guildId) {
  const { status } = await getLicenseStatus(guildId);
  return status === 'active' || status === 'grace';
}

function isLicenseRequired(commandName) {
  return LICENSE_REQUIRED_COMMANDS.includes(String(commandName || '').toLowerCase());
}

function requiresFullLicense(commandName) {
  return FULL_LICENSE_COMMANDS.includes(String(commandName || '').toLowerCase());
}

/** Verrou spécifique aux fonctionnalités réservées à une licence active. */
function fullLicenseEmbed(commandName) {
  return new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('🔒 Licence active requise')
    .setDescription(
      `La commande \`/${commandName}\` est réservée aux serveurs disposant d’une **licence active**.\n\n`
      + 'Un **essai gratuit** ne suffit pas pour cette fonctionnalité.\n'
      + 'Active une clé avec `/license` → **🔑 Activer une clé**.\n\n'
      + '*Les autres fonctionnalités premium restent accessibles pendant l’essai.*',
    );
}

// ── Cache essai (60 s TTL) ────────────────────────────────────────────────────
const trialCache = createBoundedCache({ max: 20_000, ttl: 0, name: 'trial' });

async function getTrialStatus(guildId) {
  if (!guildId) return { status: 'none', trial: null };

  const cached = trialCache.get(guildId);
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL) return cached.value;

  const doc = await Trial.findOne({ guildId }).lean();
  let value;

  if (!doc) {
    value = { status: 'none', trial: null };
  } else if (doc.expired) {
    value = { status: 'expired', trial: doc };
  } else if (new Date(doc.expiresAt) < new Date()) {
    // Expiration à la volée — marque en base en tâche de fond
    Trial.updateOne({ _id: doc._id }, { expired: true }).catch(() => {});
    value = { status: 'expired', trial: { ...doc, expired: true } };
  } else {
    value = { status: 'active', trial: doc };
  }

  trialCache.set(guildId, { value, checkedAt: Date.now() });
  return value;
}

// Démarre un essai gratuit pour un serveur.
// Retourne { ok, reason, trial } — reason parmi :
//   'started'          → essai créé avec succès
//   'already_active'   → essai déjà en cours
//   'already_used'     → essai déjà utilisé (et expiré) — ne peut pas être redémarré
//   'disabled'         → l'owner a désactivé les essais
//   'has_license'      → le serveur a déjà une licence active
//   'not_owner'        → seul le propriétaire du serveur peut démarrer l'essai
//   'too_small'        → serveur sous le minimum de membres
//   'too_young'        → serveur créé il y a moins de TRIAL_MIN_AGE_DAYS
//   'user_already_used'→ cette personne a déjà consommé un essai sur un autre serveur
async function startTrial(guildId, guildName, startedBy, context = {}) {
  if (!TRIAL_ENABLED) return { ok: false, reason: 'disabled' };
  if (!guildId || !startedBy) return { ok: false, reason: 'invalid' };

  // Déjà une licence active → pas besoin d'essai
  const licStatus = await getLicenseStatus(guildId);
  if (licStatus.status === 'active' || licStatus.status === 'grace') return { ok: false, reason: 'has_license' };

  const existing = await Trial.findOne({ guildId }).lean();

  if (existing) {
    if (!existing.expired && new Date(existing.expiresAt) >= new Date()) {
      return { ok: false, reason: 'already_active', trial: existing };
    }
    // Essai expiré — ne peut pas être redémarré sans reset owner
    return { ok: false, reason: 'already_used', trial: existing };
  }

  const botOwner = isOwner(startedBy);
  if (!botOwner) {
    const { guildOwnerId = null, memberCount = null, guildCreatedAt = null } = context || {};

    // 1. Le propriétaire du serveur, pas n'importe quel administrateur.
    if (!guildOwnerId || startedBy !== guildOwnerId) {
      return { ok: false, reason: 'not_owner' };
    }

    // 2. Un vrai serveur animé, pas une coquille vide créée pour l'occasion.
    if (TRIAL_MIN_MEMBERS > 0 && Number.isFinite(memberCount) && memberCount < TRIAL_MIN_MEMBERS) {
      return { ok: false, reason: 'too_small', minMembers: TRIAL_MIN_MEMBERS, memberCount };
    }

    if (TRIAL_MIN_AGE_DAYS > 0 && guildCreatedAt != null) {
      const createdMs = guildCreatedAt instanceof Date ? guildCreatedAt.getTime() : Number(guildCreatedAt);
      if (Number.isFinite(createdMs)) {
        const opensAt = new Date(createdMs + TRIAL_MIN_AGE_DAYS * 86_400_000);
        if (Date.now() < opensAt.getTime()) {
          return { ok: false, reason: 'too_young', minAgeDays: TRIAL_MIN_AGE_DAYS, opensAt };
        }
      }
    }

    // 3. Un essai par PERSONNE, tous serveurs confondus.
    const usedByUser = await Trial.findOne({ startedBy }).lean();
    if (usedByUser) return { ok: false, reason: 'user_already_used', trial: usedByUser };
  }

  const expiresAt = new Date(Date.now() + TRIAL_DURATION_MS);
  let trial;
  try {
    trial = await Trial.create({ guildId, guildName, startedBy, expiresAt });
  } catch (err) {
    // Deux clics simultanés : l'index unique par serveur tranche.
    if (err?.code === 11000) return { ok: false, reason: 'already_active' };
    throw err;
  }
  invalidateTrial(guildId);
  return { ok: true, reason: 'started', trial };
}

// Réinitialise l'essai d'un serveur (owner uniquement).
// Permet un nouvel essai même après expiration.
async function resetTrial(guildId, resetBy, { note = '' } = {}) {
  const expiresAt = new Date(Date.now() + TRIAL_DURATION_MS);

  // On cherche d'abord le document existant
  const existing = await Trial.findOne({ guildId }).lean();

  let trial;
  if (existing) {
    // Mise à jour d'un essai existant
    trial = await Trial.findOneAndUpdate(
      { guildId },
      {
        expired: false,
        expiresAt,
        resetBy,
        note: note || '',
        $inc: { resetCount: 1 },
      },
      { new: true },
    );
  } else {
    // Création d'un premier essai forcé par l'owner
    trial = await Trial.create({
      guildId,
      guildName: null,
      startedBy: resetBy, // l'owner est le démarreur dans ce cas
      expiresAt,
      resetBy,
      note: note || '',
      resetCount: 1,
    });
  }

  invalidateTrial(guildId);
  return trial;
}

// Révoque l'essai d'un serveur immédiatement (owner uniquement).
async function revokeTrial(guildId) {
  await Trial.updateOne({ guildId }, { expired: true });
  invalidateTrial(guildId);
}

// ── checkAccess — licence OU essai ───────────────────────────────────────────
// → { ok, reason: 'not_required'|'licensed'|'trial'|'no_license'|'expired'|'revoked' }
async function checkAccess(guildId, commandName) {
  const name = String(commandName || '').toLowerCase();
  if (!isLicenseRequired(name)) return { ok: true, reason: 'not_required' };

  // 1. Licence (la période de grâce reste un accès ouvert) — puis le PALIER.
  const { status, license } = await getLicenseStatus(guildId);
  if (status === 'active' || status === 'grace') {
    const kind = license?.kind || 'standard';
    const requiredKind = core.requiredKindFor(name);

    // Les extras d'un pack ouvrent leurs modules même si le palier ne suffit pas.
    if (!core.featureAllowed(kind, name, license?.extras)) {
      return {
        ok: false,
        reason: 'feature_locked',
        requiredKind,
        kind,
        status,
        license,
      };
    }
    return { ok: true, reason: status === 'grace' ? 'grace' : 'licensed', kind };
  }

  // 2. Essai gratuit — socle uniquement, jamais les modules « réseau ».
  if (TRIAL_ENABLED) {
    const { status: tStatus, trial } = await getTrialStatus(guildId);
    if (tStatus === 'active') {
      if (!core.featureAllowed('trial', name)) {
        return {
          ok: false,
          reason: 'feature_locked',
          requiredKind: core.requiredKindFor(name),
          kind: 'trial',
          trial,
        };
      }
      return { ok: true, reason: 'trial', trial, kind: 'trial' };
    }
  }

  // 3. Aucun accès — retourne le reason de la licence (plus précis)
  return { ok: false, reason: status === 'none' ? 'no_license' : status };
}

// ── checkAccess borné — pour les interactions Discord ────────────────────────
// Une base ou un hébergement momentanément lent ne doit JAMAIS dépasser la
// fenêtre de réponse Discord (~3 s) : sinon l'interaction échoue sans message
// (« erreur lors de l'interaction ») et l'utilisateur ne comprend pas pourquoi.
// Renvoie null quand la vérification n'a pas pu aboutir (à charge de l'appelant
// de répondre honnêtement) — jamais d'exception qui casse le routeur.
const ACCESS_TIMEOUT_MS = 2000;

async function checkAccessBounded(guildId, commandName, { timeoutMs = ACCESS_TIMEOUT_MS } = {}) {
  let timer = null;
  try {
    return await Promise.race([
      checkAccess(guildId, commandName),
      new Promise(resolve => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } catch (err) {
    console.error('[licenseGate] vérification impossible :', err.message);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Message affiché quand la vérification n'a pas abouti (aucun droit accordé :
// on reste fermé par défaut, sans faire croire à une licence manquante).
function unavailableEmbed(commandName) {
  return new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('⏳ Vérification impossible')
    .setDescription(
      `La vérification de la licence de \`/${commandName}\` n'a pas abouti `
      + '(base de données ou hébergement momentanément injoignable).\n\n'
      + 'Aucun réglage n\'est perdu : réessaie dans quelques instants.',
    );
}

// ── Embeds standards ─────────────────────────────────────────────────────────

// Embed affiché quand la fonctionnalité appartient à un AUTRE palier :
// l'utilisateur a bien une licence, mais pas celle qui ouvre ce module.
function featureLockEmbed(commandName, { requiredKind = 'network', kind = 'standard' } = {}) {
  const need = core.kindInfo(requiredKind);
  const have = core.kindInfo(kind);

  return new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle(`🔒 Réservé à la licence ${need.label}`)
    .setDescription(
      `La commande \`/${commandName}\` fait partie des fonctionnalités **${need.label}** ${need.emoji}.\n\n`
      + `Ta licence actuelle : ${have.emoji} **${have.label}** — elle n'ouvre pas ce module.\n\n`
      + `🔑 Active une clé **${need.label}** avec \`/license\` → **Activer une clé**, `
      + 'ou demande une mise à niveau à l\'owner du bot.\n\n'
      // Les packs ouvrent réellement des modules hors palier : le dire ici évite
      // de laisser croire qu'il faut forcément changer de palier.
      + '🛍️ Un **pack** peut aussi ouvrir ce module sans changer de palier '
      + '(voir `/license` → **Packs**).\n\n'
      + '*Le reste de ta licence continue de fonctionner normalement.*',
    )
    .setFooter({ text: `REZO • ${have.label} → ${need.label}` });
}

// Embed de verrouillage affiché quand aucun accès (ni licence ni essai)
function lockEmbed(commandName, { trialAvailable = true, access = null } = {}) {
  // Une licence existe mais d'un autre palier : message ciblé, pas « aucune
  // licence ». C'est le cas le plus fréquent après un achat standard.
  if (access?.reason === 'feature_locked') return featureLockEmbed(commandName, access);

  const trialTxt = trialAvailable && TRIAL_ENABLED
    ? '\n\n🧪 **Pas encore de licence ?** Essayez gratuitement pendant **'
      + Math.round(TRIAL_DURATION_MS / 86_400_000)
      + ' jours** avec `/license` → bouton **🧪 Essai gratuit**.'
    : '';

  return new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('🔒 Licence requise')
    .setDescription(
      `La commande \`/${commandName}\` fait partie du **système complet** REZO,\n`
      + 'réservé aux serveurs disposant d\'une clé de licence.\n\n'
      + '🔑 Un administrateur peut l\'activer avec `/license` → **🔑 Activer une clé**\n'
      + '(clé fournie par l\'owner du bot) — voir `/license`.'
      + trialTxt,
    );
}

// Embed de rappel affiché lors d'une commande utilisée en mode essai
function trialReminderEmbed(trial) {
  const expiresTs = Math.floor(new Date(trial.expiresAt).getTime() / 1000);
  const remaining = new Date(trial.expiresAt).getTime() - Date.now();
  const daysLeft  = Math.ceil(remaining / 86_400_000);
  const urgent    = daysLeft <= 1;

  return new EmbedBuilder()
    .setColor(urgent ? COLORS.warning : 0x9B59B6)
    .setTitle(urgent ? '⚠️ Essai gratuit — expire bientôt !' : '🧪 Mode essai gratuit')
    .setDescription(
      `Ce serveur utilise les fonctionnalités premium en **mode essai**.\n`
      + `L'essai expire <t:${expiresTs}:R> (<t:${expiresTs}:f>).\n\n`
      + (urgent
        ? '⚠️ **Il vous reste moins de 24h.** Activez une licence pour ne pas perdre l\'accès !\n'
        : '')
      + '🔑 Pour continuer après l\'essai : `/license` → **🔑 Activer une clé**.',
    )
    .setFooter({ text: 'REZO • Essai gratuit' });
}

/**
 * Garde des panneaux persistants : un bouton ou un menu cliqué APRÈS
 * l'expiration de la licence ne doit pas conserver l'accès. Répond par un
 * message éphémère et renvoie false quand l'accès est refusé.
 *
 * @param {object} interaction  bouton / menu Discord
 * @param {string} commandName  commande propriétaire du panneau
 * @param {{fullOnly?: boolean}} [options] fullOnly = l'essai ne suffit pas
 * @returns {Promise<boolean>}
 */
async function guardComponent(interaction, commandName, { fullOnly = false } = {}) {
  if (!interaction?.guildId) return true;
  if (!isLicenseRequired(commandName)) return true;

  const access = await checkAccessBounded(interaction.guildId, commandName);
  if (!access) {
    await interaction.reply({ embeds: [unavailableEmbed(commandName)], ephemeral: true }).catch(() => {});
    return false;
  }
  if (!access.ok) {
    await interaction.reply({ embeds: [lockEmbed(commandName, { access })], ephemeral: true }).catch(() => {});
    return false;
  }
  if (fullOnly && access.reason === 'trial') {
    await interaction.reply({ embeds: [fullLicenseEmbed(commandName)], ephemeral: true }).catch(() => {});
    return false;
  }
  return true;
}

// ── Activation / gestion ──────────────────────────────────────────────────────

async function activateLicense(rawKey, guildId, guildName, activatedBy) {
  const key = normalizeKey(rawKey);
  if (!isValidKeyFormat(key)) return { ok: false, reason: 'invalid_format' };

  const now = new Date();
  const id  = String(guildId);

  // ── Revendication ATOMIQUE d'un siège ────────────────────────────────────
  // Un seul findOneAndUpdate conditionnel : deux serveurs qui activent la même
  // clé au même instant ne peuvent pas obtenir tous les deux la dernière
  // place. L'ancien code lisait puis écrivait — une vraie course.
  const seatAvailable = {
    $expr: {
      $lt: [
        { $ifNull: ['$seatsUsed', { $cond: [{ $ne: [{ $ifNull: ['$guildId', null] }, null] }, 1, 0] }] },
        { $ifNull: ['$maxGuilds', 1] },
      ],
    },
  };
  const stillUsable = {
    $or: [
      { expiresAt: null },
      { $expr: { $gte: [{ $add: ['$expiresAt', { $multiply: [{ $ifNull: ['$graceDays', 0] }, 86_400_000] }] }, now] } },
    ],
  };

  const claimed = await License.findOneAndUpdate(
    {
      key,
      revoked: false,
      $and: [
        stillUsable,
        { $or: [{ guildIds: id }, { guildId: id }, seatAvailable] },
      ],
    },
    [
      {
        $set: {
          guildIds: { $setUnion: [{ $ifNull: ['$guildIds', []] }, [id]] },
          guildId: id,
          guildName: { $ifNull: [guildName || null, '$guildName'] },
          activatedBy: { $ifNull: [activatedBy || null, '$activatedBy'] },
          activatedAt: { $ifNull: ['$activatedAt', new Date()] },
          lastValidatedAt: new Date(),
        },
      },
      { $set: { seatsUsed: { $size: '$guildIds' } } },
    ],
    { new: true },
  ).catch(() => null);

  if (!claimed) {
    // Refus : on explique à partir de l'état réel, sans jamais deviner.
    const existing = await License.findOne({ key }).lean().catch(() => null);
    if (!existing) return { ok: false, reason: 'not_found' };
    const status = core.computeStatus(existing);
    if (status === 'revoked') return { ok: false, reason: 'revoked', license: existing };
    if (status === 'expired') return { ok: false, reason: 'expired', license: existing };
    if (!core.hasSeat(existing, id) && !core.canAddSeat(existing)) {
      return { ok: false, reason: core.maxSeatsOf(existing) > 1 ? 'full' : 'used_elsewhere', license: existing };
    }
    return { ok: false, reason: 'unavailable', license: existing };
  }

  // Un serveur = une licence : le siège quitte toute autre licence.
  await License.updateMany(
    { _id: { $ne: claimed._id }, $or: [{ guildId: id }, { guildIds: id }] },
    [
      { $set: { guildIds: { $setDifference: [{ $ifNull: ['$guildIds', []] }, [id]] } } },
      {
        $set: {
          seatsUsed: { $size: '$guildIds' },
          guildId: { $arrayElemAt: ['$guildIds', 0] },
          guildName: { $cond: [{ $gt: [{ $size: '$guildIds' }, 0] }, '$guildName', null] },
        },
      },
    ],
  ).catch(() => {});

  invalidate(id);
  return { ok: true, license: claimed, seats: core.seatsOf(claimed) };
}

/**
 * Délivre une licence à un serveur SANS clé à saisir (achat en pièces).
 * - licence active non illimitée → prolonge de `days` jours ;
 * - licence révoquée/expirée → détachée puis nouvelle licence ;
 * - licence illimitée → refus (rien à acheter).
 *
 * @returns {Promise<{ok: true, extended: boolean, license: object}|{ok: false, reason: string, license?: object}>}
 */
async function grantLicense(guildId, guildName, activatedBy, { days = 30, note = '' } = {}) {
  if (!guildId || !activatedBy) return { ok: false, reason: 'invalid' };
  if (!Number.isFinite(days) || days < 1 || days > 3650) return { ok: false, reason: 'duration' };

  const addMs = Math.floor(days) * 86_400_000;
  let existing = await findLicenseByGuild(guildId);

  // Une clé d'un format qui n'est plus reconnu (ex. REZO-PRO-…) ne doit ni
  // débloquer les commandes ni bloquer un achat : on la détache au passage.
  if (existing && !isValidKeyFormat(existing.key)) {
    existing.guildId     = null;
    existing.guildName   = null;
    existing.activatedBy = null;
    existing.activatedAt = null;
    await existing.save();
    existing = null;
  }

  if (existing && !existing.revoked) {
    if (!existing.expiresAt) return { ok: false, reason: 'unlimited', license: existing };

    const base = Math.max(Date.now(), new Date(existing.expiresAt).getTime());
    existing.expiresAt   = new Date(base + addMs);
    existing.activatedAt = existing.activatedAt || new Date();
    existing.activatedBy = existing.activatedBy || activatedBy;
    if (!core.hasSeat(existing, guildId)) {
      existing.guildIds = [...new Set([...core.seatsOf(existing), String(guildId)])];
      existing.seatsUsed = existing.guildIds.length;
    }
    if (note) existing.note = String(note).slice(0, 200);
    await existing.save();
    invalidate(guildId);
    return { ok: true, extended: true, license: existing };
  }

  // Une licence révoquée garde sa trace mais libère ce serveur.
  if (existing?.revoked) {
    existing.guildId = null;
    existing.guildName = null;
    existing.activatedBy = null;
    existing.activatedAt = null;
    await existing.save();
  }

  let license;
  try {
    license = await createLicense(activatedBy, { jours: days, note, planId: 'coins' });
  } catch (err) {
    // Instance sans licence maître : l'achat en pièces ne peut pas émettre.
    if (err?.code === 'master_locked') return { ok: false, reason: 'issuer_locked' };
    throw err;
  }

  license.guildId     = String(guildId);
  license.guildIds    = [String(guildId)];
  license.seatsUsed   = 1;
  license.guildName   = guildName || null;
  license.activatedBy = activatedBy;
  license.activatedAt = new Date();

  try {
    await license.save();
  } catch (err) {
    // Course avec un autre achat : la clé créée ne doit pas rester orpheline.
    await License.deleteOne({ _id: license._id }).catch(() => {});
    if (err?.code === 11000) return { ok: false, reason: 'conflict' };
    throw err;
  }

  invalidate(guildId);
  return { ok: true, extended: false, license };
}

async function revokeLicense(key, revokedBy, reason = '') {
  const license = await License.findOne({ key: String(key).trim().toUpperCase() });
  if (!license) return { ok: false, reason: 'not_found' };
  const seats = core.seatsOf(license);
  const affectedGuild = seats[0] || null;
  license.revoked       = true;
  license.revokedAt     = new Date();
  license.revokedBy     = revokedBy;
  license.revokedReason = reason || 'Révoquée par l\'owner';
  await license.save();
  seats.forEach(invalidate);
  return { ok: true, license, affectedGuild, seats };
}

async function unlinkGuild(guildId) {
  const id = String(guildId);
  const license = await findLicenseByGuild(id);
  if (!license) {
    invalidate(id);
    return { modifiedCount: 0 };
  }

  // On ne retire que CE serveur : une licence réseau garde ses autres sièges.
  const seats = core.seatsOf(license).filter(seat => seat !== id);
  license.guildIds = seats;
  license.seatsUsed = seats.length;
  license.guildId = seats[0] || null;
  license.guildName = null;
  if (!seats.length) {
    license.activatedBy = null;
    license.activatedAt = null;
  }
  await license.save();

  invalidate(id);
  seats.forEach(invalidate);
  return { modifiedCount: 1, seats };
}

async function listLicenses(filter = {}) {
  return License.find(filter).sort({ createdAt: -1 }).limit(100).lean();
}

async function listTrials(filter = {}) {
  return Trial.find(filter).sort({ startedAt: -1 }).limit(100).lean();
}

// ── Renouvellement, transfert, balayage ──────────────────────────────────────

/** Prolonge une clé de `days` jours (owner). Une licence illimitée est refusée. */
async function extendLicense(rawKey, days, extendedBy = null) {
  const key = normalizeKey(rawKey);
  if (!isValidKeyFormat(key)) return { ok: false, reason: 'invalid_format' };
  const count = Number(days);
  if (!Number.isFinite(count) || count < 1 || count > 3650) return { ok: false, reason: 'duration' };

  const license = await License.findOne({ key });
  if (!license) return { ok: false, reason: 'not_found' };
  if (license.revoked) return { ok: false, reason: 'revoked', license };
  if (!license.expiresAt) return { ok: false, reason: 'unlimited', license };

  const base = Math.max(Date.now(), new Date(license.expiresAt).getTime());
  license.expiresAt = new Date(base + Math.floor(count) * 86_400_000);
  license.lastValidatedAt = new Date();
  await license.save();

  core.seatsOf(license).forEach(invalidate);
  return { ok: true, license, days: Math.floor(count), by: extendedBy || null };
}

/** Déplace la licence vers un autre serveur (owner) — les autres sièges sont libérés. */
async function transferLicense(rawKey, toGuildId, toGuildName, transferredBy = null) {
  const key = normalizeKey(rawKey);
  if (!isValidKeyFormat(key)) return { ok: false, reason: 'invalid_format' };
  if (!toGuildId) return { ok: false, reason: 'invalid' };

  const license = await License.findOne({ key });
  if (!license) return { ok: false, reason: 'not_found' };
  if (license.revoked) return { ok: false, reason: 'revoked', license };
  if (core.computeStatus(license) === 'expired') return { ok: false, reason: 'expired', license };

  const previous = core.seatsOf(license);
  const id = String(toGuildId);
  license.guildIds    = [id];
  license.guildId     = id;
  license.seatsUsed   = 1;
  license.guildName   = toGuildName || null;
  license.activatedAt = new Date();
  license.activatedBy = transferredBy || license.activatedBy;
  license.lastValidatedAt = new Date();
  await license.save();

  [...previous, id].forEach(invalidate);
  return { ok: true, license, from: previous };
}

/**
 * Balayage quotidien : invalide les caches des licences dont l'état a changé
 * (grâce terminée, expiration) et marque les essais terminés. Aucune purge :
 * une licence expirée reste consultable, prolongeable et transférable.
 */
async function sweepExpired({ now = new Date() } = {}) {
  const docs = await License.find({ revoked: false, expiresAt: { $ne: null, $lt: now } }).lean().catch(() => []);
  let expired = 0;
  let grace = 0;

  for (const doc of docs) {
    const status = core.computeStatus(doc, now.getTime());
    core.seatsOf(doc).forEach(invalidate);
    if (status === 'expired') expired += 1;
    else if (status === 'grace') grace += 1;
  }

  const trials = await Trial.updateMany(
    { expired: false, expiresAt: { $lt: now } },
    { $set: { expired: true } },
  ).catch(() => null);

  return { licenses: docs.length, expired, grace, trials: trials?.modifiedCount ?? 0 };
}

function invalidate(guildId) {
  if (guildId) licenseCache.delete(guildId);
  // Une licence qui change d'état doit couper immédiatement l'identité
  // personnalisée du serveur (cache séparé). Require paresseux : pas de cycle
  // au chargement des modules.
  try { require('./guildBrand').invalidate(guildId); } catch { /* module facultatif */ }
}
function invalidateTrial(guildId) {
  if (guildId) trialCache.delete(guildId);
}

// Configuration dynamique de l'essai (owner uniquement, en mémoire + env)
function setTrialConfig({ durationDays, enabled, minMembers, minAgeDays }) {
  if (typeof durationDays === 'number' && durationDays > 0) {
    TRIAL_DURATION_MS = durationDays * 86_400_000;
  }
  if (typeof enabled === 'boolean') {
    TRIAL_ENABLED = enabled;
  }
  if (Number.isFinite(minMembers) && minMembers >= 0) {
    TRIAL_MIN_MEMBERS = Math.floor(minMembers);
  }
  if (Number.isFinite(minAgeDays) && minAgeDays >= 0) {
    TRIAL_MIN_AGE_DAYS = Math.floor(minAgeDays);
  }
}

function getTrialConfig() {
  return {
    enabled:      TRIAL_ENABLED,
    durationDays: Math.round(TRIAL_DURATION_MS / 86_400_000),
    minMembers:   TRIAL_MIN_MEMBERS,
    minAgeDays:   TRIAL_MIN_AGE_DAYS,
    ownerOnly:    true,
  };
}

// Amorce le cache au démarrage
async function initCache() {
  const docs = await License.find({ revoked: false }).lean();
  const now  = Date.now();
  let cachedGuilds = 0;
  for (const doc of docs) {
    if (!isValidKeyFormat(doc.key)) continue;
    const status = core.computeStatus(doc, now);
    if (status === 'expired') continue;
    const value = describe(doc, status);
    for (const seat of core.seatsOf(doc)) {
      licenseCache.set(seat, { value, checkedAt: now });
      cachedGuilds += 1;
    }
  }

  const trials = await Trial.find({ expired: false, expiresAt: { $gt: new Date() } }).lean();
  for (const t of trials) {
    trialCache.set(t.guildId, { value: { status: 'active', trial: t }, checkedAt: now });
  }

  console.log(`✅ Licences : ${docs.length} clé(s) · ${cachedGuilds} serveur(s) | Essais : ${trials.length} actif(s)`);
}

module.exports = {
  LICENSE_REQUIRED_COMMANDS,
  FULL_LICENSE_COMMANDS,
  generateKey,
  normalizeKey,
  isValidKeyFormat,
  createLicense,
  getLicenseStatus,
  findLicenseByGuild,
  isLicensed,
  isLicenseRequired,
  requiresFullLicense,
  fullLicenseEmbed,
  featureLockEmbed,
  featureAllowed: core.featureAllowed,
  requiredKindFor: core.requiredKindFor,
  featuresForKind: core.featuresForKind,
  checkAccess,
  checkAccessBounded,
  guardComponent,
  unavailableEmbed,
  lockEmbed,
  trialReminderEmbed,
  activateLicense,
  extendLicense,
  transferLicense,
  sweepExpired,
  grantLicense,
  getLicenseShopConfig,
  setLicenseShopConfig,
  revokeLicense,
  unlinkGuild,
  listLicenses,
  invalidate,
  invalidateTrial,
  initCache,
  getOwnerIds,
  isOwner,
  // Règles de licence (utiles aux panneaux)
  kindInfo: core.kindInfo,
  kindIds: core.kindIds,
  assignableKinds: core.assignableKinds,
  seatsOf: core.seatsOf,
  maxSeatsOf: core.maxSeatsOf,
  computeStatus: core.computeStatus,
  daysLeft: core.daysLeft,
  // Trial
  getTrialStatus,
  startTrial,
  resetTrial,
  revokeTrial,
  listTrials,
  setTrialConfig,
  getTrialConfig,
};
