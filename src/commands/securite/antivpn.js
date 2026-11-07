'use strict';
// commands/securite/antivpn.js — Commande dédiée à l'anti-VPN.
//
// L'anti-VPN a son propre panneau persistant (utils/antiVpnPanel.js, composants
// `avpn_*` routés par events/interactionCreate.js). Il ne dépend plus de
// /securite : la commande ouvre directement la configuration avancée.
//
// Aucune décision de filtrage n'est prise ici : le panneau écrit la politique,
// utils/antiVpnFlow.js l'applique à l'arrivée des membres.
//
// Fonctionnalité sous licence : `antivpn` figure dans LICENSE_REQUIRED_COMMANDS
// (utils/licenseGate.js). Le routeur bloque la commande, et le panneau revérifie
// l'accès à chaque interaction pour couvrir /setting et les boutons persistants.

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const panel = require('../../utils/antiVpnPanel');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('antivpn')
    .setDescription('🛰️ Anti-VPN (sous licence) — détection, sanctions, portail, historique')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),

  async execute(interaction) {
    return panel.open(interaction);
  },
};
