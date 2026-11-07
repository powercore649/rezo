'use strict';
// utils/safeSave.js — Écriture de document tolérante aux clics simultanés.
//
// Mongoose vérifie le numéro de version (`__v`) à chaque `save()` d'un document
// existant. Deux interactions rapprochées — deux boutons cliqués coup sur coup,
// deux modaux validés en parallèle — chargent le même document : la seconde
// écriture échoue alors avec `VersionError` et le réglage est perdu.
//
// Sur un panneau de configuration, le comportement attendu est « la dernière
// écriture gagne ». On réapplique donc uniquement les champs modifiés, sans
// filtre de version, au lieu de laisser la modification de l'utilisateur
// échouer.

/**
 * Enregistre un document Mongoose ; si la version a changé entre-temps,
 * réapplique les seuls champs modifiés (dernière écriture gagnante).
 *
 * @param {import('mongoose').Document} doc
 * @returns {Promise<import('mongoose').Document>} document à jour
 */
async function saveDoc(doc) {
  try {
    return await doc.save();
  } catch (err) {
    if (err?.name !== 'VersionError') throw err;

    const update = {};
    for (const p of doc.modifiedPaths()) {
      // `$set` du parent couvre déjà ses sous-champs ; demander les deux
      // ferait échouer MongoDB pour conflit de chemin (« wordFilter » et
      // « wordFilter.high » ne peuvent pas être écrits ensemble).
      if (p.includes('.')) continue;
      const value = doc.get(p);
      update[p] = typeof value?.toObject === 'function' ? value.toObject() : value;
    }
    if (!Object.keys(update).length) return doc;

    const fresh = await doc.constructor.findOneAndUpdate(
      { _id: doc._id },
      { $set: update },
      { new: true },
    );
    return fresh || doc;
  }
}

module.exports = { saveDoc };
