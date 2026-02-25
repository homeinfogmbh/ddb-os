try {
  importScripts('pattern-matcher.js');
} catch (e) {
  console.error(e);
}

const ALARM_NAME = "fetch_config";
const BAYWATCH_API_URL = "https://portal.homeinfo.de/api/baywatch";

// Initial setup
chrome.runtime.onInstalled.addListener(async () => {
  // console.log("[Service Worker] Installed");
  // Mark this as first install
  await chrome.storage.local.set({ isFirstInstall: true });
  // First, apply cached config immediately (if exists) to prevent blocking
  await applyCachedConfigFirst();
  await setupAlarm();
  // Fetch config from API immediately on first install
  await fetchAndApplyConfig();
});

chrome.runtime.onStartup.addListener(async () => {
  // console.log("[Service Worker] Startup");
  // First, apply cached config immediately (if exists) to prevent blocking
  await applyCachedConfigFirst();
  await setupAlarm(); // Ensure alarm is set on startup
  await fetchAndApplyConfig();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    // console.log("[Service Worker] Alarm triggered: Fetching config...");
    await fetchAndApplyConfig();
  }
});

// Listen for page load config requests from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'REQUEST_CONFIG') {
    // console.log("[Service Worker] Config requested by content script");
    // Fetch and apply config, then send back the latest config
    fetchAndApplyConfig().then(async () => {
      const stored = await chrome.storage.local.get(['appConfig']);
      sendResponse({ config: stored.appConfig || null });
    }).catch(err => {
      console.error("[Service Worker] Error fetching config on page load:", err);
      sendResponse({ config: null, error: err.message });
    });
    return true; // Keep the message channel open for async response
  }
});

/**
 * Gets the default URL from config, with fallback to newtab.html
 */
async function getDefaultUrl() {
  try {
    const stored = await chrome.storage.local.get(['appConfig']);
    if (stored.appConfig && stored.appConfig.config && stored.appConfig.config.default) {
      return stored.appConfig.config.default;
    }
  } catch (e) {
    console.error("[Service Worker] Error getting default URL from config:", e);
  }
  // Fallback to newtab.html if config not available
  return chrome.runtime.getURL('newtab.html');
}

// Handle tab crashes
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Check for crash status
  if (tab.url) {
    // Chrome reports crashed tabs with specific error pages
    if (tab.url.includes('chrome-error://') || 
        tab.url.includes('chrome://crash') ||
        tab.url.includes('chrome://kill') ||
        (changeInfo.discarded === true)) {
      // console.log("[Service Worker] Tab crash detected, redirecting to default page");
      const defaultUrl = await getDefaultUrl();
      chrome.tabs.update(tabId, { url: defaultUrl });
    }
  }
});

// Also listen for tab crash via the onCreated event for discarded tabs
chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.pendingUrl && tab.pendingUrl.includes('chrome-error://')) {
    // console.log("[Service Worker] New tab with crash error, redirecting to default page");
    const defaultUrl = await getDefaultUrl();
    chrome.tabs.update(tab.id, { url: defaultUrl });
  }
});

chrome.webNavigation.onErrorOccurred.addListener(async (details) => {
  if (details.frameId === 0) {
    // console.log("[Service Worker] Navigation error detected:", details.error, details.url);
    if (details.error === 'net::ERR_BLOCKED_BY_CLIENT') {
      // console.log("[Service Worker] Page blocked by extension, redirecting to default page");
      const defaultUrl = await getDefaultUrl();
      chrome.tabs.update(details.tabId, { url: defaultUrl });
    }
  }
});

async function setupAlarm(intervalMinutes = 1) {
  // Check if alarm exists and has the correct period
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (alarm && alarm.periodInMinutes === intervalMinutes) {
    return; // No change needed
  }
  
  // console.log(`[Service Worker] Setting alarm interval to ${intervalMinutes} minutes.`);
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: intervalMinutes });
}

/**
 * Apply cached config immediately on startup to prevent blocking.
 * This ensures the whitelist is active before any API calls are made.
 * On first install, creates a temporary allow-all rule until API config is fetched.
 */
async function applyCachedConfigFirst() {
  try {
    const stored = await chrome.storage.local.get(['appConfig', 'isFirstInstall']);
    if (stored.appConfig && stored.appConfig.whitelist) {
      // console.log("[Service Worker] Applying cached config immediately...");
      await ensureConfigAccess(BAYWATCH_API_URL);
      await updateDnrRules(stored.appConfig.whitelist, BAYWATCH_API_URL);
      // console.log("[Service Worker] Cached config applied successfully");
    } else if (stored.isFirstInstall) {
      // console.log("[Service Worker] First install detected, creating temporary allow-all rule...");
      // On first install, allow everything until we get the real config from API
      await ensureConfigAccess(BAYWATCH_API_URL);
      // Create a temporary allow-all rule for all resources
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [1], // Remove any existing block-all rule
        addRules: [{
          id: 8888,
          priority: 1,
          action: { type: "allow" },
          condition: { urlFilter: "*", resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest"] }
        }]
      });
      // console.log("[Service Worker] Temporary allow-all rule created");
    } else {
      // console.log("[Service Worker] No cached config found, will wait for API");
      // Ensure at least the API URL is accessible
      await ensureConfigAccess(BAYWATCH_API_URL);
    }
  } catch (e) {
    console.error("[Service Worker] Error applying cached config:", e);
    // Ensure at least the API URL is accessible
    await ensureConfigAccess(BAYWATCH_API_URL);
  }
}

