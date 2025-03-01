// Variables to store screenshot data
let screenshotDataUrl = null;
let screenshotFilename = 'screenshot.png';

// DOM elements
const screenshotImg = document.getElementById('screenshotImg');
const warningBanner = document.getElementById('warningBanner');
const downloadBtn = document.getElementById('downloadBtn');
const closeBtn = document.getElementById('closeBtn');

// Load screenshot data when the page loads
window.addEventListener('DOMContentLoaded', function() {
  // Try to get screenshot data from localStorage first
  try {
    const storedData = localStorage.getItem('screenshotData');
    if (storedData) {
      const screenshotData = JSON.parse(storedData);
      displayScreenshot(screenshotData.dataUrl, screenshotData.hasGaps);

      // Clear localStorage after retrieving the data
      localStorage.removeItem('screenshotData');
      return;
    }
  } catch (e) {
    console.error('Error retrieving screenshot from localStorage:', e);
  }

  // If localStorage doesn't have the data, check URL parameters
  const urlParams = new URLSearchParams(window.location.search);

  if (urlParams.get('useBlobUrl') === 'true') {
    // Request the blob URL from the background script
    chrome.runtime.sendMessage({action: "getBlobUrl"}, function(response) {
      if (response && response.blobUrl) {
        displayScreenshot(response.blobUrl, response.hasGaps);
      }
    });
  } else if (urlParams.get('useDataUrl') === 'false') {
    // Request the data URL from the background script
    chrome.runtime.sendMessage({action: "getScreenshot", tabId: urlParams.get('tabId')}, function(response) {
      if (response && response.dataUrl) {
        displayScreenshot(response.dataUrl, response.hasGaps);
      }
    });
  }
});

// Function to display the screenshot
function displayScreenshot(dataUrl, hasGaps) {
  // Store the screenshot data
  screenshotDataUrl = dataUrl;

  // Display the screenshot
  screenshotImg.src = dataUrl;

  // Show warning banner if there are gaps in the screenshot
  if (hasGaps) {
    warningBanner.style.display = 'block';
  }

  // Update page title with timestamp
  const timestamp = new Date().toLocaleString();
  document.title = `Screenshot - ${timestamp}`;
}

// Listen for messages from the popup (fallback method)
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.action === "displayScreenshot") {
    displayScreenshot(request.dataUrl, request.hasGaps);
  }
});

// Download button click handler
downloadBtn.addEventListener('click', function() {
  if (screenshotDataUrl) {
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    const filename = `screenshot_${timestamp}.png`;

    // Create a temporary link element and trigger download
    const a = document.createElement('a');
    a.href = screenshotDataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
});

// Close button click handler
closeBtn.addEventListener('click', function() {
  window.close();
});

// Handle keyboard shortcuts
document.addEventListener('keydown', function(event) {
  // Close on Escape key
  if (event.key === 'Escape') {
    window.close();
  }

  // Download on Ctrl+S or Command+S
  if ((event.ctrlKey || event.metaKey) && event.key === 's') {
    event.preventDefault();
    downloadBtn.click();
  }
});

// Add zoom functionality
let currentZoom = 1;
const zoomStep = 0.1;
const maxZoom = 3;
const minZoom = 0.5;

// Zoom in/out with mouse wheel
screenshotImg.addEventListener('wheel', function(event) {
  event.preventDefault();

  if (event.deltaY < 0) {
    // Zoom in
    currentZoom = Math.min(currentZoom + zoomStep, maxZoom);
  } else {
    // Zoom out
    currentZoom = Math.max(currentZoom - zoomStep, minZoom);
  }

  screenshotImg.style.transform = `scale(${currentZoom})`;
  screenshotImg.style.transformOrigin = 'top left';
});