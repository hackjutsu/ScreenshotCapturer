// Global error handler for unhandled promise rejections
window.addEventListener('unhandledrejection', function(event) {
  // Check if this is a message channel closed error
  if (event.reason && event.reason.message &&
      (event.reason.message.includes('message channel closed') ||
       event.reason.message.includes('A listener indicated an asynchronous response') ||
       event.reason.message.includes('The message port closed'))) {
    // Prevent the error from being logged to the console
    event.preventDefault();
    // Suppress debug logs to avoid console clutter
    // console.debug('Suppressed message channel error (expected behavior)');
  }
});

// Variables to store screenshot data
let screenshotDataUrl = null;
let screenshotFilename = 'screenshot.png';
let retryCount = 0;
const MAX_RETRIES = 3;

// DOM elements
const screenshotImg = document.getElementById('screenshotImg');
const warningBanner = document.getElementById('warningBanner');
const downloadBtn = document.getElementById('downloadBtn');
const closeBtn = document.getElementById('closeBtn');
const loadingMessage = document.getElementById('loadingMessage');
const errorMessage = document.getElementById('errorMessage');
const downloadInstructions = document.getElementById('downloadInstructions');
const successMessage = document.getElementById('successMessage');

// Function to show error message
function showError(message) {
  console.error("Screenshot viewer error:", message);
  if (errorMessage) {
    errorMessage.textContent = message;
    errorMessage.style.display = 'block';
  }
  if (loadingMessage) {
    loadingMessage.style.display = 'none';
  }
}

// Function to show loading message
function showLoading(message = 'Loading screenshot...') {
  if (loadingMessage) {
    loadingMessage.textContent = message;
    loadingMessage.style.display = 'block';
  }
  if (errorMessage) {
    errorMessage.style.display = 'none';
  }
}

// Function to hide loading message
function hideLoading() {
  if (loadingMessage) {
    loadingMessage.style.display = 'none';
  }
}

// Function to format file size
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Function to display the screenshot
function displayScreenshot(dataUrl, hasGaps, quality, dimensions) {
  console.log("Displaying screenshot, data URL length:", dataUrl ? dataUrl.length : 0);

  // Store the screenshot data
  screenshotDataUrl = dataUrl;

  // Create a new Image object to verify the data URL
  const img = new Image();

  img.onload = function() {
    console.log("Screenshot image loaded successfully");
    // Update the actual image
    screenshotImg.src = dataUrl;
    screenshotImg.style.display = 'block';
    hideLoading();

    // Calculate file size
    let fileSize = 0;
    if (dataUrl) {
      // Estimate file size from data URL length
      // For base64 encoded data, each 4 characters represent 3 bytes of data
      const base64Data = dataUrl.split(',')[1];
      fileSize = Math.floor((base64Data.length * 3) / 4);
    }

    // Format the file size
    const formattedSize = formatFileSize(fileSize);

    // Show success message in the header with file size
    successMessage.textContent = `Your screenshot is ready (${formattedSize}). Click the Download button to save it to your computer.`;
    successMessage.style.display = 'block';

    // For backward compatibility
    if (downloadInstructions) {
      downloadInstructions.style.display = 'none';
    }

    // Show warning banner if there are gaps
    if (hasGaps) {
      warningBanner.style.display = 'block';
    }

    // Update page title with timestamp
    const timestamp = new Date().toLocaleString();
    document.title = `Screenshot - ${timestamp}`;
  };

  img.onerror = function() {
    console.error("Failed to load screenshot image");

    // Try to reload the blob URL if we're using that method
    if (retryCount < MAX_RETRIES) {
      retryCount++;
      console.log(`Retrying blob URL retrieval (attempt ${retryCount} of ${MAX_RETRIES})...`);
      showLoading(`Retrying screenshot load (attempt ${retryCount} of ${MAX_RETRIES})...`);

      // Wait a moment before retrying
      setTimeout(function() {
        loadBlobUrl();
      }, 1000);
    } else {
      showError('Failed to load the screenshot image. The data may be corrupted or in an invalid format.');
      screenshotImg.style.display = 'none';
    }
  };

  // Set the source to trigger loading
  img.src = dataUrl;
}

