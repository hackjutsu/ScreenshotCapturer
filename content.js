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

// Store original scroll position
let originalScrollPos = 0;
let originalOverflowStyle = '';
let failedSegments = [];
let captureAttempts = 0;
const MAX_CAPTURE_ATTEMPTS = 3;

// Listen for messages from popup and background
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.action === "getScrollHeight") {
    sendResponse({scrollHeight: document.documentElement.scrollHeight});
  }

  if (request.action === "captureFullPage") {
    // Instead of calling the local captureFullPage function,
    // forward the request to the background script
    chrome.runtime.sendMessage(
      {action: "captureFullPageFromBackground", tabId: chrome.devtools?.inspectedWindow?.tabId || null},
      function(response) {
        if (response && response.error) {
          console.error("Error from background script:", response.error);
        }
      }
    );
    sendResponse({status: "forwarded"});
  }

  // Handle the processCaptures message from the background script
  if (request.action === "processCaptures") {
    processCaptures(request.captures, request.dimensions)
      .then(result => {
        // Send the result back to the popup
        chrome.runtime.sendMessage({
          action: "screenshotCaptured",
          dataUrl: result.dataUrl,
          hasGaps: false
        });
      })
      .catch(error => {
        console.error("Content script: Error processing captures:", error);
        chrome.runtime.sendMessage({
          action: "captureError",
          error: error.message || "Error processing captures"
        });
      });
    sendResponse({status: "processing"});
  }

  return true;
});

// Function to process captures and stitch them together
async function processCaptures(captures, dimensions) {
  return new Promise((resolve, reject) => {
    try {
      // Create a canvas to stitch the captures together
      const canvas = document.createElement('canvas');
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      const ctx = canvas.getContext('2d');

      // Counter for loaded images
      let loadedCount = 0;

      // Function to handle when all images are loaded
      function checkAllLoaded() {
        if (loadedCount === captures.length) {
          try {
            // Convert the canvas to a data URL
            const dataUrl = canvas.toDataURL('image/png');
            resolve({
              dataUrl: dataUrl,
              width: canvas.width,
              height: canvas.height
            });
          } catch (e) {
            reject(new Error("Failed to convert canvas to data URL: " + e.message));
          }
        }
      }

      // Load each capture into an image and draw it on the canvas
      captures.forEach((capture, index) => {
        const img = new Image();

        img.onload = function() {
          // Calculate position to draw on canvas
          // For the first capture, draw at the top
          // For subsequent captures, calculate position based on viewport height and overlap
          const yPosition = index === 0 ? 0 : index * Math.floor(dimensions.windowHeight * 0.85);

          // Draw image on canvas
          ctx.drawImage(img, 0, yPosition);

          // Increment loaded count
          loadedCount++;

          // Check if all images are loaded
          checkAllLoaded();
        };

        img.onerror = function(e) {
          console.error("Error loading image:", e);
          reject(new Error("Failed to load image " + index));
        };

        // Set the source of the image to the capture data URL
        img.src = capture;
      });
    } catch (error) {
      reject(error);
    }
  });
}

