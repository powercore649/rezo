// commands/economie/shop.js — Boutique interactive du serveur.
//
// `/shop` affiche le catalogue du serveur et permet d'acheter **en un clic** :
//   1. le membre choisit un article dans le menu déroulant ;
//   2. un bouton « Acheter » rappelle le prix et le solde restant ;
//   3. la confirmation débite les pièces et livre l'article (rôle / badge / avantage).
//
// Les articles et leurs prix se gèrent depuis le panel central
// (`/setting` → 🎉 Communauté → 🛒 Boutique) ou directement ici : un
// administrateur voit les boutons ➕ Ajouter, ✏️ Modifier et 🗑️ Supprimer.
//
// L'achat lui-même vit dans utils/shopEngine.js : stock réservé atomiquement,
// débit conditionnel via utils/economy.js, remboursement si la livraison échoue.
const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, RoleSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits, MessageFlags,
} = require('discord.js');
const { ShopItem, Inventory } = require('../../models/Shop');
const { COLORS, errorEmbed, successEmbed, infoEmbed, warningEmbed } = require('../../utils/embeds');
const { getLimit } = require('../../utils/premium');
const economy = require('../../utils/economy');
const shopEngine = require('../../utils/shopEngine');

// ─── Identifiants des composants ────────────────────────────────────────────
const SEL_BUY = 'shop_pick';
const BTN_CONFIRM = 'shop_confirm';
const BTN_CANCEL = 'shop_cancel';
const BTN_BACK = 'shop_back';
const BTN_REFRESH = 'shop_refresh';
const BTN_INVENTORY = 'shop_inventory';
const BTN_ADD = 'shop_add';
const BTN_EDIT = 'shop_edit';
const BTN_DELETE = 'shop_del';
const SEL_EDIT = 'shop_edit_pick';
const SEL_DELETE = 'shop_delete_pick';
const SEL_ROLE = 'shop_new_role';
const BTN_DELETE_YES = 'shop_delete_yes';
const BTN_DELETE_NO = 'shop_delete_no';
const MODAL_ADD = 'shop_modal_add';
const MODAL_EDIT = 'shop_modal_edit:';

const LISTEN_MS = 5 * 60 * 1000;

// ─── Permissions ────────────────────────────────────────────────────────────
function isAdmin(interaction) {
  const perms = interaction.memberPermissions || interaction.member?.permissions;
  if (!perms?.has) return false;
  return perms.has(PermissionFlagsBits.Administrator);
}

// ─── Petits constructeurs Discord ───────────────────────────────────────────
function textField(id, label, placeholder, required, maxLength, value = null) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setPlaceholder(placeholder)
    .setStyle(TextInputStyle.Short)
    .setRequired(required)
    .setMaxLength(maxLength);
  if (value !== null) input.setValue(value);
  return new ActionRowBuilder().addComponents(input);
}

function paragraphField(id, label, placeholder, required, maxLength, value = null) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setPlaceholder(placeholder)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(required)
    .setMaxLength(maxLength);
  if (value !== null) input.setValue(value);
  return new ActionRowBuilder().addComponents(input);
}

function buttonRow(components) {
  return new ActionRowBuilder().addComponents(...components);
}

// ─── Affichage du catalogue ─────────────────────────────────────────────────
/** Une ligne de catalogue : « 🎭 **Rôle VIP** — 5 000 🪙 · Stock : 3 ». */
function itemLine(item) {
  const emoji = shopEngine.TYPE_EMOJI[item.type] || '📦';
  const stock = shopEngine.stockLabel(item);
  const soldOut = Number(item.stock) === 0 ? ' · **rupture**' : '';
  return [
    `${emoji} **${item.name}** — ${shopEngine.priceLabel(item.price)} · Stock : ${stock}${soldOut}`,
    item.description ? `   *${String(item.description).slice(0, 160)}*` : null,
  ].filter(Boolean).join('\n');
}

