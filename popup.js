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
  function displayScreenshotInNewTabWithQueryParam(dataUrl, hasGaps) {
    // For smaller screenshots, we can use URL parameters
    if (dataUrl.length < 2000) {
      chrome.tabs.create({
        url: `screenshot-viewer.html?hasGaps=${hasGaps}&useDataUrl=false`
      }, function(tab) {
        // Store in background script's memory
        chrome.runtime.sendMessage({
          action: "storeScreenshot",
          dataUrl: dataUrl,
          tabId: tab.id
        });
      });
    } else {
      // For larger screenshots, we'll need to use a different approach
      // Create a blob URL
      const blob = dataURItoBlob(dataUrl);
      const blobUrl = URL.createObjectURL(blob);

      // Store the blob URL in background script's memory
      chrome.runtime.sendMessage({
        action: "storeBlobUrl",
        blobUrl: blobUrl,
        hasGaps: hasGaps
      }, function() {
        chrome.tabs.create({ url: 'screenshot-viewer.html?useBlobUrl=true' });
      });
    }
  }

  // Helper function to convert data URI to Blob
  function dataURItoBlob(dataURI) {
    const byteString = atob(dataURI.split(',')[1]);
    const mimeString = dataURI.split(',')[0].split(':')[1].split(';')[0];
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);

    for (let i = 0; i < byteString.length; i++) {
      ia[i] = byteString.charCodeAt(i);
    }

    return new Blob([ab], {type: mimeString});
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