// Function to capture full page
async function captureFullPage() {
  try {
    // Reset capture state
    captureAttempts = 0;
    failedSegments = [];

    // Save original state
    originalScrollPos = window.scrollY;
    originalOverflowStyle = document.documentElement.style.overflow;

    // Prevent scrollbars during capture
    document.documentElement.style.overflow = 'hidden';

    // Get page dimensions
    const pageWidth = Math.max(
      document.documentElement.clientWidth,
      document.documentElement.scrollWidth
    );
    const pageHeight = Math.max(
      document.documentElement.clientHeight,
      document.documentElement.scrollHeight
    );

    // Create canvas for the full page
    const canvas = document.createElement('canvas');
    canvas.width = pageWidth;
    canvas.height = pageHeight;
    const ctx = canvas.getContext('2d');

    // Get viewport height for scrolling
    const viewportHeight = window.innerHeight;

    // Determine optimal scroll step based on page content
    const scrollStep = determineOptimalScrollStep(viewportHeight, pageHeight);
    const totalSteps = Math.ceil(pageHeight / scrollStep);

    // Capture screenshots by scrolling
    for (let i = 0; i < totalSteps; i++) {
      // Update progress
      const progress = Math.round((i / totalSteps) * 100);
      chrome.runtime.sendMessage({action: "progressUpdate", progress: progress});

      // Scroll to position
      const scrollPos = i * scrollStep;
      window.scrollTo(0, scrollPos);

      // Wait for any lazy-loaded content and animations
      await new Promise(resolve => setTimeout(resolve, 400));

      try {
        // Capture current visible area
        const dataUrl = await captureVisibleArea();

        // Create image from dataUrl
        const img = await loadImage(dataUrl);

        // Calculate position to draw on canvas
        // We need to handle the case where the last segment might go beyond page height
        const yPosition = Math.min(scrollPos, pageHeight - viewportHeight);

        // Draw image on canvas
        ctx.drawImage(img, 0, yPosition);
      } catch (segmentError) {
        console.error(`Error capturing segment ${i}:`, segmentError);
        failedSegments.push(i);

        // Try alternative capture method for this segment
        const success = await tryAlternativeCapture(i, totalSteps, ctx, scrollPos, pageHeight, viewportHeight);

        if (!success) {
          // If alternative method also fails, continue to next segment
          // We'll try to fill in gaps later
          chrome.runtime.sendMessage({
            action: "progressUpdate",
            progress: progress,
            message: `Skipping segment ${i+1} (will try to recover later)`
          });
        }
      }
    }

    // Try to recover failed segments with a different approach
    if (failedSegments.length > 0) {
      await recoverFailedSegments(ctx, scrollStep, pageHeight, viewportHeight);
    }

    // Convert canvas to data URL
    const finalDataUrl = canvas.toDataURL('image/png');

    // Send the screenshot data to the popup
    try {
      chrome.runtime.sendMessage({
        action: "screenshotCaptured",
        dataUrl: finalDataUrl,
        hasGaps: failedSegments.length > 0
      });
    } catch (error) {
      console.debug("Error sending screenshot captured message:", error);
      // The screenshot was still captured, but we couldn't send it
    }

    // Restore original state
    document.documentElement.style.overflow = originalOverflowStyle;
    window.scrollTo(0, originalScrollPos);

  } catch (error) {
    console.error("Error capturing full page:", error);

    // Try fallback method
    tryFallbackMethod();

    // Restore original state
    window.scrollTo(0, originalScrollPos);
    document.documentElement.style.overflow = originalOverflowStyle;
  }
}

// Determine optimal scroll step based on page content
function determineOptimalScrollStep(viewportHeight, pageHeight) {
  // For very long pages, use smaller steps to avoid memory issues
  if (pageHeight > 15000) {
    return Math.floor(viewportHeight / 3);
  }
  // For medium-length pages
  else if (pageHeight > 5000) {
    return Math.floor(viewportHeight / 2);
  }
  // For shorter pages, use larger steps with some overlap
  else {
    return viewportHeight - 50;
  }
}

// Try to recover failed segments with a different approach
async function recoverFailedSegments(ctx, scrollStep, pageHeight, viewportHeight) {
  if (failedSegments.length === 0) return;

  chrome.runtime.sendMessage({
    action: "progressUpdate",
    progress: 90,
    message: "Attempting to recover missing segments..."
  });

  // Try a different approach for failed segments
  for (const i of failedSegments) {
    const scrollPos = i * scrollStep;

    // Scroll to position
    window.scrollTo(0, scrollPos);

    // Use a longer wait time
    await new Promise(resolve => setTimeout(resolve, 800));

    try {
      // Try with a different capture method - use a smaller viewport area
      const smallerHeight = Math.floor(viewportHeight / 2);

      // Scroll to show just the part we need
      window.scrollTo(0, scrollPos + smallerHeight/4);
      await new Promise(resolve => setTimeout(resolve, 400));

      // Capture current visible area
      const dataUrl = await captureVisibleArea();
      const img = await loadImage(dataUrl);

      // Calculate position to draw on canvas
      const yPosition = Math.min(scrollPos, pageHeight - viewportHeight);

      // Draw image on canvas
      ctx.drawImage(img, 0, yPosition);

      // Remove from failed segments list
      failedSegments = failedSegments.filter(seg => seg !== i);
    } catch (recoveryError) {
      console.error(`Failed to recover segment ${i}:`, recoveryError);
    }
  }
}