/**
 * Extracts the system ID from either:
 * 1. The GET parameter "system" from the current tab's URL (HIGHEST PRIORITY)
 * 2. The hostname (e.g., "terminal-123.local" -> "terminal-123")
 * 
 * Priority: GET parameter > hostname > cached value
 * 
 * The GET parameter is ALWAYS checked first and takes precedence.
 * This ensures that ?system=xxx in the URL always controls which config is loaded.
 */
async function getSystemId() {
  let systemId = null;
  let systemIdSource = null;
  
  // Step 1: ALWAYS check active tab's URL for GET parameter first (highest priority)
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs.length > 0 && tabs[0].url) {
      const url = new URL(tabs[0].url);
      
      // Priority 1: GET parameter "system" (ALWAYS takes precedence)
      const systemParam = url.searchParams.get('system');
      if (systemParam) {
        systemId = systemParam;
        systemIdSource = 'GET parameter';
        // console.log("[Service Worker] SystemId from GET parameter:", systemId);
      }
      
      // Priority 2: Extract from hostname (only if no GET parameter)
      if (!systemId) {
        const hostname = url.hostname;
        if (hostname && !hostname.includes('chrome') && !hostname.includes('newtab')) {
          const hostParts = hostname.split('.');
          if (hostParts.length > 0 && hostParts[0] !== 'www') {
            systemId = hostParts[0];
            systemIdSource = 'hostname';
            // console.log("[Service Worker] SystemId from hostname:", systemId);
          }
        }
      }
    }
  } catch (e) {
    // console.log("[Service Worker] Could not get systemId from tab:", e);
  }

  // Step 2: Only use cache if we couldn't get from URL (fallback)
  if (!systemId) {
    try {
      const stored = await chrome.storage.local.get(['systemId']);
      if (stored.systemId) {
        systemId = stored.systemId;
        systemIdSource = 'cache';
        // console.log("[Service Worker] Using cached systemId (fallback):", systemId);
      }
    } catch (e) {
      // console.log("[Service Worker] Could not read cached systemId");
    }
  }

  // Step 3: Update cache with the new systemId (if found from URL)
  if (systemId && systemIdSource !== 'cache') {
    await chrome.storage.local.set({ systemId: systemId });
    // console.log("[Service Worker] Cached systemId updated to:", systemId);
  }

  return systemId;
}

async function fetchAndApplyConfig() {
  // Ensure the API URL is always allowed
  await ensureConfigAccess(BAYWATCH_API_URL);
  
  let data = null;
  let configSource = 'unknown';
  
  // Step 1: Try to fetch from API
  try {
    const systemId = await getSystemId();
    
    if (systemId) {
      // console.log("[Service Worker] Fetching whitelist from API for systemId:", systemId);
      
      const response = await fetch(BAYWATCH_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ system: systemId }),
        cache: 'no-store'
      });
      
      if (response.ok) {
        data = await response.json();
        configSource = 'api';
        // console.log("[Service Worker] Config fetched from API successfully:", data);
      } else {
        console.warn("[Service Worker] API returned error:", response.status);
      }
    } else {
      // console.log("[Service Worker] No systemId available, cannot fetch from API");
    }
  } catch (error) {
    console.error("[Service Worker] API fetch failed:", error);
  }
  
  // Step 2: Fallback to local mock file if API fails
  if (!data) {
    try {
      const localConfigUrl = chrome.runtime.getURL('mock-cms/config.json');
      // console.log("[Service Worker] Falling back to local config:", localConfigUrl);
      
      const response = await fetch(localConfigUrl, { cache: 'no-store' });
      if (response.ok) {
        data = await response.json();
        configSource = 'local';
        // console.log("[Service Worker] Config loaded from local file:", data);
      }
    } catch (error) {
      console.error("[Service Worker] Local config fetch also failed:", error);
      return; // Nothing we can do
    }
  }
  
  if (!data) {
    console.error("[Service Worker] No config available from any source");
    return;
  }
  
  // console.log("[Service Worker] Config fetched successfully from:", configSource);
  
  // Check for changes
  const stored = await chrome.storage.local.get(['appConfig', 'configHash']);
  const oldHash = stored.configHash;
  const newHash = JSON.stringify(data);
  
  const hasChanged = oldHash && oldHash !== newHash;

  // Save to local storage for Content Script access and persistence
  await chrome.storage.local.set({ 
    appConfig: data,
    configHash: newHash,
    configSource: configSource,
    lastUpdated: Date.now(),
    isFirstInstall: false  // Clear first install flag after successful config fetch
  });

  if (hasChanged) {
    // console.log("[Service Worker] Config changed, rules will be updated");
  } else if (!oldHash) {
    // console.log("[Service Worker] Config loaded for the first time");
  }

  // Update Alarm Interval if changed
  if (data.config && data.config.updateIntervalMinutes) {
    const newInterval = parseInt(data.config.updateIntervalMinutes, 10);
    if (!isNaN(newInterval) && newInterval > 0) {
      await setupAlarm(newInterval);
    }
  }

  // Update Blocking Rules
  await updateDnrRules(data.whitelist, BAYWATCH_API_URL);
}

