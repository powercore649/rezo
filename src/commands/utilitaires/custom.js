// commands/utilitaires/custom.js — Commandes personnalisées créées par les membres.
//
// UNE SEULE commande pour tout faire :
//   • `/custom`                      → ouvre le panneau de gestion (tout s'y trouve)
//   • `/custom nom:regles texte:…`   → lance directement la commande (autocomplétion)
//
// Discord n'autorise pas une commande slash par membre (100 commandes globales
// pour tout le bot) : les commandes personnelles sont stockées par serveur et
// exécutées à la demande — ici, ou par le préfixe du serveur (`b!regles`).
const {
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, RoleSelectMenuBuilder,
} = require('discord.js');
const engine = require('../../utils/customCommands');
const { successEmbed, errorEmbed, COLORS } = require('../../utils/embeds');
const { footer, BRAND } = require('../../utils/brand');

const MANAGER = PermissionFlagsBits.ManageGuild;

// ── Helpers ──────────────────────────────────────────────────────────────────
function isManager(interaction) {
  return Boolean(interaction.memberPermissions?.has(MANAGER));
}

function memberRoleIds(interaction) {
  const cache = interaction.member?.roles?.cache;
  if (!cache) return [];
  return [...cache.keys()];
}

function userName(user) { return user?.username ?? 'membre'; }

function displayNameOf(user, member) {
  return member?.displayName || user?.globalName || user?.username || 'membre';
}

// Noms interdits : toutes les commandes du bot (dont /custom elle-même).
function reservedNames(client) {
  const names = client?.commands ? [...client.commands.keys()] : [];
  return [...new Set([...names, 'custom'])];
}

// Remplace le message courant quand c'est un composant (panneau), sinon répond.
async function show(interaction, payload) {
  const isComponent = typeof interaction.isMessageComponent === 'function' && interaction.isMessageComponent();
  if (isComponent && typeof interaction.update === 'function') {
    try {
      return await interaction.update(payload);
    } catch {
      // Message d'origine indisponible (trop vieux) : on répond proprement.
    }
  }
  return interaction.reply({ ...payload, ephemeral: true }).catch(() => null);
}

function visibilityLabel(doc) {
  return doc.isPublic ? '🌍 Partagée' : '🔒 Privée';
}

// ── Vues ─────────────────────────────────────────────────────────────────────
function buildHomeEmbed(docs, guildName) {
  const lines = docs.length
    ? docs.map(d => {
      const uses = d.usageCount ? ` · ${d.usageCount} utilisation(s)` : '';
      const desc = d.description ? ` — ${d.description}` : '';
      return `**${d.name}** ${visibilityLabel(d)}${uses}\n> ${(d.response || '').split('\n')[0].slice(0, 90)}${desc}`;
    }).join('\n')
    : '*Tu n\'as encore aucune commande personnalisée — clique sur ➕ **Créer**.*';

  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('✨ Mes commandes personnalisées')
    .setDescription(`${docs.length}/${engine.MAX_PER_MEMBER} emplacement(s) utilisé(s)${guildName ? ` sur **${guildName}**` : ''}\n\n${lines}`)
    .addFields({
      name: '🚀 Lancer une commande',
      value: [
        docs.length ? `\`/custom nom:${docs[0].name}\` — avec autocomplétion` : '`/custom nom:ma-commande` — avec autocomplétion',
        docs.length ? `\`b!${docs[0].name}\` — via le préfixe du serveur (si activé)` : '`b!ma-commande` — via le préfixe du serveur (si activé)',
        'Ou clique sur ▶️ **Utiliser** dans le détail d\'une commande.',
      ].join('\n'),
    })
    .setFooter({ text: footer('Commandes personnalisées') });
}

function myCommandOptions(docs) {
  return docs.slice(0, 25).map(d => ({
    label: d.name.slice(0, 100),
    value: d.name.slice(0, 100),
    description: (d.description || (d.isPublic ? 'Partagée' : 'Privée')).slice(0, 100),
    emoji: d.isPublic ? '🌍' : '🔒',
  }));
}

function buildHomeComponents(docs) {
  const rows = [];
  if (docs.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('cus_panel_select')
        .setPlaceholder('Gérer une de mes commandes…')
        .addOptions(myCommandOptions(docs)),
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cus_new').setLabel('Créer').setEmoji('➕').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('cus_list').setLabel('Mes commandes').setEmoji('📚').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cus_explore').setLabel('Partagées').setEmoji('🌍').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cus_help').setLabel('Aide').setEmoji('❔').setStyle(ButtonStyle.Secondary),
  ));
  return rows;
}

