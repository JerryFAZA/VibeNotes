/**
 * VibeNotes for Windows — renderer logic.
 * Ported feature set: trigger modes (hover/click/tray), multi-tab Markdown notes,
 * file shelf (drag in / drag out), keep-awake toggles, JSON persistence.
 */
'use strict';

const $ = (sel) => document.querySelector(sel);

const el = {
  stage: $('#stage'),
  pill: $('#pill'),
  panel: $('#panel'),
  toolbar: $('#toolbar'),
  tabs: $('#tabs'),
  btnAddTab: $('#btn-add-tab'),
  btnPreview: $('#btn-preview'),
  btnPin: $('#btn-pin'),
  dragHandle: $('#drag-handle'),
  btnRestore: $('#btn-restore'),
  btnSettings: $('#btn-settings'),
  btnCollapse: $('#btn-collapse'),
  toast: $('#toast'),
  editorArea: $('#editor-area'),
  editStack: $('#edit-stack'),
  hl: $('#hl'),
  editor: $('#editor'),
  preview: $('#preview'),
  shelf: $('#shelf'),
  shelfCount: $('#shelf-count'),
  shelfClear: $('#shelf-clear'),
  shelfItems: $('#shelf-items'),
  settingsPop: $('#settings-pop'),
  segMode: $('#seg-mode'),
  segCollapse: $('#seg-collapse'),
  swKeepAwake: $('#sw-keepawake'),
  swScreen: $('#sw-screen'),
  btnOpenData: $('#btn-open-data'),
  btnStartup: $('#btn-startup'),
};

const WIN_W = 720;
const PILL_W = 240;
const PILL_H = 28;
// Left/right 15% of the pill are dedicated drag grips: hovering there never
// expands the panel (they exist for horizontal dragging only).
const PILL_NO_HOVER_L = WIN_W / 2 - PILL_W / 2 + PILL_W * 0.15;  // = 276
const PILL_NO_HOVER_R = WIN_W / 2 + PILL_W / 2 - PILL_W * 0.15;  // = 444

let settings = {
  triggerMode: 'hover',
  autoCollapse: 'mouseLeave',   // 'mouseLeave' | 'none'
  keepAwake: false,
  screenAlwaysOn: false,
  launchAtLogin: false,
  pinned: false,                // panel pinned: stays expanded & on top
};

let expanded = false;
let previewOn = false;
let draggingFile = false;   // a file is being dragged over the window
let draggingOut = false;    // a shelf item is being dragged out to the system
let dragFileTimeout = null; // watchdog: never let draggingFile stick
let hoverAwayTimer = null;
let clickthroughActive = true;
let suppressHl = false;

/* =========================================================================
 * Note store (mirrors macOS NoteStore semantics)
 * ========================================================================= */
