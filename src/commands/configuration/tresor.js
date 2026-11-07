// commands/tresor.js — Panneau du module « Trésors cachés ».
//
// Un coffre apparaît au hasard dans un salon de chasse ; des indices tombent au
// fil du temps ; le premier membre qui tape le mot exact l'ouvre et remporte des
// pièces, de l'XP, et un rôle bonus s'il était légendaire.
//
// Tout se règle ici : salons, rythme, durée de vie, indices, récompenses,
// raretés, banque de mots et classement des chasseurs.
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const {
  getOrCreateConfig, spawnHunt, closeHunt, publishLeaderboard, resetHunter,
  topHunters, activeHuntOf,
} = require('../../utils/treasureEngine');
const {
  buildTreasurePanel, buildTreasureModal, applyTreasureOption, applyTreasureModal,
  pageForKey, describeTreasure,
} = require('../../utils/treasurePanel');
const { errorEmbed, COLORS } = require('../../utils/embeds');
const { RARITY_EMOJI } = require('../../utils/treasureWords');

const HELP_TEXT = [
  'Un **coffre** apparaît tout seul dans un salon de chasse (jamais deux à la fois).',
  '',
  '1. Le coffre s\'annonce avec son **premier indice** ; les suivants tombent un par un selon l\'intervalle réglé.',
  '2. Les membres **tapent directement le mot** dans le salon du coffre. Aucune commande à connaître.',
  `3. Le premier qui trouve l'ouvre et remporte la récompense. Trois raretés : ${RARITY_EMOJI.common} commune, ${RARITY_EMOJI.rare} rare, ${RARITY_EMOJI.legendary} légendaire (×1, ×2 et ×4 sur la mise).`,
  '4. Personne ne trouve ? Le coffre se referme tout seul et le mot est révélé.',
  '',
  'À éviter : un salon de chasse en lecture seule (les membres doivent pouvoir écrire), ou des indices très espacés sur une durée de vie courte.',
].join('\n');

/** Embed du bouton « Comment ça marche ». */
function helpEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('❔ Trésors cachés — mode d\'emploi')
    .setDescription(HELP_TEXT.slice(0, 3900))
    .setFooter({ text: 'REZO • Trésors cachés' });
}

