// utils/bookExport.js — Génération de fichiers exportables pour /livre exporter

function buildTextContent(book) {
  const lines = [];
  lines.push('='.repeat(50));
  lines.push(book.title.toUpperCase());
  if (book.description) lines.push(book.description);
  lines.push('='.repeat(50));
  lines.push('');

  const chapters = [...book.chapters].sort((a, b) => a.order - b.order);

  if (!chapters.length) {
    lines.push('(Ce livre ne contient encore aucun chapitre.)');
  } else {
    lines.push('SOMMAIRE');
    chapters.forEach((c, i) => lines.push(`  ${i + 1}. ${c.title}`));
    lines.push('');

    chapters.forEach((c, i) => {
      lines.push('-'.repeat(50));
      lines.push(`Chapitre ${i + 1} — ${c.title}`);
      lines.push('-'.repeat(50));
      lines.push(c.content);
      lines.push('');
    });
  }

  lines.push('='.repeat(50));
  lines.push(`Exporté le ${new Date().toLocaleString('fr-FR')}`);
  return lines.join('\n');
}

/**
 * Tente de générer un PDF via pdfkit. Si le module n'est pas installé,
 * renvoie null pour que l'appelant puisse retomber sur l'export texte.
 */
async function buildPdfBuffer(book) {
  let PDFDocument;
  try {
    PDFDocument = require('pdfkit');
  } catch {
    return null; // pdfkit non installé — fallback texte géré par l'appelant
  }

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50 });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(24).text(book.title, { align: 'center' });
      if (book.description) {
        doc.moveDown(0.5).fontSize(12).fillColor('#666666').text(book.description, { align: 'center' });
        doc.fillColor('#000000');
      }
      doc.moveDown(2);

      const chapters = [...book.chapters].sort((a, b) => a.order - b.order);

      if (!chapters.length) {
        doc.fontSize(12).text('(Ce livre ne contient encore aucun chapitre.)');
      } else {
        doc.fontSize(16).text('Sommaire', { underline: true });
        doc.moveDown(0.5);
        chapters.forEach((c, i) => doc.fontSize(11).text(`${i + 1}. ${c.title}`));
        doc.addPage();

        chapters.forEach((c, i) => {
          if (i > 0) doc.addPage();
          doc.fontSize(18).text(`${i + 1}. ${c.title}`, { underline: true });
          doc.moveDown();
          doc.fontSize(11).text(c.content, { align: 'left' });
        });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { buildTextContent, buildPdfBuffer };