const notes = {
  tabs: [],               // { id, text, createdAt, selStart, selEnd }
  activeTabID: null,
  recentlyDeleted: null,  // { tab, index }
  saveTimer: null,

  async load() {
    const data = await window.notch.loadData('notes.json', null);
    if (data && Array.isArray(data.tabs) && data.tabs.length > 0) {
      this.tabs = data.tabs.map((t) => ({
        id: t.id || uid(),
        text: typeof t.text === 'string' ? t.text : '',
        createdAt: t.createdAt || Date.now(),
        selStart: t.selStart || 0,
        selEnd: t.selEnd || 0,
      }));
      this.activeTabID = this.tabs.some((t) => t.id === data.activeTabID)
        ? data.activeTabID
        : this.tabs[0].id;
    } else {
      this.tabs = [{ id: uid(), text: '', createdAt: Date.now(), selStart: 0, selEnd: 0 }];
      this.activeTabID = this.tabs[0].id;
      this.persistNow();
    }
  },

  get active() {
    return this.tabs.find((t) => t.id === this.activeTabID) || this.tabs[0];
  },

  updateText(text) {
    const tab = this.active;
    if (tab.text === text) return;
    tab.text = text;
    this.scheduleSave();
  },

  updateSelection(selStart, selEnd) {
    const tab = this.active;
    const len = tab.text.length;
    tab.selStart = Math.min(Math.max(selStart, 0), len);
    tab.selEnd = Math.min(Math.max(selEnd, 0), len);
    this.scheduleSave();
  },

  addTab() {
    const tab = { id: uid(), text: '', createdAt: Date.now(), selStart: 0, selEnd: 0 };
    this.tabs.push(tab);
    this.activeTabID = tab.id;
    this.scheduleSave();
    renderTabs();
    refreshEditorFromStore();   // clear the editor: a new tab starts blank
    focusEditor();
  },

  removeTab(id) {
    if (this.tabs.length <= 1) return;
    const index = this.tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    this.recentlyDeleted = { tab: this.tabs[index], index };
    this.tabs.splice(index, 1);
    if (this.activeTabID === id) {
      this.activeTabID = this.tabs[Math.min(index, this.tabs.length - 1)].id;
    }
    this.scheduleSave();
    renderTabs();
    refreshEditorFromStore();
    updateRestoreButton();
  },

  restoreLastDeleted() {
    if (!this.recentlyDeleted) return;
    const { tab, index } = this.recentlyDeleted;
    this.recentlyDeleted = null;
    this.tabs.splice(Math.min(index, this.tabs.length), 0, tab);
    this.activeTabID = tab.id;
    this.scheduleSave();
    renderTabs();
    refreshEditorFromStore();
    updateRestoreButton();
    showToast('已恢复删除的便签');
  },

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persistNow(), 180);
  },

  persistNow() {
    clearTimeout(this.saveTimer);
    const snapshot = {
      tabs: this.tabs,
      activeTabID: this.activeTabID,
      savedAt: Date.now(),
    };
    window.notch.saveData('notes.json', snapshot);
  },
};

function uid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function tabTitle(tab, index) {
  let title = '';
  const lines = tab.text.split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (t) { title = t; break; }
  }
  for (const p of ['# ', '## ', '### ', '- [ ] ', '- [x] ', '- [X] ', '- ', '* ', '> ']) {
    if (title.startsWith(p)) { title = title.slice(p.length); }
  }
  title = title.trim();
  if (!title) return `未命名 ${index + 1}`;
  return title.length > 42 ? title.slice(0, 41) + '…' : title;
}

/* =========================================================================
 * File shelf store
 * ========================================================================= */
const shelf = {
  items: [], // { id, path, name, addedAt }

  async load() {
    this.items = (await window.notch.loadData('shelf.json', [])) || [];
    renderShelf();
  },

  async add(paths) {
    const known = new Set(this.items.map((i) => normalizePath(i.path)));
    let added = 0;
    for (const p of paths) {
      if (!p) continue;
      const norm = normalizePath(p);
      if (known.has(norm)) continue;
      if (this.items.length >= 100) { showToast('暂存区最多保留 100 个文件'); break; }
      known.add(norm);
      this.items.push({
        id: uid(),
        path: p,
        name: p.split(/[\\/]/).pop() || p,
        addedAt: Date.now(),
      });
      added++;
    }
    if (added > 0) {
      await window.notch.saveData('shelf.json', this.items);
      renderShelf();
      if (added > 0) showToast(`已暂存 ${added} 个文件（仅保留引用）`);
    }
  },

  async remove(id) {
    this.items = this.items.filter((i) => i.id !== id);
    await window.notch.saveData('shelf.json', this.items);
    renderShelf();
  },

  async clear() {
    if (!this.items.length) return;
    this.items = [];
    await window.notch.saveData('shelf.json', this.items);
    renderShelf();
    showToast('暂存区已清空（原文件不受影响）');
  },
};

function normalizePath(p) {
  return String(p).replace(/\//g, '\\').toLowerCase();
}

/* =========================================================================
 * Markdown highlight layer
 * ========================================================================= */
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inlineSpans(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\x00${codes.length - 1}\x00`;
  });
  s = s
    .replace(/!\[([^\]]*)\]\(([^)\s]*)\)/g,
      '<span class="tok-img">![$1](</span><span class="tok-url">$2</span><span class="tok-img">)</span>')
    .replace(/\[([^\]]+)\]\(([^)\s]*)\)/g,
      '<span class="tok-link">[$1](</span><span class="tok-url">$2</span><span class="tok-link">)</span>')
    .replace(/\*\*([^*]+)\*\*/g, '<span class="tok-bold">**$1**</span>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<span class="tok-italic">*$2*</span>')
    .replace(/~~([^~]+)~~/g, '<span class="tok-strike">~~$1~~</span>');
  return s.replace(/\x00(\d+)\x00/g, (_, i) => `<span class="tok-code">\`${codes[Number(i)]}\`</span>`);
}

