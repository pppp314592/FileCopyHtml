/* folder.js — フォルダの選択・権限確認・再帰ファイル列挙 */
(function (global) {
  'use strict';

  var FCH = (global.FCH = global.FCH || {});

  var DEFAULT_MAX_FILES = 20000;

  /* values() の戻り値を for-await 可能な形に正規化する（同期イテレータ実装も許容） */
  function toAsyncIterable(obj) {
    if (!obj) return null;
    if (typeof obj[Symbol.asyncIterator] === 'function') return obj;
    if (typeof obj[Symbol.iterator] === 'function') {
      return (async function* () { yield* obj; })();
    }
    return null;
  }

  function abortError() {
    var e = new Error('キャンセルされました');
    e.name = 'AbortError';
    return e;
  }

  function pickError(err) {
    if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return abortError();
    return err;
  }

  var Folder = {
    /* File System Access API の対応状況 */
    supported: function () {
      return typeof global.showDirectoryPicker === 'function';
    },

    /* フォルダ選択ダイアログ（ネットワークドライブ / UNC もここから移動できる） */
    pick: function (hint) {
      var run = function (opts) {
        return global.showDirectoryPicker(opts);
      };

      var opts = { mode: 'readwrite' };
      if (hint) opts.startIn = hint;
      return run(opts).catch(function (err) {
        /* startIn に想定外の値を渡した場合のフォールバック */
        if (err && err.name === 'TypeError' && hint) return run({ mode: 'readwrite' });
        throw pickError(err);
      });
    },

    /* 権限確認。force=true ならユーザー操作で要求する。mode は 'read' / 'readwrite' */
    ensurePermission: function (handle, force, mode) {
      if (!handle) return Promise.resolve('missing');
      var desc = { mode: mode || 'read' };
      if (typeof handle.queryPermission !== 'function') return Promise.resolve('granted');
      return handle.queryPermission(desc).then(function (state) {
        if (state === 'granted' || !force) return state;
        if (typeof handle.requestPermission !== 'function') return state;
        return handle.requestPermission(desc);
      });
    },

    /**
     * フォルダ配下のファイルを再帰的に列挙する。
     * resolve() => { files:[], dirs:number, totalBytes:number, truncated:boolean, errors:[] }
     */
    list: function (dirHandle, opts) {
      opts = opts || {};
      var maxFiles = opts.maxFiles || DEFAULT_MAX_FILES;
      var maxDepth = opts.maxDepth == null ? 12 : opts.maxDepth;
      var signal = opts.signal;
      var files = [];
      var errors = [];
      var dirCount = 0;
      var totalBytes = 0;
      var truncated = false;

      function walk(handle, prefix, depth) {
        if (truncated) return Promise.resolve();
        if (signal && signal.aborted) return Promise.reject(abortError());
        dirCount += 1;
        var iterable = toAsyncIterable(handle.values ? handle.values() : null);
        if (!iterable) {
          return Promise.reject(new Error('このブラウザはフォルダの列挙に対応していません（Chrome / Edge 86 以降推奨）'));
        }

        return (async function () {
          for await (var entry of iterable) {
            if (signal && signal.aborted) throw abortError();
            var rel = prefix ? prefix + '/' + entry.name : entry.name;
            if (entry.kind === 'directory') {
              if (depth >= maxDepth) {
                errors.push('深さ上限のため未走査: ' + rel);
                continue;
              }
              await walk(entry, rel, depth + 1);
            } else {
              var info = { path: rel, name: entry.name, dir: prefix };
              try {
                var file = await entry.getFile();
                info.size = file.size;
                info.lastModified = file.lastModified;
              } catch (err) {
                info.size = 0;
                info.lastModified = 0;
                info.error = err && err.message ? err.message : String(err);
              }
              totalBytes += info.size || 0;
              files.push(info);
              if (files.length >= maxFiles) {
                truncated = true;
                break;
              }
            }
          }
        })();
      }

      return walk(dirHandle, '', 0).then(function () {
        files.sort(function (a, b) {
          if (a.dir === b.dir) return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
          return a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0;
        });
        return { files: files, dirs: dirCount, totalBytes: totalBytes, truncated: truncated, errors: errors };
      });
    },

    /* 相対パスからファイルハンドルを取得（create=true なら dirs も作る） */
    resolveFileHandle: function (rootHandle, relPath, create) {
      var parts = String(relPath).split('/').filter(function (p) { return p && p !== '.'; });
      if (!parts.length) return Promise.reject(new Error('不正なパスです'));
      var name = parts.pop();
      return (async function () {
        var dir = rootHandle;
        for (var i = 0; i < parts.length; i += 1) {
          dir = await dir.getDirectoryHandle(parts[i], { create: !!create });
        }
        return { dir: dir, name: name, handle: await dir.getFileHandle(name, { create: !!create }) };
      })();
    }
  };

  FCH.Folder = Folder;
})(window);
