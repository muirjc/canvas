import { emptyStandardRules, type StandardRules } from '../schema.js';

/**
 * canvas-keg8: a strict Value Stream standard. Stages run left to right, each named as an outcome;
 * an optional stakeholder triggers the first stage; each stage may be enabled by business
 * capabilities, drawn beneath it with dotted connectors.
 *
 * Canvas's API still seeds the descriptive Value Stream starter for its own value-stream type (see
 * apps/api-py/src/canvas_api/seed/reference_standards.py); this stricter definition is exported for
 * consumers that generate value streams from data (ADP), and for an admin to adopt in Canvas later.
 */
export const VALUE_STREAM_STANDARD: StandardRules = {
  ...emptyStandardRules(),
  requireKnownKinds: true,
  connectorPolicy: 'listed-only',
  elementKinds: [
    {
      id: 'value_stage',
      label: 'Value Stage',
      description:
        'A stage in delivering value to the customer, named as an outcome ("Order Fulfilled"). Chain the stages left to right, from trigger to value delivered.',
      shapes: ['asymmetric'],
      approvedFills: ['#e0e7ff', '#c7d2fe'],
      approvedStrokes: ['#4338ca'],
      minCount: 1,
    },
    {
      id: 'enabling_capability',
      label: 'Enabling Capability',
      description: 'A business capability a stage depends on. Drawn beneath its stage.',
      shapes: ['rounded-rectangle'],
      approvedFills: ['#f1f5f9'],
      approvedStrokes: ['#475569'],
    },
    {
      id: 'stakeholder',
      label: 'Stakeholder',
      description: 'The customer or stakeholder whose request triggers the value stream. At most one.',
      shapes: ['stadium'],
      approvedFills: ['#fce7f3'],
      approvedStrokes: ['#be185d'],
      maxCount: 1,
    },
  ],
  connectorRules: [
    { id: 'stage_flow', label: 'Next stage', from: 'value_stage', to: 'value_stage', lineStyles: ['solid'], arrows: ['target'], maxPerSource: 1 },
    { id: 'triggers', label: 'Triggers', from: 'stakeholder', to: 'value_stage', lineStyles: ['solid'], arrows: ['target'], maxPerSource: 1 },
    { id: 'enabled_by', label: 'Enabled by', from: 'value_stage', to: 'enabling_capability', lineStyles: ['dotted'], arrows: ['none'] },
  ],
  guidance:
    'A value stream: the stages that deliver value to a customer, left to right, each named as an outcome. An optional stakeholder triggers the first stage. Business capabilities that enable a stage sit beneath it, joined by dotted lines. Stages connect only to the next stage.',
};