function highlightMarkdown(src) {
  const lines = escapeHtml(src).split('\n');
  let inCode = false;
  return lines.map((line) => {
    if (/^\s*```/.test(line)) { inCode = !inCode; return `<span class="tok-codeblock">${line || '\u200b'}</span>`; }
    if (inCode) return `<span class="tok-codeblock">${line || '\u200b'}</span>`;
    let m;
    if ((m = /^(#{1,6})(\s+)(.*)$/.exec(line))) {
      const cls = m[1].length <= 1 ? 'tok-h1' : m[1].length === 2 ? 'tok-h2' : 'tok-h3';
      return `<span class="${cls}">${m[1]}${m[2]}</span>${inlineSpans(m[3])}`;
    }
    if ((m = /^(\s*&gt;+\s?)(.*)$/.exec(line))) {
      return `<span class="tok-quote">${m[1]}${inlineSpans(m[2])}</span>`;
    }
    if ((m = /^(\s*[-*+]\s+)\[([ xX])\](\s+)(.*)$/.exec(line))) {
      const cls = m[2] === ' ' ? 'tok-task-open' : 'tok-task-done';
      return `${m[1]}<span class="${cls}">[${m[2]}]</span>${m[3]}${inlineSpans(m[4])}`;
    }
    if ((m = /^(\s*[-*+]\s+|\s*\d+\.\s+)(.*)$/.exec(line))) {
      return `<span class="tok-list">${m[1]}</span>${inlineSpans(m[2])}`;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      return `<span class="tok-list">${line}</span>`;
    }
    return inlineSpans(line) || '\u200b';
  }).join('\n');
}

function updateHl() {
  if (suppressHl) return;
  el.hl.innerHTML = highlightMarkdown(el.editor.value) + '\n';
}

function syncScroll() {
  el.hl.scrollTop = el.editor.scrollTop;
}

/* =========================================================================
 * Mini markdown renderer (preview)
 * ========================================================================= */
function inlineHtml(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\x00${codes.length - 1}\x00`; });
  s = escapeHtml(s)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) =>
      /^images\//.test(url)
        ? `<img alt="${alt}" data-src="${url}" />`
        : `<img alt="${alt}" src="${url}" />`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a data-href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\x00(\d+)\x00/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  return s;
}

function renderPreview(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  let para = [];
  let inCode = false;
  let codeBuf = [];
  let listType = null;
  let listBuf = [];

  const flushPara = () => {
    if (para.length) { out.push(`<p>${inlineHtml(para.join(' '))}</p>`); para = []; }
  };
  const flushList = () => {
    if (listBuf.length) {
      out.push(listType === 'ol' ? `<ol>${listBuf.join('')}</ol>` : `<ul>${listBuf.join('')}</ul>`);
      listBuf = []; listType = null;
    }
  };
  const flushAll = () => { flushPara(); flushList(); };

  while (i < lines.length) {
    const line = lines[i];

    if (inCode) {
      if (/^\s*```/.test(line)) {
        out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = []; inCode = false;
      } else {
        codeBuf.push(line);
      }
      i++; continue;
    }

    if (/^\s*```/.test(line)) { flushAll(); inCode = true; i++; continue; }

    if (/^\s*$/.test(line)) { flushAll(); i++; continue; }

    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flushAll();
      const lvl = Math.min(m[1].length, 4);
      out.push(`<h${lvl}>${inlineHtml(m[2])}</h${lvl}>`);
      i++; continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushAll(); out.push('<hr/>'); i++; continue; }
    if ((m = /^(\s*&gt;|\s*>)\s?(.*)$/.exec(line))) {
      flushAll();
      out.push(`<blockquote>${inlineHtml(m[2])}</blockquote>`);
      i++; continue;
    }
    if ((m = /^(\s*[-*+])\s+\[([ xX])\]\s+(.*)$/.exec(line))) {
      flushPara();
      if (listType && listType !== 'task') flushList();
      listType = 'task';
      const checked = m[2] !== ' ' ? ' checked' : '';
      listBuf.push(`<li class="task"><input type="checkbox" disabled${checked}/>${inlineHtml(m[3])}</li>`);
      i++; continue;
    }
    if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
      flushPara();
      if (listType && listType !== 'ul') flushList();
      listType = 'ul';
      listBuf.push(`<li>${inlineHtml(m[1])}</li>`);
      i++; continue;
    }
    if ((m = /^\s*\d+\.\s+(.*)$/.exec(line))) {
      flushPara();
      if (listType && listType !== 'ol') flushList();
      listType = 'ol';
      listBuf.push(`<li>${inlineHtml(m[1])}</li>`);
      i++; continue;
    }

    flushList();
    para.push(line.trim());
    i++;
  }
  flushAll();
  return out.join('\n');
}

