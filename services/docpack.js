// Doc-pack PDF assembly. Streams a PDF built from a work_item's RDS, spec, ITP
// hold points and QA, laid out per the method's `docpack` template. The layout
// (title + which sections, in order) is template-driven, so switching method
// changes only the doc-pack — never the lifecycle.

const PDFDocument = require('pdfkit');

const COLORS = { ink: '#1a2733', muted: '#5b6b7a', rule: '#c8d2dc', brand: '#0b4f6c' };

// Render to a writable stream (the HTTP response). Caller sets headers first.
function streamDocPack(stream, bundle) {
  const {
    org, project, workItem,
    inspection, rdsTemplate,
    spec, engineer,
    holdPoints,
    qa, qaTemplate,
    media,
    docpackTemplate,
  } = bundle;

  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  doc.pipe(stream);

  const def = docpackTemplate?.definition || {};
  const sections = Array.isArray(def.sections) && def.sections.length
    ? def.sections
    : [
        { key: 'rds', label: 'Repair Detail Sheet (RDS)' },
        { key: 'spec', label: 'Engineering Specification' },
        { key: 'holdpoints', label: 'ITP Hold Points' },
        { key: 'qa', label: 'QA Record' },
        { key: 'media', label: 'Evidence / Media' },
      ];

  // ── Cover / header ──────────────────────────────────────────────
  doc.fillColor(COLORS.brand).fontSize(22).font('Helvetica-Bold')
    .text('Franmarine', { continued: true })
    .fillColor(COLORS.ink).text('  Project Portal');
  doc.moveDown(0.2);
  doc.fillColor(COLORS.ink).fontSize(16).font('Helvetica-Bold')
    .text(def.title || 'Repair Doc Pack');
  doc.moveDown(0.5);

  kv(doc, 'Organisation', org?.name);
  kv(doc, 'Project', project?.name);
  kv(doc, 'Asset ref', project?.asset_ref);
  kv(doc, 'Work item', `${workItem.ref_code}  (${workItem.location_ref || 'no location'})`);
  kv(doc, 'Method', workItem.method);
  kv(doc, 'Status', workItem.status);
  kv(doc, 'Generated', new Date().toISOString());
  rule(doc);

  for (const section of sections) {
    switch (section.key) {
      case 'rds':
        renderForm(doc, section.label, inspection?.data, rdsTemplate?.definition?.fields, {
          empty: 'No RDS / inspection captured yet.',
          footer: inspection ? `Captured at ${fmt(inspection.captured_at)}` : null,
        });
        break;
      case 'spec':
        heading(doc, section.label);
        if (!spec) {
          muted(doc, 'No specification on record.');
        } else {
          kv(doc, 'Status', spec.status);
          kv(doc, 'Engineer', engineer?.name || spec.engineer_id || '—');
          if (spec.notes) kv(doc, 'Notes', spec.notes);
          kv(doc, 'Approved', spec.approved_at ? fmt(spec.approved_at) : 'Not approved');
          if (spec.doc_media_id) kv(doc, 'Spec document', `media:${spec.doc_media_id}`);
        }
        doc.moveDown(0.5);
        break;
      case 'holdpoints':
        heading(doc, section.label);
        if (!holdPoints || holdPoints.length === 0) {
          muted(doc, 'No hold points defined.');
        } else {
          holdPoints.forEach((hp) => {
            const mark = hp.signed_at ? '[x]' : '[ ]';
            const who = hp.signed_at ? `signed ${fmt(hp.signed_at)}${hp.signer_name ? ` by ${hp.signer_name}` : ''}` : 'unsigned';
            doc.fillColor(COLORS.ink).fontSize(10).font('Helvetica')
              .text(`${mark}  ${hp.sequence}. ${hp.label}  — ${who}`);
          });
        }
        doc.moveDown(0.5);
        break;
      case 'qa':
        renderForm(doc, section.label, qa?.data, qaTemplate?.definition?.fields, {
          empty: 'No QA record captured yet.',
          footer: qa
            ? `Signed off: ${qa.signed_off_at ? fmt(qa.signed_off_at) : 'no'} · Client sign: ${qa.client_sign_at ? fmt(qa.client_sign_at) : 'no'}`
            : null,
        });
        break;
      case 'media':
        heading(doc, section.label);
        if (!media || media.length === 0) {
          muted(doc, 'No media uploaded.');
        } else {
          media.forEach((m) => {
            doc.fillColor(COLORS.ink).fontSize(9).font('Helvetica')
              .text(`• ${m.original_filename || m.mime || 'file'}  sha256:${(m.sha256 || '').slice(0, 16)}…  captured:${m.captured_at ? fmt(m.captured_at) : '—'}`);
          });
        }
        doc.moveDown(0.5);
        break;
      default:
        break;
    }
  }

  // Footer page numbers
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.fillColor(COLORS.muted).fontSize(8).font('Helvetica')
      .text(`Franmarine Project Portal · ${workItem.ref_code} · page ${i + 1} of ${range.count}`,
        50, doc.page.height - 40, { align: 'center', width: doc.page.width - 100 });
  }

  doc.end();
}

function heading(doc, text) {
  doc.moveDown(0.3);
  doc.fillColor(COLORS.brand).fontSize(13).font('Helvetica-Bold').text(text);
  doc.moveDown(0.2);
}

function kv(doc, key, value) {
  doc.fillColor(COLORS.muted).fontSize(10).font('Helvetica-Bold').text(`${key}: `, { continued: true });
  doc.fillColor(COLORS.ink).font('Helvetica').text(value == null || value === '' ? '—' : String(value));
}

function muted(doc, text) {
  doc.fillColor(COLORS.muted).fontSize(10).font('Helvetica-Oblique').text(text);
}

function rule(doc) {
  doc.moveDown(0.4);
  doc.strokeColor(COLORS.rule).lineWidth(1)
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(0.4);
}

function fmt(ts) {
  if (!ts) return '—';
  const d = ts instanceof Date ? ts : new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toISOString();
}

// Render a template-driven form payload (RDS / QA). Uses field defs for labels
// and ordering; falls back to raw keys if no template is available.
function renderForm(doc, label, data, fields, opts = {}) {
  heading(doc, label);
  if (!data || Object.keys(data).length === 0) {
    muted(doc, opts.empty || 'No data.');
    doc.moveDown(0.5);
    return;
  }
  if (Array.isArray(fields) && fields.length) {
    fields.forEach((f) => {
      if (data[f.key] === undefined) return;
      const unit = f.unit ? ` ${f.unit}` : '';
      kv(doc, f.label || f.key, `${formatValue(data[f.key])}${unit}`);
    });
  } else {
    Object.entries(data).forEach(([k, v]) => kv(doc, k, formatValue(v)));
  }
  if (opts.footer) {
    doc.moveDown(0.2);
    muted(doc, opts.footer);
  }
  doc.moveDown(0.5);
}

function formatValue(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

module.exports = { streamDocPack };
