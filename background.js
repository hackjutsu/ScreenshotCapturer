// Storage for screenshots and blob URLs
let screenshotStorage = {};
let blobUrlStorage = null;
let actualBlob = null; // Store the actual blob object to prevent garbage collection
let dataUrlStorage = null; // Store the data URL as a fallback

// Keep track of pending responses
let pendingResponses = new Map();

// Helper function to safely send a response
function safeRespond(responseId, data, suppressErrorLogging = false) {
  if (!responseId) {
    console.debug("No responseId provided to safeRespond");
    return;
  }

  if (pendingResponses.has(responseId)) {
    try {
      const sendResponse = pendingResponses.get(responseId);
      if (typeof sendResponse === 'function') {
        sendResponse(data);
        pendingResponses.delete(responseId);
      } else {
        console.warn("Invalid sendResponse function for responseId:", responseId);
        pendingResponses.delete(responseId);
      }
    } catch (error) {
      // Only log errors if not suppressed
      if (!suppressErrorLogging) {
        console.error("Error sending response:", error);
      }

      // Clean up the pending response even if there was an error
      pendingResponses.delete(responseId);
    }
  } else {
    if (!suppressErrorLogging) {
      console.debug("No pending response found for responseId:", responseId);
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

  // Only store the response function if it's provided and valid
  if (typeof sendResponse === 'function') {
    pendingResponses.set(responseId, sendResponse);

    // Set a timeout to clean up the pending response after 30 seconds
    setTimeout(() => {
      if (pendingResponses.has(responseId)) {
        pendingResponses.delete(responseId);
      }
    }, 30000);
  } else {
    console.log("No response function provided for message:", request.action);
  }

  // Handle the new message from content script to capture full page using background script
  if (request.action === "captureFullPageFromBackground") {
    console.log("Background: Received captureFullPageFromBackground request");

    // Get the tab ID from the sender if not provided in the request
    const tabId = request.tabId || (sender && sender.tab && sender.tab.id);

    if (!tabId) {
      console.error("Background: No tab ID provided for captureFullPageFromBackground");
      safeRespond(responseId, {error: "No tab ID provided"});
      return true;
    }

    console.log("Background: Starting full page capture for tab:", tabId);

    // Call the captureFullPage function with the tab ID
    captureFullPage(tabId, {format: 'png'})
      .then(result => {
        console.log("Background: Full page capture completed successfully");

        // Instead of processing captures here, send them back to the content script
        // for processing since service workers don't have DOM access
        chrome.tabs.sendMessage(tabId, {
          action: "processCaptures",
          captures: result.captures,
          dimensions: result.dimensions
        });

        safeRespond(responseId, {success: true, message: "Captures sent to content script for processing"});
      })
      .catch(error => {
        console.error("Background: Error in full page capture:", error);
        safeRespond(responseId, {error: error.message || "Unknown error"});
      });

    return true; // Required for async sendResponse
  }

  // Handle keepAlive messages to prevent popup from closing
  if (request.action === "keepAlive") {
    // For keepAlive messages, we'll suppress error logging since these errors are expected
    // when the popup closes
    safeRespond(responseId, {status: "alive"}, true); // true = suppress error logging
    return true; // Keep the original behavior
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
    // Process the request even if we can't send a response
    // This ensures the screenshot is stored even if the popup closes

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

        // Try to send a response, but don't worry if it fails
        try {
          safeRespond(responseId, {success: true, blobUrl: dataUrlStorage}, true);
        } catch (responseError) {
          // Silently ignore response errors
        }

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
          safeRespond(responseId, {error: "Failed to create blob URL and no data URL fallback available"}, true);
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

      // Try to send a response, but don't worry if it fails
      try {
        safeRespond(responseId, {success: true, blobUrl: blobUrl}, true);
      } catch (responseError) {
        // Silently ignore response errors
      }
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

        // Try to send a response, but don't worry if it fails
        try {
          safeRespond(responseId, {success: true, blobUrl: dataUrlStorage}, true);
        } catch (responseError) {
          // Silently ignore response errors
        }
      } else {
        // Try to send an error response, but don't worry if it fails
        try {
          safeRespond(responseId, {error: "Failed to store blob: " + error.message}, true);
        } catch (responseError) {
          // Silently ignore response errors
        }
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
          }, true); // Suppress error logging
        } else {
          console.error("Background: No data URL available");
          safeRespond(responseId, {error: "No data URL available"}, true); // Suppress error logging
        }
        return true;
      }

      // If we have a blob URL stored, return it
      if (blobUrlStorage && blobUrlStorage.blobUrl) {
        console.log("Background: Returning stored blob URL:", blobUrlStorage.blobUrl);
        safeRespond(responseId, blobUrlStorage, true); // Suppress error logging
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
          safeRespond(responseId, blobUrlStorage, true); // Suppress error logging
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
            }, true); // Suppress error logging
          } else {
            safeRespond(responseId, {error: "Failed to create fresh blob URL and no data URL fallback available"}, true);
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
        }, true);
      } else {
        console.error("Background: No blob or data URL available");
        safeRespond(responseId, {error: "No screenshot data available"}, true);
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
        }, true);
      } else {
        safeRespond(responseId, {error: "Failed to retrieve blob URL: " + error.message}, true);
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

// Function to detect sticky elements in the page
function detectStickyElements(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      {
        target: {tabId: tabId},
        func: () => {
          // Array to store detected sticky elements
          const stickyElements = [];

          // Helper function to check if an element is visible
          function isVisible(element) {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            return style.display !== 'none' &&
                   style.visibility !== 'hidden' &&
                   style.opacity !== '0' &&
                   element.offsetWidth > 0 &&
                   element.offsetHeight > 0;
          }

          // Helper function to generate a unique selector for an element
          function generateSelector(element) {
            // If element has an ID, use that (most reliable)
            if (element.id) {
              return '#' + CSS.escape(element.id);
            }

            // If element has classes, try using tag + classes
            if (element.className && typeof element.className === 'string') {
              const classes = element.className.split(/\s+/).filter(c => c);
              if (classes.length > 0) {
                const selector = element.tagName.toLowerCase() + '.' + classes.map(c => CSS.escape(c)).join('.');
                // Check if this selector uniquely identifies the element
                try {
                  if (document.querySelectorAll(selector).length === 1) {
                    return selector;
                  }
                } catch (e) {
                  // If selector is invalid, continue to other methods
                }
              }
            }

            // Try with tag name and attribute
            const attributes = ['role', 'data-testid', 'aria-label'];
            for (const attr of attributes) {
              if (element.hasAttribute(attr)) {
                try {
                  const attrSelector = element.tagName.toLowerCase() + '[' + attr + '="' + element.getAttribute(attr).replace(/"/g, '\\"') + '"]';
                  if (document.querySelectorAll(attrSelector).length === 1) {
                    return attrSelector;
                  }
                } catch (e) {
                  // If selector is invalid, continue to other methods
                }
              }
            }

            // Fallback: create a path to the element
            let path = [];
            let current = element;

            while (current && current.nodeType === Node.ELEMENT_NODE) {
              let selector = current.nodeName.toLowerCase();

              if (current.id) {
                selector += '#' + CSS.escape(current.id);
                path.unshift(selector);
                break;
              } else {
                // Add position among siblings
                let sibling = current, nth = 1;
                while (sibling = sibling.previousElementSibling) {
                  nth++;
                }

                selector += ":nth-child(" + nth + ")";
                path.unshift(selector);

                current = current.parentNode;
              }
            }

            return path.join(' > ');
          }

          // 1. Check elements with fixed or sticky positioning
          const positionedElements = [];

          // Find elements with explicit position:fixed or position:sticky
          document.querySelectorAll('*').forEach(element => {
            if (!isVisible(element)) return;

            const style = window.getComputedStyle(element);
            if (style.position === 'fixed' || style.position === 'sticky') {
              const rect = element.getBoundingClientRect();

              // Only consider elements that are reasonably sized
              // (avoid tiny fixed elements like scroll indicators)
              if (rect.width >= 100 && rect.height >= 30) {
                positionedElements.push({
                  element: element,
                  rect: rect,
                  style: style,
                  source: 'positioned'
                });
              }
            }
          });

          // 2. Check for common header and navigation patterns
          const headerSelectors = [
            'header', '.header', '#header',
            'nav', '.nav', '#nav', '.navbar', '#navbar',
            '.site-header', '#site-header',
            '.top-bar', '.navigation', '.main-navigation'
          ];

          headerSelectors.forEach(selector => {
            try {
              const elements = document.querySelectorAll(selector);
              elements.forEach(element => {
                if (!isVisible(element)) return;

                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);

                // Check if it's at the top of the viewport or has fixed/sticky positioning
                if ((rect.top < 100 && rect.width >= 100 && rect.height >= 30) ||
                    style.position === 'fixed' || style.position === 'sticky') {
                  positionedElements.push({
                    element: element,
                    rect: rect,
                    style: style,
                    source: 'header'
                  });
                }
              });
            } catch (e) {
              // Skip invalid selectors
            }
          });

          // 3. Check for sidebar patterns
          const sidebarSelectors = [
            'aside', '.sidebar', '#sidebar',
            '.side-panel', '#side-panel',
            '.toc', '#toc', '.table-of-contents',
            '.left-sidebar', '.right-sidebar'
          ];

          sidebarSelectors.forEach(selector => {
            try {
              const elements = document.querySelectorAll(selector);
              elements.forEach(element => {
                if (!isVisible(element)) return;

                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);

                // Check if it's on the side of the viewport or has fixed/sticky positioning
                if (((rect.left < 300 || rect.right > window.innerWidth - 300) &&
                     rect.height > 200) ||
                    style.position === 'fixed' || style.position === 'sticky') {
                  positionedElements.push({
                    element: element,
                    rect: rect,
                    style: style,
                    source: 'sidebar'
                  });
                }
              });
            } catch (e) {
              // Skip invalid selectors
            }
          });

          // Process the collected elements
          // Remove duplicates (elements that contain other elements)
          const filteredElements = [];

          positionedElements.forEach(item => {
            // Check if this element is contained by any other element we've found
            let isContained = false;

            for (const otherItem of positionedElements) {
              if (item.element !== otherItem.element &&
                  otherItem.element.contains(item.element)) {
                isContained = true;
                break;
              }
            }

            if (!isContained) {
              filteredElements.push(item);
            }
          });

          // Convert to the final format with selectors
          filteredElements.forEach(item => {
            const selector = generateSelector(item.element);
            stickyElements.push({
              selector: selector,
              position: item.style.position,
              top: item.rect.top,
              left: item.rect.left,
              width: item.rect.width,
              height: item.rect.height,
              isHeader: item.rect.top < 100 && item.rect.width > window.innerWidth / 2,
              isSidebar: (item.rect.left < 300 || item.rect.right > window.innerWidth - 300) &&
                         item.rect.height > 200,
              source: item.source
            });
          });

          // deduplicate stickyElements by selector
          const deduplicatedStickyElements = stickyElements.filter((element, index, self) =>
            index === self.findIndex((t) => t.selector === element.selector)
          );
          console.log("Deduplicated sticky elements:", deduplicatedStickyElements);

          return deduplicatedStickyElements;
        }
      },
      (results) => {
        const elements = results[0]?.result || [];
        resolve(elements);
      }
    );
  });
}