async function refreshPreview() {
  const html = renderPreview(el.editor.value);
  el.preview.innerHTML = html;
  // hydrate local images (stored under userData/images)
  const imgs = el.preview.querySelectorAll('img[data-src]');
  for (const img of imgs) {
    const rel = img.getAttribute('data-src');
    const dataUrl = await window.notch.readImage(rel);
    if (dataUrl) { img.src = dataUrl; img.removeAttribute('data-src'); }
    else { img.alt = '(图片缺失: ' + rel + ')'; }
  }
}

el.preview.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-href]');
  if (a) {
    e.preventDefault();
    window.notch.openExternal(a.getAttribute('data-href'));
  }
});

/* =========================================================================
 * Editor wiring
 * ========================================================================= */
function refreshEditorFromStore() {
  const tab = notes.active;
  suppressHl = true;
  el.editor.value = tab.text;
  suppressHl = false;
  updateHl();
  setSelection(tab.selStart, tab.selEnd);
  if (previewOn) refreshPreview();
}

function setSelection(start, end) {
  const len = el.editor.value.length;
  const s = Math.min(start, len);
  const ePos = Math.min(end, len);
  try { el.editor.setSelectionRange(s, ePos); } catch { /* ignore */ }
}

function focusEditor() {
  el.editor.focus();
  setSelection(el.editor.value.length, el.editor.value.length);
}

el.editor.addEventListener('input', () => {
  notes.updateText(el.editor.value);
  updateHl();
  if (previewOn) refreshPreview();
});

el.editor.addEventListener('scroll', syncScroll);
el.editor.addEventListener('select', () => {
  notes.updateSelection(el.editor.selectionStart, el.editor.selectionEnd);
});
el.editor.addEventListener('click', () => {
  notes.updateSelection(el.editor.selectionStart, el.editor.selectionEnd);
});
el.editor.addEventListener('keydown', (e) => {
  // Tab inserts two spaces instead of leaving the field
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = el.editor.selectionStart;
    const epos = el.editor.selectionEnd;
    el.editor.setRangeText('  ', s, epos, 'end');
    notes.updateText(el.editor.value);
    updateHl();
  }
});

// Paste images straight into the note
el.editor.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = async () => {
        const rel = await window.notch.saveImage(String(reader.result));
        if (rel) {
          const s = el.editor.selectionStart;
          el.editor.setRangeText(`![图片](${rel})\n`, s, el.editor.selectionEnd, 'end');
          notes.updateText(el.editor.value);
          updateHl();
          showToast('图片已插入并保存到本地');
        } else {
          showToast('图片保存失败');
        }
      };
      reader.readAsDataURL(file);
      return;
    }
  }
});

/* =========================================================================
 * Tabs UI
 * ========================================================================= */
