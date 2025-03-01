// Storage for screenshots and blob URLs
let screenshotStorage = {};
let blobUrlStorage = null;
let actualBlob = null; // Store the actual blob object to prevent garbage collection

// Keep track of pending responses
let pendingResponses = new Map();

// Helper function to safely send a response
function safeRespond(responseId, data) {
  if (pendingResponses.has(responseId)) {
    try {
      const sendResponse = pendingResponses.get(responseId);
      sendResponse(data);
      pendingResponses.delete(responseId);
    } catch (error) {
      console.error("Error sending response:", error);
    }
  }
}

// Listen for messages from content script and popup
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  // Store the sendResponse function for later use if needed
  const responseId = Date.now() + Math.random().toString(36).substring(2, 15);
  pendingResponses.set(responseId, sendResponse);

  // Set a timeout to clean up the pending response after 30 seconds
  setTimeout(() => {
    if (pendingResponses.has(responseId)) {
      pendingResponses.delete(responseId);
    }
  }, 30000);

  // Handle keepAlive messages to prevent popup from closing
  if (request.action === "keepAlive") {
    safeRespond(responseId, {status: "alive"});
    return true;
  }

  if (request.action === "captureVisibleArea") {
    try {
      // Set capture options
      const captureOptions = {
        format: request.format || 'png',
        quality: request.quality || 100
      };

      chrome.tabs.captureVisibleTab(null, captureOptions, function(dataUrl) {
        if (chrome.runtime.lastError) {
          console.error("Error capturing tab:", chrome.runtime.lastError);
          safeRespond(responseId, {error: chrome.runtime.lastError.message});
        } else if (!dataUrl) {
          console.error("No data URL returned from captureVisibleTab");
          safeRespond(responseId, {error: "No screenshot data returned"});
        } else {
          safeRespond(responseId, {dataUrl: dataUrl});
        }
      });
    } catch (error) {
      console.error("Exception during capture:", error);
      safeRespond(responseId, {error: error.message});
    }
    return true; // Required for async sendResponse
  }

  // Store screenshot data for a specific tab
  if (request.action === "storeScreenshot") {
    screenshotStorage[request.tabId] = {
      dataUrl: request.dataUrl,
      hasGaps: request.hasGaps
    };
    safeRespond(responseId, {success: true});
    return true;
  }

  // Retrieve screenshot data for a specific tab
  if (request.action === "getScreenshot") {
    const data = screenshotStorage[request.tabId];
    if (data) {
      // Clean up after sending
      delete screenshotStorage[request.tabId];
      safeRespond(responseId, data);
    } else {
      safeRespond(responseId, {error: "Screenshot data not found"});
    }
    return true;
  }

  // Store blob URL
  if (request.action === "storeBlobUrl") {
    blobUrlStorage = {
      blobUrl: request.blobUrl,
      hasGaps: request.hasGaps
    };
    safeRespond(responseId, {success: true});
    return true;
  }

  // Retrieve blob URL
  if (request.action === "getBlobUrl") {
    if (blobUrlStorage) {
      const data = {...blobUrlStorage};
      // Don't delete the blob URL as it might be needed again
      safeRespond(responseId, data);
    } else {
      safeRespond(responseId, {error: "Blob URL not found"});
    }
    return true;
  }

  // Handle other message types if needed
  if (request.action === "logError") {
    console.error("Content script error:", request.error);
  }

  return true; // Keep the message channel open for all messages
});

// Clean up blob URLs when tabs are closed
chrome.tabs.onRemoved.addListener(function(tabId, removeInfo) {
  // Clean up any stored screenshots for this tab
  if (screenshotStorage[tabId]) {
    delete screenshotStorage[tabId];
  }

  // We don't revoke the blob URL here as it might be used by other tabs
  // The blob URL will be cleaned up when the browser is closed
});