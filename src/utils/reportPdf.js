// PDF version of a custom report (landscape A4, repeating header row, group sections).
// pdfkit is required by path: it only declares package "exports", which the .exe packager cannot follow.
function loadPdfKit() {
  try { return require('../../node_modules/pdfkit/js/pdfkit.js'); } catch (e) { return require('pdfkit'); }
}

const MARGIN = 28;
const ROW_PAD = 4;

function renderPdf(res, report, meta) {
  const PDFDocument = loadPdfKit();
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN, bufferPages: true });
  doc.pipe(res);

  const pageW = doc.page.width - MARGIN * 2;
  const weights = report.columns.map(c => c.width);
  const totalW = weights.reduce((a, b) => a + b, 0) || 1;
  const widths = weights.map(w => (w / totalW) * pageW);
  const xs = widths.reduce((acc, w, i) => { acc.push(i === 0 ? MARGIN : acc[i - 1] + widths[i - 1]); return acc; }, []);
  const bottom = () => doc.page.height - MARGIN - 18;

  // ---- title block ----
  if (meta.logo) {
    try { doc.image(meta.logo.buffer, MARGIN + pageW - 170, MARGIN - 4, { fit: [170, 48], align: 'right' }); } catch (e) { /* unreadable image: skip it */ }
  }
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(18).text(meta.title, MARGIN, MARGIN, { width: pageW - 180 });
  doc.font('Helvetica').fontSize(9).fillColor('#6b7280');
  doc.text(`Generated ${meta.generated} by ${meta.by}`, MARGIN, doc.y + 2);
  const lines = [];
  if (report.filters.length) lines.push('Filters: ' + report.filters.join('  |  '));
  else lines.push('Filters: none (all tickets you can see)');
  lines.push(`Grouped by: ${report.groupLabel}   |   Sorted by: ${report.sortLabel}`);
  if (meta.scopeNote) lines.push(meta.scopeNote);
  lines.forEach(l => doc.text(l, MARGIN, doc.y + 1, { width: pageW }));
  const s = report.summary;
  if (doc.y < MARGIN + 56) doc.y = MARGIN + 56; // keep clear of the logo
  doc.font('Helvetica-Bold').fillColor('#111827').fontSize(10)
    .text(`${s.count} ticket${s.count === 1 ? '' : 's'}  ·  ${s.open} open  ·  ${s.finished} finished` +
      (s.avgTime ? `  ·  average time to resolve ${s.avgTime}` : '') + (s.slaRate !== null ? `  ·  ${s.slaRate}% within SLA` : ''),
      MARGIN, doc.y + 6, { width: pageW });
  doc.moveDown(0.6);

  function headerRow() {
    const y = doc.y;
    doc.save().rect(MARGIN, y, pageW, 20).fill('#1f2937').restore();
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
    report.columns.forEach((c, i) => doc.text(c.label, xs[i] + 3, y + 6, { width: widths[i] - 6, lineBreak: false, ellipsis: true }));
    doc.y = y + 22;
  }

  function ensure(h, withHeader = true) {
    if (doc.y + h > bottom()) {
      doc.addPage();
      doc.y = MARGIN;
      if (withHeader) headerRow();
    }
  }

  headerRow();
  let zebra = false;

  report.groups.forEach(g => {
    if (report.options.groupBy) {
      ensure(40);
      const y = doc.y + 4;
      doc.save().rect(MARGIN, y, pageW, 20).fill('#dce7f7').restore();
      const sm = g.summary;
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#111827')
        .text(`${g.label}`, MARGIN + 4, y + 5, { width: pageW * 0.5, lineBreak: false, ellipsis: true });
      doc.font('Helvetica').fontSize(8.5).fillColor('#374151')
        .text(`${sm.count} ticket${sm.count === 1 ? '' : 's'} · ${sm.finished} finished` + (sm.avgTime ? ` · avg ${sm.avgTime}` : '') + (sm.slaRate !== null ? ` · ${sm.slaRate}% in SLA` : ''),
          MARGIN + pageW * 0.5, y + 6, { width: pageW * 0.5 - 6, align: 'right', lineBreak: false });
      doc.y = y + 24;
      zebra = false;
    }
    g.rows.forEach(r => {
      doc.font('Helvetica').fontSize(8);
      const cells = report.columns.map(c => String(c.get(r) ?? ''));
      const h = Math.max(...cells.map((t, i) => doc.heightOfString(t, { width: widths[i] - 6 })), 10) + ROW_PAD * 2;
      ensure(h);
      const y = doc.y;
      if (zebra) doc.save().rect(MARGIN, y, pageW, h).fill('#f6f8fb').restore();
      zebra = !zebra;
      doc.fillColor('#111827');
      cells.forEach((t, i) => doc.text(t, xs[i] + 3, y + ROW_PAD, { width: widths[i] - 6 }));
      doc.save().moveTo(MARGIN, y + h).lineTo(MARGIN + pageW, y + h).lineWidth(0.4).strokeColor('#e5e7eb').stroke().restore();
      doc.y = y + h;
    });
    if (!g.rows.length) { doc.font('Helvetica-Oblique').fontSize(9).fillColor('#6b7280').text('No tickets match.', MARGIN + 4, doc.y + 4); doc.moveDown(); }
  });

  // ---- page numbers ----
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.font('Helvetica').fontSize(8).fillColor('#9ca3af')
      .text(`OSA — ${meta.title} — page ${i + 1} of ${range.count}`, MARGIN, doc.page.height - MARGIN - 6, { width: pageW, align: 'center', lineBreak: false });
  }
  doc.end();
}

module.exports = { renderPdf };
