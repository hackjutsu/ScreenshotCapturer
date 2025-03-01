// Storage for screenshots and blob URLs
let screenshotStorage = {};
let blobUrlStorage = null;
let actualBlob = null; // Store the actual blob object to prevent garbage collection
let dataUrlStorage = null; // Store the data URL as a fallback

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

// Check if URL.createObjectURL is available
const hasCreateObjectURL = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
console.log("Background: URL.createObjectURL available:", hasCreateObjectURL);

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
    try {
      console.log("Background: Storing blob data", request.blob ? "Blob provided" : "No blob provided");

      // Store the data URL as a fallback
      if (request.dataUrl) {
        dataUrlStorage = request.dataUrl;
        console.log("Background: Stored data URL as fallback, length:", dataUrlStorage.length);
      }

      // If URL.createObjectURL is not available, use the data URL directly
      if (!hasCreateObjectURL) {
        console.log("Background: URL.createObjectURL not available, using data URL directly");

        // Store the metadata
        blobUrlStorage = {
          blobUrl: dataUrlStorage, // Use the data URL instead of a blob URL
          hasGaps: request.hasGaps || false,
          scaled: request.scaled || false,
          quality: request.quality || 100,
          originalWidth: request.dimensions?.originalWidth,
          originalHeight: request.dimensions?.originalHeight,
          finalWidth: request.dimensions?.finalWidth,
          finalHeight: request.dimensions?.finalHeight,
          imageSize: request.dimensions?.imageSize || (dataUrlStorage ? dataUrlStorage.length : null)
        };

        console.log("Background: Data URL stored successfully");
        safeRespond(responseId, {success: true, blobUrl: dataUrlStorage});
        return true;
      }

      // Store the actual blob to prevent garbage collection
      if (request.blob) {
        actualBlob = request.blob;
        console.log("Background: Stored actual blob, size:", actualBlob.size);
      } else if (request.dataUrl) {
        try {
          // Parse the data URL
          const parts = request.dataUrl.split(',');
          const mime = parts[0].match(/:(.*?);/)[1];
          const binary = atob(parts[1]);
          const array = [];
          for (let i = 0; i < binary.length; i++) {
            array.push(binary.charCodeAt(i));
          }
          actualBlob = new Blob([new Uint8Array(array)], {type: mime});
          console.log("Background: Created blob from dataUrl, size:", actualBlob.size);
        } catch (blobError) {
          console.error("Background: Error creating blob from dataUrl:", blobError);
          safeRespond(responseId, {error: "Failed to create blob: " + blobError.message});
          return true;
        }
      } else {
        console.error("Background: No blob or dataUrl provided");
        safeRespond(responseId, {error: "No blob or dataUrl provided"});
        return true;
      }

      // Create a new blob URL from the actual blob
      let blobUrl;
      try {
        // Revoke the old URL if it exists to prevent memory leaks
        if (blobUrlStorage && blobUrlStorage.blobUrl) {
          try {
            URL.revokeObjectURL(blobUrlStorage.blobUrl);
          } catch (e) {
            console.warn("Background: Error revoking old blob URL:", e);
          }
        }

        // Create a new blob URL
        blobUrl = URL.createObjectURL(actualBlob);
        console.log("Background: Created new blob URL:", blobUrl);
      } catch (urlError) {
        console.error("Background: Error creating blob URL:", urlError);

        // Fall back to using the data URL
        if (dataUrlStorage) {
          console.log("Background: Falling back to data URL");
          blobUrl = dataUrlStorage;
        } else {
          safeRespond(responseId, {error: "Failed to create blob URL and no data URL fallback available"});
          return true;
        }
      }

      // Store the blob URL and metadata
      blobUrlStorage = {
        blobUrl: blobUrl,
        hasGaps: request.hasGaps || false,
        scaled: request.scaled || false,
        quality: request.quality || 100,
        originalWidth: request.dimensions?.originalWidth,
        originalHeight: request.dimensions?.originalHeight,
        finalWidth: request.dimensions?.finalWidth,
        finalHeight: request.dimensions?.finalHeight,
        imageSize: request.dimensions?.imageSize || (actualBlob ? actualBlob.size : null)
      };

      console.log("Background: Blob URL stored successfully:", blobUrl);
      safeRespond(responseId, {success: true, blobUrl: blobUrl});
    } catch (error) {
      console.error("Background: Error storing blob URL:", error);

      // Fall back to using the data URL if available
      if (dataUrlStorage) {
        console.log("Background: Falling back to data URL after error");
        blobUrlStorage = {
          blobUrl: dataUrlStorage,
          hasGaps: request.hasGaps || false,
          scaled: request.scaled || false,
          quality: request.quality || 100
        };
        safeRespond(responseId, {success: true, blobUrl: dataUrlStorage});
      } else {
        safeRespond(responseId, {error: "Failed to store blob: " + error.message});
      }
    }
    return true;
  }

  // Retrieve blob URL
  if (request.action === "getBlobUrl") {
    try {
      console.log("Background: Retrieving blob URL");

      // If URL.createObjectURL is not available, use the data URL directly
      if (!hasCreateObjectURL) {
        if (dataUrlStorage) {
          console.log("Background: Returning stored data URL");
          safeRespond(responseId, {
            blobUrl: dataUrlStorage,
            hasGaps: blobUrlStorage?.hasGaps || false,
            scaled: blobUrlStorage?.scaled || false,
            quality: blobUrlStorage?.quality || 100
          });
        } else {
          console.error("Background: No data URL available");
          safeRespond(responseId, {error: "No data URL available"});
        }
        return true;
      }

      // If we have a blob URL stored, return it
      if (blobUrlStorage && blobUrlStorage.blobUrl) {
        console.log("Background: Returning stored blob URL:", blobUrlStorage.blobUrl);
        safeRespond(responseId, blobUrlStorage);
        return true;
      }

      // If we have the actual blob, create a new URL
      if (actualBlob) {
        try {
          const freshBlobUrl = URL.createObjectURL(actualBlob);
          console.log("Background: Created fresh blob URL:", freshBlobUrl);

          // Update the storage
          if (!blobUrlStorage) {
            blobUrlStorage = {
              hasGaps: false,
              scaled: false,
              quality: 100
            };
          }

          blobUrlStorage.blobUrl = freshBlobUrl;

          // Send the response
          safeRespond(responseId, blobUrlStorage);
        } catch (urlError) {
          console.error("Background: Error creating fresh blob URL:", urlError);

          // Fall back to data URL if available
          if (dataUrlStorage) {
            console.log("Background: Falling back to data URL");
            safeRespond(responseId, {
              blobUrl: dataUrlStorage,
              hasGaps: blobUrlStorage?.hasGaps || false,
              scaled: blobUrlStorage?.scaled || false,
              quality: blobUrlStorage?.quality || 100
            });
          } else {
            safeRespond(responseId, {error: "Failed to create fresh blob URL and no data URL fallback available"});
          }
        }
      } else if (dataUrlStorage) {
        // Fall back to data URL if no blob is available
        console.log("Background: No blob available, using data URL");
        safeRespond(responseId, {
          blobUrl: dataUrlStorage,
          hasGaps: blobUrlStorage?.hasGaps || false,
          scaled: blobUrlStorage?.scaled || false,
          quality: blobUrlStorage?.quality || 100
        });
      } else {
        console.error("Background: No blob or data URL available");
        safeRespond(responseId, {error: "No screenshot data available"});
      }
    } catch (error) {
      console.error("Background: Error retrieving blob URL:", error);

      // Fall back to data URL if available
      if (dataUrlStorage) {
        console.log("Background: Falling back to data URL after error");
        safeRespond(responseId, {
          blobUrl: dataUrlStorage,
          hasGaps: blobUrlStorage?.hasGaps || false,
          scaled: blobUrlStorage?.scaled || false,
          quality: blobUrlStorage?.quality || 100
        });
      } else {
        safeRespond(responseId, {error: "Failed to retrieve blob URL: " + error.message});
      }
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