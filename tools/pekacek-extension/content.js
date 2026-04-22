// Pekacek Content Script — extracts page content for sidebar

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "extract-content") {
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
