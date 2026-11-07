// commands/boost.js — Panel unique de configuration du message de boost
const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  PermissionFlagsBits, ChannelType,
} = require('discord.js');
const BoostConfig = require('../../models/BoostConfig');
const { buildBoostEmbed, sendBoostMessage } = require('../../utils/boostManager');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');

async function getOrCreate(guildId) {
  let cfg = await BoostConfig.findOne({ guildId });
  if (!cfg) cfg = await BoostConfig.create({ guildId });
  return cfg;
}

function buildPanelEmbed(cfg) {
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('💎 Boost — Panel de configuration')
    .setDescription("Message envoyé automatiquement quand un membre booste le serveur.\nPlaceholders : `{user}` `{mention}` `{server}` `{boostcount}` `{level}` `{membercount}`")
    .addFields(
      { name: 'État', value: cfg.enabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
      { name: 'Salon', value: cfg.channelId ? `<#${cfg.channelId}>` : '*Salon système (défaut)*', inline: true },
      { name: 'Couleur', value: cfg.color, inline: true },
      { name: 'Rôle booster (bonus)', value: cfg.boosterRoleId ? `<@&${cfg.boosterRoleId}>` : '*Aucun*', inline: true },
      { name: 'Rôle mentionné', value: cfg.pingRoleId ? `<@&${cfg.pingRoleId}>` : '*Aucun*', inline: true },
      { name: 'Image', value: cfg.imageUrl ? '✅ Définie' : '*Aucune*', inline: true },
      { name: 'Titre', value: cfg.title || '*vide*', inline: false },
      { name: 'Description', value: (cfg.description || '*vide*').slice(0, 500), inline: false },
    )
    .setFooter({ text: 'REZO • Boost' })
    .setTimestamp();
}

function buildPanelComponents() {
  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bst_toggle').setLabel('🔛 Activer / Désactiver').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('bst_channel').setLabel('# Salon').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('bst_message').setLabel('✏️ Message').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('bst_appearance').setLabel('🎨 Apparence').setStyle(ButtonStyle.Secondary),
  );
  const r2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bst_roles').setLabel('🎭 Rôles').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bst_test').setLabel('🧪 Tester').setStyle(ButtonStyle.Secondary),
  );
  return [r1, r2];
}