/** Payload du panneau : coffre en cours, et classement sur la page Chasseurs. */
async function panelPayload(interaction, cfg, { notice = null, page = 'home' } = {}) {
  const hunt = await activeHuntOf(interaction.guild.id);
  const hunters = page === 'hunters' ? await topHunters(interaction.guild.id, 10) : [];
  // Noms des salons pour les menus déroulants (les mentions n'y sont pas permises).
  const channelNames = {};
  for (const id of cfg.channels || []) {
    const channel = interaction.guild?.channels?.cache?.get?.(id);
    if (channel?.name) channelNames[id] = channel.name;
  }
  const { embed, components } = buildTreasurePanel(cfg, { notice, page, hunt, hunters, channelNames, now: Date.now() });
  return { embeds: [embed], components };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('tresor')
    .setDescription('🎁 Trésors cachés — un coffre à deviner par vos membres')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  HELP_TEXT,
  describe: describeTreasure,
  panelPayload,

  async execute(interaction, client) {
    let cfg = await getOrCreateConfig(interaction.guild.id);

    const reply = await interaction.reply({
      ...(await panelPayload(interaction, cfg)),
      ephemeral: true,
      fetchReply: true,
    });

    const col = reply.createMessageComponentCollector({
      filter: i => i.user.id === interaction.user.id,
      time: 15 * 60 * 1000,
    });

    col.on('collect', async i => {
      // Toutes les interactions du panneau : trs_btn_* et trs_sel_*
      // (la clé conserve son préfixe : c'est elle qui identifie l'option)
      const key = String(i.customId || '').replace(/^trs_/, '');
      cfg = await getOrCreateConfig(interaction.guild.id);

      const res = applyTreasureOption(cfg, key, i.values || []);
      const page = res.action?.page || pageForKey(key);

      if (res.action && typeof res.action === 'object' && res.action.modal) {
        const modal = buildTreasureModal(cfg, res.action.modal);
        if (modal) return i.showModal(modal);
      }

      if (res.action === 'spawnNow') {
        if (!cfg.channels.length) {
          return i.update(await panelPayload(i, cfg, { notice: '⚠️ Ajoute d\'abord un **salon de chasse** (page 💬 Salons).' }));
        }
        if (await activeHuntOf(interaction.guild.id)) {
          return i.update(await panelPayload(i, cfg, { notice: '⚠️ Un coffre est déjà ouvert : ferme-le d\'abord pour le relancer.' }));
        }
        const spawned = await spawnHunt({ guild: interaction.guild, cfg }).catch(err => {
          console.error('❌ Trésor (lancement manuel):', err.message);
          return null;
        });
        return i.update(await panelPayload(i, cfg, {
          notice: spawned
            ? `🚀 Coffre lancé dans <#${spawned.hunt.channelId}> — mot à deviner : \`${spawned.hunt.word}\` (visible par toi seul ici).`
            : '❌ Lancement impossible : vérifie que le bot peut écrire dans le salon de chasse.',
        }));
      }

      if (res.action === 'closeHunt') {
        const hunt = await activeHuntOf(interaction.guild.id);
        if (!hunt) {
          return i.update(await panelPayload(i, cfg, { notice: 'Aucun coffre ouvert pour le moment.' }));
        }
        await closeHunt(client, cfg, hunt, 'expired', { guild: interaction.guild });
        return i.update(await panelPayload(i, cfg, { notice: `🛑 Coffre refermé — le mot était \`${hunt.word}\`.` }));
      }

      if (res.action === 'publishLeaderboard') {
        const sent = await publishLeaderboard(i.channel, interaction.guild.id, interaction.guild.name);
        return i.update(await panelPayload(i, cfg, {
          notice: sent ? '📣 Classement publié dans ce salon.' : '⚠️ Je n\'ai pas la permission d\'écrire ici.',
          page: 'hunters',
        }));
      }

      if (res.action === 'resetHunter') {
        await resetHunter(interaction.guild.id, i.values[0]);
        return i.update(await panelPayload(i, cfg, {
          notice: `🔄 Fiche de <@${i.values[0]}> réinitialisée.`,
          page: 'hunters',
        }));
      }

      if (res.action === 'help') {
        return i.followUp({ embeds: [helpEmbed()], ephemeral: true }).catch(() => {});
      }

      if (res.patch) {
        Object.assign(cfg, res.patch);
        await cfg.save();
      }

      return i.update(await panelPayload(i, cfg, { notice: res.notice, page }));
    });

    col.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
  },

  // ─── Modaux (routés depuis interactionCreate.js) ──────────────────────────
  async handleModal(interaction) {
    const id = String(interaction.customId || '');
    if (!id.startsWith('trs_modal_')) return;
    const key = id.slice('trs_modal_'.length);

    const cfg = await getOrCreateConfig(interaction.guild.id);
    const res = applyTreasureModal(cfg, key, interaction.fields);
    if (res.error) {
      return interaction.reply({ embeds: [errorEmbed('Valeur invalide', res.error)], ephemeral: true }).catch(() => {});
    }

    Object.assign(cfg, res.patch);
    await cfg.save();

    const payload = await panelPayload(interaction, cfg, { notice: res.notice, page: pageForKey(key) });

    if (interaction.message) {
      try {
        await interaction.message.edit(payload);
        return interaction.reply({ content: res.notice || '✅ Enregistré.', ephemeral: true }).catch(() => {});
      } catch { /* panneau expiré : on en renvoie un neuf */ }
    }
    return interaction.reply({ ...payload, ephemeral: true });
  },
};
