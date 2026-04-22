const SERVER = "http://localhost:3777";

// Safety net: alarm wakes SW if long-poll fetch dies
chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => longPoll());

// Start on install/startup
chrome.runtime.onInstalled.addListener(() => longPoll());
chrome.runtime.onStartup.addListener(() => longPoll());

let polling = false;

async function longPoll() {
  if (polling) return;
  polling = true;

  try {
    const res = await fetch(`${SERVER}/poll`);

    if (res.status === 200) {
      const command = await res.json();
      const result = await executeCommand(command);

      await fetch(`${SERVER}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      });
    }
    // 204 = no command (timeout), just reconnect
  } catch (e) {
    // Server not running, wait before retry
    await new Promise((r) => setTimeout(r, 3000));
  }

  polling = false;
  // Immediately start next long-poll cycle
  longPoll();
}

async function executeCommand(cmd) {
  try {
    switch (cmd.action) {
      case "createBookmark":
        return await chrome.bookmarks.create({
          title: cmd.title,
          url: cmd.url,
          parentId: cmd.parentId || "1",
        });

      case "move":
        return await chrome.bookmarks.move(cmd.bookmarkId, {
          parentId: cmd.parentId,
          ...(cmd.index !== undefined && { index: cmd.index }),
        });

      case "createFolder":
        return await chrome.bookmarks.create({
          title: cmd.title,
          parentId: cmd.parentId || "1",
        });

      case "delete":
        await chrome.bookmarks.remove(cmd.bookmarkId);
        return { success: true, deletedId: cmd.bookmarkId };

      case "update": {
        const changes = {};
        if (cmd.title) changes.title = cmd.title;
        if (cmd.url) changes.url = cmd.url;
        return await chrome.bookmarks.update(cmd.bookmarkId, changes);
      }

      default:
        return { error: `Unknown action: ${cmd.action}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// Initial poll
longPoll();