function buildPanelEmbed(items, guild, { notice = null, selected = null, admin = false } = {}) {
  const enabled = items.filter(i => i.enabled !== false);
  const buyable = shopEngine.buyableItems(items);

  const lines = ['🛍️ **Choisis un article** dans le menu ci-dessous, puis confirme ton achat.', ''];
  if (!enabled.length) {
    lines.push('*La boutique est vide pour l\'instant.*');
    if (admin) lines.push('', '➕ Utilise **Ajouter un article** pour créer le premier article et fixer son prix.');
  } else {
    lines.push(...enabled.slice(0, 40).map(itemLine));
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`🛒 Boutique — ${guild?.name || 'ce serveur'}`)
    .setDescription(lines.join('\n').slice(0, 3900))
    .setFooter({ text: 'REZO • Boutique' })
    .setTimestamp();

  if (guild?.iconURL) {
    const icon = guild.iconURL({ dynamic: true });
    if (icon) embed.setThumbnail(icon);
  }

  if (enabled.length) {
    const cheapest = buyable[0];
    embed.addFields({
      name: '📦 En vente',
      value: `${buyable.length} article(s) disponible(s)${cheapest ? ` · dès **${shopEngine.priceLabel(cheapest.price)}**` : ''}`,
      inline: true,
    });
  }

  if (selected) {
    embed.addFields({ name: '🧾 Sélection', value: `${selected.name} — **${shopEngine.priceLabel(selected.price)}**`, inline: true });
  }

  if (notice) embed.addFields({ name: 'ℹ️ Info', value: String(notice).slice(0, 1000) });

  if (admin) {
    embed.addFields({ name: '🛠️ Gestion (admin)', value: '➕ Ajouter · ✏️ Modifier · 🗑️ Supprimer', inline: false });
  }

  return embed;
}

/** Un menu par tranche de 25 articles (Discord refuse plus de 25 options). */
function buildCatalogRows(buyable) {
  const rows = [];
  for (let start = 0; start < buyable.length; start += shopEngine.SELECT_LIMIT) {
    const chunk = buyable.slice(start, start + shopEngine.SELECT_LIMIT);
    const page = Math.floor(start / shopEngine.SELECT_LIMIT);
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(page === 0 ? SEL_BUY : `${SEL_BUY}:${page}`)
        .setPlaceholder(`🛍️ Choisir un article à acheter…${page ? ` (page ${page + 1})` : ''}`)
        .addOptions(chunk.map(item => ({
          label: item.name.slice(0, 100),
          value: item.itemId,
          description: `${shopEngine.priceLabel(item.price)} · Stock : ${shopEngine.stockLabel(item)}`.slice(0, 100),
          emoji: shopEngine.TYPE_EMOJI[item.type] || '📦',
        }))),
    ));
  }
  return rows;
}

function buildConfirmRow(selected) {
  return buttonRow([
    new ButtonBuilder()
      .setCustomId(BTN_CONFIRM)
      .setLabel(`Acheter — ${shopEngine.priceLabel(selected.price)}`.slice(0, 80))
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(BTN_CANCEL).setLabel('Annuler').setEmoji('❌').setStyle(ButtonStyle.Secondary),
  ]);
}

function buildBaseRow() {
  return buttonRow([
    new ButtonBuilder().setCustomId(BTN_INVENTORY).setLabel('Mon inventaire').setEmoji('🎒').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(BTN_REFRESH).setLabel('Actualiser').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
  ]);
}

function buildAdminRow() {
  return buttonRow([
    new ButtonBuilder().setCustomId(BTN_ADD).setLabel('Ajouter un article').setEmoji('➕').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(BTN_EDIT).setLabel('Modifier').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(BTN_DELETE).setLabel('Supprimer').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
  ]);
}

