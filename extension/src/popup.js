// Epic 02 — the extension's whole job is: read the two LeetCode cookies
// (chrome.cookies can read the httpOnly LEETCODE_SESSION one; a page script
// never could, see the manual-paste form's docs) and POST them to the same
// /api/auth/sync endpoint the manual-paste form uses. WECODE_CONFIG.apiBase
// comes from config.js, generated at build time (extension/build.js) — see
// extension/README.md for prod-vs-dev builds.

const statusText = document.getElementById("statusText");
const indicator = document.getElementById("indicator");
const syncButton = document.getElementById("syncButton");
const versionEl = document.getElementById("version");

versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

function setStatus(message, type) {
  statusText.textContent = message;
  indicator.className = `indicator ${type}`;
  document.getElementById("status").className = `status ${type}`;
}

function getLeetCodeCookie(name) {
  return new Promise((resolve, reject) => {
    chrome.cookies.get({ url: "https://leetcode.com", name }, (cookie) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(cookie ? cookie.value : null);
    });
  });
}

async function refreshStatus() {
  try {
    const response = await fetch(`${WECODE_CONFIG.apiBase}/api/auth/status`, {
      credentials: "include",
    });
    const data = await response.json();

    if (!data.connected) {
      setStatus("Not connected", "info");
    } else if (data.sessionStatus === "stale") {
      setStatus(`Needs resync (${data.username})`, "error");
    } else {
      setStatus(`Connected as ${data.username}`, "success");
    }
  } catch {
    setStatus("Couldn't reach WeCode", "error");
  }
}

// If the tab that triggered the sync is already on WeCode (e.g. the
// room-join screen from Epic 04, Story 2, or the landing page), reload it
// in place rather than opening a second tab — a reload re-renders whatever
// WeCode page was already open with the now-synced session, which for a
// room-join screen means landing straight in the room, joined. Only open a
// new tab when the current one is somewhere else (LeetCode, most likely).
async function goToWeCode() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isOnWeCode =
    activeTab?.url && new URL(activeTab.url).origin === WECODE_CONFIG.apiBase;

  if (isOnWeCode) {
    chrome.tabs.reload(activeTab.id);
  } else {
    chrome.tabs.create({ url: WECODE_CONFIG.apiBase });
  }
}

async function handleSync() {
  syncButton.disabled = true;
  setStatus("Checking LeetCode login…", "info");

  try {
    const [session, csrf] = await Promise.all([
      getLeetCodeCookie("LEETCODE_SESSION"),
      getLeetCodeCookie("csrftoken"),
    ]);

    if (!session || !csrf) {
      setStatus("You're not logged into LeetCode — log in there first.", "error");
      return;
    }

    setStatus("Syncing…", "info");

    const response = await fetch(`${WECODE_CONFIG.apiBase}/api/auth/sync`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        leetcodeSession: session,
        csrfToken: csrf,
        syncedVia: "extension",
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      setStatus(data.error ?? "Sync failed. Try again.", "error");
      return;
    }

    setStatus(`Connected as ${data.user.leetcodeUsername}`, "success");
    setTimeout(goToWeCode, 600);
  } catch {
    setStatus("Couldn't reach WeCode. Check your connection.", "error");
  } finally {
    syncButton.disabled = false;
  }
}

syncButton.addEventListener("click", handleSync);
refreshStatus();
