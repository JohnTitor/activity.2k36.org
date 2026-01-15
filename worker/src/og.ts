const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderStaticOgSvg(params: { username: string; domain: string }) {
  const safeUsername = escapeXml(params.username);
  const safeDomain = escapeXml(params.domain);
  const title = "activity.2k36.org";
  const subtitle = `Latest GitHub activities for @${safeUsername}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">
  <defs>
    <radialGradient id="accent1" cx="15%" cy="5%" r="75%">
      <stop offset="0%" stop-color="#0ea5e9" stop-opacity="0.22" />
      <stop offset="45%" stop-color="#0ea5e9" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="accent2" cx="85%" cy="0%" r="60%">
      <stop offset="0%" stop-color="#a855f7" stop-opacity="0.18" />
      <stop offset="40%" stop-color="#a855f7" stop-opacity="0" />
    </radialGradient>
  </defs>
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="#0a0a0b" />
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#accent1)" />
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#accent2)" />
  <text x="72" y="280" font-family="Inter, system-ui, -apple-system, Segoe UI, sans-serif" font-size="52" font-weight="600" fill="#f4f4f5">
    ${title}
  </text>
  <text x="72" y="338" font-family="Inter, system-ui, -apple-system, Segoe UI, sans-serif" font-size="28" fill="#d4d4d8">
    ${subtitle}
  </text>
</svg>
`;
}

export async function renderOgSvg(params: { username: string; domain: string }) {
  return renderStaticOgSvg(params);
}