function renderTabs() {
  el.tabs.innerHTML = '';
  notes.tabs.forEach((tab, index) => {
    const div = document.createElement('div');
    div.className = 'tab' + (tab.id === notes.activeTabID ? ' active' : '');
    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tabTitle(tab, index);
    div.appendChild(title);
    if (notes.tabs.length > 1) {
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = '删除此便签';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        notes.removeTab(tab.id);
      });
      div.appendChild(close);
    }
    div.addEventListener('click', () => {
      if (notes.activeTabID === tab.id) return;
      notes.activeTabID = tab.id;
      notes.scheduleSave();
      renderTabs();
      refreshEditorFromStore();
    });
    el.tabs.appendChild(div);
  });
  const activeIndex = notes.tabs.findIndex((t) => t.id === notes.activeTabID);
  if (activeIndex >= 0) {
    const node = el.tabs.children[activeIndex];
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

function updateRestoreButton() {
  el.btnRestore.style.display = notes.recentlyDeleted ? '' : 'none';
}

/* =========================================================================
 * Shelf UI
 * ========================================================================= */
const EXT_COLORS = {
  pdf: '#ff8a80', doc: '#82b1ff', docx: '#82b1ff', xls: '#a5d6a7', xlsx: '#a5d6a7',
  ppt: '#ffcc80', pptx: '#ffcc80', zip: '#ce93d8', rar: '#ce93d8', '7z': '#ce93d8',
  png: '#80deea', jpg: '#80deea', jpeg: '#80deea', gif: '#80deea', webp: '#80deea',
  txt: '#b0bec5', md: '#b0bec5', exe: '#ffb0b0', msi: '#ffb0b0',
};

function renderShelf() {
  el.shelfItems.innerHTML = '';
  if (!shelf.items.length) {
    const empty = document.createElement('div');
    empty.className = 'shelf-empty';
    empty.textContent = '将文件拖到这里暂存，再拖出去使用（不移动原文件）';
    el.shelfItems.appendChild(empty);
    el.shelfCount.textContent = '0/100';
    return;
  }
  el.shelfCount.textContent = `${shelf.items.length}/100`;

  shelf.items.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'shelf-item';
    div.title = item.path + '\n（单击打开 · 右键在文件夹中显示 · 拖出使用）';

    const ext = (item.name.split('.').pop() || '').toLowerCase();
    const icon = document.createElement('div');
    icon.className = 'shelf-icon';
    icon.textContent = (ext.slice(0, 3) || '文件').toUpperCase();
    if (EXT_COLORS[ext]) icon.style.color = EXT_COLORS[ext];

    const meta = document.createElement('div');
    meta.className = 'shelf-meta';
    const name = document.createElement('div');
    name.className = 'shelf-name';
    name.textContent = item.name;
    const sub = document.createElement('div');
    sub.className = 'shelf-sub';
    sub.textContent = ext ? ext.toUpperCase() + ' 文件' : '文件';
    meta.appendChild(name);
    meta.appendChild(sub);

    const x = document.createElement('div');
    x.className = 'shelf-x';
    x.textContent = '×';
    x.title = '从暂存区移除';
    x.addEventListener('click', (e) => { e.stopPropagation(); shelf.remove(item.id); });

    div.appendChild(icon);
    div.appendChild(meta);
    div.appendChild(x);

    div.addEventListener('click', () => window.notch.openFile(item.path));
    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window.notch.revealFile(item.path);
    });

    // Drag out: hand over to the system via webContents.startDrag
    div.draggable = true;
    div.addEventListener('dragstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      draggingOut = true;
      window.notch.dragOutFile(item.path);
    });
    div.addEventListener('dragend', () => { draggingOut = false; });

    el.shelfItems.appendChild(div);

    // availability check
    window.notch.fileExists(item.path).then((ok) => {
      if (!ok) { div.classList.add('missing'); sub.textContent = '文件已不存在'; }
    });
  });
}

/* Drag & drop files into the shelf / panel */
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  if (expanded) {
    const overShelf = hitShelf(e.clientY);
    el.shelf.classList.toggle('drop-target', overShelf);
  }
});

document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  draggingFile = true;
  clearTimeout(dragFileTimeout);
  // Watchdog: if dragleave/dragend are missed (cancelled drags etc.),
  // draggingFile must never stick and block auto-collapse forever.
  dragFileTimeout = setTimeout(() => { draggingFile = false; }, 10000);
  if (!expanded) expand('file-drop');
});

