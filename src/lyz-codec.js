(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require);
  } else {
    root.LyzCodec = factory(null);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (nodeRequire) {
  'use strict';

  var BUNDLE_FORMAT = 'lyz-bundle-v1';
  var KNOWN_SAVE_FILES = ['Info', 'Save', 'Hero', 'TempHero'];
  var DANGEROUS_KEYS = {
    '__proto__': true,
    'constructor': true,
    'prototype': true
  };

  function koreanError(message) {
    return new Error(message);
  }

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function stripBom(str) {
    if (typeof str !== 'string') {
      throw koreanError('문자열이 필요합니다.');
    }
    return str.charCodeAt(0) === 0xFEFF ? str.slice(1) : str;
  }

  function detectBom(str) {
    return typeof str === 'string' && str.charCodeAt(0) === 0xFEFF;
  }

  function isGzipBytes(bytes) {
    return !!bytes && bytes.length >= 2 && bytes[0] === 0x1F && bytes[1] === 0x8B;
  }

  function toUint8Array(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw koreanError('바이트 자료가 필요합니다.');
  }

  function nodeZlib() {
    if (!nodeRequire) return null;
    try {
      return nodeRequire('zlib');
    } catch (_) {
      return null;
    }
  }

  function streamTransform(bytes, streamName) {
    var StreamCtor = typeof globalThis !== 'undefined' ? globalThis[streamName] : null;
    if (typeof StreamCtor !== 'function') return null;
    if (typeof Blob !== 'function' || typeof Response !== 'function') return null;

    try {
      var stream = new Blob([bytes]).stream().pipeThrough(new StreamCtor('gzip'));
      return new Response(stream).arrayBuffer().then(function (buffer) {
        return new Uint8Array(buffer);
      });
    } catch (_) {
      return null;
    }
  }

  function decompressGzipBytes(bytes) {
    try {
      bytes = toUint8Array(bytes);
    } catch (error) {
      return Promise.reject(error);
    }

    var streamed = streamTransform(bytes, 'DecompressionStream');
    if (streamed) {
      return streamed.catch(function () {
        var zlib = nodeZlib();
        if (!zlib) throw koreanError('압축 자료를 풀 수 없습니다.');
        try {
          return new Uint8Array(zlib.gunzipSync(bytes));
        } catch (_) {
          throw koreanError('압축 자료를 풀 수 없습니다.');
        }
      });
    }

    var zlib = nodeZlib();
    if (!zlib) return Promise.reject(koreanError('압축 자료를 풀 수 없습니다.'));
    try {
      return Promise.resolve(new Uint8Array(zlib.gunzipSync(bytes)));
    } catch (_) {
      return Promise.reject(koreanError('압축 자료를 풀 수 없습니다.'));
    }
  }

  function compressGzipBytes(bytes) {
    try {
      bytes = toUint8Array(bytes);
    } catch (error) {
      return Promise.reject(error);
    }

    var streamed = streamTransform(bytes, 'CompressionStream');
    if (streamed) {
      return streamed.catch(function () {
        var zlib = nodeZlib();
        if (!zlib) throw koreanError('자료를 압축할 수 없습니다.');
        try {
          return new Uint8Array(zlib.gzipSync(bytes));
        } catch (_) {
          throw koreanError('자료를 압축할 수 없습니다.');
        }
      });
    }

    var zlib = nodeZlib();
    if (!zlib) return Promise.reject(koreanError('자료를 압축할 수 없습니다.'));
    try {
      return Promise.resolve(new Uint8Array(zlib.gzipSync(bytes)));
    } catch (_) {
      return Promise.reject(koreanError('자료를 압축할 수 없습니다.'));
    }
  }

  function decodeUtf8(bytes) {
    if (typeof TextDecoder === 'function') {
      try {
        return new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }).decode(bytes);
      } catch (_) {
        throw koreanError('문자 자료를 읽을 수 없습니다.');
      }
    }

    var zlib = nodeZlib();
    if (zlib) {
      try {
        return Buffer.from(bytes).toString('utf8');
      } catch (_) {
        throw koreanError('문자 자료를 읽을 수 없습니다.');
      }
    }
    throw koreanError('문자 자료를 읽을 수 없습니다.');
  }

  function encodeUtf8(text) {
    if (typeof TextEncoder === 'function') {
      try {
        return new TextEncoder().encode(text);
      } catch (_) {
        throw koreanError('문자 자료를 만들 수 없습니다.');
      }
    }

    var zlib = nodeZlib();
    if (zlib) {
      try {
        return new Uint8Array(Buffer.from(text, 'utf8'));
      } catch (_) {
        throw koreanError('문자 자료를 만들 수 없습니다.');
      }
    }
    throw koreanError('문자 자료를 만들 수 없습니다.');
  }

  function decodeSlotFile(fileName, bytes) {
    var input;
    try {
      input = toUint8Array(bytes);
    } catch (error) {
      return Promise.reject(error);
    }

    var compressed = isGzipBytes(input);
    var contentPromise = compressed ? decompressGzipBytes(input) : Promise.resolve(input);
    return contentPromise.then(function (content) {
      var hasBom = content.length >= 3 &&
        content[0] === 0xEF && content[1] === 0xBB && content[2] === 0xBF;
      var decoded = decodeUtf8(content);
      var text = stripBom(decoded);
      var data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        throw koreanError('저장 자료의 형식이 올바르지 않습니다.');
      }
      return {
        fileName: fileName,
        isGzip: compressed,
        hasBom: hasBom,
        text: text,
        data: data,
        byteLength: input.byteLength
      };
    });
  }

  function encodeSlotFile(text, options) {
    options = options || {};
    if (typeof text !== 'string') {
      return Promise.reject(koreanError('문자열이 필요합니다.'));
    }

    var hasBom = !!options.hasBom;
    var normalized = stripBom(text);
    if (detectBom(text)) hasBom = true;
    var content = encodeUtf8((hasBom ? '\uFEFF' : '') + normalized);

    return options.isGzip ? compressGzipBytes(content) : Promise.resolve(content);
  }

  function detectFileKind(fileName, parsedOrText) {
    var name = typeof fileName === 'string' ? fileName.split(/[\\/]/).pop() : '';
    var lower = name.toLowerCase();
    for (var k = 0; k < KNOWN_SAVE_FILES.length; k++) {
      if (KNOWN_SAVE_FILES[k].toLowerCase() === lower) {
        return KNOWN_SAVE_FILES[k];
      }
    }

    var value = parsedOrText;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(stripBom(value));
      } catch (_) {
        return null;
      }
    } else if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'data')) {
      value = value.data;
    }

    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        if (value[i] && typeof value[i] === 'object') {
          if (value[i].isTempHero === true) return 'TempHero';
          if (value[i].heroID === 0) return 'Hero';
        }
      }
      return null;
    }
    if (isRecord(value)) {
      if (Object.prototype.hasOwnProperty.call(value, 'SaveVersion') ||
          Object.prototype.hasOwnProperty.call(value, 'SaveDetail')) return 'Info';
      if (Object.prototype.hasOwnProperty.call(value, 'chapter') ||
          Object.prototype.hasOwnProperty.call(value, 'Forces') ||
          Object.prototype.hasOwnProperty.call(value, 'Areas')) return 'Save';
    }
    return null;
  }

  function skipWhitespace(text, index, limit) {
    while (index < limit && /\s/.test(text.charAt(index))) index++;
    return index;
  }

  function scanStringEnd(text, start, limit) {
    if (text.charAt(start) !== '"') throw koreanError('문자열 위치가 올바르지 않습니다.');
    var escaped = false;
    for (var i = start + 1; i < limit; i++) {
      var ch = text.charAt(i);
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        return i + 1;
      }
    }
    throw koreanError('문자열이 끝나지 않았습니다.');
  }

  function scanValueEnd(text, start, limit) {
    if (start >= limit) throw koreanError('자료 값이 없습니다.');
    var first = text.charAt(start);

    if (first === '"') return scanStringEnd(text, start, limit);

    if (first === '{' || first === '[') {
      var stack = [first === '{' ? '}' : ']'];
      var inString = false;
      var escaped = false;

      for (var i = start + 1; i < limit; i++) {
        var ch = text.charAt(i);

        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }

        if (ch === '"') {
          inString = true;
        } else if (ch === '{') {
          stack.push('}');
        } else if (ch === '[') {
          stack.push(']');
        } else if (ch === '}' || ch === ']') {
          if (stack.pop() !== ch) throw koreanError('괄호 짝이 올바르지 않습니다.');
          if (stack.length === 0) return i + 1;
        }
      }
      throw koreanError('자료 값이 끝나지 않았습니다.');
    }

    var index = start;
    while (index < limit && text.charAt(index) !== ',' &&
           text.charAt(index) !== ']' && text.charAt(index) !== '}') {
      index++;
    }
    while (index > start && /\s/.test(text.charAt(index - 1))) index--;
    if (index === start) throw koreanError('자료 값이 올바르지 않습니다.');
    return index;
  }

  function scanJsonArrayRanges(jsonText) {
    if (typeof jsonText !== 'string') throw koreanError('문자열이 필요합니다.');
    var start = skipWhitespace(jsonText, 0, jsonText.length);
    var limit = jsonText.length;
    if (jsonText.charAt(start) !== '[') throw koreanError('배열 자료가 필요합니다.');

    var ranges = [];
    var index = skipWhitespace(jsonText, start + 1, limit);
    if (jsonText.charAt(index) === ']') return ranges;

    while (index < limit) {
      var valueStart = index;
      var valueEnd = scanValueEnd(jsonText, valueStart, limit);
      ranges.push({ start: valueStart, end: valueEnd });
      index = skipWhitespace(jsonText, valueEnd, limit);

      var delimiter = jsonText.charAt(index);
      if (delimiter === ']') return ranges;
      if (delimiter !== ',') throw koreanError('배열 구분 기호가 올바르지 않습니다.');
      index = skipWhitespace(jsonText, index + 1, limit);
    }
    throw koreanError('배열 자료가 끝나지 않았습니다.');
  }

  function scanJsonObjectKeyRanges(jsonText) {
    if (typeof jsonText !== 'string') throw koreanError('문자열이 필요합니다.');
    var limit = jsonText.length;
    var index = skipWhitespace(jsonText, 0, limit);
    if (jsonText.charAt(index) !== '{') throw koreanError('객체 자료가 필요합니다.');

    var ranges = Object.create(null);
    index = skipWhitespace(jsonText, index + 1, limit);
    if (jsonText.charAt(index) === '}') return ranges;

    while (index < limit) {
      if (jsonText.charAt(index) !== '"') throw koreanError('객체 이름이 올바르지 않습니다.');
      var keyEnd = scanStringEnd(jsonText, index, limit);
      var key;
      try {
        key = JSON.parse(jsonText.slice(index, keyEnd));
      } catch (_) {
        throw koreanError('객체 이름이 올바르지 않습니다.');
      }

      index = skipWhitespace(jsonText, keyEnd, limit);
      if (jsonText.charAt(index) !== ':') throw koreanError('객체 구분 기호가 올바르지 않습니다.');
      index = skipWhitespace(jsonText, index + 1, limit);

      var valueStart = index;
      var valueEnd = scanValueEnd(jsonText, valueStart, limit);
      ranges[key] = { start: valueStart, end: valueEnd };
      index = skipWhitespace(jsonText, valueEnd, limit);

      var delimiter = jsonText.charAt(index);
      if (delimiter === '}') return ranges;
      if (delimiter !== ',') throw koreanError('객체 구분 기호가 올바르지 않습니다.');
      index = skipWhitespace(jsonText, index + 1, limit);
    }
    throw koreanError('객체 자료가 끝나지 않았습니다.');
  }

  function spliceJsonRanges(rawText, replacements) {
    if (typeof rawText !== 'string' || !Array.isArray(replacements)) {
      throw koreanError('자료 변경 항목이 올바르지 않습니다.');
    }

    var sorted = replacements.slice().sort(function (a, b) {
      return b.start - a.start;
    });
    var result = rawText;
    var previousStart = rawText.length + 1;

    for (var i = 0; i < sorted.length; i++) {
      var item = sorted[i];
      if (!item || !Number.isInteger(item.start) || !Number.isInteger(item.end) ||
          item.start < 0 || item.end < item.start || item.end > rawText.length ||
          item.end > previousStart || typeof item.text !== 'string') {
        throw koreanError('자료 변경 위치가 올바르지 않습니다.');
      }
      result = result.slice(0, item.start) + item.text + result.slice(item.end);
      previousStart = item.start;
    }
    return result;
  }

  function normalizeRawFile(value) {
    var text;
    var isGzip = false;
    var hasBom = false;

    if (typeof value === 'string') {
      text = value;
      hasBom = detectBom(text);
    } else if (value && typeof value.text === 'string') {
      text = value.text;
      isGzip = !!value.isGzip;
      hasBom = !!value.hasBom || detectBom(text);
    } else {
      throw koreanError('저장 파일 자료가 없습니다.');
    }

    return {
      text: stripBom(text),
      isGzip: isGzip,
      hasBom: hasBom
    };
  }

  function createBundle(rawFilesMap) {
    if (!isRecord(rawFilesMap)) throw koreanError('저장 묶음 자료가 필요합니다.');

    var data = {};
    var files = {};
    var rawTexts = {};
    var dirty = {};
    var dirtyHeroIndices = { Hero: {}, TempHero: {} };

    for (var i = 0; i < KNOWN_SAVE_FILES.length; i++) {
      var name = KNOWN_SAVE_FILES[i];
      if (!Object.prototype.hasOwnProperty.call(rawFilesMap, name)) {
        throw koreanError('필요한 저장 파일이 없습니다.');
      }

      var meta = normalizeRawFile(rawFilesMap[name]);
      var parsed;
      try {
        parsed = JSON.parse(meta.text);
      } catch (_) {
        throw koreanError('저장 자료의 형식이 올바르지 않습니다.');
      }

      if ((name === 'Info' || name === 'Save') && !isRecord(parsed)) {
        throw koreanError('저장 자료의 형식이 올바르지 않습니다.');
      }
      if ((name === 'Hero' || name === 'TempHero') &&
          parsed !== null && !Array.isArray(parsed)) {
        throw koreanError('영웅 자료의 형식이 올바르지 않습니다.');
      }

      data[name] = parsed;
      files[name] = { isGzip: meta.isGzip, hasBom: meta.hasBom };
      rawTexts[name] = { text: meta.text, isGzip: meta.isGzip, hasBom: meta.hasBom };
      dirty[name] = false;
    }

    var heroSpans = data.Hero === null ? [] : scanJsonArrayRanges(rawTexts.Hero.text);
    var tempHeroSpans = data.TempHero === null ? [] : scanJsonArrayRanges(rawTexts.TempHero.text);
    var saveKeySpans = scanJsonObjectKeyRanges(rawTexts.Save.text);

    return {
      format: BUNDLE_FORMAT,
      data: data,
      meta: {
        files: files,
        rawTexts: rawTexts,
        heroSpans: heroSpans,
        tempHeroSpans: tempHeroSpans,
        saveKeySpans: saveKeySpans
      },
      dirty: dirty,
      dirtyHeroIndices: dirtyHeroIndices,
      dirtySaveKeys: {}
    };
  }

  function serializeBundle(bundle) {
    if (!bundle || bundle.format !== BUNDLE_FORMAT || !bundle.data ||
        !bundle.meta || !bundle.meta.rawTexts) {
      throw koreanError('저장 묶음 자료가 올바르지 않습니다.');
    }

    var output = {};

    for (var i = 0; i < KNOWN_SAVE_FILES.length; i++) {
      var name = KNOWN_SAVE_FILES[i];
      var raw = bundle.meta.rawTexts[name];
      if (!raw) throw koreanError('저장 파일 자료가 없습니다.');
      var fileMeta = (bundle.meta.files && bundle.meta.files[name]) || raw;

      if (!bundle.dirty[name]) {
        output[name] = {
          text: raw.text,
          isGzip: !!fileMeta.isGzip,
          hasBom: !!fileMeta.hasBom
        };
        continue;
      }

      var text;
      if (name === 'Hero' || name === 'TempHero') {
        var array = bundle.data[name];
        if (array !== null && !Array.isArray(array)) {
          throw koreanError('영웅 자료의 형식이 올바르지 않습니다.');
        }

        var spans = name === 'Hero' ? bundle.meta.heroSpans : bundle.meta.tempHeroSpans;
        var dirtyIndices = bundle.dirtyHeroIndices && bundle.dirtyHeroIndices[name]
          ? bundle.dirtyHeroIndices[name]
          : {};
        var indices = Object.keys(dirtyIndices);
        var replacements = [];

        if (Array.isArray(array) && spans && spans.length === array.length && indices.length) {
          var canSplice = true;
          for (var h = 0; h < indices.length; h++) {
            var index = Number(indices[h]);
            if (!Number.isInteger(index) || index < 0 || index >= array.length || !spans[index]) {
              canSplice = false;
              break;
            }
            replacements.push({
              start: spans[index].start,
              end: spans[index].end,
              text: JSON.stringify(array[index])
            });
          }
          text = canSplice ? spliceJsonRanges(raw.text, replacements) : JSON.stringify(array);
        } else {
          text = JSON.stringify(array);
        }
      } else if (name === 'Save') {
        var save = bundle.data.Save;
        if (!isRecord(save)) throw koreanError('저장 자료의 형식이 올바르지 않습니다.');

        var keySpans = bundle.meta.saveKeySpans || {};
        var originalKeys = Object.keys(keySpans);
        var currentKeys = Object.keys(save);
        var dirtyKeys = Object.keys(bundle.dirtySaveKeys || {});
        var sameKeys = originalKeys.length === currentKeys.length;

        if (sameKeys) {
          for (var k = 0; k < originalKeys.length; k++) {
            if (!Object.prototype.hasOwnProperty.call(save, originalKeys[k])) {
              sameKeys = false;
              break;
            }
          }
        }

        var saveReplacements = [];
        var canSpliceSave = sameKeys;
        for (var s = 0; s < dirtyKeys.length && canSpliceSave; s++) {
          var key = dirtyKeys[s];
          if (!Object.prototype.hasOwnProperty.call(keySpans, key)) {
            canSpliceSave = false;
            break;
          }
          saveReplacements.push({
            start: keySpans[key].start,
            end: keySpans[key].end,
            text: JSON.stringify(save[key])
          });
        }

        text = canSpliceSave && dirtyKeys.length
          ? spliceJsonRanges(raw.text, saveReplacements)
          : JSON.stringify(save);
      } else {
        text = JSON.stringify(bundle.data.Info);
      }

      if (typeof text !== 'string') throw koreanError('저장 자료를 만들 수 없습니다.');
      output[name] = {
        text: text,
        isGzip: !!fileMeta.isGzip,
        hasBom: !!fileMeta.hasBom
      };
    }

    return output;
  }

  function cloneJson(value) {
    if (value === null || typeof value !== 'object') return value;

    if (Array.isArray(value)) {
      var array = new Array(value.length);
      for (var i = 0; i < value.length; i++) array[i] = cloneJson(value[i]);
      return array;
    }

    var clone = Object.create(null);
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (DANGEROUS_KEYS[key]) continue;
      Object.defineProperty(clone, key, {
        value: cloneJson(value[key]),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return clone;
  }

  return {
    BUNDLE_FORMAT: BUNDLE_FORMAT,
    KNOWN_SAVE_FILES: KNOWN_SAVE_FILES,
    stripBom: stripBom,
    detectBom: detectBom,
    isGzipBytes: isGzipBytes,
    decompressGzipBytes: decompressGzipBytes,
    compressGzipBytes: compressGzipBytes,
    decodeSlotFile: decodeSlotFile,
    encodeSlotFile: encodeSlotFile,
    detectFileKind: detectFileKind,
    scanJsonArrayRanges: scanJsonArrayRanges,
    scanJsonObjectKeyRanges: scanJsonObjectKeyRanges,
    spliceJsonRanges: spliceJsonRanges,
    createBundle: createBundle,
    serializeBundle: serializeBundle,
    cloneJson: cloneJson
  };
});
