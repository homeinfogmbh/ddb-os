# System Configuration & Whitelist Policy Documentation

This document outlines the parameter specifications for the Homeinfo Baywatch Chrome Extension, which retrieves whitelist configurations from the Homeinfo API and applies access control policies across the browser.

## 1. System ID Extraction

The extension automatically identifies which system configuration to retrieve using a **System ID**. This ID is extracted with the following priority:

| Priority | Source | Example | How It Works |
| :--- | :--- | :--- | :--- |
| 1 (Highest) | **GET Parameter** | `https://example.com/?system=terminal-123` | Extracts `system` URL parameter - **ALWAYS checked first** |
| 2 (Medium) | **Hostname** | `kiosk-42.homeinfo.de` | Extracts first part of hostname (e.g., `kiosk-42`) - only if no GET param |
| 3 (Lowest) | **Cache** | Previously stored value | Only used if URL has no system info |
| N/A | **Fallback** | Local `mock-cms/config.json` | If API fails, uses local configuration |

> ⚠️ **Important**: The `?system=` GET parameter **ALWAYS takes precedence**. If a user navigates to a URL with `?system=12345`, the extension will immediately use `12345` as the System ID, regardless of any cached value or hostname.

### Example Flow:
```
User navigates to: https://terminal-123.homeinfo.de/dashboard?system=lobby-screen

Extraction Order:
  1. GET parameter "system=lobby-screen" → USED (highest priority)
  2. Hostname "terminal-123" → SKIPPED (GET parameter already found)
  3. Cache → SKIPPED (GET parameter already found)
  
Result: System ID = "lobby-screen"
API Call: POST {"system": "lobby-screen"}
```

---

## 2. API Configuration

The extension retrieves whitelist configurations from the Homeinfo API:

| Property | Value | Description |
| :--- | :--- | :--- |
| **API Endpoint** | `https://portal.homeinfo.de/api/baywatch` | The production API URL |
| **HTTP Method** | `POST` | Request method for fetching configurations |
| **Content-Type** | `application/json` | Request header |
| **Request Body** | `{"system": "system-id"}` | System ID passed as JSON |
| **Response Format** | JSON (config object) | Same format as local `config.json` |

---

## 3. Configuration File Structure

The API returns (and local `config.json` follows) this JSON structure:

### A. General Settings (`config`)

These parameters define how the extension behaves and processes configuration updates.

| Key | Type | Description | Technical Context |
| :--- | :--- | :--- | :--- |
| `updateIntervalMinutes` | `Integer` | Frequency (in minutes) for checking API for new configurations | Example: `1` (check every 1 minute). Default: 1 |
| `popupMode` | `String` | Controls popup and new tab link behavior | Values: `allow` (default), `deny` (blocks popups), `self` (forces same tab) |
| `linkTargetMode` | `String` | Controls how target attributes are handled | Values: `allow` (default), `deny` (blocks targets) |

### B. Whitelist Configuration (`whitelist`)

The whitelist is an array of URL patterns that are **allowed** to be accessed. All other URLs are **blocked** by default.

#### **URL Pattern Matching Rules**

The extension supports wildcard patterns to define URL scope:

| Pattern Example | Logic Name | Explanation | Use Case |
| :--- | :--- | :--- | :--- |
| `*example.com*` | **Universal Wildcard** | Allows any subdomain AND any path (e.g., `mail.example.com/inbox`, `api.example.com/v1/data`) | Most permissive - entire domain |
| `*example.com` | **Subdomain Wildcard** | Allows all subdomains but no specific paths (e.g., `www.example.com`, `api.example.com`) | Allow domain with any subdomain |
| `example.com*` | **Path Wildcard** | Allows the domain and any path segments (e.g., `example.com/login`, `example.com/dashboard`) | Allow specific domain paths |
| `example.com` | **Exact Match** | Allows ONLY the root domain; subdomains/paths blocked | Restrictive - root domain only |
| `example.com/drive` | **Exact Path** | Allows ONLY this specific path (e.g., `example.com/drive/files`) | Most restrictive - single path |

## 4. Example Configuration

Below is a valid configuration that the API should return:

```json
{
  "config": {
    "updateIntervalMinutes": 1,
    "linkTargetMode": "allow",
    "popupMode": "allow"
  },
  "whitelist": [
    {
      "url": "*google.com*"
    },
    {
      "url": "*microsoft.com*"
    },
    {
      "url": "example.com/dashboard"
    }
  ]
}
```

---

## 5. How It Works - System Flow

### 5.1 Extension Startup

1. Extension is installed or browser restarts
2. `chrome.runtime.onInstalled` or `chrome.runtime.onStartup` triggers
3. System ID is extracted (GET parameter or hostname)
4. API call is made: `POST https://portal.homeinfo.de/api/baywatch` with `{"system": "system-id"}`

### 5.2 API Request/Response

**Request:**
```javascript
POST https://portal.homeinfo.de/api/baywatch
Content-Type: application/json

{
  "system": "terminal-123"
}
```

**Expected Response (200 OK):**
```json
{
  "config": {
    "updateIntervalMinutes": 1,
    "linkTargetMode": "allow",
    "popupMode": "allow"
  },
  "whitelist": [
    { "url": "*google.com*" },
    { "url": "*microsoft.com*" }
  ]
}
```

### 5.3 Fallback Mechanism

If the API fails (network error, timeout, etc.):
1. Extension logs the error
2. Falls back to local `mock-cms/config.json`
3. Uses local configuration for whitelist enforcement
4. Retries API call on next alarm interval

### 5.4 Continuous Updates

- Extension sets an alarm (default: every 1 minute)
- Each alarm triggers a new API fetch
- If configuration changes, new whitelist rules are applied immediately
- No page refresh or redirect is triggered

---

## 6. Development Environment Setup

### Using Local Mock Server

To test with a local mock CMS server during development:

```bash
# Navigate to the extension root directory
cd Baywatch

# Serve the mock config locally on port 8000
npx http-server mock-cms -p 8000
```

### Testing with Static System ID

For testing without a dynamic hostname/GET parameter:

1. Edit `service-worker.js`
2. In the `getSystemId()` function, add a fallback:
```javascript
// Temporary test fallback
if (!systemId) {
  systemId = 'test-system-123';
  console.log("[Service Worker] Using test systemId:", systemId);
}
```

---

## 7. Production Deployment Notes

| Item | Requirement |
| :--- | :--- |
| **API Endpoint** | Must be `https://portal.homeinfo.de/api/baywatch` |
| **SSL/TLS** | API must use HTTPS (already configured) |
| **CORS** | API should allow POST requests from Chrome extension origins |
| **Response Format** | Must match the JSON structure defined in Section 4 |
| **System ID Format** | Can be alphanumeric (e.g., `terminal-123`, `kiosk-42`) |