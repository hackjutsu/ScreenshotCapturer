# Screenshot Extension

A Chrome extension that allows you to take screenshots of web pages in two ways:
1. Capture the visible area only
2. Capture the full webpage by automatically scrolling and stitching

## Features

- **Visible Area Screenshot**: Captures what's currently visible in the browser tab
- **Full Page Screenshot**: Captures the entire webpage by scrolling and stitching multiple screenshots together
- Automatic filename generation with timestamps
- Progress indicator for full page captures

## Installation

### Development Mode

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" using the toggle in the top-right corner
4. Click "Load unpacked" and select the folder containing the extension files
5. The extension icon should appear in your Chrome toolbar

### From Chrome Web Store (Coming Soon)

1. Visit the Chrome Web Store page for this extension (link to be added)
2. Click "Add to Chrome"
3. Confirm the installation

## Usage

1. Navigate to the webpage you want to capture
2. Click the extension icon in your Chrome toolbar
3. Choose one of the following options:
   - **Capture Visible Area**: Takes a screenshot of what's currently visible
   - **Capture Full Page**: Takes a screenshot of the entire webpage (may take a moment for long pages)
4. The screenshot will be automatically downloaded with a timestamp in the filename

## How It Works

- **Visible Area Screenshot**: Uses Chrome's `captureVisibleTab` API
- **Full Page Screenshot**:
  - Creates a canvas the size of the entire webpage
  - Scrolls through the page, taking screenshots at each position
  - Draws each screenshot onto the canvas at the appropriate position
  - Converts the final canvas to a PNG image

## Requirements

- Google Chrome browser (version 88 or later recommended)

## Known Limitations

- Some websites with complex layouts or dynamic content may not capture perfectly
- Very large webpages may require significant memory during the capture process
- Websites that block content scripts may not work with the full page capture feature

## License

MIT