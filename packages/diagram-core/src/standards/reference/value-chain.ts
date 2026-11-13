import { emptyStandardRules, type StandardRules } from '../schema.js';

/**
 * canvas-tfr, exported from diagram-core by canvas-keg8: the built-in Value Chain reference standard
 * (Porter). Primary activities chain left to right into exactly one Margin; support activities sit
 * as bands across the chain and are not connected into it.
 *
 * The API seeds this same definition as a Python dict (apps/api-py/src/canvas_api/seed/
 * reference_standards.py). Keep the two identical, key order included -- the API's parity test
 * (tests/test_reference_standards_parity.py) compares them.
 */
export const VALUE_CHAIN_STANDARD: StandardRules = {
  ...emptyStandardRules(),
  requireKnownKinds: true,
  connectorPolicy: 'listed-only',
  elementKinds: [
    {
      id: 'primary_activity',
      label: 'Primary Activity',
      description:
        'An activity that directly creates and delivers value: inbound logistics, operations, outbound logistics, marketing & sales, service. Chain them left to right in the order value flows.',
      shapes: ['asymmetric'],
      approvedFills: ['#dbeafe', '#bfdbfe'],
      approvedStrokes: ['#1d4ed8'],
      minCount: 1,
      requireConnection: true,
    },
    {
      id: 'support_activity',
      label: 'Support Activity',
      description:
        'An activity that enables the primary activities across the whole chain: firm infrastructure, human resource management, technology development, procurement. Not connected into the primary flow.',
      shapes: ['rectangle'],
      approvedFills: ['#fef3c7', '#fde68a'],
      approvedStrokes: ['#b45309'],
      minCount: 1,
    },
    {
      id: 'margin',
      label: 'Margin',
      description: 'The value captured: exactly one, at the end of the primary activity chain.',
      shapes: ['hexagon'],
      approvedFills: ['#dcfce7'],
      approvedStrokes: ['#15803d'],
      minCount: 1,
      maxCount: 1,
    },
  ],
  connectorRules: [
    { id: 'flow', label: 'Value flow', from: 'primary_activity', to: 'primary_activity', lineStyles: ['solid'], arrows: ['target'], maxPerSource: 1 },
    { id: 'to_margin', label: 'Delivers margin', from: 'primary_activity', to: 'margin', lineStyles: ['solid'], arrows: ['target'], maxPerSource: 1 },
  ],
  guidance:
    "Porter's value chain: primary activities in sequence left to right (typically 5: inbound logistics, operations, outbound logistics, marketing & sales, service), the last one feeding the single Margin element. Support activities (typically 4: firm infrastructure, HR management, technology development, procurement) sit as bands above the primary chain and are not connected into it.",
};
