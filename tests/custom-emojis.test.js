'use strict';
// tests/custom-emojis.test.js — Emojis animés importés sur l'application
// Discord (`scripts/import-emojis.js` → `src/data/appEmojis.json`).
//
// Règles produit vérifiées ici :
//   • aucun emoji Unicode ne subsiste dans un embed au rendu ;
//   • les boutons n'affichent aucun emoji, ni Unicode ni custom ;
//   • les menus de sélection n'ont que des emojis animés du bot ;
//   • sans registre importé, rien ne casse (les emojis disparaissent).

const assert = require('assert');
const fs = require('fs');
const emojis = require('../src/utils/emojiSync');
const ui = require('../src/utils/ui');

function readRegistry() {
  try {
    const parsed = JSON.parse(fs.readFileSync(emojis.REGISTRY_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

const registry = readRegistry();
const PICTOGRAPH = /\p{Extended_Pictographic}/u;

function componentIds(rows) {
  return rows.flatMap(row => row.toJSON().components.map(component => component.custom_id));
}

const checks = [
  {
    name: 'le registre d’emojis est cohérent quand il existe',
    run() {
      if (!registry) return; // import pas encore lancé : rien à vérifier
      const entries = Object.entries(registry);
      assert.ok(entries.length >= 20, `${entries.length} entrées, 20 attendues au minimum`);
      const ids = new Set();
      for (const [name, entry] of entries) {
        assert.ok(/^[a-z0-9_]{2,32}$/.test(name), `nom Discord invalide : ${name}`);
        assert.ok(/^\d{15,25}$/.test(String(entry.id)), `identifiant invalide pour ${name}`);
        assert.ok(!ids.has(entry.id), `identifiant dupliqué : ${entry.id}`);
        ids.add(entry.id);
        assert.strictEqual(typeof entry.animated, 'boolean', `${name} : animated booléen`);
      }
    },
  },
  {
    name: 'un nom logique produit une balise, jamais un emoji Unicode',
    run() {
      const entry = emojis.emojiEntry('check');
      const tag = emojis.getAppEmoji('check');
      if (entry) {
        assert.strictEqual(tag, `<${entry.animated ? 'a' : ''}:rezo_valide:${entry.id}>`);
        assert.deepStrictEqual(emojis.emojiObject('check'), entry);
      }
      assert.strictEqual(emojis.getAppEmoji('inconnu_total'), '');
      assert.strictEqual(emojis.getAppEmoji(undefined), '');
      assert.strictEqual(emojis.emojiEntry('inconnu_total'), null);
      for (const key of Object.keys(emojis.CUSTOM)) {
        assert.ok(!PICTOGRAPH.test(emojis.getAppEmoji(key)), `« ${key} » rend encore un emoji Unicode`);
      }
    },
  },
  {
    name: 'un emoji Unicode est converti, un inconnu est retiré',
    run() {
      const converted = emojis.replaceUnicode('✅ Terminé');
      if (emojis.emojiEntry('check')) {
        assert.ok(converted.includes('rezo_valide'), 'succès converti en emoji animé');
        assert.ok(!PICTOGRAPH.test(converted));
      } else {
        assert.strictEqual(converted, 'Terminé');
      }

      assert.strictEqual(emojis.replaceUnicode('🦄 Licorne'), 'Licorne');
      assert.strictEqual(emojis.replaceUnicode('🦄'), '');
      assert.strictEqual(emojis.replaceUnicode('texte simple'), 'texte simple');
      assert.strictEqual(emojis.replaceUnicode(''), '');
      assert.strictEqual(emojis.replaceUnicode(null), null);

      // Les glyphes de marque ne sont pas des emojis et survivent.
      assert.strictEqual(emojis.replaceUnicode('▰▰▱▱ • REZO'), '▰▰▱▱ • REZO');
    },
  },
  {
    name: 'les boutons perdent tous leurs emojis',
    run() {
      ui.installGlobalTheme();
      const { ButtonBuilder, ButtonStyle } = require('discord.js');

      const unicode = new ButtonBuilder()
        .setCustomId('test_unicode')
        .setLabel('🔄 Actualiser')
        .setStyle(ButtonStyle.Secondary)
        .toJSON();
      assert.strictEqual(unicode.label, 'Actualiser');
      assert.strictEqual(unicode.emoji, undefined);

      const custom = new ButtonBuilder()
        .setCustomId('test_custom')
        .setLabel('Installer')
        .setEmoji({ id: '123456789012345678', name: 'rezo_cone', animated: true })
        .setStyle(ButtonStyle.Success)
        .toJSON();
      assert.strictEqual(custom.emoji, undefined, 'un setEmoji() manuel est retiré au rendu');
      assert.strictEqual(custom.label, 'Installer');

      assert.strictEqual(emojis.stripEmojis('🚀 Lancer'), 'Lancer');
      assert.strictEqual(emojis.stripEmojis('<a:rezo_fleche:123> Commencer'), 'Commencer');
      assert.strictEqual(emojis.stripEmojis('Texte normal'), 'Texte normal');
    },
  },
  {
    name: 'les menus de sélection n’exposent que des emojis animés du bot',
    run() {
      ui.installGlobalTheme();
      const { StringSelectMenuOptionBuilder, StringSelectMenuBuilder } = require('discord.js');

      const fromUnicode = new StringSelectMenuOptionBuilder()
        .setLabel('Statistiques')
        .setValue('stats')
        .setEmoji('📊')
        .toJSON();
      if (emojis.emojiEntry('calc')) {
        assert.strictEqual(fromUnicode.emoji.name, 'rezo_calcul');
        assert.ok(fromUnicode.emoji.id);
        assert.strictEqual(fromUnicode.emoji.animated, true);
      }

      const foreign = new StringSelectMenuOptionBuilder()
        .setLabel('Étranger')
        .setValue('foreign')
        .setEmoji({ id: '999999999999999999', name: 'autre_bot' })
        .toJSON();
      assert.strictEqual(foreign.emoji, undefined, 'un emoji d’un autre bot est retiré');

      const menu = new StringSelectMenuBuilder()
        .setCustomId('test_menu')
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel('Un').setValue('1').setEmoji('✅'),
          new StringSelectMenuOptionBuilder().setLabel('Deux').setValue('2').setEmoji('🦄'),
        )
        .toJSON();
      if (emojis.emojiEntry('check')) {
        assert.strictEqual(menu.options[0].emoji.name, 'rezo_valide');
      }
      assert.strictEqual(menu.options[1].emoji, undefined, 'aucun équivalent : rien');
    },
  },
  {
    name: 'chaque emoji Unicode mappé renvoie vers un nom connu',
    run() {
      for (const [glyph, key] of Object.entries(emojis.UNICODE_TO_KEY)) {
        assert.ok(emojis.CUSTOM[key], `${glyph} pointe vers un nom logique inconnu : ${key}`);
        assert.ok(PICTOGRAPH.test(glyph), `« ${glyph} » n’est pas un pictogramme remplaçable`);
      }
    },
  },
  {
    name: 'les panneaux d’installation respectent les deux règles',
    run() {
      ui.installGlobalTheme();
      const hub = require('../src/utils/setupHub');
      const embed = hub.buildStartEmbed({ guild: { name: 'Serveur ✅ de test' }, client: null }).toJSON();

      assert.ok(embed.title.includes('Installer REZO'));
      assert.ok(!PICTOGRAPH.test(embed.title), 'titre sans emoji Unicode');
      assert.ok(!PICTOGRAPH.test(embed.description || ''), 'description sans emoji Unicode');
      for (const field of embed.fields || []) {
        assert.ok(!PICTOGRAPH.test(field.name), `champ sans emoji Unicode : ${field.name}`);
        assert.ok(!PICTOGRAPH.test(field.value), `valeur sans emoji Unicode : ${field.value}`);
      }
      if (emojis.emojiEntry('arrow')) assert.ok(embed.title.includes('rezo_fleche'));

      for (const row of hub.buildStartRow().toJSON().components) {
        assert.strictEqual(row.emoji, undefined, `bouton « ${row.label} » sans emoji`);
        assert.ok(!PICTOGRAPH.test(row.label));
      }

      // Menu de sélection : chaque option porte un emoji animé, ou aucun.
      const score = {
        percent: 20, activeCount: 1, moduleCount: 3,
        missing: [
          { key: 'welcome', label: 'Bienvenue', hint: 'Accueillir', auto: true },
          { key: 'tickets', label: 'Tickets', hint: 'Support', auto: false },
        ],
        categories: [],
      };
      const rows = hub.buildInstallerComponents({ score, plan: { blocked: [] } });
      const select = rows[0].toJSON().components[0];
      assert.strictEqual(select.custom_id, 'setup_pick');
      if (emojis.emojiEntry('arrow')) {
        assert.strictEqual(select.options[0].emoji.name, 'rezo_fleche');
        assert.strictEqual(select.options[1].emoji.name, 'rezo_punaise');
      }
      for (const option of select.options) {
        if (option.emoji) {
          assert.ok(option.emoji.id);
          assert.ok(option.emoji.name.startsWith('rezo_'));
        }
      }
      // Les boutons du programme, eux, n'en portent aucun.
      for (const button of rows[1].toJSON().components) {
        assert.strictEqual(button.emoji, undefined, `bouton « ${button.label} » sans emoji`);
      }
    },
  },
  {
    name: 'le panneau anti-ping respecte les deux règles',
    run() {
      ui.installGlobalTheme();
      const command = require('../src/commands/securite/antiping');
      const engine = require('../src/utils/pingGuardEngine');
      const panel = command.buildPanel('main', {
        doc: { stats: {}, recent: [] },
        config: engine.normalizeConfig({}),
        guild: { name: 'Test', members: { cache: new Map() }, roles: { cache: new Map() } },
        guildName: 'Test',
        pending: 0,
      });
      const embed = panel.embeds[0].toJSON();
      const texts = [embed.title, embed.description || '', ...(embed.fields || []).flatMap(f => [f.name, f.value])];
      for (const text of texts) assert.ok(!PICTOGRAPH.test(text), `emoji Unicode restant : ${text}`);

      const components = panel.components.flatMap(row => row.toJSON().components);
      const buttons = components.filter(component => component.type === 2);
      assert.ok(buttons.length >= 2, 'le panneau a bien des boutons');
      for (const button of buttons) {
        assert.strictEqual(button.emoji, undefined, `bouton « ${button.label} » sans emoji`);
      }

      const menu = components.find(component => component.type === 3);
      assert.strictEqual(menu.custom_id, 'ap_menu');
      if (emojis.emojiEntry('shield')) {
        assert.strictEqual(menu.options[0].emoji.name, 'rezo_bouclier');
        for (const option of menu.options) {
          assert.ok(option.emoji && option.emoji.id, `option « ${option.label} » sans emoji animé`);
          assert.ok(option.emoji.name.startsWith('rezo_'));
        }
      }
      assert.ok(componentIds(panel.components).includes('ap_menu'));
    },
  },
];

module.exports = { checks };
