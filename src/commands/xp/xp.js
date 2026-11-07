// commands/xp.js — Moteur du système de leveling (calcul XP, cartes, level-up)
const { AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { createCanvas } = require('@napi-rs/canvas');
const XP = require('../../models/XP');
const XPConfig = require('../../models/XPConfig');
const configCache = require('../../utils/guildConfigCache');
const { safeLoadImage } = require('../../utils/safeLoadImage');
const { renderLevelUpCard } = require('../../utils/levelUpCard');
const { resolveLevelUpTheme } = require('../../utils/levelUpCardTheme');
const RankCardPref = require('../../models/RankCardPref');
const { COLORS } = require('../../utils/embeds');

// Cooldown en mémoire (évite une requête DB à chaque message pour vérifier le cooldown)
const { createBoundedCache } = require('../../utils/boundedCache');
// BORNÉ : une entrée par membre et par serveur — sans éviction, la mémoire
// grandit avec le nombre d'utilisateurs actifs.
const cooldownMap = createBoundedCache({ max: 50_000, ttl: 0, name: 'xp-cooldown' }); // clé: `${guildId}:${userId}` -> timestamp du dernier gain

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ─── Formule de progression MEE6-style ───────────────────────────────────────
// XP total nécessaire pour passer du niveau `level` au niveau `level + 1`
function xpForNextLevel(level) {
  return 5 * level * level + 50 * level + 100;
}

// Calcule le niveau courant + la progression dans le niveau à partir de l'XP total cumulé
function computeLevel(totalXp) {
  let level = 0;
  let remaining = totalXp;
  while (remaining >= xpForNextLevel(level)) {
    remaining -= xpForNextLevel(level);
    level++;
  }
  return { level, xpIntoLevel: remaining, xpForNext: xpForNextLevel(level) };
}

// La configuration XP est lue à CHAQUE message : elle passe par le cache partagé
// (repli `null` immédiat si la base ne répond pas). Les champs de type `Map` du
// schéma sont reconstruits par le cache, donc `cfg.channelMultipliers.get(...)`
// continue de fonctionner à l'identique.
const readXpConfig = configCache.registerModel(XPConfig, {
  mapPaths: ['channelMultipliers', 'roleMultipliers'],
});

async function getOrCreateConfig(guildId) {
  const cached = await readXpConfig({ guildId });
  if (cached) return cached;
  try {
    return await XPConfig.create({ guildId });
  } catch (err) {
    // Deux messages simultanés dans un serveur tout neuf créaient la config deux
    // fois : le second échouait sur l'index unique. On relit plutôt que d'échouer.
    const existing = await readXpConfig({ guildId });
    if (existing) return existing;
    throw err;
  }
}

async function getOrCreateXp(guildId, userId) {
  let doc = await XP.findOne({ guildId, userId });
  if (doc) return doc;
  try {
    doc = await XP.create({ guildId, userId });
  } catch (err) {
    // Même course que ci-dessus, par membre : deux messages simultanés d'un
    // nouveau membre ne doivent pas perdre d'XP.
    doc = await XP.findOne({ guildId, userId });
    if (!doc) throw err;
  }
  return doc;
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '8B1A1A');
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 139, g: 26, b: 26 };
}

