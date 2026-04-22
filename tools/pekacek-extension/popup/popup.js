document.getElementById("open-sidebar").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "open-sidepanel" });
  window.close();
});

document.getElementById("open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