// Function to hide sticky elements
function hideStickyElements(tabId, stickyElements) {
  return new Promise((resolve) => {
    if (!stickyElements || stickyElements.length === 0) {
      resolve(false);
      return;
    }

    const selectors = stickyElements.map(el => el.selector);

    chrome.scripting.executeScript(
      {
        target: {tabId: tabId},
        args: [selectors],
        func: (selectors) => {
          // Store hidden elements for later restoration
          window.__hiddenStickyElements = [];

          selectors.forEach(selector => {
            try {
              const element = document.querySelector(selector);
              if (element) {
                // Store original display value
                const originalDisplay = window.getComputedStyle(element).display;

                // Hide the element
                element.style.display = 'none';

                // Store reference for restoration
                window.__hiddenStickyElements.push({
                  element: element,
                  originalDisplay: originalDisplay,
                  selector: selector
                });
              }
            } catch (e) {
              console.error("Error hiding element:", selector, e);
            }
          });

          return window.__hiddenStickyElements.length;
        }
      },
      (results) => {
        const hiddenCount = results[0]?.result || 0;
        resolve(hiddenCount > 0);
      }
    );
  });
}

// Function to restore sticky elements
function restoreStickyElements(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      {
        target: {tabId: tabId},
        func: () => {
          console.log("Restoring sticky elements");
          let restoredCount = 0;

          // First approach: Use stored references
          if (window.__hiddenStickyElements && window.__hiddenStickyElements.length > 0) {
            console.log(`Found ${window.__hiddenStickyElements.length} hidden elements to restore`);

            // Restore original display values
            window.__hiddenStickyElements.forEach(item => {
              if (item.element) {
                try {
                  console.log(`Restoring element with selector: ${item.selector}, original display: ${item.originalDisplay}`);
                  // Restore original display value
                  item.element.style.display = item.originalDisplay;

                  // Force a reflow to ensure the style change takes effect
                  void item.element.offsetHeight;

                  restoredCount++;
                } catch (e) {
                  console.error("Error restoring element:", e);
                }
              }
            });

            // Clean up
            delete window.__hiddenStickyElements;
          } else {
            console.log("No hidden elements found in window.__hiddenStickyElements");
          }

          // Second approach: Remove any injected styles
          try {
            const injectedStyle = document.getElementById('screenshot-extension-styles');
            if (injectedStyle) {
              injectedStyle.parentNode.removeChild(injectedStyle);
              console.log("Removed injected style element");
            }
          } catch (e) {
            console.error("Error removing injected styles:", e);
          }

          return {
            restored: restoredCount,
            message: "Restoration completed"
          };
        }
      },
      (results) => {
        const result = results[0]?.result || { restored: 0, message: "No result" };
        console.log(`Restoration result: ${result.message}, ${result.restored} elements restored`);
        resolve(result.restored);
      }
    );
  });
}