document.addEventListener('dragend', () => {
  draggingFile = false;
  clearTimeout(dragFileTimeout);
});

document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) {
    draggingFile = false;
    clearTimeout(dragFileTimeout);
    el.shelf.classList.remove('drop-target');
  }
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  draggingFile = false;
  clearTimeout(dragFileTimeout);
  el.shelf.classList.remove('drop-target');
  if (!e.dataTransfer) return;
  const paths = [];
  for (const f of e.dataTransfer.files) {
    const p = window.notch.pathForFile(f);
    if (p) paths.push(p);
  }
  if (paths.length) shelf.add(paths);
});

function hitShelf(clientY) {
  const rect = el.shelf.getBoundingClientRect();
  return clientY >= rect.top;
}

/* =========================================================================
 * Expand / collapse + click-through choreography
 * ========================================================================= */
function setClickThrough(ignore) {
  clickthroughActive = ignore;
  window.notch.setClickThrough(ignore);
}

function inHotzone(clientX, clientY) {
  if (settings.triggerMode === 'tray') return false;
  if (clientY > PILL_H) return false;
  return Math.abs(clientX - WIN_W / 2) <= PILL_W / 2;
}

function expand(source) {
  clearTimeout(hoverAwayTimer);
  if (expanded) return;
  expanded = true;
  el.panel.classList.add('expanded');
  el.pill.classList.add('hidden-pill');
  if (clickthroughActive) setClickThrough(false);
  window.notch.setPanelExpanded(true);
  // Focus the panel on click/tray open. Also focus when the user picked
  // "blur" quick-collapse - without focus, window blur can never fire.
  // win.focus() (OS level) is required: el.focus() alone does not activate
  // a window that was shown with showInactive().
  const baseFocus = source === 'tray' || source === 'click' || source === 'second-instance' || source === 'pinned';
  if (baseFocus) {
    window.notch.focusWindow();
    setTimeout(focusEditor, 100);
  }
}

function collapse() {
  if (!expanded) return;
  notes.persistNow();
  expanded = false;
  // Explicit collapse (Esc / Ctrl+W / tray / button) always un-pins:
  // "pinned" only suppresses *automatic* collapse paths.
  if (settings.pinned) {
    settings.pinned = false;
    el.btnPin.classList.remove('active');
    window.notch.setPinned(false);
  }
  el.panel.classList.remove('expanded');
  el.shelf.classList.remove('drop-target');
  closeSettings();
  window.notch.setPanelExpanded(false);
  setTimeout(() => {
    if (!expanded) {
      el.pill.classList.remove('hidden-pill');
      setClickThrough(true);
    }
  }, 280);
}

// -----------------------------------------------------------------------
// Pill gestures: press-hold-move = drag the window along X (snap on release);
// press-release without movement = expand per trigger mode.
// -----------------------------------------------------------------------
let pillPress = null;          // { startX, dragging }
let panelPress = null;         // drag-handle gesture on the expanded panel
let panelDragging = false;     // a panel drag is in progress (suppress auto-collapse)
let hoverDwellTimer = null;    // hover mode: expand after a short dwell
let suppressHoverUntil = 0;    // right after a drag, don't insta-expand

el.pill.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || expanded) return;
  clearTimeout(hoverDwellTimer);
  hoverDwellTimer = null;
  pillPress = { startX: e.clientX, dragging: false };
});