// Function to load blob URL from background script
function loadBlobUrl() {
  console.log("Attempting to load blob URL from background script");
  showLoading('Retrieving screenshot data...');

  chrome.runtime.sendMessage({action: "getBlobUrl"}, function(response) {
    // Check for runtime errors (like disconnected port)
    if (chrome.runtime.lastError) {
      console.error("Error getting blob URL:", chrome.runtime.lastError);

      // Retry if we haven't exceeded the maximum retry count
      if (retryCount < MAX_RETRIES) {
        retryCount++;
        console.log(`Connection error, retrying (attempt ${retryCount} of ${MAX_RETRIES})...`);
        showLoading(`Connection error, retrying (attempt ${retryCount} of ${MAX_RETRIES})...`);

        // Wait a moment before retrying with exponential backoff
        setTimeout(function() {
          loadBlobUrl();
        }, 1000 * Math.pow(2, retryCount - 1));
        return;
      }

      showError('Failed to connect to extension: ' + chrome.runtime.lastError.message);
      return;
    }

    console.log("Received response for getBlobUrl:", response ? "Response received" : "No response");

    // Handle valid response with blob URL
    if (response && response.blobUrl) {
      console.log("Blob URL received, length:", response.blobUrl.length);
      displayScreenshot(response.blobUrl, response.hasGaps, response.quality, {
        originalWidth: response.originalWidth,
        originalHeight: response.originalHeight,
        finalWidth: response.finalWidth,
        finalHeight: response.finalHeight,
        imageSize: response.imageSize
      });
    }
    // Handle error in response
    else if (response && response.error) {
      console.error("Error in getBlobUrl response:", response.error);

      // Retry for certain types of errors that might be transient
      if (response.error.includes("Failed to retrieve") && retryCount < MAX_RETRIES) {
        retryCount++;
        console.log(`Error retrieving blob URL, retrying (attempt ${retryCount} of ${MAX_RETRIES})...`);
        showLoading(`Error retrieving screenshot, retrying (attempt ${retryCount} of ${MAX_RETRIES})...`);

        // Wait a moment before retrying with exponential backoff
        setTimeout(function() {
          loadBlobUrl();
        }, 1000 * Math.pow(2, retryCount - 1));
        return;
      }

      showError('Error retrieving screenshot: ' + response.error);
    }
    // Handle empty or invalid response
    else {
      console.error("No blob URL in response");

      // Retry if we haven't exceeded the maximum retry count
      if (retryCount < MAX_RETRIES) {
        retryCount++;
        console.log(`No blob URL in response, retrying (attempt ${retryCount} of ${MAX_RETRIES})...`);
        showLoading(`No screenshot data found, retrying (attempt ${retryCount} of ${MAX_RETRIES})...`);

        // Wait a moment before retrying with exponential backoff
        setTimeout(function() {
          loadBlobUrl();
        }, 1000 * Math.pow(2, retryCount - 1));
        return;
      }

      showError('No screenshot data found. The screenshot may not have been properly saved.');
    }
  });
}

// Load screenshot data when the page loads
window.addEventListener('DOMContentLoaded', function() {
  console.log("Screenshot viewer loaded, checking for screenshot data");
  showLoading();

  // Try to get screenshot data from localStorage first
  try {
    const storedData = localStorage.getItem('screenshotData');
    if (storedData) {
      console.log("Found screenshot data in localStorage");
      const screenshotData = JSON.parse(storedData);
      displayScreenshot(
        screenshotData.dataUrl,
        screenshotData.hasGaps,
        screenshotData.quality,
        screenshotData.dimensions
      );

      // Clear localStorage after retrieving the data
      localStorage.removeItem('screenshotData');
      return;
    } else {
      console.log("No screenshot data found in localStorage");
    }
  } catch (e) {
    console.error('Error retrieving screenshot from localStorage:', e);
  }

  // If localStorage doesn't have the data, check URL parameters
  const urlParams = new URLSearchParams(window.location.search);
  console.log("URL parameters:", Object.fromEntries(urlParams.entries()));

  if (urlParams.get('useBlobUrl') === 'true') {
    console.log("Using blob URL method");
    loadBlobUrl();
  } else {
    console.log("No valid method specified in URL parameters");
    showError('No valid method specified for retrieving the screenshot.');
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
  } else {
    showError('No screenshot data available to download.');
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