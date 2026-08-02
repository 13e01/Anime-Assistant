## Anime-Assistant — Live2D assistant for VS Code

> Quick start: open the command palette (Ctrl/Cmd+Shift+P), run "Anime: Show model" and press Enter.

Anime assistant to boost focus and engagement while coding. The extension provides:

- A Live2D model panel inside VS Code
- A separate transparent Electron overlay window that can be kept on top of the IDE
- Light gamification: Pomodoro timer, level/XP, reactions to saves/edits/focus changes

The overlay reacts to editor actions (edits, saves, file focus changes) via a simple events bridge and can speak phrases or play audio.

### Demo

![Demo](./anime-overlay/public/img/demo.gif)

### Quick start

Requirements:

- VS Code 1.100+

Start the overlay:

- Press `Ctrl+Alt+A` (`Cmd+Alt+A` on macOS), or open the command palette
  (`Ctrl/Cmd+Shift+P`) and run "Anime: Show model".
- The published extension includes the overlay runtime; no Node.js installation
  or terminal commands are required.

### Usage

- The "Anime: Show model" command launches the Electron overlay with a Live2D model, Pomodoro timer and reactions
- The built-in panel provides a small preview of the model inside VS Code
- The overlay can be dragged, pinned and toggled between clickable and click-through modes
- Saving files grants XP; edits and focus changes trigger small reactions

The overlay opens as a transparent window that can be kept on top of your IDE.

### Under the hood

- The extension writes compact JSON events to `anime-overlay/events.json`
- The overlay (`anime-overlay`) reads this file to display reactions, audio and animations
- Models are loaded from public CDNs by default (supports Cubism2 and Cubism4). For offline use, place assets locally and update the config.

### Project structure

- `src/extension.ts` — extension entrypoint: command, panel, events bridge
- `anime-overlay/` — Electron overlay app (Live2D, Pomodoro, XP)
- `anime-overlay/public/` — static assets (HTML/CSS/JS, model indexes, audio)

- Phrases and audio can be modified in `anime-overlay/public/phrases.json` and `anime-overlay/public/audio/`
- By default models and some dependencies are loaded from CDNs; for offline use, place assets locally and update paths.

### License

MIT