document.addEventListener('mousemove', (e) => {
  if (panelPress) {
    if (!panelPress.dragging) {
      if (Math.abs(e.clientX - panelPress.startX) >= 4 || Math.abs(e.clientY - panelPress.startY) >= 4) {
        panelPress.dragging = true;
        panelDragging = true;
        el.stage.classList.add('window-dragging');
        window.notch.dragStart('panel');
      }
    }
    return;
  }
  if (pillPress && !pillPress.dragging && !expanded) {
    if (Math.abs(e.clientX - pillPress.startX) >= 6) {
      pillPress.dragging = true;
      el.stage.classList.add('window-dragging');
      window.notch.dragStart('pill');      // main process drives the window with the real cursor
    }
    return;
  }
  if (expanded) return;
  if (pillPress) return;
  if (inHotzone(e.clientX, e.clientY)) {
    if (clickthroughActive) setClickThrough(false);
    // Left/right 15% of the pill = drag grips: hovering there never expands.
    const inDragZone = e.clientX <= PILL_NO_HOVER_L || e.clientX >= PILL_NO_HOVER_R;
    if (inDragZone && hoverDwellTimer) { clearTimeout(hoverDwellTimer); hoverDwellTimer = null; }
    if (settings.triggerMode === 'hover' && !inDragZone && Date.now() > suppressHoverUntil && !hoverDwellTimer) {
      hoverDwellTimer = setTimeout(() => {
        hoverDwellTimer = null;
        if (!expanded && !pillPress) expand('hover');
      }, 300);
    }
    // click mode: wait for the pill press-release
  } else {
    if (hoverDwellTimer) { clearTimeout(hoverDwellTimer); hoverDwellTimer = null; }
    if (!expanded && !clickthroughActive) setClickThrough(true);
  }
});

// Drag handle on the expanded panel (works pinned or not): press + move = free move
el.dragHandle.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !expanded) return;
  e.preventDefault();
  panelPress = { startX: e.clientX, startY: e.clientY, dragging: false };
});

document.addEventListener('mouseup', () => {
  if (panelPress) {
    const panelWasDragging = panelPress.dragging;
    panelPress = null;
    if (panelWasDragging) {
      panelDragging = false;
      el.stage.classList.remove('window-dragging');
      window.notch.dragEnd('panel');       // free placement + remember position
    }
    return;
  }
  if (!pillPress) return;
  const wasDragging = pillPress.dragging;
  pillPress = null;
  el.stage.classList.remove('window-dragging');
  if (wasDragging) {
    window.notch.dragEnd('pill');          // top snap + remember position
    suppressHoverUntil = Date.now() + 900; // pointer still rests on the pill; don't insta-expand
    return;
  }
  if (!expanded && (settings.triggerMode === 'click' || settings.triggerMode === 'hover')) {
    expand('click');
  }
});

el.pill.addEventListener('mouseleave', () => {
  if (!expanded && settings.triggerMode === 'click' && !clickthroughActive && !pillPress) {
    setTimeout(() => { if (!expanded && !pillPress) setClickThrough(true); }, 120);
  }
});

// Quick collapse "mouseLeave": the pointer leaves the expanded panel.
// Fast path only — the reliable detection is the main-process cursor poll
// (startLeaveWatch), which also sends collapse-requested.
el.panel.addEventListener('mouseleave', () => {
  if (settings.pinned || settings.autoCollapse !== 'mouseLeave' || !expanded || draggingFile) return;
  clearTimeout(hoverAwayTimer);
  hoverAwayTimer = setTimeout(() => {
    if (expanded && !draggingFile) collapse();
  }, 450);
});

el.panel.addEventListener('mouseenter', () => {
  clearTimeout(hoverAwayTimer);
});

// Click anywhere else in the panel closes the settings popover,
// so an open popover can never block auto-collapse.
document.addEventListener('mousedown', (e) => {
  if (!isSettingsOpen()) return;
  if (e.target.closest('#settings-pop') || e.target.closest('#btn-settings')) return;
  closeSettings();
});

// Keyboard: Esc / Ctrl+W collapse, Ctrl+T new tab, Ctrl+P preview
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { collapse(); return; }
  if (e.ctrlKey && (e.key === 'w' || e.key === 'W')) { e.preventDefault(); collapse(); return; }
  if (e.ctrlKey && (e.key === 't' || e.key === 'T')) { e.preventDefault(); notes.addTab(); return; }
  if (e.ctrlKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); togglePreview(); return; }
});

function togglePreview() {
  previewOn = !previewOn;
  el.btnPreview.classList.toggle('active', previewOn);
  if (previewOn) {
    el.editStack.style.display = 'none';
    el.preview.classList.remove('hidden');
    refreshPreview();
  } else {
    el.preview.classList.add('hidden');
    el.editStack.style.display = '';
  }
}

/* =========================================================================
 * Settings UI
 * ========================================================================= */
function isSettingsOpen() {
  return !el.settingsPop.classList.contains('hidden');
}