function buildBackRow() {
  return buttonRow([
    new ButtonBuilder().setCustomId(BTN_BACK).setLabel('Retour à la boutique').setEmoji('🛒').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(BTN_INVENTORY).setLabel('Mon inventaire').setEmoji('🎒').setStyle(ButtonStyle.Secondary),
  ]);
}

function buildItemPickerRows(customId, items, placeholder) {
  const rows = [];
  for (let start = 0; start < items.length; start += shopEngine.SELECT_LIMIT) {
    const chunk = items.slice(start, start + shopEngine.SELECT_LIMIT);
    const page = Math.floor(start / shopEngine.SELECT_LIMIT);
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(page === 0 ? customId : `${customId}:${page}`)
        .setPlaceholder(`${placeholder}${page ? ` (page ${page + 1})` : ''}`)
        .addOptions(chunk.map(item => ({
          label: item.name.slice(0, 100),
          value: item.itemId,
          description: `${shopEngine.priceLabel(item.price)} · ${shopEngine.TYPE_LABEL[item.type] || item.type}`.slice(0, 100),
          emoji: shopEngine.TYPE_EMOJI[item.type] || '📦',
        }))),
    ));
  }
  return rows;
}

/** Payload complet du panel (embed + composants) pour l'utilisateur donné. */
async function panelPayload(guild, { notice = null, selected = null, admin = false } = {}) {
  let items = [];
  try {
    items = await ShopItem.find({ guildId: guild.id });
  } catch { items = []; }
  items = [...items].sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0));

  const buyable = shopEngine.buyableItems(items);
  const components = [...buildCatalogRows(buyable)];
  components.push(selected ? buildConfirmRow(selected) : buildBaseRow());
  if (admin) components.push(buildAdminRow());

  return { embeds: [buildPanelEmbed(items, guild, { notice, selected, admin })], components };
}

function purchaseEmbed(result, buyerId) {
  const item = result.item;
  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle('✅ Achat réussi !')
    .setDescription(`<@${buyerId}> vient d'acheter **${item.name}**.`)
    .addFields(
      { name: '💰 Prix payé', value: shopEngine.priceLabel(item.price), inline: true },
      { name: '💳 Solde restant', value: result.coinsLeft === null ? '*—*' : shopEngine.priceLabel(result.coinsLeft), inline: true },
      { name: '📦 Stock restant', value: shopEngine.stockLabel(item), inline: true },
    )
    .setFooter({ text: 'REZO • Boutique' })
    .setTimestamp();

  if (result.roleAdded) embed.setDescription(`Le rôle <@&${result.roleAdded}> t'a été attribué !`);
  if (item.type === 'badge' && item.badge) embed.setDescription(`Tu as reçu le badge **${item.badge}** !`);
  return embed;
}

// ─── Gestion admin : ajouter ─────────────────────────────────────────────────
/** Valide et crée un article. Fonction partagée par le modal (et les tests). */
async function createItem({ guildId, name, price, type, stock, description = '', roleId = null }) {
  const cleanName = String(name || '').trim();
  const parsedPrice = shopEngine.parsePrice(price);
  const parsedStock = shopEngine.parseStock(stock);
  const parsedType = shopEngine.parseType(type);

  if (cleanName.length < 2) return { ok: false, error: 'Le nom de l\'article doit contenir au moins 2 caractères.' };
  if (parsedPrice === null) return { ok: false, error: `Le prix doit être un entier entre ${shopEngine.MIN_PRICE} et ${economy.formatCoins(shopEngine.MAX_PRICE)} pièces.` };
  if (parsedStock === null) return { ok: false, error: 'Le stock doit être un entier positif, ou -1 pour un stock illimité.' };
  if (!parsedType) return { ok: false, error: 'Le type doit être `role`, `badge` ou `perk`.' };
  if (parsedType === 'role' && !roleId) return { ok: false, error: 'Choisis le rôle à attribuer pour un article de type rôle.' };

  const limit = await getLimit(guildId, 'shopItems').catch(() => 8);
  const count = await ShopItem.countDocuments({ guildId }).catch(() => 0);
  if (count >= limit) {
    return { ok: false, error: `Limite de **${limit} articles** atteinte. Utilise \`/license\` pour débloquer plus d'emplacements.` };
  }

  const item = await ShopItem.create({
    guildId,
    itemId: require('crypto').randomUUID().split('-')[0],
    name: cleanName.slice(0, shopEngine.MAX_NAME),
    description: String(description || '').trim().slice(0, shopEngine.MAX_DESCRIPTION),
    price: parsedPrice,
    type: parsedType,
    roleId: parsedType === 'role' ? roleId : null,
    stock: parsedStock,
  });

  return { ok: true, item };
}

