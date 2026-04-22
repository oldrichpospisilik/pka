const SERVER = "http://localhost:3777";

async function checkStatus() {
  const dot = document.getElementById("dot");
  const label = document.getElementById("label");
  const info = document.getElementById("info");

  try {
    const res = await fetch(`${SERVER}/status`);
    const data = await res.json();

    dot.className = "dot green";
    label.textContent = "MCP server connected";
    info.textContent = data.hasPending
      ? "⏳ Pending command..."
      : "✓ Ready for commands";
  } catch (e) {
    dot.className = "dot red";
    label.textContent = "MCP server offline";
    info.textContent = "Start server: npm start";
  }
}

checkStatus();
setInterval(checkStatus, 2000);
