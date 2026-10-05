/* copy.js — チャンク書き込みのコピーエンジン（進捗・上書き・中断対応） */
(function (global) {
  'use strict';

  var FCH = (global.FCH = global.FCH || {});
  var Folder = FCH.Folder;

  var CHUNK = 8 * 1024 * 1024;

  function abortError() {
    var e = new Error('中断しました');
    e.name = 'AbortError';
    return e;
  }

  var Copy = {
    /**
     * jobs: [{
     *   key, srcRoot, srcPath, destRelPath, size, label
     * }]
     * ctx: {
     *   destRoot, overwrite,
     *   onStart(total), onFileStart(job, index),
     *   onFileProgress(job, doneBytes),
     *   onFileDone(job, result),     // result: 'copied' | 'skipped' | 'error'
     *   signal
     * }
     * resolve() => { copied, skipped, failed, bytes, cancelled }
     */
    run: function (jobs, ctx) {
      var totalBytes = jobs.reduce(function (sum, j) { return sum + (j.size || 0); }, 0);
      var doneBytes = 0;
      var copied = 0;
      var skipped = 0;
      var failed = 0;
      var cancelled = false;

      function log(level, message) {
        if (typeof ctx.onLog === 'function') ctx.onLog(level, message);
      }

      function emitProgress() {
        if (typeof ctx.onProgress === 'function') {
          ctx.onProgress({ doneBytes: doneBytes, totalBytes: totalBytes, copied: copied, skipped: skipped, failed: failed });
        }
      }

      function checkAbort() {
        if (ctx.signal && ctx.signal.aborted) throw abortError();
      }

      async function copyOne(job, index) {
        checkAbort();
        if (typeof ctx.onFileStart === 'function') ctx.onFileStart(job, index);

        var target;
        try {
          target = await Folder.resolveFileHandle(ctx.destRoot, job.destRelPath, true);
        } catch (err) {
          failed += 1;
          log('error', '[作成失敗] ' + job.destRelPath + ' … ' + (err && err.message ? err.message : err));
          if (typeof ctx.onFileDone === 'function') ctx.onFileDone(job, 'error');
          return;
        }

        /* 上書きしない場合: 既存ファイルがあればスキップ */
        if (!ctx.overwrite) {
          var exists = false;
          try {
            await target.handle.getFile();
            exists = true;
          } catch (err) {
            exists = false;
          }
          if (exists) {
            skipped += 1;
            log('warn', '[既存] ' + job.destRelPath);
            if (typeof ctx.onFileDone === 'function') ctx.onFileDone(job, 'skipped');
            return;
          }
        }

        try {
          var src = await Folder.resolveFileHandle(job.srcRoot, job.srcPath, false);
          var file = await src.handle.getFile();
          var writable = await target.handle.createWritable();

          var fileDone = 0;
          try {
            for (var offset = 0; offset < file.size; offset += CHUNK) {
              checkAbort();
              var slice = file.slice(offset, Math.min(offset + CHUNK, file.size));
              var buf = await slice.arrayBuffer();
              await writable.write(buf);
              fileDone += buf.byteLength;
              doneBytes += buf.byteLength;
              if (typeof ctx.onFileProgress === 'function') ctx.onFileProgress(job, fileDone);
              emitProgress();
            }
            if (file.size === 0) {
              await writable.write(new ArrayBuffer(0));
            }
            await writable.close();
          } catch (err) {
            try { await writable.abort(); } catch (ignore) { /* noop */ }
            throw err;
          }

          /* Chromium の FSA では更新日時を保持できないため、ini にはログのみ残す */
          copied += 1;
          log('ok', '[コピー] ' + job.destRelPath + '  (' + FCH.util.formatBytes(file.size) + ')');
          if (typeof ctx.onFileDone === 'function') ctx.onFileDone(job, 'copied');
        } catch (err) {
          if (err && err.name === 'AbortError') throw err;
          failed += 1;
          log('error', '[失敗] ' + job.destRelPath + ' … ' + (err && err.message ? err.message : err));
          if (typeof ctx.onFileDone === 'function') ctx.onFileDone(job, 'error');
        }
      }

      return (async function () {
        if (typeof ctx.onStart === 'function') ctx.onStart({ total: jobs.length, totalBytes: totalBytes });
        if (!jobs.length) {
          return { copied: 0, skipped: 0, failed: 0, bytes: 0, cancelled: false };
        }
        try {
          for (var i = 0; i < jobs.length; i += 1) {
            await copyOne(jobs[i], i);
          }
        } catch (err) {
          if (err && err.name === 'AbortError') {
            cancelled = true;
            log('warn', '処理を中断しました');
          } else {
            failed += 1;
            log('error', '想定外のエラー: ' + (err && err.message ? err.message : err));
          }
        }
        emitProgress();
        return { copied: copied, skipped: skipped, failed: failed, bytes: doneBytes, cancelled: cancelled };
      })();
    }
  };

  FCH.Copy = Copy;
})(window);