// ─── Ancienne carte de niveau (héritage) ─────────────────────────────────────
// Conservée telle quelle : /rank et l'annonce de level-up utilisent désormais
// utils/rankCard.js (carte personnalisable : fond, couleurs, formes, éléments).
// Layout : avatar + nom + "Level N" en haut, grande barre de progression pleine
// largeur, puis "XP until next level" / "Total XP" sous la barre.
async function generateRankCard(member, xpDoc, rank, accentColor = '#8B1A1A') {
  const W = 934, H = 282;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const { r, g, b } = hexToRgb(accentColor);
  const accent = `rgb(${r},${g},${b})`;

  // Fond dégradé sombre moderne
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0d0e1a');
  bg.addColorStop(0.5, '#151530');
  bg.addColorStop(1, '#1a1030');
  ctx.fillStyle = bg;
  roundRect(ctx, 0, 0, W, H, 24);
  ctx.fill();

  // Bande d'accent en haut
  const top = ctx.createLinearGradient(0, 0, W, 0);
  top.addColorStop(0, accent);
  top.addColorStop(1, `rgba(${r},${g},${b},0.3)`);
  ctx.fillStyle = top;
  roundRect(ctx, 0, 0, W, 6, 3);
  ctx.fill();

  const margin = 56;

  // Avatar circulaire avec anneau d'accent (en haut à gauche)
  const aSize = 130, aX = margin, aY = 46;
  ctx.save();
  ctx.beginPath();
  ctx.arc(aX + aSize / 2, aY + aSize / 2, aSize / 2 + 5, 0, Math.PI * 2);
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(aX + aSize / 2, aY + aSize / 2, aSize / 2, 0, Math.PI * 2);
  ctx.clip();
  const avatar = await safeLoadImage(member.displayAvatarURL({ extension: 'png', size: 256 }));
  if (avatar) ctx.drawImage(avatar, aX, aY, aSize, aSize);
  else { ctx.fillStyle = accent; ctx.fillRect(aX, aY, aSize, aSize); }
  ctx.restore();

  const tX = aX + aSize + 36;

  // Nom d'utilisateur
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 34px Sans';
  ctx.fillText(member.displayName.slice(0, 22), tX, aY + 46);

  // Sous-titre "Level N"
  ctx.fillStyle = accent;
  ctx.font = 'bold 24px Sans';
  ctx.fillText(`Level ${xpDoc.level}`, tX, aY + 84);

  if (rank) {
    ctx.fillStyle = '#B9BBBE';
    ctx.font = '20px Sans';
    ctx.textAlign = 'right';
    ctx.fillText(`Rang #${rank}`, W - margin, aY + 46);
    ctx.textAlign = 'left';
  }

  // Grande barre de progression pleine largeur
  const { xpIntoLevel, xpForNext } = computeLevel(xpDoc.totalXp);
  const ratio = Math.max(0, Math.min(1, xpIntoLevel / xpForNext));
  const barX = margin, barY = 198, barW = W - margin * 2, barH = 30;

  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  roundRect(ctx, barX, barY, barW, barH, 15);
  ctx.fill();

  if (ratio > 0) {
    const fillGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    fillGrad.addColorStop(0, accent);
    fillGrad.addColorStop(1, `rgba(${r},${g},${b},0.6)`);
    ctx.fillStyle = fillGrad;
    roundRect(ctx, barX, barY, Math.max(barH, barW * ratio), barH, 15);
    ctx.fill();
  }

  // Stats sous la barre : "XP until next level" (gauche) / "Total XP" (droite)
  const remaining = Math.max(0, xpForNext - xpIntoLevel);
  ctx.fillStyle = '#B9BBBE';
  ctx.font = '17px Sans';
  ctx.textAlign = 'left';
  ctx.fillText(`XP until next level: ${remaining.toLocaleString()}`, barX, barY + barH + 32);
  ctx.textAlign = 'right';
  ctx.fillText(`Total XP: ${xpDoc.totalXp.toLocaleString()}`, barX + barW, barY + barH + 32);
  ctx.textAlign = 'left';

  ctx.fillStyle = accent;
  ctx.font = 'bold 13px Sans';
  ctx.textAlign = 'right';
  ctx.fillText('REZO', W - 20, H - 14);
  ctx.textAlign = 'left';

  return canvas.toBuffer('image/png');
}