// Function to capture full page screenshot
async function captureFullPage(tabId, options = {}) {
  let originalScrollY = 0;

  try {
    // Send initial progress update
    chrome.runtime.sendMessage({
      action: "progressUpdate",
      progress: 0,
      message: "Starting capture process..."
    });

    // Get page dimensions and scroll position
    const dimensions = await getPageDimensions(tabId);
    originalScrollY = dimensions.scrollY;

    // Send progress update
    chrome.runtime.sendMessage({
      action: "progressUpdate",
      progress: 10,
      message: "Preparing to capture..."
    });

    // Scroll to the top of the page first
    await scrollTo(tabId, 0, 0);
    await new Promise(resolve => setTimeout(resolve, 500));

    // STEP 1: Capture the first segment with all elements visible
    chrome.runtime.sendMessage({
      action: "progressUpdate",
      progress: 20,
      message: "Capturing first segment..."
    });

    const firstCapture = await captureWithRetry(tabId, options);
    const captures = [firstCapture];

    // STEP 2: Detect and hide sticky elements after first capture
    chrome.runtime.sendMessage({
      action: "progressUpdate",
      progress: 30,
      message: "Detecting sticky elements..."
    });

    const stickyElements = await detectStickyElements(tabId);

    chrome.runtime.sendMessage({
      action: "progressUpdate",
      progress: 40,
      message: `Found ${stickyElements.length} sticky elements. Hiding them...`
    });

    if (stickyElements.length > 0) {
      await hideStickyElements(tabId, stickyElements);
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Get updated dimensions after hiding elements
    const updatedDimensions = await getPageDimensions(tabId);
    const viewportHeight = updatedDimensions.windowHeight;
    const pageHeight = updatedDimensions.height;

    // Use a fixed capture height to ensure consistent captures
    // Use 80% of viewport height to ensure good overlap without excessive duplication
    const captureHeight = Math.floor(viewportHeight * 0.8);

    // Calculate how many full captures we need
    // We'll handle the last capture separately
    const capturePositions = [];
    let currentPosition = 0;

    // Generate all scroll positions needed for captures
    while (currentPosition < pageHeight - viewportHeight) {
      capturePositions.push(currentPosition);
      currentPosition += captureHeight;
    }

    // Add the final position if it's not already included
    // This ensures we capture the bottom of the page
    if (capturePositions.length === 0 ||
        capturePositions[capturePositions.length - 1] < pageHeight - viewportHeight) {
      capturePositions.push(pageHeight - viewportHeight);
    }

    // STEP 3: Capture all segments except the first (which we already captured)
    for (let i = 1; i < capturePositions.length; i++) {
      const progressPercent = Math.floor(40 + (i / capturePositions.length) * 50);

      chrome.runtime.sendMessage({
        action: "progressUpdate",
        progress: progressPercent,
        message: `Capturing segment ${i+1}/${capturePositions.length + 1}...`
      });

      // Scroll to the exact position
      const scrollPos = capturePositions[i];
      await scrollTo(tabId, 0, scrollPos);
      await new Promise(resolve => setTimeout(resolve, 500));

      const capture = await captureWithRetry(tabId, options);
      captures.push(capture);
    }

    chrome.runtime.sendMessage({
      action: "progressUpdate",
      progress: 95,
      message: "Finalizing capture..."
    });

    // Return the array of captures for stitching
    return {
      captures: captures,
      dimensions: updatedDimensions,
      capturePositions: capturePositions
    };

  } catch (error) {
    console.error("Error capturing full page:", error);
    throw error;
  } finally {
    console.log("Final cleanup: Restoring page state");

    // Always restore sticky elements
    try {
      await restoreStickyElements(tabId);
      console.log("Sticky elements restored");
    } catch (restoreError) {
      console.error("Error restoring sticky elements:", restoreError);
    }

    // Always restore original scroll position
    try {
      await scrollTo(tabId, 0, originalScrollY);
      console.log("Original scroll position restored:", originalScrollY);
    } catch (scrollError) {
      console.error("Error restoring scroll position:", scrollError);
    }

    // Send final progress update
    chrome.runtime.sendMessage({
      action: "progressUpdate",
      progress: 100,
      message: "Capture complete"
    });
  }
}

// Function to get page dimensions
function getPageDimensions(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: {tabId: tabId},
        func: () => {
          return {
            width: Math.max(
              document.documentElement.clientWidth,
              document.documentElement.scrollWidth,
              document.body.scrollWidth
            ),
            height: Math.max(
              document.documentElement.clientHeight,
              document.documentElement.scrollHeight,
              document.body.scrollHeight
            ),
            windowHeight: window.innerHeight,
            windowWidth: window.innerWidth,
            scrollY: window.scrollY
          };
        }
      },
      (results) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(results[0].result);
        }
      }
    );
  });
}

