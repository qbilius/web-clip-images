const { Plugin, PluginSettingTab, Setting, Notice, normalizePath, requestUrl } = require('obsidian');

// ─── Default settings ──────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  watchFolders:           'Clippings',
  delayMs:                2000,
  attachmentPathMode:     'obsidian',   // 'obsidian' | 'custom' | 'samename'
  customAttachmentFolder: 'attachments',
  linkFormat:             'wikilink',   // 'wikilink' | 'markdown'
};

// ─── Regexes ───────────────────────────────────────────────────────────────

// Markdown images: ![alt](https://...) and variants with title
const MD_IMAGE_REGEX = /!\[([^\]]*)\]\((https?:\/\/[^\s)"']+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/g;

// HTML img tags: <img src="https://..."> or <img src='https://...'>
const HTML_IMG_REGEX = /<img\s[^>]*\bsrc=(?:"(https?:\/\/[^"]+)"|'(https?:\/\/[^']+)')[^>]*>/gi;

// Minimum file size: below this treat as tracking pixel and skip (1 KB)
const MIN_IMAGE_BYTES = 1024;

// Retry interval in milliseconds for failed downloads
const RETRY_DELAY_MS = 1500;

// Maximum number of concurrent image downloads
const DOWNLOAD_CONCURRENCY = 3;

// Map from MIME type to file extension
const MIME_EXT_MAP = {
  'image/jpeg':    '.jpg',
  'image/png':     '.png',
  'image/gif':     '.gif',
  'image/webp':    '.webp',
  'image/svg+xml': '.svg',
  'image/avif':    '.avif',
  'image/bmp':     '.bmp',
};

// ─── Settings tab ──────────────────────────────────────────────────────────

class AutoDownloadSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Auto Download Images After Clipping' });

    // Watch folders
    new Setting(containerEl)
      .setName('Watch folders')
      .setDesc('Automatically download images when a .md file in these folders is written. One path per line, relative to vault root. e.g. Clippings or ReadItLater/Articles')
      .addTextArea(text => {
        text
          .setPlaceholder('Clippings\nReadItLater/Articles')
          .setValue(this.plugin.settings.watchFolders)
          .onChange(async (value) => {
            this.plugin.settings.watchFolders = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 6;
        text.inputEl.style.width = '100%';
        text.inputEl.style.fontFamily = 'monospace';
      });

    // Debounce delay
    new Setting(containerEl)
      .setName('Debounce delay (ms)')
      .setDesc('Processing starts this long after the last file modification. Increase if images are missed because the clipper is still writing.')
      .addText(text => {
        text
          .setPlaceholder('2000')
          .setValue(String(this.plugin.settings.delayMs))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n >= 0) {
              this.plugin.settings.delayMs = n;
              await this.plugin.saveSettings();
            }
          });
        text.inputEl.type = 'number';
        text.inputEl.style.width = '80px';
      });

    // Image save location
    new Setting(containerEl)
      .setName('Image save location')
      .setDesc('Where to save downloaded images.')
      .addDropdown(drop => {
        drop
          .addOption('obsidian', 'Follow Obsidian settings')
          .addOption('custom',   'Custom subfolder under the same directory as the note')
          .addOption('samename', 'Subfolder with the same name as the note (under the same directory)')
          .setValue(this.plugin.settings.attachmentPathMode)
          .onChange(async (value) => {
            this.plugin.settings.attachmentPathMode = value;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    // Custom subfolder name (only shown in 'custom' mode)
    if (this.plugin.settings.attachmentPathMode === 'custom') {
      new Setting(containerEl)
        .setName('Subfolder name')
        .setDesc('Folder name relative to the note\'s directory. Default: attachments')
        .addText(text => {
          text
            .setPlaceholder('attachments')
            .setValue(this.plugin.settings.customAttachmentFolder)
            .onChange(async (value) => {
              this.plugin.settings.customAttachmentFolder = value.trim() || 'attachments';
              await this.plugin.saveSettings();
            });
          text.inputEl.style.width = '200px';
        });
    }

    // Image link format
    new Setting(containerEl)
      .setName('Image link format')
      .setDesc('Format used when inserting downloaded images into notes.')
      .addDropdown(drop => {
        drop
          .addOption('wikilink', 'Wikilink  ![[...]]')
          .addOption('markdown', 'Markdown  ![alt](...)')
          .setValue(this.plugin.settings.linkFormat)
          .onChange(async (value) => {
            this.plugin.settings.linkFormat = value;
            await this.plugin.saveSettings();
          });
      });
  }
}

// ─── Main plugin ───────────────────────────────────────────────────────────

class AutoDownloadAttachmentsPlugin extends Plugin {

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new AutoDownloadSettingTab(this.app, this));

    // Lock set to prevent concurrent processing of the same file
    this.processingFiles = new Set();
    // Session-scoped blacklist of failed/skipped URLs to avoid repeated retries
    this.failedUrls = new Set();
    // Per-file debounce timers
    this.debounceTimers = new Map();

    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (!file.path.endsWith('.md')) return;
        if (!this.isWatched(file.path)) return;
        if (this.processingFiles.has(file.path)) return;

        if (this.debounceTimers.has(file.path)) {
          clearTimeout(this.debounceTimers.get(file.path));
        }
        const timer = setTimeout(() => {
          this.debounceTimers.delete(file.path);
          this.triggerDownload(file);
        }, this.settings.delayMs);
        this.debounceTimers.set(file.path, timer);
      })
    );

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!file.path.endsWith('.md')) return;
        if (!this.isWatched(file.path)) return;
        if (this.processingFiles.has(file.path)) return;

        // Debounce: reset timer on each modification, fire only after delayMs of silence
        if (this.debounceTimers.has(file.path)) {
          clearTimeout(this.debounceTimers.get(file.path));
        }
        const timer = setTimeout(() => {
          this.debounceTimers.delete(file.path);
          this.triggerDownload(file);
        }, this.settings.delayMs);
        this.debounceTimers.set(file.path, timer);
      })
    );

    const folders = this._watchedFolders.join(', ');
    console.log(`Auto Download Images After Clipping: started, watching → ${folders}`);
  }

  onunload() {
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
  }

  isWatched(filePath) {
    return this._watchedFolders.some(folder => {
      const prefix = folder.endsWith('/') ? folder : folder + '/';
      return filePath.startsWith(prefix);
    });
  }

  async resolveAttachmentFolder(file) {
    const { attachmentPathMode, customAttachmentFolder } = this.settings;
    const fileDir = file.parent?.path ?? '';

    switch (attachmentPathMode) {
      case 'obsidian': {
        const setting = this.app.vault.getConfig('attachmentFolderPath') ?? 'attachments';
        if (setting === '/') return normalizePath('/');
        if (setting.startsWith('./')) {
          return normalizePath(`${fileDir}/${setting.slice(2)}`);
        }
        return normalizePath(setting);
      }
      case 'custom': {
        const subFolder = (customAttachmentFolder || 'attachments').trim();
        return normalizePath(`${fileDir}/${subFolder}`);
      }
      case 'samename': {
        const safeName = sanitizeFolderName(file.basename);
        return normalizePath(`${fileDir}/${safeName}`);
      }
      default:
        return normalizePath('attachments');
    }
  }

  async triggerDownload(file) {
    if (this.processingFiles.has(file.path)) return;
    this.processingFiles.add(file.path);
    try {
      const leaf = this.app.workspace.getLeaf();
      await leaf.openFile(file);
      this.app.commands.executeCommandById('editor:download-attachments');

      // Poll for the confirmation dialog and click the primary button
      let clicked = false;
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const btn = document.querySelector('.modal-button-container .mod-cta');
        if (btn) { btn.click(); clicked = true; break; }
      }

      // If download was triggered, hold the lock until after Obsidian writes the
      // file back (replacing remote URLs with local paths), so the resulting
      // modify events don't start a new download cycle.
      if (clicked) {
        await new Promise(resolve => setTimeout(resolve, this.settings.delayMs + 2000));
      }
    } finally {
      this.processingFiles.delete(file.path);
    }
  }

  // Infer file extension from Content-Type header
  extFromContentType(contentType) {
    return MIME_EXT_MAP[contentType.split(';')[0].trim()] ?? null;
  }

  // Resolve destination path, appending (2), (3)… if the filename already exists
  async resolveDestPath(folder, baseName) {
    let candidate = normalizePath(`${folder}/${baseName}`);
    if (!await this.app.vault.adapter.exists(candidate)) return candidate;

    const ext  = baseName.match(/\.[^.]+$/)?.[0] ?? '';
    const stem = baseName.slice(0, baseName.length - ext.length);
    for (let counter = 2; counter <= 99; counter++) {
      candidate = normalizePath(`${folder}/${stem}(${counter})${ext}`);
      if (!await this.app.vault.adapter.exists(candidate)) return candidate;
    }
    // Fall back to timestamp suffix when counter exceeds limit
    return normalizePath(`${folder}/${stem}(${Date.now()})${ext}`);
  }

  // Ensure folder exists: quick full-path check first, then create segment by segment, tolerating race conditions
  async ensureFolder(folderPath) {
    if (!folderPath || folderPath === '/') return;
    // Fast path: folder already exists in the common case
    if (await this.app.vault.adapter.exists(folderPath)) return;

    const parts = folderPath.split('/').filter(p => p);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!await this.app.vault.adapter.exists(current)) {
        try {
          await this.app.vault.createFolder(current);
        } catch (err) {
          // If a concurrent task already created it, exists should now be true; otherwise re-throw
          if (!await this.app.vault.adapter.exists(current)) throw err;
        }
      }
    }
  }

  // Infer file extension from URL (fallback when Content-Type is unavailable)
  extractExt(url) {
    const clean = url.split('?')[0].split('#')[0];
    const m = clean.match(/\.(jpg|jpeg|png|gif|webp|svg|avif|bmp)$/i);
    return m ? `.${m[1].toLowerCase()}` : '.jpg';
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Cache derived value to avoid recomputation on every event
    this._watchedFolders = parseFolders(this.settings.watchFolders);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Refresh cache after settings change
    this._watchedFolders = parseFolders(this.settings.watchFolders);
  }
}

// ─── Utilities ─────────────────────────────────────────────────────────────

function formatImageLink(destPath, alt, linkFormat) {
  return linkFormat === 'wikilink'
    ? `![[${destPath}]]`
    : `![${alt}](<${destPath}>)`;
}

function parseFolders(raw) {
  return raw
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function sanitizeFolderName(name) {
  return name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    || 'attachments';
}

module.exports = AutoDownloadAttachmentsPlugin;