// ─── Traite un message pour le gain d'XP + détection de level-up ─────────────
async function handleMessage(message) {
  if (!message.guild || message.author.bot) return;

  const cfg = await getOrCreateConfig(message.guild.id);
  if (!cfg.enabled) return;
  if (cfg.excludedChannels.includes(message.channel.id)) return;

  const cdKey = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  const last = cooldownMap.get(cdKey) || 0;
  if (now - last < cfg.cooldownSeconds * 1000) return;
  cooldownMap.set(cdKey, now);

  // Multiplicateurs (salon + rôle le plus élevé possédé par le membre)
  let multiplier = cfg.channelMultipliers.get(message.channel.id) || 1;
  if (message.member) {
    for (const [roleId, mult] of cfg.roleMultipliers) {
      if (message.member.roles.cache.has(roleId) && mult > multiplier) multiplier = mult;
    }
  }

  const baseGain = Math.floor(Math.random() * (cfg.maxXp - cfg.minXp + 1)) + cfg.minXp;
  const gain = Math.max(1, Math.round(baseGain * multiplier));

  const doc = await getOrCreateXp(message.guild.id, message.author.id);
  const oldLevel = doc.level;

  doc.totalXp += gain;
  doc.xp = doc.totalXp;
  doc.messages += 1;
  doc.lastMessage = new Date();

  const { level: newLevel } = computeLevel(doc.totalXp);
  doc.level = newLevel;
  await doc.save();

  if (newLevel > oldLevel) {
    await handleLevelUp(message, cfg, doc, oldLevel, newLevel).catch(err => console.error('❌ XP level-up:', err.message));
  }
}

async function handleLevelUp(message, cfg, doc, oldLevel, newLevel) {
  // Attribution des rôles de niveau (cumulatif : tous les paliers atteints sont donnés)
  if (message.member && cfg.levelRoles.length) {
    const toAdd = cfg.levelRoles.filter(lr => lr.level <= newLevel && lr.level > oldLevel).map(lr => lr.roleId);
    for (const roleId of toAdd) {
      if (message.guild.roles.cache.has(roleId) && !message.member.roles.cache.has(roleId)) {
        await message.member.roles.add(roleId).catch(() => {});
      }
    }
  }

  if (!cfg.announceLevelUp) return;
  if (!cfg.levelUpChannelId && cfg.silentChannels.includes(message.channel.id)) return; // salon silencieux (mode "salon du message" uniquement)

  const targetChannel = cfg.levelUpChannelId
    ? message.guild.channels.cache.get(cfg.levelUpChannelId)
    : message.channel;
  if (!targetChannel?.isTextBased()) return;

  if (cfg.useCardOnLevelUp) {
    try {
      const rank = await XP.countDocuments({ guildId: message.guild.id, totalXp: { $gt: doc.totalXp } }) + 1;
      // La carte d'annonce suit le thème du serveur et, si le membre l'a
      // personnalisée, ses propres réglages (comme /rank) ; les réglages
      // propres à l'annonce de niveau (XPConfig.levelUpCard, réglés via
      // /leveling → 📢 Annonce de niveau → 🎉 Carte d'annonce) prennent le pas.
      const pref = await RankCardPref.findOne({ guildId: message.guild.id, userId: message.author.id }).catch(() => null);
      const { xpIntoLevel, xpForNext } = computeLevel(doc.totalXp);
      const card = resolveLevelUpTheme(cfg, pref);
      const buffer = await renderLevelUpCard(
        {
          displayName: message.member.displayName,
          user: { username: message.author.username },
          displayAvatarURL: opts => message.member.displayAvatarURL(opts),
        },
        { level: newLevel, rank, xpIntoLevel, xpForNext, totalXp: doc.totalXp, messages: doc.messages },
        card.theme,
        {
          title: card.title,
          subtitle: card.subtitle,
          vars: { server: message.guild.name },
        },
      );
      const text = cfg.levelUpMessageTemplate
        ? cfg.levelUpMessageTemplate.replace('{user}', `<@${message.author.id}>`).replace('{level}', newLevel)
        : `🎉 <@${message.author.id}> vient de passer **niveau ${newLevel}** !`;
      await targetChannel.send({ content: text, files: [new AttachmentBuilder(buffer, { name: 'levelup.png' })] });
      return;
    } catch (err) {
      console.error('❌ Carte level-up (fallback embed):', err.message);
    }
  }

  const text = cfg.levelUpMessageTemplate
    ? cfg.levelUpMessageTemplate.replace('{user}', `<@${message.author.id}>`).replace('{level}', newLevel)
    : `🎉 <@${message.author.id}> vient de passer **niveau ${newLevel}** !`;
  await targetChannel.send({
    embeds: [new EmbedBuilder().setColor(COLORS.success).setDescription(text)],
  }).catch(() => {});
}

module.exports = {
  handleMessage,
  computeLevel,
  xpForNextLevel,
  generateRankCard,
  getOrCreateConfig,
  getOrCreateXp,
};
