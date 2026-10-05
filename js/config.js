/* config.js — INI の解析/生成 と 設定の永続化、File System Access 連携 */
(function (global) {
  'use strict';

  var FCH = (global.FCH = global.FCH || {});

  var INI_FILE_NAME = 'config.ini';
  var SECTION = 'FileCopyHtml';
  var IDB_NAME = 'FileCopyHtml';
  var IDB_STORE = 'state';
  var IDB_KEY = 'current';
  var LS_STATE = 'filecopyhtml.state.v1';
  var LS_INI = 'filecopyhtml.iniText.v1';

  /* ------------------------------------------------------------------ *
   * INI
   * ------------------------------------------------------------------ */

  function Ini() {
    this.sections = [];
    this._index = {};
  }

  Ini.prototype._ensure = function (name) {
    if (Object.prototype.hasOwnProperty.call(this._index, name)) return this._index[name];
    var sec = { name: name, keys: [], values: {} };
    this._index[name] = sec;
    this.sections.push(sec);
    return sec;
  };

  Ini.prototype.section = function (name) {
    return this._ensure(name || '');
  };

  Ini.prototype.get = function (name, key, fallback) {
    var sec = this._section(name);
    if (!sec || !Object.prototype.hasOwnProperty.call(sec.values, key)) return fallback;
    var v = sec.values[key];
    return v === '' ? fallback : v;
  };

  Ini.prototype.set = function (name, key, value) {
    var sec = this._ensure(name || '');
    if (sec.keys.indexOf(key) < 0) sec.keys.push(key);
    sec.values[key] = value == null ? '' : String(value);
    return this;
  };

  Ini.prototype._section = function (name) {
    name = name || '';
    return Object.prototype.hasOwnProperty.call(this._index, name) ? this._index[name] : null;
  };

  Ini.prototype.toString = function () {
    var lines = [];
    this.sections.forEach(function (sec) {
      if (sec.name) lines.push('[' + sec.name + ']');
      sec.keys.forEach(function (k) {
        lines.push(k + '=' + sec.values[k]);
      });
    });
    return lines.join('\r\n') + '\r\n';
  };

  Ini.parse = function (text) {
    var ini = new Ini();
    var current = ini._ensure('');
    String(text == null ? '' : text).split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim();
      if (!line) return;
      var ch = line.charAt(0);
      if (ch === ';' || ch === '#') return;
      var head = /^\[(.+)\]$/.exec(line);
      if (head) {
        current = ini._ensure(head[1].trim());
        return;
      }
      var eq = line.indexOf('=');
      if (eq < 0) return;
      var key = line.slice(0, eq).trim();
      var value = line.slice(eq + 1).trim();
      if (!key) return;
      if (current.keys.indexOf(key) < 0) current.keys.push(key);
      current.values[key] = value;
    });
    return ini;
  };

  /* ------------------------------------------------------------------ *
   * ローカルストレージ（IndexedDB 不可時のフォールバック兼バックアップ）
   * ------------------------------------------------------------------ */

  function lsGet(key) {
    try {
      var v = global.localStorage.getItem(key);
      return v == null ? null : JSON.parse(v);
    } catch (e) {
      return null;
    }
  }

  function lsSet(key, value) {
    try {
      global.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * IndexedDB（フォルダハンドル保存用）
   * ------------------------------------------------------------------ */

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) {
        reject(new Error('IndexedDB が利用できません（file:// で開いている場合は HTTP 経由での実行を推奨）'));
        return;
      }
      var req;
      try {
        req = global.indexedDB.open(IDB_NAME, 1);
      } catch (err) {
        reject(err);
        return;
      }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB を開けません')); };
      req.onblocked = function () { reject(new Error('IndexedDB が他のタブでロックされています')); };
    });
  }

  function idbGet(key) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readonly');
        var req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
        tx.oncomplete = function () { db.close(); };
      });
    });
  }

  function idbSet(key, value) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('保存が中断されました')); };
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Storage
   * ------------------------------------------------------------------ */

  var Storage = {
    /* ハンドル本体はシリアライズできないため、 clonable でない場合は handle を落とす */
    _sanitize: function (state) {
      var out = { slots: [], iniHandle: null, ui: state.ui || {} };
      (state.slots || []).forEach(function (slot) {
        if (!slot) return;
        var copy = {
          id: slot.id,
          role: slot.role,
          path: slot.path || '',
          label: slot.label || '',
          handle: slot.handle || null
        };
        if (copy.handle) {
          try {
            var probe = global.structuredClone
              ? global.structuredClone(copy.handle)
              : copy.handle;
            if (!probe || typeof probe.getDirectoryHandle !== 'function') copy.handle = null;
          } catch (e) {
            copy.handle = null;
          }
        }
        out.slots.push(copy);
      });
      out.iniHandle = state.iniHandle || null;
      return out;
    },

    /* localStorage にはハンドル本体を置けないため、パスと識別子のみ保存する */
    _plainSlots: function (slots) {
      return slots.map(function (s) {
        return { id: s.id, role: s.role, path: s.path, label: s.label };
      });
    },

    _normalizeLocal: function (rec) {
      return {
        slots: rec.slots || [],
        iniHandle: null,
        iniBound: !!rec.iniBound || !!rec.iniHandle,
        ui: rec.ui || {}
      };
    },

    save: function (state) {
      var safe = Storage._sanitize(state);
      var hasHandles = safe.slots.some(function (s) { return !!s.handle; }) || !!safe.iniHandle;
      lsSet(LS_STATE, {
        slots: Storage._plainSlots(safe.slots),
        iniBound: !!safe.iniHandle,
        ui: safe.ui
      });
      if (!hasHandles) return Promise.resolve({ persisted: 'local' });
      return idbSet(IDB_KEY, safe).then(
        function () { return { persisted: 'indexeddb' }; },
        function (err) { return { persisted: 'local', error: err }; }
      );
    },

    load: function () {
      return idbGet(IDB_KEY).then(
        function (rec) {
          if (rec && rec.slots && rec.slots.length) {
            if (!rec.iniBound) rec.iniBound = !!rec.iniHandle;
            return rec;
          }
          var ls = lsGet(LS_STATE);
          return ls ? Storage._normalizeLocal(ls) : null;
        },
        function () {
          var ls = lsGet(LS_STATE);
          return ls ? Storage._normalizeLocal(ls) : null;
        }
      );
    },

    saveIniText: function (text) {
      return lsSet(LS_INI, String(text || ''));
    },

    loadIniText: function () {
      var v = lsGet(LS_INI);
      return typeof v === 'string' ? v : null;
    },

    /* フォルダハンドルを保存できる環境かどうか（file:// では使えない場合がある） */
    probe: function () {
      return idbOpen().then(
        function (db) { db.close(); return { ok: true }; },
        function (err) { return { ok: false, reason: (err && err.message) || String(err) }; }
      );
    }
  };

  /* ------------------------------------------------------------------ *
   * ini ファイル（File System Access）
   * ------------------------------------------------------------------ */

  var IniFile = {
    NAME: INI_FILE_NAME,
    SECTION: SECTION,
    supported: function () {
      return typeof global.showSaveFilePicker === 'function';
    },

    pick: function (startIn) {
      var opts = {
        suggestedName: INI_FILE_NAME,
        types: [{ description: '設定ファイル', accept: { 'text/plain': ['.ini', '.txt'] } }]
      };
      if (startIn) opts.startIn = startIn;
      return global.showSaveFilePicker(opts);
    },

    read: function (handle) {
      if (!handle || typeof handle.getFile !== 'function') {
        return Promise.reject(new Error('ini ファイルを読み込めません（ハンドル無効）'));
      }
      return handle.getFile().then(function (file) {
        if (file.size === 0) return '';
        return file.text();
      });
    },

    write: function (handle, text) {
      if (!handle || typeof handle.createWritable !== 'function') {
        return Promise.reject(new Error('ini ファイルに書き込めません（ハンドル無効）'));
      }
      return handle.createWritable().then(function (w) {
        return w.write(String(text)).then(function () { return w.close(); });
      });
    },

    /* アプリの状態 → ini テキスト */
    build: function (state) {
      var lines = [
        '; FileCopyHtml 設定ファイル',
        '; HTML を開いたときに、このファイルのフォルダ設定が自動読み込みされます。',
        '; パスは UNC (\\\\サーバー\\共有) をそのまま記述できます。',
        ''
      ];
      var body = new Ini();
      body.set(SECTION, 'Version', '1');
      body.set(SECTION, 'Destination', state.dest ? (state.dest.path || '') : '');
      var n = 0;
      state.sources.forEach(function (slot) {
        n += 1;
        body.set(SECTION, 'Source' + n, slot ? (slot.path || '') : '');
      });
      body.set(SECTION, 'KeepTree', state.keepTree ? 'true' : 'false');
      body.set(SECTION, 'Overwrite', state.overwrite ? 'true' : 'false');
      return lines.join('\r\n') + body.toString();
    },

    /* ini テキスト → アプリの状態（パス文字列のみ） */
    apply: function (text, state) {
      var ini = Ini.parse(text);
      state.destPath = ini.get(SECTION, 'Destination', '') || '';
      state.sourcePaths = [];
      for (var i = 1; i <= 16; i += 1) {
        var v = ini.get(SECTION, 'Source' + i, '');
        state.sourcePaths.push(v || '');
      }
      var keep = (ini.get(SECTION, 'KeepTree', 'true') || 'true').toLowerCase();
      var over = (ini.get(SECTION, 'Overwrite', 'true') || 'true').toLowerCase();
      state.keepTree = keep !== 'false';
      state.overwrite = over !== 'false';
      return state;
    }
  };

  FCH.Ini = Ini;
  FCH.Section = SECTION;
  FCH.IniFile = IniFile;
  FCH.Storage = Storage;
  FCH.util = {
    formatBytes: function (bytes) {
      var n = Number(bytes) || 0;
      if (n < 1024) return n + ' B';
      var units = ['KB', 'MB', 'GB', 'TB'];
      var i = -1;
      do {
        n /= 1024;
        i += 1;
      } while (n >= 1024 && i < units.length - 1);
      return (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)) + ' ' + units[i];
    },
    formatDate: function (ms) {
      if (!ms) return '';
      var d = new Date(ms);
      var p = function (v) { return v < 10 ? '0' + v : String(v); };
      return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    },
    escapeHtml: function (s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
  };
})(window);
