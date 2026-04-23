// Pekacek Content Script — extracts page content for sidebar

function isYouTubeVideo() {
  const h = location.hostname.replace(/^www\./, "");
  if (h === "youtube.com" && location.pathname === "/watch") return true;
  if (h === "youtu.be" && location.pathname.length > 1) return true;
  return false;
}

function formatDuration(sec) {
  const n = parseInt(sec, 10);
  if (!n) return "";
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  const pad = (v) => String(v).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function extractYouTube() {
  const videoId =
    new URL(location.href).searchParams.get("v") ||
    location.pathname.replace(/^\//, "").split("/")[0];

  const title =
    document.querySelector('meta[property="og:title"]')?.content ||
    document.querySelector("h1.ytd-watch-metadata yt-formatted-string")?.textContent?.trim() ||
    document.title.replace(/ - YouTube$/, "");

  const channel =
    document.querySelector("#owner #channel-name a")?.textContent?.trim() ||
    document.querySelector("ytd-channel-name a")?.textContent?.trim() ||
    document.querySelector("#upload-info a")?.textContent?.trim() ||
    document.querySelector('link[itemprop="name"]')?.getAttribute("content") ||
    "";

  const descEl =
    document.querySelector("#description-inline-expander") ||
    document.querySelector("ytd-text-inline-expander") ||
    document.querySelector("#description");
  const description = (descEl?.innerText?.trim() ||
    document.querySelector('meta[name="description"]')?.content || "").slice(0, 3000);

  const durationSec =
    document.querySelector('meta[itemprop="duration"]')?.content ||
    document.querySelector('meta[property="og:video:duration"]')?.content ||
    "";
  const duration = formatDuration(durationSec.match?.(/\d+/)?.[0] || durationSec);

  const text =
    `[YouTube video]\n` +
    `Název: ${title}\n` +
    (channel ? `Kanál: ${channel}\n` : "") +
    (duration ? `Délka: ${duration}\n` : "") +
    `\nPopis:\n${description || "(prázdný / YouTube nevrací popis)"}`;

  return {
    type: "youtube",
    videoId,
    title,
    channel,
    description,
    duration,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    text,
    length: text.length,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "extract-content") {
    if (isYouTubeVideo()) {
      sendResponse(extractYouTube());
      return;
    }

    const selection = window.getSelection().toString().trim();

    // Get main content — try article/main first, fallback to body
    const article =
      document.querySelector("article") ||
      document.querySelector('[role="main"]') ||
      document.querySelector("main") ||
      document.body;

    // Clean text: remove scripts, styles, nav
    const clone = article.cloneNode(true);
    clone.querySelectorAll("script, style, nav, footer, header, aside, .ad, .ads, .sidebar, .comments").forEach((el) => el.remove());

    const fullText = clone.innerText
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 15000); // limit to ~15k chars

    sendResponse({
      title: document.title,
      url: window.location.href,
      selection: selection || null,
      text: fullText,
      length: fullText.length,
    });
  }
});
