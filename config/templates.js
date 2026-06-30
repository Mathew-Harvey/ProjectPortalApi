// Template seed data. `work_item.method` (weld | composite) selects which set
// loads — and NOTHING else branches on method. The lifecycle, gate, event log,
// roles and client view are identical for both.
//
// Each template row is (method, kind, definition jsonb). Definitions are
// template-driven form/layout specs so the frontend renders inputs from config
// rather than hardcoded fields, and the doc-pack lays out from config too.
//
// Field spec shape (rds / qa):
//   { key, label, type, options?, required?, unit?, help? }
//   type in: text | textarea | number | select | checkbox | date
// ITP definition holds the hold-point list instantiated per work_item:
//   { holdPoints: [ { label, sequence } ] }
// Doc-pack definition is a layout:
//   { title, sections: [ { key, label } ] }   key in: rds|spec|holdpoints|qa|media

const WELD_RDS = {
  title: 'Repair Detail Sheet — Weld / Fabrication',
  fields: [
    { key: 'defect_type', label: 'Defect type', type: 'select', required: true,
      options: ['Corrosion / section loss', 'Crack', 'Coating breakdown', 'Mechanical damage', 'Pitting'] },
    { key: 'member', label: 'Structural member', type: 'text', required: true,
      help: 'e.g. Pile P-14 bracing, splash-zone flange' },
    { key: 'extent_mm', label: 'Defect extent', type: 'number', unit: 'mm', required: true },
    { key: 'remaining_wall_mm', label: 'Remaining wall thickness', type: 'number', unit: 'mm' },
    { key: 'proposed_repair', label: 'Proposed repair', type: 'select', required: true,
      options: ['Doubler plate', 'Insert plate', 'Weld build-up', 'Cropping & renewal'] },
    { key: 'notes', label: 'Inspector notes', type: 'textarea' },
  ],
};

const COMPOSITE_RDS = {
  title: 'Repair Detail Sheet — Composite (Carbon-fibre Wrap)',
  fields: [
    { key: 'defect_type', label: 'Defect type', type: 'select', required: true,
      options: ['Corrosion / section loss', 'Through-wall leak', 'Coating breakdown', 'Pitting'] },
    { key: 'member', label: 'Structural member', type: 'text', required: true,
      help: 'e.g. Pile P-14 riser, splash-zone column' },
    { key: 'defect_length_mm', label: 'Defect length', type: 'number', unit: 'mm', required: true },
    { key: 'substrate_condition', label: 'Substrate condition', type: 'select', required: true,
      options: ['Sound', 'Light pitting', 'Heavy pitting', 'Active leak'] },
    { key: 'design_wrap_layers', label: 'Design wrap layers', type: 'number',
      help: 'Per engineering — confirmed in spec' },
    { key: 'notes', label: 'Inspector notes', type: 'textarea' },
  ],
};

const WELD_ITP = {
  title: 'Inspection & Test Plan — Weld',
  holdPoints: [
    { label: 'Surface preparation & fit-up inspection', sequence: 1 },
    { label: 'Root pass NDT (MPI)', sequence: 2 },
    { label: 'Fill & cap weld visual inspection', sequence: 3 },
    { label: 'Final NDT sign-off (UT/MPI)', sequence: 4 },
    { label: 'Coating reinstatement check', sequence: 5 },
  ],
};

const COMPOSITE_ITP = {
  title: 'Inspection & Test Plan — Composite',
  holdPoints: [
    { label: 'Surface preparation & profile check', sequence: 1 },
    { label: 'Resin mix ratio verification', sequence: 2 },
    { label: 'Layup / lamination inspection (per layer)', sequence: 3 },
    { label: 'Cure confirmation (Barcol hardness)', sequence: 4 },
    { label: 'Final wrap dimensional sign-off', sequence: 5 },
  ],
};

const WELD_QA = {
  title: 'QA Record — Weld',
  fields: [
    { key: 'weld_size_mm', label: 'Measured weld size', type: 'number', unit: 'mm', required: true },
    { key: 'ndt_method', label: 'NDT method', type: 'select', required: true,
      options: ['MPI', 'UT', 'Visual only'] },
    { key: 'ndt_result', label: 'NDT result', type: 'select', required: true,
      options: ['Acceptable', 'Rejectable — rework'] },
    { key: 'coating_dft_um', label: 'Coating DFT', type: 'number', unit: 'µm' },
    { key: 'qa_notes', label: 'QA notes', type: 'textarea' },
  ],
};

const COMPOSITE_QA = {
  title: 'QA Record — Composite',
  fields: [
    { key: 'layers_applied', label: 'Wrap layers applied', type: 'number', required: true },
    { key: 'total_thickness_mm', label: 'Total laminate thickness', type: 'number', unit: 'mm', required: true },
    { key: 'barcol_hardness', label: 'Barcol hardness', type: 'number', required: true },
    { key: 'adhesion_result', label: 'Adhesion test', type: 'select', required: true,
      options: ['Pass', 'Fail — rework'] },
    { key: 'qa_notes', label: 'QA notes', type: 'textarea' },
  ],
};

const WELD_DOCPACK = {
  title: 'Weld Repair Doc Pack',
  sections: [
    { key: 'rds', label: 'Repair Detail Sheet (RDS)' },
    { key: 'spec', label: 'Engineering Specification' },
    { key: 'holdpoints', label: 'ITP Hold Points' },
    { key: 'qa', label: 'QA Record' },
    { key: 'media', label: 'Evidence / Media' },
  ],
};

const COMPOSITE_DOCPACK = {
  title: 'Composite Wrap Repair Doc Pack',
  sections: [
    { key: 'rds', label: 'Repair Detail Sheet (RDS)' },
    { key: 'spec', label: 'Engineering Specification' },
    { key: 'holdpoints', label: 'ITP Hold Points' },
    { key: 'qa', label: 'QA Record' },
    { key: 'media', label: 'Evidence / Media' },
  ],
};

const TEMPLATES = [
  { method: 'weld', kind: 'rds', definition: WELD_RDS },
  { method: 'weld', kind: 'itp', definition: WELD_ITP },
  { method: 'weld', kind: 'qa', definition: WELD_QA },
  { method: 'weld', kind: 'docpack', definition: WELD_DOCPACK },
  { method: 'composite', kind: 'rds', definition: COMPOSITE_RDS },
  { method: 'composite', kind: 'itp', definition: COMPOSITE_ITP },
  { method: 'composite', kind: 'qa', definition: COMPOSITE_QA },
  { method: 'composite', kind: 'docpack', definition: COMPOSITE_DOCPACK },
];

module.exports = { TEMPLATES };
