// commands/topserveurs.js — Classement des serveurs du réseau REZO

const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
} = require('discord.js');

const Server = require('../../models/Server');
const { COLORS, errorEmbed } = require('../../utils/embeds');
const { computeScore, BUMP_COOLDOWN_MS } = require('../../utils/bumpNetwork');

const PAGE_SIZE = 5;
const MEDALS = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];

async function buildTopEmbed(client, page, filter, guild) {
    const query = {
        bumpCount: { $gt: 0 },
        blacklisted: false
    };

    if (filter === 'featured') {
        query.featured = true;
        query.featuredUntil = { $gt: new Date() };
    }

    if (filter === 'weekly') {
        query.weeklyBumps = { $gt: 0 };
    }

    if (filter === 'nsfw') {
        query.nsfw = true;
    } else if (filter !== 'all') {
        query.nsfw = { $ne: true };
    }

    const allServers = await Server.find(query).lean();

    const sortKey =
        filter === 'weekly' ? 'weeklyBumps' :
        filter === 'votes' ? 'totalVotes' :
        null;

    let sorted;

    if (sortKey) {
        sorted = allServers.sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0));
    } else {
        sorted = allServers
            .map(s => ({ ...s, _score: computeScore(s) }))
            .sort((a, b) => b._score - a._score);
    }

    const total = sorted.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(Math.max(0, page), totalPages - 1);

    const slice = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

    const filterLabels = {
        all: '🌍 Tous les serveurs',
        weekly: '📅 Top hebdomadaire',
        featured: '⭐ Mis en avant',
        votes: '👍 Plus votés',
        nsfw: '🔞 NSFW',
    };

    const lines = await Promise.all(
        slice.map(async (s, idx) => {
            const rank = safePage * PAGE_SIZE + idx;
            const medal = MEDALS[rank] || `**${rank + 1}.**`;

            const isFeatured =
                s.featured &&
                s.featuredUntil &&
                new Date(s.featuredUntil) > new Date();

            const ready =
                !s.lastBump ||
                Date.now() - new Date(s.lastBump).getTime() >= BUMP_COOLDOWN_MS;

            let name = s.guildName || 'Serveur inconnu';
            if (isFeatured) name = `⭐ ${name}`;

            const invite = s.inviteLink ? ` • [Rejoindre](${s.inviteLink})` : '';
            const statusDot = ready ? '🟢' : '🔴';

            return [
                `${medal} **${name}**${invite}`,
                `> ${statusDot} ${s.memberCount.toLocaleString()} membres • ${s.bumpCount} bumps • ${s.weeklyBumps} cette semaine • ⭐ ${s.totalVotes || 0} votes`,
                s.description
                    ? `> *${s.description.slice(0, 80)}${s.description.length > 80 ? '...' : ''}*`
                    : '',
            ]
                .filter(Boolean)
                .join('\n');
        })
    );

    const embed = new EmbedBuilder()
        .setColor(COLORS.primary)
        .setTitle(`🏆 Top Serveurs REZO — ${filterLabels[filter] || 'Tous'}`)
        .setDescription(lines.join('\n\n') || '*Aucun serveur dans ce classement.*')
        .setThumbnail(client.user.displayAvatarURL())
        .addFields(
            { name: '📊 Serveurs dans le réseau', value: `${total}`, inline: true },
            { name: '📄 Page', value: `${safePage + 1}/${totalPages}`, inline: true },
        )
        .setFooter({ text: `REZO • Réseau de serveurs Discord` })
        .setTimestamp();

    return { embed, totalPages, safePage };
}

function buildNavComponents(page, totalPages, filter) {
    const filterMenu = new StringSelectMenuBuilder()
        .setCustomId('topserv_filter')
        .setPlaceholder('🔍 Filtrer...')
        .addOptions([
            { label: '🌍 Tous les serveurs', value: 'all', default: filter === 'all' },
            { label: '📅 Top hebdomadaire', value: 'weekly', default: filter === 'weekly' },
            { label: '⭐ Mis en avant', value: 'featured', default: filter === 'featured' },
            { label: '👍 Plus votés', value: 'votes', default: filter === 'votes' },
        ]);

    const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`topserv_prev_${page}_${filter}`)
            .setLabel('◀ Précédent')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),

        new ButtonBuilder()
            .setCustomId(`topserv_next_${page}_${filter}`)
            .setLabel('Suivant ▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= totalPages - 1),

        new ButtonBuilder()
            .setCustomId('topserv_refresh')
            .setLabel('🔄 Actualiser')
            .setStyle(ButtonStyle.Primary),
    );

    return [
        new ActionRowBuilder().addComponents(filterMenu),
        navRow,
    ];
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('topserveurs')
        .setDescription('🏆 Classement des serveurs du réseau REZO')
        .addStringOption(o =>
            o.setName('filtre')
                .setDescription('Type de classement')
                .addChoices(
                    { name: '🌍 Tous', value: 'all' },
                    { name: '📅 Hebdomadaire', value: 'weekly' },
                    { name: '⭐ Mis en avant', value: 'featured' },
                    { name: '👍 Plus votés', value: 'votes' },
                )
        ),

    async execute(interaction, client) {

        if (!interaction.isChatInputCommand()) return;

        await interaction.deferReply();

        const filter = interaction.options.getString('filtre') || 'all';

        const { embed, totalPages, safePage } = await buildTopEmbed(
            client,
            0,
            filter,
            interaction.guild
        );

        const components = buildNavComponents(0, totalPages, filter);

        const response = await interaction.editReply({
            embeds: [embed],
            components,
            withResponse: true
        });

        const reply = await response.fetch();

        const collector = reply.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id,
            time: 5 * 60 * 1000,
        });

        let currentPage = safePage;
        let currentFilter = filter;

        collector.on('collect', async i => {
            const id = i.customId;

            if (id === 'topserv_refresh') {
                await i.deferUpdate();
                const { embed: e, totalPages: tp, safePage: sp } = await buildTopEmbed(
                    client,
                    currentPage,
                    currentFilter,
                    interaction.guild
                );
                currentPage = sp;
                await i.editReply({
                    embeds: [e],
                    components: buildNavComponents(currentPage, tp, currentFilter)
                });
                return;
            }

            if (id === 'topserv_filter') {
                currentFilter = i.values[0];
                currentPage = 0;
                await i.deferUpdate();
                const { embed: e, totalPages: tp } = await buildTopEmbed(
                    client,
                    0,
                    currentFilter,
                    interaction.guild
                );
                await i.editReply({
                    embeds: [e],
                    components: buildNavComponents(0, tp, currentFilter)
                });
                return;
            }

            if (id.startsWith('topserv_prev_') || id.startsWith('topserv_next_')) {
                const isPrev = id.startsWith('topserv_prev_');
                currentPage = isPrev ? Math.max(0, currentPage - 1) : currentPage + 1;

                await i.deferUpdate();

                const { embed: e, totalPages: tp, safePage: sp } = await buildTopEmbed(
                    client,
                    currentPage,
                    currentFilter,
                    interaction.guild
                );

                currentPage = sp;

                await i.editReply({
                    embeds: [e],
                    components: buildNavComponents(currentPage, tp, currentFilter)
                });
                return;
            }
        });

        collector.on('end', () => {
            interaction.editReply({ components: [] }).catch(() => {});
        });
    },

    async handleButton(interaction) {
        await interaction.reply({
            content: 'Utilisez `/topserveurs` pour voir le classement.',
            flags: 64 // EPHEMERAL
        });
    },
};