// Function to scroll to a specific position
function scrollTo(tabId, x, y) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      {
        target: {tabId: tabId},
        args: [x, y],
        func: (x, y) => {
          window.scrollTo(x, y);
          return true;
        }
      },
      () => resolve()
    );
  });
}

// Helper function to capture with retry and backoff
async function captureWithRetry(tabId, options = {}, maxRetries = 3, initialDelay = 1000) {
  let retries = 0;
  let delay = initialDelay;

  while (retries <= maxRetries) {
    try {
      // If not the first attempt, wait before trying again
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
        // Exponential backoff
        delay *= 2;
      }

      return await captureVisibleTabPromise(tabId, options);
    } catch (error) {
      retries++;
      console.error(`Capture attempt ${retries} failed:`, error);

      // If we've exhausted all retries or it's not a rate limit error, throw
      if (retries > maxRetries || !error.message || !error.message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')) {
        throw error;
      }

      // Otherwise, we'll retry after the delay
    }
  }
}

// Function to capture visible tab as a promise with retry
function captureVisibleTabPromise(tabId, options = {}) {
  // Create a new options object without the quality parameter
  const captureOptions = { format: 'png' };

  // Only add quality if it's for jpeg format
  if (options.format === 'jpeg') {
    // Ensure quality is an integer between 0-100
    captureOptions.quality = options.quality ? Math.min(Math.max(Math.round(options.quality), 0), 100) : 100;
  }

  // Add any other options
  Object.keys(options).forEach(key => {
    if (key !== 'quality' || options.format === 'jpeg') {
      captureOptions[key] = options[key];
    }
  });

  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(
      null,
      captureOptions,
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(dataUrl);
        }
      }
    );
  });
}