// Fallback method that captures visible viewport only
async function tryFallbackMethod() {
  try {
    captureAttempts++;

    if (captureAttempts >= MAX_CAPTURE_ATTEMPTS) {
      chrome.runtime.sendMessage({
        action: "progressUpdate",
        progress: 50,
        message: "Maximum attempts reached. Falling back to visible area only..."
      });

      // If we've tried multiple times, just capture what's visible
      const dataUrl = await captureVisibleArea();

      try {
        chrome.runtime.sendMessage({
          action: "screenshotCaptured",
          dataUrl: dataUrl,
          hasGaps: true
        });
      } catch (error) {
        console.debug("Error sending screenshot captured message:", error);
        // The screenshot was still captured, but we couldn't send it
      }
      return;
    }

    chrome.runtime.sendMessage({
      action: "progressUpdate",
      progress: 50,
      message: `Retry attempt ${captureAttempts}/${MAX_CAPTURE_ATTEMPTS}...`
    });

    // Wait a bit before retrying
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Try a different approach based on the error pattern
    if (failedSegments.length > 0) {
      // If specific segments failed, try with a completely different scroll step
      await captureFullPage();
    } else {
      // If general failure, try with visible area only
      const dataUrl = await captureVisibleArea();

      try {
        chrome.runtime.sendMessage({
          action: "screenshotCaptured",
          dataUrl: dataUrl,
          hasGaps: true
        });
      } catch (error) {
        console.debug("Error sending screenshot captured message:", error);
        // The screenshot was still captured, but we couldn't send it
      }
    }
  } catch (fallbackError) {
    chrome.runtime.sendMessage({
      action: "captureError",
      error: "All capture methods failed. " + fallbackError.message
    });
  }
}

// Alternative capture method for individual segments
async function tryAlternativeCapture(segmentIndex, totalSegments, ctx, scrollPos, pageHeight, viewportHeight) {
  chrome.runtime.sendMessage({
    action: "progressUpdate",
    progress: Math.round((segmentIndex / totalSegments) * 100),
    message: "Using alternative method for segment " + (segmentIndex + 1)
  });

  // Try different approaches in sequence
  const approaches = [
    // Approach 1: Slight position adjustment with JPEG format
    async () => {
      const smallerScrollPos = scrollPos + 50;
      window.scrollTo(0, smallerScrollPos);
      await new Promise(resolve => setTimeout(resolve, 300));
      const dataUrl = await captureVisibleAreaWithFormat('jpeg', 0.9);
      const img = await loadImage(dataUrl);
      const yPosition = Math.min(scrollPos, pageHeight - viewportHeight);
      ctx.drawImage(img, 0, yPosition);
      return true;
    },

    // Approach 2: Different scroll position with longer wait
    async () => {
      const adjustedScrollPos = scrollPos - 25;
      window.scrollTo(0, adjustedScrollPos);
      await new Promise(resolve => setTimeout(resolve, 600));
      const dataUrl = await captureVisibleArea();
      const img = await loadImage(dataUrl);
      const yPosition = Math.min(scrollPos, pageHeight - viewportHeight);
      ctx.drawImage(img, 0, yPosition);
      return true;
    },

    // Approach 3: Smaller capture area
    async () => {
      window.scrollTo(0, scrollPos + 100);
      await new Promise(resolve => setTimeout(resolve, 400));
      const dataUrl = await captureVisibleAreaWithFormat('jpeg', 0.8);
      const img = await loadImage(dataUrl);
      const yPosition = Math.min(scrollPos + 100, pageHeight - viewportHeight);
      ctx.drawImage(img, 0, yPosition);
      return true;
    }
  ];

  // Try each approach in sequence until one succeeds
  for (const approach of approaches) {
    try {
      const success = await approach();
      if (success) return true;
    } catch (error) {
      console.error("Alternative approach failed:", error);
      // Continue to next approach
    }
  }

  return false;
}

// Helper function to capture visible area
function captureVisibleArea() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({action: "captureVisibleArea"}, function(response) {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else if (response && response.dataUrl) {
        resolve(response.dataUrl);
      } else if (response && response.error) {
        reject(new Error(response.error));
      } else {
        reject(new Error("Failed to capture screenshot"));
      }
    });
  });
}

// Helper function to capture visible area with specific format
function captureVisibleAreaWithFormat(format, quality) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      action: "captureVisibleArea",
      format: format,
      quality: quality
    }, function(response) {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else if (response && response.dataUrl) {
        resolve(response.dataUrl);
      } else if (response && response.error) {
        reject(new Error(response.error));
      } else {
        reject(new Error("Failed to capture screenshot"));
      }
    });
  });
}

// Helper function to load image from data URL
function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}