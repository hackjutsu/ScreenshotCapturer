document.addEventListener('DOMContentLoaded', function() {
  const captureVisibleBtn = document.getElementById('captureVisible');
  const captureFullBtn = document.getElementById('captureFull');
  const statusDiv = document.getElementById('status');

  // Capture visible area
  captureVisibleBtn.addEventListener('click', function() {
    statusDiv.textContent = 'Capturing visible area...';

    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      chrome.tabs.captureVisibleTab(null, {format: 'png'}, function(dataUrl) {
        if (chrome.runtime.lastError) {
          statusDiv.textContent = `Error: ${chrome.runtime.lastError.message}`;
          return;
        }
        handleScreenshotCapture(dataUrl, 'visible_screenshot.png', false);
        statusDiv.textContent = 'Screenshot ready! Opening in new tab for download.';
      });
    });
  });

  // Capture full page
  captureFullBtn.addEventListener('click', function() {
    statusDiv.textContent = 'Capturing full page (this may take a moment)...';

    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      const activeTab = tabs[0];

      // Check if we can access the tab
      if (!activeTab || !activeTab.id) {
        statusDiv.textContent = 'Error: Cannot access the current tab.';
        return;
      }

      chrome.tabs.sendMessage(activeTab.id, {action: "getScrollHeight"}, function(response) {
        if (chrome.runtime.lastError || !response) {
          // If content script is not ready or doesn't respond
          statusDiv.textContent = 'Injecting content script...';

          chrome.scripting.executeScript({
            target: {tabId: activeTab.id},
            files: ['content.js']
          }, function() {
            if (chrome.runtime.lastError) {
              statusDiv.textContent = `Error: ${chrome.runtime.lastError.message}`;
              return;
            }

            // After injecting content script, try again
            statusDiv.textContent = 'Starting capture process...';
            setTimeout(() => {
              chrome.tabs.sendMessage(activeTab.id, {action: "captureFullPage"});
            }, 800); // Increased timeout for script initialization
          });
        } else {
          // Content script is ready, proceed with capture
          chrome.tabs.sendMessage(activeTab.id, {action: "captureFullPage"});
        }
      });
    });
  });

  // Helper function to handle screenshot capture (download and display)
  function handleScreenshotCapture(dataUrl, filename, hasGaps) {
    // Store screenshot data in localStorage
    const screenshotData = {
      dataUrl: dataUrl,
      hasGaps: hasGaps,
      timestamp: new Date().toISOString()
    };

    // Store the data in localStorage (with a size check)
    try {
      localStorage.setItem('screenshotData', JSON.stringify(screenshotData));

      // Display the screenshot in a new tab
      displayScreenshotInNewTab();
    } catch (e) {
      console.error('Error storing screenshot in localStorage:', e);
      // If localStorage fails (e.g., due to size limits), use a different approach
      displayScreenshotInNewTabWithQueryParam(dataUrl, hasGaps);
    }
  }

  // Helper function to download screenshot
  function downloadScreenshot(dataUrl, filename) {
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    const filenameWithTimestamp = `${filename.split('.')[0]}_${timestamp}.png`;

    chrome.downloads.download({
      url: dataUrl,
      filename: filenameWithTimestamp,
      saveAs: false
    }, function(downloadId) {
      if (chrome.runtime.lastError) {
        statusDiv.textContent = `Download error: ${chrome.runtime.lastError.message}`;
      }
    });
  }

  // Helper function to display screenshot in a new tab using localStorage
  function displayScreenshotInNewTab() {
    // Create a new tab with the screenshot viewer
    chrome.tabs.create({ url: 'screenshot-viewer.html' });
  }

  // Alternative method using query parameters for smaller screenshots
  function displayScreenshotInNewTabWithQueryParam(dataUrl, hasGaps, scaled, quality, dimensions) {
    try {
      console.log("Processing screenshot for display, data length:", dataUrl.length);

      // Check if URL.createObjectURL is available
      const hasCreateObjectURL = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
      console.log("Popup: URL.createObjectURL available:", hasCreateObjectURL);

      // Keep the popup alive while we process
      keepPopupAlive();

      if (hasCreateObjectURL) {
        // Create blob from data URL
        try {
          const blob = dataURItoBlob(dataUrl);
          console.log("Created blob, size:", blob.size);

          // Store in background script first, then open the viewer
          storeScreenshotAndOpenViewer(blob, dataUrl, hasGaps, scaled, quality, dimensions);
        } catch (blobError) {
          console.error("Error creating blob:", blobError);
          // Fall back to using just the data URL
          storeScreenshotAndOpenViewer(null, dataUrl, hasGaps, scaled, quality, dimensions);
        }
      } else {
        // If URL.createObjectURL is not available, just use the data URL
        console.log("URL.createObjectURL not available, using data URL directly");
        storeScreenshotAndOpenViewer(null, dataUrl, hasGaps, scaled, quality, dimensions);
      }
    } catch (error) {
      console.error("Error processing screenshot:", error);
      showError("Failed to process screenshot: " + error.message);
    }
  }

  // Function to store screenshot and open viewer
  function storeScreenshotAndOpenViewer(blob, dataUrl, hasGaps, scaled, quality, dimensions) {
    console.log("Storing screenshot in background script", blob ? `blob size: ${blob.size}` : "using data URL only");

    // Create a message with all the necessary data
    const message = {
      action: "storeBlobUrl",
      dataUrl: dataUrl,
      hasGaps: hasGaps || false,
      scaled: scaled || false,
      quality: quality || 100
    };

    // Add blob if available
    if (blob) {
      message.blob = blob;
    }

    // Add dimensions if available
    if (dimensions) {
      message.dimensions = {
        originalWidth: dimensions.originalWidth,
        originalHeight: dimensions.originalHeight,
        finalWidth: dimensions.finalWidth,
        finalHeight: dimensions.finalHeight,
        imageSize: dimensions.imageSize || dataUrl.length
      };
    }

    // Send the message to the background script
    chrome.runtime.sendMessage(message, function(response) {
      if (chrome.runtime.lastError) {
        console.error("Error storing screenshot:", chrome.runtime.lastError);
        showError("Failed to store screenshot data: " + chrome.runtime.lastError.message);

        // Try a direct approach as a last resort
        try {
          console.log("Trying direct approach");
          const timestamp = Date.now();
          const viewerUrl = `screenshot-viewer.html?timestamp=${timestamp}`;

          // Store in localStorage if possible
          try {
            localStorage.setItem('screenshotData', JSON.stringify({
              dataUrl: dataUrl,
              hasGaps: hasGaps || false,
              scaled: scaled || false,
              quality: quality || 100,
              timestamp: new Date().toISOString()
            }));
            console.log("Stored in localStorage as fallback");
          } catch (storageError) {
            console.error("Error storing in localStorage:", storageError);
          }

          chrome.tabs.create({ url: viewerUrl });
        } catch (directError) {
          console.error("Error with direct approach:", directError);
          showError("All screenshot display methods failed. Please try again.");
        }

        return;
      }

      console.log("Received response from background script:", response);

      if (response && response.success) {
        console.log("Screenshot data stored successfully, blob URL:", response.blobUrl);

        // Create the viewer tab with a timestamp to prevent caching issues
        const timestamp = Date.now();
        const viewerUrl = `screenshot-viewer.html?useBlobUrl=true&hasGaps=${hasGaps || false}&scaled=${scaled || false}&quality=${quality || 100}&timestamp=${timestamp}`;

        console.log("Opening viewer with URL:", viewerUrl);

        chrome.tabs.create({
          url: viewerUrl
        }, function(tab) {
          if (chrome.runtime.lastError) {
            console.error("Error creating viewer tab:", chrome.runtime.lastError);
            showError("Failed to open viewer: " + chrome.runtime.lastError.message);
          } else {
            console.log("Viewer tab created successfully, tab ID:", tab.id);
          }
        });
      } else if (response && response.error) {
        console.error("Error from background script:", response.error);
        showError("Failed to store screenshot data: " + response.error);

        // Try a direct approach as a last resort
        try {
          console.log("Trying direct approach after error");
          const timestamp = Date.now();
          const viewerUrl = `screenshot-viewer.html?timestamp=${timestamp}`;

          // Store in localStorage if possible
          try {
            localStorage.setItem('screenshotData', JSON.stringify({
              dataUrl: dataUrl,
              hasGaps: hasGaps || false,
              scaled: scaled || false,
              quality: quality || 100,
              timestamp: new Date().toISOString()
            }));
            console.log("Stored in localStorage as fallback");
          } catch (storageError) {
            console.error("Error storing in localStorage:", storageError);
          }

          chrome.tabs.create({ url: viewerUrl });
        } catch (directError) {
          console.error("Error with direct approach:", directError);
          showError("All screenshot display methods failed. Please try again.");
        }
      } else {
        console.error("Failed to store screenshot data, unexpected response:", response);
        showError("Failed to store screenshot data: Unexpected response from background script");
      }
    });
  }

  // Function to keep the popup alive
  function keepPopupAlive() {
    // Send a keepAlive message every 5 seconds
    const keepAliveInterval = setInterval(function() {
      chrome.runtime.sendMessage({action: "keepAlive"}, function(response) {
        if (chrome.runtime.lastError) {
          console.warn("Keep alive error:", chrome.runtime.lastError);
          clearInterval(keepAliveInterval);
        }
      });
    }, 5000);

    // Clear the interval after 2 minutes
    setTimeout(function() {
      clearInterval(keepAliveInterval);
    }, 120000);
  }

  // Helper function to convert data URL to Blob
  function dataURItoBlob(dataURI) {
    // Split the data URL to get the base64 data
    const byteString = atob(dataURI.split(',')[1]);

    // Get the MIME type
    const mimeString = dataURI.split(',')[0].split(':')[1].split(';')[0];

    // Convert to byte array
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
      ia[i] = byteString.charCodeAt(i);
    }

    // Create and return Blob
    return new Blob([ab], {type: mimeString});
  }

  // Helper function to show errors
  function showError(message) {
    const statusDiv = document.getElementById('status');
    if (statusDiv) {
      statusDiv.textContent = message;
      statusDiv.style.color = '#f44336';
    }
  }

  // Listen for messages from content script
  chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.action === "screenshotCaptured") {
      handleScreenshotCapture(request.dataUrl, 'full_page_screenshot.png', request.hasGaps);
      statusDiv.textContent = 'Screenshot ready! Opening in new tab for download.';
    }

    if (request.action === "progressUpdate") {
      statusDiv.textContent = `Capturing: ${request.progress}%`;
      if (request.message) {
        statusDiv.textContent += ` - ${request.message}`;
      }
    }

    if (request.action === "captureError") {
      statusDiv.textContent = `Error: ${request.error}`;
    }
  });
});