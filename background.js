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

          // Debug info to track what's happening
          const debugInfo = {
            hostname: window.location.hostname,
            positionedElementsFound: 0,
            headerElementsFound: 0,
            sidebarElementsFound: 0,
            siteSpecificElementsFound: 0,
            finalElementsAfterFiltering: 0
          };

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

          // Helper function to get detailed element info for logging
          function getElementDetails(element, source) {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);

            // Get computed styles that might affect stickiness
            const position = style.position;
            const zIndex = style.zIndex;
            const top = style.top;
            const left = style.left;
            const right = style.right;
            const bottom = style.bottom;
            const display = style.display;
            const visibility = style.visibility;
            const opacity = style.opacity;

            // Get element attributes
            const attributes = {};
            for (let i = 0; i < element.attributes.length; i++) {
              const attr = element.attributes[i];
              attributes[attr.name] = attr.value;
            }

            return {
              tagName: element.tagName,
              id: element.id || null,
              className: element.className || null,
              textContent: element.textContent ? element.textContent.substring(0, 50) + (element.textContent.length > 50 ? '...' : '') : null,
              attributes: attributes,
              rect: {
                top: rect.top,
                left: rect.left,
                width: rect.width,
                height: rect.height,
                bottom: rect.bottom,
                right: rect.right
              },
              style: {
                position,
                zIndex,
                top,
                left,
                right,
                bottom,
                display,
                visibility,
                opacity
              },
              source: source
            };
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
                debugInfo.positionedElementsFound++;

                // Log detailed info about this element
                console.log("Found positioned element:", getElementDetails(element, 'positioned'));
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
                  debugInfo.headerElementsFound++;

                  // Log detailed info about this element
                  console.log("Found header element:", getElementDetails(element, 'header'));
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
                  debugInfo.sidebarElementsFound++;
                }
              });
            } catch (e) {
              // Skip invalid selectors
            }
          });

          // 4. Site-specific detection

          // 5. Process the collected elements
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

          debugInfo.finalElementsAfterFiltering = filteredElements.length;

          // Convert to the final format with selectors
          filteredElements.forEach(item => {
            const selector = generateSelector(item.element);

            // Log detailed info about each element for debugging
            const details = getElementDetails(item.element, item.source);

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
              source: item.source,
              details: details
            });
          });

          return {
            elements: stickyElements,
            debugInfo: debugInfo
          };
        }
      },
      (results) => {
        const result = results[0]?.result || { elements: [], debugInfo: {} };
        resolve(result.elements);
      }
    );
  });
}

