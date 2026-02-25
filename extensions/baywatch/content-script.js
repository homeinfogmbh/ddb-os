let appConfig = {
  config: {
    "linkTargetMode": "allow", 
    messages: {
      blockedTitle: "Access Denied",
      blockedBody: "This domain is not on the whitelist.",
      "adminContact": "admin@company.com"
    }
  },
  whitelist: []
};

const isInIframe = window.self !== window.top;

// Request config from service worker on every page load
function requestConfigOnLoad() {
  // console.log("[Content Script] Requesting config on page load...");
  chrome.runtime.sendMessage({ type: 'REQUEST_CONFIG' }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("[Content Script] Error requesting config:", chrome.runtime.lastError);
      // Fallback to cached config
      chrome.storage.local.get(['appConfig'], (result) => {
        if (result.appConfig) {
          appConfig = result.appConfig;
          // console.log("[Content Script] Fallback to cached config:", appConfig);
        }
      });
      return;
    }
    if (response && response.config) {
      appConfig = response.config;
      // console.log("[Content Script] Config received on page load:", appConfig);
    }
  });
}

// Request config on page load
requestConfigOnLoad();

// Also load from storage as immediate fallback
chrome.storage.local.get(['appConfig'], (result) => {
  if (result.appConfig) {
    appConfig = result.appConfig;
    // console.log("[Content Script] Config loaded from storage:", appConfig);
  }
});

// Listen for updates - with special handling for iframes
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.appConfig) {
    const oldConfig = appConfig;
    appConfig = changes.appConfig.newValue;
    // console.log("[Content Script] Config updated:", appConfig);
    if (isInIframe) {
      const currentUrl = window.location.href;
      const wasAllowed = oldConfig.whitelist && isUrlAllowed(currentUrl, oldConfig.whitelist);
      const isNowAllowed = appConfig.whitelist && isUrlAllowed(currentUrl, appConfig.whitelist);
      
      if (wasAllowed && !isNowAllowed) {
        // console.log("[Content Script] Iframe content now blocked, forcing reload");
        // Clear the iframe content and reload to apply new blocking rules
        window.location.reload();
      }
    }
  }
});

document.addEventListener('click', function(event) {
  let targetElement = event.target.closest('a');

  if (targetElement && targetElement.href) {

    // Handle Popup/Target Mode
    const popupMode = (appConfig.config && appConfig.config.popupMode) ? appConfig.config.popupMode : 'allow';
    const targetAttr = targetElement.getAttribute('target');

    if (targetAttr && targetAttr.toLowerCase() !== '_self') {
      if (popupMode === 'deny') {
        console.warn("[Content Script] 🚫 POPUP/TARGET BLOCKED:", targetElement.href);
        event.preventDefault();
        event.stopPropagation();
        return;
      } else if (popupMode === 'self') {
        targetElement.setAttribute('target', '_self');
      }
    }
    
    let url;
    try {
      url = new URL(targetElement.href);
    } catch (e) {
      return;
    }

    const protocol = url.protocol;
    const hostname = url.hostname;

    if (protocol === 'mailto:') {
      console.warn("[Content Script] 🚫 BLOCKED mailto link:", targetElement.href);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Block all non-HTTP protocols (chrome://, about:, file://, javascript:, tel:, etc.)
    if (!protocol.startsWith('http')) {
      console.warn("[Content Script] 🚫 BLOCKED non-HTTP protocol:", protocol, targetElement.href);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Ignore empty hostnames
    if (!hostname) {
      return;
    }

    // Check if allowed using the shared pattern matcher
    // Note: isUrlAllowed is defined in pattern-matcher.js which is loaded before this script
    if (typeof isUrlAllowed !== 'function') {
      console.error("Pattern matcher not loaded!");
      return;
    }

    if (isUrlAllowed(targetElement.href, appConfig.whitelist)) {
      // console.log("[Content Script] ✅ ALLOWED:", targetElement.href);
      return;
    }

    // DEFAULT DENY: Block everything not in whitelist
    console.warn("[Content Script] 🚫 BLOCKED:", targetElement.href);
    event.preventDefault();
    event.stopPropagation();
    
    // Check if allowed using the shared pattern matcher
    // Note: isUrlAllowed is defined in pattern-matcher.js which is loaded before this script
    if (typeof isUrlAllowed !== 'function') {
      console.error("Pattern matcher not loaded!");
      return;
    }

    if (isUrlAllowed(targetElement.href, appConfig.whitelist)) {
      // console.log("[Content Script] ✅ ALLOWED:", targetElement.href);
      return;
    }

    // DEFAULT DENY: Block everything not in whitelist
    console.warn("[Content Script] 🚫 BLOCKED:", targetElement.href);
    event.preventDefault();
    event.stopPropagation();
  }
}, true);

// Handle middle clicks (auxclick)
document.addEventListener('auxclick', function(event) {
  if (event.button !== 1) return; // Only middle click

  let targetElement = event.target.closest('a');
  if (targetElement && targetElement.href) {
    const popupMode = (appConfig.config && appConfig.config.popupMode) ? appConfig.config.popupMode : 'allow';

    if (popupMode === 'deny') {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Same logic as click
    let url;
    try { url = new URL(targetElement.href); } catch (e) { return; }
    
    const protocol = url.protocol;
    const hostname = url.hostname;

    if (protocol === 'mailto:') {
      console.warn("[Content Script] 🚫 BLOCKED mailto link (AuxClick):", targetElement.href);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Block all non-HTTP protocols
    if (!protocol.startsWith('http')) {
      console.warn("[Content Script] 🚫 BLOCKED non-HTTP protocol (AuxClick):", protocol, targetElement.href);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (!hostname) return;

    if (typeof isUrlAllowed !== 'function') return;

    if (isUrlAllowed(targetElement.href, appConfig.whitelist)) {
      if (popupMode === 'self') {
        event.preventDefault();
        window.location.href = targetElement.href;
      }
      return;
    }

    console.warn("[Content Script] 🚫 BLOCKED (AuxClick):", targetElement.href);
    event.preventDefault();
    event.stopPropagation();
  }
}, true);

// --- DOM INSPECTION & MUTATION OBSERVER ---
// Requirement: "Watch for DOM changes... inspect link attributes... identify all iFrames... inspect their contents"

const observerConfig = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['href', 'src']
};

const mutationObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.type === 'childList') {
      mutation.addedNodes.forEach(node => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          inspectElement(node);
          // Inspect descendants
          const links = node.querySelectorAll('a');
          const iframes = node.querySelectorAll('iframe');
          links.forEach(inspectLink);
          iframes.forEach(inspectIframe);
        }
      });
    } else if (mutation.type === 'attributes') {
      inspectElement(mutation.target);
    }
  }
});