// Helper to ensure we can reach the config server
async function ensureConfigAccess(configUrl) {
  try {
    const url = new URL(configUrl);
    const domain = url.hostname;
    
    const configRule = {
      id: 9999,
      priority: 9999, // Highest priority
      action: { type: "allow" },
      condition: {
        urlFilter: `||${domain}`,
        resourceTypes: ["xmlhttprequest", "other", "main_frame"] 
      }
    };

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [9999],
      addRules: [configRule]
    });
  } catch (e) {
    console.error("[Service Worker] Failed to ensure config access:", e);
  }
}

async function updateDnrRules(whitelist, configUrl) {
  if (!whitelist || !Array.isArray(whitelist)) return;

  const allResourceTypes = [
    "main_frame", "sub_frame", "stylesheet", "script", "image", "font", 
    "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other"
  ];

  // Exclude main_frame from initiator rules to prevent whitelisted sites from navigating to blocked sites
  const subResourceTypes = allResourceTypes.filter(t => t !== 'main_frame');

  let ruleIdCounter = 2;
  const newRules = [];

  for (const entry of whitelist) {
    let pattern;

    if (typeof entry === 'string') {
      pattern = entry;
    } else if (typeof entry === 'object' && entry.url) {
      pattern = entry.url;
    } else {
      continue;
    }

    // 1. Rule to allow visiting the site (URL Filter)
    const visitRule = {
      id: ruleIdCounter++,
      priority: 2,
      action: { type: "allow" },
      condition: {
        resourceTypes: allResourceTypes
      }
    };

    // Map patterns to DNR conditions
    if (pattern.startsWith('*') && pattern.endsWith('*')) {
      const core = pattern.slice(1, -1);
      visitRule.condition.urlFilter = core; 
    }
    else if (pattern.startsWith('*')) {
      const core = pattern.slice(1);
      const escaped = core.replace(/\./g, '\\.');
      // Allow optional port (:\d+)
      visitRule.condition.regexFilter = `^https?://(.*\\.)?${escaped}(:\\d+)?/?(\\?.*)?$`;
    }
    else if (pattern.includes('/')) {
      if (pattern.startsWith('http')) {
        visitRule.condition.urlFilter = pattern;
      } else {
        visitRule.condition.urlFilter = `||${pattern}`;
      }
    }
    else {
      const escaped = pattern.replace(/\./g, '\\.');
      // Allow optional port (:\d+)
      visitRule.condition.regexFilter = `^https?://${escaped}(:\\d+)?/?(\\?.*)?$`;
    }
    newRules.push(visitRule);

    // 2. Rule to allow resources initiated BY this site (Initiator Domains)
    // Extract domain for initiatorDomains
    let domain = pattern.replace(/\*/g, '');
    if (domain.includes('/') || domain.includes(':')) {
            try {
            let urlStr = domain;
            if (!urlStr.startsWith('http')) urlStr = 'http://' + urlStr;
            domain = new URL(urlStr).hostname;
            } catch (e) {
            // Fallback: take part before slash
            domain = domain.split('/')[0];
            }
    }
    
    const resourceRule = {
        id: ruleIdCounter++,
        priority: 2,
        action: { type: "allow" },
        condition: {
        initiatorDomains: [domain],
        resourceTypes: subResourceTypes
        }
    };
    newRules.push(resourceRule);
  }

  // Always allow the Config URL domain
  if (configUrl && configUrl.startsWith('http')) {
    try {
      const url = new URL(configUrl);
      newRules.push({
        id: 9000,
        priority: 3,
        action: { type: "allow" },
        condition: { urlFilter: `||${url.hostname}` }
      });
    } catch(e) {}
  }
  
  // Always allow localhost
  newRules.push({
    id: 9001,
    priority: 3,
    action: { type: "allow" },
    condition: { urlFilter: "||localhost" }
  });

  const blockAllRule = {
    id: 1,
    priority: 1,
    action: { type: "block" },
    condition: {
      urlFilter: "*",
      resourceTypes: allResourceTypes
    }
  };

  // Get existing rules to remove them
  const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = currentRules.map(r => r.id);

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: removeRuleIds,
    addRules: [blockAllRule, ...newRules]
  });

  // console.log(`[Service Worker] DNR Rules updated. Total rules: ${newRules.length + 1}`);
  // console.log("Active Allow Rules:", newRules);
}

// Ensure initialization runs when the Service Worker loads (e.g. after toggle)
setupAlarm().catch(console.error);