// Function to hide sticky elements
function hideStickyElements(tabId, stickyElements) {
  return new Promise((resolve) => {
    if (!stickyElements || stickyElements.length === 0) {
      resolve();
      return;
    }

    const selectors = stickyElements.map(el => el.selector);

    chrome.scripting.executeScript(
      {
        target: {tabId: tabId},
        args: [selectors],
        func: (selectors) => {
          const hiddenElements = [];
          const debugInfo = {
            totalSelectors: selectors.length,
            elementsFound: 0,
            elementsHidden: 0,
            notFoundSelectors: []
          };

          selectors.forEach(selector => {
            try {
              const element = document.querySelector(selector);
              if (element) {
                debugInfo.elementsFound++;

                if (element.style.display !== 'none') {
                  // Store original display value
                  const originalDisplay = element.style.display || '';

                  // Hide the element
                  element.style.display = 'none';

                  // Verify the element was actually hidden
                  const computedStyle = window.getComputedStyle(element);
                  const wasHidden = computedStyle.display === 'none';

                  hiddenElements.push({
                    element: element,
                    originalDisplay: originalDisplay,
                    selector: selector,
                    wasHidden: wasHidden
                  });

                  if (wasHidden) {
                    debugInfo.elementsHidden++;
                  } else {
                    console.warn("Failed to hide element with selector:", selector);
                  }
                } else {
                }
              } else {
                console.warn("Element not found with selector:", selector);
                debugInfo.notFoundSelectors.push(selector);
              }
            } catch (e) {
              console.error("Error hiding element:", selector, e);
            }
          });

          // Try a more aggressive approach for Anthropic's site
          if (window.location.hostname.includes('anthropic.com')) {
            // Force hide the top navigation bar
            const topElements = document.querySelectorAll('body > header, body > nav, header:first-child, nav:first-child');
            topElements.forEach(element => {
              if (element && element.style.display !== 'none') {
                // Skip if we already hid this element
                if (hiddenElements.some(item => item.element === element)) {                  return;
                }

                const originalDisplay = element.style.display || '';
                element.style.display = 'none';

                const computedStyle = window.getComputedStyle(element);
                const wasHidden = computedStyle.display === 'none';

                hiddenElements.push({
                  element: element,
                  originalDisplay: originalDisplay,
                  selector: element.tagName + (element.id ? '#' + element.id : ''),
                  wasHidden: wasHidden
                });

                if (wasHidden) {
                  debugInfo.elementsHidden++;
                }
              }
            });

            // Try hiding by inline style override (more aggressive)
            const possibleHeaders = document.querySelectorAll('header, nav, [class*="header"], [class*="nav"]');

            possibleHeaders.forEach(element => {
              if (element &&
                  element.getBoundingClientRect().top < 100 &&
                  element.style.display !== 'none') {

                // Skip if we already hid this element
                if (hiddenElements.some(item => item.element === element)) {
                  return;
                }

                const originalDisplay = element.style.display || '';

                // More aggressive approach - use !important
                const originalStyle = element.getAttribute('style') || '';
                element.setAttribute('style', originalStyle + '; display: none !important;');

                const computedStyle = window.getComputedStyle(element);
                const wasHidden = computedStyle.display === 'none';

                hiddenElements.push({
                  element: element,
                  originalDisplay: originalDisplay,
                  originalStyle: originalStyle,
                  selector: element.tagName + (element.id ? '#' + element.id : ''),
                  wasHidden: wasHidden,
                  aggressive: true
                });

                if (wasHidden) {
                  debugInfo.elementsHidden++;
                }
              }
            });

            // Try the most aggressive approach - CSS injection
            try {
              const style = document.createElement('style');
              style.id = 'sticky-element-hider';
              style.textContent =
                "header, nav, [class*=\"header\"], [class*=\"nav\"], [class*=\"menu\"], [role=\"banner\"], [role=\"navigation\"] {" +
                "  display: none !important;" +
                "  visibility: hidden !important;" +
                "  opacity: 0 !important;" +
                "  pointer-events: none !important;" +
                "}" +
                "body > header, body > nav, div > header:first-child, div > nav:first-child {" +
                "  display: none !important;" +
                "  visibility: hidden !important;" +
                "}" +
                "/* Target elements at the top of the page */" +
                "body > div:first-child > header," +
                "body > div:first-child > nav," +
                "body > div:first-child > div > header," +
                "body > div:first-child > div > nav {" +
                "  display: none !important;" +
                "  visibility: hidden !important;" +
                "}";

              // Store reference to the style element for later removal
              window.__injectedStyle = style;

              // Add the style to the document
              document.head.appendChild(style);
            } catch (e) {
              console.error("Error injecting CSS:", e);
            }
          }

          // Store references to hidden elements in a global variable
          window.__hiddenStickyElements = hiddenElements;

          return {
            count: hiddenElements.length,
            debugInfo: debugInfo
          };
        }
      },
      (results) => {
        const result = results[0]?.result || { count: 0, debugInfo: {} };
        resolve();
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
          if (!window.__hiddenStickyElements) return 0;

          const count = window.__hiddenStickyElements.length;
          const debugInfo = {
            totalElements: count,
            elementsRestored: 0,
            failedRestores: 0
          };

          // Restore original display values
          window.__hiddenStickyElements.forEach(item => {
            if (item.element) {
              try {
                if (item.aggressive) {
                  // Restore original style attribute
                  item.element.setAttribute('style', item.originalStyle || '');
                } else {
                  // Restore original display value
                  item.element.style.display = item.originalDisplay;
                }

                debugInfo.elementsRestored++;
              } catch (e) {
                debugInfo.failedRestores++;
                console.error("Error restoring element:", e);
              }
            }
          });

          // Remove injected CSS if it exists
          if (window.__injectedStyle && window.__injectedStyle.parentNode) {
            try {
              window.__injectedStyle.parentNode.removeChild(window.__injectedStyle);
            } catch (e) {
              console.error("Error removing injected CSS:", e);
            }
          }

          // Clean up
          delete window.__hiddenStickyElements;
          delete window.__injectedStyle;

          return {
            count: count,
            debugInfo: debugInfo
          };
        }
      },
      (results) => {
        const result = results[0]?.result || { count: 0, debugInfo: {} };
        resolve();
      }
    );
  });
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

