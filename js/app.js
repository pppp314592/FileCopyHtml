/* app.js — UI 配線（フォルダ枠 / 一覧 / 複数選択 / コピー実行 / ini 永続化） */
(function (global) {
  'use strict';

  var FCH = global.FCH;
  var Folder = FCH.Folder;
  var Copy = FCH.Copy;
  var IniFile = FCH.IniFile;
  var Storage = FCH.Storage;
  var util = FCH.util;

  var MIN_SOURCES = 3;
  var MAX_SOURCES = 12;
  var MAX_RENDER = 5000;
  var MAX_LOG_LINES = 600;

  var el = {};

  function $(id) { return document.getElementById(id); }

  var state = {
    dest: null,
    sources: [],
    entries: [],
    index: Object.create(null),
    visible: null,
    selection: new Set(),
    results: {},
    filter: '',
    onlyMissing: false,
    group: false,
    keepTree: true,
    overwrite: true,
    sortKey: 'name',
    sortDir: 1,
    iniHandle: null,
    busy: false,
    rows: Object.create(null)
  };

  /* ================================================================== *
   * ログ
   * ================================================================== */

  function log(level, message) {
    var line = document.createElement('div');
    line.className = 'log-line ' + (level || 'info');
    var now = new Date();
    var p = function (v) { return v < 10 ? '0' + v : String(v); };
    var stamp = p(now.getHours()) + ':' + p(now.getMinutes()) + ':' + p(now.getSeconds());
    line.textContent = '[' + stamp + '] ' + message;
    el.logBody.appendChild(line);
    while (el.logBody.childNodes.length > MAX_LOG_LINES) el.logBody.removeChild(el.logBody.firstChild);
    el.logBody.scrollTop = el.logBody.scrollHeight;
  }

  /* ================================================================== *
   * フォルダ枠（スロット）
   * ================================================================== */

  function newSlot(id, role) {
    return {
      id: id,
      role: role,
      path: '',
      label: '',
      handle: null,
      files: [],
      dirs: 0,
      bytes: 0,
      truncated: false,
      note: '',
      error: null,
      scanState: 'empty',
      row: null
    };
  }

  function allSlots() {
    var list = [];
    if (state.dest) list.push(state.dest);
    state.sources.forEach(function (s) { if (s) list.push(s); });
    return list;
  }

  function slotById(id) {
    if (state.dest && state.dest.id === id) return state.dest;
    for (var i = 0; i < state.sources.length; i += 1) {
      if (state.sources[i] && state.sources[i].id === id) return state.sources[i];
    }
    return null;
  }

  function slotIndex(slot) {
    for (var i = 0; i < state.sources.length; i += 1) {
      if (state.sources[i] === slot) return i + 1;
    }
    return 0;
  }

  function ensureSources(n) {
    while (state.sources.length < n && state.sources.length < MAX_SOURCES) {
      state.sources.push(newSlot('src' + (state.sources.length + 1), 'source'));
    }
  }

  function slotTitle(slot) {
    if (slot.role === 'dest') return 'コピー先（目標フォルダ）';
    return 'ソース ' + slotIndex(slot);
  }

  function buildSlotRow(slot) {
    var row = document.createElement('div');
    row.className = 'slot-row' + (slot.role === 'dest' ? ' role-dest' : '');
    row.dataset.slot = slot.id;

    var idx = document.createElement('span');
    idx.className = 'slot-index';
    idx.textContent = slot.role === 'dest' ? 'DEST' : 'S' + slotIndex(slot);

    var name = document.createElement('span');
    name.className = 'slot-name';

    var path = document.createElement('input');
    path.type = 'text';
    path.className = 'slot-path';
    path.placeholder = 'ini に記録するパス（例: \\\\server\\share\\data）';
    path.spellcheck = false;

    var stat = document.createElement('span');
    stat.className = 'slot-stat';

    var actions = document.createElement('span');
    actions.className = 'slot-actions';

var pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'btn btn-sm';
    pick.textContent = '選択…';
    pick.addEventListener('click', function () { pickFolder(slot); });

    var clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'btn btn-sm';
    clear.textContent = slot.role === 'dest' ? '解除' : '削除';
    clear.addEventListener('click', function () { clearSlot(slot); });

    actions.appendChild(pick);
    actions.appendChild(clear);

    row.appendChild(idx);
    row.appendChild(name);
    row.appendChild(path);
    row.appendChild(stat);
    row.appendChild(actions);

path.addEventListener('change', function () {
      slot.path = path.value.trim();
      if (slot.pathDraft) {
        /* 手動で区切りを含むパスに修正したら確定扱いにする */
        slot.pathDraft = !/[\\/]/.test(slot.path);
        if (!slot.pathDraft) slot.pathNote = '';
      }
      renderSlotRow(slot);
      persist();
      writeIniQuiet();
    });

slot.row = row;
    slot.els = { idx: idx, name: name, path: path, stat: stat, pick: pick, clear: clear };
    return row;
  }

  function renderSlotRow(slot) {
    if (!slot.row) return;
    var e = slot.els;
    var hasHandle = !!slot.handle;

    e.idx.textContent = slot.role === 'dest' ? 'DEST' : 'S' + slotIndex(slot);
    e.name.textContent = hasHandle ? (slot.label || '(名前不明)') : '未設定';
    e.name.className = 'slot-name' + (hasHandle ? '' : ' is-empty');
    e.name.title = hasHandle ? slotTitle(slot) + ' / ' + (slot.label || '') : '未設定';
if (document.activeElement !== e.path) e.path.value = slot.path || '';
    e.path.classList.toggle('is-draft', !!slot.pathDraft);
    e.path.title = slot.pathDraft
      ? 'フォルダ選択の結果を反映したパスです。実際の場所是否符合確認してください。'
      : 'ini に記録するパス（例: \\\\サーバー\\共有\\data）';

    e.pick.disabled = state.busy;

    var statText = '';
    if (slot.error) {
      statText = 'エラー';
    } else if (hasHandle) {
      if (slot.scanState === 'scanning') {
        statText = '走査中…';
      } else if (slot.scanState === 'scanned') {
        statText = util.formatBytes(slot.bytes) + ' / ' + slot.files.length + ' 件' + (slot.dirs > 0 ? ' / ' + slot.dirs + ' フォルダ' : '');
        if (slot.truncated) statText += '（上限到達）';
      } else {
        statText = '未走査';
      }
    }
e.stat.textContent = statText;
    e.stat.title = [slot.pathNote, slot.note].filter(Boolean).join(' / ');

    slot.row.classList.toggle('is-empty', !hasHandle);
    slot.row.classList.toggle('is-error', !!slot.error);
  }

function renderSlotRows() {
    if (state.dest) {
      if (!state.dest.row) {
        el.destSlot.textContent = '';
        el.destSlot.appendChild(buildSlotRow(state.dest));
      }
      renderSlotRow(state.dest);
    }

    /* ソース枠は増減した時だけ作り直す（入力欄のフォーカスやスクロールを保つ） */
    var sig = state.sources.map(function (s) { return s.id; }).join(',');
    if (el.srcSlots.dataset.sig !== sig) {
      el.srcSlots.textContent = '';
      state.sources.forEach(function (slot) { el.srcSlots.appendChild(buildSlotRow(slot)); });
      el.srcSlots.dataset.sig = sig;
    }
    state.sources.forEach(function (slot) { renderSlotRow(slot); });
    updateControls();
  }

  /* フォルダ選択結果をパス欄へ反映する。
     File System Access API ではフルパスを取得できないため、
     空ならフォルダ名で初期化し、末尾が違えば末尾（フォルダ名）を差し替える。 */
  function reflectPath(slot, folderName) {
    var name = String(folderName || '').trim();
    if (!name) return 'none';

    var cur = String(slot.path || '').trim().replace(/[\\/]+$/, '');
    if (!cur) {
      slot.path = name;
      slot.pathDraft = true;
      slot.pathNote = 'パスはフォルダ名のみで自動入力されました。実際の場所（例: \\\\サーバー\\共有\\' + name + '）を入力してください。';
      return 'init';
    }

    var tail = cur.split(/[\\/]/).pop();
    if (tail && tail.toLowerCase() === name.toLowerCase()) {
      slot.pathDraft = false;
      slot.pathNote = '';
      return 'same';
    }

    slot.path = /[\\/]/.test(cur) ? cur.replace(/[\\/][^\\/]*$/, '') + '\\' + name : name;
    slot.pathDraft = true;
    slot.pathNote = 'パス欄の末尾を「' + name + '」に更新しました。実際の場所かどうかを確認してください。';
    return 'replaced';
  }

  function pickFolder(slot) {
    if (state.busy) return;
    var hint = null;
    if (slot.handle) hint = slot.handle;
    else if (slot.path) hint = slot.path;

    Folder.pick(hint).then(
      function (handle) {
        slot.handle = handle;
        slot.label = handle.name || '';
        slot.error = null;
        slot.scanState = 'idle';

        var mode = reflectPath(slot, slot.label);
        log('ok', slotTitle(slot) + ' を設定: ' + (slot.label || '(名前不明)') + (slot.path ? ' / ' + slot.path : ''));
        if (mode !== 'same') log('warn', slot.pathNote);

        renderSlotRows();
        persist();
        writeIniQuiet();
        return rescanSlot(slot);
      },
      function (err) {
        if (err && err.name === 'AbortError') return;
        log('err', slotTitle(slot) + ' の選択に失敗: ' + (err && err.message ? err.message : err));
      }
    );
  }

  function clearSlot(slot) {
    if (slot.role === 'source') {
      state.sources = state.sources.filter(function (s) { return s !== slot; });
      ensureSources(MIN_SOURCES);
      rebuildEntries();
      renderSlotRows();
      renderTable();
      persist();
      writeIniQuiet();
      return;
    }
    slot.handle = null;
    slot.label = '';
    slot.files = [];
    slot.bytes = 0;
    slot.dirs = 0;
    slot.note = '';
    slot.error = null;
    slot.scanState = 'empty';
    rebuildEntries();
    renderSlotRows();
    renderTable();
    persist();
    writeIniQuiet();
  }

  function rescanSlot(slot) {
    if (!slot.handle || state.busy) return Promise.resolve();
    slot.scanState = 'scanning';
    slot.error = null;
    renderSlotRow(slot);

    return Folder.ensurePermission(slot.handle, true, slot.role === 'dest' ? 'readwrite' : 'read').then(function (perm) {
      if (perm !== 'granted') throw new Error('アクセス権限が拒否されました');
      return Folder.list(slot.handle);
    }).then(function (res) {
      slot.files = res.files;
      slot.dirs = res.dirs;
      slot.bytes = res.totalBytes;
      slot.truncated = res.truncated;
      slot.scanState = 'scanned';
      var notes = [];
      if (res.truncated) notes.push('ファイル数上限(' + res.files.length + '件)のため途中まで表示');
      if (res.errors.length) notes.push('未走査フォルダ ' + res.errors.length + ' 件');
      slot.note = notes.join(' / ');
      log('ok', slotTitle(slot) + ' を走査: ' + res.files.length + ' 件 / ' + util.formatBytes(res.totalBytes) + (slot.note ? '（' + slot.note + '）' : ''));
      if (res.errors.length) res.errors.slice(0, 5).forEach(function (m) { log('warn', '  ' + m); });
    }).catch(function (err) {
      slot.scanState = 'error';
      slot.error = (err && err.message) || String(err);
      slot.note = slot.error;
      log('err', slotTitle(slot) + ' の走査に失敗: ' + slot.error);
    }).then(function () {
      rebuildEntries();
      renderSlotRows();
      renderTable();
      persist();
    });
  }

/* 全フォルダ一括での再走査（フォルダ枠ごとの個別ボタンは設けない） */
  function rescanAll() {
    if (state.busy) return;
    var targets = allSlots().filter(function (s) { return !!s.handle; });
    if (!targets.length) {
      log('warn', '走査対象のフォルダが設定されていません');
      return;
    }
    var chain = Promise.resolve();
    targets.forEach(function (slot) { chain = chain.then(function () { return rescanSlot(slot); }); });
    chain.then(function () {
      var n = targets.length;
      log('ok', '全フォルダの再スキャンを完了しました（' + n + ' フォルダ）');
    });
  }

  /* ================================================================== *
   * 一覧
   * ================================================================== */

  function rebuildEntries() {
    var entries = [];
    var destPaths = Object.create(null);

    if (state.dest) {
      state.dest.files.forEach(function (f) {
        destPaths[f.path.toLowerCase()] = true;
      });
    }

    allSlots().forEach(function (slot) {
      slot.files.forEach(function (f) {
        var isDest = slot.role === 'dest';
        entries.push({
          key: slot.id + '|' + f.path,
slotId: slot.id,
          slotLabel: slot.role === 'dest' ? 'D' : 'S' + slotIndex(slot),
          slotTitleText: slotTitle(slot),
          slotName: slot.label || '',
          role: slot.role,
          path: f.path,
          name: f.name,
          dir: f.dir,
          size: f.size,
          lastModified: f.lastModified,
          existsInDest: !!destPaths[f.path.toLowerCase()],
          error: f.error || null
        });
      });
    });

    state.entries = entries;
    state.index = Object.create(null);
    entries.forEach(function (e) { state.index[e.key] = e; });
    state.visible = null;
    pruneSelection();
  }

  function pruneSelection() {
    var next = new Set();
    state.selection.forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(state.index, k)) next.add(k);
    });
    state.selection = next;
  }

  function invalidateVisible() {
    state.visible = null;
  }

  function computeVisible() {
    var filter = state.filter.toLowerCase();
    var list = state.entries.filter(function (e) {
      if (state.onlyMissing) {
        if (e.role !== 'source') return false;
        if (e.existsInDest) return false;
      }
if (!filter) return true;
      return (e.path + ' ' + e.slotName + ' ' + e.slotTitleText + ' ' + e.slotLabel).toLowerCase().indexOf(filter) >= 0;
    });

var dir = state.sortDir;
    var key = state.sortKey;
    var rank = { dest: 0, source: 1 };

    list.sort(function (a, b) {
      /* グループ表示のときはフォルダ単位に固めてから列のキーで並べ替える */
      if (state.group) {
        var ga = rank[a.role], gb = rank[b.role];
        if (ga !== gb) return ga - gb;
        if (a.slotId !== b.slotId) return a.slotId < b.slotId ? -1 : 1;
      }
      if (key === 'size') {
        if (a.size !== b.size) return (a.size - b.size) * dir;
      } else if (key === 'date') {
        if (a.lastModified !== b.lastModified) return (a.lastModified - b.lastModified) * dir;
      } else {
        if (!state.group) {
          var ra = rank[a.role], rb = rank[b.role];
          if (ra !== rb) return ra - rb;
        }
        var c = a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
        if (c !== 0) return c * dir;
        return a.slotId < b.slotId ? -1 : 1;
      }
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    return list;
  }

  function visibleEntries() {
    if (!state.visible) state.visible = computeVisible();
    return state.visible;
  }

function resultClass(res) {
    if (res === 'copying') return ' is-copying';
    if (res === 'copied') return ' is-done';
    if (res === 'skipped') return ' is-skipped';
    if (res === 'error') return ' is-failed';
    return '';
  }

  /* コピー先のファイルは参照のみ（コピーの対象にならないため選択不可） */
  function isSelectable(e) {
    return !!e && e.role === 'source';
  }

  function stateTagHtml(e) {
    if (e.role === 'dest') return '<span class="tag dest">コピー先</span>';
    if (e.error) return '<span class="tag err">読取不可</span>';
    if (e.existsInDest) return '<span class="tag overwrite">上書き</span>';
    return '<span class="tag new">新規</span>';
  }

  function nameHtml(e) {
    if (!e.dir) return util.escapeHtml(e.name);
    var idx = e.path.lastIndexOf('/');
    return '<span class="dir">' + util.escapeHtml(e.path.slice(0, idx + 1)) + '</span>' + util.escapeHtml(e.name);
  }

  function resultText(res) {
    if (res === 'copied') return 'コピー済';
    if (res === 'skipped') return '既存';
    if (res === 'error') return '失敗';
    if (res === 'copying') return 'コピー中…';
    return '';
  }

function buildRow(e) {
    var tr = document.createElement('tr');
    var res = state.results[e.key];
    var selectable = isSelectable(e);
    tr.dataset.key = e.key;
    tr.className = (selectable && state.selection.has(e.key) ? 'is-selected' : '') + (selectable ? '' : ' is-fixed') + resultClass(res);
    tr.innerHTML =
      '<td class="col-check"><input type="checkbox" class="row-check"' + (selectable && state.selection.has(e.key) ? ' checked' : '') +
        (selectable ? '' : ' disabled title="コピー先は参照のみのため選択できません"') + '></td>' +
      '<td class="col-slot" title="' + util.escapeHtml(e.slotTitleText + ' / ' + (slotById(e.slotId) ? slotById(e.slotId).label : '')) + '">' +
        '<span class="tag ' + (e.role === 'dest' ? 'dest' : 'src') + '">' + e.slotLabel + '</span></td>' +
      '<td class="col-name" title="' + util.escapeHtml(e.path) + '">' + nameHtml(e) + '</td>' +
      '<td class="col-size">' + util.escapeHtml(util.formatBytes(e.size)) + '</td>' +
      '<td class="col-date">' + util.escapeHtml(util.formatDate(e.lastModified)) + '</td>' +
      '<td class="col-state">' + stateTagHtml(e) + '</td>' +
      '<td class="col-result">' + util.escapeHtml(resultText(res)) + '</td>';
    return tr;
  }

  function buildGroupRow(e) {
    var tr = document.createElement('tr');
    tr.className = 'group-row';
    var slot = slotById(e.slotId);
    var name = (slot && slot.label) || e.slotLabel;
    var bytes = slot ? slot.bytes : 0;
    tr.innerHTML = '<td class="col-check"></td><td colspan="6">' +
      util.escapeHtml(e.slotTitleText + '：' + name + '　' + util.formatBytes(bytes)) + '</td>';
    return tr;
  }

  function renderTable() {
    invalidateVisible();
    var rows = visibleEntries();
    var frag = document.createDocumentFragment();
    state.rows = Object.create(null);
    var curSlot = null;
    var cap = Math.min(rows.length, MAX_RENDER);

    for (var i = 0; i < cap; i += 1) {
      var e = rows[i];
      if (state.group && e.slotId !== curSlot) {
        curSlot = e.slotId;
        frag.appendChild(buildGroupRow(e));
      }
      var tr = buildRow(e);
      state.rows[e.key] = tr;
      frag.appendChild(tr);
    }

    if (rows.length > cap) {
      var note = document.createElement('tr');
      note.innerHTML = '<td colspan="7" class="col-name muted small">表示は先頭 ' + cap + ' 件までです。フィルタで絞り込んでください（全 ' + rows.length + ' 件）。</td>';
      frag.appendChild(note);
    }

    el.fileBody.textContent = '';
    el.fileBody.appendChild(frag);

    el.listEmpty.hidden = rows.length > 0;
    if (!rows.length) {
      el.listEmpty.textContent = state.entries.length
        ? 'フィルタ条件に一致するファイルがありません。'
        : 'フォルダが未設定です。上の「選択…」からフォルダを指定してください。';
    }

    updateHeaderCheck();
    renderSummary();
    updateControls();
  }

  function renderSummary() {
    var total = state.entries.length;
    var destCount = state.dest ? state.dest.files.length : 0;
    var srcCount = total - destCount;
    var parts = ['全 ' + total + ' 件（コピー先 ' + destCount + ' / コピー元 ' + srcCount + '）'];
    if (state.dest && state.dest.truncated) parts.push('コピー先は上限到達');
    el.listSummary.textContent = parts.join('　');

var selCount = 0, selBytes = 0;
    state.selection.forEach(function (key) {
      var e = state.index[key];
      if (!e) return;
      selCount += 1;
      selBytes += e.size || 0;
    });
    el.selSummary.textContent = selCount
      ? '選択 ' + selCount + ' 件 / ' + util.formatBytes(selBytes) + '（すべてコピー対象）'
      : '未選択（コピー元のファイルを選択してください）';
  }

  function entryByKey(key) {
    return state.index[key] || null;
  }

function updateHeaderCheck() {
    var rows = visibleEntries().filter(isSelectable);
    var checked = 0;
    rows.forEach(function (e) { if (state.selection.has(e.key)) checked += 1; });
    el.checkAll.checked = rows.length > 0 && checked === rows.length;
    el.checkAll.indeterminate = checked > 0 && checked < rows.length;
    el.checkAll.disabled = rows.length === 0;
  }

  function updateControls() {
    var srcSelected = countSelectedSources();
    el.btnCopy.disabled = state.busy || !state.dest || !state.dest.handle || srcSelected === 0;
    el.btnCopy.textContent = srcSelected ? 'コピー実行（' + srcSelected + ' 件）' : 'コピー実行';
    el.btnCancel.hidden = !state.busy;
    el.btnCopy.classList.toggle('busy', state.busy);
    if (state.busy) el.btnCopy.disabled = true;
    el.btnIniSave.disabled = state.busy;
    el.btnIniLoad.disabled = state.busy;
  }

  function countSelectedSources() {
    var n = 0;
    state.selection.forEach(function (key) {
      var e = state.index[key];
      if (e && e.role === 'source') n += 1;
    });
    return n;
  }

  function setProgress(ratio, text) {
    var pct = Math.max(0, Math.min(100, ratio * 100));
    el.progressBar.style.width = pct.toFixed(1) + '%';
    el.progressText.textContent = text;
  }

  /* ---------- 選択操作 ---------- */

function toggleCheck(key, checked) {
    var e = state.index[key];
    if (!isSelectable(e)) return;
    if (checked) state.selection.add(key);
    else state.selection.delete(key);
    invalidateVisible();
    var tr = state.rows[key];
    if (tr) {
      tr.classList.toggle('is-selected', checked);
      var box = tr.querySelector('.row-check');
      if (box) box.checked = checked;
    }
  }

  /* 一括選択（コピー元の行のみ対象。コピー先は参照のみなので触らない） */
  function bulkSelect(selector) {
    invalidateVisible();
    visibleEntries().forEach(function (e) {
      if (!isSelectable(e)) return;
      var want = selector(e);
      if (want) state.selection.add(e.key);
      else state.selection.delete(e.key);
      var tr = state.rows[e.key];
      if (tr) {
        tr.classList.toggle('is-selected', want);
        var box = tr.querySelector('.row-check');
        if (box) box.checked = want;
      }
    });
    updateHeaderCheck();
    renderSummary();
    updateControls();
  }

  /* ================================================================== *
   * コピー実行
   * ================================================================== */

  function buildJobs() {
    var jobs = [];
    var seen = Object.create(null);
    state.selection.forEach(function (key) {
      var e = state.index[key];
      if (!e || e.role !== 'source') return;
      var slot = slotById(e.slotId);
      if (!slot || !slot.handle) return;
      var destRel = state.keepTree ? e.path : e.name;
      var lower = destRel.toLowerCase();
      if (seen[lower]) {
        log('warn', '同一コピー先パスが重複しています（後勝ち）: ' + destRel);
      }
      seen[lower] = true;
      jobs.push({
        key: e.key,
        srcRoot: slot.handle,
        srcPath: e.path,
        destRelPath: destRel,
        size: e.size,
        slotLabel: e.slotLabel
      });
    });
    return jobs;
  }

  function setRowProgress(job, cls, text) {
    var tr = state.rows[job.key];
    if (!tr) return;
    tr.className = tr.className.replace(/\s*is-(copying|done|skipped|failed)/g, '') + cls;
    var cell = tr.querySelector('.col-result');
    if (cell && text != null) cell.textContent = text;
  }

function runCopy() {
    if (state.busy) return;
    if (!state.dest || !state.dest.handle) {
      log('err', 'コピー先（目標フォルダ）が設定されていません');
      return;
    }

    var jobs = buildJobs();
    if (!jobs.length) {
      log('warn', 'コピー元ファイルが選択されていません');
      return;
    }

    state.results = Object.create(null);
    state.busy = true;
    updateControls();

    var controller = ('AbortController' in global) ? new AbortController() : null;
    el.cancelHandler = controller ? function () { controller.abort(); } : null;

    var totalBytes = jobs.reduce(function (s, j) { return s + (j.size || 0); }, 0);
    log('info', '=== コピー開始：' + jobs.length + ' 件 / ' + util.formatBytes(totalBytes) +
      '（上書き: ' + (state.overwrite ? 'する' : 'しない') + ' / 構成: ' + (state.keepTree ? '保持' : 'フラット') + '）===');

    Folder.ensurePermission(state.dest.handle, true, 'readwrite').then(function (perm) {
      if (perm !== 'granted') throw new Error('コピー先への書き込み権限が拒否されました');
      setProgress(0, '準備中…');
      return Copy.run(jobs, {
        destRoot: state.dest.handle,
        overwrite: state.overwrite,
        signal: controller ? controller.signal : undefined,
        onProgress: function (p) {
          var ratio = p.totalBytes ? p.doneBytes / p.totalBytes : 0;
          setProgress(ratio, 'コピー中 ' + util.formatBytes(p.doneBytes) + ' / ' + util.formatBytes(p.totalBytes) +
            '　成功 ' + p.copied + ' / スキップ ' + p.skipped + ' / 失敗 ' + p.failed);
        },
        onFileStart: function (job) {
          state.results[job.key] = 'copying';
          setRowProgress(job, ' is-copying', 'コピー中…');
        },
        onFileDone: function (job, result) {
          state.results[job.key] = result;
          if (result === 'copied') setRowProgress(job, ' is-done', 'コピー済');
          else if (result === 'skipped') setRowProgress(job, ' is-skipped', '既存');
          else setRowProgress(job, ' is-failed', '失敗');
        }
      });
    }).then(function (res) {
      setProgress(1, '完了：成功 ' + res.copied + ' / スキップ ' + res.skipped + ' / 失敗 ' + res.failed);
      log(res.failed ? 'warn' : 'ok', '=== コピー終了：成功 ' + res.copied + ' 件 / ' + util.formatBytes(res.bytes) +
        '、スキップ ' + res.skipped + ' 件、失敗 ' + res.failed + ' 件 ===');
    }).catch(function (err) {
      setProgress(0, 'エラー');
      log('err', 'コピーを中断しました: ' + ((err && err.message) || err));
    }).then(function () {
      state.busy = false;
      el.cancelHandler = null;
      updateControls();
      if (state.dest) {
        return rescanSlot(state.dest).then(function () { renderSummary(); });
      }
    });
  }

  /* ================================================================== *
   * 永続化 / ini
   * ================================================================== */

  function persist() {
    var payload = {
      slots: [state.dest].concat(state.sources).filter(Boolean).map(function (s) {
        return { id: s.id, role: s.role, path: s.path, label: s.label, handle: s.handle };
      }),
      iniHandle: state.iniHandle,
      ui: { keepTree: state.keepTree, overwrite: state.overwrite, group: state.group, sortKey: state.sortKey, sortDir: state.sortDir }
    };
    return Storage.save(payload).then(function (info) {
      if (info.error) log('warn', 'フォルダハンドルの保存に失敗（localStorage にのみ保存）: ' + info.error.message);
      return info;
    }).catch(function (err) {
      log('warn', '設定の保存に失敗: ' + ((err && err.message) || err));
    });
  }

  function buildIniText() {
    return IniFile.build({
      dest: state.dest,
      sources: state.sources,
      keepTree: state.keepTree,
      overwrite: state.overwrite
    });
  }

  function writeIniQuiet() {
    var text = buildIniText();
    Storage.saveIniText(text);
    if (!state.iniHandle) return;
    IniFile.write(state.iniHandle, text).catch(function (err) {
      log('warn', 'ini の保存に失敗: ' + ((err && err.message) || err));
    });
  }

  function saveIniNow(quiet) {
    var text = buildIniText();
    Storage.saveIniText(text);
    if (!state.iniHandle) {
      if (!quiet) log('warn', 'config.ini が未選択です。右上の「config.ini を選択…」で設定するか、「ini 編集…」からダウンロードしてください。');
      return Promise.resolve(false);
    }
    return IniFile.write(state.iniHandle, text).then(function () {
      if (!quiet) log('ok', 'ini に保存しました（' + state.iniHandle.name + '）');
      return true;
    }).catch(function (err) {
      if (!quiet) log('err', 'ini の保存に失敗: ' + ((err && err.message) || err));
      return false;
    });
  }

  function readIniText() {
    if (state.iniHandle) {
      return IniFile.read(state.iniHandle).then(
        function (text) { return text == null ? null : text; },
        function (err) {
          log('warn', 'ini の読み込みに失敗: ' + ((err && err.message) || err));
          return Storage.loadIniText();
        }
      );
    }
    return Promise.resolve(Storage.loadIniText());
  }

  /* ini の内容を状態に適用（パス文字列の復元）
   戻り値: { slotId: ini に書かれていたパス } （ハンドル未設定のものだけ） */
  function applyIniText(text) {
    var parsed = { destPath: '', sourcePaths: [], keepTree: true, overwrite: true };
    IniFile.apply(text, parsed);

    var count = 0;
    parsed.sourcePaths.forEach(function (p) { if (p) count += 1; });
    ensureSources(Math.max(MIN_SOURCES, Math.min(MAX_SOURCES, count)));

    var pending = Object.create(null);
    if (parsed.destPath) {
      state.dest.path = parsed.destPath;
      if (!state.dest.handle) state.dest.scanState = 'empty';
      pending[state.dest.id] = parsed.destPath;
    }
    parsed.sourcePaths.slice(0, state.sources.length).forEach(function (p, i) {
      state.sources[i].path = p || '';
      if (p && !state.sources[i].handle) pending[state.sources[i].id] = p;
    });

    state.keepTree = parsed.keepTree;
    state.overwrite = parsed.overwrite;
    el.optKeepTree.checked = parsed.keepTree;
    el.optOverwrite.checked = parsed.overwrite;

    var names = Object.keys(pending).map(function (id) {
      var slot = slotById(id);
      return (slot ? slotTitle(slot) : id) + ': ' + pending[id];
    });
    if (names.length) {
      log('info', 'ini から設定を読み込みました（フォルダの再選択が必要）: ' + names.join(' / '));
    } else {
      log('ok', 'ini の設定を適用しました');
    }
    return pending;
  }

  /* 保存済みハンドルと ini のパスが食い違っていないか確認 */
  function reconcileSlots(iniPaths) {
    allSlots().forEach(function (slot) {
      if (!slot.handle) return;
var want = iniPaths[slot.id] || '';
      if (want && slot.path && want.toLowerCase() !== slot.path.toLowerCase()) {
        slot.pathNote = 'ini のパスと選択フォルダが一致しません（記録: ' + slot.path + '）';
        log('warn', slotTitle(slot) + '：ini のパスと選択済みフォルダが一致しません。ini=' + want + ' / 選択=' + slot.path);
      } else if (want && !slot.path) {
        slot.path = want;
      }
    });
  }

  function downloadText(filename, text) {
    var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ================================================================== *
   * 起動処理
   * ================================================================== */

  function cacheEls() {
    [
      'fsStatus', 'btnIniBind', 'btnIniLoad', 'btnIniSave', 'btnIniEdit',
      'destSlot', 'srcSlots', 'btnAddSource', 'btnRescanAll', 'btnRestore',
      'filterText', 'optOnlyMissing', 'optGroup',
      'btnSelectAll', 'btnSelectNone', 'btnSelectInvert',
      'fileBody', 'fileTable', 'tableWrap', 'listEmpty', 'listSummary', 'selSummary', 'checkAll',
      'logBody', 'btnClearLog', 'optKeepTree', 'optOverwrite',
      'progressBar', 'progressText', 'btnCopy', 'btnCancel',
      'modal', 'iniText', 'btnModalClose', 'btnIniApply', 'btnIniConfirm', 'btnIniDownload'
    ].forEach(function (id) { el[id] = $(id); });
  }

  function bindEvents() {
    el.btnAddSource.addEventListener('click', function () {
      if (state.sources.length >= MAX_SOURCES) {
        log('warn', 'ソースフォルダは最大 ' + MAX_SOURCES + ' 個までです');
        return;
      }
      state.sources.push(newSlot('src' + (state.sources.length + 1), 'source'));
      renderSlotRows();
      persist();
      writeIniQuiet();
      log('info', 'ソースフォルダを追加しました。画面内の「選択…」からフォルダを指定してください。');
    });

    el.btnRescanAll.addEventListener('click', rescanAll);

    el.btnRestore.addEventListener('click', function () {
      var targets = allSlots().filter(function (s) { return !!s.handle; });
      var chain = Promise.resolve();
      targets.forEach(function (slot) { chain = chain.then(function () { return rescanSlot(slot); }); });
      chain.then(function () { log('ok', 'フォルダへのアクセスを再取得しました'); });
    });

    el.filterText.addEventListener('input', function () {
      state.filter = el.filterText.value.trim();
      renderTable();
    });

    el.optOnlyMissing.addEventListener('change', function () {
      state.onlyMissing = el.optOnlyMissing.checked;
      renderTable();
    });

    el.optGroup.addEventListener('change', function () {
      state.group = el.optGroup.checked;
      renderTable();
      persist();
    });

    el.btnSelectAll.addEventListener('click', function () { bulkSelect(function () { return true; }); });
    el.btnSelectNone.addEventListener('click', function () { bulkSelect(function () { return false; }); });
el.btnSelectInvert.addEventListener('click', function () { bulkSelect(function (e) { return !state.selection.has(e.key); }); });

    el.checkAll.addEventListener('change', function () {
      var want = el.checkAll.checked;
      bulkSelect(function () { return want; });
    });

    el.fileBody.addEventListener('change', function (ev) {
      var box = ev.target;
      if (!box || !box.classList || !box.classList.contains('row-check')) return;
      var tr = box.closest('tr');
      if (!tr) return;
      var key = tr.dataset.key;
      toggleCheck(key, box.checked);
      updateHeaderCheck();
      renderSummary();
      updateControls();
    });

el.fileBody.addEventListener('click', function (ev) {
      if (ev.target && ev.target.classList && ev.target.classList.contains('row-check')) return;
      var tr = ev.target.closest ? ev.target.closest('tr') : null;
      if (!tr || !tr.dataset.key) return;
      var e = state.index[tr.dataset.key];
      if (!isSelectable(e)) return;
      var box = tr.querySelector('.row-check');
      toggleCheck(tr.dataset.key, !box.checked);
      updateHeaderCheck();
      renderSummary();
      updateControls();
    });

    Array.prototype.forEach.call(document.querySelectorAll('thead th.sortable'), function (th) {
      th.addEventListener('click', function () {
        var key = th.dataset.sort;
        if (state.sortKey === key) state.sortDir = -state.sortDir;
        else { state.sortKey = key; state.sortDir = 1; }
        renderTable();
        persist();
      });
    });

    el.optKeepTree.addEventListener('change', function () {
      state.keepTree = el.optKeepTree.checked;
      persist();
      writeIniQuiet();
    });
    el.optOverwrite.addEventListener('change', function () {
      state.overwrite = el.optOverwrite.checked;
      persist();
      writeIniQuiet();
    });

    el.btnCopy.addEventListener('click', runCopy);
    el.btnCancel.addEventListener('click', function () {
      if (el.cancelHandler) el.cancelHandler();
    });
    el.btnClearLog.addEventListener('click', function () { el.logBody.textContent = ''; });

    el.btnIniBind.addEventListener('click', function () {
      if (!IniFile.supported()) {
        log('warn', 'このブラウザはファイル保存ダイアログに対応していません（Chrome / Edge 推奨）。ini 編集 → ダウンロードをご利用ください。');
        return;
      }
      IniFile.pick(state.iniHandle || undefined).then(function (handle) {
        state.iniHandle = handle;
        log('ok', 'ini ファイルを設定しました: ' + handle.name);
        return IniFile.read(handle).then(function (text) {
          if (text) {
            var pending = applyIniText(text);
            reconcileSlots(pending);
          }
          renderSlotRows();
          return persist();
        }).then(function () {
          return saveIniNow(true);
        });
      }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        log('err', 'ini ファイルの選択に失敗: ' + ((err && err.message) || err));
      });
    });

    el.btnIniLoad.addEventListener('click', function () {
      readIniText().then(function (text) {
        if (!text) {
          log('warn', 'ini が未選択です（設定: ' + (state.iniHandle ? state.iniHandle.name : 'なし') + '）');
          return;
        }
        var pending = applyIniText(text);
        reconcileSlots(pending);
        renderSlotRows();
        persist();
        log('ok', 'ini を読み込みました');
      });
    });

    el.btnIniSave.addEventListener('click', function () {
      persist();
      saveIniNow(false).then(function () { writeIniQuiet(); });
    });

    el.btnIniEdit.addEventListener('click', function () {
      readIniText().then(function (text) {
        /* ini が空 / 未作成なら現在の設定から生成した内容を表示する */
        el.iniText.value = text && text.trim() ? text : buildIniText();
        el.modal.hidden = false;
      });
    });
    el.btnModalClose.addEventListener('click', function () { el.modal.hidden = true; });
    el.modal.addEventListener('click', function (ev) { if (ev.target === el.modal) el.modal.hidden = true; });
    el.btnIniApply.addEventListener('click', function () {
      var pending = applyIniText(el.iniText.value);
      reconcileSlots(pending);
      renderSlotRows();
      persist();
      el.modal.hidden = true;
    });
    el.btnIniConfirm.addEventListener('click', function () {
      var pending = applyIniText(el.iniText.value);
      reconcileSlots(pending);
      renderSlotRows();
      el.iniText.value = buildIniText();
      persist();
      saveIniNow(false);
      el.modal.hidden = true;
    });
    el.btnIniDownload.addEventListener('click', function () {
      downloadText(IniFile.NAME, el.iniText.value);
      log('ok', IniFile.NAME + ' をダウンロードしました');
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !el.modal.hidden) el.modal.hidden = true;
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        if (!el.btnCopy.disabled) runCopy();
      }
    });
  }

