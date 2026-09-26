/* ============================================================================
 * ReliefGrid — resource taxonomy (pure module, no browser dependencies).
 * ----------------------------------------------------------------------------
 * Shared by the browser (js/shared.js re-exports everything here) and by the
 * server-side AI layer (server/ai/*), so the AI Resource Navigator can only
 * ever map a request onto categories that actually exist in
 * longisland_facilities.geojson (`resource_group`).
 * ==========================================================================*/

/** Human labels for every `resource_group` value present in the dataset. */
export const RESOURCE_LABELS = {
  food: 'Food Pantry / Food Bank', shelter: 'Emergency Shelter',
  outreach: 'Outreach & Day Services', legal: 'Legal Aid',
  housing_support: 'Housing Support', behavioral_health: 'Mental Health',
  public_benefits: 'Public Benefits', health: 'Healthcare', other: 'Other',
};

export const RESOURCE_GROUPS = Object.keys(RESOURCE_LABELS);

/* Seeker-facing "what do you need" taxonomy. `groups` maps to one or more
 * resource_group values in longisland_facilities.geojson. `aiHint` describes —
 * from what the listings in each group actually are — what kinds of requests
 * belong there. It is sent to the language model as the ONLY allowed mapping
 * targets; it is not shown to users. */
export const SEEKER_CATEGORIES = [
  { id: 'shelter',           label: 'Shelter',                groups: ['shelter'],                  icon: 'shelter',
    aiHint: 'Emergency shelter, a safe place to sleep tonight, overnight accommodation, and county Department of Social Services emergency-housing intake points.' },
  { id: 'food',              label: 'Food',                   groups: ['food'],                     icon: 'food',
    aiHint: 'Food pantries and food banks: groceries, food packages, help with food.' },
  { id: 'health',            label: 'Healthcare',             groups: ['health'],                   icon: 'health',
    aiHint: 'Community health centers: medical care, check-ups, clinics for uninsured or Medicaid patients.' },
  { id: 'behavioral_health', label: 'Mental Health',          groups: ['behavioral_health'],        icon: 'behavioral_health',
    aiHint: 'Mental health support, behavioral-health crisis care, counseling, and addiction / substance-use treatment.' },
  { id: 'legal',             label: 'Legal Help',             groups: ['legal'],                    icon: 'legal',
    aiHint: 'Free civil legal aid, including eviction, housing court, and tenant legal problems.' },
  { id: 'housing_support',   label: 'Housing Support',        groups: ['housing_support'],          icon: 'housing_support',
    aiHint: 'Housing counseling, help finding or keeping housing, rental listings and referrals, supportive housing, foreclosure help.' },
  { id: 'outreach',          label: 'Hygiene & Day Services', groups: ['outreach'],                 icon: 'outreach',
    aiHint: 'Homeless outreach, day or drop-in services, community and parish outreach programs, recovery community centers.' },
  { id: 'other',             label: 'Other Services',         groups: ['public_benefits', 'other'], icon: 'other',
    aiHint: 'Public benefits access (public assistance, SNAP enrollment), employment programs, and other community service agencies.' },
];

export const SEEKER_CATEGORY_IDS = SEEKER_CATEGORIES.map(c => c.id);

export function categoryForGroup(group) {
  return SEEKER_CATEGORIES.find(c => c.groups.includes(group)) || null;
}
