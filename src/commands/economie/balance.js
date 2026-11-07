// commands/economie/balance.js — Portefeuille : solde, paiement, historique.
//
// `/balance` affiche le solde et deux boutons :
//   💸 Payer      → modal (destinataire, montant, raison) puis confirmation
//   📜 Historique → les 10 derniers mouvements du cliqueur
//
// Tout passe par utils/economy.js : le débit est conditionnel en base (jamais
// de solde négatif), le crédit est remboursé s'il échoue, et chaque virement
// est journalisé dans le modèle Transaction.
const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle, MessageFlags, PermissionFlagsBits,
} = require('discord.js');
const { COLORS, errorEmbed, successEmbed, infoEmbed } = require('../../utils/embeds');
const { getAppEmoji } = require('../../utils/emojiSync');
const economy = require('../../utils/economy');
const licenseGate = require('../../utils/licenseGate');

const BTN_PAY = 'bal_pay';
const BTN_HISTORY = 'bal_hist';
const BTN_LICENSE = 'bal_license';
const BTN_BUY_LICENSE = 'bal_buy_license';
const BTN_CONFIRM = 'bal_confirm';
const BTN_CANCEL = 'bal_cancel';
const MODAL_PAY = 'bal_pay_modal';
const LISTEN_MS = 5 * 60 * 1000;

// Un seul paiement en cours par membre : sans ce verrou, deux clics ouvrent
// deux formulaires et deux confirmations pour le même solde.
const pendingPayments = new Set(); // `${guildId}:${userId}`

/**
 * La carte de solde reste cliquable 5 minutes : sans revérification, une licence
 * (ou un essai) expirée pendant ce laps de temps laisserait encore payer.
 * @returns {Promise<string|null>} message de refus, ou null si l'accès est bon.
 */
async function licenseRefusal(guildId) {
  if (!guildId) return 'Ce serveur est introuvable.';
  const access = await licenseGate.checkAccessBounded(guildId, 'balance');
  if (!access) {
    return 'La vérification de licence n\'a pas abouti (base momentanément injoignable). Aucun paiement n\'a été effectué : réessaie dans un instant.';
  }
  if (!access.ok) {
    return 'La licence de ce serveur n\'est plus active : les paiements sont désactivés.\nActive une clé avec `/license`.';
  }
  return null;
}

// ─── petits constructeurs ────────────────────────────────────────────────────
function modalField(id, label, placeholder, required, maxLength) {
  return new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label)
      .setPlaceholder(placeholder)
      .setStyle(TextInputStyle.Short)
      .setRequired(required)
      .setMaxLength(maxLength),
  );
}

function walletEmbed(target, balance, coin, self) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`${coin} Solde de ${target.username}`)
    .setThumbnail(target.displayAvatarURL())
    .addFields({ name: `${coin} Pièces`, value: `**${economy.formatCoins(balance.coins)}**`, inline: true })
    .setTimestamp();

  if (self) {
    embed.setDescription(
      '**💸 Payer** envoie des pièces à un membre de ce serveur.\n'
      + '**📜 Historique** affiche tes derniers mouvements.',
    );
  }
  return embed;
}

/**
 * Retrouve un membre à partir d'une mention, d'un identifiant ou d'un pseudo.
 * @returns {Promise<import('discord.js').GuildMember|null>}
 */
async function resolveRecipient(guild, input) {
  const raw = String(input || '').trim();
  if (!raw || !guild) return null;

  const mention = raw.match(/^<@!?(\d{15,20})>$/);
  const id = mention ? mention[1] : (/^\d{15,20}$/.test(raw) ? raw : null);

  if (id) {
    return guild.members.fetch(id).catch(() => null);
  }

  const found = await guild.members.fetch({ query: raw.replace(/^@/, ''), limit: 5 }).catch(() => null);
  if (!found || !found.size) return null;

  const wanted = raw.replace(/^@/, '').toLowerCase();
  const candidates = [...found.values()].filter((m) => !m.user.bot);
  return candidates.find((m) => m.user.username.toLowerCase() === wanted || m.displayName.toLowerCase() === wanted)
    || candidates[0]
    || null;
}

