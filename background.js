// Storage for screenshots and blob URLs
let screenshotStorage = {};
let blobUrlStorage = null;

// Listen for messages from content script and popup
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
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
          sendResponse({error: chrome.runtime.lastError.message});
        } else if (!dataUrl) {
          console.error("No data URL returned from captureVisibleTab");
          sendResponse({error: "No screenshot data returned"});
        } else {
          sendResponse({dataUrl: dataUrl});
        }
      });
    } catch (error) {
      console.error("Exception during capture:", error);
      sendResponse({error: error.message});
    }
    return true; // Required for async sendResponse
  }

  // Store screenshot data for a specific tab
  if (request.action === "storeScreenshot") {
    screenshotStorage[request.tabId] = {
      dataUrl: request.dataUrl,
      hasGaps: request.hasGaps
    };
    sendResponse({success: true});
    return true;
  }

  // Retrieve screenshot data for a specific tab
  if (request.action === "getScreenshot") {
    const data = screenshotStorage[request.tabId];
    if (data) {
      // Clean up after sending
      delete screenshotStorage[request.tabId];
      sendResponse(data);
    } else {
      sendResponse({error: "Screenshot data not found"});
    }
    return true;
  }

  // Store blob URL
  if (request.action === "storeBlobUrl") {
    blobUrlStorage = {
      blobUrl: request.blobUrl,
      hasGaps: request.hasGaps
    };
    sendResponse({success: true});
    return true;
  }

  // Retrieve blob URL
  if (request.action === "getBlobUrl") {
    if (blobUrlStorage) {
      const data = {...blobUrlStorage};
      // Don't delete the blob URL as it might be needed again
      sendResponse(data);
    } else {
      sendResponse({error: "Blob URL not found"});
    }
    return true;
  }

  // Handle other message types if needed
  if (request.action === "logError") {
    console.error("Content script error:", request.error);
  }
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