function startObserver() {
  mutationObserver.observe(document.body, observerConfig);
  // Initial scan
  document.querySelectorAll('a').forEach(inspectLink);
  document.querySelectorAll('iframe').forEach(inspectIframe);
}

function inspectElement(node) {
  if (node.tagName === 'A') inspectLink(node);
  if (node.tagName === 'IFRAME') inspectIframe(node);
}

function inspectLink(link) {
  if (!link.href || !appConfig.whitelist) return;
  
  // Skip if already marked
  if (link.dataset.securityChecked === 'true') return;

  if (!isUrlAllowed(link.href, appConfig.whitelist)) {
    // Mark as blocked (internal state only, no visual change)
    link.dataset.securityChecked = 'true';
    link.dataset.securityStatus = 'blocked';
  } else {
    link.dataset.securityChecked = 'true';
    link.dataset.securityStatus = 'allowed';
  }
}

function inspectIframe(iframe) {
  // We can only check the src attribute. 
  // The content inside is handled by the content-script instance running INSIDE the iframe (all_frames: true).
  if (!iframe.src || !appConfig.whitelist) return;

  if (!isUrlAllowed(iframe.src, appConfig.whitelist)) {
    // Blocked iframe - force reload the iframe to apply blocking
    // This ensures that if config was updated to block content, the iframe reflects this
    if (iframe.dataset.lastBlockedSrc !== iframe.src) {
      // console.log("[Content Script] Iframe blocked, forcing reload:", iframe.src);
      iframe.dataset.lastBlockedSrc = iframe.src;
      // Clear iframe content and set to about:blank to ensure blocked content is removed
      iframe.src = 'about:blank';
    }
  }
}

// Start observing when config is loaded or DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    // Wait for config
    setTimeout(startObserver, 1000); 
  });
} else {
  setTimeout(startObserver, 1000);
}

// Re-run inspection when config changes
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.appConfig) {
    const oldConfig = changes.appConfig.oldValue;
    const newConfig = changes.appConfig.newValue;
    
    // Re-scan everything with new config
    document.querySelectorAll('a').forEach(link => {
      delete link.dataset.securityChecked;
      inspectLink(link);
    });
    
    document.querySelectorAll('iframe').forEach(iframe => {
      if (iframe.src && oldConfig && oldConfig.whitelist && newConfig && newConfig.whitelist) {
        const wasAllowed = isUrlAllowed(iframe.src, oldConfig.whitelist);
        const isNowAllowed = isUrlAllowed(iframe.src, newConfig.whitelist);
        
        if (wasAllowed && !isNowAllowed) {
          // console.log("[Content Script] Iframe now blocked by config change, clearing:", iframe.src);
          // Clear the iframe by setting to about:blank - the blocked content won't reload
          iframe.dataset.lastBlockedSrc = iframe.src;
          iframe.src = 'about:blank';
        }
      }
      inspectIframe(iframe);
    });
  }
});