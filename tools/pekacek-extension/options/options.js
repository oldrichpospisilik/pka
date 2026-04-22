const DEFAULT_BRIDGE = "http://localhost:3888";

// Load saved settings
chrome.storage.local.get(["bridgeUrl"], (data) => {
  document.getElementById("bridgeUrl").value = data.bridgeUrl || DEFAULT_BRIDGE;
});

// Save
document.getElementById("save").addEventListener("click", () => {
  const bridgeUrl = document.getElementById("bridgeUrl").value.trim() || DEFAULT_BRIDGE;

  chrome.storage.local.set({ bridgeUrl }, () => {
    document.getElementById("status").textContent = "Ulozeno \\(^o^)/";
    document.getElementById("status").style.color = "#4ecca3";
    setTimeout(() => {
      document.getElementById("status").textContent = "";
    }, 3000);
    checkBridge(bridgeUrl);
  });
});

// Check bridge status
async function checkBridge(url) {
  const dot = document.getElementById("statusDot");
  const label = document.getElementById("bridgeStatus");

  try {
    const res = await fetch(`${url || DEFAULT_BRIDGE}/status`);
    const data = await res.json();

    if (data.status === "running") {
      dot.className = "dot dot-online";
      label.textContent = `Bridge online (${data.sessions || 0} sessions)`;
    } else {
      dot.className = "dot dot-offline";
      label.textContent = "Bridge offline";
    }
  } catch {
    dot.className = "dot dot-offline";
    label.textContent = "Bridge nedostupny — spust bridge.mjs ve WSL";
  }
}

// Initial check
chrome.storage.local.get(["bridgeUrl"], (data) => {
  checkBridge(data.bridgeUrl || DEFAULT_BRIDGE);
});
