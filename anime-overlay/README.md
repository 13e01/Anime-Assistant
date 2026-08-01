How to run the overlay locally:

1. Open a terminal in the `anime-overlay` folder.
2. Run:

```powershell
npm install
npm run start
```

Electron will open a transparent window with the Live2D model which can be kept on top of your IDE.

Notes:

- For distribution you will need to include Electron in your packaged extension or provide a separate installer.
- By default models are loaded from CDNs; for offline use place the model files under `anime-overlay/media` and update the config.