function buildActionEmbed(doc) {
  return new EmbedBuilder()
    .setColor(doc.isPublic ? BRAND.colors.success : COLORS.primary)
    .setTitle(`✨ /${doc.name}`)
    .setDescription(doc.response.slice(0, 4000))
    .addFields(
      { name: '👤 Créateur', value: `<@${doc.ownerId}>`, inline: true },
      { name: '🔐 Visibilité', value: visibilityLabel(doc), inline: true },
      { name: '👁️ Réponse', value: doc.ephemeral ? 'Auteur seul' : 'Tout le monde', inline: true },
      { name: '📊 Utilisations', value: String(doc.usageCount || 0), inline: true },
      { name: '📝 Description', value: doc.description || '*aucune*', inline: false },
      ...(doc.allowedRoleIds?.length
        ? [{ name: '🔑 Rôles autorisés', value: doc.allowedRoleIds.map(id => `<@&${id}>`).join(', ').slice(0, 1024), inline: false }]
        : []),
    )
    .setFooter({ text: footer('Commandes personnalisées') });
}

// Le propriétaire (et les administrateurs) voient les boutons de gestion ;
// les autres membres ne peuvent que lancer une commande partagée.
function buildActionComponents(doc, guild, { canManage }) {
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cus_run:${doc.name}`).setLabel('Utiliser').setEmoji('▶️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`cus_run_args:${doc.name}`).setLabel('Avec un texte').setEmoji('⌨️').setStyle(ButtonStyle.Primary),
    ),
  ];

  if (canManage) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cus_edit:${doc.name}`).setLabel('Modifier').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`cus_public:${doc.name}`)
        .setLabel(doc.isPublic ? 'Rendre privée' : 'Partager')
        .setEmoji(doc.isPublic ? '🔒' : '🌍')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`cus_disc:${doc.name}`)
        .setLabel(doc.ephemeral ? 'Réponse publique' : 'Réponse discrète')
        .setEmoji(doc.ephemeral ? '🔊' : '🤫')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cus_delete:${doc.name}`).setLabel('Supprimer').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('cus_back').setLabel('Retour').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
    ));

    // Restriction d'accès : utile pour une commande partagée réservée à
    // quelques rôles. Vide = tout le monde (tant qu'elle est partagée).
    const select = new RoleSelectMenuBuilder()
      .setCustomId(`cus_roles:${doc.name}`)
      .setPlaceholder(doc.allowedRoleIds?.length
        ? 'Rôles autorisés — retire-les tous pour ouvrir à tout le monde'
        : 'Limiter à certains rôles (facultatif)')
      .setMinValues(0)
      .setMaxValues(10);
    const known = (doc.allowedRoleIds || []).filter(id => guild?.roles?.cache?.has?.(id));
    if (known.length) select.setDefaultRoles(...known);
    rows.push(new ActionRowBuilder().addComponents(select));
  } else {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cus_back').setLabel('Retour').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
    ));
  }

  return rows;
}

function confirmComponents(doc) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cus_del_ok:${doc.name}`).setLabel('Oui, supprimer').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('cus_back').setLabel('Annuler').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildListEmbed({ mine, shared, total }) {
  const fmt = (d, withAuthor) => `**${d.name}**${withAuthor ? ` <@${d.ownerId}>` : ''} — ${(d.description || 'sans description').slice(0, 60)}${d.usageCount ? ` · ${d.usageCount}×` : ''}`;
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('📚 Commandes personnalisées du serveur')
    .setDescription(`${total} commande(s) au total — ${mine.length} à toi.`)
    .addFields(
      { name: '🔒 Les tiennes', value: mine.length ? mine.map(d => fmt(d, false)).join('\n').slice(0, 1024) : '*aucune*' },
      { name: '🌍 Partagées par les autres', value: shared.length ? shared.slice(0, 15).map(d => fmt(d, true)).join('\n').slice(0, 1024) : '*aucune*' },
    )
    .setFooter({ text: footer('Commandes personnalisées') });
}

function buildHelpEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('❔ Commandes personnalisées — aide')
    .setDescription([
      'Discord n\'autorise pas une commande slash par membre (100 commandes **globales** maximum pour tout le bot). REZO contourne la limite : tes commandes sont stockées par serveur et lancées à la demande — **une seule commande à connaître : `/custom`**.',
      '',
      '**Gérer** — `/custom` ouvre le panneau : créer, modifier, partager, restreindre à des rôles, supprimer.',
      '**Lancer** — `/custom nom:regles texte:…` (autocomplétion) ou `b!regles texte…` si le préfixe du serveur est activé (`/prefix`).',
      '**Partager** — une commande partagée est utilisable par tous les membres ; le menu **rôles** du panneau permet de la réserver à certains rôles.',
      '**Discret** — la réponse n\'est visible que par celui qui lance la commande.',
    ].join('\n'))
    .addFields({
      name: '🧩 Variables disponibles',
      value: engine.PLACEHOLDERS.map(p => `\`${p.key}\` — ${p.hint}`).join('\n'),
    })
    .addFields({
      name: '📊 Limites',
      value: [
        `• \`${engine.MAX_PER_MEMBER}\` commandes par membre, \`${engine.MAX_PER_GUILD}\` par serveur`,
        `• nom : 1 à ${engine.MAX_NAME_LENGTH} caractères (\`a-z\`, \`0-9\`, \`-\`, \`_\`), unique sur le serveur`,
        `• texte : ${engine.MAX_RESPONSE} caractères maximum · anti-spam : une utilisation toutes les 2,5 s`,
      ].join('\n'),
    })
    .setFooter({ text: footer('Commandes personnalisées') });
}

// ── Flows ────────────────────────────────────────────────────────────────────
async function sendHome(interaction, payload = null) {
  const docs = (await engine.listCustomCommands(interaction.guildId, interaction.user.id)).mine;
  const body = payload || { embeds: [buildHomeEmbed(docs, interaction.guild?.name)] };
  return show(interaction, { ...body, components: buildHomeComponents(docs) });
}

async function runCommand(interaction, doc, args) {
  const run = await engine.runCustomCommand({
    doc,
    userId: interaction.user.id,
    username: userName(interaction.user),
    displayName: displayNameOf(interaction.user, interaction.member),
    memberRoleIds: memberRoleIds(interaction),
    guildName: interaction.guild?.name,
    channelId: interaction.channelId,
    args: args ?? '',
  });
  if (!run.ok) {
    return interaction.reply({ embeds: [errorEmbed('Commande bloquée', run.message)], ephemeral: true }).catch(() => null);
  }
  return interaction.reply({ ...run.payload, ephemeral: run.ephemeral }).catch(() => null);
}

async function fetchForAction(interaction, name) {
  const doc = await engine.getByName(interaction.guildId, name);
  if (!doc) return { error: `Aucune commande \`${name}\` sur ce serveur.` };
  const canManage = doc.ownerId === interaction.user.id || isManager(interaction);
  return { doc, canManage };
}

async function showAction(interaction, name) {
  const found = await fetchForAction(interaction, name);
  if (found.error) {
    const docs = (await engine.listCustomCommands(interaction.guildId, interaction.user.id)).mine;
    return show(interaction, {
      embeds: [errorEmbed('Commande introuvable', found.error), buildHomeEmbed(docs, interaction.guild?.name)],
      components: buildHomeComponents(docs),
    });
  }
  return show(interaction, {
    embeds: [buildActionEmbed(found.doc)],
    components: buildActionComponents(found.doc, interaction.guild, { canManage: found.canManage }),
  });
}

async function createAndReport(interaction, client, { name, response, description, isPublic, ephemeral }) {
  const res = await engine.createCustomCommand({
    guildId: interaction.guildId,
    ownerId: interaction.user.id,
    name, response, description, isPublic, ephemeral,
    reserved: reservedNames(client),
  });

  if (!res.ok) {
    return interaction.reply({ embeds: [errorEmbed('Création impossible', res.message)], ephemeral: true }).catch(() => null);
  }

  return interaction.reply({
    embeds: [successEmbed(`Commande \`${res.doc.name}\` créée`, [
      `**Lancer ici** — \`/custom nom:${res.doc.name}\` (ou ▶️ Utiliser depuis \`/custom\`)`,
      `**Lancer au préfixe** — \`b!${res.doc.name}\` (si le serveur a activé un préfixe via \`/prefix\`)`,
      '',
      res.doc.isPublic ? '🌍 Elle est **partagée** : tout le monde peut l\'utiliser.' : '🔒 Elle est **privée** : toi seul peux l\'utiliser.',
      'Tout se règle dans `/custom` : rôles, mode discret, partage, suppression.',
    ].join('\n'))],
    ephemeral: true,
  }).catch(() => null);
}