/** Modal ➕ Ajouter, puis choix du rôle si nécessaire. */
async function addItemFlow(button) {
  if (!isAdmin(button)) {
    return button.reply({
      embeds: [errorEmbed('Permission refusée', 'Seul un administrateur peut ajouter un article.')],
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }

  const modal = new ModalBuilder()
    .setCustomId(MODAL_ADD)
    .setTitle('➕ Nouvel article')
    .addComponents(
      textField('name', 'Nom de l\'article', 'Ex : Rôle VIP', true, shopEngine.MAX_NAME),
      textField('price', 'Prix en pièces', 'Ex : 5000', true, 12),
      textField('type', 'Type (role, badge ou perk)', 'role', true, 10),
      textField('stock', 'Stock (-1 = illimité)', '-1', false, 7),
      paragraphField('description', 'Description (optionnel)', 'Ex : Accès aux salons privés', false, shopEngine.MAX_DESCRIPTION),
    );

  await button.showModal(modal);
  const submit = await button.awaitModalSubmit({
    time: LISTEN_MS,
    filter: m => m.customId === MODAL_ADD && m.user.id === button.user.id,
  }).catch(() => null);
  if (!submit) return null;

  const name = submit.fields.getTextInputValue('name');
  const price = submit.fields.getTextInputValue('price');
  const type = shopEngine.parseType(submit.fields.getTextInputValue('type'));
  const stock = submit.fields.getTextInputValue('stock');
  const description = submit.fields.getTextInputValue('description');

  let roleId = null;
  if (type === 'role') {
    const prompt = await submit.reply({
      embeds: [infoEmbed('🎭 Rôle à attribuer', 'Choisis le rôle que l\'acheteur recevra automatiquement.')],
      components: [new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId(SEL_ROLE)
          .setPlaceholder('🎭 Choisir le rôle vendu…'),
      )],
      flags: MessageFlags.Ephemeral,
      fetchReply: true,
    });

    const picked = await prompt.awaitMessageComponent({
      time: LISTEN_MS,
      filter: m => m.customId === SEL_ROLE && m.user.id === button.user.id,
    }).catch(() => null);

    if (!picked) {
      await submit.editReply({
        embeds: [errorEmbed('Ajout annulé', 'Aucun rôle sélectionné : l\'article n\'a pas été créé.')],
        components: [],
      }).catch(() => {});
      return null;
    }
    roleId = picked.values[0];
    await picked.deferUpdate().catch(() => {});
  }

  const created = await createItem({
    guildId: button.guildId,
    name: String(name || ''),
    price: String(price || ''),
    type: String(type || ''),
    stock: String(stock ?? ''),
    description: String(description || ''),
    roleId,
  }).catch(err => ({ ok: false, error: `Création impossible : ${err.message}` }));

  if (!created.ok) {
    const payload = { embeds: [errorEmbed('Article non créé', created.error)], components: [] };
    if (roleId) await submit.editReply(payload).catch(() => {});
    else await submit.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
    return null;
  }

  const success = successEmbed('Article ajouté', `**${created.item.name}** est en vente pour **${shopEngine.priceLabel(created.item.price)}**.`);
  if (roleId) await submit.editReply({ embeds: [success], components: [] }).catch(() => {});
  else await submit.reply({ embeds: [success], flags: MessageFlags.Ephemeral }).catch(() => {});

  return created.item;
}

// ─── Gestion admin : modifier ───────────────────────────────────────────────
async function editItemFlow(button) {
  if (!isAdmin(button)) {
    return button.reply({
      embeds: [errorEmbed('Permission refusée', 'Seul un administrateur peut modifier la boutique.')],
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }

  const items = await ShopItem.find({ guildId: button.guildId }).catch(() => []);
  if (!items.length) {
    return button.reply({
      embeds: [errorEmbed('Boutique vide', 'Ajoute d\'abord un article avec **➕ Ajouter un article**.')],
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }

  const prompt = await button.reply({
    embeds: [infoEmbed('✏️ Modifier un article', 'Choisis l\'article à modifier (nom, prix, description, stock).')],
    components: buildItemPickerRows(SEL_EDIT, items, '✏️ Article à modifier…'),
    flags: MessageFlags.Ephemeral,
    fetchReply: true,
  });

  const picked = await prompt.awaitMessageComponent({
    time: LISTEN_MS,
    filter: m => (m.customId === SEL_EDIT || m.customId.startsWith(`${SEL_EDIT}:`)) && m.user.id === button.user.id,
  }).catch(() => null);
  if (!picked) return null;

  const item = items.find(x => x.itemId === picked.values[0]);
  if (!item) return null;

  const modalId = `${MODAL_EDIT}${item.itemId}`;
  const modal = new ModalBuilder()
    .setCustomId(modalId)
    .setTitle('✏️ Modifier l\'article')
    .addComponents(
      textField('name', 'Nom de l\'article', 'Ex : Rôle VIP', true, shopEngine.MAX_NAME, item.name),
      textField('price', 'Prix en pièces', 'Ex : 5000', true, 12, String(item.price)),
      textField('stock', 'Stock (-1 = illimité)', '-1', false, 7, String(item.stock)),
      paragraphField('description', 'Description (optionnel)', '', false, shopEngine.MAX_DESCRIPTION, item.description || ''),
    );

  await picked.showModal(modal);
  const submit = await picked.awaitModalSubmit({
    time: LISTEN_MS,
    filter: m => m.customId === modalId && m.user.id === button.user.id,
  }).catch(() => null);
  if (!submit) return null;

  const name = String(submit.fields.getTextInputValue('name') || '').trim();
  const price = shopEngine.parsePrice(submit.fields.getTextInputValue('price'));
  const stock = shopEngine.parseStock(submit.fields.getTextInputValue('stock'));

  if (name.length < 2) {
    return submit.reply({ embeds: [errorEmbed('Nom invalide', 'Le nom doit contenir au moins 2 caractères.')], flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  if (price === null) {
    return submit.reply({ embeds: [errorEmbed('Prix invalide', `Indique un entier entre ${shopEngine.MIN_PRICE} et ${economy.formatCoins(shopEngine.MAX_PRICE)}.`)], flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  if (stock === null) {
    return submit.reply({ embeds: [errorEmbed('Stock invalide', 'Indique un entier positif, ou -1 pour illimité.')], flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  item.name = name.slice(0, shopEngine.MAX_NAME);
  item.price = price;
  item.stock = stock;
  item.description = String(submit.fields.getTextInputValue('description') || '').trim().slice(0, shopEngine.MAX_DESCRIPTION);
  await item.save();

  await submit.reply({
    embeds: [successEmbed('Article modifié', `**${item.name}** coûte désormais **${shopEngine.priceLabel(item.price)}** (stock : ${shopEngine.stockLabel(item)}).`)],
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});

  return item;
}

// ─── Gestion admin : supprimer ──────────────────────────────────────────────
async function deleteItemFlow(button) {
  if (!isAdmin(button)) {
    return button.reply({
      embeds: [errorEmbed('Permission refusée', 'Seul un administrateur peut supprimer un article.')],
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }

  const items = await ShopItem.find({ guildId: button.guildId }).catch(() => []);
  if (!items.length) {
    return button.reply({
      embeds: [errorEmbed('Boutique vide', 'Il n\'y a aucun article à supprimer.')],
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }

  const prompt = await button.reply({
    embeds: [infoEmbed('🗑️ Supprimer un article', 'Choisis l\'article à retirer de la boutique.')],
    components: buildItemPickerRows(SEL_DELETE, items, '🗑️ Article à supprimer…'),
    flags: MessageFlags.Ephemeral,
    fetchReply: true,
  });

  const picked = await prompt.awaitMessageComponent({
    time: LISTEN_MS,
    filter: m => (m.customId === SEL_DELETE || m.customId.startsWith(`${SEL_DELETE}:`)) && m.user.id === button.user.id,
  }).catch(() => null);
  if (!picked) return null;

  const item = items.find(x => x.itemId === picked.values[0]);
  if (!item) return null;

  const confirm = await picked.reply({
    embeds: [warningEmbed('Confirmer la suppression', `Supprimer **${item.name}** ? Les inventaires déjà achetés sont conservés.`)],
    components: [buttonRow([
      new ButtonBuilder().setCustomId(BTN_DELETE_YES).setLabel('Supprimer').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(BTN_DELETE_NO).setLabel('Annuler').setStyle(ButtonStyle.Secondary),
    ])],
    flags: MessageFlags.Ephemeral,
    fetchReply: true,
  });

  const answer = await confirm.awaitMessageComponent({
    time: LISTEN_MS,
    filter: m => (m.customId === BTN_DELETE_YES || m.customId === BTN_DELETE_NO) && m.user.id === button.user.id,
  }).catch(() => null);
  if (!answer || answer.customId === BTN_DELETE_NO) {
    if (answer) {
      await answer.update({ embeds: [infoEmbed('Suppression annulée', `**${item.name}** reste en vente.`)], components: [] }).catch(() => {});
    }
    return null;
  }

  await ShopItem.findOneAndDelete({ guildId: button.guildId, itemId: item.itemId }).catch(() => null);
  await answer.update({
    embeds: [successEmbed('Article supprimé', `**${item.name}** a été retiré de la boutique.`)],
    components: [],
  }).catch(() => {});

  return item;
}

// ─── Commande ───────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('🛒 Boutique du serveur — choisis un article et achète-le avec tes pièces'),

  // Exposés pour les tests et le panel central
  buildPanelEmbed,
  panelPayload,
  purchaseEmbed,
  createItem,
  isAdmin,

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({
        embeds: [errorEmbed('Serveur uniquement', 'La boutique n\'est disponible que dans un serveur.')],
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }

    const guild = interaction.guild;
    const admin = isAdmin(interaction);
    let selected = null;

    const reply = await interaction.reply({
      ...(await panelPayload(guild, { admin })),
      flags: MessageFlags.Ephemeral,
      fetchReply: true,
    });

    const refresh = async (notice = null) => {
      try {
        await reply.edit(await panelPayload(guild, { admin, notice, selected }));
      } catch (err) {
        console.error('shop (rafraîchissement):', err.message);
      }
    };

    const collector = reply.createMessageComponentCollector({
      filter: i => i.user.id === interaction.user.id,
      time: 15 * 60 * 1000,
    });

    collector.on('collect', async i => {
      try {
        // ── Choix d'un article → écran de confirmation ────────────────
        if (i.customId === SEL_BUY || i.customId.startsWith(`${SEL_BUY}:`)) {
          const items = await ShopItem.find({ guildId: guild.id }).catch(() => []);
          const item = items.find(x => x.itemId === i.values[0]);
          if (!shopEngine.isBuyable(item)) {
            selected = null;
            return i.update(await panelPayload(guild, { admin, notice: '⚠️ Cet article n\'est plus disponible.' }));
          }
          selected = item;
          return i.update(await panelPayload(guild, { admin, selected: item }));
        }

        // ── Confirmation d'achat ─────────────────────────────────────
        if (i.customId === BTN_CONFIRM) {
          await i.deferUpdate().catch(() => {});
          const itemId = selected?.itemId;
          selected = null;
          if (!itemId) return refresh('⚠️ Aucun article sélectionné.');

          const member = i.member || await guild.members?.fetch?.(i.user.id).catch(() => null);
          const result = await shopEngine.purchase({
            guildId: guild.id,
            userId: i.user.id,
            itemId,
            member,
          });

          if (!result.ok) {
            return i.editReply({
              embeds: [errorEmbed(shopEngine.ERROR_TITLES[result.code] || 'Achat impossible', result.error)],
              components: [buildBackRow()],
            }).catch(() => {});
          }

          // L'acheteur voit son reçu ; le catalogue reste à un clic.
          return i.editReply({
            embeds: [purchaseEmbed(result, i.user.id)],
            components: [buildBackRow()],
          }).catch(() => {});
        }

        if (i.customId === BTN_CANCEL) {
          selected = null;
          return i.update(await panelPayload(guild, { admin, notice: 'Achat annulé.' }));
        }

        if (i.customId === BTN_BACK) {
          selected = null;
          return i.update(await panelPayload(guild, { admin }));
        }

        if (i.customId === BTN_REFRESH) {
          return i.update(await panelPayload(guild, { admin, selected, notice: 'Boutique actualisée.' }));
        }

        // ── Inventaire personnel ──────────────────────────────────────
        if (i.customId === BTN_INVENTORY) {
          const owned = await Inventory.find({ userId: i.user.id, guildId: guild.id }).catch(() => []);
          if (!owned.length) {
            return i.reply({
              embeds: [errorEmbed('Inventaire vide', 'Tu n\'as encore acheté aucun article. Choisis-en un dans le menu !')],
              flags: MessageFlags.Ephemeral,
            }).catch(() => {});
          }
          const lines = owned.map(entry => {
            const emoji = shopEngine.TYPE_EMOJI[entry.type] || '📦';
            const extra = entry.roleId ? ` → <@&${entry.roleId}>` : entry.badge ? ` → ${entry.badge}` : '';
            return `${emoji} **${entry.name}**${extra}`;
          });
          return i.reply({
            embeds: [new EmbedBuilder()
              .setColor(COLORS.primary)
              .setTitle('🎒 Ton inventaire')
              .setDescription(lines.join('\n').slice(0, 3900))
              .setFooter({ text: 'REZO • Boutique' })],
            flags: MessageFlags.Ephemeral,
          }).catch(() => {});
        }

        // ── Gestion admin ─────────────────────────────────────────────
        if (i.customId === BTN_ADD) {
          const created = await addItemFlow(i);
          if (created) await refresh(`✅ **${created.name}** ajouté pour ${shopEngine.priceLabel(created.price)}.`);
          return;
        }

        if (i.customId === BTN_EDIT) {
          const updated = await editItemFlow(i);
          if (updated) await refresh(`✏️ **${updated.name}** mis à jour : ${shopEngine.priceLabel(updated.price)}.`);
          return;
        }

        if (i.customId === BTN_DELETE) {
          const deleted = await deleteItemFlow(i);
          if (deleted) await refresh(`🗑️ **${deleted.name}** retiré de la boutique.`);
          return;
        }
      } catch (err) {
        console.error('shop panel:', err.message);
        if (!i.replied && !i.deferred) {
          await i.reply({
            embeds: [errorEmbed('Erreur', 'Quelque chose s\'est mal passé. Réessaie dans un instant.')],
            flags: MessageFlags.Ephemeral,
          }).catch(() => {});
        }
      }
    });

    collector.on('end', () => {
      reply.edit({ components: [] }).catch(() => {});
    });
  },
};