// Function to capture full page screenshot
async function captureFullPage(tabId, options = {}) {
  try {
    // Send initial progress update
    chrome.runtime.sendMessage({
      action: "progressUpdate",
      progress: 0,
      message: "Starting capture process..."
    });

    // Get page dimensions and scroll position
    const dimensions = await getPageDimensions(tabId);
    // Save original scroll position to restore later
    const originalScrollY = dimensions.scrollY;

    // Get the hostname to identify the website
    const hostname = await chrome.scripting.executeScript({
      target: {tabId: tabId},
      func: () => window.location.hostname
    }).then(results => results[0].result);

    // Send progress update
    chrome.runtime.sendMessage({
      action: "progressUpdate",
      progress: 10,
      message: "Detecting sticky elements..."
    });

    // Detect sticky elements before starting
    const stickyElements = await detectStickyElements(tabId);
    // Send progress update
    chrome.runtime.sendMessage({
      action: "progressUpdate",
      progress: 20,
      message: `Found ${stickyElements.length} sticky elements`
    });

    // Scroll to the top of the page
    await scrollTo(tabId, 0, 0);

    // Wait for the page to settle after scrolling
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Send progress update
    chrome.runtime.sendMessage({
      action: "progressUpdate",
      progress: 30,
      message: "Capturing first segment..."
    });

    // Capture the first part with sticky elements visible
    let firstCapture = await captureWithRetry(tabId, options);
    const captures = [firstCapture];
    // Send progress update
    chrome.runtime.sendMessage({
      action: "progressUpdate",
      progress: 40,
      message: "Hiding sticky elements..."
    });

    // Hide sticky elements before scrolling to capture the rest
    if (stickyElements.length > 0) {
      await hideStickyElements(tabId, stickyElements);
      // Give the page time to adjust layout after hiding elements
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify elements are hidden
      await chrome.scripting.executeScript({
        target: {tabId: tabId},
        func: () => {
          if (!window.__hiddenStickyElements) return "No hidden elements tracked";

          const stillHidden = window.__hiddenStickyElements.filter(item => {
            if (!item.element) return false;
            const style = window.getComputedStyle(item.element);
            return style.display === 'none';
          });

          return {
            total: window.__hiddenStickyElements.length,
            hidden: stillHidden.length,
            notHidden: window.__hiddenStickyElements.length - stillHidden.length
          };
        }
      }).then(results => {
      });
    }

    // Calculate how many screenshots we need based on the page height
    const viewportHeight = dimensions.windowHeight;
    const pageHeight = dimensions.height;

    // Use 85% of viewport height as scroll step to ensure overlap
    const scrollStep = Math.floor(viewportHeight * 0.85);
    const totalSteps = Math.ceil(pageHeight / scrollStep);

    // Capture screenshots by scrolling down
    for (let i = 1; i < totalSteps; i++) {
      // Calculate progress percentage
      const progressPercent = Math.floor(40 + (i / totalSteps) * 50);

      // Send progress update
      chrome.runtime.sendMessage({
        action: "progressUpdate",
        progress: progressPercent,
        message: `Capturing segment ${i+1}/${totalSteps}...`
      });

      // Calculate scroll position
      const scrollPos = i * scrollStep;

      // Scroll to position
      await scrollTo(tabId, 0, scrollPos);

      // Wait for the page to settle after scrolling - increased delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Re-hide sticky elements on every segment to ensure they stay hidden
      if (stickyElements.length > 0) {
        await hideStickyElements(tabId, stickyElements);

        // Additional wait after re-hiding elements
        await new Promise(resolve => setTimeout(resolve, 500));

        // Verify elements are still hidden
        await chrome.scripting.executeScript({
          target: {tabId: tabId},
          func: () => {
            if (!window.__hiddenStickyElements) return "No hidden elements tracked";

            const stillHidden = window.__hiddenStickyElements.filter(item => {
              if (!item.element) return false;
              const style = window.getComputedStyle(item.element);
              return style.display === 'none';
            });

            return {
              total: window.__hiddenStickyElements.length,
              hidden: stillHidden.length,
              notHidden: window.__hiddenStickyElements.length - stillHidden.length
            };
          }
        }).then(results => {
        });
      }

      // Add a delay before capturing to avoid hitting the rate limit
      await new Promise(resolve => setTimeout(resolve, 1000));

      try {
        // Capture current visible area with retry mechanism
        const capture = await captureWithRetry(tabId, options);
        captures.push(capture);
        // Add a delay after capturing to avoid hitting the rate limit
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (captureError) {
        console.error(`Failed to capture segment ${i+1} after multiple retries:`, captureError);
        // Continue with the next segment
      }
    }

    // Send progress update
    chrome.runtime.sendMessage({
      action: "progressUpdate",
      progress: 90,
      message: "Restoring page state..."
    });

    // Restore sticky elements after capturing is complete
    if (stickyElements.length > 0) {
      await restoreStickyElements(tabId);
    }

    // Restore original scroll position
    await scrollTo(tabId, 0, originalScrollY);

    // Send progress update
    chrome.runtime.sendMessage({
      action: "progressUpdate",
      progress: 95,
      message: "Processing captures..."
    });

    // Return the array of captures for stitching
    return {
      captures: captures,
      dimensions: dimensions
    };

  } catch (error) {
    console.error("Error capturing full page:", error);

    // Send error progress update
    chrome.runtime.sendMessage({
      action: "progressUpdate",
      progress: 100,
      message: "Error: " + error.message
    });

    throw error;
  }
}