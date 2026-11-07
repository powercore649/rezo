'use strict';
// utils/efficiencyState.js — Collecte l'état réel d'un serveur en UNE passe.
//
// Toutes les requêtes sont lancées en parallèle (Promise.allSettled) : le score
// d'efficacité a besoin d'une quarantaine de documents, mais il coûte une seule
// latence MongoDB au lieu d'une quarantaine. Les résultats sont mis en cache
// 30 secondes par serveur pour que rafraîchir le panel ne relance rien.
//
// Une requête qui échoue ne casse jamais le score : elle vaut simplement
// « module absent » (null) — dégradation contrôlée, jamais d'exception.

const Server            = require('../models/Server');
const { Welcome, Farewell } = require('../models/Welcome');
const { CaptchaConfig } = require('../models/Captcha');
const AutoMod           = require('../models/AutoMod');
const AutoModAdvanced   = require('../models/AutoModAdvanced');
const Honeypot          = require('../models/Honeypot');
const { AntiRaid }      = require('../models/AntiRaid');
const AntiScamConfig    = require('../models/AntiScamConfig');
const WarnThresholds    = require('../models/WarnThresholds');
const ServerProtection  = require('../models/ServerProtection');
const AutoRole          = require('../models/AutoRole');
const OnboardingConfig  = require('../models/OnboardingConfig');
const BirthdayConfig    = require('../models/BirthdayConfig');
const XPConfig          = require('../models/XPConfig');
const Starboard         = require('../models/Starboard');
const CountingGame      = require('../models/CountingGame');
const BoostConfig       = require('../models/BoostConfig');
const ReputationConfig  = require('../models/ReputationConfig');
const GuildLogs         = require('../models/GuildLogs');
const { ModMailConfig } = require('../models/ModMail');
const { TicketConfig }  = require('../models/Ticket');
const Reglement         = require('../models/Reglement');
const { Config: SignalementConfig } = require('../models/Signalement');
const FAQ               = require('../models/FAQ');
const MpRequestConfig   = require('../models/MpRequestConfig');
const PrefixConfig      = require('../models/PrefixConfig');
const VoiceConfig       = require('../models/VoiceConfig');
const { NotificationConfig } = require('../models/Notification');
const AutoMessage       = require('../models/AutoMessage');
const YoutubeSubAlert   = require('../models/YoutubeSubAlert');
const StreamAlert       = require('../models/StreamAlert');
const RedditWatch       = require('../models/RedditWatch');
const WeeklyRecap       = require('../models/WeeklyRecap');
const AutoThread        = require('../models/AutoThread');
const ForumWelcome      = require('../models/ForumWelcome');
const InviteConfig      = require('../models/InviteConfig');
const WatchedBot        = require('../models/WatchedBot');
const ServerBackup      = require('../models/ServerBackup');
const ServerRescue      = require('../models/ServerRescue');
const AiConfig          = require('../models/AiConfig');
const { ShopItem }      = require('../models/Shop');

const STATE_TTL_MS = 30_000;
const { createBoundedCache } = require('./boundedCache');
// BORNÉ : une entrée par serveur ; la fraîcheur est gérée par `at`.
const cache = createBoundedCache({ max: 20_000, ttl: 0, name: 'efficiency' });

// Construit TOUTES les requêtes d'un coup : elles démarrent immédiatement et
// en parallèle dès qu'on touche la Map.
function buildQueries(guildId) {
  const one = Model => Model.findOne({ guildId }).lean();
  return {
    server:        one(Server),
    welcome:       one(Welcome),
    farewell:      one(Farewell),
    captcha:       one(CaptchaConfig),
    automod:       one(AutoMod),
    automodAdvanced: one(AutoModAdvanced),
    honeypot:      one(Honeypot),
    antiRaid:      one(AntiRaid),
    antiScam:      one(AntiScamConfig),
    warnThresholds: one(WarnThresholds),
    protection:    one(ServerProtection),
    autorole:      one(AutoRole),
    onboarding:    one(OnboardingConfig),
    birthday:      one(BirthdayConfig),
    xp:            one(XPConfig),
    starboard:     one(Starboard),
    counting:      one(CountingGame),
    boost:         one(BoostConfig),
    reputation:    one(ReputationConfig),
    logs:          one(GuildLogs),
    modmail:       one(ModMailConfig),
    tickets:       one(TicketConfig),
    reglement:     one(Reglement),
    signalement:   one(SignalementConfig),
    mpRequest:     one(MpRequestConfig),
    prefix:        one(PrefixConfig),
    voice:         one(VoiceConfig),
    notif:         one(NotificationConfig),
    youtube:       one(YoutubeSubAlert),
    stream:        one(StreamAlert),
    reddit:        one(RedditWatch),
    recap:         one(WeeklyRecap),
    autothread:    one(AutoThread),
    forumWelcome:  one(ForumWelcome),
    invites:       one(InviteConfig),
    rescue:        one(ServerRescue),
    ai:            one(AiConfig),
    // Compteurs (existence de contenu configuré)
    faqCount:         FAQ.countDocuments({ guildId }),
    autoMessageCount: AutoMessage.countDocuments({ guildId, active: true }),
    watchedBotCount:  WatchedBot.countDocuments({ guildId }),
    backupCount:      ServerBackup.countDocuments({ guildId }),
    shopCount:        ShopItem.countDocuments({ enabled: true }),
  };
}

// Une passe parallèle, robuste aux pannes partielles.
async function fetchState(guildId) {
  const started = Date.now();
  const entries = Object.entries(buildQueries(guildId));
  const settled = await Promise.allSettled(entries.map(([, p]) => p));

  const state = { guildId, okCount: 0, errorCount: 0 };
  settled.forEach((res, i) => {
    const key = entries[i][0];
    if (res.status === 'fulfilled') {
      state[key] = res.value;
      state.okCount++;
    } else {
      state[key] = null;
      state.errorCount++;
    }
  });
  state.tookMs = Date.now() - started;
  return state;
}

// State mis en cache — `fresh: true` force une nouvelle passe (bouton Actualiser).
async function collectState(guildId, { fresh = false } = {}) {
  if (!guildId) return { guildId: null, tookMs: 0, cached: false, okCount: 0, errorCount: 0 };
  const hit = cache.get(guildId);
  if (!fresh && hit && (Date.now() - hit.at) < STATE_TTL_MS) {
    return { ...hit.state, cached: true };
  }
  const state = await fetchState(guildId);
  cache.set(guildId, { at: Date.now(), state });
  return { ...state, cached: false };
}

function invalidateState(guildId) {
  if (guildId) cache.delete(guildId); else cache.clear();
}

module.exports = { collectState, fetchState, invalidateState, buildQueries, STATE_TTL_MS };
