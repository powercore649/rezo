'use strict';
// tests/canvas-fallback.test.js — un binaire canvas absent ne doit rien casser.
//
// Sur un hôte sans le paquet natif de la plateforme, `require('@napi-rs/canvas')`
// lève. Sans repli, les commandes et l'événement d'arrivée qui l'importent en
// haut de fichier disparaissent purement et simplement du bot. Ces
// vérifications garantissent que le moteur neutre prend le relais et reste
// utilisable (image PNG valide, mesures numériques, dégradés inoffensifs).

const assert = require('assert');

const {
  installCanvasStub, resetCanvasStub, isStubbed, isCanvasLoadError,
  prepareCanvas, BLANK_PNG,
} = require('../src/utils/canvasFallback');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const checks = [
  {
    name: 'l’image de secours est un PNG valide',
    run() {
      assert.ok(BLANK_PNG.subarray(0, 8).equals(PNG_SIGNATURE), 'signature PNG absente');
      assert.ok(BLANK_PNG.includes(Buffer.from('IEND')), 'chunk IEND absent');
    },
  },
  {
    name: 'le moteur de secours remplace canvas et dessine sans lever',
    run() {
      installCanvasStub({ reason: 'test', quiet: true });
      try {
        const canvasModule = require('@napi-rs/canvas');
        assert.strictEqual(canvasModule.__stub, true, 'le vrai module natif a été chargé');

        const canvas = canvasModule.createCanvas(300, 120);
        assert.strictEqual(canvas.width, 300);
        assert.strictEqual(canvas.height, 120);

        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#123456';
        ctx.fillRect(0, 0, 10, 10);
        ctx.beginPath();
        ctx.arc(5, 5, 3, 0, Math.PI * 2);
        ctx.fill();
        const width = ctx.measureText('bonjour').width;
        assert.strictEqual(typeof width, 'number', 'measureText doit rendre un nombre');
        ctx.createLinearGradient(0, 0, 10, 10).addColorStop(0, '#fff');
        assert.strictEqual(ctx.isPointInPath(1, 1), false);

        const png = canvas.toBuffer('image/png');
        assert.ok(Buffer.isBuffer(png) && png.subarray(0, 8).equals(PNG_SIGNATURE), 'sortie non PNG');
        assert.match(canvas.toDataURL(), /^data:image\/png;base64,/);
      } finally {
        resetCanvasStub();
      }
    },
  },
  {
    name: 'MEDIA_CARDS=0 active le repli sans charger le natif',
    run() {
      const previous = process.env.MEDIA_CARDS;
      process.env.MEDIA_CARDS = '0';
      try {
        assert.strictEqual(prepareCanvas(process.env), true);
        assert.strictEqual(isStubbed(), true);
      } finally {
        if (previous === undefined) delete process.env.MEDIA_CARDS;
        else process.env.MEDIA_CARDS = previous;
        resetCanvasStub();
      }
      assert.strictEqual(isStubbed(), false);
    },
  },
  {
    name: 'les erreurs de chargement canvas sont reconnues, les autres non',
    run() {
      assert.strictEqual(isCanvasLoadError(new Error('Cannot find native binding. npm has a bug…')), true);
      assert.strictEqual(isCanvasLoadError(new Error("Cannot find module '@napi-rs/canvas'")), true);
      assert.strictEqual(isCanvasLoadError(new Error('ECONNREFUSED 127.0.0.1:27017')), false);
      assert.strictEqual(isCanvasLoadError(null), false);
    },
  },
  {
    name: 'après reset, le vrai module canvas est rendu aux require suivants',
    run() {
      assert.strictEqual(isStubbed(), false);
      let canvasModule;
      try {
        canvasModule = require('@napi-rs/canvas');
      } catch {
        return; // hôte sans binaire natif : le repli est le comportement attendu
      }
      assert.ok(!canvasModule.__stub, 'le moteur de secours est resté installé');
      assert.strictEqual(typeof canvasModule.createCanvas, 'function');
    },
  },
];

module.exports = { checks };
