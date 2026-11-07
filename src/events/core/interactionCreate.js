// events/interactionCreate.js — Handler central complet
const { EmbedBuilder } = require('discord.js');
const { COLORS } = require('../../utils/embeds');
const blacklist = require('../../utils/blacklist');
const licenseGate = require('../../utils/licenseGate');

module.exports = {
  name: 'interactionCreate',

  // Ouvre le contexte d'identité du serveur AVANT de router l'interaction :
  // tous les embeds créés ensuite (commandes, boutons, modaux) héritent du nom,
  // de l'avatar, de la couleur et de la bannière personnalisés du serveur.
  async execute(interaction, client) {
    // L'autocomplétion doit répondre en moins de 3 s : aucun accès base ni
    // branding n'est nécessaire pour proposer des choix.
    if (interaction.isAutocomplete?.()) return module.exports.handle(interaction, client);
    const guildBrand = require('../../utils/guildBrand');
    if (!interaction.inGuild?.()) return module.exports.handle(interaction, client);
    const brandCfg = await guildBrand.prime(interaction.guildId).catch(() => null);
    if (brandCfg?.enabled) guildBrand.patchInteraction(interaction, brandCfg);
    return guildBrand.runWith(interaction.guildId, client, () => module.exports.handle(interaction, client));
  },

  async handle(interaction, client) {

    // ── Autocomplétion d'options — doit répondre en moins de 3 s ───────────
    // Discord n'accepte qu'une seule réponse, et jamais un silence : on répond
    // toujours, même vide, pour que la liste se ferme proprement.
    if (typeof interaction.isAutocomplete === 'function' && interaction.isAutocomplete()) {
      const command = client.commands.get(interaction.commandName);
      try {
        if (typeof command?.autocomplete === 'function') await command.autocomplete(interaction, client);
        else await interaction.respond([]);
      } catch (err) {
        console.error(`❌ autocomplete /${interaction.commandName}:`, err);
        await interaction.respond([]).catch(() => {});
      }
      return;
    }

    // ── Blacklist globale — aucun module du bot ne répond sur ces serveurs ──
    if (interaction.inGuild() && blacklist.isBlacklisted(interaction.guildId)) {
      if (interaction.isRepliable() && !interaction.deferred && !interaction.replied) {
        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setColor(COLORS.error)
            .setTitle('⛔ Serveur blacklisté')
            .setDescription('Ce serveur est blacklisté globalement. Aucune fonctionnalité du bot n\'est disponible ici.')],
          ephemeral: true,
        }).catch(() => {});
      }
      return;
    }

    // ── Programme d'installation (boutons ET menus) ────────────────────────
    // Routé avant le découpage par type de composant : le panneau mélange
    // boutons et sélecteur de modules, et un préfixe unique doit suffire.
    // Ces identifiants sont persistants : ils survivent au redémarrage du bot.
    if (interaction.isMessageComponent?.() && String(interaction.customId || '').startsWith('setup_')) {
      const { handleSetupInteraction } = require('../../utils/setupHub');
      await handleSetupInteraction(interaction, client).catch(console.error);
      return;
    }

    // ── Slash commands ────────────────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;

      // ── Conditions d'utilisation — acceptation obligatoire ───────────────
      // Placé avant la licence et avant l'authentification : sans acceptation
      // de la version courante, AUCUNE commande ne s'exécute. L'invite
      // elle-même porte les boutons « Lire en entier » et « J'accepte ».
      const tosGate = require('../../utils/tosGate');
      if (!(await tosGate.ensureAccepted(interaction))) return;

      // ── Garde-fou licence — systèmes phares réservés aux serveurs licenciés ──
      // checkAccess() accepte aussi bien une licence complète qu'un essai gratuit actif.
      // La vérification est bornée (2,5 s) : si la base ou l'hébergement ne répond
      // pas, on le dit clairement au lieu de laisser la commande muette.
      if (interaction.inGuild() && licenseGate.isLicenseRequired(interaction.commandName)) {
        const access = await licenseGate.checkAccessBounded(interaction.guildId, interaction.commandName);
        if (!access) {
          return interaction.reply({ embeds: [licenseGate.unavailableEmbed(interaction.commandName)], ephemeral: true }).catch(() => {});
        }
        const fullOnly = licenseGate.requiresFullLicense(interaction.commandName);
        if (!access.ok || (fullOnly && access.reason === 'trial')) {
          // Un refus de PALIER prime sur « licence active requise » : le serveur
          // a bien une licence, simplement pas celle qui ouvre ce module.
          const embed = access.reason === 'feature_locked'
            ? licenseGate.lockEmbed(interaction.commandName, { access })
            : fullOnly
              ? licenseGate.fullLicenseEmbed(interaction.commandName)
              : licenseGate.lockEmbed(interaction.commandName, { access });
          return interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
        }
        // ── Rappel essai gratuit — injecte un followUp éphémère si l'essai expire dans < 48h
        // On ne bloque PAS la commande, on envoie juste un rappel discret après exécution.
        var _trialAccess = access; // transmis au bloc post-exécution ci-dessous
      }

      // ── Anti-spam des commandes slash ───────────────────────────────────
      // Une rafale de commandes ne produit AUCUN message : l'anti-spam des
      // messages ne pouvait pas la voir. Le garde-fou refuse la commande et
      // laisse une trace dans les logs, sans sanction (voir utils/antiSpam.js).
      // Il ne coûte rien quand l'anti-spam du serveur est désactivé.
      try {
        const { guardSlashCommand } = require('../../utils/antiSpam');
        const spamGuard = await guardSlashCommand(interaction, client);
        if (spamGuard.blocked) return;
      } catch (err) {
        console.error('❌ Anti-spam commandes:', err.message);
      }

      try {
        // ── Commandes à risque — preuve d'identité avant toute action ──────
        // Si le membre a configuré /authentificator (PIN, 2FA ou code de
        // secours), la commande passe par authGate. Sinon elle s'exécute
        // normalement : la protection est opt-in, jamais un blocage.
        const authGate = require('../../utils/authGate');
        if (authGate.isProtectedCommand(interaction.commandName)) {
          await authGate.protectCommand(interaction, { command, client });
        } else {
          // Filet d'acquittement : une commande lente (base froide, pool saturé,
          // carte à dessiner) ne doit jamais finir en « L'application ne répond
          // pas ». Le filet laisse passer les commandes rapides sans rien changer
          // et ne couvre que l'exécution, jamais l'authentification ci-dessus
          // (qui peut ouvrir un modal).
          const { runWithAutoAck } = require('../../core/latencyGuard');
          await runWithAutoAck(
            interaction,
            () => command.execute(interaction, client),
            { label: interaction.commandName },
          );
        }
      } catch (err) {
        console.error(`❌ /${interaction.commandName}:`, err);
        const errEmbed = new EmbedBuilder()
          .setColor(COLORS.error)
          .setTitle('❌ Une erreur est survenue')
          .setDescription('Veuillez réessayer dans quelques instants.');
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ embeds: [errEmbed] }).catch(() => {});
        } else {
          await interaction.reply({ embeds: [errEmbed], ephemeral: true }).catch(() => {});
        }
      }

      // ── Rappel essai gratuit — si la commande s'est bien exécutée en mode trial ──
      // Envoie un followUp éphémère uniquement quand l'essai expire dans moins de 48h
      // pour éviter de spammer à chaque commande.
      if (_trialAccess?.reason === 'trial' && _trialAccess.trial) {
        const remaining = new Date(_trialAccess.trial.expiresAt).getTime() - Date.now();
        if (remaining > 0 && remaining < 48 * 3_600_000) {
          // Envoi en best-effort — ne jamais faire planter la commande pour ça
          interaction.followUp({
            embeds: [licenseGate.trialReminderEmbed(_trialAccess.trial)],
            ephemeral: true,
          }).catch(() => {});
        }
      }

      return;
    }

    // ── Modaux ────────────────────────────────────────────────────────────
    if (interaction.isModalSubmit()) {
      const id = interaction.customId;

      // Anti-VPN — panneau persistant de la commande /antivpn (avpn_*)
      if (id.startsWith('avpn_')) {
        await require('../../utils/antiVpnPanel').handleComponent(interaction, client).catch(console.error);
        return;
      }

      // Vanity par statut — modaux du panneau /vanity (textes, embed, conditions)
      if (id.startsWith('vty_modal')) {
        const cmd = client.commands.get('vanity');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }

      // Menu de rôles — modaux de l'éditeur unique (rmneditm:<champ>)
      if (id.startsWith('rmneditm:')) {
        const cmd = client.commands.get('rolemenu');
        if (cmd?.handleEditorModal) await cmd.handleEditorModal(interaction, client).catch(console.error);
        return;
      }

      // Identité visuelle par serveur — modaux du panel /branding
      if (id.startsWith('brand_modal_')) {
        const cmd = client.commands.get('branding');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }

      // Surveillance de sites — modaux du panel /statut-site
      if (id.startsWith('site_modal')) {
        const cmd = client.commands.get('statut-site');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }

      if (id.startsWith('authgate_confirm_')) {
        const authGate = require('../../utils/authGate');
        await authGate.handleModal(interaction).catch(console.error);
        return;
      }

      // Profil utilisateur — modaux du panel /profile (titre, bio, style)
      if (id.startsWith('prf_modal')) {
        const cmd = client.commands.get('profile');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }

      // Panel licence — modaux lc_modal_*
      if (id.startsWith('lc_modal_')) {
        const cmd = client.commands.get('license');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }
      
      if (id.startsWith('auth_')) {
        const cmd = client.commands.get('authentificator');
        if (cmd?.handleModal) await cmd.handleModal(interaction).catch(console.error);
        return;
      }
      if (id.startsWith('avispanel_')) {
        const cmd = client.commands.get('avis');
        if (cmd?.handleModal) await cmd.handleModal(interaction).catch(console.error);
        return;
      }
      // Registre des sanctions — formulaire de filtre et recherche de membre.
      if (id.startsWith('sancm_')) {
        const cmd = client.commands.get('sanctions');
        if (cmd?.handleModal) await cmd.handleModal(interaction).catch(console.error);
        return;
      }
      if (id.startsWith('avis_reply_modal_')) {
        const cmd = client.commands.get('avis');
        if (cmd?.handleModal) await cmd.handleModal(interaction).catch(console.error);
        return;
      }
      if (id === 'planet_rename_modal') {
        const cmd = client.commands.get('planet');
        if (cmd?.handleModal) await cmd.handleModal(interaction).catch(console.error);
        return;
      }
      if (id.startsWith('bumpnotif_modal_')) {
        const cmd = client.commands.get('bump-notif');
        if (cmd?.handleModal) await cmd.handleModal(interaction).catch(console.error);
        return;
      }
      if (id.startsWith('mpreq_modal_')) {
        const cmd = client.commands.get('demande-mp');
        if (cmd?.handleModal) await cmd.handleModal(interaction).catch(console.error);
        return;
      }
      if (id === 'help_search_modal') {
        const cmd = client.commands.get('help');
        if (cmd?.handleSearchModal) await cmd.handleSearchModal(interaction).catch(console.error);
        return;
      }

      // Anniversaires — modales du panneau /anniversaire-config (persistant)
      if (id.startsWith('bd_modal_')) {
        const cmd = client.commands.get('anniversaire-config');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }
      if (id.startsWith('wlm_')) {
        const cmd = client.commands.get('welcome');
        if (cmd?.handleModal) await cmd.handleModal(interaction).catch(console.error);
        return;
      }
      if (id.startsWith('fwellm_')) {
        const cmd = client.commands.get('farewell-set');
        if (cmd?.handleModal) await cmd.handleModal(interaction).catch(console.error);
        return;
      }
      if (id.startsWith('pfxm_')) {
        const cmd = client.commands.get('prefix');
        if (cmd?.handleModal) await cmd.handleModal(interaction).catch(console.error);
        return;
      }
      // Règlement v2 — modaux du panneau /reglement
      if (id.startsWith('reglm_')) {
        const cmd = client.commands.get('reglement');
        if (cmd?.handleModal) await cmd.handleModal(interaction).catch(console.error);
        return;
      }
      // Signalement — modaux (étape 2 : détails)
      if (id.startsWith('sigm_submit')) {
        const cmd = client.commands.get('signalement');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }
      // Anti-raid — modaux du panneau /antiraid
      if (id.startsWith('armm_')) {
        const cmd = client.commands.get('antiraid');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }
      // Anti-scam — modaux du panel /antiscam
      if (id.startsWith('ascm_')) {
        const cmd = client.commands.get('antiscam');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }
      // Scam — formulaire public /scam (2 étapes)
      if (id.startsWith('scamf_')) {
        const cmd = client.commands.get('scam');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }
      // Confessions — soumission, réponse anonyme et cooldown
      if (id === 'confession_submit' || id === 'conf_cooldown_modal' || id.startsWith('confm_')) {
        const cmd = client.commands.get('confession');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }
      if (id.startsWith('emb_modal_')) {
        const cmd = client.commands.get('embed');
        if (cmd?.handleEmbedModal) await cmd.handleEmbedModal(interaction).catch(console.error);
        return;
      }
      // Studio d'embeds — modaux (contenu, champs, boutons, création)
      if (id.startsWith('es_modal_')) {
        const cmd = client.commands.get('embed');
        if (cmd?.handleStudioModal) await cmd.handleStudioModal(interaction).catch(console.error);
        return;
      }
      if (id.startsWith('mq_')) {
        const cmd = client.commands.get('mathquiz');
        if (cmd?.handleModal) await cmd.handleModal(interaction).catch(console.error);
        return;
      }
      if (id.startsWith('captcha_submit_')) {
        const { handleCaptchaSubmit } = require('../../commands/configuration/captcha');
        await handleCaptchaSubmit(interaction).catch(console.error);
        return;
      }
      if (id === 'captcha_advanced_modal') {
        const cmd = client.commands.get('captcha');
        if (cmd?.handleAdvancedModal) await cmd.handleAdvancedModal(interaction).catch(console.error);
        return;
      }
      if (id === 'captcha_antibot_modal') {
        const cmd = client.commands.get('captcha');
        if (cmd?.handleAntiBotModal) await cmd.handleAntiBotModal(interaction).catch(console.error);
        return;
      }
      if (id === 'hp_advanced_modal') {
        const cmd = client.commands.get('honeypot');
        if (cmd?.handleAdvancedModal) await cmd.handleAdvancedModal(interaction).catch(console.error);
        return;
      }
      if (id.startsWith('sb_modal_')) {
        const cmd = client.commands.get('starboard');
        if (cmd?.handleModal) await cmd.handleModal(interaction).catch(console.error);
        return;
      }
      if (id.startsWith('ob_modal_')) {
        const cmd = client.commands.get('onboarding');
        if (cmd?.handleModal) await cmd.handleModal(interaction).catch(console.error);
        return;
      }
      if (id === 'lvl_xp_modal') {
        const cmd = client.commands.get('leveling');
        if (cmd?.handleXpModal) await cmd.handleXpModal(interaction).catch(console.error);
        return;
      }
      if (id === 'lvl_color_modal') {
        const cmd = client.commands.get('leveling');
        if (cmd?.handleColorModal) await cmd.handleColorModal(interaction).catch(console.error);
        return;
      }
      if (id.startsWith('lvl_mult_channel_modal_') || id.startsWith('lvl_mult_role_modal_')) {
        const cmd = client.commands.get('leveling');
        if (cmd?.handleMultiplierModal) await cmd.handleMultiplierModal(interaction, id).catch(console.error);
        return;
      }
      // Carte de rang du serveur (panneau /leveling → 🎨 Carte de rang)
      if (id.startsWith('lvlcard_modal_')) {
        const cmd = client.commands.get('leveling');
        if (cmd?.handleCardModal) await cmd.handleCardModal(interaction, client).catch(console.error);
        return;
      }
      // Carte de l'annonce de niveau (/leveling → 📢 Annonce → 🎉 Carte d'annonce)
      if (id.startsWith('lvucard_modal_')) {
        const cmd = client.commands.get('leveling');
        if (cmd?.handleLevelUpCardModal) await cmd.handleLevelUpCardModal(interaction, client).catch(console.error);
        return;
      }
      // Trésors cachés (/tresor → modaux de réglage)
      if (id.startsWith('trs_modal_')) {
        const cmd = client.commands.get('tresor');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }
      // Musique — volume par défaut (réglages)
      if (id === 'mus_defvol_modal') {
        const cmd = client.commands.get('musique');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }
      // Radio — volume par défaut (réglages)
      if (id === 'rad_cfg_vol_modal') {
        const cmd = client.commands.get('radio');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }
      // Radio — recherche de station depuis le panneau (🔎 Rechercher)
      if (id === 'rad_search_modal') {
        const cmd = client.commands.get('radio');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }
      // Carte de rang personnelle (panneau /rank → 🎨 Personnaliser ma carte)
      if (id.startsWith('rcp_modal_')) {
        const cmd = client.commands.get('rank');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }
      if (id === 'bst_message_modal') {
        const cmd = client.commands.get('boost');
        if (cmd?.handleMessageModal) await cmd.handleMessageModal(interaction).catch(console.error);
        return;
      }
      if (id === 'bst_color_modal_submit') {
        const cmd = client.commands.get('boost');
        if (cmd?.handleColorModal) await cmd.handleColorModal(interaction).catch(console.error);
        return;
      }
      if (id === 'bst_image_modal_submit') {
        const cmd = client.commands.get('boost');
        if (cmd?.handleImageModal) await cmd.handleImageModal(interaction).catch(console.error);
        return;
      }
      // ── YouTube Sub Alert — modaux ─────────────────────────────────────────
      if (id.startsWith('ysub_modal_') || id === 'ysub_modal_add') {
        const cmd = client.commands.get('youtube-sub');
        if (cmd?.handleModal) await cmd.handleModal(interaction).catch(console.error);
        return;
      }

      // ── Salon d'attente — modale du message de notification ──────────────
      if (id.startsWith('wr_modal_')) {
        const cmd = client.commands.get('waitingroom');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }
      // ── Ticket — modaux (fermeture, priorité) : une seule source de vérité
      if (id.startsWith('ticket_close_modal_') || id.startsWith('ticket_priority_modal_')) {
        const cmd = client.commands.get('ticket');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }
      // ── Ticket — formulaire d'ouverture soumis (ticket_submit:<panel>:<cat>)
      if (id.startsWith('ticket_submit:')) {
        const cmd = client.commands.get('ticket');
        if (cmd?.handleSubmitModal) await cmd.handleSubmitModal(interaction, client).catch(console.error);
        return;
      }

      // ── Commandes personnalisées — modales de création / modification ────
      if (id.startsWith('cusm_')) {
        const cmd = client.commands.get('custom');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }

      // ── Ticket — modaux du panel unique (personnalisation complète)
      if (id.startsWith('tp_modal_')) {
        const cmd = client.commands.get('ticket');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }

      // ── ModMail — modaux
      if (
        id.startsWith('mm_modal_reply_') ||
        id.startsWith('mm_modal_anon_')  ||
        id.startsWith('mm_close_modal_') ||
        id === 'mm_config_welcome'        ||
        id === 'mm_config_close'
      ) {
        const cmd = client.commands.get('modmail');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }

      // ── Panneau Sécurité — modaux
      if (
        id === 'sec_modal_spam' ||
        id === 'sec_modal_raid' ||
        id === 'sec_modal_caps' ||
        id === 'sec_modal_links_wl' ||
        id === 'sec_modal_cap_config' ||
        id === 'sec_modal_spamadv' ||
        id === 'sec_modal_mention' ||
        id === 'sec_modal_graduated' ||
        id.startsWith('sec_modal_wf_')
      ) {
        const cmd = client.commands.get('securite');
        if (cmd?.handleModal) await cmd.handleModal(interaction).catch(console.error);
        return;
      }

      // ── Panneau anti-nuke (Sentinel) — seuils personnalisés
      if (id.startsWith('an_modal_')) {
        const cmd = client.commands.get('anti-nuke');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }

      // ── Vigie (contrôle à l'arrivée) — seuils et mots interdits
      if (id.startsWith('cj_modal_')) {
        const cmd = client.commands.get('controle-arrivee');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }

      // ── Casino — modaux (mise rapide, limites, configuration)
      if (id.startsWith('cas_modal_') || id.startsWith('cas_limits_')) {
        const cmd = client.commands.get('casino');
        if (cmd?.handleModal) await cmd.handleModal(interaction, client).catch(console.error);
        return;
      }
      return;
    }

    // ── Sélecteurs panneau sécurité (gérés par collecteur interne) ──────────
    if (interaction.isAnySelectMenu()) {
      // Vanity par statut — menus du panneau /vanity (rôle, salon d'annonce, logs)
      if (interaction.customId.startsWith('vty_sel_')) {
        const cmd = client.commands.get('vanity');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction, client).catch(console.error);
        return;
      }

      // Anti-VPN — salons, rôles, sections et listes (avpn_*)
      if (interaction.customId.startsWith('avpn_')) {
        await require('../../utils/antiVpnPanel').handleComponent(interaction, client).catch(console.error);
        return;
      }

      // Identité visuelle par serveur — menu de choix du champ à modifier, et
      // menus du style de pseudo (police / effet / couleur).
      if (interaction.customId === 'brand_field' || interaction.customId.startsWith('brand_style_')) {
        const cmd = client.commands.get('branding');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction, client).catch(console.error);
        return;
      }

      // Surveillance de sites — gestion d'un site et réglages du panel /statut-site
      if (interaction.customId.startsWith('site_')) {
        const cmd = client.commands.get('statut-site');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction, client).catch(console.error);
        return;
      }

      const secIds = ['sec_logs_channel','sec_exempt_role_select','sec_exempt_chan_select','mm_set_category','mm_set_log','mm_set_role'];
      if (secIds.includes(interaction.customId)) return;
      // Coffre-fort de permissions — menus gérés par le collecteur de /securite
      if (interaction.customId.startsWith('sec_vault_')) return;

      // Commandes personnalisées — menus du panel /custom
      if (interaction.customId.startsWith('cus_')) {
        const cmd = client.commands.get('custom');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction, client).catch(console.error);
        return;
      }

      // Anti-nuke (Sentinel) — menus du panneau et de la liste de confiance
      if (interaction.customId.startsWith('an_')) {
        const cmd = client.commands.get('anti-nuke');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction, client).catch(console.error);
        return;
      }

      // Vigie (contrôle à l'arrivée) — menus du panneau, contrôles et liste de confiance
      if (interaction.customId.startsWith('cj_')) {
        const cmd = client.commands.get('controle-arrivee');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction, client).catch(console.error);
        return;
      }

      // Bienvenue+ — menus du panneau /welcome panel
      if (interaction.customId.startsWith('wls_')) {
        const cmd = client.commands.get('welcome');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction).catch(console.error);
        return;
      }

      // Au revoir — menus du panneau /farewell-set panel
      if (interaction.customId.startsWith('fwells_')) {
        const cmd = client.commands.get('farewell-set');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction).catch(console.error);
        return;
      }

      // Préfixe hybride — menus du panneau /prefix
      if (interaction.customId.startsWith('pfxs_')) {
        const cmd = client.commands.get('prefix');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction).catch(console.error);
        return;
      }

      // Règlement v2 — menus du panneau /reglement
      if (interaction.customId.startsWith('regls_')) {
        const cmd = client.commands.get('reglement');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction).catch(console.error);
        return;
      }

      // Confessions — couleurs et sélecteurs salon/rôle du panneau (confs_)
      if (interaction.customId.startsWith('confs_')) {
        const cmd = client.commands.get('confession');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction, client).catch(console.error);
        return;
      }

      // Signalement — menus du panneau staff (sigs_) et menu motif (sigr_)
      if (interaction.customId.startsWith('sigs_')) {
        const cmd = client.commands.get('signalement');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction).catch(console.error);
        return;
      }
      if (interaction.customId.startsWith('sigr_')) {
        const cmd = client.commands.get('signalement');
        if (cmd?.handleReasonMenu) await cmd.handleReasonMenu(interaction).catch(console.error);
        return;
      }

      // Anti-raid — menus du panneau /antiraid
      if (interaction.customId.startsWith('arms_')) {
        const cmd = client.commands.get('antiraid');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction, client).catch(console.error);
        return;
      }

      // Anti-scam — menus du panel /antiscam
      if (interaction.customId.startsWith('_asc_')) {
        const cmd = client.commands.get('antiscam');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction, client).catch(console.error);
        return;
      }

      // Carte de rang — menus du panneau /rank (rcp_sel_*)
      if (interaction.customId.startsWith('rcp_sel_')) {
        const cmd = client.commands.get('rank');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Casino — salons autorisés et jeux activés (panneau de configuration)
      if (interaction.customId.startsWith('cas_sel_')) {
        const cmd = client.commands.get('casino');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction, client).catch(console.error);
        return;
      }
    }

    // ── Boutons ───────────────────────────────────────────────────────────
    if (interaction.isButton()) {
      // Vanity par statut — boutons du panneau /vanity (vty_*)
      if (interaction.customId.startsWith('vty_')) {
        const cmd = client.commands.get('vanity');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Anti-VPN — boutons du panneau persistant (avpn_*)
      if (interaction.customId.startsWith('avpn_')) {
        await require('../../utils/antiVpnPanel').handleComponent(interaction, client).catch(console.error);
        return;
      }

      const id = interaction.customId;

      // Conditions d'utilisation — boutons du prompt (accepter / lire / refuser).
      // Routés en premier : ils doivent fonctionner même quand tout le reste du
      // bot est bloqué, sinon un membre ne peut plus jamais accepter.
      if (id.startsWith('tos_')) {
        const tosGate = require('../../utils/tosGate');
        await tosGate.handleButton(interaction).catch(console.error);
        return;
      }

      // Casino — accueil, jeux, profil, classement, jackpot, limites, config
      if (id.startsWith('cas_')) {
        const cmd = client.commands.get('casino');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Profil utilisateur — panel /profile (édition, aperçu, badges, reset)
      if (id.startsWith('prf_')) {
        const cmd = client.commands.get('profile');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Identité visuelle par serveur — panel /branding
      if (id.startsWith('brand_')) {
        const cmd = client.commands.get('branding');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Devis Pack REZO.net — cartes envoyées en MP à l'owner (Approuver / Refuser).
      // L'émission de la clé et son envoi à l'acheteur sont faits par le module.
      if (id.startsWith('quote_ok_') || id.startsWith('quote_no_')) {
        const { handleQuoteButton } = require('../../utils/quoteNotifier');
        await handleQuoteButton(interaction, client).catch(console.error);
        return;
      }

      // Surveillance de sites — panel /statut-site
      if (id.startsWith('site_')) {
        const cmd = client.commands.get('statut-site');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Commandes personnalisées — panel /custom
      if (id.startsWith('cus_')) {
        const cmd = client.commands.get('custom');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Honeypot v3 — panel interactif (routage persistant, survive à l'expiration du collecteur)
      if (id.startsWith('_hp_')) {
        const cmd = client.commands.get('honeypot');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Anti-scam — panel + cartes de validation + votes réseau
      if (id.startsWith('_asc_')) {
        const cmd = client.commands.get('antiscam');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }
      if (id.startsWith('scamv_approve_') || id.startsWith('scamv_reject_')) {
        const cmd = client.commands.get('antiscam');
        if (cmd?.handleDecision) await cmd.handleDecision(interaction, client).catch(console.error);
        return;
      }
      if (id.startsWith('scamv_yes_') || id.startsWith('scamv_no_')) {
        const { handleVote } = require('../../utils/scamAlertActions');
        await handleVote(interaction).catch(console.error);
        return;
      }
      // Scam — boutons du formulaire public (étape 2, annulation)
      if (id.startsWith('scamf_')) {
        const cmd = client.commands.get('scam');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Registre des sanctions officielles — pagination, filtre, export, déban.
      // Préfixes `sanc_*` (boutons) et `sancm_*` (modaux) : une seule commande
      // porte l'interface, donc un seul point d'entrée ici.
      if (id.startsWith('sanc_')) {
        const cmd = client.commands.get('sanctions');
        if (cmd?.handleButton) await cmd.handleButton(interaction).catch(console.error);
        return;
      }

      // Panneau sécurité — tous les boutons commençant par sec_ sont gérés par le collecteur interne
      if (id.startsWith('sec_')) return;

      // Anti-nuke (Sentinel) — panneau an_* et liste de confiance an_wl_*
      if (id.startsWith('an_')) {
        const cmd = client.commands.get('anti-nuke');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Audit de sécurité — correctifs en un clic (auf_*)
      if (id.startsWith('auf_')) {
        const cmd = client.commands.get('audit-securite');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Vigie (contrôle à l'arrivée) — panneau cj_* et vues éphémères
      if (id.startsWith('cj_')) {
        const cmd = client.commands.get('controle-arrivee');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Pagination Twitch — gérée par le collecteur interne de la commande
      if (id.startsWith('twpage_')) return;


      // Panel d'avis, stats en direct, navigation "voir" — gérés par les collecteurs internes de avis.js
      if (id.startsWith('avispanel_') || id.startsWith('avisstats_') || id.startsWith('avis_prev') || id.startsWith('avis_next') || id.startsWith('avis_close') || id.startsWith('avis_helpful_') || id.startsWith('avis_report') || id.startsWith('avis_reply')) return;

      // Panel de notifications de bump — géré par le collecteur interne de bump-notif.js
      if (id.startsWith('bumpnotif_')) return;

      // Jeu /planet — géré par le collecteur interne de planet.js
      if (id.startsWith('planet_')) return;

      // Panels du système IA (configuration, salon, statistiques) — gérés par le
      // collecteur interne de ia.js. Les modaux ai_modal_* sont, eux,
      // attendus par ce même fichier via awaitModalSubmit.
      if (id.startsWith('aiplay_') || id.startsWith('ai_')) return;

      // Panel Demande de MP — géré par le collecteur interne de demande-mp.js
      if (id.startsWith('mpreq_')) return;

      // Demande de MP — réponse Accepter/Refuser (bouton persistant sur message public)
      if (id.startsWith('mpans_accept_') || id.startsWith('mpans_reject_')) {
        const { handleRequestButton } = require('../../utils/mpRequestHandler');
        await handleRequestButton(interaction).catch(console.error);
        return;
      }

      // Pagination de l'historique des bumps — géré par le collecteur interne de bump-historique.js
      if (id.startsWith('bumphist_')) return;

      // File de modération des avis — boutons persistants dans le salon de logs
      if (id.startsWith('avis_approve_') || id.startsWith('avis_reject_')) {
        const cmd = client.commands.get('avis');
        if (cmd?.handleModerationButton) await cmd.handleModerationButton(interaction).catch(console.error);
        return;
      }

      // Bouton piège Honeypot — persistant dans les salons piège (pas le panel)
      if (id === 'hp_trap_click') {
        const cmd = client.commands.get('honeypot');
        if (cmd?.handleButtonTrigger) await cmd.handleButtonTrigger(interaction).catch(console.error);
        return;
      }

      // Portail d'accès — validation staff (boutons de la carte envoyée au staff)
      if (id.startsWith('obreview_ok:') || id.startsWith('obreview_no:')) {
        const { handleReviewButton } = require('../../utils/onboardingManager');
        await handleReviewButton(interaction, client).catch(console.error);
        return;
      }

      // Portail d'accès — réponses de l'étape en cours (boutons, règlement)
      if (id.startsWith('ob_answer:') || id.startsWith('ob_skip:') || id.startsWith('ob_rules:')) {
        const { handleStepInteraction } = require('../../utils/onboardingManager');
        await handleStepInteraction(interaction).catch(console.error);
        return;
      }

      // Authentification d'un panneau protégé — bouton « S’authentifier »
      // (un modal submit ne peut pas ouvrir de modal, on passe par ce bouton).
      if (id.startsWith('authgate_auth_')) {
        const authGate = require('../../utils/authGate');
        await authGate.handleAuthButton(interaction).catch(console.error);
        return;
      }

      // Authentification personnelle (PIN / 2FA / codes de secours)
      if (id.startsWith('auth_')) {
        const cmd = client.commands.get('authentificator');
        if (cmd?.handleButton) await cmd.handleButton(interaction).catch(console.error);
        return;
      }

      // Bienvenue+ — boutons du panneau /welcome panel
      if (id.startsWith('wlb_')) {
        const cmd = client.commands.get('welcome');
        if (cmd?.handleButton) await cmd.handleButton(interaction).catch(console.error);
        return;
      }

      // Au revoir — boutons du panneau /farewell-set panel
      if (id.startsWith('fwell_')) {
        const cmd = client.commands.get('farewell-set');
        if (cmd?.handleButton) await cmd.handleButton(interaction).catch(console.error);
        return;
      }

      // Préfixe hybride — boutons du panneau /prefix
      if (id.startsWith('pfx_')) {
        const cmd = client.commands.get('prefix');
        if (cmd?.handleButton) await cmd.handleButton(interaction).catch(console.error);
        return;
      }

      // Notifications — boutons panel live
      if (id.startsWith('notif_')) {
        const cmd = client.commands.get('notifications');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // News — navigation articles
      if (id === 'news_prev' || id === 'news_next') return; // géré par collecteur interne

      // FreeGames — boutons de navigation (pagination)
      if (id === 'fg_prev' || id === 'fg_next') return; // géré par collecteur interne

      // ModMail — boutons (répondre, fermer, snippet)
      if (id.startsWith('mm_reply_') || id.startsWith('mm_close_') || id.startsWith('mm_snippet_')) {
        const cmd = client.commands.get('modmail');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Panel licence — boutons lc_ (tous préfixés, persistants)
      if (id.startsWith('lc_')) {
        const cmd = client.commands.get('license');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Sauvegarde — boutons bk_ (confirmations de restauration / suppression).
      // ⚠️ Même gate licence que la commande : un bouton posté avant l'expiration
      // ne doit pas permettre de contourner le verrouillage.
      if (id.startsWith('bk_')) {
        const cmd = client.commands.get('backup');
        if (cmd?.handleButton) {
          if (interaction.inGuild() && licenseGate.isLicenseRequired('backup')) {
            const access = await licenseGate.checkAccessBounded(interaction.guildId, 'backup');
            if (!access) {
              return interaction.reply({ embeds: [licenseGate.unavailableEmbed('backup')], ephemeral: true }).catch(() => {});
            }
            if (!access.ok) {
              return interaction.reply({ embeds: [licenseGate.lockEmbed('backup', { access })], ephemeral: true }).catch(() => {});
            }
          }
          await cmd.handleButton(interaction, client).catch(console.error);
        }
        return;
      }

      // Ping bot → ouvrir commande.
      // ⚠️ Même gate licence que les slash commands : sans cela, les boutons du
      // message de mention permettraient de contourner le verrouillage des
      // systèmes sous licence.
      if (id.startsWith('ping_open_')) {
        const action  = id.replace('ping_open_', '');
        const cmdName = { help: 'help', panel: 'panel', license: 'license' }[action];
        if (cmdName) {
          const cmd = client.commands.get(cmdName);
          if (cmd) {
            if (interaction.inGuild() && licenseGate.isLicenseRequired(cmdName)) {
              const access = await licenseGate.checkAccessBounded(interaction.guildId, cmdName);
              if (!access) {
                return interaction.reply({ embeds: [licenseGate.unavailableEmbed(cmdName)], ephemeral: true }).catch(() => {});
              }
              if (!access.ok) {
                return interaction.reply({ embeds: [licenseGate.lockEmbed(cmdName, { access })], ephemeral: true }).catch(() => {});
              }
            }
            await cmd.execute(interaction, client).catch(console.error);
          }
        }
        return;
      }

      // Duel — accepter / refuser
      if (id.startsWith('duel_accept_')) {
        const parts = id.split('_');
        const p1Id = parts[2], p2Id = parts[3], wagerStr = parts[4];
        const cmd = client.commands.get('duel');
        if (cmd?.handleAccept) await cmd.handleAccept(interaction, p1Id, p2Id, parseInt(wagerStr) || 0).catch(console.error);
        return;
      }
      if (id.startsWith('duel_decline_')) {
        const parts = id.split('_');
        const p1Id = parts[2];
        const cmd = client.commands.get('duel');
        if (cmd?.handleDecline) await cmd.handleDecline(interaction, p1Id).catch(console.error);
        return;
      }

      // Event — participer
      if (id.startsWith('event_join_')) {
        const eventId = id.replace('event_join_', '');
        const cmd = client.commands.get('event');
        if (cmd?.handleJoin) await cmd.handleJoin(interaction, eventId).catch(console.error);
        return;
      }

      // Règlement — accepter
      if (id === 'reglement_accept') {
        const cmd = client.commands.get('reglement');
        if (cmd?.handleAccept) await cmd.handleAccept(interaction).catch(console.error);
        return;
      }

      // Règlement v2 — boutons du panneau /reglement
      if (id.startsWith('regl_')) {
        const cmd = client.commands.get('reglement');
        if (cmd?.handleButton) await cmd.handleButton(interaction).catch(console.error);
        return;
      }

      // Signalement — boutons du panneau, boutons staff et bouton public
      if (id.startsWith('sig_') || id.startsWith('sig_open_')) {
        const cmd = client.commands.get('signalement');
        if (cmd?.handleButton) await cmd.handleButton(interaction).catch(console.error);
        return;
      }

      // Salon d'attente — boutons publics du message de file (Appeler / Rafraîchir)
      if (id === 'waitingroom_next' || id === 'waitingroom_refresh') {
        const cmd = client.commands.get('waitingroom');
        if (id === 'waitingroom_next') await cmd?.handleNext?.(interaction, client).catch(console.error);
        else await cmd?.handleRefresh?.(interaction, client).catch(console.error);
        return;
      }

      // Anti-raid — boutons du panneau /antiraid
      if (id.startsWith('arm_')) {
        const cmd = client.commands.get('antiraid');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Rappel bump → message éphémère
      if (id === 'bump_reminder_click') {
        return interaction.reply({ content: '🚀 Utilisez `/bump` pour bumper votre serveur !', ephemeral: true });
      }

      // YouTube Sub Alert — boutons (retirer mention rôle)
      if (id.startsWith('ysub_remove_role:') || id.startsWith('ysub_btn_delete:') || id.startsWith('ysub_btn_preview:') || id.startsWith('ysub_btn_test:') || id === 'ysub_btn_back' || id === 'ysub_btn_add' || id === 'ysub_btn_variables' || id === 'ysub_btn_refresh') {
        const cmd = client.commands.get('youtube-sub');
        if (id.startsWith('ysub_remove_role:')) {
          if (cmd?.handleButton) await cmd.handleButton(interaction).catch(console.error);
        }
        // Les autres boutons sont gérés par le collecteur interne
        return;
      }

      // Voir stats après bump — version corrigée (reply éphémère séparé)
      if (id === 'bump_view_stats') {
        await interaction.deferReply({ ephemeral: true });
        try {
          const Server = require('../../models/Server');
          const User = require('../../models/User');
          const { BUMP_COOLDOWN_MS } = require('../../utils/bumpNetwork');
          const guild = interaction.guild;
          const server = await Server.findOne({ guildId: guild.id });
          if (!server || server.bumpCount === 0) {
            return interaction.editReply({ content: 'Aucune donnée de bump pour ce serveur.' });
          }
          const userStats = await User.findOne({ userId: interaction.user.id, guildId: guild.id });
          const nextTs = server.lastBump
            ? Math.floor((new Date(server.lastBump).getTime() + BUMP_COOLDOWN_MS) / 1000)
            : null;
          const ready = !server.lastBump || Date.now() - new Date(server.lastBump).getTime() >= BUMP_COOLDOWN_MS;
          const embed = new EmbedBuilder()
            .setColor(COLORS.primary)
            .setTitle(`📊 Vos stats de bump — ${guild.name}`)
            .addFields(
              { name: '🚀 Vos bumps', value: `**${userStats?.bumps || 0}**`, inline: true },
              { name: '📊 Total serveur', value: `**${server.bumpCount}**`, inline: true },
              { name: '🔥 Streak', value: `**${server.bumpStreak}** jour(s)`, inline: true },
              { name: '💰 Coins gagnés', value: `**${userStats?.coinsEarned || 0}**`, inline: true },
              { name: '⏰ Prochain bump', value: ready ? '✅ Disponible !' : `<t:${nextTs}:R>`, inline: true },
            )
            .setFooter({ text: 'REZO • Stats rapides' })
            .setTimestamp();
          return interaction.editReply({ embeds: [embed] });
        } catch (err) {
          return interaction.editReply({ content: 'Utilisez `/stats serveur` pour voir les statistiques.' });
        }
      }

      // Captcha — rapport de vérification douteuse : décision du staff
      if (id.startsWith('cap_report_')) {
        const { handleReportButton } = require('../../commands/configuration/captcha');
        await handleReportButton(interaction).catch(console.error);
        return;
      }

      // Captcha — bouton répondre
      if (id.startsWith('captcha_answer_')) {
        const { verifyCaptcha } = require('../../commands/configuration/captcha');
        await verifyCaptcha(interaction).catch(console.error);
        return;
      }
      // Captcha — bouton régénérer l'image
      if (id.startsWith('captcha_regen_')) {
        const { handleRegenerate } = require('../../commands/configuration/captcha');
        await handleRegenerate(interaction).catch(console.error);
        return;
      }

      // Help — centre d'aide : allowlist explicite des boutons du panel, plus
      // les deux familles paramétrées (pagination et retour catégorie).
      // (Volontairement pas un `startsWith('help_')` : un futur id help_* géré
      //  ailleurs ne doit pas être avalé ici.)
      if (['help_home', 'help_search', 'help_random', 'help_whatsnew', 'help_license', 'help_access', 'help_diag'].includes(id)
        || id.startsWith('help_page_') || id.startsWith('help_back')) {
        const cmd = client.commands.get('help');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Botinfo — panel d'identité technique : sélecteur, rafraîchissement,
      // fermeture. Le préfixe `bi_` est réservé au panel (cf. botinfo.js).
      if (id.startsWith('bi_')) {
        const cmd = client.commands.get('botinfo');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Anniversaires — boutons du panneau /anniversaire-config (persistant)
      if (id.startsWith('bd_')) {
        const cmd = client.commands.get('anniversaire-config');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Vote serveur
      if (id.startsWith('vote_')) {
        const Vote   = require('../../models/Vote');
        const Server = require('../../models/Server');
        const { successEmbed, errorEmbed } = require('../../utils/embeds');
        const targetGuildId = id.split('_')[1];
        try {
          await Vote.create({ voterId: interaction.user.id, targetId: targetGuildId });
          await Server.findOneAndUpdate({ guildId: targetGuildId }, { $inc: { totalVotes: 1 } });
          return interaction.reply({ embeds: [successEmbed('Vote enregistré !', 'Merci pour votre vote ! 👍')], ephemeral: true });
        } catch (e) {
          if (e.code === 11000) return interaction.reply({ embeds: [require('../../utils/embeds').errorEmbed('Déjà voté', 'Vous avez déjà voté pour ce serveur aujourd\'hui !')], ephemeral: true });
          return interaction.reply({ embeds: [require('../../utils/embeds').errorEmbed('Erreur', 'Une erreur est survenue.')], ephemeral: true });
        }
      }

      // Giveaway — tous les boutons persistants du message giveaway
      if (id.startsWith('gw_join_')) {
        const giveawayId = id.replace('gw_join_', '');
        const cmd = client.commands.get('giveaway');
        if (cmd?.handleJoin) await cmd.handleJoin(interaction, giveawayId).catch(console.error);
        return;
      }
      if (id.startsWith('gw_list_')) {
        const giveawayId = id.replace('gw_list_', '');
        const cmd = client.commands.get('giveaway');
        if (cmd?.handleListButton) await cmd.handleListButton(interaction, giveawayId).catch(console.error);
        return;
      }
      if (id.startsWith('gw_info_')) {
        const giveawayId = id.replace('gw_info_', '');
        const cmd = client.commands.get('giveaway');
        if (cmd?.handleInfoButton) await cmd.handleInfoButton(interaction, giveawayId).catch(console.error);
        return;
      }
      if (id.startsWith('gw_reroll_')) {
        const giveawayId = id.replace('gw_reroll_', '');
        const cmd = client.commands.get('giveaway');
        if (cmd?.handleRerollButton) await cmd.handleRerollButton(interaction, giveawayId).catch(console.error);
        return;
      }
      if (id.startsWith('gw_cancel_')) {
        const giveawayId = id.replace('gw_cancel_', '');
        const cmd = client.commands.get('giveaway');
        if (cmd?.handleCancelButton) await cmd.handleCancelButton(interaction, giveawayId).catch(console.error);
        return;
      }


      // Confessions — panneau staff (confv_), modération et réponses anonymes
      if (id.startsWith('conf_') || id.startsWith('confv_')) {
        const cmd = client.commands.get('confession');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Studio d'embeds — boutons publiés (rôle, réponse, ticket)
      if (id.startsWith('es_btn:')) {
        const cmd = client.commands.get('embed');
        if (cmd?.handleEmbedButton) await cmd.handleEmbedButton(interaction).catch(console.error);
        return;
      }

      // Ticket — boutons du salon de ticket et des tickets fermés.
      // Toute la logique vit dans la commande unique /ticket (aucune sous-commande).
      if (id.startsWith('ticket_claim_')    || id.startsWith('ticket_priority_') ||
          id.startsWith('ticket_close_btn_')|| id.startsWith('ticket_reopen_')   ||
          id.startsWith('ticket_delete_')   || id.startsWith('ticket_rate_')) {
        const cmd = client.commands.get('ticket');
        if (!cmd) return;
        if (id.startsWith('ticket_claim_')     && cmd.handleClaimButton)    return cmd.handleClaimButton(interaction, client).catch(console.error);
        if (id.startsWith('ticket_priority_')  && cmd.handlePriorityButton) return cmd.handlePriorityButton(interaction, client).catch(console.error);
        if (id.startsWith('ticket_close_btn_') && cmd.handleCloseButton)    return cmd.handleCloseButton(interaction, client).catch(console.error);
        if (id.startsWith('ticket_reopen_')    && cmd.handleReopen)         return cmd.handleReopen(interaction, client).catch(console.error);
        if (id.startsWith('ticket_delete_')    && cmd.handleDelete)         return cmd.handleDelete(interaction, client).catch(console.error);
        if (id.startsWith('ticket_rate_')      && cmd.handleRate)           return cmd.handleRate(interaction, client).catch(console.error);
        return;
      }

      // Support vocal — panneau public (sv_open), cartes de demande
      // (sv_join_* / sv_claim_* / sv_close_*) et bouton « Configurer » (sv_info_setup).
      if (id.startsWith('sv_')) {
        const cmd = client.commands.get('support-vocal');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Poll
      if (id.includes('_vote_') || id.includes('_end')) {
        const cmd = client.commands.get('poll');
        if (!cmd?.handlePollInteraction) return;
        const match = id.match(/^(poll_\d+_\d+)_(vote_(\d+)|end)$/);
        if (!match) return;
        const pollId = match[1];
        const type   = match[2].startsWith('vote') ? 'vote' : 'end';
        const choice = type === 'vote' ? parseInt(match[3]) : null;
        await cmd.handlePollInteraction(interaction, pollId, type, choice).catch(console.error);
        return;
      }

      // Ouvrir /topserveurs depuis un bouton
      if (id === 'topserv_open') {
        const cmd = client.commands.get('topserveurs');
        if (cmd) await cmd.execute(interaction, client).catch(console.error);
        return;
      }

      // Réseau top serveurs — naviguer
      if (id.startsWith('topserv_')) {
        const cmd = client.commands.get('topserveurs');
        if (cmd?.handleButton) await cmd.handleButton(interaction).catch(console.error);
        return;
      }

      // Carte de rang personnelle — boutons du panneau /rank (rcp_*)
      // (les boutons de la carte du serveur `lvlcard_*` sont gérés par le
      // collecteur interne de /leveling)
      if (id.startsWith('rcp_')) {
        const cmd = client.commands.get('rank');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Menu de rôles — boutons de l'éditeur unique (rmnedit:pub · rmnedit:fermer)
      if (id.startsWith('rmnedit:')) {
        const cmd = client.commands.get('rolemenu');
        if (cmd?.handleEditorButton) await cmd.handleEditorButton(interaction, client).catch(console.error);
        return;
      }

      // Menu de rôles — boutons du panneau public /rolemenu (rmn:<menu>:<role>)
      // Le panneau est persistant : chaque clic relit l'état en base, donc les
      // rôles restent distribuables après un redémarrage du bot.
      if (id.startsWith('rmn:')) {
        const cmd = client.commands.get('rolemenu');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Starter Pack — boutons du panneau /starterpack (sp_*)
      // Le gate licence est refait dans handleButton : le panneau peut être
      // cliqué après l'expiration d'un essai gratuit.
      if (id.startsWith('sp_')) {
        const cmd = client.commands.get('starterpack');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Musique — panneau public (transport, file, réglages) : mus_*
      if (id.startsWith('mus_')) {
        const cmd = client.commands.get('musique');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Radio — panneau public, favoris, catalogue, réglages : rad_*
      if (id.startsWith('rad_')) {
        const cmd = client.commands.get('radio');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }

      // Carte interactive — déplacement / zoom / style : map_*
      // La vue est encodée dans le customId, donc le panneau survit à un
      // redémarrage du bot ; le libellé du lieu, lui, est cosmétique.
      if (id.startsWith('map_')) {
        const cmd = client.commands.get('carte');
        if (cmd?.handleButton) await cmd.handleButton(interaction, client).catch(console.error);
        return;
      }
    }

    // ── StringSelectMenu ──────────────────────────────────────────────────
    if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;

      // Portail d'accès — menu de rôles d'une étape
      if (id.startsWith('ob_roles:')) {
        const { handleStepInteraction } = require('../../utils/onboardingManager');
        await handleStepInteraction(interaction).catch(console.error);
        return;
      }

      if (id.startsWith('auth_')) {
        const cmd = client.commands.get('authentificator');
        if (cmd?.handleSelectMenu) await cmd.handleSelectMenu(interaction).catch(console.error);
        return;
      }
      if (id === 'help_category') {
        const cmd = client.commands.get('help');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction).catch(console.error);
        return;
      }

      // Menu de rôles — liste de l'éditeur unique (rmnedit:f)
      if (id === 'rmnedit:f') {
        const cmd = client.commands.get('rolemenu');
        if (cmd?.handleEditorSelect) await cmd.handleEditorSelect(interaction, client).catch(console.error);
        return;
      }

      // Menu de rôles — menu déroulant du panneau public (rmnsel:<menu>)
      if (id.startsWith('rmnsel:')) {
        const cmd = client.commands.get('rolemenu');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction, client).catch(console.error);
        return;
      }

      // Musique — menu de saut dans la file et sélection du rôle DJ
      if (id === 'mus_jump' || id === 'mus_dj') {
        const cmd = client.commands.get('musique');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction, client).catch(console.error);
        return;
      }
      if (id === 'help_docs') {
        const cmd = client.commands.get('help');
        if (cmd?.handleDocsSelect) await cmd.handleDocsSelect(interaction).catch(console.error);
        return;
      }
      if (id === 'help_cmd') {
        const cmd = client.commands.get('help');
        if (cmd?.handleCommandSelect) await cmd.handleCommandSelect(interaction).catch(console.error);
        return;
      }
      if (id === 'help_result') {
        const cmd = client.commands.get('help');
        if (cmd?.handleResultSelect) await cmd.handleResultSelect(interaction).catch(console.error);
        return;
      }

      // Botinfo — menu de navigation entre les vues du panel (bi_select)
      if (id === 'bi_select') {
        const cmd = client.commands.get('botinfo');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction, client).catch(console.error);
        return;
      }

      if (id.startsWith('sondage_vote_')) {
        const pollId = id.replace('sondage_vote_', '');
        if (pollId === 'temp') return;
        const cmd = client.commands.get('sondage');
        const choiceIdx = parseInt(interaction.values[0]);
        if (cmd?.handleVote) await cmd.handleVote(interaction, pollId, choiceIdx).catch(console.error);
        return;
      }
      if (id === 'lb_switch') return;

      // Support vocal — panneau de configuration (collecteur interne de la commande)
      if (id.startsWith('svs_')) return;

      // Studio d'embeds — sélection du rôle d'un bouton
      if (id.startsWith('es_attach_role:')) {
        const cmd = client.commands.get('embed');
        if (cmd?.handleStudioRoleSelect) await cmd.handleStudioRoleSelect(interaction).catch(console.error);
        return;
      }

      // Ticket — menu d'ouverture du panel public (ticket_open:<panelKey>)
      if (id.startsWith('ticket_open')) {
        const cmd = client.commands.get('ticket');
        if (cmd?.handleOpenSelect) await cmd.handleOpenSelect(interaction, client).catch(console.error);
        return;
      }

      // Inter-serveur — sélection réseau (réseau publics)
      if (id === 'topserv_filter') {
        // géré par le collecteur interne de topserveurs.js
        return;
      }

            // News — menus config (gérés par collecteur interne)
      if (id === 'news_config_action' || id.startsWith('news_ch_')) return;

      // FreeGames — menus config (gérés par collecteur interne)
      if (id === 'fg_config_action' || id === 'fg_set_channel' || id === 'fg_set_role') return;

      // Notifications — menus config (gérés par collecteur interne)
      if (id === 'notif_config_action' || id === 'notif_set_panel_channel' || id === 'notif_set_log_channel') return;

      // ModMail — select menus (snippets, config)
      if (id.startsWith('mm_snippet_select_') || id === 'mm_config_action') {
        const cmd = client.commands.get('modmail');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction, client).catch(console.error);
        return;
      }

      // Panneau sécurité — menus (gérés par collecteur interne de securite.js)
      if (id === 'sec_menu' || id === 'sec_links_action' || id === 'sec_mention_action' || id === 'sec_wf_level') {
        return; // collecteur interne
      }
      if (id.startsWith('sec_vault_')) return; // coffre-fort — collecteur interne
    }

    // ── SelectMenu génériques (gérés par collecteurs internes) ───────────
    if (interaction.isAnySelectMenu()) {
      const id = interaction.customId;

      // Radio — station, filtre de genre, favoris, salons et rôle DJ
      if (id.startsWith('rad_')) {
        const cmd = client.commands.get('radio');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction, client).catch(console.error);
        return;
      }

      // Profil utilisateur — menus du panel /profile (visibilité, badges épinglés)
      if (id.startsWith('prf_sel_')) {
        const cmd = client.commands.get('profile');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction, client).catch(console.error);
        return;
      }

      // Honeypot v3 — tous les menus du panel (string + channel selects, routage persistant)
      if (id.startsWith('_hp_')) {
        const cmd = client.commands.get('honeypot');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction, client).catch(console.error);
        return;
      }

      // Anniversaires — sélecteurs salon / rôle du panneau /anniversaire-config
      if (id.startsWith('bd_')) {
        const cmd = client.commands.get('anniversaire-config');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction, client).catch(console.error);
        return;
      }

      // YouTube Sub Alert — sélecteurs salon et rôle (persistants)
      if (id.startsWith('ysub_set_channel:') || id.startsWith('ysub_set_role:')) {
        const cmd = client.commands.get('youtube-sub');
        if (cmd?.handleSelect) await cmd.handleSelect(interaction).catch(console.error);
        return;
      }

      // YouTube Sub Alert — menus d'action et sélection chaîne (collecteur interne)
      if (id === 'ysub_select_chain' || id.startsWith('ysub_config_action:')) return;

      const internalIds = [
        'config_category','config_language','config_bump_channel','config_feed_channel','config_log_channel','config_bump_role',
        'captcha_channel_select','captcha_role_before_select','captcha_role_after_select','captcha_security_select',
        'captcha_log_channel_select','captcha_bypass_role_select',
        'panel_category','panel_module',
        'panel_console','panel_exec', // Console et exécution du /setting (collecteur interne)
        'panel_protection', // Centre de protection du /setting (collecteur interne)
        'lb_switch',
        'autothread_panel_action','autothread_select_include','autothread_select_exclude','autothread_select_role',
        'logsconfig_panel_category','logsconfig_select_channel','xpconfig_panel_action',
        'fw_select_forum',
        'sb_select_channel','sb_select_ignored_channels','sb_select_ignored_roles',
        'rd_select','rd_select_channel','rd_select_role','rd_select_sort',
        'ob_page_','ob_select_','ob_question_','ob_preview','ob_toggle_','ob_settings','ob_messages',
        'ob_add_question','ob_manage_questions','ob_close',
        'ob_select_category','ob_select_access_role','ob_select_question',
        'avispanel_',
        'bumpnotif_',
        'invlb_', // pagination du classement /invites — collecteur interne
        'mpreq_',
        'wr_', // Salon d'attente — menus du panel /waitingroom (collecteur interne)
      ];
      if (internalIds.some(iid => id === iid || id.startsWith(iid))) return;
    }
  },
};