module.exports = {
  getOrCreate,

  data: new SlashCommandBuilder()
    .setName('boost')
    .setDescription('💎 Configurer le message envoyé quand un membre booste le serveur')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    let cfg = await getOrCreate(interaction.guild.id);

    const reply = await interaction.reply({
      embeds: [buildPanelEmbed(cfg)],
      components: buildPanelComponents(),
      ephemeral: true,
      fetchReply: true,
    });

    const col = reply.createMessageComponentCollector({
      filter: i => i.user.id === interaction.user.id,
      time: 15 * 60 * 1000,
    });

    const refresh = async (i) => {
      cfg = await getOrCreate(interaction.guild.id);
      return i.update({ embeds: [buildPanelEmbed(cfg)], components: buildPanelComponents() });
    };

    const backRow = () => new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('bst_back').setLabel('← Retour').setStyle(ButtonStyle.Secondary),
    );

    col.on('collect', async i => {
      cfg = await getOrCreate(interaction.guild.id);

      if (i.customId === 'bst_toggle') {
        cfg.enabled = !cfg.enabled;
        await cfg.save();
        return refresh(i);
      }

      if (i.customId === 'bst_channel') {
        return i.update({
          embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('# Salon d\'annonce')
            .setDescription(`Actuel : ${cfg.channelId ? `<#${cfg.channelId}>` : '*Salon système (défaut)*'}`)],
          components: [
            new ActionRowBuilder().addComponents(
              new ChannelSelectMenuBuilder().setCustomId('bst_channel_select').setPlaceholder('Choisir un salon…').addChannelTypes(ChannelType.GuildText),
            ),
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('bst_channel_clear').setLabel('Salon système (défaut)').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId('bst_back').setLabel('← Retour').setStyle(ButtonStyle.Secondary),
            ),
          ],
        });
      }
      if (i.customId === 'bst_channel_select') { cfg.channelId = i.values[0]; await cfg.save(); return refresh(i); }
      if (i.customId === 'bst_channel_clear')  { cfg.channelId = null;        await cfg.save(); return refresh(i); }

      if (i.customId === 'bst_message') {
        const modal = new ModalBuilder().setCustomId('bst_message_modal').setTitle('✏️ Message de boost');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bst_title').setLabel('Titre').setStyle(TextInputStyle.Short).setValue(cfg.title).setMaxLength(256).setRequired(false)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bst_desc').setLabel('Description — {user} {server} {boostcount}').setStyle(TextInputStyle.Paragraph).setValue(cfg.description).setMaxLength(1000).setRequired(false)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bst_footer').setLabel('Texte du pied de page').setStyle(TextInputStyle.Short).setValue(cfg.footerText || '').setMaxLength(256).setRequired(false)),
        );
        return i.showModal(modal);
      }

      if (i.customId === 'bst_appearance') {
        return i.update({
          embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('🎨 Apparence')
            .setDescription(`Couleur actuelle : **${cfg.color}**\nImage : ${cfg.imageUrl ? '✅ Définie' : '*Aucune*'}\nVignette : ${cfg.useAvatar ? 'Avatar du booster' : cfg.useServerIcon ? 'Icône du serveur' : 'Aucune'}`)],
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('bst_color_modal').setLabel('🎨 Couleur').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId('bst_image_modal').setLabel('🖼️ Image').setStyle(ButtonStyle.Secondary),
            ),
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('bst_thumb_avatar').setLabel('Vignette : Avatar').setStyle(cfg.useAvatar ? ButtonStyle.Success : ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId('bst_thumb_icon').setLabel('Vignette : Icône serveur').setStyle(cfg.useServerIcon ? ButtonStyle.Success : ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId('bst_thumb_none').setLabel('Vignette : Aucune').setStyle((!cfg.useAvatar && !cfg.useServerIcon) ? ButtonStyle.Success : ButtonStyle.Secondary),
            ),
            backRow(),
          ],
        });
      }
      if (i.customId === 'bst_color_modal') {
        const modal = new ModalBuilder().setCustomId('bst_color_modal_submit').setTitle('🎨 Couleur');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('bst_hex').setLabel('Couleur hexadécimale (ex: #F47FFF)').setStyle(TextInputStyle.Short).setValue(cfg.color).setRequired(true),
        ));
        return i.showModal(modal);
      }
      if (i.customId === 'bst_image_modal') {
        const modal = new ModalBuilder().setCustomId('bst_image_modal_submit').setTitle('🖼️ Image de la bannière');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('bst_url').setLabel('URL de l\'image (laisser vide pour retirer)').setStyle(TextInputStyle.Short).setValue(cfg.imageUrl || '').setRequired(false),
        ));
        return i.showModal(modal);
      }
      if (i.customId === 'bst_thumb_avatar') { cfg.useAvatar = true;  cfg.useServerIcon = false; await cfg.save(); return refresh(i); }
      if (i.customId === 'bst_thumb_icon')   { cfg.useAvatar = false; cfg.useServerIcon = true;  await cfg.save(); return refresh(i); }
      if (i.customId === 'bst_thumb_none')   { cfg.useAvatar = false; cfg.useServerIcon = false; await cfg.save(); return refresh(i); }

      if (i.customId === 'bst_roles') {
        return i.update({
          embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('🎭 Rôles')
            .setDescription(`Rôle booster (bonus auto) : ${cfg.boosterRoleId ? `<@&${cfg.boosterRoleId}>` : '*Aucun*'}\nRôle mentionné dans l'annonce : ${cfg.pingRoleId ? `<@&${cfg.pingRoleId}>` : '*Aucun*'}`)],
          components: [
            new ActionRowBuilder().addComponents(
              new RoleSelectMenuBuilder().setCustomId('bst_role_booster').setPlaceholder('🎁 Rôle bonus attribué aux boosters…'),
            ),
            new ActionRowBuilder().addComponents(
              new RoleSelectMenuBuilder().setCustomId('bst_role_ping').setPlaceholder('📢 Rôle à mentionner (optionnel)…'),
            ),
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('bst_role_booster_clear').setLabel('Retirer rôle booster').setStyle(ButtonStyle.Danger),
              new ButtonBuilder().setCustomId('bst_role_ping_clear').setLabel('Retirer rôle mentionné').setStyle(ButtonStyle.Danger),
              new ButtonBuilder().setCustomId('bst_back').setLabel('← Retour').setStyle(ButtonStyle.Secondary),
            ),
          ],
        });
      }
      if (i.customId === 'bst_role_booster') { cfg.boosterRoleId = i.values[0]; await cfg.save(); return refresh(i); }
      if (i.customId === 'bst_role_ping')    { cfg.pingRoleId = i.values[0];    await cfg.save(); return refresh(i); }
      if (i.customId === 'bst_role_booster_clear') { cfg.boosterRoleId = null; await cfg.save(); return refresh(i); }
      if (i.customId === 'bst_role_ping_clear')    { cfg.pingRoleId = null;    await cfg.save(); return refresh(i); }

      if (i.customId === 'bst_test') {
        const embed = buildBoostEmbed(interaction.member, cfg);
        return i.reply({ content: '🧪 **Aperçu** (pas réellement envoyé dans le salon, et aucun rôle n\'a été attribué) :', embeds: [embed], ephemeral: true });
      }

      if (i.customId === 'bst_back') return refresh(i);
    });

    col.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
  },

  async handleMessageModal(interaction) {
    const cfg = await getOrCreate(interaction.guild.id);
    cfg.title = interaction.fields.getTextInputValue('bst_title') || '';
    cfg.description = interaction.fields.getTextInputValue('bst_desc') || '';
    cfg.footerText = interaction.fields.getTextInputValue('bst_footer') || '';
    await cfg.save();
    return interaction.reply({ embeds: [successEmbed('Message mis à jour', 'Le titre, la description et le pied de page ont été enregistrés.')], ephemeral: true });
  },

  async handleColorModal(interaction) {
    const cfg = await getOrCreate(interaction.guild.id);
    let hex = interaction.fields.getTextInputValue('bst_hex').trim();
    if (!/^#?[0-9a-fA-F]{6}$/.test(hex)) {
      return interaction.reply({ embeds: [errorEmbed('Couleur invalide', 'Utilise un format hexadécimal, ex: #F47FFF')], ephemeral: true });
    }
    if (!hex.startsWith('#')) hex = `#${hex}`;
    cfg.color = hex;
    await cfg.save();
    return interaction.reply({ embeds: [successEmbed('Couleur mise à jour', hex)], ephemeral: true });
  },

  async handleImageModal(interaction) {
    const cfg = await getOrCreate(interaction.guild.id);
    const url = interaction.fields.getTextInputValue('bst_url').trim();
    if (url && !/^https?:\/\/.+\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(url)) {
      return interaction.reply({ embeds: [errorEmbed('URL invalide', 'Utilise un lien direct vers une image (.png, .jpg, .gif, .webp).')], ephemeral: true });
    }
    cfg.imageUrl = url || null;
    await cfg.save();
    return interaction.reply({ embeds: [successEmbed(url ? 'Image mise à jour' : 'Image retirée', url || 'Aucune image.')], ephemeral: true });
  },
};