// ── Commande ─────────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('custom')
    .setDescription('✨ Tes commandes personnalisées : tout se gère et se lance ici')
    .addStringOption(o => o
      .setName('nom')
      .setDescription('Lancer une commande (laisser vide = ouvrir le panneau de gestion)')
      .setAutocomplete(true))
    .addStringOption(o => o
      .setName('texte')
      .setDescription('Texte transmis à la variable {args}')
      .setMaxLength(1000)),

  async execute(interaction, client) {
    if (!interaction.guildId) {
      return interaction.reply({ embeds: [errorEmbed('Serveur requis', 'Les commandes personnalisées s\'utilisent uniquement sur un serveur.')], ephemeral: true });
    }

    const nom = interaction.options.getString('nom');
    const texte = interaction.options.getString('texte') ?? '';

    // Sans nom → le panneau unique qui gère tout.
    if (!nom) {
      const docs = (await engine.listCustomCommands(interaction.guildId, interaction.user.id)).mine;
      return interaction.reply({
        embeds: [buildHomeEmbed(docs, interaction.guild?.name)],
        components: buildHomeComponents(docs),
        ephemeral: true,
      });
    }

    // Avec un nom → lancement direct (autocomplétion), comme le préfixe.
    const res = await engine.getForUse({
      guildId: interaction.guildId,
      name: nom,
      userId: interaction.user.id,
      memberRoleIds: memberRoleIds(interaction),
    });
    if (!res.ok) {
      const key = engine.normalizeName(nom);
      const mine = (await engine.listCustomCommands(interaction.guildId, interaction.user.id)).mine.find(d => d.name === key);
      // Commande à soi mais bloquée (désactivée/cooldown) : on explique.
      // Sinon on ouvre le panneau pour la créer.
      if (!mine) {
        return interaction.reply({
          embeds: [errorEmbed('Commande introuvable', `${res.message}\nTu peux la créer depuis ce panneau 👇`)],
          components: buildHomeComponents([]),
          ephemeral: true,
        });
      }
      return interaction.reply({ embeds: [errorEmbed('Commande indisponible', res.message)], ephemeral: true });
    }

    return runCommand(interaction, res.doc, texte);
  },

  // ── Autocomplétion du nom ─────────────────────────────────────────────────
  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    try {
      if (focused.name !== 'nom' || !interaction.guildId) return await interaction.respond([]);
      const choices = await engine.autocompleteFor(interaction.guildId, interaction.user.id, focused.value);
      return await interaction.respond(choices);
    } catch {
      try { return await interaction.respond([]); } catch { /* interaction expirée */ }
    }
  },

  // ── Boutons du panneau ────────────────────────────────────────────────────
  async handleButton(interaction, client) {
    const id = interaction.customId;
    const userId = interaction.user.id;
    const guildId = interaction.guildId;

    // Créer (modale)
    if (id === 'cus_new') {
      const modal = new ModalBuilder().setCustomId('cusm_new').setTitle('➕ Nouvelle commande personnalisée');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('cus_name').setLabel('Nom (a-z, 0-9, - _)')
            .setStyle(TextInputStyle.Short).setMaxLength(engine.MAX_NAME_LENGTH).setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('cus_desc').setLabel('Description (facultatif)')
            .setStyle(TextInputStyle.Short).setMaxLength(engine.MAX_DESCRIPTION).setRequired(false),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('cus_text').setLabel('Réponse ({user}, {args}, {server}…)')
            .setStyle(TextInputStyle.Paragraph).setMaxLength(engine.MAX_RESPONSE).setRequired(true),
        ),
      );
      return interaction.showModal(modal).catch(() => null);
    }

    if (id === 'cus_help') {
      return interaction.reply({ embeds: [buildHelpEmbed()], ephemeral: true }).catch(() => null);
    }

    if (id === 'cus_back') {
      return sendHome(interaction);
    }

    if (id === 'cus_list') {
      const data = await engine.listCustomCommands(guildId, userId);
      return show(interaction, { embeds: [buildListEmbed(data)], components: buildHomeComponents(data.mine) });
    }

    // Explorer les commandes partagées par les autres membres
    if (id === 'cus_explore') {
      const shared = (await engine.listCustomCommands(guildId, userId)).shared;
      const rows = [];
      if (shared.length) {
        rows.push(new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('cus_explore_select')
            .setPlaceholder('Voir une commande partagée…')
            .addOptions(shared.slice(0, 25).map(d => ({
              label: d.name.slice(0, 100),
              value: d.name.slice(0, 100),
              description: `${(d.description || 'Partagée par un membre').slice(0, 90)}`,
              emoji: '🌍',
            }))),
        ));
      }
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cus_back').setLabel('Retour').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
      ));
      return show(interaction, {
        embeds: [new EmbedBuilder()
          .setColor(COLORS.info)
          .setTitle('🌍 Commandes partagées du serveur')
          .setDescription(shared.length
            ? shared.map(d => `**${d.name}** <@${d.ownerId}> — ${(d.description || 'sans description').slice(0, 70)}`).join('\n').slice(0, 3800)
            : '*Aucune commande partagée pour l\'instant.* Crée la tienne avec ➕ **Créer**, puis partage-la.')],
        components: rows,
      });
    }

    const [action, ...rest] = id.split(':');
    const name = engine.normalizeName(rest.join(':'));

    // ── Lancer une commande depuis le panneau ────────────────────────────────
    if (action === 'cus_run') {
      const res = await engine.getForUse({ guildId, name, userId, memberRoleIds: memberRoleIds(interaction) });
      if (!res.ok) return interaction.reply({ embeds: [errorEmbed('Commande indisponible', res.message)], ephemeral: true }).catch(() => null);
      return runCommand(interaction, res.doc, '');
    }

    // Lancer avec un texte libre ({args}) : modale, pour garder une seule commande.
    if (action === 'cus_run_args') {
      const res = await engine.getForUse({ guildId, name, userId, memberRoleIds: memberRoleIds(interaction) });
      if (!res.ok) return interaction.reply({ embeds: [errorEmbed('Commande indisponible', res.message)], ephemeral: true }).catch(() => null);
      const modal = new ModalBuilder().setCustomId(`cusm_run:${res.doc.name}`).setTitle(`▶️ Lancer ${res.doc.name}`.slice(0, 45));
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('cus_args').setLabel('Texte ({args})')
            .setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(false),
        ),
      );
      return interaction.showModal(modal).catch(() => null);
    }

    const found = await fetchForAction(interaction, name);
    if (found.error) return interaction.reply({ embeds: [errorEmbed('Commande introuvable', found.error)], ephemeral: true }).catch(() => null);
    const { doc, canManage } = found;

    if (!canManage) {
      return interaction.reply({
        embeds: [errorEmbed('Action réservée', `\`${doc.name}\` appartient à <@${doc.ownerId}>.`)],
        ephemeral: true,
      }).catch(() => null);
    }

    // Modifier (modale pré-remplie)
    if (action === 'cus_edit') {
      const modal = new ModalBuilder().setCustomId(`cusm_edit:${doc.name}`).setTitle(`✏️ Modifier ${doc.name}`.slice(0, 45));
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('cus_desc').setLabel('Description')
            .setStyle(TextInputStyle.Short).setMaxLength(engine.MAX_DESCRIPTION).setValue(doc.description || '').setRequired(false),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('cus_text').setLabel('Réponse ({user}, {args}, {server}…)')
            .setStyle(TextInputStyle.Paragraph).setMaxLength(engine.MAX_RESPONSE).setValue(doc.response || '').setRequired(true),
        ),
      );
      return interaction.showModal(modal).catch(() => null);
    }

    // Basculer le partage
    if (action === 'cus_public') {
      const res = await engine.updateCustomCommand({
        guildId, userId, name, patch: { isPublic: !doc.isPublic }, isManager: isManager(interaction),
      });
      if (!res.ok) return interaction.reply({ embeds: [errorEmbed('Modification impossible', res.message)], ephemeral: true }).catch(() => null);
      return showAction(interaction, res.doc.name);
    }

    // Basculer le mode discret (réponse visible par le lanceur seulement)
    if (action === 'cus_disc') {
      const res = await engine.updateCustomCommand({
        guildId, userId, name, patch: { ephemeral: !doc.ephemeral }, isManager: isManager(interaction),
      });
      if (!res.ok) return interaction.reply({ embeds: [errorEmbed('Modification impossible', res.message)], ephemeral: true }).catch(() => null);
      return showAction(interaction, res.doc.name);
    }

    // Demander confirmation de suppression
    if (action === 'cus_delete') {
      return show(interaction, {
        embeds: [new EmbedBuilder()
          .setColor(COLORS.warning)
          .setTitle(`🗑️ Supprimer \`${doc.name}\` ?`)
          .setDescription('Cette action est définitive. Les membres perdront immédiatement l\'accès.')],
        components: confirmComponents(doc),
      });
    }

    // Suppression confirmée
    if (action === 'cus_del_ok') {
      const res = await engine.deleteCustomCommand({ guildId, userId, name, isManager: isManager(interaction) });
      const docs = (await engine.listCustomCommands(guildId, userId)).mine;
      if (!res.ok) {
        return show(interaction, {
          embeds: [errorEmbed('Suppression impossible', res.message), buildHomeEmbed(docs, interaction.guild?.name)],
          components: buildHomeComponents(docs),
        });
      }
      return show(interaction, {
        embeds: [
          successEmbed(`\`${res.doc.name}\` supprimée`, 'Elle ne répondra plus.'),
          buildHomeEmbed(docs, interaction.guild?.name),
        ],
        components: buildHomeComponents(docs),
      });
    }
  },

  // ── Menus déroulants ──────────────────────────────────────────────────────
  async handleSelect(interaction, client) {
    const id = interaction.customId;

    // Restriction d'accès par rôles
    if (id.startsWith('cus_roles:')) {
      const name = engine.normalizeName(id.slice('cus_roles:'.length));
      const res = await engine.updateCustomCommand({
        guildId: interaction.guildId,
        userId: interaction.user.id,
        name,
        patch: { allowedRoleIds: Array.isArray(interaction.values) ? interaction.values : [] },
        isManager: isManager(interaction),
      });
      if (!res.ok) return show(interaction, { embeds: [errorEmbed('Modification impossible', res.message)] });
      const allowed = (res.doc.allowedRoleIds || []).length;
      return show(interaction, {
        embeds: [
          allowed
            ? successEmbed('Accès restreint', `\`${res.doc.name}\` est désormais réservée à ${res.doc.allowedRoleIds.map(r => `<@&${r}>`).join(', ')}.`)
            : successEmbed('Accès ouvert', `\`${res.doc.name}\` n'est plus limitée par des rôles.`),
          buildActionEmbed(res.doc),
        ],
        components: buildActionComponents(res.doc, interaction.guild, { canManage: true }),
      });
    }

    if (id !== 'cus_panel_select' && id !== 'cus_explore_select') return;
    const name = engine.normalizeName(interaction.values?.[0]);
    return showAction(interaction, name);
  },

  // ── Modales (création / modification / lancement avec texte) ──────────────
  async handleModal(interaction, client) {
    const id = interaction.customId;
    const userId = interaction.user.id;
    const guildId = interaction.guildId;

    if (id === 'cusm_new') {
      return createAndReport(interaction, client, {
        name: interaction.fields.getTextInputValue('cus_name'),
        description: interaction.fields.getTextInputValue('cus_desc') || '',
        response: interaction.fields.getTextInputValue('cus_text'),
        isPublic: false,
        ephemeral: false,
      });
    }

    if (id.startsWith('cusm_run:')) {
      const name = engine.normalizeName(id.slice('cusm_run:'.length));
      const res = await engine.getForUse({ guildId, name, userId, memberRoleIds: memberRoleIds(interaction) });
      if (!res.ok) return interaction.reply({ embeds: [errorEmbed('Commande indisponible', res.message)], ephemeral: true }).catch(() => null);
      return runCommand(interaction, res.doc, interaction.fields.getTextInputValue('cus_args') || '');
    }

    if (id.startsWith('cusm_edit:')) {
      const name = engine.normalizeName(id.slice('cusm_edit:'.length));
      const res = await engine.updateCustomCommand({
        guildId,
        userId,
        name,
        patch: {
          description: interaction.fields.getTextInputValue('cus_desc') ?? '',
          response: interaction.fields.getTextInputValue('cus_text') ?? '',
        },
        isManager: isManager(interaction),
        reserved: reservedNames(client),
      });
      if (!res.ok) return interaction.reply({ embeds: [errorEmbed('Modification impossible', res.message)], ephemeral: true }).catch(() => null);

      return interaction.reply({
        embeds: [successEmbed(`\`${res.doc.name}\` mise à jour`, 'La nouvelle réponse est active.'), buildActionEmbed(res.doc)],
        components: buildActionComponents(res.doc, interaction.guild, { canManage: true }),
        ephemeral: true,
      }).catch(() => null);
    }
  },
};
