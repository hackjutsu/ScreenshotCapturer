// Simple script to generate placeholder icons for the extension
// Run this with Node.js to create the icon files

const fs = require('fs');
const { createCanvas } = require('canvas');

// Icon sizes
const sizes = [16, 48, 128];

// Create directory if it doesn't exist
if (!fs.existsSync('./icons')) {
  fs.mkdirSync('./icons');
}

// Generate icons for each size
sizes.forEach(size => {
  // Create canvas with the specified size
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Fill background
  ctx.fillStyle = '#4285f4'; // Google blue
  ctx.fillRect(0, 0, size, size);

  // Draw a camera icon (simplified)
  ctx.fillStyle = 'white';

  // Camera body
  const bodyWidth = size * 0.7;
  const bodyHeight = size * 0.5;
  const bodyX = (size - bodyWidth) / 2;
  const bodyY = (size - bodyHeight) / 2;

  ctx.fillRect(bodyX, bodyY, bodyWidth, bodyHeight);

  // Camera lens
  ctx.beginPath();
  const lensRadius = size * 0.15;
  const lensX = size / 2;
  const lensY = size / 2;
  ctx.arc(lensX, lensY, lensRadius, 0, Math.PI * 2);
  ctx.fillStyle = '#4285f4';
  ctx.fill();

  // Flash
  const flashWidth = size * 0.2;
  const flashHeight = size * 0.1;
  const flashX = bodyX + bodyWidth - flashWidth - size * 0.05;
  const flashY = bodyY - flashHeight - size * 0.02;
  ctx.fillStyle = 'white';
  ctx.fillRect(flashX, flashY, flashWidth, flashHeight);

  // Convert to PNG buffer
  const buffer = canvas.toBuffer('image/png');

  // Save to file
  fs.writeFileSync(`./icons/icon${size}.png`, buffer);

  console.log(`Created icon${size}.png`);
});

console.log('All icons created successfully!');