// ─── 💸 Payer : modal puis confirmation ──────────────────────────────────────
async function openPaymentModal(button, coin) {
  const lockKey = `${button.guildId}:${button.user.id}`;
  if (pendingPayments.has(lockKey)) {
    return button.reply({
      embeds: [errorEmbed('Paiement déjà en cours', 'Termine le paiement déjà ouvert avant d\'en lancer un autre.')],
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }
  pendingPayments.add(lockKey);
  try {
    return await paymentModalFlow(button, coin);
  } finally {
    pendingPayments.delete(lockKey);
  }
}

async function paymentModalFlow(button, coin) {
  const modalId = `${MODAL_PAY}:${button.user.id}`;
  const modal = new ModalBuilder()
    .setCustomId(modalId)
    .setTitle('💸 Payer avec mon solde')
    .addComponents(
      modalField('dest', 'Destinataire (mention, ID ou pseudo)', 'Ex : @Alex, 123456789012345678', true, 100),
      modalField('amount', 'Montant en pièces', 'Ex : 250, ou "tout"', true, 16),
      modalField('reason', 'Raison (optionnel)', 'Ex : remboursement, pari, cadeau', false, economy.MAX_REASON),
    );

  await button.showModal(modal);

  let submit;
  try {
    submit = await button.awaitModalSubmit({ time: LISTEN_MS, filter: (m) => m.customId === modalId });
  } catch {
    return; // modal fermé sans envoi : rien à faire
  }

  // Le formulaire doit appartenir au cliqueur ET au même serveur.
  if (submit.user.id !== button.user.id || submit.guildId !== button.guildId) {
    return submit.reply({
      embeds: [errorEmbed('Formulaire invalide', 'Ce formulaire ne correspond pas à ton paiement.')],
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }

  await submit.deferReply({ flags: MessageFlags.Ephemeral });

  const refused = await licenseRefusal(submit.guildId);
  if (refused) return submit.editReply({ embeds: [errorEmbed('Paiement indisponible', refused)] });

  const payer = button.user;
  const guild = submit.guild || button.guild;
  const rawTarget = submit.fields.getTextInputValue('dest');
  const rawAmount = submit.fields.getTextInputValue('amount');
  const reason = submit.fields.getTextInputValue('reason');

  const target = await resolveRecipient(guild, rawTarget);
  if (!target) {
    return submit.editReply({
      embeds: [errorEmbed('Destinataire introuvable', `Aucun membre de ce serveur ne correspond à **${rawTarget.slice(0, 60)}**.`)],
    });
  }

  const parsed = economy.parseAmount(rawAmount);
  if (parsed === null) {
    return submit.editReply({
      embeds: [errorEmbed('Montant invalide', `**${rawAmount.slice(0, 40)}** n'est pas un montant. Indique un nombre entier de pièces (ex : **250**) ou **tout**.`)],
    });
  }

  const senderBalance = await economy.getBalance(submit.guildId, payer.id);
  const available = Math.max(0, Number(senderBalance.coins) || 0);
  const amount = parsed === 'all' ? Math.min(available, economy.MAX_TRANSFER) : parsed;

  const check = economy.validateTransfer({
    fromId: payer.id,
    toId: target.id,
    amount,
    targetIsBot: target.user.bot,
  });
  if (!check.ok) {
    return submit.editReply({ embeds: [errorEmbed('Paiement impossible', check.error)] });
  }

  if (available < amount) {
    return submit.editReply({
      embeds: [errorEmbed('Solde insuffisant', `Tu as **${economy.formatCoins(available)}** ${coin}, il en faut **${economy.formatCoins(amount)}**.`)],
    });
  }

  const confirmEmbed = new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle(`${coin} Confirmer le paiement`)
    .setDescription(`<@${payer.id}> ➜ <@${target.id}>`)
    .addFields(
      { name: 'Montant', value: `**${economy.formatCoins(amount)}** ${coin}`, inline: true },
      { name: 'Solde après paiement', value: `**${economy.formatCoins(available - amount)}** ${coin}`, inline: true },
    )
    .setFooter({ text: 'Un paiement est définitif — confirme sous 5 minutes.' })
    .setTimestamp();

  if (reason.trim()) confirmEmbed.addFields({ name: 'Raison', value: reason.trim().slice(0, economy.MAX_REASON) });

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(BTN_CONFIRM).setLabel('Confirmer').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(BTN_CANCEL).setLabel('Annuler').setEmoji('❌').setStyle(ButtonStyle.Secondary),
  );

  const confirmMessage = await submit.editReply({ embeds: [confirmEmbed], components: [confirmRow] });

  let choice;
  try {
    choice = await confirmMessage.awaitMessageComponent({
      time: LISTEN_MS,
      filter: (i) => i.user.id === payer.id && [BTN_CONFIRM, BTN_CANCEL].includes(i.customId),
    });
  } catch {
    return submit.editReply({
      embeds: [infoEmbed('Paiement annulé', 'Délai dépassé : aucune pièce n\'a été transférée.')],
      components: [],
    }).catch(() => {});
  }

  if (choice.customId === BTN_CANCEL) {
    return choice.update({
      embeds: [infoEmbed('Paiement annulé', 'Aucune pièce n\'a été transférée.')],
      components: [],
    });
  }

  await choice.deferUpdate();

  // Dernière barrière : l'accès peut avoir expiré pendant la confirmation.
  const lateRefusal = await licenseRefusal(submit.guildId);
  if (lateRefusal) {
    return choice.editReply({ embeds: [errorEmbed('Paiement refusé', lateRefusal)], components: [] });
  }

  const result = await economy.transferCoins({
    guildId: submit.guildId,
    fromId: payer.id,
    toId: target.id,
    amount,
    reason,
    targetIsBot: target.user.bot,
  });

  if (!result.ok) {
    return choice.editReply({ embeds: [errorEmbed('Paiement refusé', result.error)], components: [] });
  }

  const done = successEmbed(
    'Paiement envoyé',
    `<@${target.id}> a reçu **${economy.formatCoins(result.amount)}** ${coin}.`
    + (result.reason ? `\n*${result.reason}*` : ''),
  ).addFields(
    { name: 'Solde restant', value: `**${economy.formatCoins(result.sender.coins)}** ${coin}`, inline: true },
  );

  return choice.editReply({ embeds: [done], components: [] });
}

// ─── 📜 Historique ───────────────────────────────────────────────────────────
async function showHistory(button, coin) {
  await button.deferReply({ flags: MessageFlags.Ephemeral });

  const [balance, rows] = await Promise.all([
    economy.getBalance(button.guildId, button.user.id),
    economy.getHistory(button.guildId, button.user.id),
  ]);

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('📜 Historique des paiements')
    .setDescription(
      rows.length
        ? rows.map((row) => economy.formatTransactionLine(row, button.user.id, coin)).join('\n').slice(0, 4000)
        : 'Aucun paiement pour le moment.\nUtilise **💸 Payer** pour envoyer tes premières pièces.',
    )
    .addFields({ name: `${coin} Solde actuel`, value: `**${economy.formatCoins(balance.coins)}**`, inline: true })
    .setTimestamp();

  return button.editReply({ embeds: [embed] });
}

// ─── 💎 Licence : achat avec le solde ───────────────────────────────────────
/**
 * Qui peut offrir une licence au serveur : son propriétaire, un administrateur
 * (permission Administrator), ou un owner du bot. Chacun paie avec SON solde.
 */
function canBuyLicense(interaction) {
  if (!interaction?.guild || !interaction.user) return false;
  if (licenseGate.isOwner(interaction.user.id)) return true;
  if (interaction.guild.ownerId === interaction.user.id) return true;

  const permissions = interaction.memberPermissions || interaction.member?.permissions;
  return !!permissions?.has?.(PermissionFlagsBits.Administrator);
}
async function showLicensePanel(button, coin) {
  await button.deferReply({ flags: MessageFlags.Ephemeral });

  const cfg = licenseGate.getLicenseShopConfig();
  const [balance, status] = await Promise.all([
    economy.getBalance(button.guildId, button.user.id),
    licenseGate.getLicenseStatus(button.guildId),
  ]);

  const available = Math.max(0, Number(balance.coins) || 0);
  const canPurchase = canBuyLicense(button);
  const unlimited = status.status === 'active' && !!status.license && !status.license.expiresAt;

  const statusLine = unlimited
    ? '💎 **Licence illimitée** — rien à acheter.'
    : status.status === 'active'
      ? `✅ Licence active — expire <t:${Math.floor(new Date(status.license.expiresAt).getTime() / 1000)}:R> (un achat la prolonge).`
      : status.status === 'grace'
        ? '⏳ Licence en période de grâce — un achat la prolonge et évite le verrouillage.'
        : status.status === 'expired'
        ? '⌛ Licence expirée — un achat la réactive immédiatement.'
        : status.status === 'revoked'
          ? '⛔ Licence révoquée — un achat en délivre une nouvelle.'
          : '🔒 Aucune licence — les fonctionnalités premium sont verrouillées.';

  const canBuy = canPurchase && !unlimited && available >= cfg.priceCoins;

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('💎 Licence REZO')
    .setDescription(
      `${statusLine}\n\n`
      + `Achat : **${cfg.days} jours** pour **${economy.formatCoins(cfg.priceCoins)}** ${coin}\n`
      + `Ton solde : **${economy.formatCoins(available)}** ${coin}`
      + (canPurchase ? '' : '\n\n⚠️ Réservé au **propriétaire** et aux **administrateurs** du serveur.'),
    )
    .setFooter({ text: `Paiement en pièces — aucun argent réel • ${cfg.priceCoins} pièces / ${cfg.days} j` })
    .setTimestamp();

  if (canPurchase && !unlimited && available < cfg.priceCoins) {
    embed.addFields({ name: 'Il te manque', value: `**${economy.formatCoins(cfg.priceCoins - available)}** ${coin}`, inline: true });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BTN_BUY_LICENSE)
      .setLabel(`Acheter ${cfg.days} j`)
      .setEmoji('💎')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!canBuy),
  );

  const message = await button.editReply({ embeds: [embed], components: [row] });
  if (!canBuy) return;

  let buying = false;
  const collector = message.createMessageComponentCollector({
    time: LISTEN_MS,
    filter: (i) => i.user.id === button.user.id && i.customId === BTN_BUY_LICENSE,
  });
  collector.on('collect', async (buy) => {
    if (buying) return;
    buying = true;
    await buy.deferUpdate();
    const payload = await purchaseLicense(buy, cfg, coin);
    collector.stop();
    return buy.editReply(payload);
  });
  collector.on('error', (err) => console.error('[Balance] licence :', err.message));
}

/**
 * Débite les pièces puis délivre la licence. Si la licence n'a pas pu être
 * créée, les pièces sont rendues : l'achat ne doit jamais laisser un solde
 * amputé sans contrepartie.
 */
async function purchaseLicense(interaction, cfg, coin) {
  const guild = interaction?.guild;
  const user = interaction?.user;
  if (!guild || !user) return { embeds: [errorEmbed('Serveur introuvable', 'Impossible d\'identifier le serveur.')] };

  if (!canBuyLicense(interaction)) {
    return { embeds: [errorEmbed('Accès refusé', 'Seuls le **propriétaire** et les **administrateurs** du serveur peuvent acheter une licence.')] };
  }

  const status = await licenseGate.getLicenseStatus(guild.id);
  if (status.status === 'active' && status.license && !status.license.expiresAt) {
    return { embeds: [errorEmbed('Déjà illimitée', 'Ce serveur possède déjà une licence illimitée.')] };
  }

  const spent = await economy.spendCoins({
    guildId: guild.id,
    userId: user.id,
    amount: cfg.priceCoins,
    reason: `Licence REZO ${cfg.days} jours`,
  });
  if (!spent.ok) return { embeds: [errorEmbed('Achat impossible', spent.error)] };

  let grant;
  try {
    grant = await licenseGate.grantLicense(guild.id, guild.name, user.id, {
      days: cfg.days,
      note: `Achat en pièces (${cfg.priceCoins} / ${cfg.days} j)`,
    });
  } catch (err) {
    console.error('[Balance] licence :', err.message);
    grant = { ok: false, reason: 'error' };
  }

  if (!grant.ok) {
    const refund = await economy.refundCoins({
      guildId: guild.id,
      userId: user.id,
      amount: cfg.priceCoins,
      reason: 'Licence non délivrée',
    });
    const why = grant.reason === 'unlimited'
      ? 'ce serveur a déjà une licence illimitée'
      : grant.reason === 'issuer_locked'
        ? 'cette instance du bot n’a pas de licence maître valide : elle ne peut émettre aucune clé'
        : 'la licence n\'a pas pu être délivrée';
    const refundLine = refund.ok
      ? 'Tes pièces ont été **remboursées**.'
      : '⚠️ **Le remboursement a échoué** — contacte un administrateur avec l\'heure de l\'achat.';
    return { embeds: [errorEmbed('Achat annulé', `Aucune licence créée : ${why}.\n${refundLine}`)] };
  }

  const ts = Math.floor(new Date(grant.license.expiresAt).getTime() / 1000);
  const done = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle('💎 Licence activée')
    .setDescription(`**${cfg.days} jours** ${grant.extended ? 'ajoutés' : 'de licence'} pour **${guild.name}**.`)
    .addFields(
      { name: 'Expire', value: `<t:${ts}:f>\n(<t:${ts}:R>)`, inline: true },
      { name: 'Solde restant', value: `**${economy.formatCoins(spent.sender.coins)}** ${coin}`, inline: true },
      { name: 'Clé', value: `\`${String(grant.license.key).split('-').slice(0, 2).join('-')}-••••-••••-••••\``, inline: true },
      { name: 'Acheté par', value: `<@${user.id}>`, inline: true },
    )
    .setFooter({ text: 'Fonctionnalités premium débloquées immédiatement.' })
    .setTimestamp();

  return { embeds: [done] };
}

// ─── Commande ────────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('balance')
    .setDescription('💰 Voir son solde, payer un membre et consulter l\'historique')
    .addUserOption((o) => o.setName('user').setDescription('Utilisateur (vous par défaut)')),

  async execute(interaction, client) {
    await interaction.deferReply();

    const coin = getAppEmoji(client, 'bumpify_coin') || '💰';
    const target = interaction.options.getUser('user') || interaction.user;
    const balance = await economy.getBalance(interaction.guildId, target.id);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(BTN_PAY).setLabel('Payer').setEmoji('💸').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(BTN_HISTORY).setLabel('Historique').setEmoji('📜').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(BTN_LICENSE).setLabel('Licence').setEmoji('💎').setStyle(ButtonStyle.Primary),
    );

    const message = await interaction.editReply({
      embeds: [walletEmbed(target, balance, coin, target.id === interaction.user.id)],
      components: [row],
    });

    const collector = message.createMessageComponentCollector({ time: LISTEN_MS });
    collector.on('collect', (button) => {
      const task = button.customId === BTN_PAY
        ? openPaymentModal(button, coin)
        : button.customId === BTN_HISTORY
          ? showHistory(button, coin)
          : button.customId === BTN_LICENSE
            ? showLicensePanel(button, coin)
            : null;

      // Le retour est ignoré par l'EventEmitter mais permet aux tests de
      // suivre le clic de bout en bout.
      return task ? task.catch((err) => console.error('[Balance] bouton :', err.message)) : undefined;
    });
    collector.on('error', (err) => console.error('[Balance] collector :', err.message));
  },
};
