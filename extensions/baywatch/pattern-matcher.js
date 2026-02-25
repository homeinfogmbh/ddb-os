/**
 * Checks if a URL is allowed based on the whitelist patterns.
 * @param {string} urlStr - The URL to check.
 * @param {string[]} whitelist - Array of whitelist patterns.
 * @returns {boolean} - True if allowed, false otherwise.
 */
function isUrlAllowed(urlStr, whitelist) {
  if (!whitelist || !Array.isArray(whitelist) || whitelist.length === 0) {
    return false;
  }

  let url;
  try {
    url = new URL(urlStr);
  } catch (e) {
    return false;
  }

  const hostname = url.hostname;
  const fullUrl = url.href;

  for (const entry of whitelist) {
    let pattern;
    if (typeof entry === 'string') {
      pattern = entry;
    } else if (typeof entry === 'object' && entry.url) {
      pattern = entry.url;
    } else {
      continue;
    }

    // *example.com* -> All subdomains, domain, and ALL paths
    if (pattern.startsWith('*') && pattern.endsWith('*')) {
      const core = pattern.slice(1, -1); // "example.com"
      if (hostname === core || hostname.endsWith('.' + core)) {
        return true;
      }
    }
    
    // *example.com -> Domain and subdomains, but ROOT PATH ONLY
    else if (pattern.startsWith('*')) {
      const core = pattern.slice(1); // "example.com"
      if (hostname === core || hostname.endsWith('.' + core)) {
        if (url.pathname === '/' || url.pathname === '') {
          return true;
        }
      }
    }

    // Path specific (contains '/')
    else if (pattern.includes('/')) {
      let patternHost, patternPath;
      
      if (pattern.startsWith('http')) {
        if (fullUrl.startsWith(pattern)) return true;
      } else {
        const firstSlash = pattern.indexOf('/');
        patternHost = pattern.substring(0, firstSlash);
        patternPath = pattern.substring(firstSlash);

        if (hostname === patternHost) {
           if (url.pathname.startsWith(patternPath)) {
             return true;
           }
        }
      }
    }

    // example.com -> Exact domain only, ROOT PATH ONLY
    else {
      if (hostname === pattern) {
        if (url.pathname === '/' || url.pathname === '') {
          return true;
        }
      }
    }
  }

  return false;
}

if (typeof module !== 'undefined') {
  module.exports = { isUrlAllowed };
}
