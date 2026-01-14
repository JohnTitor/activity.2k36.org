import satori from "satori";
import { html } from "satori-html";
import type { ReactNode } from "react";

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

let cachedFonts: { regular?: ArrayBuffer; semibold?: ArrayBuffer } = {};

async function fetchGoogleFontsCSS() {
  const res = await fetch(
    "https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap",
    {
      headers: {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to load font CSS: ${res.status}`);
  }
  return await res.text();
}

function extractWoff2Url(css: string, weight: number) {
  const blocks = css.split("@font-face");
  for (const block of blocks) {
    if (!block.includes(`font-weight: ${weight}`)) continue;
    const match = block.match(/src:\\s*url\\((https:[^)]+)\\)\\s*format\\('woff2'\\)/);
    if (match?.[1]) return match[1];
  }
  return null;
}

async function loadFonts() {
  if (cachedFonts.regular && cachedFonts.semibold) {
    return [
      { name: "Inter", data: cachedFonts.regular, weight: 400, style: "normal" as const },
      { name: "Inter", data: cachedFonts.semibold, weight: 600, style: "normal" as const },
    ];
  }

  const css = await fetchGoogleFontsCSS();
  const regularUrl = extractWoff2Url(css, 400);
  const semiboldUrl = extractWoff2Url(css, 600);
  if (!regularUrl || !semiboldUrl) {
    throw new Error("Failed to parse font URLs from Google Fonts CSS.");
  }

  const [regular, semibold] = await Promise.all([
    fetch(regularUrl).then((r) => r.arrayBuffer()),
    fetch(semiboldUrl).then((r) => r.arrayBuffer()),
  ]);

  cachedFonts = { regular, semibold };
  return [
    { name: "Inter", data: regular, weight: 400, style: "normal" as const },
    { name: "Inter", data: semibold, weight: 600, style: "normal" as const },
  ];
}

export async function renderOgSvg(params: { username: string; domain: string }) {
  const fonts = await loadFonts();

  const markup = html(`
    <div style="
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: center;
      padding: 72px;
      background: radial-gradient(900px circle at 15% 5%, rgba(14,165,233,0.22), transparent 45%),
                  radial-gradient(700px circle at 85% 0%, rgba(168,85,247,0.18), transparent 40%),
                  #0a0a0b;
      color: #f4f4f5;
      font-family: Inter, sans-serif;
    ">
      <div style="font-size: 52px; font-weight: 600; letter-spacing: -0.02em;">
        activity.2k36.org
      </div>
      <div style="margin-top: 18px; font-size: 28px; color: #d4d4d8;">
        Latest GitHub activities for @${params.username}
      </div>
      <div style="margin-top: 32px; display: flex; gap: 16px; font-size: 18px; color: #a1a1aa;">
        <span>https://${params.domain}</span>
        <span>•</span>
        <span>Public activity</span>
      </div>
    </div>
  `) as unknown as ReactNode;

  return await satori(markup, {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts: fonts as unknown as any,
  });
}