function setFsBadge(kind, text) {
    el.fsStatus.className = ('badge ' + (kind || '')).trim();
    el.fsStatus.textContent = text;
  }

function startup() {
    cacheEls();

    var handlePersistable = true;
    state.dest = newSlot('dest', 'dest');
    ensureSources(MIN_SOURCES);

var supported = Folder.supported();
    setFsBadge('', supported ? 'フォルダ API: 対応' : 'フォルダ API: 非対応（Chrome / Edge 86 以降が必要）');
    log('info', 'FileCopyHtml を起動しました');

    el.optKeepTree.checked = state.keepTree;
    el.optOverwrite.checked = state.overwrite;

    bindEvents();
    renderSlotRows();
    renderTable();

Storage.probe().then(function (p) {
      if (!p.ok) {
        handlePersistable = false;
        log('warn', 'フォルダ選択結果を保持できません（' + p.reason + '）。フォルダは毎回「選択…」から選び直す必要があります（設定の復元は config.ini のパスから行います）。');
      }
      return Storage.load();
    }).then(function (rec) {
      var iniBound = false;
      if (!rec || !rec.slots) return null;
      var pendingPaths = Object.create(null);
      rec.slots.forEach(function (s) {
        var slot = slotById(s.id);
        if (!slot) return;
        slot.path = s.path || '';
        slot.label = s.label || '';
        slot.handle = s.handle || null;
        if (slot.handle) slot.scanState = 'idle';
        if (s.id === 'dest') pendingPaths.dest = slot.path;
        else pendingPaths[s.id] = slot.path;
      });
state.iniHandle = rec.iniHandle || null;
      iniBound = !!rec.iniBound;
      var ui = rec.ui || {};
      if (typeof ui.keepTree === 'boolean') { state.keepTree = ui.keepTree; el.optKeepTree.checked = ui.keepTree; }
      if (typeof ui.overwrite === 'boolean') { state.overwrite = ui.overwrite; el.optOverwrite.checked = ui.overwrite; }
      if (typeof ui.group === 'boolean') { state.group = ui.group; el.optGroup.checked = ui.group; }
      if (ui.sortKey) state.sortKey = ui.sortKey;
      if (ui.sortDir) state.sortDir = ui.sortDir;
      return pendingPaths;
    }).then(function (pendingPaths) {
      if (!pendingPaths) return null;
return readIniText().then(function (text) {
        if (!text) {
          log('info', iniBound
            ? '保存済みの config.ini へアクセスできないため、ini は未設定として扱います。右上の「config.ini を選択…」で選び直してください。'
            : 'ini は未設定です（config.ini を選ぶと以降の変更が自動保存されます）');
          return null;
        }
        var pending = applyIniText(text);
        reconcileSlots(pending);
        log('ok', 'config.ini を自動読み込みしました' + (state.iniHandle ? '' : '（ブラウザ内保存分）'));
        return pendingPaths;
      });
    }).then(function () {
      var restorable = allSlots().filter(function (s) { return !!s.handle; });
      if (!restorable.length) {
        renderSlotRows();
        return;
      }
      var needPrompt = [];
      var chain = Promise.resolve();
      restorable.forEach(function (slot) {
        chain = chain.then(function () {
          return Folder.ensurePermission(slot.handle, false).then(function (perm) {
            if (perm === 'granted') return rescanSlot(slot);
            needPrompt.push(slotTitle(slot));
            slot.scanState = 'needs-permission';
            renderSlotRow(slot);
            return null;
          }).catch(function (err) {
            slot.error = (err && err.message) || String(err);
            slot.scanState = 'error';
            renderSlotRow(slot);
            return null;
          });
        });
      });
return chain.then(function () {
        renderSlotRows();
        if (needPrompt.length) {
          el.btnRestore.hidden = false;
          setFsBadge('warn', 'フォルダの許可が必要です: ' + needPrompt.join(' / '));
          log('warn', 'フォルダへのアクセス許可が必要です（' + needPrompt.join(' / ') + '）。「保存済みフォルダの権限を要求」をクリックしてください。');
        } else if (!handlePersistable) {
          setFsBadge('warn', 'フォルダ選択は保存されません（毎回選択してください）');
        }
      });
    }).catch(function (err) {
      log('err', '起動時の設定読み込みに失敗: ' + ((err && err.message) || err));
      renderSlotRows();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startup);
  } else {
    startup();
  }
})(window);
