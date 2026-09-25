/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Renders resources/icon.svg to resources/icon.png (1024x1024, transparent corners) with
 * Electron's own renderer, so no image library is needed. electron-builder derives the
 * Windows .ico, macOS .icns and Linux icon set from that PNG at package time.
 *
 * Run with `npm run icon`.
 */
const { app, BrowserWindow } = require('electron');
const { promises: fs } = require('node:fs');
const path = require('node:path');

const SIZE = 1024;
const root = path.join(__dirname, '..');
const source = path.join(root, 'resources', 'icon.svg');
const target = path.join(root, 'resources', 'icon.png');

async function main() {
  await app.whenReady();
  const svg = await fs.readFile(source, 'utf8');
  const win = new BrowserWindow({ width: 200, height: 200, show: false, webPreferences: { sandbox: true } });
  await win.loadURL('data:text/html;charset=utf-8,<!doctype html><html><body></body></html>');
  // A canvas is not bound to the window size, so the icon renders at full resolution on any screen.
  const dataUrl = await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = ${SIZE};
        canvas.height = ${SIZE};
        canvas.getContext('2d').drawImage(img, 0, 0, ${SIZE}, ${SIZE});
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('svg failed to decode'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)});
    })
  `);
  const png = Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64');
  await fs.writeFile(target, png);
  console.log(`wrote ${path.relative(root, target)} (${SIZE}x${SIZE}, ${png.length} bytes)`);
  win.destroy();
  app.exit(0);
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
