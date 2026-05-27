export const DEFAULT_SHOPIFY_REFERENCE_SITES = [
  "https://www.allbirds.com/",
  "https://www.gymshark.com/",
  "https://www.kyliecosmetics.com/",
  "https://www.bombas.com/",
  "https://www.brooklinen.com/",
  "https://www.studioneat.com/"
];

export function resolveReferenceSites(userProvided = []) {
  const cleaned = (userProvided || []).map((u) => String(u).trim()).filter(Boolean);
  if (cleaned.length) return cleaned;
  return DEFAULT_SHOPIFY_REFERENCE_SITES;
}
 