function closeSettings() {
  el.settingsPop.classList.add('hidden');
  el.btnSettings.classList.remove('active');
}

function applySettingsToUi() {
  // segmented control
  el.segMode.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === settings.triggerMode);
  });
  el.segCollapse.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.collapse === settings.autoCollapse);
  });
  el.swKeepAwake.classList.toggle('on', !!settings.keepAwake);
  el.swScreen.classList.toggle('on', !!settings.screenAlwaysOn);
  el.btnPin.classList.toggle('active', !!settings.pinned);
  el.btnStartup.textContent = settings.launchAtLogin ? '开机自启 ✓' : '开机自启';

  // pill & hint visibility per mode
  const trayOnly = settings.triggerMode === 'tray';
  if (!expanded) {
    el.pill.style.display = trayOnly ? 'none' : '';
    if (trayOnly && !clickthroughActive) setClickThrough(true);
  }
}

el.segMode.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  const mode = btn.dataset.mode;
  window.notch.setTriggerMode(mode);
  settings.triggerMode = mode;
  applySettingsToUi();
});

el.segCollapse.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-collapse]');
  if (!btn) return;
  const mode = btn.dataset.collapse;
  window.notch.setAutoCollapse(mode);
  settings.autoCollapse = mode;
  applySettingsToUi();
  const labels = { mouseLeave: "鼠标移出时收起", none: "快捷收起已关闭" };
  showToast(labels[mode] || '已更新');
});

el.swKeepAwake.addEventListener('click', () => {
  settings.keepAwake = !settings.keepAwake;
  el.swKeepAwake.classList.toggle('on', settings.keepAwake);
  window.notch.setKeepAwake(settings.keepAwake);
});

el.swScreen.addEventListener('click', () => {
  settings.screenAlwaysOn = !settings.screenAlwaysOn;
  el.swScreen.classList.toggle('on', settings.screenAlwaysOn);
  window.notch.setScreenAlwaysOn(settings.screenAlwaysOn);
});

el.btnOpenData.addEventListener('click', () => window.notch.openDataDir());

el.btnStartup.addEventListener('click', () => {
  const next = !settings.launchAtLogin;
  window.notch.setLaunchAtLogin(next);
  settings.launchAtLogin = next;
  el.btnStartup.textContent = next ? '开机自启 ✓' : '开机自启';
});

el.btnSettings.addEventListener('click', () => {
  if (isSettingsOpen()) closeSettings();
  else {
    el.settingsPop.classList.remove('hidden');
    el.btnSettings.classList.add('active');
  }
});

el.btnPreview.addEventListener('click', togglePreview);
el.btnPin.addEventListener('click', () => {
  const next = !settings.pinned;
  settings.pinned = next;
  el.btnPin.classList.toggle('active', next);
  window.notch.setPinned(next);
  if (next) {
    // A pinned panel holds no auto-collapse; stop pending timers.
    clearTimeout(hoverAwayTimer);
    showToast('已固定：面板将保持展开并置顶');
  } else {
    showToast('已取消固定');
  }
});
el.btnAddTab.addEventListener('click', () => notes.addTab());
el.btnRestore.addEventListener('click', () => notes.restoreLastDeleted());
el.btnCollapse.addEventListener('click', () => collapse());
el.shelfClear.addEventListener('click', () => shelf.clear());

/* =========================================================================
 * Toast
 * ========================================================================= */
let toastTimer = null;
function showToast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
}

/* =========================================================================
 * Boot
 * ========================================================================= */
window.notch.onSettingsUpdated((s) => {
  settings = { ...settings, ...s };
  applySettingsToUi();
});

window.notch.onExpandRequested(() => expand('tray'));
window.notch.onCollapseRequested(() => collapse());

window.addEventListener('beforeunload', () => notes.persistNow());

(async function boot() {
  settings = { ...settings, ...(await window.notch.getSettings()) };
  await notes.load();
  renderTabs();
  refreshEditorFromStore();
  await shelf.load();
  applySettingsToUi();
  if (settings.pinned) {
    expand('pinned');      // restore pinned panel: expanded & on top
  } else {
    setClickThrough(true);
  }
})();
